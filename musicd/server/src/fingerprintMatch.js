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
 *
 * Returns: [{ mbid, title, artist, firstReleaseDate, score, source: 'acoustid' }]
 */
async function matchAlbumByFingerprint(trackPaths, albumTitle, albumArtist) {
  // Pick up to TRACKS_TO_FINGERPRINT paths. We don't sort -- caller
  // already gave us a reasonable list. Filter to existing files only.
  const fs = require('fs');
  const usable = trackPaths.filter(p => {
    try { return fs.statSync(p).isFile(); } catch { return false; }
  }).slice(0, TRACKS_TO_FINGERPRINT);

  if (usable.length === 0) {
    return { candidates: [], reason: 'No readable tracks found for fingerprinting' };
  }

  // Tally release-group MBIDs as we go. Each track may suggest several
  // RGs; an RG that shows up across multiple tracks is much more
  // likely to be correct than one that appears on a single track.
  const rgTally = new Map();    // mbid -> { mbid, title, artist, year, hits, totalScore, sample }
  const errors = [];

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
    return {
      candidates: [],
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
    reason: errors.length > 0 ? `Some tracks had errors: ${errors.length}` : null,
  };
}

/**
 * Convenience: fingerprint-match an album by its database row. Looks
 * up the album's tracks, picks up to N, and runs matchAlbumByFingerprint.
 */
async function matchAlbumById(albumId) {
  const database = db.get();
  const album = database.prepare(
    'SELECT id, title, album_artist FROM albums WHERE id = ?'
  ).get(albumId);
  if (!album) {
    throw new Error('Album not found');
  }
  // Pick longest tracks first -- more decoded audio = stronger
  // fingerprint. Limit early so we don't read the whole tracks table.
  const tracks = database.prepare(`
    SELECT path FROM tracks
    WHERE album = ? AND album_artist = ? AND excluded = 0
    ORDER BY duration DESC
    LIMIT ?
  `).all(album.title, album.album_artist, TRACKS_TO_FINGERPRINT * 2);

  if (tracks.length === 0) {
    return { candidates: [], reason: 'No tracks found for this album' };
  }
  return await matchAlbumByFingerprint(
    tracks.map(t => t.path),
    album.title,
    album.album_artist
  );
}

module.exports = {
  matchAlbumById,
  matchAlbumByFingerprint,
  computeFingerprint,
  lookupFingerprint,
};
