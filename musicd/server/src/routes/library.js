const express = require('express');
const router = express.Router();
const db = require('../db');
const scanner = require('../scanner');
const tierMiddleware = require('../tierMiddleware');
const librarySort = require('../librarySort');

const cache = new Map();
const CACHE_TTL = 30000;

// v1.1.0.91 — per-key TTL override. Some endpoints have heavy
// computation (focus/options at 54k+ rows) and rarely-changing
// data, so we want to cache them for much longer than the default
// 30s. ttlMs is optional; falls back to CACHE_TTL.
function cached(key, fn, ttlMs) {
  const now = Date.now();
  const ttl = ttlMs || CACHE_TTL;
  const hit = cache.get(key);
  if (hit && now - hit.ts < ttl) return hit.data;
  const data = fn();
  cache.set(key, { data, ts: now });
  return data;
}
function invalidateCache() { cache.clear(); }

// How many albums one multi-select action may act on. A phone grid tops out
// well below this; the cap is here so a hand-made request cannot ask the
// server to assemble a hundred thousand tracks in one statement loop.
const MULTI_SELECT_MAX_ALBUMS = 500;

// Validation helper (#21)
function clamp(val, min, max, defaultVal) {
  const n = parseInt(val);
  if (isNaN(n)) return defaultVal;
  return Math.max(min, Math.min(n, max));
}

// GET /api/library/favorites — albums marked as favourite, newest favourite first
router.get('/favorites', (req, res) => {
  const database = db.get();
  const lim = clamp(req.query.limit, 1, 1000, 500);
  const result = cached('favorites:' + lim, () => {
    const rows = database.prepare(`
      SELECT id, title, album_artist, artist, year, track_count, total_duration, primary_format, genre,
             favorited_at,
             CASE WHEN cover_art IS NOT NULL THEN 1 ELSE 0 END as has_art
      FROM albums
      WHERE is_favorite = 1 AND excluded = 0
      ORDER BY favorited_at DESC NULLS LAST, title COLLATE NOCASE ASC
      LIMIT ?
    `).all(lim);
    return rows.map(a => ({
      ...a,
      cover_art: a.has_art ? `/api/library/albums/${a.id}/cover` : null,
      has_art: undefined,
    }));
  });
  res.setHeader('Cache-Control', 'private, max-age=15');
  res.json(result);
});

// GET /api/library/albums
router.get('/albums', tierMiddleware.clampLimit('library_size_limit'), (req, res) => {
  const database = db.get();
  const { sort, dir, seed, format, artist, genre, favorites, saved, tag_id, tag_ids } = req.query;
  // v1.1.11.0 — the sort suite moved to src/librarySort.js so the client's
  // sheet and this route cannot drift apart. It validates the three
  // parameters and hands back an ORDER BY body; nothing from req.query
  // reaches the SQL. 'title' still resolves, so an older client keeps working.
  const sortId = librarySort.normaliseSort(sort);
  const sortDirection = librarySort.normaliseDir(sortId, dir);
  const sortSeed = librarySort.normaliseSeed(seed);
  const orderBy = librarySort.orderByFor(sortId, sortDirection, sortSeed);
  const favOnly = favorites === '1' || favorites === 'true';
  // v1.1.0.70 — composable Saved-for-later filter, mirrors favOnly.
  // Both flags can be combined; the resulting clause is the AND of
  // both. No reason to forbid that — "saved AND favourite" is a
  // sensible filter the user might choose later.
  const savedOnly = saved === '1' || saved === 'true';
  // v1.1.0.71 / v1.1.0.73 — composable tag filter. The original
  // ?tag_id=N (single) is preserved for back-compat with anything
  // that still uses the v71 contract; v73 adds ?tag_ids=N,M,P
  // (comma-separated) to support the multi-tag chip-strip on the
  // Albums screen. Semantics are AND — an album must carry every
  // listed tag to match. (The AND-vs-OR decision is documented in
  // the v73 changelog; OR can be added later via &match=any.)
  //
  // Numeric-only validation per id: any non-numeric token is
  // silently dropped rather than 400'd, so the URL stays forgiving
  // when the client races a tag deletion. After validation we
  // dedupe so a stuttery client doesn't get more EXISTS clauses
  // than it needs.
  let tagIds = [];
  if (tag_ids) {
    const tokens = String(tag_ids).split(',').map(s => s.trim());
    for (const t of tokens) {
      if (/^\d+$/.test(t)) tagIds.push(parseInt(t, 10));
    }
    tagIds = Array.from(new Set(tagIds));
  } else if (tag_id && /^\d+$/.test(String(tag_id))) {
    tagIds = [parseInt(tag_id, 10)];
  }
  const lim = clamp(req.query.limit, 1, 500, 200);
  const off = clamp(req.query.offset, 0, 999999, 0);

  // v1.1.0.80 — Focus filter clauses. Roon-style: each pick creates
  // a pill, pills can be include (+) or exclude (-). Per spec:
  //   * AND across sub-sections (format AND decade AND genre)
  //   * OR within a sub-section (format=flac OR format=alac)
  //   * Excludes are AND NOT (so "exclude rock" filters out all rock)
  //
  // Params are comma-separated lists, e.g.:
  //   ?focus_format=flac,alac
  //   &focus_format_excl=mp3
  //   &focus_genre=Rock,Jazz
  //   &focus_decade=1970,1980
  //   &focus_artist=Pink%20Floyd
  //   &focus_last_played=week
  //   &focus_last_played_excl=day
  //   &focus_added_on=month
  //
  // For lastPlayed/addedOn we accept a single value (day/week/month/longer);
  // multi-select within these sub-sections doesn't really make sense
  // (overlapping ranges). Multi-tick still creates multiple pills,
  // but only the longest range is meaningful — UI enforces at the
  // pill level by simply allowing multiple ticks; server takes the
  // first valid value if multiple come through.
  const parseList = (v) => v ? String(v).split(',').map(s => s.trim()).filter(Boolean) : [];
  const focusFormatIn   = parseList(req.query.focus_format).map(s => s.toLowerCase());
  const focusFormatEx   = parseList(req.query.focus_format_excl).map(s => s.toLowerCase());
  // v1.1.0.81 — audio-quality params. Integer values; we drop any
  // non-numeric tokens silently rather than 400 — keeps URLs
  // forgiving when a malformed query reaches the server (rare,
  // but possible from a client-side bug).
  const parseIntList = (v) => parseList(v).map(s => parseInt(s, 10)).filter(n => Number.isFinite(n));
  const focusBitDepthIn    = parseIntList(req.query.focus_bit_depth);
  const focusBitDepthEx    = parseIntList(req.query.focus_bit_depth_excl);
  const focusSampleRateIn  = parseIntList(req.query.focus_sample_rate);
  const focusSampleRateEx  = parseIntList(req.query.focus_sample_rate_excl);
  const focusChannelsIn    = parseIntList(req.query.focus_channels);
  const focusChannelsEx    = parseIntList(req.query.focus_channels_excl);
  const focusGenreIn    = parseList(req.query.focus_genre);
  const focusGenreEx    = parseList(req.query.focus_genre_excl);
  const focusDecadeIn   = parseList(req.query.focus_decade).map(s => parseInt(s, 10)).filter(n => Number.isFinite(n));
  const focusDecadeEx   = parseList(req.query.focus_decade_excl).map(s => parseInt(s, 10)).filter(n => Number.isFinite(n));
  const focusArtistIn   = parseList(req.query.focus_artist);
  const focusArtistEx   = parseList(req.query.focus_artist_excl);
  // v1.1.0.97 — album type filter. Validated against the known set
  // because it's a fixed taxonomy. Unknown values are silently
  // dropped (forgiving URL handling).
  const VALID_ALBUM_TYPES = new Set(['main', 'ep', 'single', 'soundtrack', 'deluxe', 'limited']);
  const focusAlbumTypeIn = parseList(req.query.focus_album_type).filter(v => VALID_ALBUM_TYPES.has(v));
  const focusAlbumTypeEx = parseList(req.query.focus_album_type_excl).filter(v => VALID_ALBUM_TYPES.has(v));
  // For last-played / added-on we treat the param as a single value
  // even if a list comes through — pick the first valid.
  const validRange = (v) => ['day', 'week', 'month', 'longer'].includes(v) ? v : null;
  const focusLastPlayed   = validRange(parseList(req.query.focus_last_played)[0]);
  const focusLastPlayedEx = validRange(parseList(req.query.focus_last_played_excl)[0]);
  const focusAddedOn      = validRange(parseList(req.query.focus_added_on)[0]);
  const focusAddedOnEx    = validRange(parseList(req.query.focus_added_on_excl)[0]);

  // Build the focus WHERE clause and bound parameters. Each
  // sub-section contributes one AND-clause; within a sub-section,
  // multi-pick uses IN(...) (OR semantics).
  const focusParts = [];
  const focusParams = [];

  if (focusFormatIn.length > 0) {
    focusParts.push(`LOWER(primary_format) IN (${focusFormatIn.map(() => '?').join(',')})`);
    focusParams.push(...focusFormatIn);
  }
  if (focusFormatEx.length > 0) {
    focusParts.push(`(LOWER(primary_format) IS NULL OR LOWER(primary_format) NOT IN (${focusFormatEx.map(() => '?').join(',')}))`);
    focusParams.push(...focusFormatEx);
  }
  // v1.1.0.81 — bit depth / sample rate / channels. Numeric IN(..)
  // filters with NULL-safe excludes (an album with NULL bit_depth
  // shouldn't be excluded by "NOT IN (16)" because it might be
  // 24-bit but unscanned — same logic as the format clause above).
  if (focusBitDepthIn.length > 0) {
    focusParts.push(`primary_bit_depth IN (${focusBitDepthIn.map(() => '?').join(',')})`);
    focusParams.push(...focusBitDepthIn);
  }
  if (focusBitDepthEx.length > 0) {
    focusParts.push(`(primary_bit_depth IS NULL OR primary_bit_depth NOT IN (${focusBitDepthEx.map(() => '?').join(',')}))`);
    focusParams.push(...focusBitDepthEx);
  }
  if (focusSampleRateIn.length > 0) {
    focusParts.push(`primary_sample_rate IN (${focusSampleRateIn.map(() => '?').join(',')})`);
    focusParams.push(...focusSampleRateIn);
  }
  if (focusSampleRateEx.length > 0) {
    focusParts.push(`(primary_sample_rate IS NULL OR primary_sample_rate NOT IN (${focusSampleRateEx.map(() => '?').join(',')}))`);
    focusParams.push(...focusSampleRateEx);
  }
  if (focusChannelsIn.length > 0) {
    focusParts.push(`primary_channels IN (${focusChannelsIn.map(() => '?').join(',')})`);
    focusParams.push(...focusChannelsIn);
  }
  if (focusChannelsEx.length > 0) {
    focusParts.push(`(primary_channels IS NULL OR primary_channels NOT IN (${focusChannelsEx.map(() => '?').join(',')}))`);
    focusParams.push(...focusChannelsEx);
  }
  if (focusDecadeIn.length > 0) {
    focusParts.push(`(year IS NOT NULL AND ((year / 10) * 10) IN (${focusDecadeIn.map(() => '?').join(',')}))`);
    focusParams.push(...focusDecadeIn);
  }
  if (focusDecadeEx.length > 0) {
    focusParts.push(`(year IS NULL OR ((year / 10) * 10) NOT IN (${focusDecadeEx.map(() => '?').join(',')}))`);
    focusParams.push(...focusDecadeEx);
  }
  if (focusArtistIn.length > 0) {
    focusParts.push(`album_artist IN (${focusArtistIn.map(() => '?').join(',')})`);
    focusParams.push(...focusArtistIn);
  }
  if (focusArtistEx.length > 0) {
    focusParts.push(`(album_artist IS NULL OR album_artist NOT IN (${focusArtistEx.map(() => '?').join(',')}))`);
    focusParams.push(...focusArtistEx);
  }
  // v1.1.0.97 — album type clauses
  if (focusAlbumTypeIn.length > 0) {
    focusParts.push(`album_type IN (${focusAlbumTypeIn.map(() => '?').join(',')})`);
    focusParams.push(...focusAlbumTypeIn);
  }
  if (focusAlbumTypeEx.length > 0) {
    focusParts.push(`(album_type IS NULL OR album_type NOT IN (${focusAlbumTypeEx.map(() => '?').join(',')}))`);
    focusParams.push(...focusAlbumTypeEx);
  }
  // Genre: alias-aware match. We expand each canonical name to its
  // raw aliases, then build a string-level test (genre column stores
  // raw delimiter-separated tag values). This mirrors what the
  // existing ?genre= filter does, but we bundle multiple genre picks
  // as OR. Excludes are NOT (any of the aliases match).
  const buildGenreClause = (canonicals, isExclude) => {
    if (canonicals.length === 0) return null;
    const { reverseAliases } = require('../genreAlias');
    const subClauses = [];
    const subParams = [];
    for (const canonical of canonicals) {
      const variants = reverseAliases(canonical);
      const allVariants = new Set(variants);
      allVariants.add(canonical.toLowerCase().trim());
      const orParts = [];
      const seps = [',', ';', '/'];
      for (const v of allVariants) {
        orParts.push('genre = ? COLLATE NOCASE');
        subParams.push(v);
        for (const sep of seps) {
          orParts.push('genre LIKE ? COLLATE NOCASE'); subParams.push(v + sep + '%');
          orParts.push('genre LIKE ? COLLATE NOCASE'); subParams.push('%' + sep + v);
          orParts.push('genre LIKE ? COLLATE NOCASE'); subParams.push('%' + sep + ' ' + v);
          orParts.push('genre LIKE ? COLLATE NOCASE'); subParams.push('%' + sep + v + sep + '%');
          orParts.push('genre LIKE ? COLLATE NOCASE'); subParams.push('%' + sep + ' ' + v + sep + '%');
        }
      }
      subClauses.push(`(${orParts.join(' OR ')})`);
    }
    const inner = subClauses.join(' OR ');
    const wrapped = isExclude ? `(genre IS NULL OR NOT (${inner}))` : `(${inner})`;
    return { clause: wrapped, params: subParams };
  };
  const gIn = buildGenreClause(focusGenreIn, false);
  if (gIn) { focusParts.push(gIn.clause); focusParams.push(...gIn.params); }
  const gEx = buildGenreClause(focusGenreEx, true);
  if (gEx) { focusParts.push(gEx.clause); focusParams.push(...gEx.params); }

  // Last played: query play_history. EXISTS (subquery) for include,
  // NOT EXISTS for exclude. The 'longer' bucket means "no play in
  // the last 30 days" — that's NOT EXISTS for the include side and
  // EXISTS for the exclude side.
  const DAY_S = 86400;
  const nowSec = Math.floor(Date.now() / 1000);
  const rangeCutoff = (range) => {
    if (range === 'day')   return nowSec - 1*DAY_S;
    if (range === 'week')  return nowSec - 7*DAY_S;
    if (range === 'month') return nowSec - 30*DAY_S;
    return null; // 'longer' has no cutoff — handled inversely
  };
  if (focusLastPlayed) {
    if (focusLastPlayed === 'longer') {
      // played longer than 30 days ago, OR never played
      focusParts.push(`NOT EXISTS (SELECT 1 FROM play_history ph WHERE ph.album_title = albums.title AND ph.album_artist = albums.album_artist AND ph.played_at > ?)`);
      focusParams.push(nowSec - 30*DAY_S);
    } else {
      const cutoff = rangeCutoff(focusLastPlayed);
      focusParts.push(`EXISTS (SELECT 1 FROM play_history ph WHERE ph.album_title = albums.title AND ph.album_artist = albums.album_artist AND ph.played_at > ?)`);
      focusParams.push(cutoff);
    }
  }
  if (focusLastPlayedEx) {
    // exclude: invert the same logic
    if (focusLastPlayedEx === 'longer') {
      // exclude albums never played / played > 30d ago — i.e. only
      // include albums played in the last 30 days
      focusParts.push(`EXISTS (SELECT 1 FROM play_history ph WHERE ph.album_title = albums.title AND ph.album_artist = albums.album_artist AND ph.played_at > ?)`);
      focusParams.push(nowSec - 30*DAY_S);
    } else {
      const cutoff = rangeCutoff(focusLastPlayedEx);
      focusParts.push(`NOT EXISTS (SELECT 1 FROM play_history ph WHERE ph.album_title = albums.title AND ph.album_artist = albums.album_artist AND ph.played_at > ?)`);
      focusParams.push(cutoff);
    }
  }
  // Added on: same idea but operates on albums.added_at directly.
  if (focusAddedOn) {
    if (focusAddedOn === 'longer') {
      focusParts.push(`(added_at IS NULL OR added_at <= ?)`);
      focusParams.push(nowSec - 30*DAY_S);
    } else {
      focusParts.push(`(added_at IS NOT NULL AND added_at > ?)`);
      focusParams.push(rangeCutoff(focusAddedOn));
    }
  }
  if (focusAddedOnEx) {
    if (focusAddedOnEx === 'longer') {
      focusParts.push(`(added_at IS NOT NULL AND added_at > ?)`);
      focusParams.push(nowSec - 30*DAY_S);
    } else {
      focusParts.push(`(added_at IS NULL OR added_at <= ?)`);
      focusParams.push(rangeCutoff(focusAddedOnEx));
    }
  }

  const focusClause = focusParts.length > 0 ? ' AND ' + focusParts.join(' AND ') : '';

  // Use JSON-stringified key to prevent collisions (#14)
  const cacheKey = 'albums:' + JSON.stringify({
    sortId, sortDirection, sortSeed, lim, off, format, artist, genre, favOnly, savedOnly, tagIds,
    focusFormatIn, focusFormatEx, focusGenreIn, focusGenreEx,
    focusDecadeIn, focusDecadeEx, focusArtistIn, focusArtistEx,
    focusLastPlayed, focusLastPlayedEx, focusAddedOn, focusAddedOnEx,
    // v1.1.0.81
    focusBitDepthIn, focusBitDepthEx, focusSampleRateIn, focusSampleRateEx,
    focusChannelsIn, focusChannelsEx,
  });

  const result = cached(cacheKey, () => {
    let rows;
    // The favourites filter is composable with the other filters: when
    // ?favorites=1 is present we add `is_favorite = 1` to whichever WHERE
    // clause we'd otherwise use. Since the queries below were originally
    // separate prepared statements, the simplest faithful change is to
    // append the filter via parameterised WHERE.
    // v1.1.0.70 — same trick for ?saved=1.
    // v1.1.0.71 / v1.1.0.73 — same trick for tag filtering. Each id
    // gets its own EXISTS clause; all are AND-ed together, so an
    // album must carry every selected tag to match. Each EXISTS
    // uses the idx_album_tags_tag index so even five active filters
    // stays in low-millisecond territory at typical library sizes.
    // The validated integers are inlined into the SQL; we never
    // accept arbitrary tag id values, so this is safe from
    // injection.
    const favClause = favOnly ? ' AND COALESCE(is_favorite,0) = 1 ' : '';
    const savedClause = savedOnly ? ' AND COALESCE(is_saved_for_later,0) = 1 ' : '';
    const tagClause = tagIds.length > 0
      ? tagIds.map(id => ` AND EXISTS (SELECT 1 FROM album_tags at WHERE at.album_id = albums.id AND at.tag_id = ${id}) `).join('')
      : '';
    const filterClause = favClause + savedClause + tagClause;
    if (artist) {
      rows = database.prepare(`
        SELECT id, title, album_artist, artist, year, track_count, total_duration, primary_format, genre,
               COALESCE(is_favorite, 0) as is_favorite,
               CASE WHEN cover_art IS NOT NULL THEN 1 ELSE 0 END as has_art
        FROM albums
        WHERE (album_artist = ? OR artist = ?) AND excluded = 0 ${filterClause} ${focusClause}
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?
      `).all(artist, artist, ...focusParams, lim, off);
    } else if (genre) {
      // Expand the requested canonical genre to all of its raw aliases so
      // tag-spelling variants land in the same listing. E.g. clicking
      // "Electronic" also matches albums tagged "Electronique" or "Electronica".
      const { reverseAliases } = require('../genreAlias');
      const variants = reverseAliases(genre); // folded (lower, no accents)
      // We need both folded and ANY-case patterns. SQLite's LIKE is
      // case-insensitive for ASCII by default, but accents matter — so we
      // also include the canonical-as-passed form for the un-aliased case.
      const allVariants = new Set(variants);
      allVariants.add(genre.toLowerCase().trim());
      // Album rows store the raw tag string, which usually has only one
      // genre (the scanner picks common.genre[0]) — but multi-genre values
      // do exist when a tag itself includes a separator. The /genres
      // endpoint splits on [,;/]; we mirror that here so the listing and
      // the filter agree on what counts as "this album is tagged X".
      // For each variant we test:
      //   exact      genre = v
      //   start      v followed by ',' ';' '/' (with or without trailing space)
      //   end        ',' ';' '/' followed by v (with or without leading space)
      //   middle     v sandwiched between any two separator characters
      const orParts = [];
      const params = [];
      const seps = [',', ';', '/'];
      for (const v of allVariants) {
        orParts.push('genre = ? COLLATE NOCASE');
        params.push(v);
        for (const sep of seps) {
          // Start: "v,..." or "v, ..."
          orParts.push('genre LIKE ? COLLATE NOCASE');
          params.push(v + sep + '%');
          // End: "...,v" or "..., v"
          orParts.push('genre LIKE ? COLLATE NOCASE');
          params.push('%' + sep + v);
          orParts.push('genre LIKE ? COLLATE NOCASE');
          params.push('%' + sep + ' ' + v);
          // Middle (any separator before AND after, with or without spaces)
          orParts.push('genre LIKE ? COLLATE NOCASE');
          params.push('%' + sep + v + sep + '%');
          orParts.push('genre LIKE ? COLLATE NOCASE');
          params.push('%' + sep + ' ' + v + sep + '%');
        }
      }
      const whereClause = `(${orParts.join(' OR ')}) AND excluded = 0 ${filterClause} ${focusClause}`;
      rows = database.prepare(`
        SELECT id, title, album_artist, artist, year, track_count, total_duration, primary_format, genre,
               COALESCE(is_favorite, 0) as is_favorite,
               CASE WHEN cover_art IS NOT NULL THEN 1 ELSE 0 END as has_art
        FROM albums
        WHERE ${whereClause}
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?
      `).all(...params, ...focusParams, lim, off);
    } else if (format) {
      rows = database.prepare(`
        SELECT id, title, album_artist, artist, year, track_count, total_duration, primary_format, genre,
               COALESCE(is_favorite, 0) as is_favorite,
               CASE WHEN cover_art IS NOT NULL THEN 1 ELSE 0 END as has_art
        FROM albums
        WHERE primary_format = ? AND excluded = 0 ${filterClause} ${focusClause}
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?
      `).all(format, ...focusParams, lim, off);
    } else {
      // v1.1.0.70 — single ELSE branch handles "no filter," "favOnly,"
      // "savedOnly," and "favOnly + savedOnly" via filterClause. The
      // separate favOnly fast-path that v30.x had is no longer needed
      // — the SQL planner handles a leading "AND" against the
      // `excluded = 0` predicate just as efficiently as the dedicated
      // branch did, and removing the special case avoids having to
      // duplicate the savedOnly logic.
      rows = database.prepare(`
        SELECT id, title, album_artist, artist, year, track_count, total_duration, primary_format, genre,
               COALESCE(is_favorite, 0) as is_favorite,
               CASE WHEN cover_art IS NOT NULL THEN 1 ELSE 0 END as has_art
        FROM albums
        WHERE excluded = 0 ${filterClause} ${focusClause}
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?
      `).all(...focusParams, lim, off);
    }
    return rows.map(a => ({
      ...a,
      is_favorite: !!a.is_favorite,
      cover_art: a.has_art ? `/api/library/albums/${a.id}/cover` : null,
      has_art: undefined,
    }));
  });

  res.setHeader('Cache-Control', 'private, max-age=30');
  res.json(result);
});

// GET /api/library/albums/random — pick one album at random and return it.
// Used by the "Play random album" button on the main Albums page (#13) and the
// continuous-music ("MusicD Radio") feature when the queue empties (#14, 28.3).
// Optional query params:
//   excludeId  — id to skip (so radio doesn't repeat the just-played album)
//   favorites=1 — restrict to favourited albums only. Used by the Random
//                 button on the Favourites page (#4 / 28.4).
router.get('/albums/random', (req, res) => {
  const database = db.get();
  const exclude = req.query.excludeId || null;
  const favOnly = req.query.favorites === '1';
  // ORDER BY RANDOM() over the full album table is fine at our scale
  // (thousands, not millions). If this ever gets slow, switch to a counted
  // OFFSET approach.
  const conditions = ['track_count > 0', 'excluded = 0'];
  const params = [];
  if (exclude) { conditions.push('id != ?'); params.push(exclude); }
  if (favOnly) { conditions.push('is_favorite = 1'); }
  const sql = `SELECT id FROM albums WHERE ${conditions.join(' AND ')} ORDER BY RANDOM() LIMIT 1`;
  const row = database.prepare(sql).get(...params);
  if (!row) return res.status(404).json({
    error: favOnly ? 'No favourited albums' : 'No albums in library'
  });
  res.json({ id: row.id });
});

// POST /api/library/albums/tracks — the tracks of several albums, in one
// request (v1.1.29.0).
//
// Backs the album grids' multi-select: with eight albums ticked, "Play now"
// needs every track of all eight, in album order, before it can build a queue.
// One request rather than eight, because the client would otherwise have to
// fan out and then reassemble the results in the order the user picked — and
// get that ordering right on every one of the five actions.
//
// The album order is the order the ids arrive in, NOT the order the database
// hands the rows back. That is the selection order, and shuffling it would
// make "Play now" on a picked run of albums play them in some other sequence.
router.post('/albums/tracks', (req, res) => {
  const database = db.get();
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
  if (!ids || ids.length === 0) {
    return res.status(400).json({ error: 'ids array required' });
  }
  // De-duplicated, order preserved. A repeated id would otherwise queue the
  // same album twice from one tap.
  const wanted = [...new Set(ids.map(String))].slice(0, MULTI_SELECT_MAX_ALBUMS);

  const albumStmt = database.prepare(
    'SELECT id, title, album_artist FROM albums WHERE id = ?');
  // The same query /albums/:id uses, including its fallback for tracks
  // scanned before album_id existed — a half-migrated library must not
  // silently return an empty album here while the detail page shows it fine.
  const trackStmt = database.prepare(`
    SELECT t.id, t.title, t.artist, t.album, t.album_artist,
           t.track_number, t.disc_number, t.duration, t.format, t.codec,
           t.sample_rate, t.bit_depth,
           COALESCE(t.is_favorite, 0) as is_favorite,
           COALESCE(t.user_rating, 0) as user_rating,
           COALESCE(t.is_saved_for_later, 0) as is_saved_for_later
    FROM tracks t
    WHERE (
      t.album_id = ?
      OR (t.album_id IS NULL AND t.album = ? AND t.album_artist = ?)
    )
    AND t.excluded = 0
    ORDER BY COALESCE(t.disc_number, 1) ASC, t.track_number ASC
  `);

  const tracks = [];
  const missing = [];
  for (const id of wanted) {
    const album = albumStmt.get(id);
    if (!album) { missing.push(id); continue; }
    for (const t of trackStmt.all(album.id, album.title, album.album_artist)) {
      tracks.push({
        ...t,
        is_favorite: !!t.is_favorite,
        is_saved_for_later: !!t.is_saved_for_later,
        album_id: album.id,
      });
    }
  }

  // 200 with what was found, not 404: an album deleted by a rescan between
  // the tap and the request should cost the user that album, not the action.
  res.json({ tracks, albums: wanted.length - missing.length, missing });
});

// GET /api/library/albums/random-set — N albums picked at random (v1.1.21.0).
//   ?limit=N — defaults to 15 (the 3x5 wall); capped at 60
//
// The Home screen's "Random albums" carousel and the full wall behind its
// title both read this. Distinct from /albums/random above, which returns one
// id for "play something" — this returns whole album rows in the same shape
// as /albums/recent, so the Home carousels can share one tile component.
//
// Deliberately unseeded, unlike the library grid's Random sort. That sort is
// paged with LIMIT/OFFSET and needs the order to hold still between pages, or
// it serves duplicates; this returns one short set in one request, and a fresh
// roll is the entire point of the Refresh button.
router.get('/albums/random-set', (req, res) => {
  const database = db.get();
  const limit = clamp(req.query.limit, 1, 60, 15);

  const rows = database.prepare(`
    SELECT id, title, album_artist, artist, year,
           primary_format, track_count,
           COALESCE(is_favorite, 0) as is_favorite,
           CASE WHEN cover_art IS NOT NULL THEN 1 ELSE 0 END as has_art
    FROM albums
    WHERE track_count > 0 AND excluded = 0
    ORDER BY RANDOM()
    LIMIT ?
  `).all(limit);

  res.json(rows.map(a => ({
    ...a,
    is_favorite: !!a.is_favorite,
    cover_art: a.has_art ? `/api/library/albums/${a.id}/cover` : null,
    has_art: undefined,
  })));
});

// GET /api/library/albums/recent — albums for the Home screen's
// "Recent activity" tabs (#28.5).
//   ?type=added   (default) — albums by added_at DESC
//   ?type=played            — albums whose tracks were most recently played
//   ?limit=N                — defaults to 12; capped at 50
//
// For type=played we group play_history by (album_title, album_artist) and
// take the most recent timestamp per album. We then look the album up in the
// albums table; rows where the album no longer exists are silently dropped.
router.get('/albums/recent', (req, res) => {
  const database = db.get();
  const type = req.query.type === 'played' ? 'played' : 'added';
  const limit = clamp(req.query.limit, 1, 50, 12);

  let rows;
  if (type === 'played') {
    rows = database.prepare(`
      SELECT a.id, a.title, a.album_artist, a.artist, a.year,
             a.primary_format, a.track_count,
             COALESCE(a.is_favorite, 0) as is_favorite,
             CASE WHEN a.cover_art IS NOT NULL THEN 1 ELSE 0 END as has_art,
             ph.last_played as activity_at
      FROM (
        SELECT album_title, album_artist, MAX(played_at) as last_played
        FROM play_history
        WHERE album_title IS NOT NULL
        GROUP BY album_title, album_artist
        ORDER BY last_played DESC
        LIMIT ?
      ) ph
      JOIN albums a ON a.title = ph.album_title AND a.album_artist = ph.album_artist
      WHERE a.excluded = 0
      ORDER BY ph.last_played DESC
    `).all(limit);
  } else {
    rows = database.prepare(`
      SELECT id, title, album_artist, artist, year,
             primary_format, track_count,
             COALESCE(is_favorite, 0) as is_favorite,
             CASE WHEN cover_art IS NOT NULL THEN 1 ELSE 0 END as has_art,
             added_at as activity_at
      FROM albums
      WHERE track_count > 0 AND excluded = 0
      ORDER BY added_at DESC
      LIMIT ?
    `).all(limit);
  }

  res.json(rows.map(a => ({
    ...a,
    is_favorite: !!a.is_favorite,
    cover_art: a.has_art ? `/api/library/albums/${a.id}/cover` : null,
    has_art: undefined,
  })));
});

// GET /api/library/albums/:id
router.get('/albums/:id', (req, res) => {
  // v1.1.1.4 diagnostic — log every album-detail request with
  // the requesting IP and tier so we can correlate phone taps
  // with server-side fetches when diagnosing the blank-album bug.
  console.log(`[album-detail-req] id=${req.params.id} tier=${req.tier || '?'} ua=${(req.get('user-agent') || '').slice(0, 60)}`);
  const database = db.get();
  const album = database.prepare(`
    SELECT id, title, artist, album_artist, year, release_date, genre, track_count, total_duration, primary_format,
           COALESCE(is_favorite, 0) as is_favorite,
           COALESCE(is_saved_for_later, 0) as is_saved_for_later,
           album_type,
           COALESCE(album_type_locked, 0) as album_type_locked,
           CASE WHEN cover_art IS NOT NULL THEN 1 ELSE 0 END as has_art,
           mb_release_group_id, match_status, match_confidence
    FROM albums WHERE id = ?
  `).get(req.params.id);
  if (!album) {
    console.log(`[album-detail-req] id=${req.params.id} → 404 Not Found`);
    return res.status(404).json({ error: 'Not found' });
  }

  // LEFT JOIN track_loudness so each track carries its analysis result.
  // The UI shows integrated_lufs inline alongside bit depth / sample
  // rate (#30.17). Tracks that haven't been analysed yet just have
  // null for these fields; the UI omits the badge in that case.
  // v1.1.0.92 — query by album_id rather than album+album_artist.
  // Old code joined on title+artist which collided when the user
  // had two versions of the same album (16/44.1 vs 24/192). The
  // new tracks.album_id column gives a clean 1:1 relationship.
  // Falls back to title+artist for tracks predating the migration
  // (album_id is NULL until rescanned) so the page still works on
  // a half-migrated DB.
  const tracks = database.prepare(`
    SELECT t.id, t.title, t.artist, t.track_number, t.disc_number, t.duration,
           t.bitrate, t.sample_rate, t.bit_depth, t.channels, t.format, t.codec, t.file_size, t.genre,
           COALESCE(t.is_favorite, 0) as is_favorite,
           COALESCE(t.user_rating, 0) as user_rating,
           COALESCE(t.is_saved_for_later, 0) as is_saved_for_later,
           tl.integrated_lufs, tl.true_peak, tl.album_integrated_lufs,
           tl.track_gain_db, tl.album_gain_db, tl.album_peak, tl.reference_lufs
    FROM tracks t
    LEFT JOIN track_loudness tl ON tl.track_id = t.id
    WHERE (
      t.album_id = ?
      OR (t.album_id IS NULL AND t.album = ? AND t.album_artist = ?)
    )
    AND t.excluded = 0
    ORDER BY
      COALESCE(t.disc_number, 1) ASC,
      t.track_number ASC
  `).all(album.id, album.title, album.album_artist);

  res.json({
    ...album,
    is_favorite: !!album.is_favorite,
    is_saved_for_later: !!album.is_saved_for_later,
    album_type_locked: !!album.album_type_locked,
    cover_art: album.has_art ? `/api/library/albums/${album.id}/cover` : null,
    has_art: undefined,
    tracks,
  });
});

// POST /api/library/albums/:id/favorite — toggle or set favourite state
// Body: { value: boolean } — if omitted, toggles current state.
router.post('/albums/:id/favorite', (req, res) => {
  const database = db.get();
  const id = req.params.id;
  const existing = database.prepare('SELECT COALESCE(is_favorite, 0) as fav FROM albums WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Album not found' });
  const next = (typeof req.body?.value === 'boolean')
    ? (req.body.value ? 1 : 0)
    : (existing.fav ? 0 : 1);
  const now = Math.floor(Date.now() / 1000);
  database.prepare('UPDATE albums SET is_favorite = ?, favorited_at = ? WHERE id = ?')
    .run(next, next ? now : null, id);
  invalidateCache();
  res.json({ ok: true, is_favorite: !!next });
});

// v1.1.0.58 — track-level favourite. Toggles tracks.is_favorite.
// Body { value: boolean } sets explicitly; omit value to toggle.
// Independent of album favourites — a single starred track from an
// album the user doesn't otherwise care about is the common case.
router.post('/tracks/:id/favorite', (req, res) => {
  const database = db.get();
  const id = req.params.id;
  const existing = database.prepare('SELECT COALESCE(is_favorite, 0) as fav FROM tracks WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Track not found' });
  const next = (typeof req.body?.value === 'boolean')
    ? (req.body.value ? 1 : 0)
    : (existing.fav ? 0 : 1);
  const now = Math.floor(Date.now() / 1000);
  database.prepare('UPDATE tracks SET is_favorite = ?, favorited_at = ? WHERE id = ?')
    .run(next, next ? now : null, id);
  invalidateCache();
  res.json({ ok: true, is_favorite: !!next });
});

// v1.1.0.58 — track-level user rating, 0-5 stars. 0 means unrated.
// Body { rating: 0-5 }. Higher values are clamped; non-integers are
// floored.
router.post('/tracks/:id/rating', (req, res) => {
  const database = db.get();
  const id = req.params.id;
  const existing = database.prepare('SELECT id FROM tracks WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Track not found' });
  let rating = parseInt(req.body?.rating, 10);
  if (!Number.isFinite(rating)) return res.status(400).json({ error: 'rating (0-5 integer) required' });
  if (rating < 0) rating = 0;
  if (rating > 5) rating = 5;
  database.prepare('UPDATE tracks SET user_rating = ? WHERE id = ?').run(rating, id);
  invalidateCache();
  res.json({ ok: true, user_rating: rating });
});

// ──────────────────────────────────────────────────────────────────────
// v1.1.0.67 — Save for later (album + track)
//
// A single boolean column per row, mirroring the favourites schema.
// Toggle endpoints mirror the favourite toggles; list endpoints
// mirror the favourites list endpoint. Conceptually equivalent to a
// special-cased "Saved" tag but kept as a column because the UI
// surfaces it as a primary action separate from arbitrary user tags.

router.post('/albums/:id/save-for-later', (req, res) => {
  const database = db.get();
  const id = req.params.id;
  const existing = database.prepare('SELECT COALESCE(is_saved_for_later, 0) as s FROM albums WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Album not found' });
  const next = (typeof req.body?.value === 'boolean')
    ? (req.body.value ? 1 : 0)
    : (existing.s ? 0 : 1);
  const now = Math.floor(Date.now() / 1000);
  database.prepare('UPDATE albums SET is_saved_for_later = ?, saved_for_later_at = ? WHERE id = ?')
    .run(next, next ? now : null, id);
  invalidateCache();
  res.json({ ok: true, is_saved_for_later: !!next });
});

router.post('/tracks/:id/save-for-later', (req, res) => {
  const database = db.get();
  const id = req.params.id;
  const existing = database.prepare('SELECT COALESCE(is_saved_for_later, 0) as s FROM tracks WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Track not found' });
  const next = (typeof req.body?.value === 'boolean')
    ? (req.body.value ? 1 : 0)
    : (existing.s ? 0 : 1);
  const now = Math.floor(Date.now() / 1000);
  database.prepare('UPDATE tracks SET is_saved_for_later = ?, saved_for_later_at = ? WHERE id = ?')
    .run(next, next ? now : null, id);
  invalidateCache();
  res.json({ ok: true, is_saved_for_later: !!next });
});

// v1.1.0.98 — Album type override.
//
// POST /api/library/albums/:id/type
//   { type: 'main' | 'ep' | 'single' | 'soundtrack' | 'deluxe' | 'limited' }
//     → set the type and lock so subsequent rescans don't clobber
//   { auto: true }
//     → clear the lock and re-derive immediately (using the title/
//       folder/heuristic logic — same as recomputeAlbumTypes does
//       for unlocked rows). User sees the auto value right away
//       without waiting for next scan.
//
// Either body is accepted; { type } takes precedence if both
// supplied (a body of { type: 'main', auto: true } locks to 'main').
//
// Validates the type against the known set. Unknown values 400
// rather than silently dropping — this is a write operation and
// the user should know if their request didn't take.
const VALID_ALBUM_TYPES = new Set(['main', 'ep', 'single', 'soundtrack', 'deluxe', 'limited']);
router.post('/albums/:id/type', (req, res) => {
  const database = db.get();
  const id = req.params.id;
  const album = database.prepare(`
    SELECT id, title, album_folder, track_count, total_duration
    FROM albums WHERE id = ?
  `).get(id);
  if (!album) return res.status(404).json({ error: 'Album not found' });

  const body = req.body || {};

  if (body.type !== undefined) {
    if (!VALID_ALBUM_TYPES.has(body.type)) {
      return res.status(400).json({
        error: `type must be one of: ${[...VALID_ALBUM_TYPES].join(', ')}`,
      });
    }
    database.prepare('UPDATE albums SET album_type = ?, album_type_locked = 1 WHERE id = ?')
      .run(body.type, id);
    invalidateCache();
    return res.json({ ok: true, album_type: body.type, album_type_locked: true });
  }

  if (body.auto === true) {
    // Re-derive using the same logic recomputeAlbumTypes uses.
    // We don't have MB secondary types stored yet, so the deriver
    // falls through to title/folder/heuristic — same as scan path.
    const derived = scanner.deriveAlbumType({
      title: album.title || '',
      folder: album.album_folder || '',
      trackCount: album.track_count || 0,
      totalDurationSec: album.total_duration || 0,
      mbReleaseGroupTypes: [],
    });
    database.prepare('UPDATE albums SET album_type = ?, album_type_locked = 0 WHERE id = ?')
      .run(derived, id);
    invalidateCache();
    return res.json({ ok: true, album_type: derived, album_type_locked: false });
  }

  return res.status(400).json({
    error: 'body must include { type: <one of valid> } or { auto: true }',
  });
});

// v1.1.1.0 — Bulk album type override.
//
// POST /api/library/albums/bulk-type
//   { ids: ['...', '...'], type: 'soundtrack' }
//     → set type and lock for every id
//   { ids: ['...', '...'], auto: true }
//     → clear lock and re-derive every id inline
//
// Capped at 500 ids per call — typical bulk operations are
// reclassifying a soundtrack folder (a few dozen) or fixing a
// pattern miss across the whole library (couple hundred). Beyond
// 500 and we're better off with a focused rescan after editing
// patterns.
//
// Returns { ok: true, updated: N, skipped: [{ id, reason }, ...] }
// where skipped surfaces ids that didn't exist or other per-row
// failures. Doesn't 404 the whole call when one id is bad — bulk
// operations should be tolerant.
//
// Runs in a single transaction so a failure mid-flight doesn't
// leave the table half-updated.
const BULK_TYPE_MAX_IDS = 500;
router.post('/albums/bulk-type', (req, res) => {
  const database = db.get();
  const body = req.body || {};

  if (!Array.isArray(body.ids) || body.ids.length === 0) {
    return res.status(400).json({ error: 'body.ids must be a non-empty array' });
  }
  if (body.ids.length > BULK_TYPE_MAX_IDS) {
    return res.status(400).json({
      error: `too many ids (max ${BULK_TYPE_MAX_IDS}). Split into multiple calls.`,
    });
  }
  if (!body.ids.every(id => typeof id === 'string' && id.length > 0 && id.length < 100)) {
    return res.status(400).json({ error: 'every id must be a non-empty string' });
  }

  const isAuto = body.auto === true;
  const isType = typeof body.type === 'string';
  if (isAuto === isType) {
    // Either both true or both false — both invalid.
    return res.status(400).json({ error: 'body must include { type } OR { auto: true }, not both' });
  }
  if (isType && !VALID_ALBUM_TYPES.has(body.type)) {
    return res.status(400).json({
      error: `type must be one of: ${[...VALID_ALBUM_TYPES].join(', ')}`,
    });
  }

  // De-dupe ids. A client could pass [a, a, b] without meaning to
  // count `a` twice.
  const uniqueIds = [...new Set(body.ids)];

  // Look up each row to (a) skip missing ids cleanly and (b) for
  // the auto path, get the title/folder needed to re-derive.
  const lookup = database.prepare(`
    SELECT id, title, album_folder, track_count, total_duration
    FROM albums WHERE id = ?
  `);

  const skipped = [];
  let updated = 0;

  const updateLocked = database.prepare(
    'UPDATE albums SET album_type = ?, album_type_locked = 1 WHERE id = ?'
  );
  const updateAuto = database.prepare(
    'UPDATE albums SET album_type = ?, album_type_locked = 0 WHERE id = ?'
  );

  const tx = database.transaction(() => {
    for (const id of uniqueIds) {
      const row = lookup.get(id);
      if (!row) {
        skipped.push({ id, reason: 'not_found' });
        continue;
      }
      if (isType) {
        updateLocked.run(body.type, id);
      } else {
        // Auto: re-derive inline. Same logic as the single-album
        // auto branch.
        const derived = scanner.deriveAlbumType({
          title: row.title || '',
          folder: row.album_folder || '',
          trackCount: row.track_count || 0,
          totalDurationSec: row.total_duration || 0,
          mbReleaseGroupTypes: [],
        });
        updateAuto.run(derived, id);
      }
      updated++;
    }
  });
  tx();

  invalidateCache();
  res.json({ ok: true, updated, skipped });
});

// List endpoints — newest-saved first. Same shape as /favorites for
// the album case so the existing list components can render either.
router.get('/saved/albums', (req, res) => {
  const database = db.get();
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
  const offset = parseInt(req.query.offset, 10) || 0;
  const rows = database.prepare(`
    SELECT id, title, album_artist, year, cover_art,
           COALESCE(is_favorite, 0) as is_favorite,
           saved_for_later_at
    FROM albums
    WHERE is_saved_for_later = 1 AND excluded = 0
    ORDER BY saved_for_later_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);
  res.json(rows);
});

router.get('/saved/tracks', (req, res) => {
  const database = db.get();
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
  const offset = parseInt(req.query.offset, 10) || 0;
  const rows = database.prepare(`
    SELECT id, title, artist, album_id, duration, track_number,
           saved_for_later_at
    FROM tracks
    WHERE is_saved_for_later = 1
    ORDER BY saved_for_later_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);
  res.json(rows);
});

// ──────────────────────────────────────────────────────────────────────
// v1.1.0.67 — Per-album / per-track tag assignments
//
// GET returns the current tag list for the entity.
// PUT sets the full tag list (idempotent — diffs against current and
// adds/removes as needed). Body: { tag_ids: number[] }.
//
// We keep the API as "set the full list" rather than separate add/
// remove endpoints because the UI is a checkbox list — the user
// ticks/unticks several tags and hits save. One round-trip with the
// final desired set is cleaner than juggling deltas in the client.
//
// Tags must already exist (be created via POST /api/tags first); this
// endpoint doesn't auto-create. The TagPicker UI calls POST /api/tags
// for new names then includes the returned id here.

function entityTagsRoute(entityKind) {
  // entityKind is 'album' or 'track'. We construct the link table name
  // and FK column dynamically. Any other value is a programming bug.
  const linkTable = entityKind === 'album' ? 'album_tags' : 'track_tags';
  const fkCol = entityKind === 'album' ? 'album_id' : 'track_id';
  const parentTable = entityKind === 'album' ? 'albums' : 'tracks';

  return {
    getTags(req, res) {
      const database = db.get();
      const id = req.params.id;
      const exists = database.prepare(`SELECT id FROM ${parentTable} WHERE id = ?`).get(id);
      if (!exists) return res.status(404).json({ error: `${entityKind} not found` });
      const rows = database.prepare(`
        SELECT t.id, t.name, t.color
        FROM ${linkTable} lt
        JOIN tags t ON t.id = lt.tag_id
        WHERE lt.${fkCol} = ?
        ORDER BY LOWER(t.name) ASC
      `).all(id);
      res.json(rows);
    },
    setTags(req, res) {
      const database = db.get();
      const id = req.params.id;
      const exists = database.prepare(`SELECT id FROM ${parentTable} WHERE id = ?`).get(id);
      if (!exists) return res.status(404).json({ error: `${entityKind} not found` });
      const wanted = Array.isArray(req.body?.tag_ids) ? req.body.tag_ids : null;
      if (!wanted) return res.status(400).json({ error: 'tag_ids array required' });
      // Sanitise: integers only.
      const wantedSet = new Set(wanted.map(n => parseInt(n, 10)).filter(Number.isFinite));
      // Validate that all tags exist before touching the link table.
      // SQLite has no IN-array binding; build the placeholders manually.
      if (wantedSet.size > 0) {
        const placeholders = Array.from(wantedSet).map(() => '?').join(',');
        const valid = database.prepare(`SELECT id FROM tags WHERE id IN (${placeholders})`)
          .all(...Array.from(wantedSet));
        if (valid.length !== wantedSet.size) {
          return res.status(400).json({ error: 'One or more tag_ids do not exist' });
        }
      }
      const tx = database.transaction(() => {
        const current = database.prepare(`SELECT tag_id FROM ${linkTable} WHERE ${fkCol} = ?`).all(id);
        const currentSet = new Set(current.map(r => r.tag_id));
        // Remove tags that aren't wanted any more.
        for (const tagId of currentSet) {
          if (!wantedSet.has(tagId)) {
            database.prepare(`DELETE FROM ${linkTable} WHERE ${fkCol} = ? AND tag_id = ?`).run(id, tagId);
          }
        }
        // Add tags that are newly wanted.
        const insertStmt = database.prepare(`INSERT OR IGNORE INTO ${linkTable} (${fkCol}, tag_id, added_at) VALUES (?, ?, ?)`);
        for (const tagId of wantedSet) {
          if (!currentSet.has(tagId)) {
            insertStmt.run(id, tagId, Date.now());
          }
        }
      });
      tx();
      // Return the new full list for the client to update its state.
      const rows = database.prepare(`
        SELECT t.id, t.name, t.color
        FROM ${linkTable} lt
        JOIN tags t ON t.id = lt.tag_id
        WHERE lt.${fkCol} = ?
        ORDER BY LOWER(t.name) ASC
      `).all(id);
      res.json(rows);
    },
  };
}

const albumTagsRoute = entityTagsRoute('album');
const trackTagsRoute = entityTagsRoute('track');

router.get('/albums/:id/tags', albumTagsRoute.getTags);
router.put('/albums/:id/tags', albumTagsRoute.setTags);
router.get('/tracks/:id/tags', trackTagsRoute.getTags);
router.put('/tracks/:id/tags', trackTagsRoute.setTags);

// GET /api/library/albums/:id/cover
router.get('/albums/:id/cover', (req, res) => {
  const database = db.get();
  const album = database.prepare('SELECT cover_art, cover_art_mime FROM albums WHERE id = ?').get(req.params.id);
  if (album?.cover_art) {
    const etag = `"${req.params.id}"`;
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.setHeader('Content-Type', album.cover_art_mime || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.setHeader('ETag', etag);
    return res.send(Buffer.from(album.cover_art));
  }
  res.status(404).end();
});

// GET /api/library/tracks/:id/cover — proxy via the album cover (#11)
router.get('/tracks/:id/cover', (req, res) => {
  const database = db.get();
  const row = database.prepare(`
    SELECT a.id as album_id, a.cover_art, a.cover_art_mime
    FROM tracks t
    LEFT JOIN albums a ON a.title = t.album AND a.album_artist = t.album_artist
    WHERE t.id = ?
  `).get(req.params.id);

  if (row?.cover_art) {
    const etag = `"alb-${row.album_id}"`;
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.setHeader('Content-Type', row.cover_art_mime || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.setHeader('ETag', etag);
    return res.send(Buffer.from(row.cover_art));
  }
  res.status(404).end();
});

// GET /api/library/albums/:id/related (#v1.1.0.99) — sections shown
// inline below the tracklist on the album page. Two parts:
//
//   - bio: the cached album bio (NULL if not yet fetched, or if all
//     sources returned no_match). This is a CACHE-ONLY read — we
//     don't trigger a network fetch on miss because the album page
//     should render fast. The bioScanner runs in the background and
//     fills the cache for any matched album over time.
//
//   - more_by_artist: up to 6 other albums by the same album_artist,
//     excluding this one. Sorted year DESC. Only includes albums
//     that aren't excluded. The list is empty when the artist has
//     no other albums in the library.
//
// All the data needed is in the local database — no network calls.
// Endpoint is therefore fast and safe to call on every album page
// load.
const _bioFetch = require('../bioFetch');
router.get('/albums/:id/related', (req, res) => {
  const database = db.get();
  const album = database.prepare(`
    SELECT id, album_artist FROM albums WHERE id = ?
  `).get(req.params.id);
  if (!album) return res.status(404).json({ error: 'Album not found' });

  // Cache-only bio read.
  let bio = null;
  try {
    const cached = _bioFetch.loadAlbumBio(album.id);
    // Surface the bio only if we actually have content to show. The
    // 'no_match' / 'no_mbid' rows mark "we tried, nothing found";
    // the section UI reads these as null and collapses to header-
    // only.
    if (cached && cached.fetch_status === 'ok' && cached.content && cached.content.trim()) {
      bio = {
        content: cached.content,
        source: cached.source,
        source_url: cached.source_url,
      };
    }
  } catch (e) {
    // Defensive — bio cache miss shouldn't break the whole endpoint.
    console.warn('[related] bio load failed:', e.message);
  }

  // More by this artist. Excludes the current album. Limited to 6 —
  // the UI shows a horizontal-scrolling row, so a small count keeps
  // the section feeling like a glance, not a full listing. If the
  // artist has more than 6 albums, the user can navigate to the
  // artist page for the full list.
  const moreByArtist = database.prepare(`
    SELECT id, title, album_artist, year, release_date,
           COALESCE(is_favorite, 0) as is_favorite,
           CASE WHEN cover_art IS NOT NULL THEN 1 ELSE 0 END as has_art
    FROM albums
    WHERE album_artist = ?
      AND id != ?
      AND excluded = 0
    ORDER BY year DESC NULLS LAST, title ASC
    LIMIT 6
  `).all(album.album_artist, album.id);

  res.json({
    bio,
    more_by_artist: moreByArtist.map(a => ({
      ...a,
      is_favorite: !!a.is_favorite,
      has_art: !!a.has_art,
      cover_art: a.has_art ? `/api/library/albums/${a.id}/cover` : null,
    })),
  });
});

// GET /api/library/tracks/:id
router.get('/tracks/:id', (req, res) => {
  const database = db.get();
  const track = database.prepare(`
    SELECT id, title, artist, album, album_artist, year, track_number, disc_number,
           duration, bitrate, sample_rate, bit_depth, channels, format, codec, file_size, path, genre,
           COALESCE(is_favorite, 0) as is_favorite,
           COALESCE(user_rating, 0) as user_rating
    FROM tracks WHERE id = ?
  `).get(req.params.id);
  if (!track) return res.status(404).json({ error: 'Not found' });
  res.json(track);
});

// GET /api/library/search
router.get('/search', (req, res) => {
  const database = db.get();
  const q = (req.query.q || '').trim();
  const type = req.query.type || 'tracks';
  if (!q) return res.json([]);
  const like = `%${q}%`;

  if (type === 'artists') {
    const artists = database.prepare(`
      SELECT album_artist as name, COUNT(DISTINCT id) as album_count
      FROM albums
      WHERE album_artist LIKE ? COLLATE NOCASE AND excluded = 0
      GROUP BY album_artist
      ORDER BY album_artist COLLATE NOCASE
      LIMIT 20
    `).all(like);
    return res.json(artists);
  }

  if (type === 'albums') {
    const albums = database.prepare(`
      SELECT id, title, album_artist, artist, year,
             CASE WHEN cover_art IS NOT NULL THEN '/api/library/albums/' || id || '/cover' ELSE NULL END as cover_art
      FROM albums
      WHERE (title LIKE ? COLLATE NOCASE OR album_artist LIKE ? COLLATE NOCASE) AND excluded = 0
      ORDER BY title COLLATE NOCASE
      LIMIT 30
    `).all(like, like);
    return res.json(albums);
  }

  try {
    const results = database.prepare(`
      SELECT t.id, t.title, t.artist, t.album, t.duration, t.format, t.codec
      FROM tracks t JOIN tracks_fts f ON t.rowid = f.rowid
      WHERE tracks_fts MATCH ? AND t.excluded = 0
      ORDER BY rank LIMIT 40
    `).all(`${q}*`);
    return res.json(results);
  } catch (e) {
    const results = database.prepare(`
      SELECT id, title, artist, album, duration, format, codec
      FROM tracks
      WHERE (title LIKE ? COLLATE NOCASE OR artist LIKE ? COLLATE NOCASE) AND excluded = 0
      LIMIT 40
    `).all(like, like);
    return res.json(results);
  }
});

// GET /api/library/artists
router.get('/artists', (req, res) => {
  const database = db.get();
  const data = cached('artists', () => database.prepare(`
    SELECT a.album_artist as name, COUNT(*) as album_count,
           CASE WHEN ar.logo IS NOT NULL THEN 1 ELSE 0 END as has_logo,
           ar.logo_source as logo_source
    FROM albums a
    LEFT JOIN artists ar ON ar.name = a.album_artist
    WHERE a.album_artist IS NOT NULL AND a.album_artist != 'Unknown Artist' AND a.excluded = 0
    GROUP BY a.album_artist
    ORDER BY a.album_artist COLLATE NOCASE
  `).all());
  res.json(data);
});

// GET /api/library/artists/:name — basic artist info row.
// Returns the artists row for this name, including mb_artist_id
// (which the client uses to know whether bio lookup is feasible
// for this artist before showing the About button as enabled).
router.get('/artists/:name', (req, res) => {
  const database = db.get();
  const name = decodeURIComponent(req.params.name);
  const row = database.prepare(`
    SELECT name, mb_artist_id,
           CASE WHEN logo IS NOT NULL THEN 1 ELSE 0 END AS has_logo,
           logo_source, logo_fetched_at
    FROM artists WHERE name = ?
  `).get(name);
  if (!row) return res.status(404).json({ error: 'Artist not found' });
  res.json({
    ...row,
    has_logo: !!row.has_logo,
    logo_url: row.has_logo ? `/api/library/artists/${encodeURIComponent(row.name)}/logo` : null,
  });
});

// GET /api/library/artists/:name/tracks — flattened track list for an artist,
// ordered by album (matching the Artist Albums page) and disc/track within
// each album. Used by the Play All / Queue All buttons (#12) on the artist
// album page so the client doesn't have to make N round-trips to gather every
// album's tracks separately.
//
// Query params:
//   sort=year|title — passed through to album ordering. Defaults to 'year DESC'
//                     to match the most common Artist Albums view.
//   primary=1     — restrict to albums where this artist is the album_artist
//                     (i.e. exclude collaborations). Default: include both.
router.get('/artists/:name/tracks', (req, res) => {
  const database = db.get();
  const name = decodeURIComponent(req.params.name);
  const primaryOnly = req.query.primary === '1';
  const sort = req.query.sort === 'title' ? 'title' : 'year';
  // ORDER BY year DESC matches the Artist Albums page's "newest first" default;
  // titles use COLLATE NOCASE for sensible alphabetic order.
  const albumOrder = sort === 'title'
    ? 'a.title COLLATE NOCASE ASC'
    : 'a.year DESC, a.title COLLATE NOCASE ASC';
  // We could do this as one big JOIN-and-ORDER, but it's clearer to fetch the
  // ordered album list first then walk the tracks per album. The track count
  // for any single artist is small enough that the extra query cost is
  // negligible compared to network round-trips it saves on the client.
  const albumPredicate = primaryOnly
    ? 'a.album_artist = ?'
    : '(a.album_artist = ? OR a.artist = ?)';
  const albumArgs = primaryOnly ? [name] : [name, name];
  const albums = database.prepare(`
    SELECT a.id, a.title, a.album_artist
    FROM albums a
    WHERE ${albumPredicate} AND a.excluded = 0
    ORDER BY ${albumOrder}
  `).all(...albumArgs);

  const tracks = [];
  const trackStmt = database.prepare(`
    SELECT id, title, artist, album, album_artist, track_number, disc_number,
           duration, bitrate, sample_rate, bit_depth, channels, format, codec
    FROM tracks
    WHERE album = ? AND album_artist = ? AND excluded = 0
    ORDER BY disc_number ASC, track_number ASC
  `);
  for (const a of albums) {
    const t = trackStmt.all(a.title, a.album_artist);
    for (const tr of t) tracks.push(tr);
  }
  res.json({ artist: name, albumCount: albums.length, trackCount: tracks.length, tracks });
});

// GET /api/library/favorites/tracks — flattened track list for every favourited
// album, ordered the same way the Favourites screen displays them (artist then
// title COLLATE NOCASE). Used by the Play All / Queue All buttons on the
// Favourites page (#4 / 28.4). Single round-trip rather than N album fetches.
router.get('/favorites/tracks', (req, res) => {
  const database = db.get();
  const albums = database.prepare(`
    SELECT id, title, album_artist
    FROM albums
    WHERE is_favorite = 1 AND track_count > 0 AND excluded = 0
    ORDER BY album_artist COLLATE NOCASE ASC, title COLLATE NOCASE ASC
  `).all();
  const tracks = [];
  const trackStmt = database.prepare(`
    SELECT id, title, artist, album, album_artist, track_number, disc_number,
           duration, bitrate, sample_rate, bit_depth, channels, format, codec
    FROM tracks
    WHERE album = ? AND album_artist = ? AND excluded = 0
    ORDER BY disc_number ASC, track_number ASC
  `);
  for (const a of albums) {
    const t = trackStmt.all(a.title, a.album_artist);
    for (const tr of t) tracks.push(tr);
  }
  res.json({ albumCount: albums.length, trackCount: tracks.length, tracks });
});

// GET /api/library/artists/:name/logo — serve logo binary
router.get('/artists/:name/logo', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const row = db.get().prepare('SELECT logo, logo_mime, logo_fetched_at FROM artists WHERE name = ?').get(name);
  if (!row?.logo) return res.status(404).end();
  res.setHeader('Content-Type', row.logo_mime || 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=604800'); // 7 days
  if (row.logo_fetched_at) res.setHeader('ETag', `"${row.logo_fetched_at}"`);
  res.send(row.logo);
});

// POST /api/library/artists/:name/logo — manual upload (raw body, image/*)
const express2 = require('express');
const upload = express2.raw({ type: 'image/*', limit: '5mb' });
router.post('/artists/:name/logo', upload, async (req, res) => {
  if (!req.body || !req.body.length) return res.status(400).json({ error: 'Empty body' });
  const name = decodeURIComponent(req.params.name);
  const mime = req.headers['content-type'] || 'image/png';
  const artistLogos = require('../artistLogos');
  await artistLogos.setManualLogo(name, req.body, mime);
  invalidateCache();
  res.json({ ok: true, source: 'manual' });
});

// DELETE /api/library/artists/:name/logo — clear (e.g. to retry fetch)
router.delete('/artists/:name/logo', (req, res) => {
  const artistLogos = require('../artistLogos');
  artistLogos.clearLogo(decodeURIComponent(req.params.name));
  invalidateCache();
  res.json({ ok: true });
});

// GET /api/library/genres
// Genres in tags are often comma-separated like "Pop, Rock, Metal" — split them and count each.
router.get('/genres', (req, res) => {
  const database = db.get();
  const data = cached('genres', () => {
    const { normaliseGenre } = require('../genreAlias');
    const rows = database.prepare(`
      SELECT genre FROM albums WHERE genre IS NOT NULL AND genre != '' AND excluded = 0
    `).all();
    const counts = new Map();
    for (const row of rows) {
      const parts = row.genre.split(/[,;\/]/).map(g => g.trim()).filter(Boolean);
      // De-dupe within a single album's tags so "Pop, Electronic, Electronique"
      // doesn't double-count Electronic for one album.
      const seenForRow = new Set();
      for (const p of parts) {
        const canonical = normaliseGenre(p);
        if (!canonical || seenForRow.has(canonical)) continue;
        seenForRow.add(canonical);
        counts.set(canonical, (counts.get(canonical) || 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  });
  res.json(data);
});

// v1.1.0.80 — Focus filter picks.
//
// GET /api/library/focus/options
//
// Returns the available picks per sub-section, computed from real
// library data so the UI doesn't show "1990s" if there are no
// 1990s albums, or a non-existent format.
//
// Shape:
//   {
//     formats:    [{ value: 'flac', label: 'FLAC', count: 1234 }, ...],
//     decades:    [{ value: 1970, label: '1970s', count: 89 }, ...],
//     genres:     [{ value: 'Rock', count: 456 }, ...],   // canonical names
//     artists:    [{ value: 'Pink Floyd', count: 14 }, ...], // top 50 by album count
//     lastPlayed: [{ value: 'day', label: 'Last 24 hours', count: 5 }, ...],
//     addedOn:    [{ value: 'day', label: 'Last 24 hours', count: 12 }, ...],
//   }
//
// Computed entirely from existing columns + play_history. No
// schema changes required for v80. (Bit depth / sample rate /
// channels are deferred to v81 because they need new columns
// populated via rebuildAlbumStats.)
router.get('/focus/options', (req, res) => {
  const database = db.get();
  // v1.1.0.91 — TTL bumped from default 30s to 1 hour. Focus options
  // only change when the library is scanned (new albums, edited tags,
  // newly-played tracks moving between time buckets). Recomputing on
  // every Focus open was producing a visible "loading…" state on
  // 54k+ track libraries because the genre normalisation loop has
  // to iterate every album row in JS. The scan invalidator already
  // calls invalidateCache() on completion, so a 1-hour TTL is safe:
  // - genuine library change → cache cleared, next /focus/options
  //   pays the cold-path cost once
  // - no library change → up to an hour stale, but the data is
  //   identical so user sees no difference
  // - play_history-driven buckets (lastPlayed) become stale faster,
  //   but the worst case is "Last 24 hours" count being slightly
  //   off until next library write. Acceptable.
  const data = cached('focus:options', () => {
    // Formats: derive from primary_format. Group lower-case raw
    // values; UI can pretty-print FLAC vs flac.
    const formatRows = database.prepare(`
      SELECT LOWER(primary_format) AS value, COUNT(*) AS count
      FROM albums
      WHERE excluded = 0 AND primary_format IS NOT NULL AND primary_format != ''
      GROUP BY LOWER(primary_format)
      ORDER BY value ASC
    `).all();
    const formats = formatRows.map(r => ({
      value: r.value,
      label: r.value.toUpperCase(),
      count: r.count,
    }));

    // Decades: floor(year/10)*10 grouped, only those that exist.
    const decadeRows = database.prepare(`
      SELECT (year / 10) * 10 AS value, COUNT(*) AS count
      FROM albums
      WHERE excluded = 0 AND year IS NOT NULL AND year > 0
      GROUP BY (year / 10) * 10
      ORDER BY value ASC
    `).all();
    const decades = decadeRows.map(r => ({
      value: r.value,
      label: `${r.value}s`,
      count: r.count,
    }));

    // v1.1.0.81 — Bit depth: only those present, smallest to largest.
    const bitDepthRows = database.prepare(`
      SELECT primary_bit_depth AS value, COUNT(*) AS count
      FROM albums
      WHERE excluded = 0 AND primary_bit_depth IS NOT NULL
      GROUP BY primary_bit_depth
      ORDER BY value ASC
    `).all();
    const bitDepths = bitDepthRows.map(r => ({
      value: r.value,
      label: `${r.value}-bit`,
      count: r.count,
    }));

    // v1.1.0.81 — Sample rate: only those present, smallest to
    // largest. Labels are human-readable kHz with the conventional
    // decimal where applicable (44.1 kHz vs 48 kHz).
    const sampleRateRows = database.prepare(`
      SELECT primary_sample_rate AS value, COUNT(*) AS count
      FROM albums
      WHERE excluded = 0 AND primary_sample_rate IS NOT NULL
      GROUP BY primary_sample_rate
      ORDER BY value ASC
    `).all();
    const formatSampleRate = (hz) => {
      // 44100 → "44.1 kHz", 48000 → "48 kHz", 88200 → "88.2 kHz", etc.
      const k = hz / 1000;
      const isInteger = Math.abs(k - Math.round(k)) < 0.05;
      return isInteger ? `${Math.round(k)} kHz` : `${k.toFixed(1)} kHz`;
    };
    const sampleRates = sampleRateRows.map(r => ({
      value: r.value,
      label: formatSampleRate(r.value),
      count: r.count,
    }));

    // v1.1.0.81 — Channel layout. Common counts get human labels
    // (Mono / Stereo / 5.1 / 7.1); unusual counts fall back to
    // "{n}ch" so we don't drop them entirely.
    const channelRows = database.prepare(`
      SELECT primary_channels AS value, COUNT(*) AS count
      FROM albums
      WHERE excluded = 0 AND primary_channels IS NOT NULL AND primary_channels > 0
      GROUP BY primary_channels
      ORDER BY value ASC
    `).all();
    const channelLabel = (n) => {
      if (n === 1) return 'Mono';
      if (n === 2) return 'Stereo';
      if (n === 6) return '5.1';
      if (n === 8) return '7.1';
      return `${n}ch`;
    };
    const channels = channelRows.map(r => ({
      value: r.value,
      label: channelLabel(r.value),
      count: r.count,
    }));

    // Genres: reuse the same alias-aware counting logic the /genres
    // endpoint already does. We need canonical names so the user's
    // tick maps cleanly to filtering on canonical+aliases later.
    const { normaliseGenre } = require('../genreAlias');
    const genreRowsRaw = database.prepare(`
      SELECT genre FROM albums WHERE genre IS NOT NULL AND genre != '' AND excluded = 0
    `).all();
    const genreCounts = new Map();
    for (const row of genreRowsRaw) {
      const parts = row.genre.split(/[,;\/]/).map(g => g.trim()).filter(Boolean);
      const seenForRow = new Set();
      for (const p of parts) {
        const canonical = normaliseGenre(p);
        if (!canonical || seenForRow.has(canonical)) continue;
        seenForRow.add(canonical);
        genreCounts.set(canonical, (genreCounts.get(canonical) || 0) + 1);
      }
    }
    const genres = Array.from(genreCounts.entries())
      .map(([value, count]) => ({ value, count }))
      // Genre column displays alphabetically per spec: name-based
      // sub-sections sort A→Z. The `count` is for tooltip / future
      // use; not the sort key.
      .sort((a, b) => a.value.localeCompare(b.value));

    // Artists: top 50 by album count. The full library is typically
    // 1000-3000 distinct artists which would be impossible to scroll
    // in a Focus column. The UI also exposes a search box (server-
    // side q= param against this list, future work) for the long
    // tail.
    const artistRows = database.prepare(`
      SELECT album_artist AS value, COUNT(*) AS count
      FROM albums
      WHERE excluded = 0 AND album_artist IS NOT NULL AND album_artist != ''
      GROUP BY album_artist
      ORDER BY count DESC, value COLLATE NOCASE ASC
      LIMIT 50
    `).all();
    const artists = artistRows
      .map(r => ({ value: r.value, count: r.count }))
      // Once we've got the top 50 by count, present them
      // alphabetically in the column (per spec — name-based A→Z).
      .sort((a, b) => a.value.localeCompare(b.value));

    // Last played / Added on: bucket counts. The buckets are time
    // ranges, ordered shortest-to-longest:
    //   day    = last 24h
    //   week   = last 7 days
    //   month  = last 30 days
    //   longer = older than 30 days OR never (for last_played)
    // Bucket counts here are inclusive — "week" includes "day" —
    // because the UI ticks correspond to inclusive ranges
    // ("played in the last week" includes albums played today).
    const now = Math.floor(Date.now() / 1000);
    const DAY = 86400;
    const lastPlayedCount = (cutoffSec) => database.prepare(`
      SELECT COUNT(DISTINCT album_artist || char(0) || album_title) AS c
      FROM play_history
      WHERE played_at > ?
    `).get(cutoffSec).c;
    const lastPlayed = [
      { value: 'day',    label: 'Last 24 hours', count: lastPlayedCount(now - 1*DAY) },
      { value: 'week',   label: 'Last 7 days',   count: lastPlayedCount(now - 7*DAY) },
      { value: 'month',  label: 'Last 30 days',  count: lastPlayedCount(now - 30*DAY) },
      // 'longer' = older than 30 days OR never; computed on the
      // album side as "total albums minus recently-played albums".
      { value: 'longer', label: 'Longer ago',    count: 0 },
    ];
    const totalAlbums = database.prepare(`SELECT COUNT(*) AS c FROM albums WHERE excluded = 0`).get().c;
    lastPlayed[3].count = Math.max(0, totalAlbums - lastPlayed[2].count);

    const addedOnCount = (cutoffSec) => database.prepare(`
      SELECT COUNT(*) AS c FROM albums
      WHERE excluded = 0 AND added_at > ?
    `).get(cutoffSec).c;
    const addedOn = [
      { value: 'day',    label: 'Last 24 hours', count: addedOnCount(now - 1*DAY) },
      { value: 'week',   label: 'Last 7 days',   count: addedOnCount(now - 7*DAY) },
      { value: 'month',  label: 'Last 30 days',  count: addedOnCount(now - 30*DAY) },
      { value: 'longer', label: 'Longer ago',    count: 0 },
    ];
    addedOn[3].count = Math.max(0, totalAlbums - addedOn[2].count);

    // v1.1.0.97 — Album Type facet. Six values, displayed in this
    // order so the most-used categories (Main, EP, Single) lead.
    // We surface only types that have at least one album in the
    // current library — empty buckets are omitted so the user
    // doesn't see a meaningless "Soundtrack: 0" row.
    const ALBUM_TYPE_LABELS = {
      main:       'Main',
      ep:         'EP',
      single:     'Single',
      soundtrack: 'Soundtrack',
      deluxe:     'Deluxe',
      limited:    'Limited',
    };
    const ALBUM_TYPE_ORDER = ['main', 'ep', 'single', 'soundtrack', 'deluxe', 'limited'];
    const albumTypeRows = database.prepare(`
      SELECT album_type AS value, COUNT(*) AS count
      FROM albums
      WHERE excluded = 0 AND album_type IS NOT NULL
      GROUP BY album_type
    `).all();
    const albumTypeCounts = Object.fromEntries(albumTypeRows.map(r => [r.value, r.count]));
    const albumTypes = ALBUM_TYPE_ORDER
      .filter(t => (albumTypeCounts[t] || 0) > 0)
      .map(t => ({
        value: t,
        label: ALBUM_TYPE_LABELS[t],
        count: albumTypeCounts[t],
      }));

    return {
      formats,
      decades,
      bitDepths,
      sampleRates,
      channels,
      genres,
      artists,
      albumTypes,
      lastPlayed,
      addedOn,
    };
  }, 60 * 60 * 1000); // 1 hour TTL — see comment above
  res.setHeader('Cache-Control', 'private, max-age=60');
  res.json(data);
});

// v1.1.25.0 — the saved-focus CRUD that lived here is gone.
//
// The only screen that could list, load, rename or delete a saved focus was
// the Focus library in the side menu, and the owner removed it on the grounds
// that a focus combination worth keeping is a tag. Leaving the routes would
// have left four endpoints nothing calls, and leaving the client's Save
// buttons would have been worse: rows written that nothing can ever read
// again.
//
// The saved_focuses TABLE is deliberately still created by db.js. Dropping it
// would destroy whatever anyone had saved, to gain nothing — an unused table
// costs a schema line. See the note there.

// v1.1.0.83 — Focus sub-section order persistence.
//
// The user can drag column titles in the Focus bar to reorder
// sub-sections (e.g. move Artist to first position). The custom
// order persists across reloads and applies to every Focus bar
// render.
//
// Storage: a single key `focus_section_order` in the existing
// settings table, value is a JSON array of section keys in the
// user's chosen order. NULL/missing → use the default (which the
// client knows; we don't ship the default order from the server).
//
// Validation: keys must be strings, no duplicates. Unknown keys
// are accepted server-side — a saved order from a future client
// might mention sections this server doesn't know about, and we
// shouldn't reject legitimate writes. The client filters at render
// time.

const FOCUS_SECTION_ORDER_KEY = 'focus_section_order';

// GET /api/library/focus/section-order
//   → { order: string[] | null }
router.get('/focus/section-order', (req, res) => {
  try {
    const database = db.get();
    const row = database.prepare('SELECT value FROM settings WHERE key = ?')
      .get(FOCUS_SECTION_ORDER_KEY);
    if (!row) return res.json({ order: null });
    let parsed;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      // Stale or hand-edited; pretend it doesn't exist
      return res.json({ order: null });
    }
    if (!Array.isArray(parsed)) return res.json({ order: null });
    res.json({ order: parsed });
  } catch (e) {
    console.error('[focus] get section order failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/library/focus/section-order
//   body: { order: string[] }
//   → { ok: true }
router.put('/focus/section-order', (req, res) => {
  const order = req.body?.order;
  if (!Array.isArray(order)) {
    return res.status(400).json({ error: 'order must be an array of section keys' });
  }
  // Sanity bounds — order shouldn't be giant. 32 is a generous cap
  // for any plausible future expansion of FOCUS_SECTIONS.
  if (order.length > 32) {
    return res.status(400).json({ error: 'order has too many entries' });
  }
  // All entries must be non-empty strings.
  if (!order.every(k => typeof k === 'string' && k.length > 0 && k.length < 64)) {
    return res.status(400).json({ error: 'order entries must be non-empty strings' });
  }
  // Reject duplicates — a user-correct order has each key at most
  // once, and a duplicate would cause render bugs (React key
  // collisions).
  if (new Set(order).size !== order.length) {
    return res.status(400).json({ error: 'order contains duplicate entries' });
  }
  try {
    const database = db.get();
    database.prepare(`
      INSERT INTO settings (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(FOCUS_SECTION_ORDER_KEY, JSON.stringify(order));
    res.json({ ok: true });
  } catch (e) {
    console.error('[focus] set section order failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/library/focus/section-order
//   → { ok: true }
//
// Resets to the default order (client-known). Used by the "Reset
// order" button in the Focus bar.
router.delete('/focus/section-order', (req, res) => {
  try {
    const database = db.get();
    database.prepare('DELETE FROM settings WHERE key = ?').run(FOCUS_SECTION_ORDER_KEY);
    res.json({ ok: true });
  } catch (e) {
    console.error('[focus] reset section order failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/library/stats
router.get('/stats', (req, res) => {
  const database = db.get();
  const data = cached('stats', () => {
    const totals = database.prepare(`
      SELECT COUNT(*) as total_tracks,
             COUNT(DISTINCT album_artist || char(0) || album) as total_albums,
             COUNT(DISTINCT album_artist) as total_artists,
             SUM(duration) as total_duration,
             SUM(file_size) as total_size
      FROM tracks
      WHERE excluded = 0
    `).get();
    const formats = database.prepare(`
      SELECT primary_format as format, COUNT(*) as count
      FROM albums WHERE primary_format IS NOT NULL AND excluded = 0
      GROUP BY primary_format ORDER BY count DESC
    `).all();
    return { ...totals, formats };
  });
  res.json(data);
});

// GET /api/library/status — current scan/enrichment progress
router.get('/status', (req, res) => {
  const scanner = require('../scanner');
  res.json(scanner.getStatus());
});

// POST /api/library/scan
router.post('/scan', async (req, res) => {
  invalidateCache();
  const scanner = require('../scanner');
  const musicDir = process.env.MUSIC_DIR || '/music';
  res.json({ ok: true, message: 'Scan started' });
  scanner.scan(musicDir).then(() => invalidateCache()).catch(console.error);
});

// POST /api/library/artwork
router.post('/artwork', async (req, res) => {
  res.json({ ok: true });
  const database = db.get();
  const { findCoverArt } = require('../coverArt');
  const missing = database.prepare(`
    SELECT a.id, a.title, a.album_artist,
           (SELECT path FROM tracks WHERE album=a.title AND album_artist=a.album_artist LIMIT 1) as sample_path
    FROM albums a WHERE a.cover_art IS NULL AND a.excluded = 0
  `).all();
  console.log(`🌐 Artwork enrichment: ${missing.length} albums`);
  for (const album of missing) {
    try {
      const art = await findCoverArt(album.sample_path||'', null, null, album.album_artist, album.title);
      if (art) {
        database.prepare('UPDATE albums SET cover_art=?, cover_art_mime=? WHERE id=?').run(art.data, art.mime, album.id);
        console.log(`  ✓ ${album.album_artist} — ${album.title}`);
      }
    } catch {}
  }
  invalidateCache();
  if (global.broadcastState) global.broadcastState('library_updated', { artwork: true });
});

// POST /api/library/artwork-album
router.post('/artwork-album', async (req, res) => {
  const { albumId, artist, title } = req.body;
  if (!albumId) return res.status(400).json({ error: 'albumId required' });
  res.json({ ok: true });
  const database = db.get();
  const { findCoverArt } = require('../coverArt');
  const sample = database.prepare('SELECT path FROM tracks WHERE album=? AND album_artist=? LIMIT 1').get(title, artist);
  try {
    const art = await findCoverArt(sample?.path||'', null, null, artist, title);
    if (art) {
      database.prepare('UPDATE albums SET cover_art=?, cover_art_mime=? WHERE id=?').run(art.data, art.mime, albumId);
      invalidateCache();
      if (global.broadcastState) global.broadcastState('library_updated', { albumId });
    }
  } catch (e) {}
});


// POST /api/library/backfill-genres — re-extract genre tag for tracks where it's missing
router.post('/backfill-genres', async (req, res) => {
  res.json({ ok: true, message: 'Backfill started' });

  const { parseFile } = require('music-metadata');
  const database = db.get();
  const missing = database.prepare(`
    SELECT id, path FROM tracks WHERE (genre IS NULL OR genre = '') AND excluded = 0
  `).all();

  console.log(`🎶 Backfilling genres for ${missing.length} tracks...`);

  const update = database.prepare('UPDATE tracks SET genre = ? WHERE id = ?');
  let updated = 0;
  let processed = 0;

  // Process in chunks to avoid blocking
  const CHUNK = 16;
  for (let i = 0; i < missing.length; i += CHUNK) {
    await Promise.all(missing.slice(i, i + CHUNK).map(async (track) => {
      try {
        const meta = await parseFile(track.path, { skipCovers: true });
        const g = (Array.isArray(meta.common.genre) ? meta.common.genre[0] : meta.common.genre) || null;
        if (g) {
          update.run(g.replace(/[\x00-\x1F\x7F]/g, ''), track.id);
          updated++;
        }
      } catch (e) {}
    }));
    processed += CHUNK;
    if (processed % 1000 === 0 || processed >= missing.length) {
      console.log(`  ... ${Math.min(processed, missing.length)} / ${missing.length} (${updated} with genre)`);
    }
  }

  // Now propagate genres up to album rows that lack them
  console.log('📊 Propagating genres to albums...');
  database.exec(`
    UPDATE albums SET genre = (
      SELECT t.genre FROM tracks t
      WHERE t.album = albums.title AND t.album_artist = albums.album_artist
        AND t.genre IS NOT NULL AND t.genre != ''
      LIMIT 1
    ) WHERE genre IS NULL OR genre = ''
  `);

  invalidateCache();
  console.log(`✅ Genre backfill complete — ${updated} tracks updated`);
  if (global.broadcastState) global.broadcastState('library_updated', { genres: true });
});


// ── Library scope (#30.9) ─────────────────────────────────────────────
//
// The user picks which subfolders under /music are scanned. Selection is
// stored as an array of absolute paths in settings.library_scope. Tracks
// outside the active scope are kept in the database with excluded=1
// (soft delete) so re-including a folder restores favourites and play
// counts instantly.
//
// GET    /api/library/scope            — active list with per-path counts
// POST   /api/library/scope            — { path, action: 'add' | 'remove' }
// GET    /api/library/browse?path=...  — immediate children of a folder
//                                        (for the lazy-load tree browser)

const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const libraryScope = require('../libraryScope');

router.get('/scope', (req, res) => {
  const database = db.get();
  const scope = libraryScope.getScope();
  // Annotate each entry with the database stats for that subtree. Cheap:
  // the excluded index lets SQLite cull most rows on a removed folder
  // and the LIKE-range scan is short for any reasonable path. We use
  // active counts so the UI shows what's currently visible to the user.
  const stmt = database.prepare(`
    SELECT COUNT(*) AS tracks
    FROM tracks
    WHERE excluded = 0 AND (path = ? OR path LIKE ? || '/%')
  `);
  const annotated = scope.map(p => {
    const r = stmt.get(p, p);
    return { path: p, tracks: r?.tracks || 0 };
  });
  res.json({
    scope: annotated,
    musicRoot: libraryScope.MUSIC_ROOT,
  });
});

router.post('/scope', async (req, res) => {
  const { path: rawPath, action } = req.body || {};
  if (!rawPath || !action) {
    return res.status(400).json({ error: 'path and action required' });
  }
  if (action !== 'add' && action !== 'remove') {
    return res.status(400).json({ error: 'action must be add or remove' });
  }
  try {
    let result;
    if (action === 'add') {
      result = libraryScope.addToScope(rawPath);
    } else {
      result = libraryScope.removeFromScope(rawPath);
    }
    invalidateCache();
    // Apply the change asynchronously — for adds this kicks a scan that
    // can take a while. We return immediately so the UI stays responsive;
    // progress is broadcast over the existing library_status WS channel.
    const scanner = require('../scanner');
    if (action === 'add' && result.status !== 'already_covered') {
      scanner.applyScopeChange({ addedPath: libraryScope.normalisePath(rawPath) })
        .catch(err => console.warn('applyScopeChange failed:', err.message));
    } else {
      // Remove or no-op — just reconcile flags + broadcast.
      scanner.applyScopeChange()
        .catch(err => console.warn('applyScopeChange failed:', err.message));
    }
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// GET /api/library/browse?path=/music/Albums
//
// Returns immediate children of the given path. Used by the tree browser
// in Settings — each click on a disclosure triangle fetches one level.
//
// Response:
//   { path: '/music/Albums', children: [
//       { name: 'Bowie', path: '/music/Albums/Bowie', isDir: true,
//         audioFiles: 0, hasSubdirs: true },
//       ...
//   ] }
//
// audioFiles counts files at this level only (not recursive). hasSubdirs
// is true iff the folder contains at least one subdirectory. Both let
// the UI show a useful "X audio files / has more folders" summary
// without walking the whole subtree.
//
// Path is required and must be under MUSIC_ROOT — we reject anything
// else for safety. Files (non-directories) are filtered out: only
// directories are returned, since the user can only select folders.
router.get('/browse', async (req, res) => {
  const rawPath = req.query.path;
  if (!rawPath) return res.status(400).json({ error: 'path required' });
  const normalised = libraryScope.normalisePath(rawPath);
  if (!normalised) return res.status(400).json({ error: 'invalid path' });

  try {
    const stat = await fsPromises.stat(normalised);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: 'not a directory' });
    }
  } catch (e) {
    return res.status(404).json({ error: 'path not found' });
  }

  const AUDIO_EXTS = new Set([
    '.flac', '.mp3', '.dsf', '.dff', '.dsd',
    '.wav', '.aiff', '.aif', '.ogg', '.opus', '.m4a', '.wv'
  ]);

  let entries;
  try {
    entries = await fsPromises.readdir(normalised, { withFileTypes: true });
  } catch (e) {
    return res.status(500).json({ error: 'failed to read directory: ' + e.message });
  }

  const children = [];
  // Count audio files at this level for the parent (helps the UI decide
  // whether the parent itself is worth selecting). We track this on the
  // parent payload, not on each child.
  let audioFilesAtThisLevel = 0;
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const childPath = path.join(normalised, entry.name);
    if (entry.isDirectory()) {
      // Peek inside to determine quick metadata. We read the child
      // directory once for both audioFiles count and hasSubdirs flag.
      let audioCount = 0;
      let hasSubdirs = false;
      try {
        const inner = await fsPromises.readdir(childPath, { withFileTypes: true });
        for (const e of inner) {
          if (e.name.startsWith('.')) continue;
          if (e.isDirectory()) hasSubdirs = true;
          else if (e.isFile()) {
            const ext = path.extname(e.name).toLowerCase();
            if (AUDIO_EXTS.has(ext)) audioCount++;
          }
        }
      } catch {} // unreadable subdirs are reported with zero counts
      children.push({
        name: entry.name,
        path: childPath,
        isDir: true,
        audioFiles: audioCount,
        hasSubdirs,
      });
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (AUDIO_EXTS.has(ext)) audioFilesAtThisLevel++;
    }
  }

  // Sort children alphabetically (case-insensitive) so the UI order is
  // stable across requests. Folders with content at the top would also
  // be a valid sort but alphabetic matches what users expect from a
  // file browser.
  children.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  // Annotate which children are already in scope (or covered by an
  // ancestor in scope). The UI uses this to mark them as already-active.
  const scope = libraryScope.getScope();
  for (const child of children) {
    child.inScope = scope.some(s => child.path === s || child.path.startsWith(s + '/') || s.startsWith(child.path + '/'));
    // Also distinguish: covered-by-ancestor (this exact path is under
    // an ancestor scope entry) vs exactly-listed (this path is itself
    // in the scope list). The UI shows different treatment for each:
    // covered-by-ancestor = "included via parent" hint; exactly-listed
    // = remove button.
    child.exactlyListed = scope.includes(child.path);
    child.coveredByAncestor = scope.some(s => s !== child.path && child.path.startsWith(s + '/'));
  }

  res.json({
    path: normalised,
    audioFilesAtThisLevel,
    children,
  });
});

// ── Database backups (#30.10) ──────────────────────────────────────────
//
// Manual snapshot of the user's musicd state (database + DSP folders)
// to /mnt/backups, packaged as .tar.gz. The mount is optional — older
// docker run commands won't have it. The endpoints surface configuration
// state in their responses so the UI can render a "not configured" hint
// rather than failing silently.
//
// GET    /api/library/backups                — config + list
// POST   /api/library/backups                — create new backup
// GET    /api/library/backups/:filename      — download a backup
// DELETE /api/library/backups/:filename      — delete a backup
//
// Filename validation lives in the backup module; routes treat invalid
// names as 400 Bad Request without leaking the reason.

const backup = require('../backup');

router.get('/backups', async (req, res) => {
  try {
    const result = await backup.listBackups();
    result.running = backup.isRunning();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/backups', tierMiddleware.requireFeature('backup_restore'), async (req, res) => {
  try {
    const result = await backup.createBackup();
    invalidateCache();
    res.json({ ok: true, backup: result });
  } catch (e) {
    // Distinguish "not configured" (400) from "already running" (409)
    // from "actual failure" (500) so the UI can show the right message.
    if (/not configured/i.test(e.message)) return res.status(400).json({ error: e.message });
    if (/already in progress/i.test(e.message)) return res.status(409).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

router.get('/backups/:filename', (req, res) => {
  const p = backup.pathForDownload(req.params.filename);
  if (!p) return res.status(404).json({ error: 'Not found' });
  // Stream the file with the right headers so the browser saves it
  // rather than trying to render it. Content-Disposition: attachment
  // is the canonical way; we also set the right MIME type for .tar.gz
  // so browsers that ignore Content-Disposition still don't try to
  // unpack it inline.
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.filename}"`);
  res.sendFile(p);
});

router.delete('/backups/:filename', async (req, res) => {
  try {
    await backup.deleteBackup(req.params.filename);
    res.json({ ok: true });
  } catch (e) {
    if (/Invalid/i.test(e.message)) return res.status(400).json({ error: e.message });
    if (/not configured/i.test(e.message)) return res.status(400).json({ error: e.message });
    if (e.code === 'ENOENT') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: e.message });
  }
});

// POST /api/library/backups/:filename/restore (#v1.1.0.2)
//
// Stages a backup for restore on the next container start. We never
// overwrite the live DB while the app is running -- that would
// corrupt SQLite WAL state. Instead we extract the .tar.gz into
// /data/.pending-restore/, and the entrypoint.sh swaps it in on
// next boot before Node even starts.
//
// Body (optional): { restart: true } -- if set, the server triggers
// a `docker restart musicd` after staging. Without it, the staged
// backup just waits until the next manual restart.
router.post('/backups/:filename/restore', tierMiddleware.requireFeature('backup_restore'), async (req, res) => {
  try {
    await backup.stageRestore(req.params.filename);
    const restart = !!(req.body && req.body.restart);
    res.json({ ok: true, restart });
    if (restart) {
      // Self-restart via docker socket. Best-effort -- if the socket
      // isn't mounted (no auto-update setup), we return ok without
      // restarting and the UI tells the user to restart manually.
      setTimeout(() => {
        backup.selfRestart().catch(e => console.warn('[restore] self-restart failed:', e.message));
      }, 500);
    }
  } catch (e) {
    if (/Invalid/i.test(e.message)) return res.status(400).json({ error: e.message });
    if (e.code === 'ENOENT') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: e.message });
  }
});


// ── Metadata matching (#30.19) ────────────────────────────────────────
//
// Album-level matching against MusicBrainz. The user supplies a
// contact (URL/email) for MB's TOS, then triggers the matcher; it
// runs in the background, throttled to 1 req/sec.
//
// GET    /api/library/match/progress       -- polled by UI for status
// POST   /api/library/match/start          -- kicks off (validates contact)
// POST   /api/library/match/stop           -- pause
// POST   /api/library/match/reset          -- mark everything pending again
// GET    /api/library/unmatched            -- list uncertain + unmatched
// GET    /api/library/match/:id/candidates -- candidates for one album

const metadataMatch = require('../metadataMatch');

router.get('/match/progress', (req, res) => {
  const progress = metadataMatch.getProgress();
  // Include unmatched count so the sidebar (which polls this same
  // endpoint) can decide whether to render the "Unmatched" menu item.
  // Cheaper than two separate endpoints, same shape regardless of
  // whether matcher is running.
  progress.unmatchedCount = metadataMatch.getUnmatchedCount();
  res.json(progress);
});

router.post('/match/start', async (req, res) => {
  try {
    const database = db.get();
    const settings = database.prepare(`SELECT value FROM settings WHERE key = 'mb_contact'`).get();
    const contact = (settings?.value || '').trim();
    if (!contact) {
      return res.status(400).json({
        error: 'No contact configured. Set a URL or email in Settings → Metadata Refresh before matching.',
      });
    }
    await metadataMatch.start(contact);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/match/stop', (req, res) => {
  metadataMatch.stop();
  res.json({ ok: true });
});

router.post('/match/reset', (req, res) => {
  try {
    metadataMatch.resetAll();
    invalidateCache();
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// v1.1.0.66 — diagnostic for the unmatched set. Runs the v66
// title/artist cleaners against every currently-unmatched album
// without hitting MusicBrainz, so the user can see how many of
// their unmatched albums would be re-queried with a different
// (cleaner) string under the v66 matcher. The samples array
// contains up to 30 examples of albums where the cleaner would
// strip something — useful for previewing what a rematch run
// would attempt.
router.get('/match/diagnostic', (req, res) => {
  try {
    const sampleLimit = Math.min(parseInt(req.query.samples, 10) || 30, 200);
    const data = metadataMatch.previewDiagnostic({ sampleLimit });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// v1.1.0.66 — re-queue currently-unmatched/uncertain albums for
// re-processing through the v66 matcher. Doesn't start the worker
// itself — that's a separate POST /match/start, same as the normal
// flow. This is a two-step pattern so the user can review the
// diagnostic, decide to rematch, and explicitly kick off the run
// rather than us doing it implicitly. Albums that were
// manually-confirmed or tag-resolved are NOT re-queued.
router.post('/match/rematch-unmatched', (req, res) => {
  try {
    const queuedCount = metadataMatch.requeueUnmatched();
    invalidateCache();
    res.json({ ok: true, queuedCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List of albums that need triage -- uncertain or unmatched. Paginated
// so a 5000-album library doesn't dump everything in one response.
router.get('/unmatched', (req, res) => {
  const database = db.get();
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const offset = parseInt(req.query.offset, 10) || 0;
  const albums = database.prepare(`
    SELECT id, title, album_artist, year, track_count, primary_format,
           match_status, match_confidence, matched_at,
           CASE WHEN cover_art IS NOT NULL THEN 1 ELSE 0 END AS has_art
    FROM albums
    WHERE excluded = 0 AND match_status IN ('uncertain', 'unmatched')
    ORDER BY match_status DESC, album_artist, title
    LIMIT ? OFFSET ?
  `).all(limit, offset);
  const totalRow = database.prepare(`
    SELECT COUNT(*) AS c FROM albums
    WHERE excluded = 0 AND match_status IN ('uncertain', 'unmatched')
  `).get();
  res.json({
    total: totalRow?.c || 0,
    limit,
    offset,
    albums: albums.map(a => ({
      ...a,
      cover_art: a.has_art ? `/api/library/albums/${a.id}/cover` : null,
      has_art: undefined,
    })),
  });
});

// Top-N candidates for one album (whatever the matcher stored).
router.get('/match/:id/candidates', (req, res) => {
  const database = db.get();
  const row = database.prepare(`
    SELECT id, title, album_artist, year, track_count, match_status,
           match_confidence, match_candidates, matched_at, mb_release_group_id
    FROM albums WHERE id = ?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Album not found' });
  let candidates = [];
  try {
    candidates = JSON.parse(row.match_candidates || '[]');
  } catch {} // malformed JSON shouldn't kill the response
  res.json({
    album: {
      id: row.id,
      title: row.title,
      album_artist: row.album_artist,
      year: row.year,
      track_count: row.track_count,
      match_status: row.match_status,
      match_confidence: row.match_confidence,
      mbid: row.mb_release_group_id,
      matched_at: row.matched_at,
    },
    candidates,
  });
});

// ── Manual matching (#v1.1.0.21) ──────────────────────────────────────
//
// Three routes for user-driven match decisions:
//
//   POST /library/match/:id/confirm  body: { mbid, title?, artist?, year? }
//       Confirms a candidate (or an arbitrary MBID returned from the
//       /search route below). Marks the album as matched with confidence
//       100 and matched_by='manual'. If the candidates JSON doesn't
//       already contain the chosen MBID, we synthesise a minimal entry
//       so the album row's match_candidates remains consistent.
//
//   POST /library/match/:id/reject
//       The user has decided this album genuinely has no MB record (or
//       they don't care). We mark it match_status='rejected' which both
//       removes it from the unmatched list AND prevents the matcher
//       from picking it up again. matched_by='manual' so resetAll
//       preserves the rejection.
//
//   GET  /library/match/search?q=...&contact=...
//       Free-text MB release-group search. Used by the Unmatched UI's
//       "search MusicBrainz" box for albums where the matcher's
//       title/artist query found nothing useful. Returns up to 25
//       results in the same shape as match_candidates.

router.post('/match/:id/confirm', (req, res) => {
  const { mbid, title, artist, year } = req.body || {};
  if (!mbid || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(mbid)) {
    return res.status(400).json({ error: 'mbid required (UUID format)' });
  }
  const database = db.get();
  const row = database.prepare(
    'SELECT id, title, album_artist, match_candidates FROM albums WHERE id = ?'
  ).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Album not found' });

  // Synthesise/update candidates so the row records what the user
  // chose, even if the chosen mbid wasn't in the original auto-matcher
  // candidates list (e.g. it came from manual MB search).
  let candidates = [];
  try { candidates = JSON.parse(row.match_candidates || '[]'); } catch {}
  const present = candidates.find(c => c.mbid === mbid);
  if (!present) {
    candidates.unshift({
      mbid,
      title: title || row.title,
      artist: artist || row.album_artist,
      firstReleaseDate: year ? `${year}` : null,
      score: 100,
      source: 'manual',
    });
    candidates = candidates.slice(0, 5);
  }

  database.prepare(`
    UPDATE albums
    SET mb_release_group_id = ?,
        match_status = 'matched',
        match_confidence = 100,
        match_candidates = ?,
        matched_at = ?,
        matched_by = 'manual'
    WHERE id = ?
  `).run(mbid, JSON.stringify(candidates), Math.floor(Date.now() / 1000), row.id);
  // v1.1.0.78 — matched_at in unix seconds (schema-wide).

  res.json({ ok: true, mbid, id: row.id });
});

router.post('/match/:id/reject', (req, res) => {
  const database = db.get();
  const row = database.prepare('SELECT id FROM albums WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Album not found' });
  database.prepare(`
    UPDATE albums
    SET match_status = 'rejected',
        matched_at = ?,
        matched_by = 'manual'
    WHERE id = ?
  `).run(Math.floor(Date.now() / 1000), row.id);
  // v1.1.0.78 — matched_at in unix seconds (schema-wide).
  res.json({ ok: true, id: row.id });
});

router.get('/match/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) {
    return res.status(400).json({ error: 'q (query) is required, min 2 chars' });
  }
  // Contact is required for the User-Agent (MB's TOS). Read from
  // settings the same way /match/start does -- the UI shouldn't have
  // to pass it on every search request.
  const database = db.get();
  const settings = database.prepare(`SELECT value FROM settings WHERE key = 'mb_contact'`).get();
  const contact = (settings?.value || '').trim();
  if (!contact) {
    return res.status(400).json({
      error: 'No MusicBrainz contact set. Settings → Metadata.',
    });
  }
  try {
    const results = await metadataMatch.searchReleaseGroups(q, contact);
    res.json({ query: q, results });
  } catch (e) {
    res.status(502).json({ error: e.message || 'Search failed' });
  }
});

// AcoustID fingerprint matching for one album (#v1.1.0.22). Synchronous --
// the user taps "Try fingerprint" in the Unmatched modal and waits for
// the result. Server-side this takes 5-30s depending on number of
// tracks and AcoustID response time. Returns candidates in the same
// shape as the auto-matcher's so the UI renders them with the same
// component.
const fingerprintMatch = require('../fingerprintMatch');

router.post('/match/:id/fingerprint', async (req, res) => {
  const database = db.get();
  const album = database.prepare('SELECT id FROM albums WHERE id = ?').get(req.params.id);
  if (!album) return res.status(404).json({ error: 'Album not found' });

  try {
    const result = await fingerprintMatch.matchAlbumById(req.params.id);
    res.json({
      album_id: req.params.id,
      candidates: result.candidates,
      reason: result.reason || null,
    });
  } catch (e) {
    console.error('[fingerprint] error:', e);
    res.status(500).json({ error: e.message || 'Fingerprint matching failed' });
  }
});


// ── Album/artist bios (#30.23) ────────────────────────────────────────
//
// Lazy-fetch bios from Wikipedia/Last.fm/AudioDB/MB-annotation for an
// album or artist, with caching. The bio fetcher knows the priority
// order; this route just exposes get + force-refresh.

const bioFetch = require('../bioFetch');

router.get('/albums/:id/bio', async (req, res) => {
  try {
    const force = req.query.force === '1' || req.query.force === 'true';
    const bio = await bioFetch.getAlbumBio(req.params.id, { force });
    if (!bio) return res.status(404).json({ error: 'Album not found' });
    res.json(bio);
  } catch (e) {
    console.error('[bio] album endpoint error:', e);
    res.status(500).json({ error: e.message });
  }
});

router.get('/artists/:name/bio', async (req, res) => {
  try {
    const force = req.query.force === '1' || req.query.force === 'true';
    const bio = await bioFetch.getArtistBio(req.params.name, { force });
    if (!bio) return res.status(404).json({ error: 'Artist not found' });
    res.json(bio);
  } catch (e) {
    console.error('[bio] artist endpoint error:', e);
    res.status(500).json({ error: e.message });
  }
});


module.exports = router;
