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
// v1.1.34.0 — normalisation, edition-noise stripping and folder parsing
// moved to src/albumIdentity.js so this matcher and album version
// grouping cannot disagree about what "the same album" means. If they
// disagree, three copies of one record match the same release group and
// still refuse to collapse into one tile.
const identity = require('./albumIdentity');
const mbArtist = require('./mbArtist');

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

// v1.1.34.0 — normalise / cleanAlbumTitle / cleanArtistName used to be
// defined here. They now live in src/albumIdentity.js, because album
// version grouping needs exactly the same answers and a second copy
// would drift. Aliased rather than rewritten at every call site, so the
// diff that moved them is readable.
const normalise = identity.normalise;
const cleanAlbumTitle = identity.cleanAlbumTitle;
const cleanArtistName = identity.cleanArtistName;

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
 * Score one MusicBrainz release group against one local album.
 * 0-100. The matched / uncertain thresholds are at the call site.
 *
 * v1.1.34.0 — THE ARITHMETIC CHANGED, and it is the fix for the
 * reported bug. Under the old weights an exact title plus an exact
 * artist scored 50 + 30 = 80, against a matched threshold of 85. So a
 * PERFECT match on both axes did not match. It only got over the line
 * with a year agreement (+15) or MB's own confidence (+10).
 *
 * That is precisely why "Air - Moon Safari (Remaster)" failed. The
 * noise stripper does its job and searches for "Moon Safari"; the title
 * and artist both match exactly — but the file is tagged with the
 * REISSUE year, 2018, while the release group's first release was 1998.
 * No year bonus, 80 points, sent to triage. Three copies of one album,
 * three trips to the Unmatched page.
 *
 * Exact title + exact artist is now 55 + 35 = 90, and matches on its
 * own. That is the user-facing rule this feature exists to deliver:
 * artist and album title, agreeing exactly, is enough.
 *
 * Everything else is evidence that adjusts around that:
 *
 *   type      an Album is not a Single. MB's primary and secondary
 *             types were already being fetched and stored and never
 *             scored, which is how a 10-track local album could match
 *             a live record or a compilation of the same name.
 *   year      a bonus, NEVER a penalty. A reissue is tagged with its
 *             reissue year by definition, so punishing a year mismatch
 *             would re-break the exact case this release fixes.
 *   tracks    a small nudge. The doc comment here has claimed a track
 *             count bonus since v30.19 and the code never had one.
 *
 * ctx (all optional):
 *   artistConfirmed  the candidate came from a browse of this artist's
 *                    own discography by MBID, so the artist axis is not
 *                    a guess and is not scored as a string
 *   trackCount       local track count, for the track-count nudge
 */
function scoreCandidate(album, candidate, ctx = {}) {
  let score = 0;

  // Strip edition noise from BOTH sides before comparing. The candidate
  // is normally canonical ("Moon Safari") and the local title is not
  // ("Moon Safari (Deluxe Edition)"); without this the edit distance
  // between them is enormous and the right answer scores zero.
  const albumTitleClean = cleanAlbumTitle(album.title || '').cleaned;
  const albumArtistClean = cleanArtistName(album.album_artist || '').cleaned;
  const albumTitleN = normalise(albumTitleClean);
  const albumArtistN = normalise(albumArtistClean);
  const candTitleN = normalise(cleanAlbumTitle(candidate.title || '').cleaned);
  const candArtistName = (candidate['artist-credit'] || [])
    .map(ac => ac.name || ac.artist?.name || '')
    .join(' ');
  const candArtistN = normalise(candArtistName);

  // ---- title -------------------------------------------------------
  if (albumTitleN && albumTitleN === candTitleN) {
    score += 55;
  } else {
    // Proportional fuzz: ~10% of the longer side, floor 2, cap 8. A
    // fixed cap punishes long classical titles and is far too generous
    // on three-character ones.
    const longerLen = Math.max(albumTitleN.length, candTitleN.length);
    const fuzzyCap = Math.max(2, Math.min(8, Math.floor(longerLen * 0.10)));
    const dist = editDistance(albumTitleN, candTitleN, fuzzyCap);
    if (dist <= Math.max(2, Math.floor(fuzzyCap * 0.25))) score += 38;
    else if (dist <= Math.floor(fuzzyCap * 0.5))          score += 26;
    else if (dist <= fuzzyCap)                            score += 15;
  }

  // ---- artist ------------------------------------------------------
  if (ctx.artistConfirmed) {
    // Browsed from this artist's own discography by MBID. There is no
    // string comparison worth doing: MusicBrainz says this release
    // group is theirs, which is stronger evidence than any spelling.
    score += 35;
  } else if (albumArtistN && albumArtistN === candArtistN) {
    score += 35;
  } else {
    const longerArtLen = Math.max(albumArtistN.length, candArtistN.length);
    const fuzzyCap = Math.max(2, Math.min(6, Math.floor(longerArtLen * 0.12)));
    const dist = editDistance(albumArtistN, candArtistN, fuzzyCap);
    if (dist <= Math.max(2, Math.floor(fuzzyCap * 0.25))) score += 24;
    else if (dist <= fuzzyCap)                            score += 12;
  }

  // ---- release type ------------------------------------------------
  //
  // Fetched and stored since v30.19, never scored until now. A local
  // album of 8 tracks matching a release group MB calls a Single is
  // almost certainly the wrong group with the right name.
  const primary = (candidate['primary-type'] || '').toLowerCase();
  const secondary = (candidate['secondary-types'] || []).map(s => String(s).toLowerCase());
  const localTracks = Number(ctx.trackCount || album.track_count || 0);

  if (primary === 'album') score += 6;
  else if (primary === 'ep' && localTracks && localTracks <= 8) score += 3;
  else if ((primary === 'single') && localTracks >= 5) score -= 12;
  else if (primary === 'broadcast' || primary === 'other') score -= 4;

  // Secondary types describe a DIFFERENT record that shares a name: the
  // live album, the remix album, the compilation. Penalise unless the
  // local title says the same thing — which it does via the noise we
  // stripped, so check the raw title rather than the cleaned one.
  const rawTitleN = normalise(album.title || '');
  const SECONDARY_HINTS = {
    live: /\blive\b/, compilation: /\b(compilation|greatest|best of|anthology|collection)\b/,
    remix: /\bremix/, soundtrack: /\b(soundtrack|ost|score)\b/, demo: /\bdemos?\b/,
    spokenword: /\bspoken\b/, interview: /\binterview\b/, mixtape: /\bmixtape\b/,
  };
  for (const st of secondary) {
    const hint = SECONDARY_HINTS[st.replace(/[^a-z]/g, '')];
    if (hint && hint.test(rawTitleN)) score += 4;      // agrees — good evidence
    else score -= 10;                                  // a different record
  }

  // ---- year --------------------------------------------------------
  //
  // A BONUS ONLY. A remaster is tagged with the remaster's year and its
  // release group's first-release-date is the original's, so a mismatch
  // is the normal state of affairs for exactly the albums this release
  // is trying to fix. Never subtract for it.
  if (album.year && candidate['first-release-date']) {
    const candYear = parseInt(candidate['first-release-date'].slice(0, 4), 10);
    if (candYear && Math.abs(candYear - album.year) <= 1) score += 12;
  }

  // ---- track count -------------------------------------------------
  //
  // Browse responses carry no track count, so this only fires when the
  // caller supplied one. Small on purpose: a deluxe edition legitimately
  // has more tracks than its release group's canonical release.
  if (localTracks && ctx.candidateTrackCount) {
    const diff = Math.abs(localTracks - ctx.candidateTrackCount);
    if (diff === 0) score += 5;
    else if (diff <= 2) score += 2;
  }

  // ---- MB's own relevance -----------------------------------------
  // Only present on search results; browse has no score field.
  if (candidate.score && candidate.score >= 95) score += 8;

  return Math.max(0, Math.min(100, score));
}

/**
 * Match one album to a MusicBrainz RELEASE GROUP.
 *
 * A release group is the album as a concept — "Moon Safari" — and every
 * edition of it (original, deluxe, remaster, the Japanese pressing with
 * the bonus track) hangs off that one group. Matching to the group, not
 * to a specific release, is what makes three copies of one record agree
 * on one MBID, and it is what album version grouping is built on.
 *
 * v1.1.34.0 — the strategy is now artist-first. In order:
 *
 *   0. TAG MBID. The file already carries a MusicBrainz release id.
 *      One lookup converts it to its group. Authoritative, one request.
 *
 *   1. IDENTITY RECOVERY. Work out what this album actually is before
 *      asking anything: the album row's own tags, else the most common
 *      track artist, else the folder name. A library whose album_artist
 *      column is empty is not unmatchable — it usually has perfectly
 *      good per-track artists, and folders people named by hand.
 *
 *   2. ARTIST -> MBID -> DISCOGRAPHY. Resolve the artist once, then
 *      browse everything they released and score the album against that
 *      closed set. This is the good path: the artist axis stops being a
 *      fuzzy string, it costs fewer requests than the old per-album
 *      searches, and a title too mangled for any query to hit can still
 *      be recognised because we are no longer asking MB to find it.
 *
 *   3. SEARCH FALLBACK. The old title+artist queries, for artists MB
 *      could not resolve and discographies too large to browse.
 *
 * Returns the result object; the caller persists it.
 */
async function matchOneAlbum(album, userAgent) {
  const dbh = (() => { try { return db.get(); } catch (e) { return null; } })();

  // ---- 0. the album's own tags are authoritative --------------------
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
          diagnostic: { path: 'tag-mbid' },
        };
      }
    } catch {
      // A wrong or withdrawn release id must not mark the album errored
      // — fall through and match it the normal way.
    }
  }

  // ---- 1. what is this album, really? -------------------------------
  const id = identity.effectiveIdentity(album, dbh);
  if (id.unusable) {
    return {
      status: 'unmatched', confidence: null, mbid: null, candidates: [],
      diagnostic: {
        reason: 'no-usable-title-or-artist',
        titleSource: id.source.title, artistSource: id.source.artist,
        titleStripped: id.titleStripped, artistStripped: id.artistStripped,
      },
    };
  }

  // Scoring reads album.title / album.album_artist, so hand it the
  // RECOVERED identity rather than the raw row — otherwise everything
  // recovered from tracks or the folder is thrown away at scoring time.
  const scored_album = {
    ...album,
    title: id.title,
    album_artist: id.artist,
    year: id.year,
  };

  const titleClean = id.cleanTitle.replace(/["\\]/g, ' ').trim();
  const artistClean = id.cleanArtist.replace(/["\\]/g, ' ').trim();
  const diagnostic = {
    titleUsed: titleClean, artistUsed: artistClean,
    titleSource: id.source.title, artistSource: id.source.artist,
    titleStripped: id.titleStripped, artistStripped: id.artistStripped,
  };

  // ---- 2. artist -> MBID -> their actual discography ----------------
  let discographyScored = null;
  if (dbh) {
    const ctx = { mbRequest, userAgent, dbh };
    let arid = null;
    try {
      arid = await mbArtist.resolveArtistMbid(id.artist, ctx);
    } catch (e) {
      // Treated as "no MBID", not as a failed match — the search
      // fallback below still runs.
    }
    if (arid) {
      diagnostic.artistMbid = arid;
      let disco = { groups: [], complete: false };
      try {
        disco = await mbArtist.getDiscography(arid, ctx);
      } catch (e) {
        diagnostic.discographyError = e.message;
      }
      if (disco.groups.length > 0) {
        diagnostic.discographySize = disco.groups.length;
        diagnostic.discographyComplete = disco.complete;
        const ranked = disco.groups
          .map(g => ({ candidate: g, score: scoreCandidate(scored_album, g, {
            artistConfirmed: true,
            trackCount: album.track_count,
          }) }))
          .sort((a, b) => b.score - a.score);
        discographyScored = ranked;
      }
    }
  }

  // A confident hit inside the artist's own catalogue is the best
  // answer available and costs no further requests.
  if (discographyScored && discographyScored.length > 0) {
    const decided = decideMatch(discographyScored, { fromDiscography: true });
    if (decided.status === 'matched') {
      return { ...decided, diagnostic: { ...diagnostic, path: 'discography' } };
    }
    // Not confident enough. Keep these candidates as a floor — the
    // search below may do better, and if it does not, these are still
    // the most relevant things to show on the triage page.
  }

  // ---- 3. search fallback -------------------------------------------
  const attempts = [];
  if (album.barcode) {
    const bc = String(album.barcode).replace(/["\\]/g, ' ').trim();
    if (bc) attempts.push(`releasegroup:"${titleClean}" AND artist:"${artistClean}" AND barcode:"${bc}"`);
  }
  if (album.catalog_number) {
    const cn = String(album.catalog_number).replace(/["\\]/g, ' ').trim();
    if (cn) attempts.push(`releasegroup:"${titleClean}" AND artist:"${artistClean}" AND catno:"${cn}"`);
  }
  // Title + artist, the query the whole feature rests on.
  attempts.push(`releasegroup:"${titleClean}" AND artist:"${artistClean}"`);
  // v1.1.34.0 — the year-qualified query was FIRST here and is now gone
  // from the ordering entirely. It cannot help: a release group's
  // firstreleasedate is the ORIGINAL release, and any album whose tags
  // carry a reissue year (which is every remaster and every deluxe
  // edition) simply misses. It cost a request per album to return
  // nothing for exactly the albums that were failing.
  const rawTitle = (album.title || '').replace(/["\\]/g, ' ').trim();
  const rawArtist = (album.album_artist || '').replace(/["\\]/g, ' ').trim();
  if ((id.titleStripped.length || id.artistStripped.length) && rawTitle && rawArtist) {
    // Some editions really are their own release group at MB, with the
    // qualifier in the canonical title. Try the untouched strings too.
    attempts.push(`releasegroup:"${rawTitle}" AND artist:"${rawArtist}"`);
  }
  // Last resort: everything by this artist, scored locally. Limit is
  // raised to 25 here — the old code documented 25 and passed 10.
  attempts.push(`artist:"${artistClean}"`);

  let groups = [];
  for (const query of attempts) {
    let data;
    try {
      data = await mbRequest('/release-group/',
        { query, limit: query.startsWith('artist:') ? 25 : 10 }, userAgent);
    } catch (e) {
      // Network failures are recoverable: 'error' rows are retried on
      // the next run rather than being remembered as unmatched.
      return { status: 'error', confidence: null, mbid: null, candidates: [], error: e.message };
    }
    const fetched = data['release-groups'] || [];
    if (fetched.length > 0) {
      groups = fetched;
      diagnostic.queryUsed = query;
      break;
    }
  }

  const searchScored = groups.map(g => ({
    candidate: g,
    score: scoreCandidate(scored_album, g, { trackCount: album.track_count }),
  }));

  // Merge with anything the discography pass found, de-duplicated by
  // MBID, keeping the higher score for a group both passes saw.
  const byId = new Map();
  for (const s of [...(discographyScored || []), ...searchScored]) {
    const prev = byId.get(s.candidate.id);
    if (!prev || s.score > prev.score) byId.set(s.candidate.id, s);
  }
  const all = [...byId.values()].sort((a, b) => b.score - a.score);

  if (all.length === 0) {
    return { status: 'unmatched', confidence: 0, mbid: null, candidates: [], diagnostic };
  }
  const decided = decideMatch(all, { fromDiscography: false });
  return { ...decided, diagnostic: { ...diagnostic, path: decided.path || 'search' } };
}

/**
 * Turn a ranked candidate list into a status.
 *
 * v1.1.34.0 — the runner-up guard used to be unconditional: a match
 * needed to beat its nearest rival by more than 15 points, whatever its
 * own score. That reads sensibly and behaves badly. "Moon Safari" the
 * studio album scores 100 and "Moon Safari" the live album scores 86,
 * because they share a title and an artist and differ only in MB's
 * secondary type — so a DECISIVE top answer was sent to triage on
 * account of a rival it had already beaten by every measure that
 * matters. A very strong top score is itself the evidence; it does not
 * also need a gap.
 *
 * opts.fromDiscography relaxes the bar, and deliberately. Those
 * candidates came from browsing this artist's own catalogue by MBID, so
 * the artist is not in question and the only open question is which of
 * their records this is — a far smaller question than "which of the
 * millions of release groups is this", and one where a clear leader is
 * worth trusting at a lower score.
 */
function decideMatch(ranked, opts = {}) {
  const top = ranked[0];
  const second = ranked[1];

  const trimmed = ranked.slice(0, MAX_CANDIDATES_STORED).map(s => ({
    mbid: s.candidate.id,
    title: s.candidate.title,
    artist: (s.candidate['artist-credit'] || [])
      .map(ac => ac.name || ac.artist?.name || '')
      .join(' ').trim() || '(unknown)',
    primaryType: s.candidate['primary-type'] || null,
    secondaryTypes: s.candidate['secondary-types'] || [],
    firstReleaseDate: s.candidate['first-release-date'] || null,
    disambiguation: s.candidate.disambiguation || null,
    score: s.score,
    mbScore: s.candidate.score || null,
  }));

  const decisive = top.score >= 95;
  const clear = !second || second.score < top.score - 15;
  // Inside one artist's catalogue: a clear leader at 75 is trustworthy.
  const discoClear = opts.fromDiscography
    && top.score >= 75
    && (!second || second.score < top.score - 20);

  if ((top.score >= 85 && (decisive || clear)) || discoClear) {
    return { status: 'matched', confidence: top.score, mbid: top.candidate.id, candidates: trimmed };
  }
  if (top.score >= 60) {
    return { status: 'uncertain', confidence: top.score, mbid: null, candidates: trimmed };
  }
  return { status: 'unmatched', confidence: top.score, mbid: null, candidates: trimmed };
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

  // v1.1.34.0 — drop the artist MBID / discography caches at the start
  // of every run. They are per-run by design: MusicBrainz gains artists
  // and release groups between runs, and a user pressing "rematch"
  // after fixing their tags expects a fresh answer rather than this
  // process's memory of the last one.
  mbArtist.resetCaches();

  console.log(`[match] Starting MusicBrainz matcher for ${_progress.total} albums`);

  // Pick one pending album, process it, repeat. We re-query each
  // iteration rather than fetching the full list once because the
  // user might add new albums (via library scan) while the matcher
  // runs — those will be picked up automatically.
  const pickStmt = database.prepare(`
    -- v1.1.34.0 — album_folder joins the selection because identity
    -- recovery reads it: a folder called "Air - Moon Safari (1998)" is
    -- very often better metadata than the tags, and is the whole
    -- fallback for albums whose album_artist column is empty.
    SELECT id, title, album_artist, year, track_count, album_folder,
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
      // v1.1.34.0 — an album that just gained a release-group MBID moves
      // from a title-based version key to a release-group one, and has
      // to land in the same group as its siblings. Rebuilding here is
      // what makes "run the matcher" and "my three copies of Moon Safari
      // finally collapse into one tile" the same action.
      try {
        const rebuilt = require('./albumVersions').rebuildVersionKeys();
        if (rebuilt.changed > 0 && global.broadcastState) {
          global.broadcastState('library_updated', { reason: 'version_keys' });
        }
      } catch (e) {
        console.warn('[match] version key rebuild failed:', e.message);
      }
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
    SELECT id, title, album_artist, match_status, album_folder
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

    // v1.1.34.0 — ask the same question the matcher will actually ask.
    // This used to read the raw columns and count anything with an empty
    // title or album_artist as unmatchable. The matcher now recovers
    // both from the tracks and from the folder name, so counting on the
    // raw columns tells the user a set of albums is hopeless when the
    // next run will match them.
    const id = identity.effectiveIdentity(row, database);
    if (id.unusable) {
      missingTitleOrArtist += 1;
      continue;
    }
    const recovered = id.source.title !== 'tag' || id.source.artist !== 'tag';
    const changed = id.titleStripped.length > 0 || id.artistStripped.length > 0 || recovered;
    if (changed) {
      wouldChangeQuery += 1;
      if (samples.length < sampleLimit) {
        samples.push({
          id: row.id,
          title: row.title,
          album_artist: row.album_artist,
          cleanedTitle: id.cleanTitle,
          cleanedArtist: id.cleanArtist,
          titleStripped: id.titleStripped,
          artistStripped: id.artistStripped,
          // Where each field came from: 'tag' | 'tracks' | 'folder'.
          // A user looking at a surprising match can see the matcher was
          // working from a folder name rather than from their tags.
          titleSource: id.source.title,
          artistSource: id.source.artist,
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
  // v1.1.34.0 — exported for test/album-matching.test.js. The scoring
  // arithmetic and the match/uncertain decision are the two things this
  // release changed and the two things most worth pinning: the old
  // weights could not match an album whose title and artist were both
  // exactly right, and nothing in the suite noticed.
  scoreCandidate,
  decideMatch,
};
