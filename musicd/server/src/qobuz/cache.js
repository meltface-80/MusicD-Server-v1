// src/qobuz/cache.js — turns a Qobuz album into library rows.
//
// v1.1.33.0. Derived from MusicD-Server-Bridge's qobuz/cache.js,
// rewritten against this repo's schema: no disc_count, no
// is_compilation, no cover_thumb column here, and tracks.album_id is
// the join this app's album page and stats rebuild both rely on, so
// it is set on every row.
//
// What it writes:
//   albums   one row, id 'qobuz:<albumId>', excluded = 1 on first
//            insert (cached, not yet in the library — see
//            streamingLibrary.js for why that is the whole visibility
//            mechanism)
//   tracks   one row per track, path 'qobuz://<trackId>', album_id
//            pointing at the album row, excluded mirroring the album
//
// Idempotent. Re-caching refreshes metadata and leaves `excluded`
// and the favourite flags alone — those belong to
// streamingLibrary.setAlbumFavorited(), and a re-cache during a
// favourites sync must not knock an album back out of the library
// between the two writes.

'use strict';

const crypto = require('crypto');
const db = require('../db');
const qobuzApi = require('./api');
const log = require('../serviceLog').forModule('qobuz');

// Deterministic local track id from the Qobuz track id, so repeated
// caching of the same album reuses rows instead of duplicating them.
// The 'qobuz-' prefix keeps these visibly distinct from the md5 ids
// the scanner mints for local files.
function _trackIdFor(qobuzTrackId) {
  return 'qobuz-' + crypto.createHash('md5')
    .update(String(qobuzTrackId))
    .digest('hex')
    .slice(0, 24);
}

// Qobuz's image object is { small, thumbnail, large, back, mega }.
// Prefer the biggest that is reliably present.
function _coverUrl(image) {
  if (!image || typeof image !== 'object') return null;
  return image.large || image.mega || image.thumbnail || image.small || null;
}

// Qobuz gives released_at as unix seconds, and sometimes only
// release_date_original as a string. Require a 4-digit year shape
// before parsing the string form: the obvious
// `parseInt(s.slice(0,4)) || null` turns "0001" into 1 and "abcd"
// into null, which mixes two different failures into one value.
function _yearFrom(album) {
  if (album.released_at) {
    const y = new Date(album.released_at * 1000).getUTCFullYear();
    return Number.isFinite(y) ? y : null;
  }
  if (album.release_date_original) {
    const m = /^(\d{4})\b/.exec(String(album.release_date_original));
    return m ? parseInt(m[1], 10) : null;
  }
  return null;
}

// Full YYYY-MM-DD where Qobuz gives us one — this app stores
// release_date alongside year and the album page prefers it.
function _releaseDateFrom(album) {
  const raw = album.release_date_original || album.release_date_stream || '';
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(raw));
  if (m) return m[1];
  if (album.released_at) {
    const d = new Date(album.released_at * 1000);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return null;
}

// Cache a Qobuz album. Returns { localAlbumId, coverUrl, trackCount }.
async function cacheAlbum(qobuzAlbumId) {
  if (!qobuzAlbumId) throw new Error('cacheAlbum: qobuzAlbumId required');

  const album = await qobuzApi.getAlbum(qobuzAlbumId);
  if (!album || !album.id) throw new Error('cacheAlbum: Qobuz returned no album');
  if (!album.tracks || !Array.isArray(album.tracks.items) || album.tracks.items.length === 0) {
    throw new Error('cacheAlbum: Qobuz album has no tracks');
  }

  const localAlbumId = 'qobuz:' + String(album.id);
  const dbh = db.get();
  const items = album.tracks.items;

  const trackCount    = items.length;
  const totalDuration = items.reduce((sum, t) => sum + (t.duration || 0), 0);
  // Album-level format summary from the first track. Qobuz albums are
  // uniform in practice; this is the same first-track approximation
  // rebuildAlbumStats makes for local albums, so Focus's bit-depth
  // and sample-rate filters treat both alike.
  const t0 = items[0] || {};
  const primarySampleRate = Math.round((t0.maximum_sampling_rate || 0) * 1000) || null;
  const primaryBitDepth   = t0.maximum_bit_depth || null;
  const primaryChannels   = t0.maximum_channel_count || 2;

  const year        = _yearFrom(album);
  const releaseDate = _releaseDateFrom(album);
  const coverUrl    = _coverUrl(album.image);
  const albumArtist = (album.artist && album.artist.name) || 'Unknown Artist';
  const genre       = (album.genre && album.genre.name) || null;
  const title       = album.title || 'Untitled';

  // `excluded` appears in the INSERT column list but NOT in the
  // DO UPDATE SET list. That is deliberate and load-bearing: a fresh
  // row lands outside the library (1), and a re-cache of an album
  // already in the library leaves its stored value alone. Putting it
  // in the update list would drop every favourited album out of the
  // grid on the next sync pass, one album at a time, which reads as
  // "my library is emptying itself".
  const insertAlbum = dbh.prepare(`
    INSERT INTO albums (
      id, title, artist, album_artist, year, release_date,
      track_count, total_duration, primary_format,
      primary_sample_rate, primary_bit_depth, primary_channels,
      genre, added_at, excluded
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'flac', ?, ?, ?, ?, unixepoch(), 1)
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
      primary_bit_depth   = excluded.primary_bit_depth,
      primary_channels    = excluded.primary_channels,
      genre               = excluded.genre
  `);

  const insertTrack = dbh.prepare(`
    INSERT INTO tracks (
      id, path, album_id, title, artist, album_artist, album,
      year, release_date, track_number, disc_number, duration,
      sample_rate, bit_depth, channels, format, codec, genre,
      added_at, updated_at, excluded
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'flac', 'FLAC', ?,
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
      channels     = excluded.channels,
      genre        = excluded.genre,
      updated_at   = unixepoch()
  `);

  // Album and tracks land together or not at all. A half-written
  // album is one rebuildAlbumStats away from being deleted outright
  // (it prunes albums with track_count = 0), taking the user's
  // favourite with it.
  const tx = dbh.transaction(() => {
    insertAlbum.run(
      localAlbumId, title, albumArtist, albumArtist, year, releaseDate,
      trackCount, totalDuration,
      primarySampleRate, primaryBitDepth, primaryChannels,
      genre
    );
    // New tracks inherit the album's current visibility so a re-cache
    // of a favourited album does not leave its tracks out of the
    // library. Read after the album upsert, so a first insert reads
    // the 1 it just wrote.
    const cur = dbh.prepare('SELECT COALESCE(excluded, 1) AS excluded FROM albums WHERE id = ?')
      .get(localAlbumId);
    const albumExcluded = cur ? cur.excluded : 1;

    for (const t of items) {
      const trackArtist = (t.performer && t.performer.name)
        || albumArtist
        || 'Unknown Artist';
      insertTrack.run(
        _trackIdFor(t.id),
        'qobuz://' + String(t.id),
        localAlbumId,
        t.title || 'Untitled',
        trackArtist,
        albumArtist,
        title,
        year,
        releaseDate,
        t.track_number || 1,
        t.media_number || 1,
        t.duration || 0,
        Math.round((t.maximum_sampling_rate || 0) * 1000) || null,
        t.maximum_bit_depth || null,
        t.maximum_channel_count || 2,
        genre,
        albumExcluded
      );
    }
  });
  tx();

  log.info(`cached album ${qobuzAlbumId} → ${localAlbumId} (${trackCount} tracks)`);

  // Cover art is fetched out of band. Playback and the album page do
  // not wait on it; the tile shows a placeholder for the second or
  // two it takes, exactly as a local album does before its art is
  // read.
  if (coverUrl) {
    _cacheCover(localAlbumId, coverUrl).catch((err) => {
      log.warn(`cover cache failed for ${localAlbumId}: ${err.message}`);
    });
  }

  return { localAlbumId, coverUrl, trackCount };
}

// Fetch the cover and store it on the album row.
//
// Local covers are stored as found — whatever bytes the file carried.
// These are not: they come off a CDN at a size nobody chose, and a
// sync of 300 favourites at Tidal's 1280px would put ~80 MB of JPEG
// into the database. Capped at 1000px and re-encoded, a favourites
// library costs a few MB and still out-resolves the largest tile the
// client draws.
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
