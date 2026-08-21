// src/tidal/cache.js — turns a Tidal album into library rows.
//
// v1.1.33.0. The Qobuz cache's twin; read src/qobuz/cache.js first,
// the structure and the reasoning behind `excluded` are identical.
// What differs is only what Tidal's API hands back:
//
//   * tracks come from a second call, /albums/<id>/tracks, not
//     nested in the album
//   * discs are volumeNumber, and the album carries numberOfVolumes
//   * there is no per-track sample rate or bit depth on this API
//     surface — only an audioQuality tier per album — so the format
//     columns are derived from that tier (see _formatFor)
//   * cover art is a GUID that has to be expanded into a CDN URL
//
// MQA is deliberately not represented. The client never requests the
// MQA tier, so an album that is MQA-only on Tidal is described here
// by its lossless tier, which is what will actually play.

'use strict';

const crypto = require('crypto');
const db = require('../db');
const tidalApi = require('./api');
const log = require('../serviceLog').forModule('tidal');

function _trackIdFor(tidalTrackId) {
  return 'tidal-' + crypto.createHash('md5')
    .update(String(tidalTrackId))
    .digest('hex')
    .slice(0, 24);
}

// Tidal cover ids are GUID-like with hyphens; the CDN path replaces
// each hyphen with a slash. 1280 is the largest square they publish.
function _coverUrl(coverId) {
  if (!coverId) return null;
  if (/^https?:\/\//.test(coverId)) return coverId;
  return `https://resources.tidal.com/images/${String(coverId).replace(/-/g, '/')}/1280x1280.jpg`;
}

// Tidal reports quality as a tier, not as numbers. Map each tier to
// the (sample rate, bit depth, format) it actually delivers, so this
// app's Focus filters and the album page's format line say something
// true rather than nothing.
//
// HI_RES_LOSSLESS spans 24/44.1 to 24/192 and the API does not say
// which; 96 kHz is the common case and the honest middle. The stream
// route overwrites both values from the playback response once a
// track actually plays, so the guess only ever describes an album
// nobody has played yet.
function _formatFor(audioQuality) {
  switch (audioQuality) {
    case 'HI_RES_LOSSLESS': return { sampleRate: 96000, bitDepth: 24, format: 'flac', codec: 'FLAC' };
    case 'LOSSLESS':        return { sampleRate: 44100, bitDepth: 16, format: 'flac', codec: 'FLAC' };
    case 'HIGH':            return { sampleRate: 44100, bitDepth: 16, format: 'aac',  codec: 'AAC'  };
    case 'LOW':             return { sampleRate: 44100, bitDepth: 16, format: 'aac',  codec: 'AAC'  };
    default:                return { sampleRate: 44100, bitDepth: 16, format: 'flac', codec: 'FLAC' };
  }
}

function _yearFrom(album) {
  const raw = album.releaseDate || album.streamStartDate || '';
  const m = /^(\d{4})\b/.exec(String(raw));
  return m ? parseInt(m[1], 10) : null;
}

function _releaseDateFrom(album) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(album.releaseDate || ''));
  return m ? m[1] : null;
}

function _artistNameFrom(obj, fallback) {
  if (obj && obj.artist && obj.artist.name) return obj.artist.name;
  if (obj && Array.isArray(obj.artists) && obj.artists[0] && obj.artists[0].name) {
    return obj.artists[0].name;
  }
  return fallback || 'Unknown Artist';
}

// Cache a Tidal album. Returns { localAlbumId, coverUrl, trackCount }.
async function cacheAlbum(tidalAlbumId) {
  if (!tidalAlbumId) throw new Error('cacheAlbum: tidalAlbumId required');

  const album = await tidalApi.getAlbum(tidalAlbumId);
  if (!album || !album.id) throw new Error('cacheAlbum: Tidal returned no album');
  const items = await tidalApi.getAlbumTracks(tidalAlbumId);
  if (!items || items.length === 0) throw new Error('cacheAlbum: Tidal album has no tracks');

  const localAlbumId = 'tidal:' + String(album.id);
  const dbh = db.get();

  const trackCount    = items.length;
  const totalDuration = items.reduce((sum, t) => sum + (t.duration || 0), 0);
  const fmt           = _formatFor(album.audioQuality);
  const year          = _yearFrom(album);
  const releaseDate   = _releaseDateFrom(album);
  const coverUrl      = _coverUrl(album.cover);
  const albumArtist   = _artistNameFrom(album);
  const title         = album.title || 'Untitled';
  // Tidal has no album genre on this endpoint. Left null rather than
  // invented: an album with a wrong genre is worse in the Genres
  // screen than one the user can see is unclassified.
  const genre         = null;

  // See the Qobuz cache for why `excluded` is in the insert list and
  // not the update list.
  const insertAlbum = dbh.prepare(`
    INSERT INTO albums (
      id, title, artist, album_artist, year, release_date,
      track_count, total_duration, primary_format,
      primary_sample_rate, primary_bit_depth, primary_channels,
      genre, added_at, excluded
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2, ?, unixepoch(), 1)
    ON CONFLICT(id) DO UPDATE SET
      title               = excluded.title,
      artist              = excluded.artist,
      album_artist        = excluded.album_artist,
      year                = excluded.year,
      release_date        = excluded.release_date,
      track_count         = excluded.track_count,
      total_duration      = excluded.total_duration,
      primary_format      = excluded.primary_format,
      primary_sample_rate = excluded.primary_sample_rate,
      primary_bit_depth   = excluded.primary_bit_depth
  `);

  const insertTrack = dbh.prepare(`
    INSERT INTO tracks (
      id, path, album_id, title, artist, album_artist, album,
      year, release_date, track_number, disc_number, duration,
      sample_rate, bit_depth, channels, format, codec,
      added_at, updated_at, excluded
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2, ?, ?,
              unixepoch(), unixepoch(), ?)
    ON CONFLICT(path) DO UPDATE SET
      album_id     = excluded.album_id,
      title        = excluded.title,
      artist       = excluded.artist,
      album_artist = excluded.album_artist,
      album        = excluded.album,
      year         = excluded.year,
      release_date = excluded.release_date,
      track_number = excluded.track_number,
      disc_number  = excluded.disc_number,
      duration     = excluded.duration,
      sample_rate  = excluded.sample_rate,
      bit_depth    = excluded.bit_depth,
      format       = excluded.format,
      codec        = excluded.codec,
      updated_at   = unixepoch()
  `);

  const tx = dbh.transaction(() => {
    insertAlbum.run(
      localAlbumId, title, albumArtist, albumArtist, year, releaseDate,
      trackCount, totalDuration, fmt.format,
      fmt.sampleRate, fmt.bitDepth, genre
    );
    const cur = dbh.prepare('SELECT COALESCE(excluded, 1) AS excluded FROM albums WHERE id = ?')
      .get(localAlbumId);
    const albumExcluded = cur ? cur.excluded : 1;

    for (const t of items) {
      insertTrack.run(
        _trackIdFor(t.id),
        'tidal://' + String(t.id),
        localAlbumId,
        t.title || 'Untitled',
        _artistNameFrom(t, albumArtist),
        albumArtist,
        title,
        year,
        releaseDate,
        t.trackNumber || 1,
        t.volumeNumber || 1,
        t.duration || 0,
        fmt.sampleRate,
        fmt.bitDepth,
        fmt.format,
        fmt.codec,
        albumExcluded
      );
    }
  });
  tx();

  log.info(`cached album ${tidalAlbumId} → ${localAlbumId} (${trackCount} tracks)`);

  if (coverUrl) {
    _cacheCover(localAlbumId, coverUrl).catch((err) => {
      log.warn(`cover cache failed for ${localAlbumId}: ${err.message}`);
    });
  }

  return { localAlbumId, coverUrl, trackCount };
}

// Identical policy to the Qobuz cache: capped and re-encoded, because
// these bytes come off a CDN at a size nobody here chose.
async function _cacheCover(localAlbumId, coverUrl) {
  const dbh = db.get();
  const existing = dbh.prepare(
    'SELECT cover_art IS NOT NULL AS has_cover FROM albums WHERE id = ?'
  ).get(localAlbumId);
  if (existing && existing.has_cover) return;

  let buf;
  const ctl = new AbortController();
  const tmo = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(coverUrl, { signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    buf = Buffer.from(await r.arrayBuffer());
  } catch (e) {
    throw new Error(`fetch failed: ${e.message}`);
  } finally {
    clearTimeout(tmo);
  }
  if (!buf || buf.length === 0) throw new Error('empty cover response');

  let jpeg;
  try {
    const sharp = require('sharp');
    jpeg = await sharp(buf)
      .resize(1000, 1000, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 88, mozjpeg: true })
      .toBuffer();
  } catch (e) {
    throw new Error(`resize failed: ${e.message}`);
  }

  dbh.prepare(
    'UPDATE albums SET cover_art = ?, cover_art_mime = ? WHERE id = ?'
  ).run(jpeg, 'image/jpeg', localAlbumId);
  log.info(`cached cover for ${localAlbumId} (${jpeg.length}B)`);
}

module.exports = { cacheAlbum };
