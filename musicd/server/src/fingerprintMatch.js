// AcoustID fingerprint matching (#v1.1.0.22)
// ============================================
//
// When MusicBrainz title/artist search fails to identify an album, we
// fall back to audio fingerprinting via AcoustID. The fingerprint is
// derived from the actual decoded audio so it works even if a file
// has wrong, missing, or non-Latin metadata.
//
// Flow (per album):
//   1. Pick up to N tracks from the album to fingerprint -- one is
//      enough sometimes, but multi-track lookups disambiguate (a song
//      might appear on the original album AND 12 compilations; we
//      want the release-group all chosen tracks share).
//   2. Run `fpcalc -json <path>` for each. Output is
//      { duration, fingerprint }.
//   3. POST each (duration, fingerprint) to acoustid.org/v2/lookup
//      with meta=releasegroups+recordings. Compress the body since
//      fingerprints are long.
//   4. Each AcoustID response contains 0+ recordings with linked
//      release-groups. Tally release-group MBIDs across all tracks --
//      the RG that appears most often (and matches our tracks well)
//      wins.
//   5. Return the top RG candidates in the same shape as
//      metadataMatch's candidates so the UI renders them identically.
//
// We use the application key baked in below (registered to musicd as
// a non-commercial application). Per acoustid.org/webservice the
// application key is what identifies the app to AcoustID; users only
// need their own key if they're SUBMITTING new fingerprints, which
// musicd never does. So no per-user setup.
//
// Two entry points (v1.1.38.0)
// ----------------------------
// For its first several releases everything below was reachable from
// exactly one place: the "Try fingerprint" button in the Unmatched
// modal, via POST /api/library/match/:id/fingerprint. The automatic
// matcher never called any of it. That is backwards. Fingerprinting is
// the only source in the system that still works when the tags are
// worthless, which is the exact problem the matching feature exists to
// solve -- and it was reachable only by a user who had already noticed
// an album was wrong and gone looking for a button.
//
// So there are now two ways in:
//
//   matchAlbumRow(album, opts)  the form the automatic matcher wants.
//                               It takes an album row the caller
//                               already holds and does NOT re-read it,
//                               because the matcher is walking a result
//                               set and a second SELECT per album for a
//                               row it is already holding is pure waste.
//   matchAlbumById(id)          the manual route's form, now a thin
//                               wrapper that loads the row and delegates.
//
// Both return `recordingMbids` alongside the release-group candidates:
// the recording MBIDs AcoustID gave us, deduplicated, best-scoring
// first. Those are worth more than the release-group vote they feed. A
// recording MBID persisted onto tracks.mb_recording_id is what the
// works layer looks up to find the composition behind a performance, so
// we collect them even when the sampled tracks could not agree on a
// release group at all -- a failed album match does not make the
// per-recording identifications wrong, and throwing them away would
// mean paying the fingerprinting cost twice to get them back.

const { execFile } = require('child_process');
const { promisify } = require('util');
const axios = require('axios');
const zlib = require('zlib');
const db = require('./db');

const execFileP = promisify(execFile);

// Application API key -- baked in for all musicd users (#v1.1.0.22).
// Only needed for the "client" parameter on lookups. Not a user
// secret; AcoustID intends app keys to be embedded in distributed
// software.
const ACOUSTID_CLIENT = 'GWOs21vq2N';

const ACOUSTID_BASE = 'https://api.acoustid.org/v2';
const FPCALC_TIMEOUT_MS = 20000;       // some long DSD files take ~10s
const HTTP_TIMEOUT_MS = 15000;
const TRACKS_TO_FINGERPRINT = 3;       // sample 3 tracks per album by default
const MIN_DURATION_SEC = 30;           // AcoustID won't index <30s clips well

// Rough wall-clock seconds per fingerprinted track, used only by
// estimateCost() below. fpcalc decodes the first two minutes of audio
// (1-3s on the small hosts this runs on, more for a lossless file off a
// spinning disk), then the AcoustID round trip costs its 500ms throttle
// gap plus the request itself. 3.5s is the middle of that; it is a
// planning figure, not a promise.
const SECONDS_PER_FINGERPRINTED_TRACK = 3.5;

// One place to read opts.maxTracks so the entry points, the worker and
// the cost estimate cannot disagree about what "3" means. A caller that
// passes nothing, zero, or nonsense gets the default rather than an
// album that silently fingerprints no tracks at all.
function normaliseMaxTracks(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return TRACKS_TO_FINGERPRINT;
  return Math.floor(n);
}

// AcoustID requires that we don't exceed 3 req/sec. Throttle to ~2/sec
// for safety. Since this is user-driven (one album at a time) we
// almost never hit it, but the per-album fingerprinting does multiple
// API calls in sequence.
let _lastRequestAt = 0;
const MIN_REQUEST_GAP_MS = 500;

async function throttledRequest(config) {
  const now = Date.now();
  const wait = Math.max(0, _lastRequestAt + MIN_REQUEST_GAP_MS - now);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastRequestAt = Date.now();
  return axios(config);
}

/**
 * Run fpcalc on a file. Returns { duration, fingerprint } or throws.
 * Output JSON looks like: { "duration": 245, "fingerprint": "AQABz..." }
 */
async function computeFingerprint(filePath) {
  let stdout;
  try {
    const r = await execFileP('fpcalc', ['-json', filePath], {
      timeout: FPCALC_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,  // fingerprints can be ~50KB
    });
    stdout = r.stdout;
  } catch (e) {
    // fpcalc returns non-zero on unsupported codecs / corrupt files.
    // We don't fail the whole album for one bad track -- caller skips.
    throw new Error(`fpcalc failed: ${(e.stderr || e.message || '').trim().slice(0, 160)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('fpcalc output not valid JSON');
  }
  if (!parsed.fingerprint || !parsed.duration) {
    throw new Error('fpcalc returned empty fingerprint');
  }
  return {
    duration: Math.round(parsed.duration),
    fingerprint: parsed.fingerprint,
  };
}

/**
 * Look up a single fingerprint via AcoustID. Returns the parsed
 * results array (each entry has score + recordings + releasegroups)
 * or [] on no match.
 *
 * We POST with gzip-compressed body because fingerprints are long
 * (often 30KB+) and AcoustID supports gzipped POST.
 */
async function lookupFingerprint(duration, fingerprint) {
  const serviceHealth = require('./serviceHealth');
  const params = new URLSearchParams();
  params.append('client', ACOUSTID_CLIENT);
  params.append('meta', 'releasegroups+recordings');
  params.append('duration', String(duration));
  params.append('fingerprint', fingerprint);

  const body = zlib.gzipSync(params.toString());

  let res;
  try {
    res = await throttledRequest({
      method: 'POST',
      url: `${ACOUSTID_BASE}/lookup`,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Encoding': 'gzip',
      },
      data: body,
      timeout: HTTP_TIMEOUT_MS,
      // axios will gzip-decode the response automatically (default).
    });
  } catch (e) {
    serviceHealth.recordFailure('acoustid', e.message || 'network error');
    throw e;
  }

  if (res.data?.status !== 'ok') {
    const msg = res.data?.error?.message || 'unknown';
    serviceHealth.recordFailure('acoustid', msg);
    throw new Error(`AcoustID error: ${msg}`);
  }
  serviceHealth.recordSuccess('acoustid');
  return res.data.results || [];
}

/**
 * Match an album by fingerprinting up to N of its tracks. Returns
 * candidate release-groups with confidence scores in the shape
 * metadataMatch's match_candidates uses.
 *
 *   trackPaths: array of absolute file paths from the tracks table
 *   albumTitle, albumArtist: for relevance boosting in the score
 *   opts.maxTracks: how many of trackPaths to actually fingerprint,
 *                   defaulting to TRACKS_TO_FINGERPRINT
 *
 * Returns:
 *   {
 *     candidates: [{ mbid, title, artist, firstReleaseDate, primaryType,
 *                    score, source: 'acoustid', hits }],
 *     recordingMbids: ['<mbid>', ...],
 *     recordingsByPath: { '<absolute path>': '<mbid>' },
 *     reason: string|null
 *   }
 *
 * `recordingsByPath` is not in the shared contract and a caller may
 * ignore it, but persisting recording MBIDs "onto tracks" needs to know
 * which track each one belongs to, and the flat list has thrown that
 * away by the time it reaches the caller. It holds AcoustID's own
 * best-scoring recording for each path we successfully looked up.
 */
async function matchAlbumByFingerprint(trackPaths, albumTitle, albumArtist, opts = {}) {
  // Pick up to maxTracks paths. We don't sort -- caller already gave us
  // a reasonable list. Filter to existing files only.
  const maxTracks = normaliseMaxTracks(opts.maxTracks);
  const fs = require('fs');
  const usable = trackPaths.filter(p => {
    try { return fs.statSync(p).isFile(); } catch { return false; }
  }).slice(0, maxTracks);

  if (usable.length === 0) {
    return {
      candidates: [],
      recordingMbids: [],
      recordingsByPath: {},
      reason: 'No readable tracks found for fingerprinting',
    };
  }

  // Tally release-group MBIDs as we go. Each track may suggest several
  // RGs; an RG that shows up across multiple tracks is much more
  // likely to be correct than one that appears on a single track.
  const rgTally = new Map();    // mbid -> { mbid, title, artist, year, hits, totalScore, sample }
  const errors = [];

  // Recording MBIDs, collected independently of the release-group vote.
  // A Set because the same recording comes back once per track that
  // matched it, and because insertion order is AcoustID's own ranking:
  // it returns results best-score-first and recordings within a result
  // in its own confidence order, so the head of this list is the most
  // likely identification and a caller taking [0] gets the right answer.
  const recordingMbids = new Set();
  const recordingsByPath = {};

  for (const trackPath of usable) {
    let fp;
    try {
      fp = await computeFingerprint(trackPath);
    } catch (e) {
      errors.push(`${trackPath}: ${e.message}`);
      continue;
    }
    if (fp.duration < MIN_DURATION_SEC) {
      errors.push(`${trackPath}: too short (${fp.duration}s)`);
      continue;
    }

    let results;
    try {
      results = await lookupFingerprint(fp.duration, fp.fingerprint);
    } catch (e) {
      errors.push(`AcoustID lookup failed: ${e.message}`);
      continue;
    }

    // Each result has a score (0..1) and possibly recordings, each of
    // which has releasegroups. Walk the tree and tally.
    for (const result of results) {
      const acoustScore = result.score || 0;  // 0..1
      for (const rec of (result.recordings || [])) {
        // rec.id is the MusicBrainz recording MBID. The tally below only
        // ever wanted rec.releasegroups, so for several releases this
        // was read past and dropped on the floor -- the single most
        // useful identifier in the response, discarded by the code that
        // paid to fetch it. Captured here, before the release-group
        // walk, so a recording that MB has not attached to any release
        // group still gives us its MBID.
        if (rec.id) {
          recordingMbids.add(rec.id);
          if (!recordingsByPath[trackPath]) recordingsByPath[trackPath] = rec.id;
        }
        for (const rg of (rec.releasegroups || [])) {
          if (!rg.id) continue;
          const existing = rgTally.get(rg.id);
          if (existing) {
            existing.hits++;
            existing.totalScore += acoustScore;
          } else {
            rgTally.set(rg.id, {
              mbid: rg.id,
              title: rg.title || '(unknown)',
              artist: (rg.artists || []).map(a => a.name).join(' ') || rec.artists?.[0]?.name || '(unknown)',
              firstReleaseDate: rg.first_release_date || null,
              primaryType: rg.type || null,
              hits: 1,
              totalScore: acoustScore,
            });
          }
        }
      }
    }
  }

  if (rgTally.size === 0) {
    // No release group could be agreed on -- but we still hand back any
    // recording MBIDs we saw. AcoustID identifying the performances
    // while MusicBrainz has them on no shared release group is a normal
    // outcome for compilations and for singles, and those MBIDs are
    // exactly what the works layer needs.
    return {
      candidates: [],
      recordingMbids: Array.from(recordingMbids),
      recordingsByPath,
      reason: errors.length > 0
        ? `No matches. Errors: ${errors.slice(0, 3).join('; ')}`
        : 'No AcoustID matches for any sampled track',
    };
  }

  // Score: combine hit count (across multiple tracks => same RG = strong
  // signal) and average AcoustID score (fingerprint similarity), with a
  // small bonus when the RG title matches the album title.
  const albumTitleLower = (albumTitle || '').toLowerCase().trim();
  const ranked = Array.from(rgTally.values()).map(rg => {
    const avgAcoust = rg.totalScore / rg.hits;
    let score = Math.round(avgAcoust * 60);              // up to 60 from acoustid score
    score += Math.min(rg.hits, usable.length) * 15;       // up to 15 per track up to N
    if (albumTitleLower && rg.title.toLowerCase() === albumTitleLower) {
      score += 10;
    }
    return {
      mbid: rg.mbid,
      title: rg.title,
      artist: rg.artist,
      firstReleaseDate: rg.firstReleaseDate,
      primaryType: rg.primaryType,
      score: Math.min(100, score),
      source: 'acoustid',
      hits: rg.hits,
    };
  }).sort((a, b) => b.score - a.score);

  return {
    candidates: ranked.slice(0, 5),
    recordingMbids: Array.from(recordingMbids),
    recordingsByPath,
    reason: errors.length > 0 ? `Some tracks had errors: ${errors.length}` : null,
  };
}

/**
 * Fingerprint-match an album from a row the caller already holds:
 * { id, title, album_artist }. This is the entry point the automatic
 * matcher uses -- it is walking a result set of albums, so it has the
 * row in hand and must not be made to pay for a second SELECT of it.
 *
 *   opts.maxTracks: override TRACKS_TO_FINGERPRINT for this album
 *
 * Returns the same shape as matchAlbumByFingerprint.
 */
async function matchAlbumRow(album, opts = {}) {
  if (!album || !album.id) {
    throw new Error('matchAlbumRow needs an album row with an id');
  }
  const maxTracks = normaliseMaxTracks(opts.maxTracks);
  const database = db.get();

  // Tracks are selected by album_id, NOT by album title + album_artist.
  //
  // Selecting by title+artist was wrong in the one situation that
  // matters most here. Two album rows can legitimately share a title and
  // an artist -- a CD rip and a hi-res reissue of the same record in
  // different folders -- and that is precisely the case album version
  // grouping exists to handle. The old query matched the tracks of BOTH
  // rows and then took the longest ones, so the hi-res copy's files,
  // being the longer-running of near-identical durations only by luck,
  // could be the ones fingerprinted on behalf of the CD row and vice
  // versa. Two albums, one identity, decided by a duration tie-break.
  //
  // album_id is the column the rest of the server already resolves this
  // with: streamingLibrary.js mirrors excluded onto tracks with it and
  // deliberately refuses a title+artist fallback for this same reason,
  // and albumIdentity.js recovers a missing album artist from it. There
  // is an index on it (idx_tracks_album_id).
  //
  // The one cost is that tracks.album_id is NULL for a library that has
  // not been scanned since v1.1.0.92, and those rows now match nothing
  // rather than matching approximately. That is the right trade: a
  // fingerprint result is written to the album as an identity, and a
  // confidently wrong identity is worse than none. The reason string
  // below names the rescan so the user is not left guessing.
  //
  // Longest tracks first -- more decoded audio means a stronger
  // fingerprint. We ask for twice what we intend to use so that
  // unreadable or missing files (which matchAlbumByFingerprint filters
  // out by stat) still leave a full sample behind.
  const tracks = database.prepare(`
    SELECT path FROM tracks
    WHERE album_id = ? AND excluded = 0
    ORDER BY duration DESC
    LIMIT ?
  `).all(album.id, maxTracks * 2);

  if (tracks.length === 0) {
    return {
      candidates: [],
      recordingMbids: [],
      recordingsByPath: {},
      reason: 'No tracks are linked to this album. If the library has not '
        + 'been rescanned recently, run a scan so tracks are linked to their '
        + 'album rows, then try again.',
    };
  }
  return await matchAlbumByFingerprint(
    tracks.map(t => t.path),
    album.title,
    album.album_artist,
    { maxTracks }
  );
}

/**
 * Convenience: fingerprint-match an album by its id. Loads the row and
 * delegates to matchAlbumRow. This is what the manual "Try fingerprint"
 * route calls, and its signature has not changed.
 */
async function matchAlbumById(albumId, opts = {}) {
  const database = db.get();
  const album = database.prepare(
    'SELECT id, title, album_artist FROM albums WHERE id = ?'
  ).get(albumId);
  if (!album) {
    throw new Error('Album not found');
  }
  return await matchAlbumRow(album, opts);
}

/**
 * Roughly how many seconds fingerprinting `albumCount` albums will take.
 *
 * The automatic matcher needs this to decide whether fingerprinting is
 * something it can do inline or something it should offer as a separate,
 * clearly expensive pass -- an AcoustID lookup is not comparable to a
 * MusicBrainz search, because before the network call there is a full
 * audio decode per track. What it does NOT need is precision, and this
 * cannot give it any: the decode dominates and its cost depends on the
 * codec, the file size and the host's CPU, none of which we know here.
 * Treat the answer as an order of magnitude for a progress estimate or a
 * warning, never as a deadline.
 */
function estimateCost(albumCount, opts = {}) {
  const n = Number(albumCount);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const maxTracks = normaliseMaxTracks(opts.maxTracks);
  return Math.round(n * maxTracks * SECONDS_PER_FINGERPRINTED_TRACK);
}

module.exports = {
  matchAlbumRow,
  matchAlbumById,
  matchAlbumByFingerprint,
  estimateCost,
  computeFingerprint,
  lookupFingerprint,
};
