// /api/news routes (#30, #30.1, #30.4)
//
//   GET  /api/news/feed?limit=N&source=...&kind=...  — list cached items
//   POST /api/news/refresh                            — trigger immediate fetch
//                                                       (rate-limited to 1/min)
//   GET  /api/news/prefs                              — which rows are enabled
//   PUT  /api/news/prefs                              — enable/disable rows
//
// v1.1.20.0: every row is OFF on a new install and nothing is fetched until
// one is switched on. /feed therefore reports `enabled` alongside the items,
// so the Home screen can leave the whole block out rather than render an
// empty one.
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
    // `enabled` is what lets the client hide the section entirely instead of
    // showing an empty "no news yet" state that would never fill.
    res.json({ items, enabled: news.anyNewsEnabled(news.getNewsPrefs()) });
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

router.get('/prefs', (req, res) => {
  try {
    res.json({ prefs: news.getNewsPrefs() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/news/prefs  { qobuzReleases?, bandcampReleases?, ... }
//
// A partial patch: only the keys present are changed, so the four switches do
// not have to be sent together and two of them cannot race each other into
// overwriting the other's value.
router.put('/prefs', (req, res) => {
  try {
    const patch = req.body || {};
    const known = news.NEWS_PREF_KEYS.some(k => typeof patch[k] === 'boolean');
    if (!known) {
      return res.status(400).json({
        error: `expected at least one of: ${news.NEWS_PREF_KEYS.join(', ')}`,
      });
    }
    // setNewsPrefs starts or stops the refresh timer as part of saving, so
    // "off means no background work" holds from the moment the switch moves.
    const prefs = news.setNewsPrefs(patch);
    res.json({ ok: true, prefs, enabled: news.anyNewsEnabled(prefs) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
