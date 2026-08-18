/**
 * v1.1.1.4 — Client-side debug log relay.
 *
 * Lets the client POST log messages that get printed to the server's
 * stdout (and thus into journald / docker logs). Used to diagnose
 * issues on devices where the user can't easily access the browser
 * console — phones, tablets, embedded browsers.
 *
 * Body: { tag: 'album-tap', message: '...', data: {...} }
 *
 * The endpoint is intentionally simple — no auth, no rate limit, no
 * persistence. Volume is bounded by being client-controlled and
 * self-imposed (only fires from instrumented points). For
 * production-grade you'd want rate limiting; for diagnostic use
 * during a single bug hunt, this is fine.
 *
 * Toggleable via the MUSICD_CLIENT_DEBUG env variable. Default ON
 * for v1.1.1.4 specifically because the whole point of this build
 * is diagnostic. Future builds can default OFF.
 */
const express = require('express');
const router = express.Router();

const ENABLED = process.env.MUSICD_CLIENT_DEBUG !== '0';

router.post('/client-log', express.json({ limit: '64kb' }), (req, res) => {
  if (!ENABLED) return res.json({ ok: false, disabled: true });
  const { tag, message, data } = req.body || {};
  const safeTag = String(tag || 'client').slice(0, 32);
  const safeMsg = String(message || '').slice(0, 500);
  const ua = (req.get('user-agent') || '').slice(0, 80);
  const ip = req.ip || req.connection?.remoteAddress || '?';
  const dataStr = data === undefined ? '' : ' ' + JSON.stringify(data).slice(0, 400);
  console.log(`[client-log][${safeTag}] ${safeMsg}${dataStr}  (ip=${ip} ua=${ua})`);
  res.json({ ok: true });
});

module.exports = router;
