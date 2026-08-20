const express = require('express');
const router = express.Router();
const playerState = require('../playerState');

router.post('/play', async (req, res) => {
  try {
    const { trackId, rendererId, queue, queueIndex } = req.body || {};
    if (!trackId || !rendererId) return res.status(400).json({ error: 'trackId and rendererId required' });
    await playerState.startPlayback(rendererId, trackId, queue, queueIndex);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/queue', (req, res) => {
  const { trackIds, rendererId } = req.body || {};
  if (!Array.isArray(trackIds)) return res.status(400).json({ error: 'trackIds[] required' });
  playerState.appendQueue(trackIds, rendererId);
  res.json({ ok: true });
});

router.post('/pause', async (req, res) => {
  try {
    const { rendererId } = req.body || {};
    await playerState.pause(rendererId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/stop', async (req, res) => {
  try {
    const { rendererId } = req.body || {};
    await playerState.stopAll(rendererId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/volume', async (req, res) => {
  try {
    const { rendererId, volume } = req.body || {};
    await playerState.setVolume(rendererId, parseInt(volume) || 0);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/next', async (req, res) => {
  try { await playerState.next(req.body?.rendererId); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/prev', async (req, res) => {
  try { await playerState.prev(req.body?.rendererId); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Switch the focused zone (#v1.1.0.9). The "switch" no longer moves
// the queue or stops anything; it just changes which zone the UI is
// showing. Other zones keep playing. Empty body uses the rendererId
// in the body. Backwards-compat with v1.1.0.x clients which expected
// switch-renderer to also move the queue: those clients won't see any
// difference because they only show one zone -- moving the queue at
// the server would just confuse them.
router.post('/switch-renderer', async (req, res) => {
  try {
    const { rendererId } = req.body || {};
    if (!rendererId) return res.status(400).json({ error: 'rendererId required' });
    await playerState.switchToRenderer(rendererId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /player/queue/move (#v1.1.0.9) — move the current queue from one
// renderer to another. Old renderer stops; new renderer starts at the
// same queue index. Used by the "Move queue to..." action in the queue
// screen. Body: { fromRendererId, toRendererId }.
router.post('/queue/move', async (req, res) => {
  try {
    const { fromRendererId, toRendererId } = req.body || {};
    if (!fromRendererId || !toRendererId) {
      return res.status(400).json({ error: 'fromRendererId and toRendererId required' });
    }
    await playerState.moveQueueToRenderer(fromRendererId, toRendererId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/state', (req, res) => res.json(playerState.getState()));

// GET /player/state/all (#v1.1.0.9) — multi-zone state snapshot. Returns
// every zone's public state plus the focusedZoneId. Used by the client
// to render mini-player + indicators for other playing zones.
router.get('/state/all', (req, res) => res.json(playerState.getAllZonesState()));

// #21/#22 — Reorder the active queue.
// Body: { from: number, to: number }
// The server moves queue[from] to queue[to] and updates queueIndex if needed
// so the *currently-playing track stays the currently-playing track* — no
// renderer restart, no SetAVTransportURI re-issue. If the move changed which
// track sits at queueIndex+1, the previously pre-queued NextURI is cleared
// (and the new one will be set on the next polling tick).
router.post('/queue/reorder', async (req, res) => {
  try {
    const from = parseInt(req.body?.from, 10);
    const to   = parseInt(req.body?.to, 10);
    const rendererId = req.body?.rendererId;
    if (Number.isNaN(from) || Number.isNaN(to)) {
      return res.status(400).json({ error: 'from and to (integer indices) required' });
    }
    const result = await playerState.reorderQueue(from, to, rendererId);
    if (!result) return res.status(400).json({ error: 'Reorder failed (out-of-range or no active queue)' });
    res.json({ ok: true, queue: result.queue, queueIndex: result.queueIndex });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// v1.1.24.0 — move a whole selection to just after the currently-playing
// track. Body: { indices: [Int], rendererId? }
//
// Backs both "Play now" and "Play next" on the queue screen's multi-select;
// "Play now" is this followed by POST /player/next, because after the move the
// first selected track is queueIndex + 1. Indices matching the currently-
// playing track are ignored rather than failing the batch, the same way
// /queue/remove-batch treats them.
router.post('/queue/move-next', async (req, res) => {
  try {
    const indices = Array.isArray(req.body?.indices) ? req.body.indices : null;
    const rendererId = req.body?.rendererId;
    if (!indices || indices.length === 0) {
      return res.status(400).json({ error: 'indices array required' });
    }
    const result = await playerState.moveSelectionNext(indices, rendererId);
    if (!result) return res.status(400).json({ error: 'Move failed (nothing movable, or no active queue)' });
    res.json({ ok: true, queue: result.queue, queueIndex: result.queueIndex, moved: result.moved });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// #21 — Remove a single track from the queue (cannot remove the currently-playing one).
router.post('/queue/remove', async (req, res) => {
  try {
    const index = parseInt(req.body?.index, 10);
    const rendererId = req.body?.rendererId;
    if (Number.isNaN(index)) return res.status(400).json({ error: 'index required' });
    const result = await playerState.removeFromQueue(index, rendererId);
    if (!result) return res.status(400).json({ error: 'Remove failed (cannot remove current track)' });
    res.json({ ok: true, queue: result.queue, queueIndex: result.queueIndex });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// v1.1.0.55 — batch remove. Body: { indices: [Int], rendererId? }
// Indices that match the currently-playing track are silently ignored
// (rather than failing the whole batch). This lets the client send
// "everything but the current track" without juggling the index
// boundary itself. Returns the new queue + queueIndex.
router.post('/queue/remove-batch', async (req, res) => {
  try {
    const indices = Array.isArray(req.body?.indices) ? req.body.indices : null;
    const rendererId = req.body?.rendererId;
    if (!indices || indices.length === 0) {
      return res.status(400).json({ error: 'indices array required' });
    }
    const result = await playerState.removeFromQueueBatch(indices, rendererId);
    if (!result) return res.status(400).json({ error: 'Remove-batch failed (no valid indices)' });
    res.json({ ok: true, queue: result.queue, queueIndex: result.queueIndex });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// v1.1.0.55 — append track IDs to the end of the queue. Body:
// { trackIds: [Int|String], rendererId? }
// Used by the bulk Add menu (Add all / Add played / Add now playing /
// Add selected). Doesn't reorder or interrupt — strictly appends.
router.post('/queue/append', async (req, res) => {
  try {
    const trackIds = Array.isArray(req.body?.trackIds) ? req.body.trackIds : null;
    const rendererId = req.body?.rendererId;
    if (!trackIds || trackIds.length === 0) {
      return res.status(400).json({ error: 'trackIds array required' });
    }
    playerState.appendQueue(trackIds, rendererId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// v1.1.0.56 — insert tracks immediately after the currently-playing
// one. Body: { trackIds: [Int|String], rendererId? }
// Used by the Play [▾] dropdown's "Play Next" on the album page and
// (later) the track-row ⋯ menu. Clears the gapless next-stream so the
// inserted track actually plays next instead of the pre-rolled one.
router.post('/queue/insert-next', async (req, res) => {
  try {
    const trackIds = Array.isArray(req.body?.trackIds) ? req.body.trackIds : null;
    const rendererId = req.body?.rendererId;
    if (!trackIds || trackIds.length === 0) {
      return res.status(400).json({ error: 'trackIds array required' });
    }
    const result = await playerState.insertNextInQueue(trackIds, rendererId);
    if (!result) return res.status(400).json({ error: 'Insert-next failed (no active queue?)' });
    res.json({ ok: true, queue: result.queue, queueIndex: result.queueIndex });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// #14 — Toggle MusicD Radio (continuous music). When on, the server keeps the
// queue topped up by appending a random album whenever it gets close to empty.
router.post('/radio', async (req, res) => {
  try {
    const enabled = !!req.body?.enabled;
    const state = playerState.setRadio(enabled);
    res.json({ ok: true, radio: state });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
