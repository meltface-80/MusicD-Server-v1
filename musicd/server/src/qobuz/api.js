// src/qobuz/api.js — Qobuz REST API client.
//
// v1.1.33.0. Ported from MusicD-Server-Bridge
// (musicd/server/src/qobuz/api.js) with two changes: the levelled
// logger becomes ../serviceLog, and settings reads go through this
// repo's ../settings accessor. The request signing, the token-recovery
// re-login and the response caps are the bridge's, unmodified —
// they are the parts that took field use to get right.
//
// Provides login(), isLoggedIn(), getUserInfo(), logout(), catalogue
// search, album details, getFileUrl (the signed-request flow) and
// favourites.
//
// All credentials are stored in the `settings` table:
//   qobuz_email        — user's Qobuz account email
//   qobuz_password     — plaintext (sigh — same security level as
//                        acoustid_key and discogs_token, which are
//                        also stored plaintext. LAN-trust model.)
//   qobuz_token        — user_auth_token returned by user/login.
//                        Used in subsequent requests via the
//                        user_auth_token query param.
//   qobuz_user_id      — numeric user ID; we use this for our records
//                        but Qobuz uses it internally too.
//   qobuz_user_display — display_name or login from the user object.
//                        Shown in the settings UI as "Logged in as X".
//
// CREDENTIALS NOTE: the app_id and app_secret below are extracted from
// Sven's LMS Qobuz plugin (v30.6.9) install.xml. They're tied to that
// plugin's relationship with Qobuz. If Qobuz ever blocks that aid
// (rare but possible), this stops working. Long-term we'd want our
// own aid registered with Qobuz; for development this is fine.
//
// API URLs and shapes reverse-engineered from Sven's plugin. There's
// no official public docs; the closest is github.com/Qobuz/api-documentation
// which is sparse but covers the signed-request algorithm.

'use strict';

const crypto = require('crypto');
const settings = require('../settings');
const log = require('../serviceLog').forModule('qobuz');

const QOBUZ_BASE_URL = 'https://www.qobuz.com/api.json/0.2/';

// Decoded from Sven's plugin install.xml. See header comment for caveat.
const APP_ID     = '942852567';
const APP_SECRET = '761730d3f95e4af09ac63b9a37ccc96a';

// Format codes per Qobuz API.
const FORMAT = {
  MP3:           5,    // 320 kbps MP3
  FLAC:          6,    // 16-bit/44.1 FLAC (CD quality)
  FLAC_HIRES:    7,    // 24-bit/≤96kHz FLAC
  FLAC_HIRES_2:  27,   // 24-bit/≤192kHz FLAC
};

// User-Agent we present to Qobuz. They don't seem to police this hard
// but a recognisable one is friendlier than the default.
const USER_AGENT = 'musicd/1.0 (qobuz-client)';

// ---- low-level request helpers --------------------------------------------

// Build a URL with query string. Sorts keys alphabetically (Qobuz seems
// fine with arbitrary order but Sven's plugin sorts, so we do too).
function _buildUrl(path, params) {
  const entries = Object.entries(params).filter(([k]) => !k.startsWith('_'));
  entries.sort(([a], [b]) => a.localeCompare(b));
  const qs = entries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return `${QOBUZ_BASE_URL}${path}?${qs}`;
}

// Compute the request_sig for a signed call.
//
// Algorithm (from Sven's plugin, lines 922-940 of API.pm, which
// matches the github.com/Qobuz/api-documentation signed-requests
// description):
//
//   1. Start with the URL path with the FIRST slash removed.
//      e.g. 'track/getFileUrl' → 'trackgetFileUrl'
//   2. Build the signing string from the query params (excluding
//      app_id and user_auth_token). Format each as `keyvalue` (no
//      equals sign), then sort the resulting strings lexicographically
//      and concatenate. NOTE: this sorts by the concatenated key+value,
//      not by key alone — for current Qobuz endpoints the difference
//      is academic (no two params share a key prefix), but Sven's
//      algorithm definitively sorts the concatenations and we mirror
//      that here for safety.
//   3. Append timestamp (unix seconds)
//   4. Append APP_SECRET
//   5. MD5-hash the result
//
// The wire format includes &request_ts=... and &request_sig=...
function _signRequest(path, params, timestamp) {
  // 1. Strip first slash only (Perl: s/\///).
  let payload = path.replace('/', '');
  // 2. Build "keyvalue" concatenations, filter app_id/user_auth_token,
  //    sort the resulting strings, concatenate.
  const sigParts = Object.entries(params)
    .filter(([k]) =>
      !k.startsWith('_') && k !== 'app_id' && k !== 'user_auth_token')
    .map(([k, v]) => `${k}${v}`);
  sigParts.sort();   // string-lex sort, matches Perl's sort
  payload += sigParts.join('');
  // 3. + 4.
  payload += String(timestamp);
  payload += APP_SECRET;
  // 5.
  return crypto.createHash('md5').update(payload).digest('hex');
}

// Make an HTTP request to the Qobuz API. Returns a Promise that
// resolves with the parsed JSON body, or rejects on error.
//
// Special params (prefixed with _ — stripped before sending):
//   _sign:      true → add request_ts + request_sig
//   _useToken:  true → add user_auth_token (must be logged in)
//   _post:      true → POST instead of GET
//
// Token recovery: Qobuz tokens go inactive after weeks of idle. The
// password is stored precisely so we can re-login transparently — do
// that here: on an invalid-token failure, re-login once (single
// in-flight re-login shared across concurrent callers) and retry.
let _reloginInFlight = null;

async function _request(path, params = {}) {
  try {
    return await _requestOnce(path, params);
  } catch (err) {
    const tokenProblem = params._useToken &&
      /invalid user auth token|user_auth_token/i.test(err.message || '');
    if (!tokenProblem) throw err;
    if (!settings.get('qobuz_email', '') || !settings.get('qobuz_password', '')) throw err;
    if (!_reloginInFlight) {
      _reloginInFlight = refreshToken().finally(() => { _reloginInFlight = null; });
    }
    await _reloginInFlight;  // throws if the re-login itself failed
    return _requestOnce(path, params);
  }
}

async function _requestOnce(path, params = {}) {
  const useToken = !!params._useToken;
  const sign     = !!params._sign;
  const post     = !!params._post;

  // Token attachment (after removing internal flags)
  const token = settings.get('qobuz_token', '');
  if (useToken) {
    if (!token) {
      throw new Error('Qobuz: not logged in (no token)');
    }
    params = { ...params, user_auth_token: token };
  }

  // app_id is always present.
  params = { ...params, app_id: APP_ID };

  // Signing happens BEFORE we strip internal flags, because the sig
  // covers only non-underscore keys (which our signer enforces).
  if (sign) {
    const ts = Math.floor(Date.now() / 1000);
    params.request_sig = _signRequest(path, params, ts);
    params.request_ts  = ts;
  }

  // Build URL. _-prefixed keys are stripped by _buildUrl.
  const url = _buildUrl(path, params);

  // dev.1252: 10s timeout + 8 MB response cap. Bare fetch() lets a
  // hung upstream wedge the route indefinitely and unbounded text
  // reading can OOM on a malicious oversized response.
  const ctl = new AbortController();
  const tmo = setTimeout(() => ctl.abort(), 10_000);
  const fetchOpts = {
    method: post ? 'POST' : 'GET',
    headers: {
      'User-Agent': USER_AGENT,
      'Accept':     'application/json',
    },
    signal: ctl.signal,
  };

  // Redact secrets from any log line that quotes the URL. username/
  // password ride the query string on user/login — without redaction a
  // debug-level run writes the account password into journalctl.
  const safeUrl = url
    .replace(APP_ID, '<app_id>')
    .replace(token, token ? '<token>' : '')
    .replace(/([?&])(username|password)=[^&]*/g, '$1$2=<redacted>');

  log.debug(`${post ? 'POST' : 'GET'} ${safeUrl}`);

  let res;
  try {
    res = await fetch(url, fetchOpts);
  } catch (e) {
    clearTimeout(tmo);
    if (e.name === 'AbortError') {
      throw new Error('Qobuz: request timed out');
    }
    throw new Error(`Qobuz: network error: ${e.message}`);
  }
  const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
  const cl = parseInt(res.headers.get('content-length') || '', 10);
  if (Number.isFinite(cl) && cl > MAX_RESPONSE_BYTES) {
    clearTimeout(tmo);
    throw new Error(`Qobuz: response too large (Content-Length ${cl})`);
  }
  const body = await res.text();
  clearTimeout(tmo);
  if (body.length > MAX_RESPONSE_BYTES) {
    throw new Error(`Qobuz: response too large (${body.length} bytes)`);
  }
  let json;
  try {
    json = JSON.parse(body);
  } catch (e) {
    throw new Error(`Qobuz: invalid JSON response (status ${res.status}): ${body.slice(0, 200)}`);
  }
  if (!res.ok) {
    // Qobuz error responses look like {status:"error", code:401, message:"..."}
    const msg = json && (json.message || json.error) || `HTTP ${res.status}`;
    throw new Error(`Qobuz: ${msg}`);
  }
  return json;
}

// ---- public API -----------------------------------------------------------

// Attempt to log in with the given email/password. On success, stores
// the token + user info in settings and returns the user object.
// Throws on failure (bad credentials, network error, etc).
async function login(email, password) {
  if (!email || !password) {
    throw new Error('Qobuz: email and password required');
  }
  const result = await _request('user/login', {
    username: email,
    password: password,
  });
  if (!result || !result.user_auth_token || !result.user || !result.user.id) {
    throw new Error('Qobuz: login response missing token or user info');
  }

  // Persist credentials + token. We deliberately store the password
  // so the server can re-login automatically if the token expires.
  // (Tokens expire after weeks of inactivity; the password gives us
  // a way to recover without prompting the user.)
  settings.set('qobuz_email',        email);
  settings.set('qobuz_password',     password);
  settings.set('qobuz_token',        result.user_auth_token);
  settings.set('qobuz_user_id',      String(result.user.id));
  settings.set('qobuz_user_display', result.user.display_name || result.user.login || email);

  log.info(`logged in as ${result.user.display_name || result.user.login} (id=${result.user.id})`);
  return result.user;
}

// Returns true if we have a stored token.
function isLoggedIn() {
  return !!settings.get('qobuz_token', '');
}

// Returns { email, display, user_id } for the logged-in user, or null.
function getUserInfo() {
  const email = settings.get('qobuz_email', '');
  if (!email) return null;
  return {
    email:    email,
    display:  settings.get('qobuz_user_display', '') || email,
    user_id:  settings.get('qobuz_user_id', ''),
  };
}

// Clear stored credentials + token. (We don't call Qobuz's "logout"
// endpoint because there isn't one that does anything useful; tokens
// just become inactive after enough idle time.)
function logout() {
  settings.set('qobuz_email',        '');
  settings.set('qobuz_password',     '');
  settings.set('qobuz_token',        '');
  settings.set('qobuz_user_id',      '');
  settings.set('qobuz_user_display', '');
  log.info('logged out');
}

// Re-login using stored email + password. Used internally if a request
// fails with a 401-style "token invalid" error. Public so callers
// (e.g. an admin "force-refresh" button) can invoke it too.
async function refreshToken() {
  const email    = settings.get('qobuz_email', '');
  const password = settings.get('qobuz_password', '');
  if (!email || !password) {
    throw new Error('Qobuz: cannot refresh token — no stored credentials');
  }
  log.info('refreshing token');
  return login(email, password);
}

// ---- catalog -------------------------------------------------------------

// Fetch the full album object including its track listing.
//
// Returns the raw Qobuz response, top-level fields like:
//   { id, title, artist:{id,name}, image:{small,thumbnail,large},
//     tracks_count, duration, released_at, hires, hires_streamable,
//     maximum_bit_depth, maximum_sampling_rate,
//     tracks: { items: [...], total },
//     genres_list, label:{...}, ... }
//
// Each track in tracks.items has at least:
//   id, title, duration, track_number, media_number, isrc,
//   maximum_bit_depth, maximum_sampling_rate, streamable, hires_streamable,
//   performer:{id,name}, composer:{id,name}, work, version
async function getAlbum(albumId) {
  if (!albumId) {
    throw new Error('Qobuz: album_id required');
  }
  return _request('album/get', {
    album_id: String(albumId),
    _useToken: true,
  });
}

// Fetch a streamable URL for a given track. This is the first call
// that requires a signed request — see _signRequest for the algorithm.
//
// formatId is one of the FORMAT constants:
//   5  → MP3 320 kbps
//   6  → FLAC CD (16-bit/44.1)
//   7  → FLAC HiRes (24-bit/≤96 kHz)
//   27 → FLAC HiRes 2 (24-bit/≤192 kHz)
//
// If omitted, uses the user's preferred format from settings (default 27).
//
// Returns the raw Qobuz response, which has the streaming URL in the
// `url` field plus metadata about what we actually got (Qobuz may give
// you a lower quality than requested if the track isn't available at
// the requested quality):
//   { url: 'https://streaming-qobuz-std.akamaized.net/.../file.flac?...',
//     format_id, mime_type, sampling_rate, bit_depth, restrictions, ... }
//
// The URL is time-limited — typically valid for an hour or two — and
// must be re-fetched on each play. Don't cache it long-term.
async function getFileUrl(trackId, formatId) {
  if (!trackId) {
    throw new Error('Qobuz: track_id required');
  }
  const fmt = formatId || parseInt(settings.get('qobuz_preferred_format', 27), 10) || 27;
  return _request('track/getFileUrl', {
    track_id:  String(trackId),
    format_id: String(fmt),
    _sign:     true,
    _useToken: true,
  });
}

// Search Qobuz's catalogue. type is one of 'albums', 'artists', 'tracks',
// 'playlists', or null/undefined for a mixed-result search. limit caps
// each section's results; default 25.
//
// Returns the raw Qobuz response, which has top-level fields like
//   { albums: { items: [...], total: N, limit, offset },
//     tracks: { items: [...], ... },
//     artists: { items: [...], ... },
//     playlists: { items: [...], ... } }
// — though when `type` is set, only that section is populated.
//
// Each album item has: id, title, artist:{id,name}, image:{small,thumbnail,large},
// tracks_count, duration, released_at, hires, hires_streamable, streamable, ...
// Each track item has: id, title, performer:{id,name}, album:{id,title,image},
// duration, track_number, hires_streamable, streamable, maximum_bit_depth,
// maximum_sampling_rate, ...
//
// Returns from the user's region's catalogue. Tracks marked
// streamable:false won't play — UI should grey those out.
async function search(query, type, limit) {
  if (!query) {
    throw new Error('Qobuz: search query required');
  }
  const params = {
    query: query,
    limit: limit || 25,
    _useToken: true,
  };
  if (type && ['albums', 'artists', 'tracks', 'playlists'].indexOf(type) !== -1) {
    params.type = type;
  }
  return _request('catalog/search', params);
}

// Fetch a curated/featured album list. The `type` parameter selects
// which curation Qobuz returns:
//   new-releases-full      — what the Qobuz apps show as "New Releases"
//   ideal-discography      — "Discography"
//   qobuzissims            — Qobuz editorial picks
//   most-streamed          — global most-streamed
//   press-awards           — albums with press awards
//   editor-picks, best-sellers, most-featured
// q6.5 surfaces only 'new-releases-full' to the UI; the other types
// stay available for future filter/category work.
async function getFeatured(type, limit) {
  if (!type) {
    throw new Error('Qobuz: getFeatured type required');
  }
  return _request('album/getFeatured', {
    type:      type,
    limit:     limit || 50,
    _useToken: true,
  });
}

// Fetch the user's favourites. `type` is one of 'albums', 'artists',
// 'tracks', 'playlists'. q6.5 wires up 'albums' only.
async function getFavorites(type, limit, offset) {
  if (!type) {
    throw new Error('Qobuz: getFavorites type required');
  }
  return _request('favorite/getUserFavorites', {
    type:      type,
    limit:     limit || 100,
    offset:    offset || 0,
    _useToken: true,
  });
}

// dev.1207: add or remove an album from the user's favourites. Mirrors
// Sven's setFavorite API in API.pm:
//   favorite/create?album_ids=X  → add
//   favorite/delete?album_ids=X  → remove
// Both require the user auth token. We POST so the action shows in
// Qobuz's logs as a write rather than a read; Qobuz's API accepts
// either form but POST is the convention for state-changing calls.
async function setAlbumFavorite(qobuzAlbumId, add) {
  if (!qobuzAlbumId) {
    throw new Error('Qobuz: album id required');
  }
  const path = add ? 'favorite/create' : 'favorite/delete';
  return _request(path, {
    album_ids: String(qobuzAlbumId),
    _useToken: true,
    _post:     true,
  });
}

// dev.1207: check whether a given album/track/artist is in the user's
// favourites. We surface the boolean only — the response shape is
// { status: true|false, item_id, type }.
async function getFavoriteStatus(itemType, itemId) {
  if (!itemType || !itemId) {
    throw new Error('Qobuz: type and item_id required');
  }
  const r = await _request('favorite/status', {
    type:      itemType,
    item_id:   String(itemId),
    _useToken: true,
  });
  // Response is { status: true|false } per Sven's notes. Coerce to
  // a real boolean in case Qobuz returns the string "true".
  return r && (r.status === true || r.status === 'true');
}

module.exports = {
  // public surface
  login,
  isLoggedIn,
  getUserInfo,
  logout,
  refreshToken,
  search,
  getAlbum,
  getFileUrl,
  getFeatured,
  getFavorites,
  setAlbumFavorite,
  getFavoriteStatus,

  // internal — exposed for future builds (search, album, getFileUrl)
  _request,
  _signRequest,
  _buildUrl,

  // constants
  FORMAT,
  APP_ID,
};
