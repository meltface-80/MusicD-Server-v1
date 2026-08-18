// Remote update fetcher (#30.6).
// =================================
// Polls a JSON manifest URL (typically a Dropbox-hosted manifest.json),
// compares the version field to the running version, and on demand
// downloads the referenced tar into the local /mnt/downloads watch
// folder so the existing updater pipeline picks it up.
//
// The manifest format (kept deliberately small):
//
//   {
//     "version": "1.0.30.6",
//     "tarUrl":  "https://www.dropbox.com/.../musicd-v1-0-30-6.tar?dl=1",
//     "releaseNotes": "Optional human-readable notes"
//   }
//
// Why a manifest instead of fetching the tar directly:
// every poll only needs to read ~200 bytes (the JSON), and we only
// download the multi-MB tar when the user actually opts in to update.
//
// The manifest URL itself is stable for the lifetime of the project —
// the *contents* of the manifest change with each release. This is
// what makes the public-Dropbox-link approach work: the file at the URL
// gets edited (Dropbox keeps the same shared link for the same file),
// and inside it we point at whichever tar is current.
//
// State model:
//   _lastCheck:  timestamp of last manifest fetch attempt
//   _lastResult: parsed manifest from the most recent successful fetch,
//                or { error } from the most recent failed fetch.
//   _checkInFlight: shared promise for in-flight checks (so concurrent
//                   callers don't trigger multiple fetches)
//
// The daily refresh loop is started by start(); manual checks call
// checkNow() which returns the same shape regardless of timing.

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const version = require('./version');

// Where downloaded tars go. We can't use /mnt/downloads because that's
// often mounted :ro inside the running container (deliberately, so the
// dev workflow of dropping tars onto the host visible can't accidentally
// be tampered with by the running musicd process). /mnt/musicd_updates
// is mounted :rw and we already write update logs there, so it's the
// natural home for downloaded-but-not-yet-applied tars.
//
// Subdir 'pending' makes it obvious which tars are waiting to be applied
// vs which have already been consumed (the alpine updater script moves
// applied tars up to /mnt/musicd_updates/).
//
// (#30.8 — earlier versions wrote to /mnt/downloads and failed with
// EROFS on any container started with that mount as :ro.)
// PENDING_DIR resolves per orchestrator (#v1.1.0.48).
const PENDING_DIR = (() => {
  try {
    const orch = require('./orchestrator');
    if (orch.mode() === 'systemd') return '/var/lib/musicd/updates/pending';
  } catch { /* fall through */ }
  return '/mnt/musicd_updates/pending';
})();

// The same directory as the host sees it. The alpine updater container
// has the host root mounted at /host, so it reads tars at this path.
//
// v1.1.2.9: this path is now resolved at runtime by inspecting the
// musicd container's own bind mounts via the docker socket, the same
// way updater.js's resolveHostMountPath() works. The hardcoded path
// here had been wrong on real DietPi installs (which mount
// /mnt/musicd_updates from /mnt/dietpi_userdata/musicd_updates, not
// /var/lib/musicd/updates), causing the updater to write tars to
// /mnt/musicd_updates/pending (which lands on the host at
// /mnt/dietpi_userdata/musicd_updates/pending) but tell the alpine
// updater to read /host/var/lib/musicd/updates/pending — the wrong
// path. The resulting "tar: can't open: No such file or directory"
// in the alpine logs was the v1.1.2.5–v1.1.2.8 update failure.
//
// We can't share resolveHostMountPath() with updater.js without a
// circular import, so this is a separate but identical implementation.
// Cached after first lookup; mounts don't change at runtime.
let _pendingDirHostCache = null;
function getPendingDirHost() {
  if (_pendingDirHostCache !== null) return _pendingDirHostCache;
  const { execSync } = require('child_process');
  const tryInspect = (id) => {
    try {
      const out = execSync(
        `docker inspect --format='{{json .Mounts}}' ${id}`,
        { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }
      );
      const mounts = JSON.parse(out);
      if (!Array.isArray(mounts)) return null;
      for (const m of mounts) {
        if (m && m.Destination === '/mnt/musicd_updates' && m.Source) {
          return `/host${m.Source}/pending`;
        }
      }
      return null;
    } catch {
      return null;
    }
  };

  // Same resolution chain as updater.js's resolveHostMountPath():
  // try name 'musicd' first (always works on standard installs), then
  // /etc/hostname, then scan all containers.
  let found = tryInspect('musicd');
  if (!found) {
    try {
      const h = fs.readFileSync('/etc/hostname', 'utf8').trim();
      if (h) found = tryInspect(h);
    } catch { /* */ }
  }
  if (!found) {
    try {
      const ids = execSync('docker ps -q', { encoding: 'utf8', timeout: 5000 })
        .split('\n').filter(Boolean);
      for (const id of ids) {
        found = tryInspect(id);
        if (found) break;
      }
    } catch { /* */ }
  }

  // Fallback to legacy hardcoded path if everything failed. Better than
  // null — at least matches what the v1.1.2.7 and earlier code did, so
  // we don't make things worse than they were.
  _pendingDirHostCache = found || '/host/var/lib/musicd/updates/pending';
  console.log(`[remoteUpdater] PENDING_DIR_HOST resolved to: ${_pendingDirHostCache}`);
  return _pendingDirHostCache;
}

// Daily auto-check. The user can also press the manual button which
// bypasses this interval.
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Manifest fetch should be quick; we don't want the daily check
// blocking forever if Dropbox is slow.
const MANIFEST_TIMEOUT_MS = 15_000;

// Tar download has a longer timeout because the file is bigger.
// 5 minutes is plenty for a few MB over residential broadband.
const TAR_TIMEOUT_MS = 5 * 60 * 1000;

// Safety: cap how big a downloaded tar can be. A musicd tar is well
// under 10 MB (mostly source + small skill files); 50 MB lets us grow
// substantially without risking accidental disk-fill from a misshared
// file.
const MAX_TAR_BYTES = 50 * 1024 * 1024;

// Module state — set by checkNow() and read by getStatus().
let _lastCheckTs   = 0;       // unix seconds
let _lastResult    = null;    // { version, tarUrl, releaseNotes } or { error }
let _checkInFlight = null;    // Promise during an in-progress check
let _checkTimer    = null;    // setInterval handle for daily checks

/**
 * Get the manifest URL (#v1.1.0.25). Now baked into the build rather
 * than user-configurable -- the previous per-user setting created
 * needless friction (every user pasting the same URL) and was a
 * frequent source of "auto-update isn't working" support tickets when
 * users had stripped a query parameter while copying.
 *
 * Override priority:
 *   1. MUSICD_MANIFEST_URL env variable -- for development, private
 *      mirrors, or self-hosted forks. Set with -e on docker run.
 *   2. The legacy `update_manifest_url` settings row -- still
 *      respected so existing installs that had a custom URL keep
 *      working without a migration step.
 *   3. The baked-in default below.
 *
 * Returns null only if explicitly disabled (env var or setting set
 * to empty string). Otherwise always returns the baked-in URL.
 */
function getManifestUrl() {
  // 1. Environment variable wins
  if ('MUSICD_MANIFEST_URL' in process.env) {
    const env = String(process.env.MUSICD_MANIFEST_URL || '').trim();
    return env || null;   // empty env var disables
  }
  // 2. Legacy per-user setting (only if explicitly set to non-default)
  try {
    const db = require('./db').get();
    const row = db.prepare(`SELECT value FROM settings WHERE key = 'update_manifest_url'`).get();
    const v = (row?.value || '').trim();
    // If the user previously cleared their URL (empty row), respect
    // that and stay disabled. Otherwise, if they set a custom URL
    // that's NOT the v1.1.0.24-or-earlier default, keep it.
    if (row && v === '') return null;
    if (v && v !== LEGACY_DEFAULT_URL) return v;
  } catch {
    // settings table missing or other DB error — fall through to default
  }
  // 3. Baked-in default
  return DEFAULT_MANIFEST_URL;
}

/**
 * Default manifest URL (#v1.1.0.25 baked in). Override via
 * MUSICD_MANIFEST_URL env variable.
 *
 * v1.1.2.3: fixed two long-standing bugs in this URL.
 *   1. `dl=0` → `dl=1`. With dl=0 Dropbox serves the HTML preview
 *      page, not the JSON. The fetcher would get HTML, fail to
 *      parse it, and silently report "manifest is not valid JSON"
 *      from every check. Auto-update never worked.
 *   2. Removed the `&st=...` session token. That token is
 *      browser-session-bound and expires within hours; the link
 *      worked when first pasted but began returning 403 after.
 *      The persistent `rlkey=` is the actual share-key — that's
 *      sufficient on its own.
 *
 * Same Dropbox file as before; only the URL parameters changed.
 */
const DEFAULT_MANIFEST_URL = 'https://www.dropbox.com/scl/fi/f652dr08cy6cci4e2ur17/manifest.json?rlkey=pglhbq32hpsq9ofp10zg07l89&dl=1';

/**
 * The previous (v1.1.0.24-and-earlier) default URL that was stored
 * verbatim in the settings table for users who never customised it.
 * We treat "settings.update_manifest_url == LEGACY_DEFAULT_URL" the
 * same as "no setting" so the env-override / new-default path takes
 * over cleanly. Currently the same string -- if the canonical URL
 * ever changes, both constants update together.
 */
const LEGACY_DEFAULT_URL = DEFAULT_MANIFEST_URL;

/**
 * setManifestUrl is no longer exposed -- the URL isn't user-configurable
 * (#v1.1.0.25). The function is kept as a stub so any old client code
 * calling /api/update/manifest-url gets a clear error rather than a
 * mysterious silent failure.
 */
function setManifestUrl() {
  return { ok: false, error: 'Manifest URL is now baked in. Set MUSICD_MANIFEST_URL env variable to override.' };
}

/**
 * Dropbox public-share URLs end in `?dl=0` (preview page) or `?dl=1`
 * (direct download). When users paste a URL straight from Dropbox's
 * "share" UI it usually has dl=0. We rewrite to dl=1 so the server
 * gets file bytes rather than HTML.
 *
 * v1.1.2.3 — also strip `st=...` query parameters. These are
 * session tokens Dropbox adds to share URLs copied from the Web UI.
 * They expire (hours, not days), so a URL that worked when first
 * pasted starts returning 403 after the session lapses. Removing
 * the token leaves the persistent `rlkey=` which is sufficient for
 * the share to remain valid.
 *
 * Other domains pass through unchanged.
 */
function normaliseDropboxUrl(url) {
  if (!url || typeof url !== 'string') return url;
  if (!/dropbox\.com/.test(url)) return url;
  // Strip st=... session token (v1.1.2.3). Handles &st=xxx and ?st=xxx
  // at any position; leaves any following params intact.
  url = url.replace(/([?&])st=[^&]*(&|$)/, (_m, pre, post) => post === '&' ? pre : (pre === '?' ? '?' : ''));
  // Clean up any trailing '?' or '&' the strip may have left behind.
  url = url.replace(/[?&]$/, '');
  // Replace dl=0 with dl=1. Both forms (& and ?) need handling.
  if (/[?&]dl=0(?:&|$)/.test(url)) {
    return url.replace(/([?&])dl=0(?=&|$)/, '$1dl=1');
  }
  // No dl param at all — append.
  if (!/[?&]dl=1(?:&|$)/.test(url)) {
    return url + (url.includes('?') ? '&dl=1' : '?dl=1');
  }
  return url;
}

/**
 * Fetch and parse the manifest JSON from the configured URL.
 * Returns the parsed object on success, or { error: '...' } on failure.
 *
 * Failure modes (each logged but non-fatal):
 *   - No URL configured → returns null (remote checks disabled)
 *   - Network error → { error: 'fetch failed: ...' }
 *   - HTTP non-2xx → { error: 'HTTP <status>' }
 *   - Body isn't valid JSON → { error: 'invalid JSON' }
 *   - Parsed JSON missing required fields → { error: 'malformed manifest' }
 *
 * On Dropbox link-expired errors we attempt one retry with the `st=`
 * session token stripped — that often works because Dropbox accepts
 * the link without it.
 */
async function fetchManifest(url) {
  const fetchUrl = normaliseDropboxUrl(url);
  let body;
  try {
    const r = await axios.get(fetchUrl, {
      timeout: MANIFEST_TIMEOUT_MS,
      maxRedirects: 5,
      headers: { 'User-Agent': 'musicd/1.0 update-checker' },
      responseType: 'text',
      transformResponse: [v => v],   // disable axios's auto JSON-parse
                                      // so we can give precise errors
      validateStatus: s => s >= 200 && s < 400,
    });
    body = r.data;
  } catch (e) {
    // Try once more with st= stripped, in case Dropbox's session token
    // has expired. This is the most common Dropbox-link failure mode.
    if (/dropbox\.com/.test(fetchUrl) && /[?&]st=/.test(fetchUrl)) {
      const stripped = fetchUrl.replace(/([?&])st=[^&]*(&|$)/, (_, pre, post) => post === '&' ? pre : '');
      try {
        const r2 = await axios.get(stripped, {
          timeout: MANIFEST_TIMEOUT_MS,
          maxRedirects: 5,
          headers: { 'User-Agent': 'musicd/1.0 update-checker' },
          responseType: 'text',
          transformResponse: [v => v],
          validateStatus: s => s >= 200 && s < 400,
        });
        body = r2.data;
      } catch (e2) {
        return { error: `fetch failed: ${e2.message}` };
      }
    } else {
      return { error: `fetch failed: ${e.message}` };
    }
  }

  if (!body || typeof body !== 'string') {
    return { error: 'empty response body' };
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Common Dropbox failure: returns HTML preview page rather than the
    // file bytes. Surface a clear message so the user knows to fix the
    // share link.
    if (/<html|<!doctype/i.test(body.slice(0, 200))) {
      return { error: 'manifest URL returned HTML (the share link probably needs ?dl=1)' };
    }
    return { error: 'manifest is not valid JSON' };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { error: 'manifest is not a JSON object' };
  }

  // v1.1.1.3 — hybrid manifest format support.
  //
  // Old format (v1.1.1.2 and earlier):
  //   { version, tarUrl, releaseNotes }
  //
  // New format (v1.1.1.3+):
  //   { manifestVersion: 1,
  //     channels: { stable: { version, tarUrl, ... }, ... },
  //     channelMetadata: { ... },
  //     accessTiers: { ... } }
  //
  // During the migration, the manifest carries BOTH shapes:
  //   - Top-level version/tarUrl point at the latest legacy build
  //     (e.g. 1.1.1.3) so old clients update to 1.1.1.3.
  //   - channels.* has the new releases for new clients.
  //
  // We accept either shape. If channels exists and is well-formed,
  // we use the new path; otherwise we fall back to top-level fields
  // exactly as before.
  const hasNewFormat = parsed.manifestVersion >= 1 && parsed.channels && typeof parsed.channels === 'object';
  const hasLegacyFormat = typeof parsed.version === 'string' && typeof parsed.tarUrl === 'string';

  if (!hasNewFormat && !hasLegacyFormat) {
    return { error: 'manifest missing required fields (version+tarUrl, or manifestVersion+channels)' };
  }

  // If the new format is present, validate each channel entry.
  if (hasNewFormat) {
    for (const [name, ch] of Object.entries(parsed.channels)) {
      if (!ch || typeof ch !== 'object') {
        return { error: `channel "${name}" is not an object` };
      }
      if (typeof ch.version !== 'string' || typeof ch.tarUrl !== 'string') {
        return { error: `channel "${name}" missing version or tarUrl` };
      }
    }
  }

  return parsed;
}

/**
 * Run a manifest check and update module state. Returns a summary
 * object describing the result. Idempotent across concurrent callers
 * — they all share one in-flight promise.
 */
async function checkNow() {
  if (_checkInFlight) return _checkInFlight;
  _checkInFlight = (async () => {
    const url = getManifestUrl();
    _lastCheckTs = Math.floor(Date.now() / 1000);
    if (!url) {
      _lastResult = { error: 'no manifest URL configured' };
      return _lastResult;
    }
    const result = await fetchManifest(url);
    _lastResult = result;
    if (result.error) {
      console.warn(`[update] manifest check failed: ${result.error}`);
      return result;
    }
    // Compare versions.
    const current = version.parseVersion(version.getVersion());
    const remote = version.parseVersion(result.version);
    const cmp = version.compareVersions(remote, current);
    if (cmp > 0) {
      console.log(`[update] remote update available: ${version.formatVersion(remote)} (running ${version.formatVersion(current)})`);
    } else {
      console.log(`[update] up to date (running ${version.formatVersion(current)}, remote ${result.version})`);
    }
    return result;
  })();
  try { return await _checkInFlight; }
  finally { _checkInFlight = null; }
}

/**
 * Returns null if no remote update available, or
 * { currentVersion, availableVersion, tarFilename, downloadUrl,
 *   releaseNotes } if there is. Uses the *cached* last manifest —
 * doesn't trigger a fresh fetch. Caller can fall back to checkNow()
 * if the cache is stale.
 *
 * tarFilename is derived from the version so it matches the standard
 * musicd-vX-Y-Z-W.tar pattern that the existing local updater expects.
 */
function findRemoteUpdate() {
  if (!_lastResult || _lastResult.error) return null;
  // Legacy path: top-level version/tarUrl. Used when no channel
  // context is available (no user tier yet, or manifest has no
  // channels block). v1.1.1.3 routes pass an explicit channel via
  // findRemoteUpdateForChannel() instead.
  if (typeof _lastResult.version !== 'string' || typeof _lastResult.tarUrl !== 'string') {
    return null;
  }
  const current = version.parseVersion(version.getVersion());
  const remote = version.parseVersion(_lastResult.version);
  if (version.compareVersions(remote, current) <= 0) return null;
  // v1.1.1.3 — use version.tarFilenameFor so semver names are
  // generated correctly (musicd-1.0.0-beta.1.tar) alongside legacy
  // names (musicd-v1-1-1-3.tar).
  const tarFilename = version.tarFilenameFor(remote);
  return {
    currentVersion: version.formatVersion(current),
    availableVersion: _lastResult.version,
    tarFilename,
    downloadUrl: _lastResult.tarUrl,
    releaseNotes: _lastResult.releaseNotes || null,
    source: 'remote',
    channel: null,  // legacy path — no channel context
  };
}

/**
 * v1.1.1.3 — channel-aware release lookup.
 *
 * Given a channel name (stable / earlyAccess / beta / alpha / legacy),
 * return the release information for that channel from the cached
 * manifest, or null if:
 *   - no cached manifest
 *   - manifest doesn't have channels block (legacy-only manifest)
 *   - channel doesn't exist in this manifest
 *   - channel's version is not newer than running version
 *
 * Caller reads user's channel preference from DB and calls this
 * function with that name. The route layer combines the answer
 * with tier/feature-flag info to decide what to show the user.
 */
function findRemoteUpdateForChannel(channelName) {
  if (!_lastResult || _lastResult.error) return null;
  if (!_lastResult.channels || typeof _lastResult.channels !== 'object') return null;
  const ch = _lastResult.channels[channelName];
  if (!ch) return null;
  if (typeof ch.version !== 'string' || typeof ch.tarUrl !== 'string') return null;

  const current = version.parseVersion(version.getVersion());
  const remote = version.parseVersion(ch.version);
  if (version.compareVersions(remote, current) <= 0) return null;

  const tarFilename = version.tarFilenameFor(remote);
  return {
    currentVersion: version.formatVersion(current),
    availableVersion: ch.version,
    tarFilename,
    downloadUrl: ch.tarUrl,
    releaseNotes: ch.releaseNotes || null,
    releasedAt: ch.releasedAt || null,
    source: 'remote',
    channel: channelName,
  };
}

/**
 * v1.1.1.3 — read the cached manifest's channel list (for the
 * Settings channel picker UI). Returns the channels block from
 * the new format, or null if the manifest is legacy-only.
 *
 * Each entry includes whatever metadata the manifest provided plus
 * a per-channel "isAvailable" flag (always true if the channel is
 * present in the manifest — left as a hook for future "out of
 * service" semantics).
 */
function getAvailableChannels() {
  if (!_lastResult || _lastResult.error) return null;
  if (!_lastResult.channels || typeof _lastResult.channels !== 'object') return null;
  const out = {};
  for (const [name, ch] of Object.entries(_lastResult.channels)) {
    out[name] = {
      version: ch.version,
      releasedAt: ch.releasedAt || null,
      releaseNotes: ch.releaseNotes || null,
      isAvailable: true,
    };
  }
  return out;
}

/**
 * v1.1.1.3 — read the cached manifest's accessTiers block (for
 * the code-validation logic in the tier route). Returns the
 * raw object or null. Each tier has { channels, codeHash?,
 * label, default?, featureFlags? }.
 */
function getAccessTiers() {
  if (!_lastResult || _lastResult.error) return null;
  if (!_lastResult.accessTiers || typeof _lastResult.accessTiers !== 'object') return null;
  return _lastResult.accessTiers;
}

/**
 * v1.1.1.3 — read the cached manifest's channelMetadata block.
 * Returns the raw metadata object or null.
 */
function getChannelMetadata() {
  if (!_lastResult || _lastResult.error) return null;
  if (!_lastResult.channelMetadata || typeof _lastResult.channelMetadata !== 'object') return null;
  return _lastResult.channelMetadata;
}

/**
 * Download the tar at `downloadUrl` into PENDING_DIR with the given
 * filename. Returns { ok: true, path } on success or { ok: false,
 * error } on failure. The downloaded file is sanity-checked: must be
 * larger than 4 KB (anything smaller is almost certainly an HTML error
 * page) and must start with the tar magic bytes.
 *
 * The tar lands in PENDING_DIR (writable) rather than the local watch
 * folder /mnt/downloads (often :ro). The runUpdate() path knows to look
 * here for remote-source updates — see updater.js.
 */
async function downloadTar(downloadUrl, tarFilename) {
  if (!downloadUrl) return { ok: false, error: 'no download URL' };
  // Ensure target dir exists. fs.mkdirSync is idempotent with recursive.
  try {
    fs.mkdirSync(PENDING_DIR, { recursive: true });
  } catch (e) {
    return { ok: false, error: `cannot create pending dir: ${e.message}` };
  }

  const fetchUrl = normaliseDropboxUrl(downloadUrl);
  const targetPath = path.join(PENDING_DIR, tarFilename);
  const tmpPath = targetPath + '.partial';

  // Stream the response to disk so we don't hold the whole file in memory.
  let stream;
  try {
    const r = await axios.get(fetchUrl, {
      timeout: TAR_TIMEOUT_MS,
      maxRedirects: 5,
      headers: { 'User-Agent': 'musicd/1.0 update-downloader' },
      responseType: 'stream',
      maxContentLength: MAX_TAR_BYTES,
      maxBodyLength:    MAX_TAR_BYTES,
      validateStatus: s => s >= 200 && s < 400,
    });
    stream = r.data;
  } catch (e) {
    return { ok: false, error: `download failed: ${e.message}` };
  }

  // Pipe stream to a tmp file so a partial download doesn't masquerade
  // as a complete tar. Rename to the final filename only on success.
  try {
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tmpPath);
      let bytes = 0;
      stream.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_TAR_BYTES) {
          out.destroy();
          stream.destroy();
          reject(new Error(`download exceeded max size (${MAX_TAR_BYTES} bytes)`));
        }
      });
      stream.pipe(out);
      out.on('finish', resolve);
      out.on('error', reject);
      stream.on('error', reject);
    });
  } catch (e) {
    // Common cause: pending dir owned by a different UID than the
    // container's node user. Surface a self-explanatory message
    // pointing at the fix rather than just the bare EACCES path
    // (#v1.1.0.5).
    if (e.code === 'EACCES') {
      return {
        ok: false,
        error: `Cannot write to ${PENDING_DIR}: permission denied. On the host, run: sudo chown -R 1000:1000 /mnt/dietpi_userdata/musicd_updates`
      };
    }
    return { ok: false, error: `download write failed: ${e.message}` };
  }

  // Validate: file must exist, be reasonably-sized, and start with
  // tar magic bytes (or at least look like a binary, not an HTML error
  // page).
  let stat;
  try { stat = fs.statSync(tmpPath); }
  catch (e) {
    return { ok: false, error: `partial file not found: ${e.message}` };
  }
  if (stat.size < 4096) {
    // Read it as text to diagnose. Often this is an HTML error page
    // from Dropbox saying the link is broken.
    let snippet = '';
    try { snippet = fs.readFileSync(tmpPath, 'utf8').slice(0, 200); } catch {}
    fs.unlinkSync(tmpPath);
    if (/<html|<!doctype/i.test(snippet)) {
      return { ok: false, error: 'download returned HTML — the share link may need ?dl=1' };
    }
    return { ok: false, error: `download too small (${stat.size} bytes)` };
  }

  // Tar magic bytes: at offset 257, the string "ustar" appears in
  // POSIX tar files. We do a soft check — if it's not there we still
  // try to use it (older tars don't have ustar magic), but log.
  try {
    const fd = fs.openSync(tmpPath, 'r');
    const buf = Buffer.alloc(8);
    fs.readSync(fd, buf, 0, 8, 257);
    fs.closeSync(fd);
    if (buf.toString('ascii').slice(0, 5) !== 'ustar') {
      console.warn(`[update] downloaded file lacks ustar magic — trying anyway`);
    }
  } catch (e) {
    // Magic check failed — not fatal, we still try.
    console.warn(`[update] tar magic check failed: ${e.message}`);
  }

  // Atomic rename → final filename. After this point findAvailableUpdate()
  // sees the new file.
  try { fs.renameSync(tmpPath, targetPath); }
  catch (e) {
    return { ok: false, error: `rename failed: ${e.message}` };
  }

  console.log(`[update] downloaded ${tarFilename} (${stat.size} bytes) to ${targetPath}`);
  return { ok: true, path: targetPath, size: stat.size };
}

/** Public status helper for the Settings UI. */
function getStatus() {
  const url = getManifestUrl();
  return {
    // manifestUrl removed in #v1.1.0.25 -- no longer user-visible.
    // The URL is baked in (or set via MUSICD_MANIFEST_URL env var);
    // the UI only needs to know whether updates are enabled.
    enabled:        !!url,
    lastCheck:      _lastCheckTs || null,
    lastResult:     _lastResult || null,
  };
}

// Default manifest URL is now defined above getManifestUrl, baked-in
// with env-variable override (#v1.1.0.25). The seedDefaultManifestUrl
// function that used to populate the settings row at first boot has
// been removed -- it served the old per-user-setting model. New
// installs just read the baked-in URL on demand.

/**
 * Start the daily auto-check loop. Idempotent.
 *
 * The first check is deferred 30s after start() so it doesn't compete
 * with library scan / discovery / news fetch / etc at boot. After that
 * runs every 24 hours.
 */
function start() {
  if (_checkTimer) return;
  setTimeout(() => {
    checkNow().catch(e => console.warn('[update] initial remote check failed:', e.message));
  }, 30_000);
  _checkTimer = setInterval(() => {
    checkNow().catch(e => console.warn('[update] periodic remote check failed:', e.message));
  }, CHECK_INTERVAL_MS);
}

function stop() {
  if (_checkTimer) { clearInterval(_checkTimer); _checkTimer = null; }
}

module.exports = {
  start,
  stop,
  checkNow,
  findRemoteUpdate,
  // v1.1.1.3 — channel-aware additions for the tier system.
  // Routes pass the user's channel to findRemoteUpdateForChannel
  // and use getAvailableChannels / getAccessTiers / getChannelMetadata
  // to populate the Settings channel picker.
  findRemoteUpdateForChannel,
  getAvailableChannels,
  getAccessTiers,
  getChannelMetadata,
  downloadTar,
  getStatus,
  getManifestUrl,
  setManifestUrl,
  getPendingDirHost,
};
