// Bio scanner (#v1.1.0.28)
// =========================
//
// Wraps the existing on-demand bioFetch in a "scan everything pending"
// loop, used by the metadata scheduler. Bios stay lazy when accessed
// on-demand from the UI -- this module just walks the catalogue and
// pre-warms entries that haven't been attempted yet.
//
// "Pending" definition:
//   - Albums:  bio_attempted_at IS NULL AND mb_release_group_id IS NOT NULL
//              (no MBID = bios won't work, skip)
//   - Artists: bio_attempted_at IS NULL AND mb_artist_id IS NOT NULL
//
// The bioFetch source-fallback chain (Wikipedia → Last.fm → AudioDB →
// MB annotation) is unchanged. We just call its public entry point and
// stamp bio_attempted_at = now whether or not anything came back.
//
// Throttling: bioFetch already coordinates with mbThrottle and the
// per-source pacers. We add no extra throttle here, but we DO yield
// between items (10ms) so the scheduler can interrupt cleanly when
// the thermal guard or window-end signal asks us to pause.

const db = require('./db');
const bioFetch = require('./bioFetch');

let _stopRequested = false;
let _running = false;
let _progress = {
  running: false,
  processed: 0,
  total: 0,
  startedAt: null,
};

function getProgress() {
  return { ..._progress };
}

function requestStop() {
  _stopRequested = true;
}

/**
 * Count of pending bios across albums + artists. The scheduler uses
 * this to decide whether to enter the bio-scan job slot at all.
 */
function getPendingCount() {
  const database = db.get();
  try {
    const a = database.prepare(`
      SELECT COUNT(*) AS c FROM albums
      WHERE excluded = 0
        AND scheduled_excluded = 0
        AND mb_release_group_id IS NOT NULL
        AND bio_attempted_at IS NULL
    `).get();
    const b = database.prepare(`
      SELECT COUNT(*) AS c FROM artists
      WHERE mb_artist_id IS NOT NULL
        AND bio_attempted_at IS NULL
    `).get();
    return (a?.c || 0) + (b?.c || 0);
  } catch {
    return 0;
  }
}

/**
 * Scan all pending bios. Stops early if requestStop() is called or
 * if an external deadline fn returns true. Returns when the queue
 * is empty.
 *
 * @param {object}   opts
 * @param {function} opts.shouldPause - Async fn returning true if the
 *   scheduler wants us to pause (thermal trip / window end). Polled
 *   between each item.
 */
async function scanAll({ shouldPause } = {}) {
  if (_running) {
    throw new Error('Bio scan already running');
  }
  _running = true;
  _stopRequested = false;
  _progress = {
    running: true,
    processed: 0,
    total: getPendingCount(),
    startedAt: Date.now(),
  };

  try {
    const database = db.get();
    // Pull a small batch each iteration so we re-check the pending
    // set as we go (an album might have been newly matched while
    // we were running, or the user might have excluded one).
    const albumStmt = database.prepare(`
      SELECT id, mb_release_group_id FROM albums
      WHERE excluded = 0
        AND scheduled_excluded = 0
        AND mb_release_group_id IS NOT NULL
        AND bio_attempted_at IS NULL
      ORDER BY id
      LIMIT 1
    `);
    const artistStmt = database.prepare(`
      SELECT id, name, mb_artist_id FROM artists
      WHERE mb_artist_id IS NOT NULL
        AND bio_attempted_at IS NULL
      ORDER BY id
      LIMIT 1
    `);
    const stampAlbum = database.prepare(
      'UPDATE albums SET bio_attempted_at = ? WHERE id = ?'
    );
    const stampArtist = database.prepare(
      'UPDATE artists SET bio_attempted_at = ? WHERE id = ?'
    );

    while (!_stopRequested) {
      // Yield to the event loop so we don't starve scheduler signals.
      await new Promise(r => setTimeout(r, 10));

      if (shouldPause && await shouldPause()) {
        // Scheduler asked to pause -- exit cleanly. Caller decides
        // whether to retry or move on.
        break;
      }

      // Albums first, then artists. Either ordering works; this just
      // means album bios populate slightly faster on a fresh library
      // which is what most users will look at first.
      const album = albumStmt.get();
      if (album) {
        try {
          await bioFetch.getAlbumBio(album.id, { force: false });
        } catch (e) {
          // bioFetch already logs internally; we just stamp and move on.
        }
        stampAlbum.run(Date.now(), album.id);
        _progress.processed++;
        continue;
      }
      const artist = artistStmt.get();
      if (artist) {
        try {
          await bioFetch.getArtistBio(artist.name, { force: false });
        } catch (e) {
          // ditto
        }
        stampArtist.run(Date.now(), artist.id);
        _progress.processed++;
        continue;
      }
      // Nothing pending in either queue. Done.
      break;
    }
  } finally {
    _running = false;
    _progress.running = false;
  }
}

module.exports = {
  scanAll,
  requestStop,
  getProgress,
  getPendingCount,
};
