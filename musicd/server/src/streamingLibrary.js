// src/streamingLibrary.js — where Qobuz and Tidal become library albums.
//
// v1.1.33.0.
//
// THE SHAPE
//
// A streaming album is not a parallel universe. It is a row in
// `albums` whose id is 'qobuz:<serviceId>' or 'tidal:<serviceId>',
// with rows in `tracks` whose path is 'qobuz://<serviceId>' or
// 'tidal://<serviceId>'. Every column a local album has, it has:
// title, album_artist, year, genre, cover_art, track_count,
// primary_format, primary_sample_rate, primary_bit_depth. That is the
// whole trick behind "see no difference" — the grid, the sort suite,
// Focus, the album page, the queue, the DSP chain and the scrobbler
// were not taught about streaming services, because from where they
// sit there is nothing to learn.
//
// THE ONE INVARIANT
//
// `albums.excluded` decides whether a row is in the browsable library.
// 42 queries in routes/library.js already filter on it, and this
// feature adds a clause to none of them, because:
//
//     a streaming album is excluded = 0 exactly when it is
//     favourited at the service, and its tracks always mirror
//     their album.
//
// Favourite it in Qobuz (from their app, or with the ⊕ here) and it
// is in your library. Un-favourite it and it is not. Browsing the
// catalogue caches rows so the album page and playback have something
// to read, and those rows sit at excluded = 1 — present, playable if
// you navigate to them, invisible to every browse surface.
//
// Every write of that pair goes through setAlbumFavorited() below.
// Nothing else in this codebase may set `excluded` on a streaming
// row. The two flags drifting apart is the failure mode that shows up
// as "my Qobuz albums vanished from the grid but Favourites still
// lists them", and it is unfalsifiable from the UI, so
// test/streaming-library.test.js asserts that this file is the only
// writer.
//
// WHAT `excluded` IS NOT
//
// It is not albums.is_favorite (this app's heart) and it is not
// qobuz_favorited / tidal_favorited (the service's own favourite,
// which the ⊕ mirrors). Those two are independent by design and are
// documented at their migration in db.js.
//
// SCOPE
//
// scanner.js's library-scope pass rewrites `excluded` across the
// whole table from a list of filesystem paths. 'qobuz://5152122'
// is under no directory the user ever picked, so an unguarded scope
// pass silently excludes every streaming album the moment anybody
// narrows their library to a subfolder. The pass therefore skips
// streaming rows outright — see applyScope() in scanner.js.

'use strict';

const db = require('./db');
const log = require('./serviceLog').forModule('streaming');

// The two services, and everything that is spelled differently
// between them, in one table. Adding a third service is adding a row
// here plus an api/ + cache/ pair with the same method names.
const SERVICES = {
  qobuz: {
    id:         'qobuz',
    label:      'Qobuz',
    albumPrefix: 'qobuz:',
    pathPrefix:  'qobuz://',
    favColumn:   'qobuz_favorited',
    // Qobuz accepts large limits on favorite/getUserFavorites — the LMS
    // Qobuz plugin asks for 5000 in a single request. 500 a page keeps
    // each response a sane size while still making a 10,000-favourite
    // library 20 requests rather than 100.
    favPageSize: 500,
  },
  tidal: {
    id:         'tidal',
    label:      'Tidal',
    albumPrefix: 'tidal:',
    pathPrefix:  'tidal://',
    favColumn:   'tidal_favorited',
    // Tidal's v1 favourites endpoint caps at 100 per page and the client
    // clamps to it; asking for more silently returns 100.
    favPageSize: 100,
  },
};

const SERVICE_IDS = Object.keys(SERVICES);

// ---- identity ------------------------------------------------------------

function isService(service) {
  return Object.prototype.hasOwnProperty.call(SERVICES, service);
}

function serviceDef(service) {
  const def = SERVICES[service];
  if (!def) throw new Error(`unknown streaming service "${service}"`);
  return def;
}

// 'qobuz' + '5152122' → 'qobuz:5152122'
function albumIdFor(service, serviceAlbumId) {
  return serviceDef(service).albumPrefix + String(serviceAlbumId);
}

// 'qobuz' + '5152123' → 'qobuz://5152123'
function trackPathFor(service, serviceTrackId) {
  return serviceDef(service).pathPrefix + String(serviceTrackId);
}

// 'qobuz:5152122' → 'qobuz'; a local album id → null.
function serviceForAlbumId(albumId) {
  if (!albumId) return null;
  const s = String(albumId);
  for (const id of SERVICE_IDS) {
    if (s.startsWith(SERVICES[id].albumPrefix)) return id;
  }
  return null;
}

// 'qobuz://5152123' → 'qobuz'; a filesystem path → null.
function serviceForTrackPath(trackPath) {
  if (!trackPath) return null;
  const s = String(trackPath);
  for (const id of SERVICE_IDS) {
    if (s.startsWith(SERVICES[id].pathPrefix)) return id;
  }
  return null;
}

// 'qobuz:5152122' → '5152122'. Returns null for a local album id.
function serviceAlbumIdFrom(albumId) {
  const service = serviceForAlbumId(albumId);
  if (!service) return null;
  return String(albumId).slice(SERVICES[service].albumPrefix.length);
}

// 'qobuz://5152123' → '5152123'. Returns null for a filesystem path.
function serviceTrackIdFrom(trackPath) {
  const service = serviceForTrackPath(trackPath);
  if (!service) return null;
  return String(trackPath).slice(SERVICES[service].pathPrefix.length);
}

function isStreamingAlbumId(albumId) { return serviceForAlbumId(albumId) !== null; }
function isStreamingPath(trackPath) { return serviceForTrackPath(trackPath) !== null; }

// ---- SQL fragments -------------------------------------------------------
//
// Two album-scoped routes — GET /library/albums/:id and
// POST /library/albums/tracks — must show a streaming album's tracks
// even when the album is not favourited, because the user got there
// by deliberately opening it from search or from a service page. They
// relax `t.excluded = 0` with this clause rather than dropping the
// filter, so a genuinely out-of-scope local track stays hidden.
//
// Expressed here, once, so the two cannot drift. Browse surfaces do
// NOT use it: their plain `excluded = 0` is what keeps a catalogue
// you merely looked at out of your library.
const TRACK_VISIBLE_SQL =
  "(t.excluded = 0 OR t.path LIKE 'qobuz://%' OR t.path LIKE 'tidal://%')";

// The scope pass's "leave streaming rows alone" guards, likewise
// written once. scanner.js applies them to both its UPDATE statements
// and to the no-scope branch.
const NOT_STREAMING_TRACK_SQL =
  "path NOT LIKE 'qobuz://%' AND path NOT LIKE 'tidal://%'";
const NOT_STREAMING_ALBUM_SQL =
  "id NOT LIKE 'qobuz:%' AND id NOT LIKE 'tidal:%'";

// Album-list queries select this to give the client a service glyph
// for the tile. Derived from the id rather than stored, so it cannot
// disagree with the row it describes.
const SERVICE_SELECT_SQL = `
  CASE
    WHEN id LIKE 'qobuz:%' THEN 'qobuz'
    WHEN id LIKE 'tidal:%' THEN 'tidal'
    ELSE NULL
  END`;

// ---- the invariant -------------------------------------------------------

// Set (or clear) a streaming album's service-favourite, and move the
// album and its tracks into or out of the browsable library with it.
// One transaction: a crash between the two writes is what produces an
// album that is in your Qobuz favourites but invisible in the grid.
//
// Returns true when a row was updated, false when the album is not
// cached locally (nothing to flag — the caller has usually just
// failed to cache it, and logs its own warning).
function setAlbumFavorited(service, localAlbumId, favorited) {
  const def = serviceDef(service);
  if (serviceForAlbumId(localAlbumId) !== service) {
    throw new Error(
      `setAlbumFavorited: "${localAlbumId}" is not a ${def.label} album id`);
  }
  const dbh = db.get();
  const flag = favorited ? 1 : 0;
  // excluded is the INVERSE of favourited: favourited albums are in
  // the library (excluded = 0), cached-but-not-favourited ones are
  // not (excluded = 1).
  const excluded = favorited ? 0 : 1;

  const tx = dbh.transaction(() => {
    const r = dbh.prepare(
      `UPDATE albums SET ${def.favColumn} = ?, excluded = ? WHERE id = ?`
    ).run(flag, excluded, localAlbumId);
    if (r.changes === 0) return 0;
    // Tracks mirror their album. Matched by album_id, which the cache
    // always sets — no title+artist fallback here, because a
    // streaming album sharing a title with a local one must not drag
    // the local album's tracks in or out of the library with it.
    dbh.prepare(
      'UPDATE tracks SET excluded = ? WHERE album_id = ?'
    ).run(excluded, localAlbumId);
    return r.changes;
  });

  return tx() > 0;
}

// Read back the pair for one album. Used by the routes to answer the
// ⊕ state without a second round-trip to the service, and by the
// tests to assert the invariant holds.
function getAlbumState(localAlbumId) {
  const service = serviceForAlbumId(localAlbumId);
  if (!service) return null;
  const def = SERVICES[service];
  const dbh = db.get();
  const row = dbh.prepare(
    `SELECT COALESCE(${def.favColumn}, 0) AS favorited,
            COALESCE(excluded, 0)         AS excluded,
            COALESCE(is_favorite, 0)      AS is_favorite
     FROM albums WHERE id = ?`
  ).get(localAlbumId);
  if (!row) return null;
  return {
    service,
    cached:      true,
    favorited:   !!row.favorited,
    inLibrary:   row.excluded === 0,
    is_favorite: !!row.is_favorite,
  };
}

// ---- module wiring -------------------------------------------------------
//
// Required lazily. api/cache pull in `settings`, which pulls in `db`;
// requiring them at module scope from a file the routes load during
// boot puts a cycle in the graph for no benefit. Declaration before
// use also matters here (see CLAUDE.md): these are function bodies,
// evaluated on call, never during module init.
function apiFor(service) {
  return require(`./${serviceDef(service).id}/api`);
}

function cacheFor(service) {
  return require(`./${serviceDef(service).id}/cache`);
}

function isLoggedIn(service) {
  try {
    return !!apiFor(service).isLoggedIn();
  } catch (e) {
    // A service module that fails to load must not take the sidebar
    // down with it — report "logged out" and log once.
    log.warn(`${service} login check failed: ${e.message}`);
    return false;
  }
}

// Which services the client should show in the side menu, and on
// which screens the ⊕ is live. Cheap: two settings reads.
function loggedInServices() {
  return SERVICE_IDS.filter(isLoggedIn);
}

function statuses() {
  const out = {};
  for (const id of SERVICE_IDS) {
    out[id] = { logged_in: isLoggedIn(id), label: SERVICES[id].label };
  }
  return out;
}

// ---- favourites sync -----------------------------------------------------
//
// Reconciles the service's favourites list against the local flag, in
// both directions:
//
//   * in the service's list, not flagged here → cache the album
//     (metadata + cover) and flag it, so it appears in the library
//   * flagged here, not in the service's list → clear the flag, so an
//     album un-favourited from the phone leaves the library here too
//
// Runs on login, on demand from Settings → Services, and once a day.
// Sequential rather than parallel: a first sync of 300 favourites is
// 300 album fetches, and hammering Qobuz with those concurrently is
// how an app id gets rate-limited. Slow and finished beats fast and
// throttled — the client polls syncState() for progress.
const _syncStates = {};
for (const id of SERVICE_IDS) {
  _syncStates[id] = {
    running: false, startedAt: null, finishedAt: null,
    total: 0, processed: 0, added: 0, removed: 0, errors: 0, error: null,
  };
}

// v1.1.34.0 — THERE IS NO FAVOURITES LIMIT.
//
// This used to page 100 at a time and stop after 50 pages, which capped
// a sync at exactly 5000 albums and reported "5000" as the total — so a
// library larger than that silently synced a prefix of itself and said
// it was finished. (The LMS Qobuz plugin has the same number as a hard
// constant, QOBUZ_USERDATA_LIMIT = 5000, which is why raising it there
// is a known thing people have to do.)
//
// It now pages until the service says there are no more, using the
// total the service itself reports as the target, so progress counts
// against the real number. The only remaining bound is an absolute
// runaway stop: it exists so a misbehaving endpoint that always returns
// a full page cannot loop forever, and it is set far above any real
// library rather than at a number anyone could reach.
const FAV_RUNAWAY_STOP = 200000;

function syncState(service) {
  serviceDef(service);
  return { ..._syncStates[service] };
}

// Pull every favourited album id from the service, following its
// pagination. Normalises the two services' different response shapes
// down to an array of { serviceAlbumId }.
async function _fetchFavoriteAlbumIds(service, onProgress) {
  const def = serviceDef(service);
  const api = apiFor(service);
  const pageSize = def.favPageSize || 100;
  const ids = [];
  const seen = new Set();
  let offset = 0;
  let reportedTotal = null;

  for (;;) {
    const r = await api.getFavorites('albums', pageSize, offset);
    // Qobuz: { albums: { items: [...], total } }
    // Tidal: { items: [ { item: {...} } ], totalNumberOfItems }
    let items = [];
    if (r && r.albums && Array.isArray(r.albums.items)) {
      items = r.albums.items;
      if (reportedTotal === null && Number.isFinite(Number(r.albums.total))) {
        reportedTotal = Number(r.albums.total);
      }
    } else if (r && Array.isArray(r.items)) {
      items = r.items.map((row) => (row && row.item) ? row.item : row);
      if (reportedTotal === null && Number.isFinite(Number(r.totalNumberOfItems))) {
        reportedTotal = Number(r.totalNumberOfItems);
      }
    }
    if (items.length === 0) break;

    for (const it of items) {
      if (!it || it.id == null) continue;
      const id = String(it.id);
      // De-duplicated: a favourite added while we are paging shifts the
      // window and can hand us the same album twice. Without this the
      // count drifts above the real total and an album gets cached twice.
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }

    // Tell the caller the real target as soon as the service states it,
    // so progress counts against the true number from the first page
    // rather than against however much has been fetched so far.
    if (onProgress) onProgress({ fetched: ids.length, total: reportedTotal });

    // Advance by the page size actually requested, not by how many came
    // back: a page containing duplicates would otherwise re-request the
    // same window forever.
    offset += pageSize;
    if (items.length < pageSize) break;
    if (reportedTotal !== null && ids.length >= reportedTotal) break;
    if (ids.length >= FAV_RUNAWAY_STOP) {
      log.warn(`${def.label}: stopped paging favourites at ${FAV_RUNAWAY_STOP} — ` +
        'the service kept returning full pages past its own reported total');
      break;
    }
  }
  return ids;
}

async function _runSync(service) {
  const def = serviceDef(service);
  const st = _syncStates[service];
  const dbh = db.get();

  const remoteIds = await _fetchFavoriteAlbumIds(service, ({ fetched, total }) => {
    // Paging a 10,000-favourite library is itself a minute of requests.
    // Surfacing the target during that phase is the difference between
    // "it is working" and "it is stuck at zero".
    st.total = total !== null ? total : fetched;
  });
  st.total = remoteIds.length;
  log.info(`${def.label}: ${remoteIds.length} favourite album(s) to reconcile`);

  const cache = cacheFor(service);
  const remoteLocalIds = new Set(remoteIds.map((id) => albumIdFor(service, id)));

  // Direction 1: everything the service says is a favourite.
  for (const serviceAlbumId of remoteIds) {
    const localAlbumId = albumIdFor(service, serviceAlbumId);
    try {
      // cacheAlbum is idempotent and cheap when the row already
      // exists with a cover; it is what guarantees the tile renders
      // with real art rather than a placeholder.
      await cache.cacheAlbum(serviceAlbumId);
      if (setAlbumFavorited(service, localAlbumId, true)) st.added++;
    } catch (e) {
      st.errors++;
      log.warn(`${def.label}: sync of album ${serviceAlbumId} failed: ${e.message}`);
    }
    st.processed++;
  }

  // Direction 2: locally flagged rows the service no longer lists.
  // Only ever clears the flag; the cached rows stay, so re-favouriting
  // later costs nothing.
  const flagged = dbh.prepare(
    `SELECT id FROM albums WHERE ${def.favColumn} = 1`
  ).all();
  for (const row of flagged) {
    if (remoteLocalIds.has(row.id)) continue;
    try {
      if (setAlbumFavorited(service, row.id, false)) st.removed++;
    } catch (e) {
      st.errors++;
      log.warn(`${def.label}: clearing stale favourite ${row.id} failed: ${e.message}`);
    }
  }

  log.info(`${def.label}: sync done — ${st.added} in library, ` +
    `${st.removed} removed, ${st.errors} error(s)`);
}

// Start a sync in the background. Returns { started: bool, reason }.
// Only one per service at a time; a second request while one runs is
// answered with started:false rather than queued, because the running
// one will pick up whatever the second one wanted anyway.
function startFavoritesSync(service) {
  const def = serviceDef(service);
  const st = _syncStates[service];
  if (st.running) return { started: false, reason: 'already running' };
  if (!isLoggedIn(service)) return { started: false, reason: `not logged in to ${def.label}` };

  st.running = true;
  st.startedAt = Date.now();
  st.finishedAt = null;
  st.total = 0; st.processed = 0; st.added = 0; st.removed = 0;
  st.errors = 0; st.error = null;

  _runSync(service)
    .catch((e) => {
      st.error = String(e.message || e);
      log.warn(`${def.label}: sync aborted: ${st.error}`);
    })
    .finally(() => {
      st.running = false;
      st.finishedAt = Date.now();
      // The album grid is cached in routes/library.js; a sync that
      // changed nothing visible still costs one rebuild, and a sync
      // that added 200 albums is invisible without it.
      try { require('./routes/library').invalidateCache(); } catch (e) {
        // Route module not loaded yet (sync triggered during boot before
        // the routers mount). The cache it would clear does not exist
        // yet either, so there is nothing to invalidate.
      }
      if (global.broadcastState) {
        global.broadcastState('library_updated', { reason: `${service}_favorites_sync` });
      }
    });

  return { started: true };
}

// Daily reconcile, plus one run shortly after boot. Without it, a
// favourite added from the Qobuz app on a phone never reaches this
// library until the user happens to press Sync.
const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SYNC_BOOT_DELAY_MS = 45 * 1000;   // after discovery and the first scan
let _syncTimer = null;

function startScheduledSync() {
  if (_syncTimer) return;
  const runAll = () => {
    for (const id of SERVICE_IDS) {
      if (isLoggedIn(id)) startFavoritesSync(id);
    }
  };
  setTimeout(runAll, SYNC_BOOT_DELAY_MS).unref();
  _syncTimer = setInterval(runAll, SYNC_INTERVAL_MS);
  _syncTimer.unref();
}

function stopScheduledSync() {
  if (_syncTimer) { clearInterval(_syncTimer); _syncTimer = null; }
}

module.exports = {
  SERVICES,
  SERVICE_IDS,
  isService,
  serviceDef,
  albumIdFor,
  trackPathFor,
  serviceForAlbumId,
  serviceForTrackPath,
  serviceAlbumIdFrom,
  serviceTrackIdFrom,
  isStreamingAlbumId,
  isStreamingPath,
  TRACK_VISIBLE_SQL,
  NOT_STREAMING_TRACK_SQL,
  NOT_STREAMING_ALBUM_SQL,
  SERVICE_SELECT_SQL,
  setAlbumFavorited,
  getAlbumState,
  apiFor,
  cacheFor,
  isLoggedIn,
  loggedInServices,
  statuses,
  syncState,
  // Exported for test/streaming-library.test.js. The paging loop is the
  // piece that silently capped a sync at 5000 albums and reported it as
  // complete, so it is worth being able to drive directly against a
  // stubbed client rather than only through a live account.
  _fetchFavoriteAlbumIds,
  startFavoritesSync,
  startScheduledSync,
  stopScheduledSync,
};
