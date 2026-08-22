// src/listenBrainz.js — MusicBrainz's own fuzzy matcher, fifty lookups a request.
// ================================================================================
//
// v1.1.38.0. The matcher's cost has always been the MusicBrainz web
// service's one-request-per-second-per-IP rule. metadataMatch.js spends
// up to five searches on an album it cannot place, mbArtist.js spends an
// artist lookup plus up to two discography browses per artist, and every
// one of those requests waits its turn on mbThrottle. A two thousand
// album library is measured in hours, and nearly all of that time is
// spent asking a Lucene index to guess at strings a ripper mangled.
//
// ListenBrainz runs a DIFFERENT matcher over the same data.
// /1/metadata/lookup/ is the mapper that turns a submitted listen — an
// artist name, a track name, sometimes an album name, all of them as
// typed by whatever player sent them — into MusicBrainz MBIDs. It is a
// Typesense index over artist credit, recording and release names, built
// and maintained by the MusicBrainz project itself, and it is very good
// at exactly the input this server has: tag strings of unknown quality.
//
// Two things make it worth a module of its own.
//
//   1. FIFTY LOOKUPS PER REQUEST. Their MAX_LOOKUPS_PER_POST is 50, and
//      the budget is 50 requests per 10 seconds per token rather than
//      one request per second. Three tracks of an album is ONE request.
//      A hundred albums sampled three tracks deep is six requests and a
//      couple of seconds; the same hundred albums against the web
//      service is three hundred requests and five minutes of throttle.
//
//   2. IT ANSWERS WITH A RELEASE. A hit carries recording_mbid,
//      release_mbid and artist_mbids. releaseGroupFor() below turns the
//      release into its group with a single web-service call, and a
//      release-group MBID is what this whole pipeline exists to find —
//      it is what albums.mb_release_group_id stores, what cover art is
//      fetched by, and what album version grouping keys on.
//
// WHAT IT IS NOT. It is a fuzzy matcher, not an oracle. It answers with
// its best guess and it does not say how sure it is. So this module
// never claims more than it has: lookupAlbum() sends several tracks of
// one album and reports how many of them came back pointing at the same
// release, and the confidence it returns is derived from that agreement
// and from nothing else. One track's guess and three tracks' agreement
// are very different evidence and the caller can tell them apart.
//
// AUTHENTICATION. Both forms of this endpoint used to be open. They are
// not any more — ListenBrainz closed the metadata endpoints to anonymous
// callers after AI scrapers made a mess of them — so every request
// carries `Authorization: Token <token>`, read from the
// `listenbrainz_token` setting. With no token this module is simply
// switched off: isConfigured() answers false, lookupRecordings() returns
// all-nulls without sending anything, and the matcher falls through to
// the web service exactly as it did before. A ListenBrainz account is
// free and the token sits on the user's profile page, but nobody is
// obliged to have one and nothing here breaks without it.
//
// ONE FORM, NOT TWO. ListenBrainz also publishes a GET form of the
// endpoint for a single lookup. It is deliberately not used here. A
// one-item POST costs the same single request against the same budget,
// and the two forms answer in different shapes — the POST with a list
// whose entries carry an `index`, the GET with a bare object — which
// would be a second place for the index rule below to be got wrong.

'use strict';

const axios = require('axios');
const settings = require('./settings');
const identity = require('./albumIdentity');
const serviceHealth = require('./serviceHealth');
const mbHttp = require('./mbHttp');
const log = require('./serviceLog').forModule('listenbrainz');

const LB_BASE = 'https://api.listenbrainz.org/1';
const LOOKUP_PATH = '/metadata/lookup/';

// Both of these are the server's own constants, named the same way they
// are named in the ListenBrainz source so the next person to check them
// against it can grep for the same words.
const MAX_LOOKUPS_PER_POST = 50;
const MAX_MAPPING_QUERY_LENGTH = 250;

// The documented budget is 50 requests per 10 seconds per token, which
// is one request every 200ms spent evenly. That is the floor we pace to
// when the response headers tell us nothing; when they do tell us
// something, _noteRateLimit() below paces off the real numbers instead.
const MIN_GAP_MS = 200;

// Their 429 carries X-RateLimit-Reset-In. This is what we sleep for when
// it does not, and it is one whole window.
const DEFAULT_RESET_IN_S = 10;
const MAX_429_RETRIES = 3;

const REQUEST_TIMEOUT_MS = 15000;

// Tracks sampled per album by lookupAlbum() unless the caller says
// otherwise. Three is the smallest number that can produce a MAJORITY:
// with two, a disagreement is a coin toss and there is nothing to break
// the tie. It is also, conveniently, a sixteenth of one request.
const DEFAULT_SAMPLE = 3;

// A release name shorter than this, after truncation, is noise to a
// fuzzy index rather than a hint. Below it we drop the field entirely.
const MIN_RELEASE_FRAGMENT = 8;

const HEALTH_KEY = 'listenbrainz';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Read fresh on every call rather than cached at module init. The field
// is editable in Settings, and a user who pastes a token mid-scan should
// see the next lookup go out rather than having to restart the server —
// the same rule mbHttp.getContact() follows for the MusicBrainz contact.
function _token() {
  return settings.get('listenbrainz_token', '').trim();
}

/**
 * True when a token is configured. A settings read and nothing else:
 * no network, and no attempt to validate the token itself. Callers use
 * it to decide whether this path is worth trying at all; a token that
 * turns out to be wrong surfaces as an LB_UNAUTHORISED error on the
 * first real lookup, which is the only moment anyone can know.
 */
function isConfigured() {
  return _token() !== '';
}

// ListenBrainz does not demand a contactable User-Agent the way
// MusicBrainz does, but it is the same project and being identifiable
// costs nothing. mbHttp already builds exactly this string from the
// VERSION file, so borrow it rather than growing a second one: with a
// contact configured they get `musicd/<version> ( <contact> )`, without
// one the bare `musicd/<version>`.
function _userAgent() {
  return mbHttp.buildUserAgent(mbHttp.getContact());
}

// ---------------------------------------------------------------------------
// Service health
// ---------------------------------------------------------------------------
//
// serviceHealth keeps a locked-down list of service names and answers an
// unknown one with a console warning, on purpose — that is what stops a
// typo'd recordSuccess() silently inventing a service. 'listenbrainz' is
// new here, and whether it has been added to that list is not this
// module's business to change. So check once: if the key is registered,
// report health normally; if it is not, say so a single time and stay
// quiet afterwards rather than printing a warning per lookup. The moment
// the key is added this starts reporting with no change here.
let _healthRegistered = null;

function _health(ok, error) {
  if (_healthRegistered === null) {
    _healthRegistered = Array.isArray(serviceHealth.SERVICES)
      && serviceHealth.SERVICES.indexOf(HEALTH_KEY) !== -1;
    if (!_healthRegistered) {
      log.warn(
        `serviceHealth has no '${HEALTH_KEY}' entry, so this service will show as `
        + 'grey in Settings → Built-in Services until it is added to SERVICES in '
        + 'serviceHealth.js. Lookups themselves are unaffected.'
      );
    }
  }
  if (!_healthRegistered) return;
  if (ok) serviceHealth.recordSuccess(HEALTH_KEY);
  else serviceHealth.recordFailure(HEALTH_KEY, error || 'unknown error');
}

// ---------------------------------------------------------------------------
// Pacing
// ---------------------------------------------------------------------------

function _sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Header values come back as strings, and axios v1 hands them over on an
// AxiosHeaders instance rather than a plain object. Read it both ways so
// this keeps working whichever shape turns up.
function _headerNumber(headers, name) {
  if (!headers) return NaN;
  let raw = headers[name];
  if ((raw === undefined || raw === null) && typeof headers.get === 'function') {
    raw = headers.get(name);
  }
  if (raw === undefined || raw === null || raw === '') return NaN;
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}

// Requests are serialised through a promise chain and spaced by at least
// MIN_GAP_MS. The chain matters as much as the gap: the budget is per
// TOKEN, not per connection, so a matcher run and a hand-triggered
// rematch spend the same allowance, and without a queue both would look
// at the clock at the same instant and both decide the coast was clear.
let _chain = Promise.resolve();
let _nextAllowedAt = 0;

function _pace() {
  // The body only ever sleeps, so this chain cannot reject and cannot
  // deadlock a later caller.
  const next = _chain.then(async () => {
    const waitMs = _nextAllowedAt - Date.now();
    if (waitMs > 0) await _sleep(waitMs);
    // Provisional. Holds the floor for whoever is behind us in the queue
    // until the response headers arrive and _noteRateLimit() replaces it
    // with what the server actually said.
    _nextAllowedAt = Date.now() + MIN_GAP_MS;
  });
  _chain = next;
  return next;
}

// Pace off the real numbers rather than a guess. Every response carries
//
//   X-RateLimit-Remaining   requests left in the current window
//   X-RateLimit-Reset-In    seconds until that window resets
//
// and the gap that spends exactly the remaining budget over the rest of
// the window is resetIn / (remaining + 1) seconds. The +1 keeps one
// request in hand for whatever else is holding the same token.
//
// With a full budget — 50 left, 10 seconds to go — that arithmetic gives
// 196ms, so the 200ms floor wins and nothing is slowed down. With one
// request left and 8 seconds on the clock it stretches to 4 seconds, and
// the burst that would have earned us a 429 never leaves the process.
// Remaining at zero waits out the whole window.
function _noteRateLimit(headers) {
  const remaining = _headerNumber(headers, 'x-ratelimit-remaining');
  const resetIn = _headerNumber(headers, 'x-ratelimit-reset-in');
  let gap = MIN_GAP_MS;
  if (Number.isFinite(remaining) && Number.isFinite(resetIn)) {
    if (remaining <= 0) {
      gap = Math.max(gap, (resetIn > 0 ? resetIn : DEFAULT_RESET_IN_S) * 1000);
    } else if (resetIn > 0) {
      gap = Math.max(gap, Math.ceil((resetIn * 1000) / (remaining + 1)));
    }
  }
  _nextAllowedAt = Date.now() + gap;
}

// ---------------------------------------------------------------------------
// Query length
// ---------------------------------------------------------------------------
//
// MAX_MAPPING_QUERY_LENGTH is 250 on their side and it applies to the
// COMBINED length of artist_name + recording_name + release_name for ONE
// recording. Go over it and the whole POST is rejected with a 400 — not
// the offending entry, the entire batch. One forty-minute classical track
// title would therefore cost the other 49 lookups in the request, so the
// truncation happens here, defensively, before anything is sent.
//
// What gets sacrificed, in order:
//
//   1. the release name. It is the only optional field of the three: the
//      mapper does its work on artist + recording, and the release name
//      is a tie-breaker between pressings. Truncated to whatever room is
//      left, or dropped outright if that room is smaller than a
//      meaningful fragment.
//   2. the recording name, cut to whatever the artist name left behind.
//      A prefix still matches in a fuzzy index; nothing at all does not.
//   3. the artist name, in the pathological case where it alone is over
//      the cap. Nothing useful will come back from that lookup, but it
//      keeps its slot in the batch so the indices still line up.
//
// Returns null for an entry the mapper cannot use at all (no artist or
// no recording name), which the caller answers with a null match without
// spending a slot on it.
function _fitLookup(item) {
  let artist = String((item && item.artist_name) || '').trim();
  let recording = String((item && item.recording_name) || '').trim();
  let release = String((item && item.release_name) || '').trim();

  if (!artist || !recording) return null;

  const total = () => artist.length + recording.length + release.length;

  if (total() > MAX_MAPPING_QUERY_LENGTH && release) {
    const room = MAX_MAPPING_QUERY_LENGTH - artist.length - recording.length;
    release = room >= MIN_RELEASE_FRAGMENT ? release.slice(0, room).trim() : '';
  }
  if (total() > MAX_MAPPING_QUERY_LENGTH) {
    recording = recording.slice(0, Math.max(0, MAX_MAPPING_QUERY_LENGTH - artist.length)).trim();
  }
  if (total() > MAX_MAPPING_QUERY_LENGTH) {
    artist = artist.slice(0, MAX_MAPPING_QUERY_LENGTH).trim();
    recording = '';
    release = '';
  }

  const body = { artist_name: artist, recording_name: recording };
  // Send release_name only when there is one. An empty string is a real
  // value to a search index and asking it to match "" against every
  // release name it holds is not the same as not asking.
  if (release) body.release_name = release;
  return body;
}

// ---------------------------------------------------------------------------
// The POST
// ---------------------------------------------------------------------------

// Sends one chunk of at most MAX_LOOKUPS_PER_POST bodies and returns the
// raw result list. Throws on anything it cannot recover from; the 429
// retry loop is here because a rate limit is not a failure, it is a
// request to come back.
async function _postLookup(bodies) {
  const token = _token();
  let attempt = 0;

  for (;;) {
    await _pace();
    try {
      const res = await axios.post(
        `${LB_BASE}${LOOKUP_PATH}`,
        { recordings: bodies },
        {
          headers: {
            Authorization: `Token ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': _userAgent(),
          },
          timeout: REQUEST_TIMEOUT_MS,
        }
      );
      _noteRateLimit(res.headers);
      _health(true);
      // A miss is an absent entry, not a null one, so a batch where
      // nothing matched comes back as []. That is a successful request.
      return Array.isArray(res.data) ? res.data : [];
    } catch (e) {
      const status = e.response && e.response.status;

      if (status === 429 && attempt < MAX_429_RETRIES) {
        attempt += 1;
        const resetIn = _headerNumber(e.response.headers, 'x-ratelimit-reset-in');
        const waitS = Number.isFinite(resetIn) && resetIn > 0 ? resetIn : DEFAULT_RESET_IN_S;
        log.warn(`rate-limited (429); sleeping ${waitS}s before retry ${attempt}/${MAX_429_RETRIES}`);
        // A quarter second past their number. The window boundary is
        // measured on their clock, not ours, and coming back a hair
        // early earns a second 429 and burns a retry for nothing.
        await _sleep(waitS * 1000 + 250);
        _nextAllowedAt = Date.now() + MIN_GAP_MS;
        continue;
      }

      if (status === 401 || status === 403) {
        // Worth its own error: this is the one failure a user can fix,
        // and "lookup failed" would send them looking at their network.
        _health(false, 'token rejected');
        const err = new Error(
          'ListenBrainz rejected the token (Settings → ListenBrainz token). '
          + 'The metadata endpoints no longer accept anonymous requests.'
        );
        err.code = 'LB_UNAUTHORISED';
        throw err;
      }

      _health(false, e.message || `HTTP ${status || 'error'}`);
      throw e;
    }
  }
}

// ---------------------------------------------------------------------------
// Bulk lookup
// ---------------------------------------------------------------------------

/**
 * Look up many recordings at once.
 *
 *   items  [{ artist_name, recording_name, release_name? }, ...]
 *
 * Returns an array the SAME LENGTH AND ORDER as `items`. Each entry is
 * null (no match, not sendable, or the request failed) or
 *
 *   { recording_mbid, release_mbid, artist_mbids: [],
 *     recording_name, release_name, artist_credit_name, index }
 *
 * where `index` is the position in `items` this match answers.
 *
 * Never throws. A caller that gets nulls back falls through to whatever
 * it would have done without ListenBrainz, and a metadata helper being
 * unreachable must not be able to fail a matcher run.
 */
async function lookupRecordings(items) {
  const list = Array.isArray(items) ? items : [];
  const out = new Array(list.length).fill(null);
  if (!list.length) return out;

  if (!isConfigured()) {
    // Not a warning. Running without a token is a supported
    // configuration, and this is the path a user who has never heard of
    // ListenBrainz takes on every single album.
    log.debug('no token configured — skipping lookup');
    return out;
  }

  // Build the sendable set, remembering where each entry came from. An
  // item the mapper cannot use (no artist, or no recording name) is
  // answered null here rather than spending a slot in the batch.
  const sendable = [];
  for (let i = 0; i < list.length; i++) {
    const body = _fitLookup(list[i]);
    if (body) sendable.push({ at: i, body });
  }
  if (!sendable.length) return out;

  for (let start = 0; start < sendable.length; start += MAX_LOOKUPS_PER_POST) {
    const chunk = sendable.slice(start, start + MAX_LOOKUPS_PER_POST);
    let matches;
    try {
      matches = await _postLookup(chunk.map((c) => c.body));
    } catch (e) {
      log.warn(`lookup of ${chunk.length} recording(s) failed: ${e.message}`);
      // Stop rather than send the rest. Everything that fails a chunk
      // here — a rejected token, a 5xx, a network that is not there —
      // applies just as much to the next chunk, and the caller falls
      // back to the MusicBrainz web service on nulls anyway. Another ten
      // doomed requests would only delay that.
      break;
    }

    for (const m of matches) {
      // ---------------------------------------------------------------
      // THE INDEX RULE. Read this before touching the loop.
      //
      // The response array is SHORTER than the request array whenever a
      // lookup misses: ListenBrainz leaves misses out rather than
      // returning a null for them. So the Nth result is NOT the answer
      // to the Nth recording we asked about. Every result carries
      // `index`, the position of the input it answers, and that field is
      // the only thing that may be used to line them back up.
      //
      // Mapping by position instead files one album's release MBID
      // against a different album, and that is the kind of wrong answer
      // nobody can see: the MBID is real, the release exists, the cover
      // art downloads, the version grouping collapses two unrelated
      // records into one tile, and everything looks like it worked.
      // ---------------------------------------------------------------
      const idx = Number(m && m.index);
      if (!Number.isInteger(idx) || idx < 0 || idx >= chunk.length) {
        log.warn(
          `dropped a result with an unusable index (${m && m.index}) — `
          + 'refusing to guess which recording it answers'
        );
        continue;
      }
      const at = chunk[idx].at;
      out[at] = {
        recording_mbid: m.recording_mbid || null,
        release_mbid: m.release_mbid || null,
        artist_mbids: Array.isArray(m.artist_mbids) ? m.artist_mbids.slice() : [],
        recording_name: m.recording_name || '',
        release_name: m.release_name || '',
        artist_credit_name: m.artist_credit_name || '',
        // Rewritten from the position within this chunk to the position
        // in the caller's own array — the caller never saw the chunking
        // and should not have to reason about it.
        index: at,
      };
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Album-level lookup
// ---------------------------------------------------------------------------

// Pick `want` track titles spread across the running order rather than
// simply the first `want`. Three tracks taken from the start, the middle
// and the end of an album are more independent evidence than tracks 1-3:
// on a compilation the opening tracks very often come from one source
// album, and three lookups that all agree on that album's release are
// three votes for the wrong answer, cast with maximum confidence.
//
// Duplicate titles are dropped for the same reason — two tracks with the
// same name vote twice for whatever that one name matches, which is
// agreement we did not earn.
function _spreadSample(titles, want) {
  const clean = [];
  const seen = new Set();
  for (const t of (Array.isArray(titles) ? titles : [])) {
    const s = String(t || '').trim();
    if (!s) continue;
    const key = identity.normalise(s);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    clean.push(s);
  }
  if (clean.length <= want) return clean;
  if (want <= 1) return clean.slice(0, 1);
  const out = [];
  for (let i = 0; i < want; i++) {
    out.push(clean[Math.round((i * (clean.length - 1)) / (want - 1))]);
  }
  return out;
}

// How sure are we, 0-100, given how the sampled tracks voted?
//
// Three quantities come out of the tally, and they are not the same
// thing:
//
//   agree     tracks that came back pointing at the winning release
//   dissent   tracks that came back pointing at a DIFFERENT release —
//             a contradiction, and the strongest evidence against
//   silence   tracks that came back with no match at all. Weak evidence,
//             not contradiction: a mistyped track title says nothing
//             about whether the other two got the album right.
//
// So: a base set by how many tracks actually agreed, then 12 points off
// per contradiction and 5 off per silence.
//
//   agree  base      because
//     1     60       one fuzzy guess, uncorroborated
//     2     80       two independent lookups landed on one release
//     3+    95       decisive; nothing this fuzzy earns 100
//
// Which produces the numbers the caller will actually see:
//
//   3 of 3 agreeing              95   decisive
//   2 agree, 1 silent            75   good
//   2 agree, 1 dissenting        68   good, with a caveat
//   1 of 1 sampled               60   weak — a single-track album, or
//                                     an album whose other tracks were
//                                     not sent
//   1 agree, 2 silent            50
//   1 agree, 2 dissenting        36   barely evidence at all
//
// The caller decides where its own bar sits. Anything under 50 should be
// treated as a hint worth checking against another source, not a match.
function _confidence(agree, dissent, silence) {
  const base = agree >= 3 ? 95 : (agree === 2 ? 80 : 60);
  const score = base - (12 * dissent) - (5 * silence);
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Album-level convenience for the matcher.
 *
 *   { title, artist, trackTitles }   the album as this library has it
 *   opts.sample                      tracks to send, default 3
 *
 * Returns { releaseMbid, artistMbids, agree, sampled, confidence } or
 * null when nothing came back. Never throws.
 */
async function lookupAlbum({ title, artist, trackTitles } = {}, opts = {}) {
  if (!isConfigured()) return null;

  // Normalisation comes from albumIdentity and from nowhere else. This
  // module has to agree with the matcher and with version grouping about
  // what an album is CALLED — if it strips "(Deluxe Edition)" by a
  // different rule than they do, it resolves a release the matcher would
  // never have looked for and the two disagree about the same row. That
  // divergence is the entire reason albumIdentity.js exists.
  const cleanTitle = identity.cleanAlbumTitle(title || '').cleaned;
  const cleanArtist = identity.cleanArtistName(artist || '').cleaned;

  // No artist is fatal: the mapper needs one, and "Unknown Artist" is
  // worse than nothing because it is a real string that will match
  // something somewhere.
  if (!cleanArtist || identity.isPlaceholder(cleanArtist)) return null;

  const want = Math.max(1, Math.min(MAX_LOOKUPS_PER_POST,
    Number(opts.sample) || DEFAULT_SAMPLE));
  const sample = _spreadSample(trackTitles, want);
  if (!sample.length) return null;

  // A placeholder album title is left OFF the query rather than sent.
  // "Unknown Album" as a release_name actively steers a fuzzy index
  // wrong; an absent release_name just lets artist + recording decide.
  const releaseName = identity.isPlaceholder(cleanTitle) ? '' : cleanTitle;
  const items = sample.map((t) => ({
    artist_name: cleanArtist,
    recording_name: t,
    release_name: releaseName,
  }));

  const results = await lookupRecordings(items);

  // Tally the releases the sampled tracks came back with. Insertion
  // order is the sampling order, so a dead tie between two releases is
  // settled in favour of the earlier-sampled track's answer — arbitrary,
  // but deterministic, and the confidence it earns says plainly that it
  // was a tie.
  const votes = new Map();
  let voted = 0;
  for (const r of results) {
    if (!r || !r.release_mbid) continue;
    voted += 1;
    const entry = votes.get(r.release_mbid);
    if (entry) entry.count += 1;
    else votes.set(r.release_mbid, { count: 1, first: r });
  }
  if (!voted) return null;

  let winnerId = null;
  let winner = null;
  for (const [id, entry] of votes) {
    if (!winner || entry.count > winner.count) { winner = entry; winnerId = id; }
  }

  const agree = winner.count;
  const dissent = voted - agree;
  const silence = items.length - voted;
  const confidence = _confidence(agree, dissent, silence);

  log.info(
    `"${cleanArtist} — ${cleanTitle || 'untitled'}": ${agree}/${items.length} `
    + `agree on release ${winnerId} (confidence ${confidence})`
  );

  return {
    releaseMbid: winnerId,
    // The names MusicBrainz holds for the winning release, carried
    // through so a caller can show the user what it matched to without
    // a second lookup. The matcher puts them straight into the stored
    // candidate row that the Unmatched page renders.
    releaseName: winner.first.release_name || null,
    artistCreditName: winner.first.artist_credit_name || null,
    // The artist credit of ONE track on the winning release, not a union
    // across the agreeing tracks. A union looks more thorough and is
    // worse: on a compilation it collects every guest performer, and a
    // list of nine artist MBIDs for one album row means nothing to
    // anybody downstream.
    artistMbids: Array.isArray(winner.first.artist_mbids)
      ? winner.first.artist_mbids.slice()
      : [],
    agree,
    sampled: items.length,
    confidence,
  };
}

// ---------------------------------------------------------------------------
// Release -> release group
// ---------------------------------------------------------------------------

/**
 * Convert a release MBID to its release-group MBID.
 *
 * ListenBrainz answers with a RELEASE — one specific pressing, with its
 * own barcode and catalogue number. Everything downstream of the matcher
 * wants the RELEASE GROUP: the album as a concept, which every edition
 * of it hangs off, and which is what makes three copies of one record
 * agree on one MBID. One web-service call converts the two.
 *
 *   opts  passed through to mbHttp.request; { contact } is required
 *         there. When the caller does not supply one we fill it in from
 *         the setting, which is where mbHttp would have read it anyway.
 *
 * Returns the group MBID, or null when there isn't one to be had. Never
 * throws: a release that has been merged away 404s, and that is a normal
 * answer, not an error worth failing an album over.
 */
async function releaseGroupFor(releaseMbid, opts = {}) {
  const id = String(releaseMbid || '').trim();
  if (!id) return null;

  const callOpts = (opts && opts.contact)
    ? opts
    : Object.assign({}, opts, { contact: mbHttp.getContact() });

  try {
    const data = await mbHttp.request(
      `/release/${encodeURIComponent(id)}`,
      { inc: 'release-groups' },
      callOpts
    );
    const rg = data && data['release-group'];
    return (rg && rg.id) || null;
  } catch (e) {
    const status = e.response && e.response.status;
    if (status === 404) {
      log.warn(`release ${id} is not at MusicBrainz (404) — probably merged away`);
      return null;
    }
    if (e.code === 'MB_NO_CONTACT') {
      // Not silence: the user needs to know why this half of the feature
      // is inert, and the message names the setting that fixes it.
      log.warn(
        `cannot resolve release ${id} to its release group — MusicBrainz `
        + 'requests need a contact (Settings → MusicBrainz contact)'
      );
      return null;
    }
    log.warn(`release-group lookup for ${id} failed: ${e.message}`);
    return null;
  }
}

/**
 * Check the saved token against ListenBrainz and report who it belongs to.
 *
 * v1.1.40.0. This exists because the token field shipped in v1.1.38.0 with
 * no way to tell whether it worked. A credential you paste into a box that
 * then says nothing is a credential you cannot trust — and the failure mode
 * is silent by design here, since a bad token just means the matcher falls
 * back to the MusicBrainz path and carries on.
 *
 * ListenBrainz has an endpoint for exactly this: /1/validate-token answers
 * { valid, user_name } and does NOT count as a failed auth attempt. It also
 * accepts the token as a query parameter for backwards compatibility; we
 * send the Authorization header, which is the documented form and the same
 * one the mapper uses — so a pass here proves the mapper will authenticate,
 * not merely that the string exists in their database.
 *
 * Returns { valid, userName, error }. Never throws: this is called from a
 * settings button and a network blip should read as "could not check",
 * which is a different thing from "invalid" and is reported as such.
 */
async function validateToken(explicitToken) {
  const token = String(explicitToken || _token() || '').trim();
  if (!token) return { valid: false, userName: null, error: 'No token saved.' };

  let res;
  try {
    res = await axios.get(`${LB_BASE}/validate-token`, {
      headers: { Authorization: `Token ${token}`, 'User-Agent': _userAgent() },
      timeout: REQUEST_TIMEOUT_MS,
      // A 401 is an ANSWER here, not a transport failure — resolve it so
      // the message below can distinguish "wrong token" from "unreachable".
      validateStatus: (s) => s >= 200 && s < 500,
    });
  } catch (e) {
    return { valid: false, userName: null, error: `Could not reach ListenBrainz: ${e.message}` };
  }

  if (res.status === 401 || res.status === 403) {
    return { valid: false, userName: null, error: 'ListenBrainz rejected this token.' };
  }
  if (res.status >= 400) {
    const msg = (res.data && (res.data.error || res.data.message)) || `HTTP ${res.status}`;
    return { valid: false, userName: null, error: msg };
  }

  const data = res.data || {};
  if (data.valid) {
    log.info(`token validated for ListenBrainz user "${data.user_name}"`);
    return { valid: true, userName: data.user_name || null, error: null };
  }
  return {
    valid: false,
    userName: null,
    // The most common cause by far, and the one worth naming: people
    // paste an OAuth client id or client secret from the applications
    // page instead of the user token from the settings page.
    error: data.message
      || 'Not a valid ListenBrainz user token. Check you copied the token from '
         + 'listenbrainz.org/settings/ and not a client ID or secret from the '
         + 'applications page — those are a different credential and will not work here.',
  };
}

module.exports = {
  isConfigured,
  validateToken,
  lookupRecordings,
  lookupAlbum,
  releaseGroupFor,
  // Exported for tests: the query-length trim and the confidence
  // arithmetic are the two pieces with no network in them and the two
  // most worth being able to drive directly.
  _fitLookup,
  _confidence,
  _spreadSample,
  MAX_LOOKUPS_PER_POST,
  MAX_MAPPING_QUERY_LENGTH,
};
