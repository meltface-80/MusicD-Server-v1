// Album metadata matching against MusicBrainz (#30.19)
// =====================================================
//
// For each album in the library, query MusicBrainz's release-group
// search and try to find a confident match. Successful matches store
// the MBID; uncertain or no matches go to a triage list the user can
// review on the Unmatched page.
//
// We don't write any tag fields into the database in Phase 1 -- this
// module is purely about finding and storing the MBID. Later phases
// will use that MBID to fetch canonical metadata, cover art, bios.
//
// MusicBrainz's API requires:
//   - Identifying User-Agent (we build it from the user's contact info)
//   - 1 request per second rate limit
//   - Response timeout reasonable (5s)
//
// The contact field is mandatory. If empty, this module refuses to
// run and returns a clear error to the UI. That puts the responsibility
// on the user to comply with MB's TOS.

const axios = require('axios');
const db = require('./db');

const MB_BASE = 'https://musicbrainz.org/ws/2';
const REQUEST_TIMEOUT_MS = 8000;
const MAX_CANDIDATES_STORED = 5;

// State
let _running = false;
let _stopRequested = false;
let _progress = {
  running: false,
  processed: 0,
  total: 0,
  matched: 0,
  uncertain: 0,
  unmatched: 0,
  errored: 0,
  lastError: null,
  startedAt: null,
};

// Shared 1 req/sec throttle so this module and bioFetch don't breach
// the MB rate limit when running concurrently (#30.23).
const mbThrottle = require('./mbThrottle');

/**
 * Throttled HTTP request to the MusicBrainz API. Sleeps before each
 * call so we never exceed 1 req/sec (with a small margin).
 */
async function mbRequest(path, params, userAgent) {
  await mbThrottle.wait();

  const serviceHealth = require('./serviceHealth');
  const url = `${MB_BASE}${path}`;
  try {
    const res = await axios.get(url, {
      params: { ...params, fmt: 'json' },
      headers: { 'User-Agent': userAgent },
      timeout: REQUEST_TIMEOUT_MS,
    });
    serviceHealth.recordSuccess('musicbrainz');
    return res.data;
  } catch (e) {
    // 404 on a specific MBID lookup is a normal "not found" -- not a
    // service failure. Search endpoints don't 404 (they return empty).
    if (e.response?.status === 404) {
      serviceHealth.recordSuccess('musicbrainz');
      throw e;
    }
    serviceHealth.recordFailure('musicbrainz', e.message || 'unknown error');
    throw e;
  }
}

/**
 * Build the User-Agent string that identifies our client to
 * MusicBrainz. Their TOS requires this -- they need a way to contact
 * us if our client misbehaves.
 *
 * The contact part is user-supplied (URL or email). Without it we
 * refuse to start. The version number comes from the VERSION file so
 * MB's logs show which release made the request.
 */
function buildUserAgent(contact) {
  let version = 'unknown';
  try {
    const fs = require('fs');
    const path = require('path');
    version = fs.readFileSync(path.join(__dirname, '../../VERSION'), 'utf-8').trim();
  } catch {} // not fatal; UA still needs the contact part
  return `musicd/${version} ( ${contact} )`;
}

/**
 * Normalise a string for matching. Strips diacritics (so cafe matches
 * café), removes leading articles ("The Beatles" matches "Beatles"),
 * lowercases, collapses whitespace, removes punctuation. The result
 * is only used for scoring -- the original strings are sent to MB.
 */
function normalise(s) {
  if (!s) return '';
  let n = String(s).toLowerCase();
  // Strip diacritics
  n = n.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  // Drop leading article
  n = n.replace(/^(the |a |an )/i, '');
  // Drop punctuation that varies between sources
  n = n.replace(/[^\w\s]/g, ' ');
  // Collapse whitespace
  n = n.replace(/\s+/g, ' ').trim();
  return n;
}

/**
 * v1.1.0.66 — strip noise phrases from an album title before sending
 * it to MusicBrainz or scoring against a candidate. Many real-world
 * albums in the wild are tagged with reissue / edition phrasing that
 * MB doesn't include in the canonical release-group title. Without
 * this stripping, queries like:
 *
 *   releasegroup:"Abbey Road (Remastered 2019)"
 *
 * either return nothing or score the canonical "Abbey Road" too low
 * to clear the 85-confidence threshold (because the edit-distance
 * between the user's title and MB's title is huge).
 *
 * Patterns we strip (case-insensitive):
 *   - Trailing parenthesised qualifiers: (Deluxe), (Remastered),
 *     (Remastered 2019), (Anniversary Edition), (Bonus Tracks),
 *     (Expanded), (Special Edition), (Director's Cut), (Live), etc.
 *   - Trailing bracketed qualifiers: [Bonus Tracks], [Hi-Res], etc.
 *   - Trailing en-dash qualifiers: " - Remastered", " - Live at Foo"
 *   - Disc indicators: " CD1", " Disc 1", " Vol. 1"
 *   - Format hints: " (HiRes 24/96)", " (DSD)", " (FLAC)"
 *
 * We only strip TRAILING noise — leading or middle phrases are
 * usually meaningful ("Live at Wembley" as the full title is a
 * different release group than "Wembley"). The trailing-only rule
 * keeps "(Live)" suffixes off, but preserves "Live!" as a title.
 *
 * We also keep the cleaned title for scoring AND build a separate
 * "tail" string of what was stripped. The tail is logged in the
 * diagnostic so users can see why a match was attempted with a
 * different title than the one tagged.
 */
const NOISE_PATTERNS = [
  // Parenthesised editions / formats / live notes
  /\s*[\(\[]\s*(?:remaster(?:ed)?|deluxe|expanded|special|anniversary|legacy|collector'?s|definitive|limited|gold|platinum|standard|original|extended|director'?s)\s+(?:edition|version|cut|recording|mix|master)?\s*(?:\d{2,4})?\s*[\)\]]\s*$/i,
  // "(50th Anniversary Edition)", "(25th Anniversary)", "(2nd Edition)"
  /\s*[\(\[]\s*\d+(?:st|nd|rd|th)?\s+(?:anniversary|edition|reissue|remaster(?:ed)?|deluxe|expanded|special)\s*(?:edition|version)?\s*[\)\]]\s*$/i,
  /\s*[\(\[]\s*(?:remaster(?:ed)?|deluxe|expanded|special|anniversary|bonus\s+tracks?|bonus|hi-?res|live|acoustic|demo|instrumental|stereo|mono|reissue|repackaged?|edition)\s*(?:\d{2,4})?\s*[\)\]]\s*$/i,
  /\s*[\(\[]\s*\d{4}\s+(?:remaster(?:ed)?|edition|reissue|version)\s*[\)\]]\s*$/i,
  /\s*[\(\[]\s*(?:24[/-]?96|24[/-]?192|dsd\d*|flac|mqa|hi-?res(?:\s+audio)?)\s*[\)\]]\s*$/i,
  // En-dash / hyphen trailing edition notes
  /\s+[\-\u2013\u2014]\s+(?:remaster(?:ed)?|deluxe|expanded|live|bonus\s+tracks?|hi-?res|edition|version)\b.*$/i,
  // Disc indicators at the very end
  /\s+(?:cd|disc|disk|vol(?:ume)?\.?)\s*\d+\s*$/i,
];

function cleanAlbumTitle(title) {
  if (!title) return { cleaned: '', stripped: [] };
  let cleaned = String(title).trim();
  const stripped = [];
  let changed = true;
  // Iterate — a title can have multiple trailing noise phrases
  // ("Foo (Deluxe Edition) [Bonus Tracks]"). Each pass strips one;
  // we keep going until no pattern matches. Cap at 4 iterations to
  // avoid pathological cases.
  let iter = 0;
  while (changed && iter < 4) {
    changed = false;
    for (const re of NOISE_PATTERNS) {
      const m = cleaned.match(re);
      if (m) {
        stripped.push(m[0].trim());
        cleaned = cleaned.slice(0, m.index).trim();
        changed = true;
        break;
      }
    }
    iter += 1;
  }
  // Don't return an empty cleaned title — if we'd strip everything,
  // keep the original. (E.g. "(Live)" as the full title.)
  if (!cleaned) cleaned = String(title).trim();
  return { cleaned, stripped };
}

/**
 * v1.1.0.66 — strip "feat./ft./featuring" suffixes from an artist
 * name. MusicBrainz stores featured-artist credits via the artist-
 * credit join phrase, not in the artist string itself. So a tag like
 * "Calvin Harris feat. Rihanna" must become "Calvin Harris" for the
 * MB query to match.
 *
 * Also strips trailing "& Friends", "and the X-band" if at the end —
 * these are common informal credits that don't appear in MB's
 * canonical artist row. Conservative: only trailing "feat.X" is
 * stripped automatically; "and the X-band" is preserved unless the
 * artist clearly has a known canonical short form.
 */
function cleanArtistName(artist) {
  if (!artist) return { cleaned: '', stripped: [] };
  let cleaned = String(artist).trim();
  const stripped = [];
  // Strip trailing "feat. X", "ft. X", "featuring X", "f. X"
  const featRe = /\s+(?:feat\.?|ft\.?|featuring|f\.|with)\s+.+$/i;
  const m = cleaned.match(featRe);
  if (m) {
    stripped.push(m[0].trim());
    cleaned = cleaned.slice(0, m.index).trim();
  }
  if (!cleaned) cleaned = String(artist).trim();
  return { cleaned, stripped };
}

/**
 * Levenshtein distance, capped at maxDist (returns maxDist+1 if exceeded).
 * Used to allow small typos when scoring candidates. We cap because the
 * full computation is O(m*n) and we only care about "close enough" or
 * "way off".
 */
function editDistance(a, b, maxDist = 5) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > maxDist) return maxDist + 1;
  const al = a.length, bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  let prev = new Array(bl + 1);
  let curr = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,        // insertion
        prev[j] + 1,            // deletion
        prev[j - 1] + cost      // substitution
      );
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > maxDist) return maxDist + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[bl];
}

/**
 * Score a single MB release group candidate against our album record.
 * Returns 0-100 where 100 is a perfect match. The thresholds for what
 * counts as "matched" vs "uncertain" are at the call site.
 *
 * Heuristics:
 *   - Title exact match (after normalisation): +50
 *   - Title close match (Levenshtein <= 2): +35
 *   - Title fuzzy match (Levenshtein <= 4): +20
 *   - Artist exact match: +30
 *   - Artist close match: +20
 *   - Year matches release-group's first-release-date: +15
 *   - Track count matches: +5
 *   - MB's own ext:score matches >= 95: +10 (their scorer agrees)
 */
function scoreCandidate(album, candidate) {
  let score = 0;
  // v1.1.0.66 — strip noise tails before normalising for scoring.
  // Without this, the candidate's canonical title (e.g. "Abbey Road")
  // and our tagged title (e.g. "Abbey Road (Remastered 2019)") have
  // a huge edit-distance and the candidate scores 0 on the title
  // axis even though it's the right release group. Same for
  // featured-artist suffixes.
  const albumTitleClean = cleanAlbumTitle(album.title || '').cleaned;
  const albumArtistClean = cleanArtistName(album.album_artist || '').cleaned;
  const albumTitleN = normalise(albumTitleClean);
  const albumArtistN = normalise(albumArtistClean);
  const candTitleN = normalise(candidate.title);
  // "artist-credit" is an array of { name, joinphrase, artist:{name,...} }
  const candArtistName = (candidate['artist-credit'] || [])
    .map(ac => ac.name || ac.artist?.name || '')
    .join(' ');
  const candArtistN = normalise(candArtistName);

  // Title scoring
  if (albumTitleN === candTitleN) {
    score += 50;
  } else {
    // v1.1.0.66 — proportional fuzzy threshold. The old fixed cap of
    // 4 was too tight for long titles (classical works, "Symphony No.
    // X in Y Major Op. Z" patterns). New threshold scales with title
    // length: ~10% of the longer side, capped at 8. Short titles
    // still get a tight match (3-char title → cap of 1), long titles
    // get the latitude they need.
    const longerLen = Math.max(albumTitleN.length, candTitleN.length);
    const fuzzyCap = Math.max(2, Math.min(8, Math.floor(longerLen * 0.10)));
    const dist = editDistance(albumTitleN, candTitleN, fuzzyCap);
    // Stratify: closer match → higher score. Ratios are computed
    // against the new dynamic cap so a "1 edit on a 30-char title"
    // doesn't score the same as "1 edit on a 5-char title".
    if (dist <= Math.max(2, Math.floor(fuzzyCap * 0.25))) score += 35;
    else if (dist <= Math.floor(fuzzyCap * 0.5))         score += 25;
    else if (dist <= fuzzyCap)                            score += 15;
  }

  // Artist scoring
  if (albumArtistN === candArtistN) {
    score += 30;
  } else {
    // Same proportional approach as title.
    const longerArtLen = Math.max(albumArtistN.length, candArtistN.length);
    const fuzzyCap = Math.max(2, Math.min(6, Math.floor(longerArtLen * 0.12)));
    const dist = editDistance(albumArtistN, candArtistN, fuzzyCap);
    if (dist <= Math.max(2, Math.floor(fuzzyCap * 0.25))) score += 22;
    else if (dist <= fuzzyCap)                            score += 12;
  }

  // Year matching (release group's first-release-date)
  if (album.year && candidate['first-release-date']) {
    const candYear = parseInt(candidate['first-release-date'].slice(0, 4), 10);
    if (candYear && Math.abs(candYear - album.year) <= 1) score += 15;
  }

  // MB's own search relevance score
  if (candidate.score && candidate.score >= 95) score += 10;

  return Math.min(100, score);
}

/**
 * Match a single album against MusicBrainz. Returns the result object
 * to be persisted; doesn't write to the DB itself.
 *
 * Phase 1 logic:
 *   - Query MB release-group?query=...
 *   - Score each candidate
 *   - Best score >= 85: matched
 *   - Best score >= 60 OR multiple candidates >= 75: uncertain
 *   - Otherwise: unmatched
 */
async function matchOneAlbum(album, userAgent) {
  // Fast path: if the album row carries an mb_release_id from tags
  // (#v1.1.0.20) but no release-group ID, do a single direct lookup
  // to convert release -> release-group. Cheap (one request) and
  // very accurate -- the user's tag is authoritative.
  if (album.mb_release_id && !album.mb_release_group_id) {
    try {
      const data = await mbRequest(
        `/release/${album.mb_release_id}`,
        { inc: 'release-groups' },
        userAgent
      );
      const rgId = data?.['release-group']?.id;
      if (rgId) {
        return {
          status: 'matched',
          confidence: 100,
          mbid: rgId,
          candidates: [{
            mbid: rgId,
            title: data['release-group'].title || album.title,
            artist: data['release-group']['artist-credit']?.[0]?.name || album.album_artist,
            year: (data['release-group']['first-release-date'] || '').slice(0, 4),
            score: 100,
            source: 'tag-resolved',
          }],
        };
      }
    } catch {
      // Fall through to the title-search path. If the release ID was
      // wrong or MB has no record of it, we want the normal matcher
      // to run rather than mark it errored.
    }
  }

  // v1.1.0.66 — clean noise out of the title and artist before the
  // search. Many real-world tags carry "(Deluxe Edition)" / "feat. X"
  // / "[Bonus Tracks]" trailers that MusicBrainz doesn't include in
  // the canonical release-group title. Keep both the original and
  // the cleaned forms; we'll fall back to the original if the
  // cleaned query returns nothing.
  const titleClean0 = (album.title || '').replace(/["\\]/g, ' ').trim();
  const artistClean0 = (album.album_artist || '').replace(/["\\]/g, ' ').trim();
  const { cleaned: titleClean, stripped: titleStripped } = cleanAlbumTitle(titleClean0);
  const { cleaned: artistClean, stripped: artistStripped } = cleanArtistName(artistClean0);
  if (!titleClean || !artistClean) {
    return { status: 'unmatched', confidence: null, mbid: null, candidates: [], diagnostic: { reason: 'missing-title-or-artist', titleStripped, artistStripped } };
  }

  // Strategy: try the most specific query first (with barcode/catno
  // when we have them), fall back to title+artist if that returns
  // nothing. This is more accurate than a single broad query because
  // the MB scoring algorithm penalises results that don't match
  // every field, but rewards results that match additional fields.
  // (#v1.1.0.20)
  //
  // Order of attempts:
  //   1. barcode is unique enough that title+artist+barcode is gold
  //   2. catalog_number is nearly as good
  //   3. year+title+artist disambiguates the most common case (an
  //      album reissued multiple times)
  //   4. plain title+artist as a final fallback
  const attempts = [];
  if (album.barcode) {
    const bc = album.barcode.replace(/["\\]/g, ' ').trim();
    if (bc) {
      attempts.push(`releasegroup:"${titleClean}" AND artist:"${artistClean}" AND barcode:"${bc}"`);
    }
  }
  if (album.catalog_number) {
    const cn = album.catalog_number.replace(/["\\]/g, ' ').trim();
    if (cn) {
      attempts.push(`releasegroup:"${titleClean}" AND artist:"${artistClean}" AND catno:"${cn}"`);
    }
  }
  if (album.year && Number.isFinite(album.year)) {
    attempts.push(`releasegroup:"${titleClean}" AND artist:"${artistClean}" AND firstreleasedate:${album.year}`);
  }
  // Plain query last -- always runs as a safety net.
  attempts.push(`releasegroup:"${titleClean}" AND artist:"${artistClean}"`);

  // v1.1.0.66 — if we cleaned anything off the title or artist, also
  // fall back to a query with the ORIGINAL strings. Some MB release
  // groups genuinely include "(Deluxe Edition)" in their canonical
  // title (e.g. when the deluxe edition was its own release group);
  // those wouldn't match a cleaned-title query. The raw-title attempt
  // runs only if no cleaned-title attempt got results.
  if (titleStripped.length > 0 || artistStripped.length > 0) {
    attempts.push(`releasegroup:"${titleClean0}" AND artist:"${artistClean0}"`);
  }

  // v1.1.0.66 — final fallback: artist-only search. If everything
  // else returns nothing, scan the artist's release groups and let
  // the candidate scorer find any near-title match. This catches the
  // case where the album title in our tags is so wrong that no
  // title-clause query hits, but the artist match plus a fuzzy
  // title score is still informative for the user. We cap to 25
  // results so we don't drown the scorer in irrelevant items.
  attempts.push(`artist:"${artistClean}"`);

  let groups = [];
  let lastQueryUsed = null;
  for (const query of attempts) {
    let data;
    try {
      data = await mbRequest('/release-group/', { query, limit: 10 }, userAgent);
    } catch (e) {
      // Network/HTTP failures are recoverable — mark as 'error', the
      // user can retry later. Distinguish 503 (busy) from real failures
      // because both should retry.
      return { status: 'error', confidence: null, mbid: null, candidates: [], error: e.message };
    }
    const fetched = data['release-groups'] || [];
    if (fetched.length > 0) {
      groups = fetched;
      lastQueryUsed = query;
      break;
    }
  }

  if (groups.length === 0) {
    return { status: 'unmatched', confidence: 0, mbid: null, candidates: [] };
  }

  // Score and sort
  const scored = groups
    .map(g => ({ candidate: g, score: scoreCandidate(album, g) }))
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
  const second = scored[1];

  // Trim down candidate data to what the UI actually needs, to keep
  // the JSON column small. Stored once at match time and read by the
  // Unmatched page when the user opens triage.
  const trimmedCandidates = scored.slice(0, MAX_CANDIDATES_STORED).map(s => ({
    mbid: s.candidate.id,
    title: s.candidate.title,
    artist: (s.candidate['artist-credit'] || [])
      .map(ac => ac.name || ac.artist?.name || '')
      .join(' ').trim() || '(unknown)',
    primaryType: s.candidate['primary-type'] || null,
    firstReleaseDate: s.candidate['first-release-date'] || null,
    score: s.score,
    mbScore: s.candidate.score || null,
  }));

  // Decide match status
  // - 85+ with no close runner-up: matched
  // - 60+ but ambiguous (or single weak match): uncertain
  // - else: unmatched
  if (top.score >= 85 && (!second || second.score < top.score - 15)) {
    return {
      status: 'matched',
      confidence: top.score,
      mbid: top.candidate.id,
      candidates: trimmedCandidates,
    };
  }
  if (top.score >= 60) {
    return {
      status: 'uncertain',
      confidence: top.score,
      mbid: null,
      candidates: trimmedCandidates,
    };
  }
  return {
    status: 'unmatched',
    confidence: top.score,
    mbid: null,
    candidates: trimmedCandidates,
  };
}

/**
 * Main loop: pulls pending albums from the DB one at a time, queries
 * MB, persists the result. Runs until stopped, no more pending work,
 * or a fatal error.
 */
async function runLoop(contact) {
  const userAgent = buildUserAgent(contact);
  const database = db.get();

  // Total pending count for progress display
  const totalPendingResult = database.prepare(`
    SELECT COUNT(*) AS c FROM albums
    WHERE excluded = 0 AND (match_status IS NULL OR match_status IN ('pending', 'error'))
  `).get();
  _progress.total = totalPendingResult.c;
  _progress.processed = 0;
  _progress.matched = 0;
  _progress.uncertain = 0;
  _progress.unmatched = 0;
  _progress.errored = 0;
  _progress.startedAt = Date.now();
  _progress.lastError = null;

  console.log(`[match] Starting MusicBrainz matcher for ${_progress.total} albums`);

  // Pick one pending album, process it, repeat. We re-query each
  // iteration rather than fetching the full list once because the
  // user might add new albums (via library scan) while the matcher
  // runs — those will be picked up automatically.
  const pickStmt = database.prepare(`
    SELECT id, title, album_artist, year, track_count,
           barcode, catalog_number, mb_release_id, mb_release_group_id
    FROM albums
    WHERE excluded = 0 AND (match_status IS NULL OR match_status IN ('pending', 'error'))
    ORDER BY id
    LIMIT 1
  `);
  const updateStmt = database.prepare(`
    UPDATE albums
    SET mb_release_group_id = ?,
        match_status = ?,
        match_confidence = ?,
        match_candidates = ?,
        matched_at = ?,
        matched_by = ?
    WHERE id = ?
  `);

  while (!_stopRequested) {
    const album = pickStmt.get();
    if (!album) {
      console.log('[match] No more pending albums, stopping');
      break;
    }

    let result;
    try {
      result = await matchOneAlbum(album, userAgent);
    } catch (e) {
      console.error(`[match] Failed on album "${album.title}":`, e.message);
      result = { status: 'error', confidence: null, mbid: null, candidates: [] };
      _progress.lastError = e.message;
    }

    // Determine matched_by based on result source. The matcher's
    // tag-resolved fast path returns candidates with source='tag-resolved'
    // (the user's tag was authoritative). Everything else from this loop
    // is auto-matched. (#v1.1.0.21)
    let matchedBy = null;
    if (result.status === 'matched') {
      const fromTag = (result.candidates || []).some(c => c.source === 'tag-resolved');
      matchedBy = fromTag ? 'tag' : 'auto';
    }

    // Persist result. Even errors get persisted so the loop doesn't
    // get stuck on the same album forever -- they're picked up again
    // in the next run if the user resets.
    // v1.1.0.78 — matched_at in unix seconds (was milliseconds in
    // v77 and prior). Schema-wide normalisation; see migration
    // for the conversion of legacy rows.
    updateStmt.run(
      result.mbid,
      result.status,
      result.confidence,
      JSON.stringify(result.candidates || []),
      Math.floor(Date.now() / 1000),
      matchedBy,
      album.id
    );

    _progress.processed++;
    if (result.status === 'matched') _progress.matched++;
    else if (result.status === 'uncertain') _progress.uncertain++;
    else if (result.status === 'unmatched') _progress.unmatched++;
    else if (result.status === 'error') _progress.errored++;

    if (_progress.processed % 25 === 0) {
      console.log(`[match] Progress: ${_progress.processed}/${_progress.total} ` +
        `(${_progress.matched} matched, ${_progress.uncertain} uncertain, ${_progress.unmatched} unmatched, ${_progress.errored} errored)`);
    }
  }

  console.log(`[match] Stopped. Final: ${_progress.processed}/${_progress.total} ` +
    `(${_progress.matched} matched, ${_progress.uncertain} uncertain, ${_progress.unmatched} unmatched, ${_progress.errored} errored)`);
}

// ── public API ────────────────────────────────────────────────────────

async function start(contact) {
  if (_running) {
    throw new Error('Matcher is already running');
  }
  if (!contact || !contact.trim()) {
    throw new Error('A contact (URL or email) is required for MusicBrainz API requests. Set one in Settings → Metadata Refresh.');
  }
  _running = true;
  _stopRequested = false;
  _progress.running = true;
  // Don't await — return immediately so the API can respond. The loop
  // runs in the background; progress is polled by the UI.
  runLoop(contact)
    .catch(e => {
      console.error('[match] Loop crashed:', e);
      _progress.lastError = e.message;
    })
    .finally(() => {
      _running = false;
      _progress.running = false;
    });
}

function stop() {
  _stopRequested = true;
}

function getProgress() {
  const out = { ..._progress };
  // When the matcher is idle, also report how many albums are still
  // pending to be matched (#30.24). This catches the case where the
  // last run finished, the user added new albums via a library scan,
  // and now expects to see "X pending" -- otherwise they'd see the
  // stale "5,000 / 5,000" from the previous run.
  if (!_running) {
    try {
      const r = db.get().prepare(`
        SELECT COUNT(*) AS c FROM albums
        WHERE excluded = 0 AND (match_status IS NULL OR match_status IN ('pending', 'error'))
      `).get();
      out.pendingCount = r?.c || 0;
    } catch {
      out.pendingCount = 0;
    }
  } else {
    out.pendingCount = Math.max(0, _progress.total - _progress.processed);
  }
  return out;
}

/**
 * Reset all match results. Marks every album as 'pending' so the
 * matcher will reprocess them on next run. Useful if MB has updated
 * data, or if the user changed the matching algorithm.
 */
function resetAll() {
  if (_running) {
    throw new Error('Cannot reset while matcher is running. Stop first.');
  }
  const database = db.get();
  // Preserve manual decisions -- if the user has confirmed or rejected
  // an album, that's an intentional choice we don't want to silently
  // undo (#v1.1.0.21). Tag-sourced matches are also preserved because
  // those reflect authoritative metadata in the file. Reset only
  // affects 'auto' matches, plus uncertain/unmatched/error states.
  database.prepare(`
    UPDATE albums
    SET mb_release_group_id = NULL,
        match_status = 'pending',
        match_confidence = NULL,
        match_candidates = NULL,
        matched_at = NULL
    WHERE excluded = 0
      AND (matched_by IS NULL OR matched_by = 'auto')
  `).run();
}

/**
 * Count of albums that need user attention -- i.e. uncertain or
 * unmatched. Used by the sidebar to decide whether to show the
 * "Unmatched" menu item.
 */
function getUnmatchedCount() {
  const database = db.get();
  const r = database.prepare(`
    SELECT COUNT(*) AS c FROM albums
    WHERE excluded = 0 AND match_status IN ('uncertain', 'unmatched')
  `).get();
  return r?.c || 0;
}

/**
 * Free-text search of MB release-groups, used by the manual matching
 * UI (#v1.1.0.21). Returns an array in the same shape as the
 * match_candidates JSON column so the UI can render results with the
 * same component used for auto-matched candidates.
 *
 * Query is passed through MB's Lucene-syntax search. We don't try to
 * parse the user's input -- if they type "miles davis kind of blue"
 * that's fine; if they type artist:"miles davis" AND release:"kind of
 * blue" that's also fine. MB handles both.
 */
async function searchReleaseGroups(query, contact) {
  if (!contact || !contact.trim()) {
    throw new Error('A contact (URL or email) is required for MusicBrainz API requests.');
  }
  const userAgent = buildUserAgent(contact.trim());
  const data = await mbRequest('/release-group/', { query, limit: 25 }, userAgent);
  const groups = data['release-groups'] || [];
  return groups.map(g => ({
    mbid: g.id,
    title: g.title,
    artist: (g['artist-credit'] || [])
      .map(ac => ac.name || ac.artist?.name || '')
      .join(' ').trim() || '(unknown)',
    primaryType: g['primary-type'] || null,
    firstReleaseDate: g['first-release-date'] || null,
    score: g.score || 0,
    mbScore: g.score || null,
  }));
}

/**
 * v1.1.0.66 — flip currently-unmatched (and uncertain) albums back
 * to 'pending' so the regular worker loop will re-process them with
 * the v66 improved matcher. Skips albums the user has manually
 * confirmed (matched_by='manual') or that came in via tag MBID
 * (matched_by='tag') — those decisions stick. Returns the count of
 * albums queued.
 */
function requeueUnmatched() {
  const database = db.get();
  // v1.1.0.78 — include 'error' alongside unmatched/uncertain.
  // Pre-v78 the rematch button silently skipped error-state albums,
  // even though those are exactly the ones most likely to recover
  // on a retry (transient MB / network failures during the original
  // sweep).
  const result = database.prepare(`
    UPDATE albums
    SET match_status = 'pending',
        match_confidence = NULL,
        match_candidates = NULL,
        matched_at = NULL
    WHERE excluded = 0
      AND match_status IN ('unmatched', 'uncertain', 'error')
      AND (matched_by IS NULL OR matched_by = 'auto')
  `).run();
  return result.changes || 0;
}

/**
 * v1.1.0.66 — diagnostic: run the v66 cleaners against every
 * currently-unmatched album and report what would be stripped.
 * Doesn't hit MusicBrainz at all — purely in-memory analysis to
 * help the user understand WHY their library has unmatched albums.
 *
 * Returns:
 *   {
 *     totalUnmatched: int,
 *     wouldChangeQuery: int,        // albums where cleaner would produce a different MB query
 *     wouldNotChange: int,          // albums where the cleaner is a no-op (already clean)
 *     missingTitleOrArtist: int,    // can't be matched regardless — no title or artist
 *     samples: [
 *       { id, title, album_artist, cleanedTitle, cleanedArtist, titleStripped, artistStripped }
 *     ]
 *   }
 *
 * The samples array contains up to `sampleLimit` albums where the
 * cleaner WOULD change the query — these are the candidates most
 * likely to benefit from a rematch run.
 */
function previewDiagnostic({ sampleLimit = 30 } = {}) {
  const database = db.get();
  // v1.1.0.78 — include 'error' status alongside 'unmatched' and
  // 'uncertain'. Pre-v78 the diagnostic only counted unmatched +
  // uncertain, leaving any albums that errored out (network blip
  // mid-MB-fetch, transient 503, etc.) invisible to the user even
  // though they're prime candidates for re-queue.
  const rows = database.prepare(`
    SELECT id, title, album_artist, match_status
    FROM albums
    WHERE excluded = 0
      AND match_status IN ('unmatched', 'uncertain', 'error')
      AND (matched_by IS NULL OR matched_by = 'auto')
    ORDER BY id
  `).all();

  let wouldChangeQuery = 0;
  let wouldNotChange = 0;
  let missingTitleOrArtist = 0;
  // v1.1.0.78 — per-status breakdown so the UI can show
  // "12 unmatched · 4 uncertain · 1 error".
  const byStatus = { unmatched: 0, uncertain: 0, error: 0 };
  const samples = [];

  for (const row of rows) {
    if (byStatus[row.match_status] !== undefined) byStatus[row.match_status]++;

    const rawTitle = (row.title || '').trim();
    const rawArtist = (row.album_artist || '').trim();
    if (!rawTitle || !rawArtist) {
      missingTitleOrArtist += 1;
      continue;
    }
    const t = cleanAlbumTitle(rawTitle);
    const a = cleanArtistName(rawArtist);
    const changed = t.stripped.length > 0 || a.stripped.length > 0;
    if (changed) {
      wouldChangeQuery += 1;
      if (samples.length < sampleLimit) {
        samples.push({
          id: row.id,
          title: row.title,
          album_artist: row.album_artist,
          cleanedTitle: t.cleaned,
          cleanedArtist: a.cleaned,
          titleStripped: t.stripped,
          artistStripped: a.stripped,
        });
      }
    } else {
      wouldNotChange += 1;
    }
  }

  return {
    totalUnmatched: rows.length,
    wouldChangeQuery,
    wouldNotChange,
    missingTitleOrArtist,
    byStatus,
    samples,
  };
}

module.exports = {
  start,
  stop,
  getProgress,
  resetAll,
  getUnmatchedCount,
  searchReleaseGroups,
  // v1.1.0.66 additions
  requeueUnmatched,
  previewDiagnostic,
  cleanAlbumTitle,
  cleanArtistName,
};
