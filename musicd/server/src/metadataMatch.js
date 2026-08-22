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
// v1.1.38.0 — every MusicBrainz call in the server now goes through one
// client. See src/mbHttp.js: it owns the single throttle, the single
// User-Agent (built from the user's contact, which MB's terms require)
// and 503 / Retry-After backoff, which this module did not have. Before
// this release there were THREE independent 1-req/sec pacers pointed at
// a service that allows one request per second in total, and two of
// them sent a User-Agent with no contact in it.
const mbHttp = require('./mbHttp');
const settings = require('./settings');
// v1.1.38.0 — the ListenBrainz mapper. See the block in matchOneAlbum for
// why it sits ahead of every MusicBrainz path.
const listenBrainz = require('./listenBrainz');
// v1.1.38.0 — AcoustID, as the last stage of the automatic matcher.
// Before this release it was reachable only from a manual button.
const fingerprintMatch = require('./fingerprintMatch');
// v1.1.38.0 — Qobuz and Tidal as a barcode oracle. See the block in
// matchOneAlbum for why an exact identifier beats a fuzzy search.
const streamingBarcode = require('./streamingBarcode');

const MAX_CANDIDATES_STORED = 5;

// The score at which a candidate is good enough on its own — no runner-up
// gap required, and no further query worth spending. Named here because
// v1.1.38.0 made the search fallback stop early on a decisive answer, and
// two places deciding separately what "decisive" means is how the matched
// threshold and the scoring weights drifted apart in the first place.
const DECISIVE_SCORE = 95;
// The floor for a match that DOES need to have beaten its nearest rival.
const MATCH_SCORE = 85;
// Below this an album is unmatched rather than uncertain: not worth a
// human's time on the triage page.
const UNCERTAIN_SCORE = 60;
// How much the ListenBrainz mapper has to agree with itself before we
// take its answer without asking MusicBrainz anything else. Two sampled
// tracks landing on the same release is the bar; one track alone is not,
// because a single-track vote on a song that appears on twelve
// compilations tells you nothing about which record this is.
const LB_MIN_CONFIDENCE = 65;

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

/**
 * Throttled, retrying request to the MusicBrainz API.
 *
 * v1.1.38.0 — this used to be forty lines of axios plus its own call to
 * mbThrottle. It is now a thin adapter over src/mbHttp.js, kept only
 * because mbArtist.js is handed an `mbRequest(path, params, userAgent)`
 * callable in its ctx and that signature is worth preserving: it is what
 * lets mbArtist be tested without a network and without knowing where
 * the contact string came from.
 *
 * The behaviour that changed underneath it is the part that matters. A
 * 503 from MusicBrainz means "you are going too fast, come back in
 * Retry-After seconds", and this module used to treat it as a hard
 * failure — which marked the album errored and, because of the loop bug
 * fixed in this same release, immediately retried the same album. mbHttp
 * now honours Retry-After and backs off three times before giving up.
 */
async function mbRequest(path, params, userAgent) {
  return mbHttp.request(path, params, { userAgent });
}

// Re-exported so the shape of this module does not change for callers
// that build a User-Agent for a one-off request.
const buildUserAgent = mbHttp.buildUserAgent;

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
  // live album, the remix album, the compilation.
  //
  // v1.1.38.0 — THE PENALTY IS NOW ASYMMETRIC, and that is a fix.
  //
  // It used to be a flat −10 for every secondary type the local raw
  // title did not echo. That is right for "Moon Safari (Live)" against
  // the studio album. It is wrong for Trainspotting, Purple Rain, The
  // Harder They Come — soundtracks whose titles contain no word
  // resembling "soundtrack", and compilations named after the band
  // rather than described as one. Exact title plus exact artist is 90;
  // one unearned −10 takes it to 80, under the 85 bar, and a correct
  // answer lands in triage.
  //
  // Absence of evidence is not evidence. So agreement still pays (+4),
  // but a penalty now needs positive local evidence AGAINST the type:
  //
  //   album_type   the scanner computes this per album. When it says
  //                this is a studio album and MB says compilation, the
  //                two genuinely disagree and the penalty is earned.
  //   track count  a compilation or anthology of the same name is
  //                normally much longer than the studio record. A local
  //                album of 10 tracks against MB's 2-CD "collection" is
  //                real evidence; a local album of 40 is not.
  //
  // With neither signal available we take a small −3 rather than −10:
  // enough to break a tie against a plain studio release group, not
  // enough on its own to push an otherwise perfect match into triage.
  const rawTitleN = normalise(album.title || '');
  const SECONDARY_HINTS = {
    live: /\blive\b/, compilation: /\b(compilation|greatest|best of|anthology|collection)\b/,
    remix: /\bremix/, soundtrack: /\b(soundtrack|ost|score)\b/, demo: /\bdemos?\b/,
    spokenword: /\bspoken\b/, interview: /\binterview\b/, mixtape: /\bmixtape\b/,
  };
  // 'album' here is the scanner's own classification of the local rows.
  // Anything else (or nothing at all) means we have no opinion, not that
  // we disagree.
  const localType = String(album.album_type || '').toLowerCase();
  const localSaysStudio = localType === 'album' || localType === 'studio';
  for (const st of secondary) {
    const key = st.replace(/[^a-z]/g, '');
    const hint = SECONDARY_HINTS[key];
    if (hint && hint.test(rawTitleN)) {
      score += 4;                                      // agrees — good evidence
      continue;
    }
    // A gathering of other people's records is normally longer than the
    // studio album it shares a name with. 18 is deliberately generous:
    // plenty of legitimate single-disc compilations sit at 14 or 16.
    const gathering = key === 'compilation' || key === 'live' || key === 'mixtape';
    const shortForAGathering = gathering && localTracks > 0 && localTracks <= 18;
    if (localSaysStudio || shortForAGathering) score -= 10;   // genuinely disagrees
    else score -= 3;                                          // no opinion either way
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
 * Re-score the top two candidates with real track counts from
 * MusicBrainz, and return the list re-sorted.
 *
 * One `/release-group/<id>?inc=releases` per candidate. A release group
 * holds several releases and they disagree — the point of a deluxe
 * edition is that it has more tracks — so we take the release whose
 * count is CLOSEST to the local album's rather than the first or the
 * mean. Taking the first would systematically favour whichever pressing
 * MusicBrainz happens to list first, which is not evidence about
 * anything.
 *
 * Failure here is not failure of the match: on a network error the
 * candidate keeps the score it already had and the caller decides on the
 * evidence it already has.
 */
async function refineWithTrackCounts(ranked, scored_album, userAgent, diagnostic) {
  const out = ranked.slice();
  const localTracks = Number(scored_album.track_count) || 0;
  for (let i = 0; i < Math.min(2, out.length); i++) {
    const entry = out[i];
    let data;
    try {
      data = await mbRequest(`/release-group/${entry.candidate.id}`, { inc: 'releases' }, userAgent);
    } catch (e) {
      // Keep the unrefined score. A tie-break we could not afford is a
      // tie-break we do without.
      diagnostic.trackCountError = e.message;
      continue;
    }
    let best = null;
    for (const rel of (data.releases || [])) {
      const n = Number(rel['track-count'] || 0);
      if (!n) continue;
      if (best === null || Math.abs(n - localTracks) < Math.abs(best - localTracks)) best = n;
    }
    if (best === null) continue;
    out[i] = {
      candidate: entry.candidate,
      score: scoreCandidate(scored_album, entry.candidate, {
        trackCount: localTracks,
        candidateTrackCount: best,
      }),
    };
  }
  diagnostic.trackCountRefined = true;
  return out.sort((a, b) => b.score - a.score);
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

  // ---- 1b. the ListenBrainz mapper ----------------------------------
  //
  // v1.1.38.0, and the reason a full matcher run stopped taking an hour.
  //
  // ListenBrainz runs MusicBrainz's own fuzzy matcher — a Typesense index
  // over artist credit, recording and release names — as a public
  // endpoint. Two things make it worth putting ahead of everything else
  // here. It answers on TRACK titles, so an album whose own title is
  // mangled past the point where any release-group query would hit can
  // still be identified from the names of the songs on it. And it takes
  // fifty lookups per POST at fifty requests per ten seconds, against
  // MusicBrainz's one request per second — so the sampled tracks of an
  // album cost a fraction of a request where the search fallback costs
  // up to four whole ones.
  //
  // It hands back a RELEASE mbid, and this matcher deals in release
  // GROUPS, so a confident answer still costs one MusicBrainz lookup to
  // convert. That is one request against the four-plus below it, and it
  // is authoritative rather than fuzzy.
  //
  // Opt-in twice over: the endpoint needs a free account token (it was
  // closed to anonymous callers over AI scraping), and the setting can
  // be turned off independently. With no token this whole block is
  // skipped and the matcher behaves exactly as it did before.
  if (dbh && listenBrainz.isConfigured() && settings.getBool('matcher_use_listenbrainz', true)) {
    let trackTitles = [];
    try {
      trackTitles = dbh.prepare(`
        SELECT title FROM tracks
        WHERE album_id = ? AND title IS NOT NULL AND TRIM(title) != ''
        ORDER BY disc_number, track_number
      `).all(album.id).map(r => r.title);
    } catch (e) {
      // No tracks table, or an album row with no tracks (a streaming
      // placeholder). Not fatal — the mapper simply has nothing to send
      // and the paths below still run.
    }
    if (trackTitles.length > 0) {
      let lb = null;
      try {
        lb = await listenBrainz.lookupAlbum({ title: id.title, artist: id.artist, trackTitles });
      } catch (e) {
        // ListenBrainz being down or rate-limiting is not a failed match.
        // Fall through to the MusicBrainz paths, which is what this
        // matcher did for every album before this release.
        diagnostic.listenBrainzError = e.message;
      }
      if (lb && lb.releaseMbid) {
        diagnostic.listenBrainz = {
          releaseMbid: lb.releaseMbid, agree: lb.agree,
          sampled: lb.sampled, confidence: lb.confidence,
        };
        if (lb.confidence >= LB_MIN_CONFIDENCE) {
          let rgId = null;
          try {
            rgId = await listenBrainz.releaseGroupFor(lb.releaseMbid, { userAgent });
          } catch (e) {
            diagnostic.listenBrainzRgError = e.message;
          }
          if (rgId) {
            return {
              status: 'matched',
              confidence: lb.confidence,
              mbid: rgId,
              artistMbids: lb.artistMbids || [],
              candidates: [{
                mbid: rgId,
                title: lb.releaseName || id.title,
                artist: lb.artistCreditName || id.artist,
                score: lb.confidence,
                source: 'listenbrainz',
              }],
              diagnostic: { ...diagnostic, path: 'listenbrainz' },
            };
          }
        }
      }
    }
  }

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

  // ---- 2b. borrow a barcode from Qobuz or Tidal ---------------------
  //
  // v1.1.38.0. The barcode-qualified query below is the best one in this
  // function — a barcode is an exact identifier, so MusicBrainz either
  // knows it or does not, with no fuzz in between — and it has almost
  // never run, because `albums.barcode` is almost always null. Rippers
  // do not write a UPC.
  //
  // The user is logged into Qobuz and/or Tidal, this server already
  // holds authenticated clients for both, and their album responses
  // carry the UPC. So before falling back to fuzzy text search, ask a
  // catalogue we are already paying for. src/streamingBarcode.js does
  // the asking and refuses to guess: title and artist must agree exactly
  // after the same normalisation the matcher itself uses, and the track
  // count must agree too when both sides have one.
  //
  // Persisted on the album row, so it is spent once per album rather
  // than once per matcher run — and so a later manual re-match gets it
  // for free.
  let borrowedBarcode = null;
  if (!album.barcode && streamingBarcode.isAvailable()) {
    try {
      const found = await streamingBarcode.findBarcode({
        title: id.title, artist: id.artist, trackCount: album.track_count,
      });
      if (found) {
        borrowedBarcode = found.barcode;
        diagnostic.barcodeFrom = found.service;
        diagnostic.barcode = found.barcode;
        if (dbh) {
          try {
            dbh.prepare('UPDATE albums SET barcode = COALESCE(barcode, ?) WHERE id = ?')
              .run(found.barcode, album.id);
          } catch (e) {
            // Storing it is an optimisation for next time; the query
            // below uses the value we already hold either way.
            diagnostic.barcodeStoreError = e.message;
          }
        }
      }
    } catch (e) {
      // findBarcode is documented never to throw, but a matcher run must
      // not depend on that promise being kept.
      diagnostic.barcodeError = e.message;
    }
  }

  // ---- 3. search fallback -------------------------------------------
  const attempts = [];
  const knownBarcode = album.barcode || borrowedBarcode;
  if (knownBarcode) {
    const bc = String(knownBarcode).replace(/["\\]/g, ' ').trim();
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

  // v1.1.38.0 — THE LOOP USED TO STOP AT THE FIRST ANSWER, NOT THE BEST.
  //
  // It was `if (fetched.length > 0) { groups = fetched; break; }`. But
  // MusicBrainz's Lucene search is fuzzy and frequently returns a
  // low-relevance hit rather than nothing at all, so one piece of junk
  // from the title+artist query stopped the raw-strings query and the
  // artist-only sweep from ever running — and the artist-only sweep is
  // there specifically to catch titles too mangled for any title query
  // to hit. The attempts were ordered best-first and then the ordering
  // was used as a reason not to ask the later ones.
  //
  // Now every attempt is scored and the best candidate across all of
  // them wins. The early exit is kept, but it is now conditional on the
  // ANSWER rather than on there being one: once a candidate clears the
  // decisive bar there is nothing a further query could add, so we stop
  // and save the request. On the albums that were already failing this
  // costs at most three more requests, and those are precisely the
  // albums worth spending requests on.
  const searchScored = [];
  const queriesUsed = [];
  for (const query of attempts) {
    let data;
    try {
      data = await mbRequest('/release-group/',
        { query, limit: query.startsWith('artist:') ? 25 : 10 }, userAgent);
    } catch (e) {
      // Network failures are recoverable: 'error' rows are retried on
      // the next run rather than being remembered as unmatched. But if
      // an earlier attempt already produced candidates, keep them —
      // throwing away good evidence because a later, broader query
      // timed out is worse than answering from what we have.
      if (searchScored.length === 0) {
        return { status: 'error', confidence: null, mbid: null, candidates: [], error: e.message };
      }
      diagnostic.searchError = e.message;
      break;
    }
    const fetched = data['release-groups'] || [];
    if (fetched.length === 0) continue;
    queriesUsed.push(query);
    let best = 0;
    for (const g of fetched) {
      const score = scoreCandidate(scored_album, g, { trackCount: album.track_count });
      searchScored.push({ candidate: g, score });
      if (score > best) best = score;
    }
    if (best >= DECISIVE_SCORE) break;
  }
  if (queriesUsed.length > 0) diagnostic.queriesUsed = queriesUsed;

  // Merge with anything the discography pass found, de-duplicated by
  // MBID, keeping the higher score for a group both passes saw.
  const byId = new Map();
  for (const s of [...(discographyScored || []), ...searchScored]) {
    const prev = byId.get(s.candidate.id);
    if (!prev || s.score > prev.score) byId.set(s.candidate.id, s);
  }
  const all = [...byId.values()].sort((a, b) => b.score - a.score);

  // v1.1.38.0 — the track-count tie-break, which finally fires.
  //
  // scoreCandidate has read `ctx.candidateTrackCount` since v1.1.34.0 and
  // NOTHING has ever written it: neither caller passed one, and neither
  // could, because browse responses and search results both omit track
  // counts. So the block was dead. (Its own predecessor was a doc comment
  // claiming a bonus the code did not have, noted and half-fixed in
  // v1.1.34.0 — this is the second time this particular nudge has been
  // described but not delivered.)
  //
  // Earning it costs a request, so it is spent only where it can change
  // the answer: two candidates within ten points of each other, with the
  // leader short of the match bar. That is the studio-album-against-
  // deluxe-edition case and very little else, and it is exactly the case
  // a track count settles. Everywhere else the ranking is already
  // decided and the request would buy nothing.
  let refined = all;
  if (all.length >= 2 && all[0].score < MATCH_SCORE && all[0].score - all[1].score <= 10
      && Number(album.track_count) > 0) {
    refined = await refineWithTrackCounts(all, scored_album, userAgent, diagnostic);
  }

  const decided = refined.length === 0
    ? { status: 'unmatched', confidence: 0, mbid: null, candidates: [] }
    : decideMatch(refined, { fromDiscography: false });
  if (decided.status === 'matched') {
    return { ...decided, diagnostic: { ...diagnostic, path: decided.path || 'search' } };
  }

  // ---- 4. fingerprint the residue -----------------------------------
  //
  // v1.1.38.0. src/fingerprintMatch.js has been 294 lines of working
  // AcoustID integration reachable from exactly one place: a manual
  // button on the Unmatched page. The automatic matcher never called it.
  //
  // It is the only source in this system that works when the tags are
  // worthless, which is the problem the whole matching feature exists to
  // solve, and it was sitting unused while albums with unreadable
  // metadata went to triage by the hundred.
  //
  // It goes LAST because it is the expensive one, and expensive in a
  // different currency from everything above: fpcalc decodes real audio,
  // so this costs CPU and disk on a machine whose scheduler already
  // backs off at 59 °C, rather than costing MusicBrainz quota. By the
  // time an album reaches here it has survived identity recovery, the
  // ListenBrainz mapper, an artist-MBID discography browse and up to
  // four search queries — so the set is small, and every album in it is
  // one nothing else could name.
  //
  // Its recording MBIDs are kept whatever the outcome: they are what the
  // works layer needs, and an album we could not place still has tracks
  // AcoustID recognised.
  const fpAllowed = settings.getBool('matcher_use_fingerprint', true);
  if (fpAllowed && album.id) {
    let fp = null;
    try {
      fp = await fingerprintMatch.matchAlbumRow(album, {});
    } catch (e) {
      // fpcalc missing from the image, an unreadable file, AcoustID down.
      // None of those are a reason to fail the album — it already has a
      // perfectly good 'unmatched' or 'uncertain' answer from the text
      // paths above, and this was the long shot.
      diagnostic.fingerprintError = e.message;
    }
    if (fp && Array.isArray(fp.candidates) && fp.candidates.length > 0) {
      diagnostic.fingerprint = { candidates: fp.candidates.length, reason: fp.reason || null };
      const top = fp.candidates[0];
      // AcoustID's own agreement across several tracks of one album is
      // strong evidence — it is derived from the audio, not from a
      // string somebody typed — so it is allowed to convert an album the
      // text paths could not place. The bar is its own score, which
      // already folds in how many sampled tracks agreed.
      if (top.score >= MATCH_SCORE) {
        return {
          status: 'matched',
          confidence: top.score,
          mbid: top.mbid,
          recordingMbids: fp.recordingMbids || [],
          recordingsByPath: fp.recordingsByPath || {},
          candidates: fp.candidates.slice(0, MAX_CANDIDATES_STORED),
          diagnostic: { ...diagnostic, path: 'acoustid' },
        };
      }
      // Not confident enough to take, but far better triage material
      // than nothing: show the user what the audio suggests.
      const merged = [...(decided.candidates || []), ...fp.candidates]
        .slice(0, MAX_CANDIDATES_STORED);
      return {
        ...decided,
        status: decided.status === 'unmatched' && top.score >= UNCERTAIN_SCORE
          ? 'uncertain' : decided.status,
        confidence: Math.max(decided.confidence || 0, top.score),
        recordingMbids: fp.recordingMbids || [],
          recordingsByPath: fp.recordingsByPath || {},
        candidates: merged,
        diagnostic: { ...diagnostic, path: 'acoustid-triage' },
      };
    }
    if (fp && Array.isArray(fp.recordingMbids) && fp.recordingMbids.length > 0) {
      // No release group agreed on, but AcoustID did recognise the audio.
      // The recording MBIDs are still worth keeping for the works layer.
      return { ...decided, recordingMbids: fp.recordingMbids,
        recordingsByPath: fp.recordingsByPath || {},
        diagnostic: { ...diagnostic, path: decided.path || 'search' } };
    }
  }

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

  const decisive = top.score >= DECISIVE_SCORE;
  const clear = !second || second.score < top.score - 15;
  // Inside one artist's catalogue: a clear leader at 75 is trustworthy.
  const discoClear = opts.fromDiscography
    && top.score >= 75
    && (!second || second.score < top.score - 20);

  if ((top.score >= MATCH_SCORE && (decisive || clear)) || discoClear) {
    return { status: 'matched', confidence: top.score, mbid: top.candidate.id, candidates: trimmed };
  }
  if (top.score >= UNCERTAIN_SCORE) {
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
  //
  // v1.1.38.0 — THIS LOOP COULD RUN FOREVER ON ONE ALBUM, and fixing
  // that is the most important change in this release.
  //
  // The pick has always been `WHERE match_status IS NULL OR IN
  // ('pending', 'error') ORDER BY id LIMIT 1`. When an album fails, the
  // body writes match_status = 'error' and picks again — and 'error' is
  // still in that WHERE clause, so the very same row comes back. The
  // comment on the write says it persists the status "so the loop
  // doesn't get stuck on the same album forever"; persisting a status
  // that the query still selects does not remove the row from the query.
  //
  // In the healthy case this is invisible: a one-off timeout errors an
  // album, the album is re-picked, and the retry succeeds. The failure
  // mode is when MusicBrainz is down or rate-limiting — then EVERY album
  // errors, so the run consists of album #1, forever, firing up to five
  // requests a go at a service that is already asking us to slow down,
  // until the scheduler's one-hour job cap fires. _progress.processed
  // climbs past _progress.total while it happens, which is why the UI
  // has been seen showing counts like 4,312 / 2,000.
  //
  // The fix is an in-run set of album ids already attempted. It is
  // per-run and in-memory on purpose: 'error' still means "retry me on
  // the next run", which is the behaviour the daily stale-requeue and
  // the Rematch button both rely on. What it must not mean is "retry me
  // immediately, in this run, having just failed".
  //
  // Paging, rather than LIMIT 1, because a set-membership test cannot be
  // pushed into the SQL without binding a list that grows to the size of
  // the library. We take a page, walk it for the first id we have not
  // tried, and move the cursor on. albums.id is TEXT (a content hash),
  // so ORDER BY id is a stable arbitrary order rather than insertion
  // order — fine for a full sweep, but it does mean an album added
  // mid-run can sort BEHIND the cursor. Hence the single wrap at the
  // end: when the cursor runs out we go back to the start once and pick
  // up anything that appeared behind us. The attempted set is what makes
  // that wrap safe, and what guarantees the loop terminates.
  const PICK_PAGE = 50;
  const pickStmt = database.prepare(`
    -- v1.1.34.0 — album_folder joins the selection because identity
    -- recovery reads it: a folder called "Air - Moon Safari (1998)" is
    -- very often better metadata than the tags, and is the whole
    -- fallback for albums whose album_artist column is empty.
    SELECT id, title, album_artist, year, track_count, album_folder,
           album_type, barcode, catalog_number, mb_release_id, mb_release_group_id
    FROM albums
    WHERE excluded = 0 AND (match_status IS NULL OR match_status IN ('pending', 'error'))
      AND id > ?
    ORDER BY id
    LIMIT ${PICK_PAGE}
  `);

  const attempted = new Set();
  let cursor = '';
  let wrapped = false;

  // Returns the next album this run has not already tried, or null when
  // there is genuinely nothing left. Never returns the same id twice.
  function nextAlbum() {
    for (;;) {
      const page = pickStmt.all(cursor);
      if (page.length === 0) {
        if (wrapped) return null;
        // One wrap, to catch rows that sorted behind the cursor because
        // they were inserted during this run.
        wrapped = true;
        cursor = '';
        continue;
      }
      for (const row of page) {
        if (!attempted.has(row.id)) {
          // The cursor advances to the row we are RETURNING, not to the
          // end of the page. Advancing to the end would step over the
          // rows after it that we have not consumed yet, and they would
          // be seen again only on the final wrap — which, being a single
          // wrap, does not get around to all of them. A first cut of
          // this did exactly that and silently skipped two albums in
          // seven; the harness in test/album-matching.test.js is there
          // because reading the code did not reveal it.
          cursor = row.id;
          return row;
        }
      }
      // Whole page already tried — step past it and keep paging.
      cursor = page[page.length - 1].id;
    }
  }
  // Prepared lazily and tolerantly: tracks.mb_recording_id arrives with
  // this release's migration, and a matcher started against a database
  // that has not migrated yet should degrade to "no recording MBIDs"
  // rather than throwing on every album.
  let recordingMbidStmt = null;
  try {
    recordingMbidStmt = database.prepare(
      'UPDATE tracks SET mb_recording_id = COALESCE(mb_recording_id, ?) WHERE path = ?'
    );
  } catch (e) {
    console.warn('[match] recording MBIDs will not be stored — no mb_recording_id column yet');
  }

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
    const album = nextAlbum();
    if (!album) {
      console.log('[match] No more pending albums, stopping');
      break;
    }
    // Marked BEFORE the attempt, not after. If matchOneAlbum throws in a
    // way the catch below does not cover — or the process is interrupted
    // between the attempt and the write — the album must still not be
    // handed back to this same run.
    attempted.add(album.id);

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

    // Persist result. Errors are persisted too, but note that since
    // v1.1.38.0 that is no longer what keeps the loop off this album —
    // the in-run `attempted` set is. Writing 'error' means "retry me on
    // the NEXT run", which is what the daily stale-requeue and the
    // Rematch button both act on.
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

    // v1.1.38.0 — keep the recording MBIDs AcoustID recognised, keyed by
    // the file they came from.
    //
    // By path rather than by position, deliberately. fingerprintMatch
    // samples the LONGEST tracks on the album, not the first ones, so
    // the nth MBID in a flat list is not the nth track — writing them
    // positionally would attach the wrong recording to most of them, and
    // a wrong recording MBID propagates straight into the works layer.
    // The path is the only key that cannot be got wrong.
    //
    // This is worth doing even when the album stayed unmatched: the
    // audio was still recognised, and a recording MBID is what the works
    // layer needs. Tags remain the main source (the scanner harvests
    // them at scan time, free) — this fills in for files Picard never
    // touched.
    if (result.recordingsByPath && recordingMbidStmt) {
      for (const [trackPath, recId] of Object.entries(result.recordingsByPath)) {
        if (!recId) continue;
        try {
          recordingMbidStmt.run(recId, trackPath);
        } catch (e) {
          // A track deleted between the scan and now. Losing one
          // recording MBID must not abort the matcher run.
          console.warn(`[match] could not store recording MBID for ${trackPath}: ${e.message}`);
        }
      }
    }

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
