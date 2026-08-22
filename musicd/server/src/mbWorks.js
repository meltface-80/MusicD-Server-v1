// src/mbWorks.js — MusicBrainz works, which is to say compositions.
//
// v1.1.38.0.
//
// THE FACT THAT SHAPES THIS WHOLE MODULE. A work attaches to RECORDINGS,
// never to release groups. The chain is:
//
//     work <- performance <- recording <- track <- medium <- release
//                                                       <- release group
//
// There is no query, in the API or in the database, that reaches a work
// from an album without going through that album's tracks. So works
// cannot identify an album and nothing here tries to. Anyone arriving
// with "use works to improve matching" should stop at this paragraph:
// that is not a thing MusicBrainz can answer, and adding it would not
// convert a single album currently sitting in triage.
//
// WHAT THEY DO BUY.
//
//   Classical becomes browsable. A classical album today is a title like
//   "Beethoven: Symphonies 5 & 7" over eight tracks called "I. Allegro
//   con brio". Works give the composer as an entity, the canonical work
//   title (Symphony No. 5 in C minor, Op. 67) and the movement it sits
//   in. That is the difference between a pile of files and a library.
//
//   Covers connect. Two recordings of the same work are the same song —
//   the track-level twin of the album version grouping shipped in
//   v1.1.34.0.
//
//   ISWC is a composition-level identifier that survives bad tags, the
//   way a barcode does at release level.
//
// THE CONSTRAINT. Works are priced PER TRACK. A 20,000-track library at
// MusicBrainz's one request a second is five and a half hours just to
// walk the recordings, before fetching a single work. This module is
// only affordable because the recording MBIDs arrive from somewhere
// free, and so it has one hard rule:
//
//     IT NEVER GOES LOOKING FOR A RECORDING MBID OVER THE NETWORK.
//
// A track with no mb_recording_id is skipped, full stop. The ids come
// from the scanner harvesting Picard tags at scan time (free, and the
// common case for anyone who tags), and from the matcher's AcoustID
// stage for files Picard never touched. If neither has supplied one,
// this module has nothing to do and correctly does nothing.
//
// The economics after that are good, because one work serves every
// recording of it across the library: a symphony movement recorded by
// six orchestras is six recordings and one work. The cache hit rate is
// the entire reason this is viable at all.

'use strict';

const db = require('./db');
const mbHttp = require('./mbHttp');
const settings = require('./settings');
const log = require('./serviceLog').forModule('works');

// A work fetched this long ago is not re-fetched. Works are about as
// static as MusicBrainz data gets — a composition's composer does not
// change — so this is generous on purpose.
const WORK_TTL_S = 180 * 24 * 60 * 60;

// Yield to the event loop this often while scanning, so the scheduler's
// thermal guard and window-end signal can interrupt cleanly. Same figure
// bioScanner uses, for the same reason.
const YIELD_MS = 10;

let _stopRequested = false;
let _running = false;
let _progress = { running: false, processed: 0, resolved: 0, total: 0, startedAt: null };

function getProgress() {
  return { ..._progress };
}

function requestStop() {
  _stopRequested = true;
}

function isEnabled() {
  return settings.getBool('works_enabled', true);
}

function _sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------
//
// Which tracks are worth spending a request on, and in what order.
//
// A blanket sweep of a pop library buys nothing and costs everything, so
// the queue is PRIORITISED rather than filtered — filtering on a guess
// at "is this classical" would silently exclude a correctly-tagged
// classical album whose genre tag happens to say "Soundtrack".
//
// Three tiers, best first:
//
//   0  the track's own tags already name a work. One request confirms it
//      and fills in the composer; there is no guessing involved and it
//      is certainly worth doing.
//   1  the album's genre says classical. This is where the feature
//      actually pays off.
//   2  everything else with a recording MBID.
//
// The scheduler's one-hour job cap means tier 2 may never be reached on
// a large library, which is the correct outcome: the tiers are ordered
// so that stopping early stops on the least valuable work.
//
// A NOTE ON WHAT WAS NOT USED. `albums.album_type` looks like the right
// signal and is not: scanner.deriveAlbumType only ever returns main, ep,
// single, soundtrack, deluxe or limited. There is no classical value for
// it to return, so testing it would have been a condition that never
// fires — the sort of check that reads as working and quietly is not.
// Genre is tag-derived and imperfect, but it is real.
//
// Matched with LIKE rather than a regex because SQLite has no REGEXP
// operator unless the host registers one, and registering a function for
// this would put the classical vocabulary in a second place. The terms
// are deliberately broad: over-including costs one request against a
// track that was going to be visited in tier 2 anyway.
const CLASSICAL_GENRE_TERMS = [
  'classical', 'opera', 'baroque', 'orchestral', 'chamber',
  'symphon', 'concerto', 'choral', 'renaissance', 'early music',
];
const CLASSICAL_GENRE_SQL = CLASSICAL_GENRE_TERMS
  .map((t) => `LOWER(COALESCE(a.genre, '')) LIKE '%${t}%'`)
  .join(' OR ');

const ELIGIBLE_SQL = `
  FROM tracks t
  JOIN albums a ON a.id = t.album_id
  WHERE t.mb_recording_id IS NOT NULL
    AND t.work_attempted_at IS NULL
    AND t.excluded = 0
    AND a.excluded = 0
`;

/**
 * Count of tracks this module could usefully act on.
 *
 * Cheap by requirement: the scheduler calls it every thirty seconds.
 * Wrapped so that a database which has not run this release's migration
 * yet answers 0 rather than throwing — a missing table here would
 * otherwise take down pendingCounts() and blank the whole scheduler UI.
 */
function pendingCount() {
  if (!isEnabled()) return 0;
  try {
    const row = db.get().prepare(`SELECT COUNT(*) AS c ${ELIGIBLE_SQL}`).get();
    return row ? row.c : 0;
  } catch (e) {
    // Pre-migration database, or no tracks table in a partial test
    // schema. Zero is the honest answer and it keeps the scheduler
    // reporting the other five jobs correctly.
    return 0;
  }
}

// The next batch of tracks to resolve, best tier first. Batched rather
// than streamed because the priority expression is not free to compute
// and re-running it per track would dominate the cost of a job that is
// otherwise network-bound.
function _nextBatch(database, limit) {
  return database.prepare(`
    SELECT t.id AS track_id, t.path, t.mb_recording_id, t.mb_work_id,
           CASE
             WHEN t.mb_work_id IS NOT NULL THEN 0
             WHEN ${CLASSICAL_GENRE_SQL} THEN 1
             ELSE 2
           END AS tier
    ${ELIGIBLE_SQL}
    ORDER BY tier, t.album_id, t.disc_number, t.track_number
    LIMIT ?
  `).all(limit);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function _upsertWork(database, work) {
  database.prepare(`
    INSERT INTO works (id, title, type, iswc, language, composer, composer_mbid, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      type = excluded.type,
      iswc = excluded.iswc,
      language = excluded.language,
      composer = excluded.composer,
      composer_mbid = excluded.composer_mbid,
      fetched_at = unixepoch()
  `).run(
    work.id, work.title, work.type || null, work.iswc || null,
    work.language || null, work.composer || null, work.composer_mbid || null
  );
}

function _linkTrack(database, trackId, workId) {
  database.prepare(
    'INSERT OR IGNORE INTO track_works (track_id, work_id) VALUES (?, ?)'
  ).run(trackId, workId);
}

function _cachedWork(database, workId) {
  try {
    const row = database.prepare('SELECT * FROM works WHERE id = ?').get(workId);
    if (!row) return null;
    if (!row.fetched_at) return row;
    const age = Math.floor(Date.now() / 1000) - row.fetched_at;
    return age < WORK_TTL_S ? row : null;
  } catch (e) {
    // No works table yet. Treated as a cache miss, which is safe: the
    // caller's own write will then fail too and be reported once.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

// Pull the composer (and the other writing credits, which are cheap to
// keep once we have the response) out of a work's artist relations.
//
// MusicBrainz models these as relation types on the work: 'composer',
// 'lyricist', 'arranger', 'librettist'. A work can have several of each
// — two composers on a collaboration is normal — so the display string
// joins them, while composer_mbid keeps only the first, because a column
// holding "one of the composers" is useful and a column holding a list
// of UUIDs is not.
function _creditsFrom(workData) {
  const composers = [];
  let firstMbid = null;
  for (const rel of (workData.relations || [])) {
    if (rel.type !== 'composer') continue;
    const name = rel.artist && rel.artist.name;
    if (!name) continue;
    composers.push(name);
    if (!firstMbid && rel.artist.id) firstMbid = rel.artist.id;
  }
  return {
    composer: composers.length > 0 ? composers.join(' & ') : null,
    composer_mbid: firstMbid,
  };
}

/**
 * Resolve the work(s) behind one recording MBID.
 *
 * Cache-first at BOTH levels, and that is the whole economics of this
 * module. The recording lookup is unavoidable per track. The work lookup
 * behind it usually is not: once one track of a symphony has resolved,
 * every other movement and every other recording of it across the
 * library is a database read.
 */
async function worksForRecording(recordingMbid, opts = {}) {
  if (!recordingMbid) return [];
  const database = db.get();

  let recData;
  try {
    recData = await mbHttp.request(`/recording/${recordingMbid}`, { inc: 'work-rels' }, opts);
  } catch (e) {
    if (e && e.response && e.response.status === 404) {
      // The recording MBID in the tags points at something MusicBrainz
      // has since merged or removed. Not an error worth retrying —
      // the caller stamps work_attempted_at and moves on.
      log.warn(`recording ${recordingMbid} not found at MusicBrainz`);
      return [];
    }
    throw e;
  }

  const out = [];
  for (const rel of (recData.relations || [])) {
    if (rel.type !== 'performance' || !rel.work || !rel.work.id) continue;
    const workId = rel.work.id;

    const cached = _cachedWork(database, workId);
    if (cached) {
      out.push(cached);
      continue;
    }

    // Second call, only on a cache miss: the recording relation carries
    // the work's id and title but not its composer, and the composer is
    // the entire point.
    let workData;
    try {
      workData = await mbHttp.request(`/work/${workId}`, { inc: 'artist-rels' }, opts);
    } catch (e) {
      // Fall back to what the recording relation already told us. A work
      // with a title and no composer is still better than no work, and
      // the TTL means the composer is picked up on a later pass.
      log.warn(`work ${workId} lookup failed: ${e.message}`);
      workData = rel.work;
    }

    const credits = _creditsFrom(workData);
    const work = {
      id: workId,
      title: workData.title || rel.work.title || '(untitled work)',
      type: workData.type || null,
      iswc: (Array.isArray(workData.iswcs) && workData.iswcs[0]) || workData.iswc || null,
      language: workData.language || null,
      composer: credits.composer,
      composer_mbid: credits.composer_mbid,
    };
    try {
      _upsertWork(database, work);
    } catch (e) {
      log.warn(`could not cache work ${workId}: ${e.message}`);
    }
    out.push(work);
  }
  return out;
}

/**
 * Resolve works for every eligible track of one album.
 *
 * work_attempted_at is stamped on every track we TRY, including the ones
 * that come back with nothing. Skipping that stamp is precisely the
 * mistake the cover-art job made — see db.js's ART_PENDING_SQL — and it
 * is what turns a background job into a queue that never drains.
 */
async function populateAlbumWorks(albumId, opts = {}) {
  const database = db.get();
  const summary = { processed: 0, resolved: 0, skipped: 0 };
  const contact = opts.contact || mbHttp.getContact();
  if (!contact) return summary;

  const tracks = database.prepare(`
    SELECT id AS track_id, mb_recording_id
    FROM tracks
    WHERE album_id = ? AND excluded = 0
    ORDER BY disc_number, track_number
  `).all(albumId);

  const stamp = database.prepare('UPDATE tracks SET work_attempted_at = unixepoch() WHERE id = ?');

  for (const t of tracks) {
    if (!t.mb_recording_id) { summary.skipped += 1; continue; }
    let works = [];
    try {
      works = await worksForRecording(t.mb_recording_id, { contact });
    } catch (e) {
      log.warn(`track ${t.track_id}: ${e.message}`);
    }
    for (const w of works) {
      try {
        _linkTrack(database, t.track_id, w.id);
      } catch (e) {
        log.warn(`could not link track ${t.track_id} to work ${w.id}: ${e.message}`);
      }
    }
    try {
      stamp.run(t.track_id);
    } catch (e) {
      log.warn(`could not stamp track ${t.track_id}: ${e.message}`);
    }
    summary.processed += 1;
    if (works.length > 0) summary.resolved += 1;
  }
  return summary;
}

/**
 * Everything the album page needs, read-only and with no network.
 *
 * Ordered by disc then track so the caller can render it alongside the
 * track list without a second sort.
 */
function worksForAlbum(albumId) {
  try {
    return db.get().prepare(`
      SELECT t.id AS track_id, t.disc_number, t.track_number,
             w.id AS work_id, w.title, w.type, w.iswc, w.language,
             w.composer, w.composer_mbid
      FROM tracks t
      JOIN track_works tw ON tw.track_id = t.id
      JOIN works w ON w.id = tw.work_id
      WHERE t.album_id = ?
      ORDER BY t.disc_number, t.track_number
    `).all(albumId);
  } catch (e) {
    // Pre-migration database. An album page must render regardless, so
    // "this album has no works" is the right answer here rather than a
    // 500 on the whole detail route.
    return [];
  }
}

/**
 * The scheduler job body.
 *
 * Modelled on bioScanner.scanAll: walk the queue, poll shouldPause
 * between items, yield briefly so the thermal guard and the window-end
 * signal can interrupt cleanly rather than being noticed an hour later.
 */
async function runScan({ shouldPause } = {}) {
  if (_running) return;
  if (!isEnabled()) return;

  let contact;
  try {
    contact = mbHttp.requireContact();
  } catch (e) {
    log.warn('skipped — no MusicBrainz contact configured');
    return;
  }

  _running = true;
  _stopRequested = false;
  const database = db.get();
  _progress = {
    running: true, processed: 0, resolved: 0,
    total: pendingCount(), startedAt: Date.now(),
  };
  log.info(`starting — ${_progress.total} track(s) eligible`);

  const stamp = database.prepare('UPDATE tracks SET work_attempted_at = unixepoch() WHERE id = ?');

  try {
    for (;;) {
      if (_stopRequested) break;
      if (shouldPause && await shouldPause()) break;

      const batch = _nextBatch(database, 50);
      if (batch.length === 0) break;

      for (const row of batch) {
        if (_stopRequested) break;
        if (shouldPause && await shouldPause()) break;

        let works = [];
        try {
          works = await worksForRecording(row.mb_recording_id, { contact });
        } catch (e) {
          log.warn(`${row.path}: ${e.message}`);
        }
        for (const w of works) {
          try {
            _linkTrack(database, row.track_id, w.id);
          } catch (e) {
            log.warn(`could not link ${row.track_id} -> ${w.id}: ${e.message}`);
          }
        }
        // Stamped whether or not anything came back. See populateAlbumWorks.
        try {
          stamp.run(row.track_id);
        } catch (e) {
          log.warn(`could not stamp ${row.track_id}: ${e.message}`);
        }
        _progress.processed += 1;
        if (works.length > 0) _progress.resolved += 1;
        await _sleep(YIELD_MS);
      }
    }
  } finally {
    _running = false;
    _progress.running = false;
    log.info(`stopped — ${_progress.processed} track(s) processed, ${_progress.resolved} with works`);
  }
}

module.exports = {
  worksForRecording,
  populateAlbumWorks,
  worksForAlbum,
  pendingCount,
  runScan,
  getProgress,
  requestStop,
  isEnabled,
};
