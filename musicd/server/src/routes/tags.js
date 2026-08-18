// v1.1.0.67 — User-defined tags + Save-for-later.
// =================================================
//
// Tags
// ----
//   GET    /api/tags                 — list tags with usage counts
//   POST   /api/tags                 — create a tag
//   PATCH  /api/tags/:id             — rename or recolour
//   DELETE /api/tags/:id             — delete (cascades to album/track links)
//
//   GET    /api/tags/:id/albums      — albums assigned this tag (paged)
//   GET    /api/tags/:id/tracks      — tracks assigned this tag (paged)
//
//   PUT    /api/albums/:id/tags      — set the full tag list for an album
//   PUT    /api/tracks/:id/tags      — set the full tag list for a track
//
// Save-for-later
// --------------
//   POST   /api/albums/:id/save-for-later   { saved: bool }
//   POST   /api/tracks/:id/save-for-later   { saved: bool }
//
//   GET    /api/library/saved/albums
//   GET    /api/library/saved/tracks
//
// Tags are stored in the tags table (id, name, color, created_at) with
// a UNIQUE COLLATE NOCASE index on name so "Jazz" and "jazz" can't both
// exist. Album-tag and track-tag links are in album_tags and track_tags
// respectively, ON DELETE CASCADE so cleanup is automatic.
//
// All endpoints write the user's chosen casing into `name`. Lookups are
// case-insensitive (the COLLATE NOCASE constraint), so creating "Jazz"
// then querying for "jazz" still finds it.

const express = require('express');
const router = express.Router();
const db = require('../db');

// ──────────────────────────────────────────────────────────────────────
// Helpers

function nowMs() { return Date.now(); }

function normaliseTagName(s) {
  // Trim + collapse whitespace. We keep the user's casing for display
  // but enforce a sensible minimum / maximum length.
  if (typeof s !== 'string') return '';
  return s.trim().replace(/\s+/g, ' ');
}

function isValidColor(c) {
  if (c == null) return true;
  if (typeof c !== 'string') return false;
  return /^#[0-9a-fA-F]{6}$/.test(c);
}

// ──────────────────────────────────────────────────────────────────────
// Tag CRUD

router.get('/', (req, res) => {
  const database = db.get();
  const rows = database.prepare(`
    SELECT t.id, t.name, t.color, t.created_at,
           (SELECT COUNT(*) FROM album_tags WHERE tag_id = t.id) AS album_count,
           (SELECT COUNT(*) FROM track_tags WHERE tag_id = t.id) AS track_count
    FROM tags t
    ORDER BY LOWER(t.name) ASC
  `).all();
  res.json(rows);
});

router.post('/', (req, res) => {
  const name = normaliseTagName(req.body?.name);
  const color = req.body?.color ?? null;
  if (!name) return res.status(400).json({ error: 'Tag name required' });
  if (name.length > 60) return res.status(400).json({ error: 'Tag name too long (max 60)' });
  if (!isValidColor(color)) return res.status(400).json({ error: 'Color must be #RRGGBB hex' });

  const database = db.get();
  // Check for case-insensitive duplicate. UNIQUE COLLATE NOCASE will
  // also enforce this at the DB level, but a friendly error message is
  // better than a SQL error string in the UI.
  const existing = database.prepare(`SELECT id FROM tags WHERE name = ? COLLATE NOCASE`).get(name);
  if (existing) return res.status(409).json({ error: 'Tag already exists', id: existing.id });

  try {
    const r = database.prepare(`INSERT INTO tags (name, color, created_at) VALUES (?, ?, ?)`)
      .run(name, color, nowMs());
    const tag = database.prepare(`SELECT id, name, color, created_at FROM tags WHERE id = ?`).get(r.lastInsertRowid);
    res.json({ ...tag, album_count: 0, track_count: 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const database = db.get();
  const existing = database.prepare(`SELECT id, name, color FROM tags WHERE id = ?`).get(id);
  if (!existing) return res.status(404).json({ error: 'Tag not found' });

  const updates = [];
  const params = [];
  if (req.body?.name !== undefined) {
    const newName = normaliseTagName(req.body.name);
    if (!newName) return res.status(400).json({ error: 'Tag name required' });
    if (newName.length > 60) return res.status(400).json({ error: 'Tag name too long (max 60)' });
    // Allow case-only renames ("jazz" → "Jazz") — we collide-check
    // only against OTHER tags, not this one.
    const collide = database.prepare(`SELECT id FROM tags WHERE name = ? COLLATE NOCASE AND id != ?`).get(newName, id);
    if (collide) return res.status(409).json({ error: 'Another tag with this name already exists', id: collide.id });
    updates.push('name = ?'); params.push(newName);
  }
  if (req.body?.color !== undefined) {
    const newColor = req.body.color;
    if (!isValidColor(newColor)) return res.status(400).json({ error: 'Color must be #RRGGBB hex or null' });
    updates.push('color = ?'); params.push(newColor);
  }
  if (updates.length === 0) return res.json(existing);
  params.push(id);
  database.prepare(`UPDATE tags SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  const tag = database.prepare(`
    SELECT id, name, color, created_at,
           (SELECT COUNT(*) FROM album_tags WHERE tag_id = id) AS album_count,
           (SELECT COUNT(*) FROM track_tags WHERE tag_id = id) AS track_count
    FROM tags WHERE id = ?
  `).get(id);
  res.json(tag);
});

router.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const database = db.get();
  const r = database.prepare(`DELETE FROM tags WHERE id = ?`).run(id);
  if (r.changes === 0) return res.status(404).json({ error: 'Tag not found' });
  // ON DELETE CASCADE handles album_tags + track_tags rows.
  res.json({ ok: true });
});

// ──────────────────────────────────────────────────────────────────────
// Listing albums/tracks for a tag (used by future filter UI)

router.get('/:id/albums', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
  const offset = parseInt(req.query.offset, 10) || 0;
  const database = db.get();
  const rows = database.prepare(`
    SELECT a.id, a.title, a.album_artist, a.year, a.cover_art, a.is_favorite,
           at.added_at
    FROM album_tags at
    JOIN albums a ON a.id = at.album_id
    WHERE at.tag_id = ? AND a.excluded = 0
    ORDER BY at.added_at DESC
    LIMIT ? OFFSET ?
  `).all(id, limit, offset);
  res.json(rows);
});

router.get('/:id/tracks', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
  const offset = parseInt(req.query.offset, 10) || 0;
  const database = db.get();
  const rows = database.prepare(`
    SELECT t.id, t.title, t.artist, t.album_id, t.duration, t.track_number,
           tt.added_at
    FROM track_tags tt
    JOIN tracks t ON t.id = tt.track_id
    WHERE tt.tag_id = ?
    ORDER BY tt.added_at DESC
    LIMIT ? OFFSET ?
  `).all(id, limit, offset);
  res.json(rows);
});

module.exports = router;
