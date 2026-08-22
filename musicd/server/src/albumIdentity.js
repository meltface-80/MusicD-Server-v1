// src/albumIdentity.js — what an album IS, independent of how it was tagged.
//
// v1.1.34.0. Two features need to answer the same question and must
// answer it identically:
//
//   the MusicBrainz matcher    "what should I search for?"
//   album version grouping     "are these two rows the same album?"
//
// If those disagree — if the matcher strips "(Deluxe Edition)" but the
// grouper does not — then three copies of Moon Safari can all match the
// same release-group and still refuse to collapse into one tile, which
// looks exactly like the grouping being broken. So the normalisation
// lives here once and both import it.
//
// Nothing in this file does I/O except the two `effective*` helpers,
// which read the tracks table to recover metadata the album row is
// missing. Everything else is a pure string function, which is what
// makes the whole thing testable without a network.

'use strict';

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

// Fold a string to its comparable form: no diacritics, no leading
// article, no punctuation, single-spaced, lowercase. Only ever used for
// COMPARING — the original strings are what get sent to MusicBrainz,
// because MB's own index does its own folding and second-guessing it
// loses information.
function normalise(s) {
  if (!s) return '';
  let n = String(s).toLowerCase();
  // Escaped, not the literal combining-mark range: written literally
  // this is invisible in an editor and a tool that mangles non-ASCII
  // breaks diacritic folding with nothing to see in the diff.
  n = n.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  n = n.replace(/^(the |a |an )/i, '');
  n = n.replace(/[^\w\s]/g, ' ');
  n = n.replace(/\s+/g, ' ').trim();
  return n;
}

// ---------------------------------------------------------------------------
// Edition noise
// ---------------------------------------------------------------------------
//
// Real-world tags carry reissue and format phrasing that MusicBrainz
// does NOT put in the canonical release-group title. "Moon Safari",
// "Moon Safari (Deluxe)" and "Moon Safari (Remaster)" are one release
// group at MB and three rows here; stripping the tail is what lets all
// three find it, and what lets all three group together afterwards.
//
// TRAILING ONLY, deliberately. "Live at Wembley" as a whole title is a
// different album from "Wembley"; only a trailing "(Live)" is an
// edition note. That rule is why the patterns are all anchored with $.
const NOISE_PATTERNS = [
  // (Deluxe Edition), (Remastered 2019), (Director's Cut), (Legacy Edition)
  /\s*[\(\[]\s*(?:remaster(?:ed)?|deluxe|expanded|special|anniversary|legacy|collector'?s|definitive|limited|gold|platinum|standard|original|extended|director'?s|super\s+deluxe)\s+(?:edition|version|cut|recording|mix|master|reissue)?\s*(?:\d{2,4})?\s*[\)\]]\s*$/i,
  // (50th Anniversary Edition), (25th Anniversary), (2nd Edition)
  /\s*[\(\[]\s*\d+(?:st|nd|rd|th)?\s+(?:anniversary|edition|reissue|remaster(?:ed)?|deluxe|expanded|special)\s*(?:edition|version)?\s*[\)\]]\s*$/i,
  // Bare qualifiers: (Deluxe), (Remastered), (Bonus Tracks), (Mono)
  /\s*[\(\[]\s*(?:remaster(?:ed)?|deluxe|expanded|special|anniversary|bonus\s+tracks?|bonus|hi-?res|live|acoustic|demo|instrumental|stereo|mono|reissue|repackaged?|edition|explicit|clean)\s*(?:\d{2,4})?\s*[\)\]]\s*$/i,
  // (2019 Remaster), (2009 Reissue)
  /\s*[\(\[]\s*\d{4}\s+(?:remaster(?:ed)?|edition|reissue|version|mix)\s*[\)\]]\s*$/i,
  // Format hints a ripper added: (24/96), (DSD), (FLAC), (MQA), (Hi-Res)
  /\s*[\(\[]\s*(?:24[/-]?\d{2,3}|16[/-]?44(?:\.1)?|dsd\d*|flac|alac|wav|mqa|sacd|vinyl|hi-?res(?:\s+audio)?)\s*[\)\]]\s*$/i,
  // Trailing dash notes: " - Remastered", " - 2019 Remaster", " - Deluxe"
  /\s+[\-–—]\s+(?:\d{4}\s+)?(?:remaster(?:ed)?|deluxe|expanded|live|bonus\s+tracks?|hi-?res|edition|version|reissue|mono|stereo)\b.*$/i,
  // Disc indicators: " CD1", " Disc 2", " Vol. 3"
  /\s+(?:cd|disc|disk|vol(?:ume)?\.?)\s*\d+\s*$/i,
];

// Returns { cleaned, stripped[] }. `stripped` feeds the diagnostic on
// the Unmatched page, so a user can see the matcher searched for
// something other than what they tagged — otherwise a "wrong" match
// looks inexplicable.
function cleanAlbumTitle(title) {
  if (!title) return { cleaned: '', stripped: [] };
  let cleaned = String(title).trim();
  const stripped = [];
  let changed = true;
  let iter = 0;
  // A title can carry several tails: "Foo (Deluxe Edition) [Bonus Tracks]".
  // Each pass removes one. Capped so a pathological title cannot spin.
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
  // Never strip a title away to nothing — "(Live)" as the entire title
  // is a real album name, and an empty query matches everything.
  if (!cleaned) cleaned = String(title).trim();
  return { cleaned, stripped };
}

// MusicBrainz keeps featured credits in the artist-credit join phrase,
// not in the artist name, so "Calvin Harris feat. Rihanna" has to become
// "Calvin Harris" before it will match anything.
function cleanArtistName(artist) {
  if (!artist) return { cleaned: '', stripped: [] };
  let cleaned = String(artist).trim();
  const stripped = [];
  const featRe = /\s+(?:feat\.?|ft\.?|featuring|f\.|with)\s+.+$/i;
  const m = cleaned.match(featRe);
  if (m) {
    stripped.push(m[0].trim());
    cleaned = cleaned.slice(0, m.index).trim();
  }
  if (!cleaned) cleaned = String(artist).trim();
  return { cleaned, stripped };
}

// ---------------------------------------------------------------------------
// Placeholder detection
// ---------------------------------------------------------------------------
//
// Rippers write these when they know nothing. Treating them as a real
// artist is what sends the matcher off to search for an artist called
// "Unknown Artist" and come back with nothing — so they are recognised
// as ABSENT, which is what triggers recovery from the tracks and the
// folder name below.
const PLACEHOLDER = new Set([
  '', 'unknown', 'unknown artist', 'unknown album', 'various', 'various artists',
  'va', 'untitled', 'no artist', 'not available', 'n a', 'none', 'null',
  'audio cd', 'cd', 'album', 'track', 'sampler',
]);

function isPlaceholder(value) {
  return PLACEHOLDER.has(normalise(value));
}

// ---------------------------------------------------------------------------
// Folder-name parsing
// ---------------------------------------------------------------------------
//
// When tags are poor the directory name is very often the best metadata
// present — people who do not tag still name folders. Handles the
// layouts that actually turn up in ripped libraries:
//
//   Air - Moon Safari
//   Air - Moon Safari (1998)
//   Air - 1998 - Moon Safari
//   1998 - Moon Safari
//   Moon Safari (1998)
//   [1998] Air - Moon Safari
//
// Returns { artist, title, year } with any field null when the shape
// does not carry it. Never guesses: a folder with no separator yields a
// title and no artist, rather than splitting on a space and inventing
// an artist from the first word.
function parseFolderName(folder) {
  const out = { artist: null, title: null, year: null };
  if (!folder) return out;

  let base = String(folder).replace(/[\\/]+$/, '');
  base = base.split(/[\\/]/).pop() || '';
  base = base.trim();
  if (!base) return out;

  // A leading [1998] or (1998) year block.
  const lead = base.match(/^[\[\(]\s*(19|20)\d{2}\s*[\]\)]\s*[-–—]?\s*/);
  if (lead) {
    out.year = parseInt(lead[0].replace(/\D/g, '').slice(0, 4), 10);
    base = base.slice(lead[0].length).trim();
  }

  // A trailing (1998) / [1998] year block.
  const tail = base.match(/\s*[\[\(]\s*((?:19|20)\d{2})\s*[\]\)]\s*$/);
  if (tail) {
    if (!out.year) out.year = parseInt(tail[1], 10);
    base = base.slice(0, tail.index).trim();
  }

  // Split on " - ", which is the near-universal convention. Split on the
  // FIRST separator only: "Air - Moon Safari - Remastered" is an artist
  // and a title-with-a-tail, not three fields.
  const parts = base.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) {
    let [first, ...rest] = parts;
    let second = rest.join(' - ').trim();
    first = first.trim();

    // "Air - 1998 - Moon Safari": a bare year in the middle position.
    const midYear = second.match(/^((?:19|20)\d{2})\s*[-–—]\s*(.+)$/);
    if (midYear) {
      if (!out.year) out.year = parseInt(midYear[1], 10);
      second = midYear[2].trim();
    }

    // "1998 - Moon Safari": the first field is the year, not an artist.
    if (/^(19|20)\d{2}$/.test(first)) {
      if (!out.year) out.year = parseInt(first, 10);
      out.title = second || null;
      return out;
    }

    out.artist = first || null;
    out.title = second || null;
    return out;
  }

  // No separator: the whole thing is a title.
  out.title = base || null;
  return out;
}

// ---------------------------------------------------------------------------
// Effective identity
// ---------------------------------------------------------------------------
//
// The album row's own columns, with two fallbacks when they are absent
// or a placeholder:
//
//   1. the tracks — an album row with no album_artist very often has
//      perfectly good per-track artists, and the most common one across
//      the album is the album artist by any reasonable reading
//   2. the folder name
//
// `dbh` is a better-sqlite3 handle. Passing it in rather than requiring
// ./db here keeps this module testable against an in-memory database.
function effectiveIdentity(album, dbh) {
  const source = { title: 'tag', artist: 'tag' };
  let title = (album.title || '').trim();
  let artist = (album.album_artist || '').trim();
  let year = Number.isFinite(album.year) ? album.year : null;

  const needTitle = isPlaceholder(title);
  const needArtist = isPlaceholder(artist);

  // Recovery 1: the most common non-placeholder track artist.
  if (needArtist && dbh && album.id) {
    try {
      const row = dbh.prepare(`
        SELECT artist, COUNT(*) AS n
        FROM tracks
        WHERE album_id = ? AND artist IS NOT NULL AND TRIM(artist) != ''
        GROUP BY artist
        ORDER BY n DESC
        LIMIT 5
      `).all(album.id).find((r) => !isPlaceholder(r.artist));
      if (row) { artist = String(row.artist).trim(); source.artist = 'tracks'; }
    } catch (e) {
      // A missing tracks table (or a caller passing a partial schema in
      // a test) must not take identity resolution down — the folder
      // fallback below still applies.
    }
  }

  // Recovery 2: the folder name, for whichever field is still missing.
  if ((isPlaceholder(artist) || isPlaceholder(title)) && album.album_folder) {
    const parsed = parseFolderName(album.album_folder);
    if (isPlaceholder(artist) && parsed.artist && !isPlaceholder(parsed.artist)) {
      artist = parsed.artist; source.artist = 'folder';
    }
    if (isPlaceholder(title) && parsed.title && !isPlaceholder(parsed.title)) {
      title = parsed.title; source.title = 'folder';
    }
    if (!year && parsed.year) year = parsed.year;
  }

  const t = cleanAlbumTitle(title);
  const a = cleanArtistName(artist);

  return {
    title,
    artist,
    year,
    cleanTitle: t.cleaned,
    cleanArtist: a.cleaned,
    titleStripped: t.stripped,
    artistStripped: a.stripped,
    // 'tag' | 'tracks' | 'folder' — surfaced in the match diagnostic so
    // a user looking at a wrong match can see the matcher was working
    // from a folder name, not from their tags.
    source,
    // True when there is nothing worth sending to MusicBrainz. The
    // matcher stops here rather than searching for "Unknown Artist".
    unusable: isPlaceholder(t.cleaned) || isPlaceholder(a.cleaned),
  };
}

// ---------------------------------------------------------------------------
// Version key
// ---------------------------------------------------------------------------
//
// What makes two album rows "the same album" for version grouping.
//
//   'rg:<mbid>'         both matched to the same MusicBrainz release
//                       group. Authoritative — this is the whole reason
//                       matching and grouping are one piece of work.
//   't:<title>|<artist>' not matched (yet): the cleaned, normalised
//                       title and artist. Works on a library that has
//                       never been matched, and is exactly the pairing
//                       that collapses Moon Safari / (Deluxe) /
//                       (Remaster).
//
// Returns null when there is no usable identity at all, and a null key
// never groups with anything — including other nulls. Two albums whose
// titles we do not know are not evidence of being the same album.
function versionKeyFor(album, dbh) {
  if (album.mb_release_group_id) return 'rg:' + album.mb_release_group_id;
  const id = effectiveIdentity(album, dbh);
  const t = normalise(id.cleanTitle);
  const a = normalise(id.cleanArtist);
  if (!t || isPlaceholder(t)) return null;
  // A known title with an unknown artist still groups, on title alone
  // being an exact normalised match. Rare, and better than not grouping
  // two rips of the same record that both lost their artist tag.
  return 't:' + t + '|' + (isPlaceholder(a) ? '' : a);
}

module.exports = {
  normalise,
  cleanAlbumTitle,
  cleanArtistName,
  isPlaceholder,
  parseFolderName,
  effectiveIdentity,
  versionKeyFor,
  NOISE_PATTERNS,
};
