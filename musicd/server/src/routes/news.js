// /api/news routes (#30, #30.1, #30.4)
//
//   GET  /api/news/feed?limit=N&source=...&kind=...  — list cached items
//   POST /api/news/refresh                            — trigger immediate fetch
//                                                       (rate-limited to 1/min)
//
// kind=article — Pitchfork articles + Bandcamp Daily articles + Qobuz
//                fallback magazine tiles
// kind=release — Qobuz album release cards + Bandcamp embedded album mentions
// (omit kind to get everything mixed)
//
// The cache is populated by the periodic refresh loop in news.js, which
// starts at boot. The endpoints just read from / kick the cache; they
// never block on upstream fetches except via the explicit refresh path.

const express = require('express');
const news = require('../news');

const router = express.Router();

router.get('/feed', (req, res) => {
  try {
    const items = news.listItems({
      limit:  req.query.limit,
      source: req.query.source || null,
      kind:   req.query.kind   || null,
    });
    res.json({ items });
  } catch (e) {
    console.error('GET /news/feed failed:', e);
    res.status(500).json({ error: e.message });
  }
});

router.post('/refresh', async (req, res) => {
  try {
    const r = await news.refreshManual();
    if (r.ok) {
      res.json(r);
    } else {
      // 429 for cooldown so the client can show "try again in X" without
      // treating it as a real failure. Other reasons are 500-class.
      const code = r.reason === 'cooldown' ? 429 : 500;
      res.status(code).json(r);
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
