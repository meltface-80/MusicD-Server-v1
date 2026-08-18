const express = require('express');
const router = express.Router();
const renderers = require('../renderers');
const db = require('../db');

router.get('/', (req, res) => {
  // Annotate each renderer with its saved icon_id from renderer_settings
  // (#30.22). The renderers module deals with live device discovery only;
  // user-chosen settings live in the database, so we overlay them here at
  // the API edge. Renderers without a saved choice get icon_id=null and
  // the client falls back to a protocol-based default.
  const list = renderers.list();
  if (list.length === 0) return res.json([]);
  const ids = list.map(r => r.id);
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.get().prepare(
    `SELECT renderer_id, icon_id FROM renderer_settings WHERE renderer_id IN (${placeholders})`
  ).all(...ids);
  const iconMap = Object.fromEntries(rows.map(r => [r.renderer_id, r.icon_id]));
  res.json(list.map(r => ({ ...r, icon_id: iconMap[r.id] || null })));
});

// Trigger an active SSDP/mDNS search
router.post('/search', (req, res) => {
  renderers.triggerSearch();
  res.json({ ok: true });
});

// Remember last-used renderer (used to default the player on app boot)
router.post('/last-used', (req, res) => {
  const { rendererId } = req.body || {};
  if (!rendererId) return res.status(400).json({ error: 'rendererId required' });
  db.get().prepare(`
    INSERT INTO renderer_settings (renderer_id, last_used_at)
    VALUES (?, unixepoch())
    ON CONFLICT(renderer_id) DO UPDATE SET last_used_at = unixepoch()
  `).run(rendererId);
  res.json({ ok: true });
});

router.get('/last-used', (req, res) => {
  const row = db.get().prepare(`
    SELECT renderer_id FROM renderer_settings ORDER BY last_used_at DESC LIMIT 1
  `).get();
  res.json({ rendererId: row?.renderer_id || null });
});

// Set or clear the icon for a renderer (#30.22). Body shape:
//   { rendererId: 'sonos:...', iconId: 'speaker' }   -- set
//   { rendererId: 'sonos:...', iconId: null }        -- clear (use default)
//
// We don't validate iconId against a server-side enum because the icon
// set lives in the client. If the user picks 'kitchen' and we ship a
// later version without that icon, the client falls back to default
// rather than crashing. The DB just stores whatever string the client
// sent.
router.post('/icon', (req, res) => {
  const { rendererId, iconId } = req.body || {};
  if (!rendererId) return res.status(400).json({ error: 'rendererId required' });
  // Use INSERT OR ... UPDATE pattern -- the row may not exist yet for a
  // never-seen renderer.
  const stmt = db.get().prepare(`
    INSERT INTO renderer_settings (renderer_id, icon_id, last_used_at)
    VALUES (?, ?, COALESCE((SELECT last_used_at FROM renderer_settings WHERE renderer_id = ?), unixepoch()))
    ON CONFLICT(renderer_id) DO UPDATE SET icon_id = excluded.icon_id
  `);
  stmt.run(rendererId, iconId || null, rendererId);
  res.json({ ok: true });
});

module.exports = router;
