// src/mbArtist.js — resolve an artist to a MusicBrainz MBID, then work
// from their actual discography.
//
// v1.1.34.0. This is the change that makes matching better, and the
// reason is worth stating plainly.
//
// THE OLD SHAPE. Every album asked MusicBrainz a fuzzy question:
//
//     releasegroup:"Moon Safari" AND artist:"Air"
//
// The artist is a STRING there, re-matched from scratch for every album
// that artist ever made. "The Rolling Stones" against "Rolling Stones",
// "Björk" against "Bjork", a trailing "  " from a bad ripper — each of
// those costs you the artist axis on every one of their albums, one at
// a time, forever.
//
// THE NEW SHAPE. Resolve the artist ONCE:
//
//     Air -> 5a85c140-dcf9-4dd2-b2c8-aff0471f2b1b
//
// and then ask a question with no fuzz left in it: give me everything
// this artist released. Score the local album against that closed set.
//
// Three things follow, and the third is the one that matters for a
// badly-tagged library:
//
//   1. The artist axis becomes exact. It stops being a source of error.
//   2. It costs FEWER requests, not more. One artist lookup plus one
//      discography browse serves every album by that artist; the old
//      way spent up to five searches per album. A 2000-album,
//      400-artist library goes from thousands of requests to hundreds.
//   3. A closed candidate set can be scored on title alone. An album
//      whose title is mangled past the point where any title query
//      would hit can still be recognised, because we are no longer
//      asking MB to find it — we already have the list it is on.
//
// The MBID is cached in artists.mb_artist_id, which already existed for
// artist logo lookups, so the second run of the matcher spends nothing
// on artists it has already seen.

'use strict';

const identity = require('./albumIdentity');
const log = require('./serviceLog').forModule('mb-artist');

// Discographies are cached for the life of a matcher run. Trimmed to
// the fields the scorer reads — a full browse response is mostly
// relations and annotations we never look at, and 400 artists' worth of
// untrimmed JSON is tens of MB held for the length of a long crawl.
const _discographyCache = new Map();
// Artists MB has no confident answer for. Without this, an artist whose
// name is unresolvable costs one failed lookup per album they appear on.
const _unresolvable = new Set();
const MAX_CACHED_DISCOGRAPHIES = 600;

// MB caps browse at 100 per page. Most artists fit in one; a prolific
// one (Bowie, Various Artists compilations) does not, and paging their
// entire catalogue would spend a minute of rate limit on one album. Two
// pages is the compromise — beyond that the caller falls back to a
// targeted search, which is what a big discography wants anyway.
const BROWSE_PAGE = 100;
const MAX_BROWSE_PAGES = 2;

function _trim(rg) {
  return {
    id: rg.id,
    title: rg.title,
    'first-release-date': rg['first-release-date'] || null,
    'primary-type': rg['primary-type'] || null,
    'secondary-types': rg['secondary-types'] || [],
    disambiguation: rg.disambiguation || '',
    'artist-credit': (rg['artist-credit'] || []).map((ac) => ({
      name: ac.name || (ac.artist && ac.artist.name) || '',
    })),
  };
}

// Score an artist search hit. Exactness matters far more here than in
// album scoring: a wrong artist MBID poisons every album we then match
// from their discography, so the bar is deliberately high and there is
// no fuzzy tier below it.
function _scoreArtist(wanted, candidate) {
  const w = identity.normalise(wanted);
  if (!w) return 0;
  const name = identity.normalise(candidate.name || '');
  if (name === w) return 100;
  // MB aliases carry the spellings people actually tag with — the
  // "Bjork" for "Björk" case lives here, as do transliterations and
  // legal-vs-stage names.
  for (const alias of (candidate.aliases || [])) {
    if (identity.normalise(alias.name || '') === w) return 95;
  }
  const sort = identity.normalise(candidate['sort-name'] || '');
  if (sort === w) return 90;
  // "Beatles" vs "The Beatles" is already handled by normalise()
  // dropping leading articles, so anything still unequal here is a
  // genuinely different string. Accept only if MB itself is certain
  // AND the strings are close, which keeps typos working without
  // opening the door to a different artist with a similar name.
  const mbScore = Number(candidate.score || 0);
  if (mbScore >= 95 && name && w) {
    const shorter = Math.min(name.length, w.length);
    if (shorter >= 5 && (name.startsWith(w) || w.startsWith(name))) return 80;
  }
  return 0;
}

// ctx: { mbRequest, userAgent, dbh }
// Returns an MBID string, or null when nothing is confident enough.
async function resolveArtistMbid(artistName, ctx) {
  const clean = identity.cleanArtistName(artistName || '').cleaned;
  if (!clean || identity.isPlaceholder(clean)) return null;
  const key = identity.normalise(clean);
  if (_unresolvable.has(key)) return null;

  // Cached from a previous run, or from artist-logo lookups.
  try {
    const row = ctx.dbh.prepare(
      'SELECT mb_artist_id FROM artists WHERE LOWER(name) = LOWER(?) AND mb_artist_id IS NOT NULL'
    ).get(clean);
    if (row && row.mb_artist_id) return row.mb_artist_id;
  } catch (e) {
    // No artists table (a partial schema in a test). Fall through to
    // the network path; only the cache is lost.
  }

  let data;
  try {
    data = await ctx.mbRequest('/artist/',
      { query: `artist:"${clean.replace(/["\\]/g, ' ')}"`, limit: 5 },
      ctx.userAgent);
  } catch (e) {
    // A network failure is not evidence the artist is unresolvable —
    // do NOT poison the negative cache with it, or one blip costs the
    // rest of the run every album by that artist.
    log.warn(`artist lookup failed for "${clean}": ${e.message}`);
    return null;
  }

  const hits = (data && data.artists) || [];
  let best = null;
  for (const c of hits) {
    const s = _scoreArtist(clean, c);
    if (s > 0 && (!best || s > best.score)) best = { score: s, id: c.id, name: c.name };
  }
  if (!best) {
    _unresolvable.add(key);
    return null;
  }

  try {
    ctx.dbh.prepare('INSERT OR IGNORE INTO artists (id, name) VALUES (?, ?)')
      .run(identity.normalise(clean).replace(/\s+/g, ' '), clean);
    ctx.dbh.prepare('UPDATE artists SET mb_artist_id = ? WHERE LOWER(name) = LOWER(?)')
      .run(best.id, clean);
  } catch (e) {
    log.warn(`could not cache MBID for "${clean}": ${e.message}`);
  }
  log.info(`resolved "${clean}" -> ${best.id} (${best.score})`);
  return best.id;
}

// Everything this artist released, trimmed and cached. Returns
// { groups: [...], complete: bool } — `complete` false means the
// discography was larger than we were willing to page, and the caller
// should not treat "not in this list" as evidence of anything.
async function getDiscography(arid, ctx) {
  if (!arid) return { groups: [], complete: false };
  if (_discographyCache.has(arid)) return _discographyCache.get(arid);

  const groups = [];
  let complete = true;
  let total = null;

  for (let page = 0; page < MAX_BROWSE_PAGES; page++) {
    let data;
    try {
      data = await ctx.mbRequest('/release-group/', {
        artist: arid,
        limit: BROWSE_PAGE,
        offset: page * BROWSE_PAGE,
        inc: 'artist-credits',
      }, ctx.userAgent);
    } catch (e) {
      log.warn(`discography browse failed for ${arid}: ${e.message}`);
      // Partial results are still useful; say so rather than caching a
      // short list as if it were the whole catalogue.
      complete = false;
      break;
    }
    const page_groups = (data && data['release-groups']) || [];
    for (const rg of page_groups) groups.push(_trim(rg));
    if (total === null) total = Number(data && data['release-group-count']) || page_groups.length;
    if (groups.length >= total || page_groups.length < BROWSE_PAGE) break;
    if (page === MAX_BROWSE_PAGES - 1 && groups.length < total) complete = false;
  }

  const result = { groups, complete };
  // Bounded: a very large library must not grow this without limit.
  // Oldest-first eviction is fine — a matcher run walks albums in id
  // order, so an artist already passed is unlikely to come back.
  if (_discographyCache.size >= MAX_CACHED_DISCOGRAPHIES) {
    const oldest = _discographyCache.keys().next().value;
    _discographyCache.delete(oldest);
  }
  _discographyCache.set(arid, result);
  log.info(`discography ${arid}: ${groups.length} release group(s)${complete ? '' : ' (truncated)'}`);
  return result;
}

// Between runs the caches are dropped: MB data changes, an artist that
// was unresolvable last week may have been added since, and a user
// pressing "rematch" expects a fresh answer rather than this process's
// memory of the last one.
function resetCaches() {
  _discographyCache.clear();
  _unresolvable.clear();
}

module.exports = { resolveArtistMbid, getDiscography, resetCaches, _scoreArtist };
