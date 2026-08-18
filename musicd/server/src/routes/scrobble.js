const express = require('express');
const router = express.Router();
const scrobbler = require('../scrobbler');

// Scrobbler routes (#30.25)
// =========================
//
// GET    /api/scrobble/status         -- connection state, queue depth, last error
// POST   /api/scrobble/auth/login     -- { username, password } → session
// POST   /api/scrobble/auth/logout    -- clear session
// POST   /api/scrobble/flush          -- manually retry the queue

router.get('/status', (req, res) => {
  res.json(scrobbler.getStatus());
});

router.post('/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  try {
    const result = await scrobbler.login(username, password);
    res.json({ ok: true, username: result.username });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/auth/logout', (req, res) => {
  scrobbler.logout();
  res.json({ ok: true });
});

router.post('/flush', async (req, res) => {
  try {
    await scrobbler.flushQueue();
    res.json({ ok: true, status: scrobbler.getStatus() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
