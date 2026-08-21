// src/streamingNormalise.js — one album shape, two services.
//
// v1.1.33.0. Qobuz and Tidal describe the same album with different
// words: tracks_count vs numberOfTracks, released_at (unix seconds)
// vs releaseDate (a string), an image object vs a cover GUID that has
// to be expanded into a CDN path, performer vs artist. The service
// screens, the ⊕, and merged search all want the same fields.
//
// So the split lives here and nowhere else. Every response that
// leaves a streaming route for the client has been through one of
// these, which is why QobuzScreen and TidalScreen can be the same
// component with a different title, and why SearchResults can put a
// Qobuz album and a local album in one grid without a branch.
//
// The normalised album:
//   {
//     service:        'qobuz' | 'tidal'
//     serviceAlbumId: the id at the service, as a string
//     localAlbumId:   'qobuz:123' — the id this app knows it by, and
//                     the id to open the album page with
//     title, artist, year, cover, trackCount, duration
//     quality:        a short human string, '24/96' or 'CD' or null
//     explicit:       bool
//     streamable:     bool — false means the service will refuse to
//                     play it in this account's region; the UI greys
//                     it rather than letting the user find out at the
//                     moment they press play
//   }

'use strict';

const streaming = require('./streamingLibrary');

// ---- Qobuz ---------------------------------------------------------------

function _qobuzCover(image) {
  if (!image || typeof image !== 'object') return null;
  return image.large || image.mega || image.thumbnail || image.small || null;
}

function _qobuzQuality(a) {
  const bits = a.maximum_bit_depth;
  const rate = a.maximum_sampling_rate;   // kHz
  if (!bits || !rate) return null;
  if (bits === 16 && Math.abs(rate - 44.1) < 0.05) return 'CD';
  // Trim a trailing .0 so 96.0 reads as 96 but 88.2 keeps its decimal.
  const rateStr = Number.isInteger(rate) ? String(rate) : String(rate);
  return `${bits}/${rateStr}`;
}

function qobuzAlbum(a) {
  if (!a || a.id == null) return null;
  let year = null;
  if (a.released_at) {
    const y = new Date(a.released_at * 1000).getUTCFullYear();
    year = Number.isFinite(y) ? y : null;
  } else if (a.release_date_original) {
    const m = /^(\d{4})\b/.exec(String(a.release_date_original));
    year = m ? parseInt(m[1], 10) : null;
  }
  return {
    service:        'qobuz',
    serviceAlbumId: String(a.id),
    localAlbumId:   streaming.albumIdFor('qobuz', a.id),
    title:          a.title || 'Untitled',
    artist:         (a.artist && a.artist.name) || 'Unknown Artist',
    year,
    cover:          _qobuzCover(a.image),
    trackCount:     a.tracks_count || 0,
    duration:       a.duration || 0,
    quality:        _qobuzQuality(a),
    explicit:       !!a.parental_warning,
    // Qobuz marks region-locked and preview-only releases with
    // streamable:false. Absent on some browse payloads, in which case
    // assume playable rather than greying out a whole page.
    streamable:     a.streamable !== false,
  };
}

function qobuzTrack(t) {
  if (!t || t.id == null) return null;
  const album = t.album || {};
  return {
    service:        'qobuz',
    serviceTrackId: String(t.id),
    serviceAlbumId: album.id != null ? String(album.id) : null,
    localAlbumId:   album.id != null ? streaming.albumIdFor('qobuz', album.id) : null,
    title:          t.title || 'Untitled',
    artist:         (t.performer && t.performer.name)
                      || (album.artist && album.artist.name)
                      || 'Unknown Artist',
    album:          album.title || '',
    duration:       t.duration || 0,
    cover:          _qobuzCover(album.image),
    explicit:       !!t.parental_warning,
    streamable:     t.streamable !== false,
  };
}

function qobuzArtist(a) {
  if (!a || a.id == null) return null;
  return {
    service:        'qobuz',
    serviceArtistId: String(a.id),
    name:           a.name || 'Unknown Artist',
    image:          (a.image && (a.image.large || a.image.medium || a.image.small)) || null,
    albumCount:     a.albums_count || 0,
  };
}

// ---- Tidal ---------------------------------------------------------------

function _tidalCover(coverId) {
  if (!coverId) return null;
  if (/^https?:\/\//.test(coverId)) return coverId;
  return `https://resources.tidal.com/images/${String(coverId).replace(/-/g, '/')}/640x640.jpg`;
}

// Tidal publishes a quality tier, not numbers. Say the tier in the
// same vocabulary the Qobuz side uses so a mixed search result reads
// consistently — 'CD' for lossless, '24/96' for hi-res. Both are the
// tier's nominal delivery, not a measurement of this release.
function _tidalQuality(q) {
  switch (q) {
    case 'HI_RES_LOSSLESS': return '24/96';
    case 'LOSSLESS':        return 'CD';
    case 'HIGH':            return 'AAC';
    case 'LOW':             return 'AAC';
    default:                return null;
  }
}

function _tidalArtist(obj) {
  if (obj && obj.artist && obj.artist.name) return obj.artist.name;
  if (obj && Array.isArray(obj.artists) && obj.artists[0] && obj.artists[0].name) {
    return obj.artists[0].name;
  }
  return 'Unknown Artist';
}

function tidalAlbum(a) {
  if (!a || a.id == null) return null;
  const m = /^(\d{4})\b/.exec(String(a.releaseDate || ''));
  return {
    service:        'tidal',
    serviceAlbumId: String(a.id),
    localAlbumId:   streaming.albumIdFor('tidal', a.id),
    title:          a.title || 'Untitled',
    artist:         _tidalArtist(a),
    year:           m ? parseInt(m[1], 10) : null,
    cover:          _tidalCover(a.cover),
    trackCount:     a.numberOfTracks || 0,
    duration:       a.duration || 0,
    quality:        _tidalQuality(a.audioQuality),
    explicit:       !!a.explicit,
    // Tidal uses allowStreaming, and omits it on some browse
    // payloads. Same "assume playable when unstated" rule as Qobuz.
    streamable:     a.allowStreaming !== false,
  };
}

function tidalTrack(t) {
  if (!t || t.id == null) return null;
  const album = t.album || {};
  return {
    service:        'tidal',
    serviceTrackId: String(t.id),
    serviceAlbumId: album.id != null ? String(album.id) : null,
    localAlbumId:   album.id != null ? streaming.albumIdFor('tidal', album.id) : null,
    title:          t.title || 'Untitled',
    artist:         _tidalArtist(t),
    album:          album.title || '',
    duration:       t.duration || 0,
    cover:          _tidalCover(album.cover),
    explicit:       !!t.explicit,
    streamable:     t.allowStreaming !== false,
  };
}

function tidalArtist(a) {
  if (!a || a.id == null) return null;
  return {
    service:        'tidal',
    serviceArtistId: String(a.id),
    name:           a.name || 'Unknown Artist',
    image:          a.picture ? _tidalCover(a.picture) : null,
    albumCount:     0,   // not on Tidal's search payload
  };
}

// ---- dispatch ------------------------------------------------------------

const BY_SERVICE = {
  qobuz: { album: qobuzAlbum, track: qobuzTrack, artist: qobuzArtist },
  tidal: { album: tidalAlbum, track: tidalTrack, artist: tidalArtist },
};

// normaliseList('qobuz', 'album', rawItems) → normalised[], nulls dropped.
// A single malformed item in a 50-item page should cost that item, not
// the page.
function normaliseList(service, kind, items) {
  const fns = BY_SERVICE[service];
  if (!fns || !fns[kind]) throw new Error(`normalise: no ${kind} mapper for "${service}"`);
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const raw of items) {
    let n = null;
    try { n = fns[kind](raw); } catch (e) { n = null; }
    if (n) out.push(n);
  }
  return out;
}

function normaliseOne(service, kind, item) {
  const list = normaliseList(service, kind, [item]);
  return list.length ? list[0] : null;
}

// Both services page their responses differently. Pull the item array
// out of whatever shape came back, for a given section name.
//
//   Qobuz search: { albums: { items: [...] }, tracks: {...} }
//   Tidal search: { albums: { items: [...] } } on /search, or a bare
//                 { items: [...] } from the typed endpoints
//   Tidal favourites: { items: [ { item: {...} } ] } — the favourite
//                 wraps the album, so unwrap one level
function itemsFrom(payload, section) {
  if (!payload) return [];
  let raw = null;
  if (section && payload[section] && Array.isArray(payload[section].items)) {
    raw = payload[section].items;
  } else if (Array.isArray(payload.items)) {
    raw = payload.items;
  } else if (Array.isArray(payload)) {
    raw = payload;
  }
  if (!raw) return [];
  return raw.map((row) => (row && row.item && typeof row.item === 'object') ? row.item : row);
}

module.exports = {
  qobuzAlbum, qobuzTrack, qobuzArtist,
  tidalAlbum, tidalTrack, tidalArtist,
  normaliseList, normaliseOne, itemsFrom,
};
