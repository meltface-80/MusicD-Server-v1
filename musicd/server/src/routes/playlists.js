// Playlists (v1.1.19.0).
//
// The "Add to Playlist" row has sat disabled in the track menu since v57 with
// a "v60" badge on it, because nothing backed it. This is that backing.
//
// Deliberately small: a playlist is a name and an ordered set of track ids.
// No smart playlists, no folders, no sharing — the menu action that prompted
// this needs "list the playlists, add this track to one, make a new one", and
// the screen needs "show it, play it, remove a track". Everything here serves
// one of those.

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../db');

const now = () => Math.floor(Date.now() / 1000);
const newId = () => crypto.randomBytes(12).toString('hex');

// Names are the only free text here. Trimmed, length-capped, and required to
// be non-empty — an untitled playlist is unfindable in a list of playlists.
const MAX_NAME = 80;
function cleanName(raw) {
  const name = String(raw == null ? '' : raw).trim().replace(/\s+/g, ' ');
  if (!name) return null;
  return name.slice(0, MAX_NAME);
}

// The columns the client needs to render a track row. Kept in one place so
// the playlist view and the queue see the same shape.
const TRACK_COLUMNS = `
  t.id, t.title, t.artist, t.album, t.album_artist, t.duration,
  t.format, t.codec, t.track_number, t.disc_number
`;

// GET /api/playlists → [{ id, name, trackCount, duration, updated_at }]
router.get('/', (req, res) => {
  try {
    const rows = db.get().prepare(`
      SELECT p.id, p.name, p.created_at, p.updated_at,
             COUNT(pt.track_id)            AS trackCount,
             COALESCE(SUM(t.duration), 0)  AS duration
      FROM playlists p
      LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
      LEFT JOIN tracks t           ON t.id = pt.track_id
      GROUP BY p.id
      ORDER BY p.updated_at DESC
    `).all();
    res.json({ playlists: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/playlists  { name, trackIds? } → the created playlist
//
// trackIds is optional so "new playlist" from the add-to-playlist sheet is a
// single round trip rather than create-then-add.
router.post('/', (req, res) => {
  const name = cleanName(req.body?.name);
  if (!name) return res.status(400).json({ error: 'name is required' });
  const ids = Array.isArray(req.body?.trackIds) ? req.body.trackIds : [];
  try {
    const database = db.get();
    const id = newId();
    const ts = now();
    database.prepare('INSERT INTO playlists (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(id, name, ts, ts);
    const added = ids.length ? addTracks(id, ids) : 0;
    res.json({ ok: true, playlist: { id, name, created_at: ts, updated_at: ts, trackCount: added } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/playlists/:id → the playlist plus its tracks, in order
router.get('/:id', (req, res) => {
  try {
    const database = db.get();
    const p = database.prepare('SELECT * FROM playlists WHERE id = ?').get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Playlist not found' });
    // INNER JOIN on purpose: a track removed from the library should vanish
    // from the playlist view rather than render as a blank row. The
    // playlist_tracks row goes with it via ON DELETE CASCADE.
    const tracks = database.prepare(`
      SELECT ${TRACK_COLUMNS}
      FROM playlist_tracks pt
      JOIN tracks t ON t.id = pt.track_id
      WHERE pt.playlist_id = ?
      ORDER BY pt.position ASC
    `).all(req.params.id);
    res.json({ playlist: p, tracks });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/playlists/:id  { name }
router.patch('/:id', (req, res) => {
  const name = cleanName(req.body?.name);
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const r = db.get().prepare('UPDATE playlists SET name = ?, updated_at = ? WHERE id = ?')
      .run(name, now(), req.params.id);
    if (r.changes === 0) return res.status(404).json({ error: 'Playlist not found' });
    res.json({ ok: true, name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/playlists/:id
router.delete('/:id', (req, res) => {
  try {
    const r = db.get().prepare('DELETE FROM playlists WHERE id = ?').run(req.params.id);
    if (r.changes === 0) return res.status(404).json({ error: 'Playlist not found' });
    // playlist_tracks goes with it via ON DELETE CASCADE, which needs the
    // foreign_keys pragma db.init() sets.
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Append tracks to the end, skipping any already present and any id the
// library does not know. Returns how many were actually added.
//
// The position of a new row continues from the current maximum rather than
// from the row count, so removing a track from the middle cannot make the
// next addition collide with an existing position.
function addTracks(playlistId, trackIds) {
  const database = db.get();
  const ids = [...new Set(trackIds.filter(id => typeof id === 'string' && id))];
  if (ids.length === 0) return 0;

  const maxPos = database.prepare(
    'SELECT COALESCE(MAX(position), -1) AS m FROM playlist_tracks WHERE playlist_id = ?'
  ).get(playlistId).m;

  const exists = database.prepare('SELECT 1 FROM tracks WHERE id = ?');
  const insert = database.prepare(`
    INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(playlist_id, track_id) DO NOTHING
  `);
  const ts = now();

  const tx = database.transaction(() => {
    let pos = maxPos + 1;
    let added = 0;
    for (const id of ids) {
      if (!exists.get(id)) continue;
      const r = insert.run(playlistId, id, pos, ts);
      if (r.changes > 0) { pos++; added++; }
    }
    if (added > 0) {
      database.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(ts, playlistId);
    }
    return added;
  });
  return tx();
}

// POST /api/playlists/:id/tracks  { trackIds: [...] }
router.post('/:id/tracks', (req, res) => {
  const ids = Array.isArray(req.body?.trackIds)
    ? req.body.trackIds
    : (req.body?.trackId ? [req.body.trackId] : []);
  if (ids.length === 0) return res.status(400).json({ error: 'trackIds is required' });
  try {
    const database = db.get();
    if (!database.prepare('SELECT 1 FROM playlists WHERE id = ?').get(req.params.id)) {
      return res.status(404).json({ error: 'Playlist not found' });
    }
    const added = addTracks(req.params.id, ids);
    // `added` can legitimately be 0 — every track was already in it. That is
    // a success for an idempotent action, not an error, so say what happened
    // rather than failing.
    res.json({ ok: true, added, requested: ids.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/playlists/:id/tracks/:trackId
router.delete('/:id/tracks/:trackId', (req, res) => {
  try {
    const database = db.get();
    const r = database.prepare(
      'DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?'
    ).run(req.params.id, req.params.trackId);
    if (r.changes === 0) return res.status(404).json({ error: 'Not in this playlist' });
    database.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(now(), req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/playlists/for-track/:trackId → ids of the playlists holding it.
//
// Lets the add-to-playlist sheet tick what the track is already in, so the
// user is not offered an action that would do nothing.
router.get('/for-track/:trackId', (req, res) => {
  try {
    const rows = db.get().prepare(
      'SELECT playlist_id FROM playlist_tracks WHERE track_id = ?'
    ).all(req.params.trackId);
    res.json({ playlistIds: rows.map(r => r.playlist_id) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
