// Database backup tool (#30.10)
// =============================
// Creates portable .tar.gz snapshots of the user's musicd state. Each
// backup contains:
//   • A consistent snapshot of musicd.db (taken via SQLite's online
//     backup API, so it's safe even while the database is being written
//     to). Cover art BLOBs, favourites, play history, library scope,
//     all settings, news cache, artist logos, DSP profile rows — all
//     live in the database, so the .db file is the bulk of a backup.
//   • The contents of /data/dsp/{ir,peq,autoeq}/ — user-uploaded FIR
//     impulse responses, manual PEQ profiles, and the AutoEQ snapshot
//     index. None of these are inside the database.
//
// Backups land in BACKUP_DIR (a separate :rw mount) and are listed,
// downloaded, and deleted via the API. Restore is intentionally not
// in-app for v30.10 — to restore, the user stops the container,
// extracts the tar over /var/lib/musicd-data, and starts it again.
//
// The mount is OPTIONAL: if /mnt/backups isn't bind-mounted, the API
// reports "not configured" and the UI shows a hint about updating the
// docker run command. This way v30.10 still auto-installs cleanly even
// on containers started by v30.9 (which doesn't know about the mount).

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');
const db = require('./db');
const paths = require('./paths');

const BACKUP_DIR = '/mnt/backups';
const FILENAME_PATTERN = /^musicd-backup-\d{4}-\d{2}-\d{2}T\d{6}\.tar\.gz$/;

let _backupRunning = false;

/**
 * Returns the configuration state of the backup feature. The mount is
 * optional — older docker run commands won't have it. The UI uses this
 * to decide whether to render the backup section or a "not configured"
 * hint.
 *
 *   { configured: false, reason: 'mount_missing' }    — /mnt/backups doesn't exist
 *   { configured: false, reason: 'mount_readonly' }   — exists but can't write
 *   { configured: true, dir: '/mnt/backups' }         — ready to go
 */
function getConfig() {
  let stat;
  try {
    stat = fs.statSync(BACKUP_DIR);
  } catch (e) {
    return { configured: false, reason: 'mount_missing' };
  }
  if (!stat.isDirectory()) {
    return { configured: false, reason: 'mount_missing' };
  }
  // Try a touch to verify writability. We don't keep the file — just
  // create and unlink. fs.access(W_OK) doesn't actually verify mount
  // semantics on bind mounts (read-only mounts can still report W_OK).
  const probe = path.join(BACKUP_DIR, '.musicd-write-probe');
  try {
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
  } catch (e) {
    return { configured: false, reason: 'mount_readonly' };
  }
  return { configured: true, dir: BACKUP_DIR };
}

/**
 * Generate a backup filename from the current time. ISO-8601-like
 * (2026-04-30T143022) but with colons stripped — colons aren't legal
 * in filenames on some host filesystems and would force users to
 * quote-escape on the command line.
 */
function backupFilename(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const ts =
    `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}` +
    `T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return `musicd-backup-${ts}.tar.gz`;
}

/**
 * Validate that a filename submitted by the client is a backup file
 * we created. Whitelist-only — rejects anything with path components,
 * relative-traversal sequences, or unexpected extensions.
 *
 * Returns the validated filename (no path) or null if the name is bad.
 * Callers should treat null as a 400 Bad Request.
 */
function validateFilename(name) {
  if (typeof name !== 'string') return null;
  if (name.length > 200) return null;
  if (!FILENAME_PATTERN.test(name)) return null;
  // Belt-and-braces — should be redundant after the regex match
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return null;
  return name;
}

/**
 * Resolve a filename to its full disk path. Always under BACKUP_DIR;
 * the validation in validateFilename() guarantees no escape.
 */
function fullPath(filename) {
  return path.join(BACKUP_DIR, filename);
}

/**
 * List backup files currently on disk. Returns an array sorted newest
 * first. Files that don't match our filename pattern are silently
 * skipped (defensive — a user might drop their own files into the
 * mount and we shouldn't surface those in the UI).
 */
async function listBackups() {
  const cfg = getConfig();
  if (!cfg.configured) return { configured: false, reason: cfg.reason, backups: [] };

  let entries;
  try {
    entries = await fsp.readdir(BACKUP_DIR, { withFileTypes: true });
  } catch (e) {
    return { configured: false, reason: 'mount_missing', backups: [] };
  }

  const out = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!FILENAME_PATTERN.test(entry.name)) continue;
    const p = fullPath(entry.name);
    try {
      const stat = await fsp.stat(p);
      out.push({
        filename: entry.name,
        sizeBytes: stat.size,
        createdAt: stat.mtimeMs, // mtime ≈ creation for our newly-written files
      });
    } catch {} // file disappeared between readdir and stat — skip
  }
  // Newest first
  out.sort((a, b) => b.createdAt - a.createdAt);
  return { configured: true, backups: out };
}

/**
 * Create a new backup. Writes to a `.partial` filename first then
 * renames once the tar is closed, so a crash mid-write doesn't leave
 * a half-formed file pretending to be a real backup.
 *
 * Steps:
 *   1. Snapshot the SQLite database to a tmp file (online backup API)
 *   2. Stage everything we want in the tar under /tmp/musicd-backup-XXX/
 *   3. tar -czf into the partial filename
 *   4. Rename to final filename
 *   5. Clean up the staging dir
 *
 * Concurrency guard: only one backup at a time. The route already
 * disables the UI button while a backup is running, but we double-check
 * here so a stale browser tab can't fire concurrent requests.
 */
async function createBackup() {
  const cfg = getConfig();
  if (!cfg.configured) {
    throw new Error(`Backup mount not configured (${cfg.reason}). See README for the docker run command with the backups mount.`);
  }
  if (_backupRunning) {
    throw new Error('A backup is already in progress.');
  }
  _backupRunning = true;

  const filename = backupFilename();
  const finalPath = fullPath(filename);
  const partialPath = finalPath + '.partial';
  const stageDir = path.join('/tmp', `musicd-backup-${Date.now()}-${process.pid}`);

  try {
    // Step 1: stage dir
    await fsp.mkdir(stageDir, { recursive: true });

    // Step 2: snapshot the database. better-sqlite3's db.backup() returns
    // a Promise that resolves when the snapshot is complete; the resulting
    // file is a fully-consistent copy even if writes happened during it.
    const dbSnapshotPath = path.join(stageDir, 'musicd.db');
    await db.get().backup(dbSnapshotPath);

    // Step 3: copy the DSP folders. Rather than tarring from /data
    // directly (which would bake in absolute paths and capture
    // ephemeral things like our own /tmp staging), we copy what we
    // want into stageDir and tar from there. Each copy is tolerant
    // of the source not existing — a fresh install might not have
    // any FIR files, for instance.
    for (const sub of ['ir', 'peq', 'autoeq']) {
      const src = path.join(paths.DSP_DIR, sub);
      const dst = path.join(stageDir, 'dsp', sub);
      await copyDirRecursive(src, dst);
    }

    // Step 3b: optionally include images (#v1.1.0.2). Cover art and
    // artist logos cache to disk under /data/coverart and /data/artistlogos.
    // Without these, after a restore the DB knows the MBIDs but the
    // image files are gone -- musicd would re-fetch them on demand,
    // which works but is slow and beats up the upstream services.
    // Default ON so backups are complete; setting backup_include_images=0
    // turns it off for users who want smaller backups.
    let includeImages = true;
    try {
      const row = db.get().prepare("SELECT value FROM settings WHERE key='backup_include_images'").get();
      if (row && (row.value === '0' || row.value === 'false')) includeImages = false;
    } catch {}
    if (includeImages) {
      const coverSrc = path.join(paths.DATA_DIR, 'coverart');
      const coverDst = path.join(stageDir, 'coverart');
      await copyDirRecursive(coverSrc, coverDst);
      const logoSrc = path.join(paths.DATA_DIR, 'artistlogos');
      const logoDst = path.join(stageDir, 'artistlogos');
      await copyDirRecursive(logoSrc, logoDst);
    }

    // Step 4: tar up the staging dir. The -C flag changes into stageDir
    // first so paths inside the tar are relative (./musicd.db, ./dsp/ir/...)
    // rather than including the temp path.
    await runTar(['-czf', partialPath, '-C', stageDir, '.']);

    // Step 5: atomic rename
    await fsp.rename(partialPath, finalPath);

    // Step 6: stat for the response
    const stat = await fsp.stat(finalPath);
    return {
      filename,
      sizeBytes: stat.size,
      createdAt: stat.mtimeMs,
    };
  } catch (e) {
    // Clean up partial if it exists
    try { await fsp.unlink(partialPath); } catch {}
    throw e;
  } finally {
    // Always clean up staging dir
    try { await rmRecursive(stageDir); } catch {}
    _backupRunning = false;
  }
}

/**
 * Delete a single backup file. Validates the name first to prevent
 * directory traversal. Callers (the route) should also have validated
 * but defense in depth is cheap.
 */
async function deleteBackup(filename) {
  const cfg = getConfig();
  if (!cfg.configured) {
    throw new Error('Backup mount not configured');
  }
  const validated = validateFilename(filename);
  if (!validated) {
    throw new Error('Invalid filename');
  }
  const p = fullPath(validated);
  await fsp.unlink(p);
}

/**
 * Resolve a filename to the path callers can stream. Returns null
 * (not throws) on missing/invalid so the route can return 404 cleanly.
 */
function pathForDownload(filename) {
  const cfg = getConfig();
  if (!cfg.configured) return null;
  const validated = validateFilename(filename);
  if (!validated) return null;
  const p = fullPath(validated);
  if (!fs.existsSync(p)) return null;
  return p;
}

function isRunning() {
  return _backupRunning;
}

// ── helpers ────────────────────────────────────────────────────────────

function runTar(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('tar', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited ${code}: ${stderr.trim() || 'no stderr'}`));
    });
  });
}

async function copyDirRecursive(src, dst) {
  let stat;
  try { stat = await fsp.stat(src); } catch { return; } // missing source = no-op
  if (!stat.isDirectory()) return;
  await fsp.mkdir(dst, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(s, d);
    } else if (entry.isFile()) {
      await fsp.copyFile(s, d);
    }
    // Skip symlinks/special files — backup is for regular user content only
  }
}

async function rmRecursive(p) {
  // Node 14+ has fs.rm with recursive
  await fsp.rm(p, { recursive: true, force: true });
}

// ── Restore staging (#v1.1.0.2) ──────────────────────────────────────
//
// Stages a backup tar.gz for restore on next container boot. Never
// touches the live DB -- the entrypoint.sh handles the actual swap
// at boot time when the DB isn't open. This is the only safe pattern
// for SQLite restore: in-process restore would risk WAL corruption.
//
// The pending dir lives at /data/.pending-restore/. On next start,
// the entrypoint moves musicd.db (and dsp/ if present) from there
// into /data/, after backing up the previous DB to .pre-restore-musicd.db
// for emergency rollback.

const PENDING_DIR = path.join(paths.DATA_DIR, '.pending-restore');

async function stageRestore(filename) {
  const safe = validateFilename(filename);
  if (!safe) throw new Error('Invalid filename');
  const src = path.join(BACKUP_DIR, safe);
  // Throw early with a clean code if the file is gone.
  await fsp.stat(src);
  // Wipe any previously-staged restore -- we always replace.
  await rmRecursive(PENDING_DIR);
  await fsp.mkdir(PENDING_DIR, { recursive: true });
  // Extract the tar straight into the pending dir. The backup tar
  // contents are exactly what we want at /data/ root: ./musicd.db
  // and ./dsp/{ir,peq,autoeq}/. The entrypoint moves them into place.
  await runTar(['-xzf', src, '-C', PENDING_DIR]);
  // Sanity check: the tar must contain musicd.db. If it doesn't,
  // something's wrong and we shouldn't pretend the staging succeeded.
  const dbAt = path.join(PENDING_DIR, 'musicd.db');
  try { await fsp.stat(dbAt); }
  catch {
    await rmRecursive(PENDING_DIR);
    throw new Error('Backup file missing musicd.db');
  }
  return { staged: true };
}

// Self-restart delegates to the orchestrator abstraction (#v1.1.0.48).
// The orchestrator picks docker / systemd / unknown automatically and
// returns the appropriate error message if no restart channel is
// configured.
async function selfRestart() {
  const orchestrator = require('./orchestrator');
  if (!orchestrator.canSelfRestart()) {
    const m = orchestrator.mode();
    if (m === 'docker') {
      throw new Error('Docker socket not mounted -- restart manually with `docker restart musicd` on the host');
    } else if (m === 'systemd') {
      throw new Error('systemctl unavailable -- restart manually with `sudo systemctl restart musicd`');
    } else {
      throw new Error('No restart channel detected -- restart musicd manually');
    }
  }
  return orchestrator.selfRestart();
}

module.exports = {
  getConfig,
  listBackups,
  createBackup,
  deleteBackup,
  pathForDownload,
  isRunning,
  validateFilename,
  stageRestore,
  selfRestart,
  BACKUP_DIR,
};
