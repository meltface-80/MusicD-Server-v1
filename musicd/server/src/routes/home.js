// /api/home routes (v1.1.21.0)
//
//   GET  /api/home/prefs   — which Home-screen carousels are switched on
//   PUT  /api/home/prefs   — switch them on and off
//
// These three rows (Recently added, Recently played, Random albums) read this
// server's own library and make no outside request, so unlike /api/news/prefs
// they are ON by default and there is no background work to start or stop —
// see the note at the top of ../homePrefs.js.

const express = require('express');
const homePrefs = require('../homePrefs');

const router = express.Router();

router.get('/prefs', (req, res) => {
  try {
    res.json({ prefs: homePrefs.getHomePrefs() });
  } catch (e) {
    console.error('GET /home/prefs failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/home/prefs  { recentlyAdded?, recentlyPlayed?, randomAlbums? }
router.put('/prefs', (req, res) => {
  try {
    const patch = req.body || {};
    const known = homePrefs.HOME_PREF_KEYS.some(k => typeof patch[k] === 'boolean');
    if (!known) {
      return res.status(400).json({
        error: `expected at least one of: ${homePrefs.HOME_PREF_KEYS.join(', ')}`,
      });
    }
    res.json({ ok: true, prefs: homePrefs.setHomePrefs(patch) });
  } catch (e) {
    console.error('PUT /home/prefs failed:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
