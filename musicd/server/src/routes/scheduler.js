const express = require('express');
const router = express.Router();
const scheduler = require('../metadataScheduler');

// GET /api/scheduler/status — full snapshot (polled by Settings UI)
router.get('/status', (req, res) => {
  res.json(scheduler.getStatus());
});

// PATCH /api/scheduler/mode — { mode: 'off' | 'automatic' | 'scheduled' }
router.patch('/mode', express.json(), (req, res) => {
  const { mode } = req.body || {};
  try {
    scheduler.setMode(mode);
    res.json({ ok: true, status: scheduler.getStatus() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// PATCH /api/scheduler/window — { start: 'HH:MM', end: 'HH:MM' }
router.patch('/window', express.json(), (req, res) => {
  const { start, end } = req.body || {};
  const r = scheduler.setWindow(start, end);
  if (!r.ok) return res.status(400).json(r);
  res.json({ ok: true, status: scheduler.getStatus() });
});

// POST /api/scheduler/run-now — kick off a one-shot cycle
router.post('/run-now', (req, res) => {
  const r = scheduler.runNow();
  res.json(r);
});

// POST /api/scheduler/stop — request the running cycle to stop
router.post('/stop', (req, res) => {
  scheduler.stopCurrent();
  res.json({ ok: true });
});

module.exports = router;
