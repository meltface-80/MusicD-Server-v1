// src/tidal/api.js — Tidal REST API client.
//
// v1.1.33.0. Ported from MusicD-Server-Bridge
// (musicd/server/src/tidal/api.js). Changes on port: the levelled
// logger becomes ../serviceLog, settings reads go through this repo's
// ../settings accessor, and the two numeric settings (token expiry,
// which the shared-refresh guard compares against the clock) are read
// with settings.getNum so a TEXT column cannot turn a comparison into
// a string sort.
//
// Provides:
//   * OAuth 2 device-code flow (start → poll → token)
//   * Refresh-token flow
//   * Authenticated GET wrapper
//   * status / catalog read (search, album, favourites)
//   * getStreamInfo stub for stage 5 playback
//
// All credentials are stored in the `settings` table:
//   tidal_access_token       — Bearer token for the v1 API
//   tidal_refresh_token      — long-lived, used to mint new access tokens
//   tidal_token_expires_at   — unix timestamp (seconds)
//   tidal_user_id            — numeric user id from /v1/sessions
//   tidal_user_display       — username for the settings "Logged in as" line
//   tidal_country_code       — required for catalog GETs (2-letter)
//   tidal_quality            — LOW | HIGH | LOSSLESS | HI_RES_LOSSLESS
//
// CREDENTIALS NOTE: client_id + client_secret below are recycled from
// the actively-maintained reverse-engineered Tidal libraries (python-
// tidal et al). They identify *MusicD itself* to Tidal's API — not the
// user. They are well-known and Tidal occasionally rotates / bans
// them. If/when that happens, playback (stage 5) will break with a
// 4xx from Tidal; update the constants below from one of:
//   https://github.com/tamland/python-tidal
//   https://github.com/yaronzz/Tidal-Media-Downloader
// and bounce musicd. The Open API (developer.tidal.com) doesn't
// expose stream URLs so we cannot use it for the playback path.
//
// MQA: explicitly NOT supported (per user requirement). We never
// request the MQA quality tier and we filter out MQA codec hints from
// any responses.

'use strict';

const settings = require('../settings');
const log = require('../serviceLog').forModule('tidal');

const AUTH_BASE  = 'https://auth.tidal.com/v1/oauth2';
const API_BASE   = 'https://api.tidal.com/v1';

// Recycled client credentials. See header note. The "TV-style" device
// type because that's the OAuth grant that supports device_authorization.
//
// Source: streamrip PR #932 (Jan 2026), credentials base64-decoded.
// Limited Input Device type — supports the device_authorization grant.
const CLIENT_ID     = 'fX2JxdmntZWK0ixT';
const CLIENT_SECRET = '1Nm5AfDAjxrgJFJbKNWLeAyKGVGmINuXPPLHVXAvxAg=';

const USER_AGENT = 'musicd/1.0 (tidal-client)';

const QUALITIES = {
  LOW:              'LOW',
  HIGH:             'HIGH',
  LOSSLESS:         'LOSSLESS',
  HI_RES_LOSSLESS:  'HI_RES_LOSSLESS',
};

// ---- low-level helpers ----------------------------------------------------

// dev.1252: shared upper bounds for every Tidal request.
const TIDAL_REQUEST_TIMEOUT_MS = 10_000;
const TIDAL_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

async function _formPost(url, body) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (v != null) sp.append(k, String(v));
  }
  const ctl = new AbortController();
  const tmo = setTimeout(() => ctl.abort(), TIDAL_REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept':       'application/json',
        'User-Agent':   USER_AGENT,
      },
      body: sp.toString(),
      signal: ctl.signal,
    });
  } catch (e) {
    clearTimeout(tmo);
    if (e.name === 'AbortError') {
      throw new Error(`Tidal: request to ${url} timed out`);
    }
    throw new Error(`Tidal: network error talking to ${url}: ${e.message}`);
  }
  const cl = parseInt(res.headers.get('content-length') || '', 10);
  if (Number.isFinite(cl) && cl > TIDAL_MAX_RESPONSE_BYTES) {
    clearTimeout(tmo);
    throw new Error(`Tidal: response too large (Content-Length ${cl})`);
  }
  let text = '';
  try { text = await res.text(); } catch { /* ignore */ }
  clearTimeout(tmo);
  if (text.length > TIDAL_MAX_RESPONSE_BYTES) {
    throw new Error(`Tidal: response too large (${text.length} bytes)`);
  }
  let json = null;
  if (text) { try { json = JSON.parse(text); } catch { /* leave null */ } }
  if (!res.ok) {
    const code = (json && (json.error || json.status || json.userMessage)) || `HTTP ${res.status}`;
    const desc = (json && (json.error_description || json.subStatus || json.userMessage)) || '';
    const err = new Error(`Tidal: ${code}${desc ? ': ' + desc : ''}`);
    err.status = res.status;
    err.body = json || text;
    throw err;
  }
  return json;
}

async function _authedGet(path, params) {
  await _ensureFreshAccessToken();
  const accessToken = settings.get('tidal_access_token');
  if (!accessToken) {
    throw new Error('Tidal: not logged in');
  }
  const url = new URL(API_BASE + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v != null) url.searchParams.append(k, String(v));
    }
  }
  // Tidal v1 catalog endpoints require countryCode. Inject if missing.
  if (!url.searchParams.has('countryCode')) {
    const cc = settings.get('tidal_country_code');
    if (cc) url.searchParams.append('countryCode', cc);
  }
  const ctl = new AbortController();
  const tmo = setTimeout(() => ctl.abort(), TIDAL_REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url.toString(), {
      method:  'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept':        'application/json',
        'User-Agent':    USER_AGENT,
      },
      signal: ctl.signal,
    });
  } catch (e) {
    clearTimeout(tmo);
    if (e.name === 'AbortError') {
      throw new Error(`Tidal: request to ${url} timed out`);
    }
    throw new Error(`Tidal: network error talking to ${url}: ${e.message}`);
  }
  const cl = parseInt(res.headers.get('content-length') || '', 10);
  if (Number.isFinite(cl) && cl > TIDAL_MAX_RESPONSE_BYTES) {
    clearTimeout(tmo);
    throw new Error(`Tidal: response too large (Content-Length ${cl})`);
  }
  let text = '';
  try { text = await res.text(); } catch { /* ignore */ }
  clearTimeout(tmo);
  if (text.length > TIDAL_MAX_RESPONSE_BYTES) {
    throw new Error(`Tidal: response too large (${text.length} bytes)`);
  }
  let json = null;
  if (text) { try { json = JSON.parse(text); } catch { /* leave null */ } }
  if (!res.ok) {
    const code = (json && (json.error || json.status || json.userMessage)) || `HTTP ${res.status}`;
    const desc = (json && (json.error_description || json.subStatus || json.userMessage)) || '';
    const err = new Error(`Tidal: ${code}${desc ? ': ' + desc : ''}`);
    err.status = res.status;
    err.body = json || text;
    throw err;
  }
  return json;
}

// ---- auth: device-code flow ------------------------------------------------

/**
 * Start a device-code authorization. Returns { user_code,
 * verification_uri, verification_uri_complete, device_code,
 * expires_in, interval }.
 *
 * Front-end shows user_code + verification_uri to the user; user
 * visits the URL on any device and enters the code; meanwhile the
 * front-end polls authPoll() until the user completes consent.
 */
async function authStart() {
  const r = await _formPost(`${AUTH_BASE}/device_authorization`, {
    client_id: CLIENT_ID,
    scope:     'r_usr w_usr',
  });
  // Normalise to a stable shape — Tidal returns deviceCode (camel) in
  // some builds and device_code (snake) in others.
  return {
    device_code:               r.deviceCode || r.device_code,
    user_code:                 r.userCode || r.user_code,
    verification_uri:          r.verificationUri || r.verification_uri || 'link.tidal.com',
    verification_uri_complete: r.verificationUriComplete || r.verification_uri_complete,
    expires_in:                r.expiresIn || r.expires_in || 600,
    interval:                  r.interval || 2,
  };
}

/**
 * Poll the token endpoint with a device_code. Returns:
 *   { status: 'pending' }                — user hasn't consented yet
 *   { status: 'ok' }                     — token persisted, ready to use
 *   throws Error on terminal failure (expired, denied, etc.)
 */
async function authPoll(deviceCode) {
  if (!deviceCode) throw new Error('Tidal: device_code required');
  try {
    const r = await _formPost(`${AUTH_BASE}/token`, {
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      device_code:   deviceCode,
      grant_type:    'urn:ietf:params:oauth:grant-type:device_code',
      scope:         'r_usr w_usr',
    });
    await _persistTokenResponse(r);
    return { status: 'ok' };
  } catch (e) {
    // Tidal returns 400 + sub_status / error=authorization_pending
    // while waiting for user consent. Map it to a "pending" result.
    if (e.status === 400 && e.body) {
      const code = e.body.error || '';
      const sub  = e.body.subStatus || e.body.sub_status || 0;
      if (code === 'authorization_pending' || sub === 1002) {
        return { status: 'pending' };
      }
      // Slow down — we polled too fast.
      if (code === 'slow_down' || sub === 1003) {
        return { status: 'pending' };
      }
    }
    throw e;
  }
}

async function _persistTokenResponse(r) {
  const accessToken  = r.access_token;
  const refreshToken = r.refresh_token;
  const expiresIn    = Number(r.expires_in || 0);
  const expiresAt    = Math.floor(Date.now() / 1000) + (expiresIn || 86400);
  if (!accessToken) throw new Error('Tidal: token response missing access_token');
  settings.set('tidal_access_token', accessToken);
  if (refreshToken) settings.set('tidal_refresh_token', refreshToken);
  settings.set('tidal_token_expires_at', expiresAt);
  // Pull user info immediately so we have user_id + country_code for
  // subsequent catalog calls.
  try {
    const sess = await _sessionsCall(accessToken);
    if (sess && sess.userId)      settings.set('tidal_user_id',       sess.userId);
    if (sess && sess.countryCode) settings.set('tidal_country_code',  sess.countryCode);
    if (sess && sess.username)    settings.set('tidal_user_display',  sess.username);
  } catch (e) {
    // Non-fatal: session fetch failed but we already have a token.
    // Subsequent api calls will fail more usefully and we can retry.
    log.warn(`session lookup failed after auth: ${e.message}`);
  }
}

async function _sessionsCall(accessToken) {
  // /sessions is a GET that returns the auth context the token grants.
  // Used to discover userId + countryCode after device-code auth.
  const url = `${API_BASE}/sessions`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept':        'application/json',
      'User-Agent':    USER_AGENT,
    },
    // Same dev.1252 hardening as _formPost/_authedGet: a hung
    // /sessions otherwise wedges authPoll and the first catalog
    // request after a refresh for undici's multi-minute default.
    signal: AbortSignal.timeout(TIDAL_REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Tidal /sessions returned ${res.status}`);
  }
  return res.json();
}

// Tidal rotates refresh tokens: concurrent refreshes race, and the
// losing writer persists a stale refresh token — the next refresh then
// 401s and silently signs the user out. Share one in-flight refresh
// across all concurrent callers.
let _refreshInFlight = null;

async function _ensureFreshAccessToken() {
  const expiresAt = settings.getNum('tidal_token_expires_at', 0);
  const now       = Math.floor(Date.now() / 1000);
  // Refresh if expiring within 60 seconds.
  if (now < expiresAt - 60) return;
  const refreshToken = settings.get('tidal_refresh_token');
  if (!refreshToken) {
    // No refresh token — caller will see "not logged in".
    return;
  }
  if (_refreshInFlight) return _refreshInFlight;
  _refreshInFlight = _doRefresh(refreshToken).finally(() => { _refreshInFlight = null; });
  return _refreshInFlight;
}

async function _doRefresh(refreshToken) {
  try {
    const r = await _formPost(`${AUTH_BASE}/token`, {
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
      scope:         'r_usr w_usr',
    });
    await _persistTokenResponse(r);
    log.info('refreshed Tidal access token');
  } catch (e) {
    log.warn(`Tidal token refresh failed: ${e.message}`);
    // dev.1252: only clear the access token when the failure is
    // unambiguously an auth error (401/403 from Tidal). Transient
    // network blips and 5xx upstream should NOT permanently sign the
    // user out — leave the token in place so the next request can
    // retry on a fresh socket.
    if (e.status === 401 || e.status === 403) {
      settings.set('tidal_access_token', null);
    }
  }
}

function isLoggedIn() {
  return !!settings.get('tidal_access_token');
}

function logout() {
  settings.set('tidal_access_token', null);
  settings.set('tidal_refresh_token', null);
  settings.set('tidal_token_expires_at', null);
  settings.set('tidal_user_id', null);
  settings.set('tidal_user_display', null);
  // Keep country_code + quality preference — those are user prefs not
  // session state.
}

function getStatus() {
  return {
    logged_in:    isLoggedIn(),
    user: isLoggedIn() ? {
      id:      settings.get('tidal_user_id'),
      display: settings.get('tidal_user_display'),
    } : null,
    quality:      settings.get('tidal_quality') || 'LOSSLESS',
    country_code: settings.get('tidal_country_code') || null,
  };
}

function setQuality(quality) {
  if (!QUALITIES[quality]) throw new Error(`Tidal: invalid quality "${quality}"`);
  settings.set('tidal_quality', quality);
}

// ---- catalog (read) -------------------------------------------------------

/**
 * search(query, type, limit) — type in 'albums', 'artists', 'tracks',
 * or null for everything. Returns Tidal's native shape:
 *   { albums: { items, totalNumberOfItems, ... }, tracks: ..., ... }
 */
async function search(query, type, limit) {
  if (!query) throw new Error('Tidal: query required');
  limit = Math.max(1, Math.min(100, Number(limit) || 25));
  // Tidal's v1 search endpoint covers all types with a single call;
  // when type is specified we use the typed endpoint to keep the
  // response small. Either way it returns the same shape.
  const path = type ? `/search/${type}` : '/search';
  return _authedGet(path, {
    query,
    limit,
    offset: 0,
  });
}

async function getAlbum(albumId) {
  if (!albumId) throw new Error('Tidal: album id required');
  return _authedGet(`/albums/${encodeURIComponent(albumId)}`);
}

async function getAlbumTracks(albumId) {
  if (!albumId) throw new Error('Tidal: album id required');
  const r = await _authedGet(`/albums/${encodeURIComponent(albumId)}/tracks`, {
    limit: 100,
    offset: 0,
  });
  return (r && Array.isArray(r.items)) ? r.items : [];
}

/**
 * getFavorites('albums' | 'tracks' | 'artists', limit, offset)
 */
async function getFavorites(kind, limit, offset) {
  const userId = settings.get('tidal_user_id');
  if (!userId) throw new Error('Tidal: no user id (not logged in?)');
  limit  = Math.max(1, Math.min(100, Number(limit) || 50));
  offset = Math.max(0, Number(offset) || 0);
  return _authedGet(`/users/${encodeURIComponent(userId)}/favorites/${kind}`, {
    limit,
    offset,
    order: 'DATE',
    orderDirection: 'DESC',
  });
}

/**
 * setAlbumFavorite(albumId, add) — true to add, false to remove.
 * Sends POST /users/{uid}/favorites/albums with albumIds=<id>, or
 * DELETE /users/{uid}/favorites/albums/<id>.
 */
async function setAlbumFavorite(albumId, add) {
  await _ensureFreshAccessToken();
  const accessToken = settings.get('tidal_access_token');
  const userId      = settings.get('tidal_user_id');
  const countryCode = settings.get('tidal_country_code');
  if (!accessToken || !userId) throw new Error('Tidal: not logged in');

  let url, method, body;
  if (add) {
    url = new URL(`${API_BASE}/users/${encodeURIComponent(userId)}/favorites/albums`);
    if (countryCode) url.searchParams.set('countryCode', countryCode);
    method = 'POST';
    const sp = new URLSearchParams();
    sp.append('albumIds', String(albumId));
    body = sp.toString();
  } else {
    url = new URL(`${API_BASE}/users/${encodeURIComponent(userId)}/favorites/albums/${encodeURIComponent(albumId)}`);
    if (countryCode) url.searchParams.set('countryCode', countryCode);
    method = 'DELETE';
    body = undefined;
  }

  const res = await fetch(url.toString(), {
    method,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept':        'application/json',
      'User-Agent':    USER_AGENT,
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body,
  });
  if (!res.ok && res.status !== 404) {
    let text = '';
    try { text = await res.text(); } catch {}
    throw new Error(`Tidal favorite toggle ${method} returned ${res.status}: ${text.slice(0, 200)}`);
  }
  return { ok: true };
}

// ---- playback ------------------------------------------------------------
//
// getStreamInfo(trackId, qualityOverride) — resolve a Tidal track to
// something ffmpeg can read.
//
// Calls /v1/tracks/{id}/playbackinfopostpaywall. Tidal returns one
// of two manifest shapes:
//
//   application/vnd.tidal.bts — base64-encoded JSON envelope:
//     { mimeType: 'audio/flac', codecs: 'flac',
//       encryptionType: 'NONE', urls: ['https://...'] }
//     We extract urls[0]; that's a signed direct FLAC/AAC URL. ffmpeg
//     reads it with -i <url>.
//
//   application/dash+xml — base64-encoded MPEG-DASH manifest. Used
//     for HI_RES_LOSSLESS (multi-bitrate adaptation). The XML refers
//     to segment URLs at https://...tidal.com/.../<seg>. ffmpeg
//     reads DASH manifests directly with -i <mpd>, so we write the
//     decoded XML to a temp .mpd file and return that file path.
//
// Returns:
//   {
//     source:        'url' | 'file',    // url is HTTPS, file is local path
//     value:         '<url-or-path>',   // what to pass to ffmpeg
//     mime:          'audio/flac' | 'audio/mp4' | 'application/dash+xml',
//     codec:         'flac' | 'mp4a' | etc.
//     audioQuality:  'LOW' | 'HIGH' | 'LOSSLESS' | 'HI_RES_LOSSLESS',
//     isDash:        bool,
//     replayGain:    { trackGain, trackPeak, albumGain, albumPeak } | null,
//     cleanup:       async fn that removes any temp file we created
//                    (null if there's nothing to clean)
//   }

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// dev.1239 (stage 5): temp directory for DASH manifests. We hold them
// until the player tells us the track has finished (via the cleanup
// callback on the return value). One file per stream session — small
// (~5KB each), so a few stale ones from crash-restart are not a
// space concern, but the cleanup paths handle them anyway.
const TIDAL_MPD_DIR = path.join(os.tmpdir(), 'musicd-tidal-mpd');
try {
  fs.mkdirSync(TIDAL_MPD_DIR, { recursive: true });
} catch { /* ignore */ }

// dev.1252: janitor sweeps the .mpd temp dir every 30 minutes and
// removes any file older than 2 hours. Without this, abandoned
// playback (user skipped the track before the stream's cleanup
// callback fired) leaked .mpd files until the next process restart.
// The sweep is .unref()'d so it never holds the event loop open.
const TIDAL_MPD_TTL_MS    = 2 * 60 * 60 * 1000;
const TIDAL_MPD_SWEEP_MS  = 30 * 60 * 1000;
function _sweepTidalMpdDir() {
  fs.readdir(TIDAL_MPD_DIR, (err, names) => {
    if (err) return;
    const cutoff = Date.now() - TIDAL_MPD_TTL_MS;
    for (const name of names) {
      if (!name.endsWith('.mpd')) continue;
      const fpath = path.join(TIDAL_MPD_DIR, name);
      fs.stat(fpath, (statErr, st) => {
        if (statErr || !st) return;
        if (st.mtimeMs < cutoff) {
          fs.unlink(fpath, () => { /* best effort */ });
        }
      });
    }
  });
}
setInterval(_sweepTidalMpdDir, TIDAL_MPD_SWEEP_MS).unref();
// One sweep at module load to mop up anything left from a prior crash.
_sweepTidalMpdDir();

async function getStreamInfo(trackId, qualityOverride) {
  if (!trackId) throw new Error('Tidal: trackId required');
  const quality = qualityOverride
    || settings.get('tidal_quality')
    || 'LOSSLESS';
  if (!QUALITIES[quality]) {
    throw new Error(`Tidal: invalid quality "${quality}"`);
  }
  const r = await _authedGet(
    `/tracks/${encodeURIComponent(trackId)}/playbackinfopostpaywall`,
    {
      audioquality:      quality,
      playbackmode:      'STREAM',
      assetpresentation: 'FULL',
    }
  );
  if (!r || !r.manifest) {
    throw new Error('Tidal: playbackinfo returned no manifest');
  }

  const mimeType = String(r.manifestMimeType || '').toLowerCase();
  const replayGain = {
    trackGain: r.trackReplayGain != null ? Number(r.trackReplayGain) : null,
    trackPeak: r.trackPeakAmplitude != null ? Number(r.trackPeakAmplitude) : null,
    albumGain: r.albumReplayGain != null ? Number(r.albumReplayGain) : null,
    albumPeak: r.albumPeakAmplitude != null ? Number(r.albumPeakAmplitude) : null,
  };

  // Decode the base64 manifest payload.
  let decoded;
  try {
    decoded = Buffer.from(r.manifest, 'base64').toString('utf-8');
  } catch (e) {
    throw new Error(`Tidal: manifest base64 decode failed: ${e.message}`);
  }

  // application/vnd.tidal.bts → JSON envelope with a direct URL.
  if (mimeType === 'application/vnd.tidal.bts' || mimeType === 'application/vnd.tidal.emu') {
    let env;
    try {
      env = JSON.parse(decoded);
    } catch (e) {
      throw new Error(`Tidal: bts manifest parse failed: ${e.message}`);
    }
    if (!env.urls || !env.urls[0]) {
      throw new Error('Tidal: bts manifest had no urls');
    }
    if (env.encryptionType && env.encryptionType !== 'NONE') {
      // We don't handle encrypted streams. Older Tidal device-types
      // sometimes return OLD_AES — newer leaked Limited Input Device
      // client_ids return NONE for LOSSLESS / HIGH / LOW. If we hit
      // this it's a credential-tier issue.
      throw new Error(`Tidal: stream is encrypted (${env.encryptionType}) — credential tier may not support this quality`);
    }
    return {
      source: 'url',
      value:  env.urls[0],
      mime:   env.mimeType || 'audio/flac',
      codec:  env.codecs || 'flac',
      audioQuality: r.audioQuality || quality,
      isDash: false,
      replayGain,
      cleanup: null,
    };
  }

  // application/dash+xml → write to temp file, return path.
  if (mimeType === 'application/dash+xml') {
    const fname = `tidal-${trackId}-${Date.now()}.mpd`;
    const fpath = path.join(TIDAL_MPD_DIR, fname);
    try {
      fs.writeFileSync(fpath, decoded, 'utf-8');
    } catch (e) {
      throw new Error(`Tidal: writing temp .mpd failed: ${e.message}`);
    }
    return {
      source: 'file',
      value:  fpath,
      mime:   'application/dash+xml',
      codec:  'flac',
      audioQuality: r.audioQuality || quality,
      isDash: true,
      replayGain,
      cleanup: async () => {
        try { fs.unlinkSync(fpath); } catch { /* already gone */ }
      },
    };
  }

  throw new Error(`Tidal: unknown manifest mime type "${r.manifestMimeType}"`);
}

// ---- catalog: new releases ------------------------------------------------
//
// dev.1243: pulls Tidal's curated "new this week" album list, used by
// the New Releases tab on TidalScreen. Tidal exposes a few related
// endpoints — the one with the most stable shape across regions is
// /featured/new/albums (Sven's LMS plugin and python-tidal both use
// this). Returns the standard Tidal page result: { items, totalNumberOfItems }.
//
// Note: results vary by region. The user_id determines which country
// code we authed for; Tidal returns the right region's new releases
// automatically based on the token.
async function getNewReleases(limit) {
  limit  = Math.max(1, Math.min(100, Number(limit) || 50));
  return _authedGet('/featured/new/albums', { limit, offset: 0 });
}

module.exports = {
  // Auth
  authStart,
  authPoll,
  isLoggedIn,
  logout,
  getStatus,
  setQuality,
  // Catalog
  search,
  getAlbum,
  getAlbumTracks,
  getFavorites,
  setAlbumFavorite,
  getNewReleases,
  // Playback (stub)
  getStreamInfo,
  // Constants exposed for routes / clients
  QUALITIES,
};
