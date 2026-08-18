// AutoEQ database updater (#29.1)
// =================================
// Fetches the full AutoEQ project's pre-computed parametric EQ presets from
// GitHub and writes them under <data>/dsp/autoeq/presets/.
//
// Strategy:
//   1. One GET to GitHub's Trees API to list every file in the repo at
//      master HEAD. This is rate-limited (60/hr unauthenticated) but we
//      only need it once per refresh.
//   2. Filter the paths to "results/<source>/<category>/<model>/<model>
//      ParametricEQ.txt" — AutoEQ's canonical parametric output.
//   3. Fetch each .txt over raw.githubusercontent.com (CDN-served, NOT
//      rate-limited), in batches of 8 parallel requests.
//   4. Save each preset as <model>.txt and rebuild index.json.
//
// Progress is exposed via a module-level state object that the route
// handler can poll. We deliberately avoid WebSocket plumbing for this —
// it's a one-off operation, not a real-time stream.
//
// Error handling: individual file fetch failures are non-fatal; we log
// them and continue. Index is rebuilt from whatever files actually landed
// on disk so partial successes still produce a usable database.

const fs = require('fs');
const path = require('path');
const https = require('https');
const paths = require('../paths');

// AutoEQ repo coordinates. Pinned to master — the project is actively
// maintained but the result file naming convention has been stable since
// the 4.0.0 reorganisation in 2023.
const REPO_OWNER  = 'jaakkopasanen';
const REPO_NAME   = 'AutoEq';
const REPO_BRANCH = 'master';

// File path pattern in the repo. AutoEQ's results layout is:
//   results/<source>/<category>/<model>/<model> ParametricEQ.txt
// (Plus FixedBandEQ.txt, GraphicEQ.txt, .png plots, etc that we don't want.)
const PRESET_PATH_RE = /^results\/[^/]+\/[^/]+\/([^/]+)\/\1 ParametricEQ\.txt$/;

// Concurrency limit for raw.githubusercontent.com fetches. 8 is the
// commonly-recommended balance between throughput and being a polite
// CDN consumer.
const FETCH_CONCURRENCY = 8;

// Module-level progress state. Populated while a refresh is running, read
// by the GET /api/dsp/autoeq/update/progress endpoint.
let progress = {
  running: false,
  phase: 'idle',         // 'idle' | 'fetching-tree' | 'downloading' | 'finalising' | 'done' | 'error'
  total: 0,
  done: 0,
  error: null,
  startedAt: null,
  finishedAt: null,
  // Diagnostic counters
  skippedExisting: 0,
  failed: 0,
};

function getProgress() { return { ...progress }; }

// Tiny JSON-fetch helper. Wraps node:https with a 60-second timeout and
// strict status-code check so we don't get stuck on a hang.
function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'musicd-autoeq-updater',
        'Accept':     'application/json',
      },
    }, (res) => {
      if (res.statusCode !== 200) {
        // Read and discard so the socket can close cleanly
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON: ' + e.message)); }
      });
    });
    req.setTimeout(60000, () => { req.destroy(new Error('Timeout')); });
    req.on('error', reject);
  });
}

// Fetch a single text file. Returns the body string. Used for the per-preset
// raw downloads.
function httpsGetText(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'musicd-autoeq-updater' },
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(data));
    });
    req.setTimeout(30000, () => { req.destroy(new Error('Timeout')); });
    req.on('error', reject);
  });
}

// Run a list of async tasks with bounded concurrency. Each task is a
// thunk returning a Promise. Resolves when all tasks complete; never
// rejects (individual failures are caught and counted by the caller).
async function runWithConcurrency(tasks, limit) {
  const queue = tasks.slice();
  const workers = new Array(Math.min(limit, queue.length)).fill(null).map(async () => {
    while (queue.length > 0) {
      const task = queue.shift();
      if (task) await task();
    }
  });
  await Promise.all(workers);
}

// Parse a model name from "<source>/<category>/<model>/..." path. The
// model is the third segment. We want a clean name for the saved file
// and the index entry.
function pathToModelInfo(repoPath) {
  // e.g. "results/oratory1990/over-ear/Sennheiser HD 800/Sennheiser HD 800 ParametricEQ.txt"
  const parts = repoPath.split('/');
  if (parts.length < 5) return null;
  return {
    source:   parts[1],
    category: parts[2],
    model:    parts[3],
  };
}

// Public: trigger a refresh. Idempotent — second call while one is running
// just returns early. Doesn't await; spawns a background promise. Caller
// polls getProgress().
function startRefresh({ replace = false } = {}) {
  if (progress.running) return { ok: false, reason: 'Already running' };
  progress = {
    running: true,
    phase: 'fetching-tree',
    total: 0, done: 0,
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
    skippedExisting: 0,
    failed: 0,
  };

  // Run async, don't await — caller polls progress
  runRefresh({ replace }).catch(err => {
    progress.running = false;
    progress.phase = 'error';
    progress.error = err.message;
    progress.finishedAt = Date.now();
    console.error('AutoEQ refresh failed:', err);
  });

  return { ok: true };
}

async function runRefresh({ replace }) {
  const presetsDir = path.join(paths.AUTOEQ_DIR, 'presets');
  const indexPath  = path.join(paths.AUTOEQ_DIR, 'index.json');
  fs.mkdirSync(presetsDir, { recursive: true });

  // Step 1: tree
  const treeUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/git/trees/${REPO_BRANCH}?recursive=1`;
  const tree = await httpsGetJson(treeUrl);
  if (!tree || !Array.isArray(tree.tree)) {
    throw new Error('GitHub tree response missing tree[]');
  }
  if (tree.truncated) {
    // Trees API truncates at ~100k entries. AutoEQ is well under but worth
    // logging if it ever isn't — would need to switch to a paginated walk.
    console.warn('AutoEQ tree response was truncated; some presets may be missed.');
  }

  // Filter to canonical ParametricEQ.txt files
  const candidates = [];
  for (const entry of tree.tree) {
    if (entry.type !== 'blob') continue;
    if (!PRESET_PATH_RE.test(entry.path)) continue;
    const info = pathToModelInfo(entry.path);
    if (!info) continue;
    candidates.push({ ...info, repoPath: entry.path });
  }

  progress.total = candidates.length;
  progress.phase = 'downloading';
  console.log(`AutoEQ refresh: ${candidates.length} presets to fetch`);

  // Step 2: download. Skip if file already exists locally and replace=false.
  const newIndex = [];
  const seenSlugs = new Set();
  const tasks = candidates.map(c => async () => {
    // Slug = the model directory name. AutoEQ paths use the model name as
    // both the directory and the file prefix, so it's safe to use as our
    // filename. Some characters (slashes) are illegal in our slugs but
    // those don't appear in headphone model names anyway.
    const slug = c.model;
    // Dedupe — some models appear under multiple sources. First-write wins.
    if (seenSlugs.has(slug)) { progress.done++; return; }
    seenSlugs.add(slug);

    const localPath = path.join(presetsDir, `${slug}.txt`);
    if (!replace && fs.existsSync(localPath)) {
      progress.skippedExisting++;
      progress.done++;
      // File already on disk → safe to index.
      newIndex.push({ model: c.model, slug, category: c.category, source: c.source });
      return;
    }
    const rawUrl = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${REPO_BRANCH}/${c.repoPath.split('/').map(encodeURIComponent).join('/')}`;
    try {
      const body = await httpsGetText(rawUrl);
      // Sanity check: must contain at least one Filter line
      if (!/Filter\s+\d+:/i.test(body)) {
        throw new Error('No filter lines in body');
      }
      fs.writeFileSync(localPath, body);
      // Only after successful write do we add to the index. Earlier we
      // pushed the index entry before fetching, which left ghost entries
      // pointing at non-existent files when the fetch failed — and the
      // /autoeq/preset/:slug endpoint would 404 for them.
      newIndex.push({ model: c.model, slug, category: c.category, source: c.source });
    } catch (e) {
      console.warn(`AutoEQ fetch failed for ${slug}:`, e.message);
      progress.failed++;
    }
    progress.done++;
  });

  await runWithConcurrency(tasks, FETCH_CONCURRENCY);

  // Step 3: rebuild index
  progress.phase = 'finalising';
  // Sort by model name for deterministic UI ordering
  newIndex.sort((a, b) => a.model.localeCompare(b.model, undefined, { sensitivity: 'base' }));
  fs.writeFileSync(indexPath, JSON.stringify(newIndex, null, 2));

  progress.running = false;
  progress.phase = 'done';
  progress.finishedAt = Date.now();
  console.log(`AutoEQ refresh: done. ${newIndex.length} presets indexed, ${progress.failed} failed, ${progress.skippedExisting} skipped (already existed).`);
}

module.exports = {
  startRefresh,
  getProgress,
};
