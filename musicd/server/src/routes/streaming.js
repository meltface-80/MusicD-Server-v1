// src/routes/streaming.js — the Qobuz and Tidal HTTP surface.
//
// v1.1.33.0. Mounted at /api/streaming. One router for both services
// because, apart from signing in, they do the same things: search a
// catalogue, open an album, list what is curated, list and change
// favourites. The service is a path segment, validated once by
// _resolveService below, so a third service is a row in
// streamingLibrary.SERVICES and nothing here.
//
// Signing in is where they genuinely differ, and those two routes are
// written out separately rather than abstracted:
//
//   Qobuz  email + password, straight to POST /qobuz/login. The
//          password is stored, because Qobuz tokens go inactive after
//          weeks idle and re-logging in silently is the difference
//          between "it kept working" and "it signed me out again".
//
//   Tidal  OAuth 2 device code. There is no password to collect: the
//          client asks for a code, shows it with a link.tidal.com
//          URL, and polls while the user approves it on whatever
//          device they like. POST /tidal/auth/start then
//          POST /tidal/auth/poll.
//
// Everything that leaves here has been through streamingNormalise, so
// the client sees one album shape from both services.

'use strict';

const express = require('express');
const router = express.Router();

const streaming = require('../streamingLibrary');
const normalise = require('../streamingNormalise');
const settings = require('../settings');
const log = require('../serviceLog').forModule('streaming');

// ---- helpers -------------------------------------------------------------

// Validate :service and hand back the definition, or 404. Anything
// not in the table is a typo or a probe, and both deserve the same
// answer.
function _resolveService(req, res) {
  const id = String(req.params.service || '').toLowerCase();
  if (!streaming.isService(id)) {
    res.status(404).json({ error: `Unknown service "${id}"` });
    return null;
  }
  return streaming.serviceDef(id);
}

// Gate on being signed in. Returns false and answers 401 when not, so
// callers read `if (!_requireLogin(...)) return;`.
function _requireLogin(def, res) {
  if (streaming.isLoggedIn(def.id)) return true;
  res.status(401).json({ error: `Not signed in to ${def.label}` });
  return false;
}

// Upstream failures are 502, not 500: the request was fine, the
// service was not, and the client shows a retry rather than a bug
// report. The service clients prefix their messages with 'Qobuz:' /
// 'Tidal:'; strip that so the UI does not print "Qobuz: Qobuz says…".
function _upstreamError(res, def, e, what) {
  const raw = String((e && e.message) || e);
  const msg = raw.startsWith(`${def.label}:`) ? raw.slice(def.label.length + 1).trim() : raw;
  log.warn(`${def.label} ${what} failed: ${raw}`);
  res.status(502).json({ error: msg || `${what} failed` });
}

function _clampLimit(v, def, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(1, Math.min(max, n));
}

// ---- status --------------------------------------------------------------

// GET /api/streaming/status
//
// The one call the client makes on boot and after any auth change.
// It drives three things at once: whether the side menu shows Qobuz
// and Tidal rows, whether Settings → Services shows "Signed in as",
// and whether an album page draws the ⊕. Kept cheap (a few settings
// reads, no network) because the sidebar asks for it on every mount.
router.get('/status', (_req, res) => {
  const out = {};
  for (const id of streaming.SERVICE_IDS) {
    const def = streaming.SERVICES[id];
    const loggedIn = streaming.isLoggedIn(id);
    const entry = { service: id, label: def.label, logged_in: loggedIn, user: null };
    if (loggedIn) {
      try {
        const api = streaming.apiFor(id);
        if (id === 'qobuz') {
          const info = api.getUserInfo();
          entry.user = info ? { display: info.display, email: info.email } : null;
          entry.format = settings.getNum('qobuz_preferred_format', 27);
        } else {
          const st = api.getStatus();
          entry.user = st.user ? { display: st.user.display, id: st.user.id } : null;
          entry.quality = st.quality;
          entry.country_code = st.country_code;
        }
      } catch (e) {
        log.warn(`${def.label} status read failed: ${e.message}`);
      }
    }
    entry.sync = streaming.syncState(id);
    out[id] = entry;
  }
  res.json(out);
});

// ---- auth: Qobuz ---------------------------------------------------------

// POST /api/streaming/qobuz/login  { email, password }
router.post('/qobuz/login', async (req, res) => {
  const email = String(req.body?.email || '').trim();
  const password = String(req.body?.password || '');
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  const def = streaming.serviceDef('qobuz');
  try {
    const user = await streaming.apiFor('qobuz').login(email, password);
    // Pull the user's favourites straight away. Without this, signing
    // in appears to do nothing: the side menu gains a Qobuz row and
    // the library is unchanged until something triggers a sync.
    streaming.startFavoritesSync('qobuz');
    res.json({
      ok: true,
      user: { display: user.display_name || user.login || email, email },
    });
  } catch (e) {
    // Bad credentials are the overwhelmingly common failure and are
    // the user's to fix, so they get 401 and the service's own words.
    const raw = String((e && e.message) || e);
    if (/invalid|credential|password|401/i.test(raw)) {
      log.warn(`Qobuz login rejected for ${email.replace(/(.).*(@.*)/, '$1***$2')}`);
      return res.status(401).json({ error: 'Qobuz rejected those credentials' });
    }
    _upstreamError(res, def, e, 'login');
  }
});

// ---- auth: Tidal ---------------------------------------------------------

// POST /api/streaming/tidal/auth/start → the code to show the user.
router.post('/tidal/auth/start', async (_req, res) => {
  const def = streaming.serviceDef('tidal');
  try {
    const r = await streaming.apiFor('tidal').authStart();
    res.json({
      ok: true,
      device_code:   r.device_code,
      user_code:     r.user_code,
      // Tidal returns a bare host; make it a URL the client can link.
      verification_uri: /^https?:\/\//.test(r.verification_uri || '')
        ? r.verification_uri
        : `https://${r.verification_uri || 'link.tidal.com'}`,
      verification_uri_complete: r.verification_uri_complete || null,
      expires_in: r.expires_in,
      interval:   r.interval,
    });
  } catch (e) {
    _upstreamError(res, def, e, 'authorization start');
  }
});

// POST /api/streaming/tidal/auth/poll  { device_code }
//   → { status: 'pending' } while the user has not approved yet
//   → { status: 'ok' } once the token is stored
router.post('/tidal/auth/poll', async (req, res) => {
  const deviceCode = String(req.body?.device_code || '').trim();
  if (!deviceCode) return res.status(400).json({ error: 'device_code required' });
  const def = streaming.serviceDef('tidal');
  try {
    const r = await streaming.apiFor('tidal').authPoll(deviceCode);
    if (r.status === 'ok') {
      streaming.startFavoritesSync('tidal');
    }
    res.json({ ok: true, status: r.status });
  } catch (e) {
    _upstreamError(res, def, e, 'authorization');
  }
});

// ---- auth: shared --------------------------------------------------------

// POST /api/streaming/:service/logout
//
// Signing out drops the credentials and takes the service's albums
// out of the library — leaving them would put rows in the grid that
// cannot play. The cached rows themselves stay, so signing back in is
// a sync rather than a re-download.
router.post('/:service/logout', (req, res) => {
  const def = _resolveService(req, res);
  if (!def) return;
  try {
    streaming.apiFor(def.id).logout();
  } catch (e) {
    log.warn(`${def.label} logout: ${e.message}`);
  }
  let removed = 0;
  try {
    const db = require('../db').get();
    const rows = db.prepare(
      `SELECT id FROM albums WHERE ${def.favColumn} = 1`
    ).all();
    for (const row of rows) {
      if (streaming.setAlbumFavorited(def.id, row.id, false)) removed++;
    }
  } catch (e) {
    log.warn(`${def.label} logout: clearing library rows failed: ${e.message}`);
  }
  try { require('./library').invalidateCache(); } catch (e) {
    // Router not loaded — no cache exists to clear.
  }
  if (global.broadcastState) {
    global.broadcastState('library_updated', { reason: `${def.id}_logout` });
  }
  log.info(`${def.label}: signed out, ${removed} album(s) left the library`);
  res.json({ ok: true, removed });
});

// POST /api/streaming/:service/settings
//   Qobuz  { format: 5 | 6 | 7 | 27 }
//   Tidal  { quality: 'LOW' | 'HIGH' | 'LOSSLESS' | 'HI_RES_LOSSLESS' }
router.post('/:service/settings', (req, res) => {
  const def = _resolveService(req, res);
  if (!def) return;
  try {
    if (def.id === 'qobuz') {
      const fmt = parseInt(req.body?.format, 10);
      const allowed = [5, 6, 7, 27];
      if (!allowed.includes(fmt)) {
        return res.status(400).json({ error: `format must be one of ${allowed.join(', ')}` });
      }
      settings.set('qobuz_preferred_format', fmt);
      return res.json({ ok: true, format: fmt });
    }
    const quality = String(req.body?.quality || '');
    streaming.apiFor('tidal').setQuality(quality);   // throws on an unknown tier
    return res.json({ ok: true, quality });
  } catch (e) {
    res.status(400).json({ error: String((e && e.message) || e) });
  }
});

// ---- catalogue -----------------------------------------------------------

// GET /api/streaming/:service/search?q=&type=albums|tracks|artists&limit=
//
// Returns all three sections when type is omitted, which is what the
// service screens' own search box asks for. The unified search in
// routes/library.js calls this module's searchService() helper
// directly rather than going back out over HTTP.
router.get('/:service/search', async (req, res) => {
  const def = _resolveService(req, res);
  if (!def) return;
  if (!_requireLogin(def, res)) return;
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ albums: [], tracks: [], artists: [] });
  const limit = _clampLimit(req.query.limit, 25, 50);
  const type = ['albums', 'tracks', 'artists'].includes(req.query.type)
    ? req.query.type : null;
  try {
    const out = await searchService(def.id, q, type, limit);
    res.json(out);
  } catch (e) {
    _upstreamError(res, def, e, 'search');
  }
});

// GET /api/streaming/:service/album/:id
//
// Fetches the album, writes it into the library tables (so the
// standard album page, the queue and playback all have rows to read),
// and hands back both the normalised album and the local id to open.
//
// Caching on a plain GET is deliberate. Opening an album is exactly
// when we need its rows to exist, and making the client remember to
// POST a cache call first is how you get an album page that renders
// once and then 404s on reload.
router.get('/:service/album/:id', async (req, res) => {
  const def = _resolveService(req, res);
  if (!def) return;
  if (!_requireLogin(def, res)) return;
  const serviceAlbumId = String(req.params.id || '').trim();
  if (!serviceAlbumId) return res.status(400).json({ error: 'Album id required' });
  try {
    const cached = await streaming.cacheFor(def.id).cacheAlbum(serviceAlbumId);
    const raw = await streaming.apiFor(def.id).getAlbum(serviceAlbumId);
    const album = normalise.normaliseOne(def.id, 'album', raw);
    const state = streaming.getAlbumState(cached.localAlbumId);
    res.json({
      ok: true,
      localAlbumId: cached.localAlbumId,
      album,
      favorited: state ? state.favorited : false,
      in_library: state ? state.inLibrary : false,
    });
  } catch (e) {
    _upstreamError(res, def, e, 'album fetch');
  }
});

// GET /api/streaming/:service/new-releases?limit=
router.get('/:service/new-releases', async (req, res) => {
  const def = _resolveService(req, res);
  if (!def) return;
  if (!_requireLogin(def, res)) return;
  const limit = _clampLimit(req.query.limit, 50, 100);
  try {
    const api = streaming.apiFor(def.id);
    const raw = def.id === 'qobuz'
      ? await api.getFeatured('new-releases-full', limit)
      : await api.getNewReleases(limit);
    res.json({ albums: normalise.normaliseList(def.id, 'album', normalise.itemsFrom(raw, 'albums')) });
  } catch (e) {
    _upstreamError(res, def, e, 'new releases');
  }
});

// GET /api/streaming/qobuz/browse/:type?limit=
//
// The eight editorial lists Qobuz's own apps show. Tidal has no
// equivalent on the API surface this client uses, so its screen has
// no Browse tab rather than an empty one.
const QOBUZ_BROWSE_TYPES = [
  'new-releases-full', 'most-streamed', 'press-awards', 'editor-picks',
  'best-sellers', 'most-featured', 'qobuzissims', 'ideal-discography',
];

router.get('/:service/browse/:type', async (req, res) => {
  const def = _resolveService(req, res);
  if (!def) return;
  if (def.id !== 'qobuz') {
    return res.status(404).json({ error: `${def.label} has no browse categories` });
  }
  if (!_requireLogin(def, res)) return;
  const type = String(req.params.type || '');
  if (!QOBUZ_BROWSE_TYPES.includes(type)) {
    return res.status(400).json({ error: `Unknown browse category "${type}"` });
  }
  const limit = _clampLimit(req.query.limit, 50, 100);
  try {
    const raw = await streaming.apiFor('qobuz').getFeatured(type, limit);
    res.json({
      type,
      albums: normalise.normaliseList('qobuz', 'album', normalise.itemsFrom(raw, 'albums')),
    });
  } catch (e) {
    _upstreamError(res, def, e, `browse "${type}"`);
  }
});

// GET /api/streaming/:service/browse — the category list itself.
router.get('/:service/browse', (req, res) => {
  const def = _resolveService(req, res);
  if (!def) return;
  if (def.id !== 'qobuz') return res.json({ categories: [] });
  res.json({
    categories: [
      { type: 'new-releases-full', label: 'New Releases' },
      { type: 'most-streamed',     label: 'Most Streamed' },
      { type: 'press-awards',      label: 'Press Awards' },
      { type: 'editor-picks',      label: 'Editor Picks' },
      { type: 'best-sellers',      label: 'Best Sellers' },
      { type: 'most-featured',     label: 'Most Featured' },
      { type: 'qobuzissims',       label: 'Qobuzissims' },
      { type: 'ideal-discography', label: 'Ideal Discography' },
    ],
  });
});

// POST /api/streaming/:service/track/:id/resolve   { albumId }
//
// A catalogue track from unified search has no local row, so it has no
// id the player can queue. This caches its album — which is what mints
// the track rows — and hands back the local track id to play.
//
// The album id comes from the search result rather than being looked up,
// because both services already told us which album the track belongs
// to and a second catalogue call to rediscover it would be pure latency
// on a tap the user is waiting on.
router.post('/:service/track/:id/resolve', async (req, res) => {
  const def = _resolveService(req, res);
  if (!def) return;
  if (!_requireLogin(def, res)) return;
  const serviceTrackId = String(req.params.id || '').trim();
  const serviceAlbumId = String(req.body?.albumId || '').trim();
  if (!serviceTrackId) return res.status(400).json({ error: 'Track id required' });
  if (!serviceAlbumId) return res.status(400).json({ error: 'albumId required' });

  try {
    const cached = await streaming.cacheFor(def.id).cacheAlbum(serviceAlbumId);
    const trackPath = streaming.trackPathFor(def.id, serviceTrackId);
    const row = require('../db').get()
      .prepare('SELECT id FROM tracks WHERE path = ?').get(trackPath);
    if (!row) {
      // The album cached but does not contain this track. Happens when a
      // search result names a different release of the same recording;
      // say so rather than returning a null id the client would queue.
      return res.status(404).json({
        error: `That track is not on the ${def.label} album it was listed under`,
      });
    }
    res.json({ ok: true, trackId: row.id, localAlbumId: cached.localAlbumId });
  } catch (e) {
    _upstreamError(res, def, e, 'track resolve');
  }
});

// GET /api/streaming/:service/recent-plays?limit=
//
// What you have actually listened to from this service, newest first.
// Read from local play history rather than from the service, so it is
// this app's history and not the account's — which is the useful one
// when the point of the tab is "take me back to that thing".
//
// Joined through tracks.track_id → tracks.album_id, not through the
// denormalised album_title / album_artist columns play_history also
// carries: those collide between a local album and a streaming one with
// the same name, which is exactly the pair most likely to co-exist.
router.get('/:service/recent-plays', (req, res) => {
  const def = _resolveService(req, res);
  if (!def) return;
  const limit = _clampLimit(req.query.limit, 30, 100);
  try {
    const rows = require('../db').get().prepare(`
      SELECT a.id, a.title, a.album_artist, a.year, a.track_count,
             MAX(ph.played_at) AS played_at,
             CASE WHEN a.cover_art IS NOT NULL
                  THEN '/api/library/albums/' || a.id || '/cover' ELSE NULL END AS cover_art,
             COALESCE(a.excluded, 0) AS excluded
      FROM play_history ph
      JOIN tracks t ON t.id = ph.track_id
      JOIN albums a ON a.id = t.album_id
      WHERE a.id LIKE ? || ':%'
      GROUP BY a.id
      ORDER BY played_at DESC
      LIMIT ?
    `).all(def.id, limit);
    res.json({
      albums: rows.map((r) => ({
        service:        def.id,
        serviceAlbumId: streaming.serviceAlbumIdFrom(r.id),
        localAlbumId:   r.id,
        title:          r.title,
        artist:         r.album_artist,
        year:           r.year,
        cover:          r.cover_art,
        trackCount:     r.track_count,
        in_library:     r.excluded === 0,
        playedAt:       r.played_at,
      })),
    });
  } catch (e) {
    log.warn(`${def.label} recent plays failed: ${e.message}`);
    res.status(500).json({ error: 'Could not read play history' });
  }
});

// ---- favourites ----------------------------------------------------------

// GET /api/streaming/:service/favorites/albums?limit=&offset=
//
// Reads the service, not the local flag, so the service page shows
// what the account actually holds even if a sync has not run.
router.get('/:service/favorites/albums', async (req, res) => {
  const def = _resolveService(req, res);
  if (!def) return;
  if (!_requireLogin(def, res)) return;
  const limit = _clampLimit(req.query.limit, 100, 100);
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  try {
    const raw = await streaming.apiFor(def.id).getFavorites('albums', limit, offset);
    res.json({ albums: normalise.normaliseList(def.id, 'album', normalise.itemsFrom(raw, 'albums')) });
  } catch (e) {
    _upstreamError(res, def, e, 'favourites');
  }
});

// GET /api/streaming/:service/favorites/album/:id/status
//
// Answers from the local flag when the album is cached, and asks the
// service only when it is not. The ⊕ has to render the moment the
// album page opens; a network round-trip per open would make it flick
// from empty to filled on every visit.
router.get('/:service/favorites/album/:id/status', async (req, res) => {
  const def = _resolveService(req, res);
  if (!def) return;
  if (!_requireLogin(def, res)) return;
  const serviceAlbumId = String(req.params.id || '').trim();
  const localAlbumId = streaming.albumIdFor(def.id, serviceAlbumId);
  const state = streaming.getAlbumState(localAlbumId);
  if (state) return res.json({ favorited: state.favorited, in_library: state.inLibrary });
  try {
    let favorited = false;
    if (def.id === 'qobuz') {
      favorited = await streaming.apiFor('qobuz').getFavoriteStatus('album', serviceAlbumId);
    } else {
      // Tidal has no per-item status endpoint; look for the album in
      // the favourites list. Bounded at one page — an album outside
      // the 100 most recent favourites reads as not-favourited until
      // a sync caches it, which is a wrong ⊕ on an album the user has
      // never opened here, and self-corrects the moment they do.
      const raw = await streaming.apiFor('tidal').getFavorites('albums', 100, 0);
      const ids = normalise.itemsFrom(raw, 'albums').map((a) => String(a && a.id));
      favorited = ids.includes(String(serviceAlbumId));
    }
    res.json({ favorited, in_library: false });
  } catch (e) {
    _upstreamError(res, def, e, 'favourite status');
  }
});

// POST   /api/streaming/:service/favorites/album/:id   → add
// DELETE /api/streaming/:service/favorites/album/:id   → remove
//
// This is the ⊕. It writes the service first: if Qobuz refuses, the
// local library must not claim the album is in it. Only once the
// service has accepted do we cache (so the tile has art) and flip the
// flag (so the album enters the library).
async function _setFavorite(req, res, add) {
  const def = _resolveService(req, res);
  if (!def) return;
  if (!_requireLogin(def, res)) return;
  const serviceAlbumId = String(req.params.id || '').trim();
  if (!serviceAlbumId) return res.status(400).json({ error: 'Album id required' });
  const localAlbumId = streaming.albumIdFor(def.id, serviceAlbumId);

  try {
    await streaming.apiFor(def.id).setAlbumFavorite(serviceAlbumId, add);
  } catch (e) {
    return _upstreamError(res, def, e, add ? 'add favourite' : 'remove favourite');
  }

  if (add) {
    // Make sure there is something to show. cacheAlbum is idempotent
    // and cheap for an album already opened; for one favourited
    // straight from a search result it is what fetches the metadata
    // and cover the library tile needs.
    try {
      await streaming.cacheFor(def.id).cacheAlbum(serviceAlbumId);
    } catch (e) {
      // The favourite is recorded at the service either way. A tile
      // with a placeholder that fills in on next open beats failing
      // an action the user already saw succeed.
      log.warn(`${def.label}: caching ${serviceAlbumId} after favourite failed: ${e.message}`);
    }
  }

  let applied = false;
  try {
    applied = streaming.setAlbumFavorited(def.id, localAlbumId, add);
  } catch (e) {
    log.warn(`${def.label}: flag update for ${localAlbumId} failed: ${e.message}`);
  }

  try { require('./library').invalidateCache(); } catch (e) {
    // Router not loaded — no cache exists to clear.
  }
  if (global.broadcastState) {
    global.broadcastState('library_updated', { reason: `${def.id}_favorite`, albumId: localAlbumId });
  }
  res.json({ ok: true, favorited: add, in_library: add && applied, localAlbumId });
}

router.post('/:service/favorites/album/:id', (req, res) => _setFavorite(req, res, true));
router.delete('/:service/favorites/album/:id', (req, res) => _setFavorite(req, res, false));

// POST /api/streaming/:service/favorites/sync
// GET  /api/streaming/:service/favorites/sync/status
//
// A first sync of a few hundred favourites is a few hundred sequential
// album fetches; it runs in the background and the client polls.
// Returning 202 rather than 200 says so.
router.post('/:service/favorites/sync', (req, res) => {
  const def = _resolveService(req, res);
  if (!def) return;
  const r = streaming.startFavoritesSync(def.id);
  if (!r.started) return res.status(409).json({ error: r.reason, sync: streaming.syncState(def.id) });
  res.status(202).json({ ok: true, sync: streaming.syncState(def.id) });
});

router.get('/:service/favorites/sync/status', (req, res) => {
  const def = _resolveService(req, res);
  if (!def) return;
  res.json(streaming.syncState(def.id));
});

// ---- shared search helper ------------------------------------------------
//
// Exported so routes/library.js can fold catalogue results into
// unified search without an HTTP round-trip to this same process.
async function searchService(service, q, type, limit) {
  const api = streaming.apiFor(service);
  const out = { albums: [], tracks: [], artists: [] };
  const sections = type ? [type] : ['albums', 'tracks', 'artists'];

  // Both services answer a typed search with one section populated,
  // and an untyped search with all of them. One untyped call is
  // cheaper than three typed ones, so prefer it when we want
  // everything.
  if (!type) {
    const raw = await api.search(q, null, limit);
    out.albums  = normalise.normaliseList(service, 'album',  normalise.itemsFrom(raw, 'albums'));
    out.tracks  = normalise.normaliseList(service, 'track',  normalise.itemsFrom(raw, 'tracks'));
    out.artists = normalise.normaliseList(service, 'artist', normalise.itemsFrom(raw, 'artists'));
    return out;
  }

  for (const section of sections) {
    const raw = await api.search(q, section, limit);
    const kind = section === 'albums' ? 'album' : section === 'tracks' ? 'track' : 'artist';
    out[section] = normalise.normaliseList(service, kind, normalise.itemsFrom(raw, section));
  }
  return out;
}

module.exports = router;
module.exports.searchService = searchService;
module.exports.QOBUZ_BROWSE_TYPES = QOBUZ_BROWSE_TYPES;
