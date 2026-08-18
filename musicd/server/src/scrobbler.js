// Last.fm scrobbler (#30.25)
// ===========================
//
// Sends "now playing" notifications and scrobbles to Last.fm based
// on user playback. Uses the mobile-auth flow (username + password →
// session key) which is simplest for self-hosted users on a LAN.
//
// Scrobble eligibility (per Last.fm spec):
//   - Track duration ≥ 30 seconds
//   - AND (played ≥ 50% OR played ≥ 240 seconds)
//
// We persist failed scrobbles to a queue table on disk so a network
// blip doesn't lose history. Retried in batches every minute.
//
// Honest notes on the auth method:
// Last.fm's `auth.getMobileSession` is being deprecated in favour of
// the desktop-auth flow (browser redirect). It still works but Last.fm
// has been signalling for years that they want to remove it. If it
// ever stops working, we'll need to switch to the browser flow which
// is awkward for a self-hosted app on LAN. The user-facing UI tells
// users this honestly so they're not surprised if it breaks.

const axios = require('axios');
const crypto = require('crypto');
const db = require('./db');
const serviceHealth = require('./serviceHealth');

const LFM_API_BASE = 'https://ws.audioscrobbler.com/2.0/';
const REQUEST_TIMEOUT_MS = 12000;
const RETRY_INTERVAL_MS = 60_000;     // try the queue once a minute
const MAX_QUEUE_RETRIES = 30;          // give up after ~30 minutes of failures

// Module state
let _retryTimer = null;
// Per-zone scrobble tracking. Map from zoneId → { trackId, startedAt,
// scrobbleSent, nowPlayingSent, duration }. Reset whenever the current
// track changes.
const _zoneState = new Map();

// ── Settings helpers ─────────────────────────────────────────────────

function getSetting(key, fallback = '') {
  try {
    const row = db.get().prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row?.value ?? fallback;
  } catch {
    return fallback;
  }
}

function setSetting(key, value) {
  db.get().prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value == null ? null : String(value));
}

// ── Last.fm signature ────────────────────────────────────────────────
// Every signed Last.fm request needs an api_sig parameter, computed as
// MD5(concat-sorted-params + secret). The api_key and shared secret
// are now baked in (#v1.1.0.23) -- previously users had to register
// their own Last.fm app and paste the keys into Settings, which was
// unnecessary friction. Per-user session keys are still per-user.

const { LASTFM_API_KEY, LASTFM_API_SECRET } = require('./apiCredentials');

function buildSignature(params, secret) {
  // Sort params by key, concat key+value, append secret, md5.
  // Per docs: do NOT include `format` or `callback` in the signature.
  const filtered = Object.entries(params)
    .filter(([k]) => k !== 'format' && k !== 'callback')
    .sort(([a], [b]) => a.localeCompare(b));
  const concat = filtered.map(([k, v]) => `${k}${v}`).join('');
  return crypto.createHash('md5').update(concat + secret, 'utf8').digest('hex');
}

// ── Last.fm API call ─────────────────────────────────────────────────
// Wraps signed POST requests. Throws on HTTP failure or Last.fm error
// response. The caller decides whether to retry / queue / give up.

async function lfmCall(method, params, { signed = true } = {}) {
  const allParams = {
    method,
    api_key: LASTFM_API_KEY,
    ...params,
  };
  if (signed) {
    allParams.api_sig = buildSignature(allParams, LASTFM_API_SECRET);
  }
  allParams.format = 'json';

  // Last.fm requires write methods (auth, scrobble, updateNowPlaying)
  // to use POST. Read methods can be GET. We use POST for everything
  // signed; cheap, and avoids URL length issues with long titles.
  const formBody = new URLSearchParams(allParams).toString();
  let res;
  try {
    res = await axios.post(LFM_API_BASE, formBody, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        // Identify ourselves; Last.fm doesn't require it but it's polite.
        'User-Agent': 'musicd-scrobbler',
      },
      timeout: REQUEST_TIMEOUT_MS,
      // Don't throw on 4xx; Last.fm puts error info in the body which
      // we want to inspect.
      validateStatus: () => true,
    });
  } catch (e) {
    // Network/timeout/DNS — not a Last.fm protocol error, but still
    // counts as "Last.fm not reachable" for health purposes.
    serviceHealth.recordFailure('lastfm', e.message || 'network error');
    throw e;
  }

  // Last.fm returns errors as { error: <code>, message: <string> }
  if (res.data?.error) {
    const err = new Error(res.data.message || `Last.fm error ${res.data.error}`);
    err.lfmCode = res.data.error;
    serviceHealth.recordFailure('lastfm', `${res.data.error}: ${err.message}`);
    throw err;
  }
  if (res.status >= 400) {
    serviceHealth.recordFailure('lastfm', `HTTP ${res.status}`);
    throw new Error(`HTTP ${res.status}`);
  }
  serviceHealth.recordSuccess('lastfm');
  return res.data;
}

// ── Authentication (mobile auth) ─────────────────────────────────────
// Exchange username + password for a session key. The session key is
// what we store; the password is forgotten immediately after the
// exchange.
//
// Last.fm's auth.getMobileSession requires the password to be hashed
// in a specific way as part of the signed-params calculation, but the
// password is sent as a plain `password` parameter (over HTTPS).

async function login(username, password) {
  if (!username || !password) {
    throw new Error('Username and password are required');
  }

  let data;
  try {
    data = await lfmCall('auth.getMobileSession', {
      username,
      password,
    });
  } catch (e) {
    // Last.fm error code 4 is "Authentication failed: Invalid credentials"
    if (e.lfmCode === 4) throw new Error('Invalid Last.fm username or password');
    if (e.lfmCode === 10) throw new Error('Last.fm rejected our app credentials. Contact the developer.');
    if (e.lfmCode === 13) throw new Error('Signature mismatch — likely a bug. Contact the developer.');
    throw e;
  }

  const session = data?.session;
  if (!session?.key || !session?.name) {
    throw new Error('Last.fm returned no session — login failed');
  }

  // Persist. Note: we store the session key (not the password). The
  // session key is long-lived; users can revoke it from Last.fm's
  // applications page.
  setSetting('lastfm_username', session.name);
  setSetting('lastfm_session_key', session.key);
  setSetting('scrobble_enabled', '1');

  console.log(`[scrobble] Logged in as ${session.name}`);
  return { username: session.name };
}

function logout() {
  setSetting('lastfm_username', '');
  setSetting('lastfm_session_key', '');
  setSetting('scrobble_enabled', '0');
  // Clear in-memory zone state too -- we don't want to scrobble after
  // logout if a poll fires before the next track changes.
  _zoneState.clear();
  console.log('[scrobble] Logged out');
}

function isConnected() {
  return !!(getSetting('lastfm_session_key', '').trim()
            && getSetting('scrobble_enabled', '') === '1');
}

function getStatus() {
  const lastError = getSetting('scrobble_last_error', '');
  const queueDepth = getQueueDepth();
  return {
    connected: isConnected(),
    username: getSetting('lastfm_username', '') || null,
    lastError: lastError || null,
    queueDepth,
    // hasApiKey/hasApiSecret were exposed when users had to provide
    // their own. Now that the keys are baked in (#v1.1.0.23) these
    // are always true; keep them in the response shape so the client
    // doesn't break, but they're now constants.
    hasApiKey: true,
    hasApiSecret: true,
  };
}

// ── Queue persistence ────────────────────────────────────────────────
// Failed scrobbles get persisted so they survive restarts. Re-tried
// every minute (in batches of 50, the Last.fm batch limit).

function getQueueDepth() {
  try {
    const r = db.get().prepare('SELECT COUNT(*) AS c FROM scrobble_queue').get();
    return r?.c || 0;
  } catch { return 0; }
}

function enqueueScrobble(track, timestamp) {
  try {
    db.get().prepare(`
      INSERT INTO scrobble_queue (artist, album, track, album_artist, duration, played_at, attempts)
      VALUES (?, ?, ?, ?, ?, ?, 0)
    `).run(
      track.artist || '',
      track.album || null,
      track.title || '',
      track.album_artist || null,
      Math.round(track.duration || 0),
      timestamp,
    );
  } catch (e) {
    console.warn('[scrobble] Failed to queue:', e.message);
  }
}

async function flushQueue() {
  if (!isConnected()) return;
  let rows;
  try {
    rows = db.get().prepare(`
      SELECT id, artist, album, track, album_artist, duration, played_at, attempts
      FROM scrobble_queue
      ORDER BY played_at ASC
      LIMIT 50
    `).all();
  } catch { return; }
  if (rows.length === 0) return;

  // Last.fm's track.scrobble accepts batch up to 50 with [N] suffix
  // params. We send the whole batch in one call.
  const sk = getSetting('lastfm_session_key', '').trim();
  const params = { sk };
  rows.forEach((row, i) => {
    params[`artist[${i}]`] = row.artist;
    params[`track[${i}]`] = row.track;
    params[`timestamp[${i}]`] = String(row.played_at);
    if (row.album) params[`album[${i}]`] = row.album;
    if (row.album_artist && row.album_artist !== row.artist) {
      params[`albumArtist[${i}]`] = row.album_artist;
    }
    if (row.duration > 0) params[`duration[${i}]`] = String(row.duration);
  });

  try {
    await lfmCall('track.scrobble', params);
    // Success: delete the rows we just sent.
    const placeholders = rows.map(() => '?').join(',');
    db.get().prepare(`DELETE FROM scrobble_queue WHERE id IN (${placeholders})`)
      .run(...rows.map(r => r.id));
    setSetting('scrobble_last_error', '');
    console.log(`[scrobble] Flushed ${rows.length} queued scrobbles`);
  } catch (e) {
    setSetting('scrobble_last_error', e.message || 'Unknown error');
    // Increment attempt count; drop rows that exceeded MAX_QUEUE_RETRIES
    db.get().prepare(`
      UPDATE scrobble_queue SET attempts = attempts + 1
      WHERE id IN (${rows.map(() => '?').join(',')})
    `).run(...rows.map(r => r.id));
    db.get().prepare(`DELETE FROM scrobble_queue WHERE attempts > ?`)
      .run(MAX_QUEUE_RETRIES);
    console.warn(`[scrobble] Flush failed (${rows.length} queued): ${e.message}`);
  }
}

function startRetryLoop() {
  if (_retryTimer) return;
  _retryTimer = setInterval(() => {
    flushQueue().catch(() => {});
  }, RETRY_INTERVAL_MS);
  // Also try once on startup in case there's queued stuff from before.
  setTimeout(() => flushQueue().catch(() => {}), 5000);
}

// ── Player hooks ─────────────────────────────────────────────────────
// Called from playerState.js. The two events that matter:
//   1. Track started playing → reset state, send updateNowPlaying
//   2. Each playback poll tick → check if we should scrobble yet

/**
 * Called when a track starts playing on a zone. Resets the per-track
 * scrobble state and fires the updateNowPlaying call (fire-and-forget;
 * if it fails we don't queue — the now-playing indicator on Last.fm
 * is ephemeral).
 */
async function onTrackStart(zoneId, track) {
  if (!isConnected()) return;
  if (!track || !track.title || !track.artist) return;
  // Track too short to ever scrobble — don't bother with now-playing
  // either, just skip cleanly.
  const duration = Number(track.duration) || 0;
  if (duration > 0 && duration < 30) return;

  _zoneState.set(zoneId, {
    trackId: track.id,
    startedAt: Math.floor(Date.now() / 1000),
    duration,
    scrobbleSent: false,
    nowPlayingSent: false,
  });

  // updateNowPlaying. Fire-and-forget. We don't queue these because
  // Last.fm's "now playing" indicator only matters in real time --
  // a delayed update is worse than no update.
  try {
    const sk = getSetting('lastfm_session_key', '').trim();
    const params = {
      artist: track.artist,
      track: track.title,
      sk,
    };
    if (track.album) params.album = track.album;
    if (track.album_artist && track.album_artist !== track.artist) {
      params.albumArtist = track.album_artist;
    }
    if (duration > 0) params.duration = String(Math.round(duration));
    await lfmCall('track.updateNowPlaying', params);
    const state = _zoneState.get(zoneId);
    if (state) state.nowPlayingSent = true;
  } catch (e) {
    // Don't surface this -- now-playing is best-effort. Note in the
    // last-error field for the status endpoint, in case the user is
    // wondering why they don't see "now playing" on Last.fm.
    setSetting('scrobble_last_error', `now-playing failed: ${e.message}`);
  }
}

/**
 * Called from the polling loop with the current playhead position.
 * If eligibility is met, scrobble (or queue if offline). Idempotent
 * within a single track play -- we set scrobbleSent so repeated calls
 * during the eligible window don't double-scrobble.
 */
function onPlaybackTick(zoneId, currentPositionSec) {
  if (!isConnected()) return;
  const state = _zoneState.get(zoneId);
  if (!state || state.scrobbleSent) return;

  const duration = state.duration;
  // Eligibility per Last.fm: 30s minimum duration, AND played at least
  // half the track or 4 minutes (whichever is less). When duration is
  // unknown (0), Last.fm's docs say still scrobble after 4 minutes.
  const eligible =
    (duration === 0 && currentPositionSec >= 240) ||
    (duration >= 30 && (currentPositionSec >= duration / 2 || currentPositionSec >= 240));

  if (!eligible) return;

  // Mark sent immediately so we don't re-fire on the next tick.
  state.scrobbleSent = true;

  const track = {
    artist: state.artist,
    title: state.title,
    album: state.album,
    album_artist: state.album_artist,
    duration: state.duration,
  };
  // We don't have the full track object on the state -- fetch it.
  // Cheap because better-sqlite3 is sync and the row is tiny.
  let row;
  try {
    row = db.get().prepare(`
      SELECT id, title, artist, album, album_artist, duration
      FROM tracks WHERE id = ?
    `).get(state.trackId);
  } catch {}
  if (!row) return;
  if (!row.title || !row.artist) return;

  enqueueScrobble(row, state.startedAt);
  // Try to flush right away; if it fails, the queue will be retried.
  flushQueue().catch(() => {});
}

/**
 * Reset state when a track ends (paused mid-track or stopped). Doesn't
 * scrobble retroactively -- if the user paused before the threshold,
 * the play didn't count, per Last.fm's design.
 */
function onTrackEnd(zoneId) {
  _zoneState.delete(zoneId);
}

// ── Module init ──────────────────────────────────────────────────────
// Start the retry loop on first require. Idempotent.
startRetryLoop();

module.exports = {
  // Auth
  login,
  logout,
  getStatus,
  isConnected,
  // Player hooks
  onTrackStart,
  onPlaybackTick,
  onTrackEnd,
  // Manual operations
  flushQueue,
};
