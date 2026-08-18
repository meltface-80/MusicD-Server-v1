// Remote update fetcher (#30.6).
// =================================
// Polls a JSON manifest URL, compares the version field to the running
// version, and on demand downloads the referenced tar into the local
// /mnt/downloads watch folder so the existing updater pipeline picks
// it up.
//
// The manifest format (kept deliberately small):
//
//   {
//     "version": "1.1.3.8",
//     "tarUrl":  "https://github.com/.../raw/main/musicd-v1-1-3-8.tar",
//     "tarSha256": null,          // optional — see expectedSha256For()
//     "releaseNotes": "Optional human-readable notes"
//   }
//
// Why a manifest instead of fetching the tar directly:
// every poll only needs to read ~200 bytes (the JSON), and we only
// download the multi-MB tar when the user actually opts in to update.
//
// The manifest URL itself is stable for the lifetime of the project —
// the *contents* of the manifest change with each release.
//
// v1.1.3.8 — the manifest moved from a public Dropbox share link to
// this repo, served over GitHub raw:
//
//   https://raw.githubusercontent.com/meltface-80/MusicD-Server-v1/main/manifest.json
//
// Why: the Dropbox link was a standing liability. Its share URL carries
// load-bearing query parameters (`rlkey`, `dl=1`) plus a `st=` session
// token that expires within hours, and getting any of them wrong meant
// the server was served an HTML preview page instead of JSON — which is
// exactly how auto-update silently did nothing until v1.1.2.3. Serving
// the manifest out of the repo means the release, its notes and the
// manifest that announces it are one commit, the URL has no expiring
// parts, and anyone can see what is being published. This mirrors what
// MusicD-Server-Bridge already does.
//
// The tar is hosted in the repo too, not as a GitHub Release asset:
//
//   https://github.com/meltface-80/MusicD-Server-v1/raw/main/musicd-v1-1-3-8.tar
//
// That URL 302s to the raw CDN; axios follows it (maxRedirects: 5).
//
// State model:
//   _lastCheck:  timestamp of last manifest fetch attempt
//   _lastResult: parsed manifest from the most recent successful fetch,
//                or { error } from the most recent failed fetch.
//   _lastGood:   the most recent *successfully parsed* manifest, which
//                a later failure never clears (v1.1.3.8 — see below).
//   _checkInFlight: shared promise for in-flight checks (so concurrent
//                   callers don't trigger multiple fetches)
//
// The daily refresh loop is started by start(); manual checks call
// checkNow() which returns the same shape regardless of timing.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');   // v1.1.3.8 — optional tar SHA-256 check
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
// blocking forever if the manifest host is slow.
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
let _lastGood      = null;    // last successfully parsed manifest (v1.1.3.8)
let _checkInFlight = null;    // Promise during an in-progress check
let _checkTimer    = null;    // setInterval handle for daily checks

/**
 * v1.1.3.8 — the manifest every reader below works from.
 *
 * Returns the newest successfully parsed manifest, which is normally
 * _lastResult but falls back to _lastGood when the most recent check
 * failed. Before this, one failed fetch replaced _lastResult with
 * { error } and every reader went null with it — so a single DNS blip
 * or a five-second GitHub outage took the whole tier system down with
 * it: getAccessTiers() returned null and POST /api/update/tier/code
 * answered 503 "manifest not available yet" for the next 24 hours,
 * until the daily poll happened to succeed. A manifest we fetched an
 * hour ago is still a perfectly good answer to "which codes are valid"
 * and "what is on the beta channel"; a transient network error is not
 * a reason to forget it.
 *
 * getStatus() deliberately keeps reporting _lastResult, so the Settings
 * page still shows the live error even while the cached manifest is
 * being served from here.
 */
function cachedManifest() {
  if (_lastResult && !_lastResult.error) return _lastResult;
  if (_lastGood && !_lastGood.error) return _lastGood;
  return null;
}

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
    // that's NOT one of the shipped defaults, keep it.
    //
    // v1.1.3.8 — this compares against every URL we have ever shipped
    // as the default (isSupersededDefault), not just the current one.
    // Installs from v1.1.0.24 and earlier still have the old Dropbox
    // URL sitting in their settings table because that release seeded
    // it there. With a single-string comparison, moving the default to
    // GitHub raw would have made that stored Dropbox URL suddenly look
    // like a deliberate user override — and every one of those installs
    // would have gone on polling the dead Dropbox link forever, never
    // seeing another release. A row that merely repeats a default we
    // once shipped is not a choice the user made.
    if (row && v === '') return null;
    if (v && !isSupersededDefault(v)) return v;
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
 * v1.1.3.8 — now the manifest committed to this repo, served by
 * GitHub raw off the default branch. The manifest and the tar it
 * points at land in the same commit as the code they describe, so a
 * release can no longer half-exist (published tar, un-updated
 * manifest, or the reverse), and there is nothing in the URL that
 * expires.
 *
 * Previously (v1.1.2.3 through v1.1.3.7) this was a Dropbox public
 * share link, kept here for the record because installs still carry
 * it in their settings table:
 *
 *   https://www.dropbox.com/scl/fi/f652dr08cy6cci4e2ur17/manifest.json?rlkey=...&dl=1
 *
 * Two separate bugs had to be fixed in that URL before it worked at
 * all — `dl=0` served an HTML preview page instead of the JSON, and
 * the `st=` session token expired within hours and started answering
 * 403 — which is the whole argument for a URL with no parameters.
 */
const DEFAULT_MANIFEST_URL = 'https://raw.githubusercontent.com/meltface-80/MusicD-Server-v1/main/manifest.json';

/**
 * Every URL we have ever shipped as the baked-in default.
 *
 * Installs from v1.1.0.24 and earlier had the default of their day
 * written into `settings.update_manifest_url`; later releases stopped
 * seeding the row but still read it. A stored value matching any entry
 * here is therefore a leftover, not a user choice, and getManifestUrl()
 * treats it as "no setting" so those installs follow the current
 * default instead of being pinned to a retired one.
 *
 * Compared after normaliseDropboxUrl() so the dl=0 / st=... variants of
 * the same Dropbox link that were seeded at different times all match.
 * Add to this list — never edit an entry — whenever the default moves.
 */
const LEGACY_DEFAULT_URLS = [
  'https://www.dropbox.com/scl/fi/f652dr08cy6cci4e2ur17/manifest.json?rlkey=pglhbq32hpsq9ofp10zg07l89&dl=1',
  'https://www.dropbox.com/scl/fi/f652dr08cy6cci4e2ur17/manifest.json?rlkey=pglhbq32hpsq9ofp10zg07l89&dl=0',
  DEFAULT_MANIFEST_URL,
];

/**
 * True if `candidate` is one of the defaults we have shipped, i.e. a
 * value that got into the settings table by seeding rather than by
 * someone choosing it. v1.1.3.8 — replaces the single-string
 * LEGACY_DEFAULT_URL comparison; see getManifestUrl() for why.
 */
function isSupersededDefault(candidate) {
  if (!candidate) return false;
  const c = normaliseDropboxUrl(String(candidate).trim());
  return LEGACY_DEFAULT_URLS.some(u => normaliseDropboxUrl(u) === c);
}

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
 *
 * v1.1.3.8 — the baked-in manifest and tar URLs are now GitHub, so
 * this function is a no-op on the default path: the `dropbox.com`
 * guard on the second line returns the string untouched before any
 * rewriting happens. It is kept, not deleted, because both override
 * routes still exist — MUSICD_MANIFEST_URL and the legacy
 * `update_manifest_url` settings row can each still hold a Dropbox
 * share link, and a private mirror on Dropbox is exactly the case
 * those overrides are for. Deleting it would silently break them.
 *
 * If a rewrite rule is ever added here, it must stay behind that guard
 * — appending `?dl=1` to a raw.githubusercontent.com URL is harmless
 * today, but a rule that touched the path would corrupt it.
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
 * v1.1.3.8 — request headers that ask every cache in the path to
 * revalidate. Sent on the manifest fetch only; the tar download is
 * content-addressed by filename and never changes under a given name,
 * so caching it is a feature.
 */
const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-cache, no-store, max-age=0',
  'Pragma': 'no-cache',
};

/**
 * v1.1.3.8 — append a throwaway query parameter so the manifest fetch
 * cannot be answered from a shared cache.
 *
 * raw.githubusercontent.com is fronted by a CDN that serves the file
 * with a five-minute max-age and, more to the point, keys its cache on
 * the URL. NO_CACHE_HEADERS asks nicely, but a request header is a hint
 * an intermediate cache is free to ignore, and this is the one failure
 * mode that cannot be diagnosed from the server: a stale copy pins the
 * updater to a superseded manifest, every check reports "up to date",
 * and nothing anywhere logs an error. A URL the cache has never seen
 * cannot be stale, so we make one per request. The origin ignores
 * unknown query parameters, and at one manifest fetch per day (plus the
 * occasional manual "Check now") the cost of always missing the cache
 * is nil.
 *
 * Dropbox share links are left alone: their query string is
 * load-bearing (`rlkey`, `dl`) and is not a place to add guesses.
 */
function cacheBustUrl(url) {
  if (!url || typeof url !== 'string') return url;
  if (/dropbox\.com/.test(url)) return url;
  return url + (url.includes('?') ? '&' : '?') + `_cb=${Date.now()}`;
}

/**
 * v1.1.3.8 — turn an axios failure into something a user can act on.
 *
 * A 404 from GitHub raw has one overwhelmingly likely cause during a
 * release: the manifest has not been committed to the branch yet. The
 * bare "Request failed with status code 404" sent people looking for a
 * missing GitHub Release, which is not how this manifest is published.
 */
function describeFetchFailure(e, url) {
  const status = e?.response?.status;
  if (status === 404 && /github(usercontent)?\.com/.test(String(url))) {
    return `fetch failed: HTTP 404 for ${String(url).split('?')[0]} — the ` +
           `manifest is not on that branch. It is published by committing ` +
           `manifest.json, not by cutting a GitHub release.`;
  }
  return `fetch failed: ${e.message}`;
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
    const r = await axios.get(cacheBustUrl(fetchUrl), {
      timeout: MANIFEST_TIMEOUT_MS,
      maxRedirects: 5,
      headers: { 'User-Agent': 'musicd/1.0 update-checker', ...NO_CACHE_HEADERS },
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
        return { error: describeFetchFailure(e2, stripped) };
      }
    } else {
      return { error: describeFetchFailure(e, fetchUrl) };
    }
  }

  if (!body || typeof body !== 'string') {
    return { error: 'empty response body' };
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    // An HTML body means we reached a web page, not the file. v1.1.3.8:
    // the advice depends on where the manifest is hosted — telling a
    // GitHub user to add ?dl=1 sends them somewhere useless, and the
    // real cause there is a wrong path or a private repo serving a 404
    // page.
    if (/<html|<!doctype/i.test(body.slice(0, 200))) {
      return {
        error: /dropbox\.com/i.test(fetchUrl)
          ? 'manifest URL returned HTML (the share link probably needs ?dl=1)'
          : 'manifest URL returned HTML, not JSON — check the path is right and the repo is public',
      };
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
      // v1.1.3.8 — _lastGood is deliberately left alone on failure.
      // The failure is still reported (here, and through getStatus()
      // to the Settings page), but the readers below keep answering
      // from the last manifest that actually parsed, so a transient
      // network error doesn't take the channel picker and the tier
      // codes down with it. See cachedManifest().
      console.warn(`[update] manifest check failed: ${result.error}` +
        (_lastGood ? ' — continuing to use the last good manifest' : ''));
      return result;
    }
    _lastGood = result;
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
  const manifest = cachedManifest();
  if (!manifest) return null;
  // Legacy path: top-level version/tarUrl. Used when no channel
  // context is available (no user tier yet, or manifest has no
  // channels block). v1.1.1.3 routes pass an explicit channel via
  // findRemoteUpdateForChannel() instead.
  if (typeof manifest.version !== 'string' || typeof manifest.tarUrl !== 'string') {
    return null;
  }
  const current = version.parseVersion(version.getVersion());
  const remote = version.parseVersion(manifest.version);
  if (version.compareVersions(remote, current) <= 0) return null;
  // v1.1.1.3 — use version.tarFilenameFor so semver names are
  // generated correctly (musicd-1.0.0-beta.1.tar) alongside legacy
  // names (musicd-v1-1-1-3.tar).
  const tarFilename = version.tarFilenameFor(remote);
  return {
    currentVersion: version.formatVersion(current),
    availableVersion: manifest.version,
    tarFilename,
    downloadUrl: manifest.tarUrl,
    releaseNotes: manifest.releaseNotes || null,
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
  const manifest = cachedManifest();
  if (!manifest) return null;
  if (!manifest.channels || typeof manifest.channels !== 'object') return null;
  const ch = manifest.channels[channelName];
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
  const manifest = cachedManifest();
  if (!manifest) return null;
  if (!manifest.channels || typeof manifest.channels !== 'object') return null;
  const out = {};
  for (const [name, ch] of Object.entries(manifest.channels)) {
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
  const manifest = cachedManifest();
  if (!manifest) return null;
  if (!manifest.accessTiers || typeof manifest.accessTiers !== 'object') return null;
  return manifest.accessTiers;
}

/**
 * v1.1.1.3 — read the cached manifest's channelMetadata block.
 * Returns the raw metadata object or null.
 */
function getChannelMetadata() {
  const manifest = cachedManifest();
  if (!manifest) return null;
  if (!manifest.channelMetadata || typeof manifest.channelMetadata !== 'object') return null;
  return manifest.channelMetadata;
}

/**
 * v1.1.3.8 — find the SHA-256 the manifest declares for a tar URL.
 *
 * Returns a lowercase 64-hex string, or null when the manifest does not
 * publish a usable hash for that URL. "Not usable" covers absent, null,
 * empty, and anything that isn't 64 hex characters — all of them mean
 * the same thing to the caller: nothing to check against.
 *
 * The hash is looked up by URL rather than passed down from the caller
 * so that routes/update.js keeps calling downloadTar(url, filename)
 * unchanged. Top-level and per-channel entries are both searched, and
 * both the camelCase key this server reads (tarSha256) and the
 * bridge-style alias (tarball_sha256 / sha256) are accepted, so a
 * publisher who fills in either spelling gets verification.
 */
function expectedSha256For(downloadUrl) {
  const manifest = cachedManifest();
  if (!manifest || !downloadUrl) return null;
  const want = String(downloadUrl).trim();
  const hashOf = (entry) => {
    for (const key of ['tarSha256', 'tarball_sha256', 'sha256']) {
      const v = entry?.[key];
      if (typeof v === 'string' && /^[0-9a-fA-F]{64}$/.test(v.trim())) {
        return v.trim().toLowerCase();
      }
    }
    return null;
  };
  const isSameTar = (entry) =>
    ['tarUrl', 'tarball_url'].some(key => typeof entry?.[key] === 'string' && entry[key].trim() === want);

  if (isSameTar(manifest)) {
    const h = hashOf(manifest);
    if (h) return h;
  }
  if (manifest.channels && typeof manifest.channels === 'object') {
    for (const ch of Object.values(manifest.channels)) {
      if (isSameTar(ch)) {
        const h = hashOf(ch);
        if (h) return h;
      }
    }
  }
  return null;
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
 *
 * v1.1.3.8 — SHA-256 verification, when and only when the manifest
 * declares one.
 *
 * `expectedSha256` may be passed explicitly; when it is omitted (which
 * is how routes/update.js calls this) the hash is looked up from the
 * cached manifest by URL. A published hash is enforced: mismatch means
 * the tmp file is deleted and nothing is installed. No published hash
 * means the download proceeds on the size and ustar checks alone, with
 * a one-line warning.
 *
 * Optional rather than mandatory because of how this project publishes:
 * the manifest is committed before the tar it points at has been built,
 * so at authoring time the hash genuinely is not knowable, and there is
 * no second place to put it — the manifest URL is the trust anchor.
 * Making the hash mandatory would mean either blocking every update
 * until someone remembers to backfill it, or writing a placeholder that
 * is indistinguishable from a real hash and would fail every download
 * with "checksum mismatch". Refusing all updates is a far worse outcome
 * than the status quo of not checking, which is what every release up
 * to v1.1.3.7 did. Fill tarSha256 in and the check turns itself on.
 */
async function downloadTar(downloadUrl, tarFilename, expectedSha256) {
  if (!downloadUrl) return { ok: false, error: 'no download URL' };

  // v1.1.3.8 — resolve the expected hash before the first byte lands,
  // so the decision "are we verifying this download or not" is made
  // once and can be logged, rather than discovered halfway through.
  const wantSha =
    (typeof expectedSha256 === 'string' && /^[0-9a-fA-F]{64}$/.test(expectedSha256.trim()))
      ? expectedSha256.trim().toLowerCase()
      : expectedSha256For(downloadUrl);

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
  //
  // v1.1.3.8 — the hash is computed from the same chunks on their way
  // past, not by re-reading the finished file: it costs nothing here
  // and it cannot disagree with what was written.
  const hash = wantSha ? crypto.createHash('sha256') : null;
  try {
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tmpPath);
      let bytes = 0;
      stream.on('data', chunk => {
        bytes += chunk.length;
        if (hash) hash.update(chunk);
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
      // v1.1.3.8: same split as the manifest fetch above — Dropbox share
      // links need ?dl=1, whereas a GitHub raw URL serving HTML means the
      // tar is not committed at that path on the default branch.
      return {
        ok: false,
        error: /dropbox\.com/i.test(fetchUrl)
          ? 'download returned HTML — the share link may need ?dl=1'
          : 'download returned HTML, not a tar — check the release tarball is committed at that path on main',
      };
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

  // v1.1.3.8 — checksum gate. Runs before the rename so a tar that
  // fails it never appears under a name findAvailableUpdate() would
  // pick up; the partial file is removed rather than left to be
  // retried into the same failure.
  if (wantSha) {
    const gotSha = hash.digest('hex');
    if (gotSha !== wantSha) {
      try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
      return {
        ok: false,
        error: `checksum mismatch for ${tarFilename}: manifest declares ` +
               `sha256 ${wantSha}, downloaded file hashes to ${gotSha}. ` +
               `Nothing was installed. Either the download was corrupted ` +
               `or the manifest's tarSha256 is stale.`,
      };
    }
    console.log(`[update] sha256 verified for ${tarFilename} (${wantSha})`);
  } else {
    // Not an error: the manifest is allowed to publish no hash, and
    // every release up to v1.1.3.7 published none. Logged so that
    // "was this download checked?" is answerable from the logs.
    console.warn(
      `[update] no sha256 published for ${tarFilename} — installing on the ` +
      `size and tar-magic checks alone. Set tarSha256 in the manifest to ` +
      `enable verification.`);
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
    // v1.1.3.8 — additive field. True when the last check failed but an
    // earlier manifest is still being served to the channel picker and
    // the tier codes, which is otherwise invisible: the UI shows the
    // error from lastResult while everything carries on working.
    // Existing consumers ignore it.
    servingCached:  !!(_lastResult && _lastResult.error && _lastGood && !_lastGood.error),
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
