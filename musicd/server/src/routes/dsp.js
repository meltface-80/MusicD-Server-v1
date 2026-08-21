// DSP routes (#29.0; #29.6 cleanup)
// API surface for managing per-renderer DSP profiles, AutoEQ presets,
// crossfeed, and FIR convolution.
//
// Endpoints
// ---------
// GET    /api/dsp/profile/:rendererId      → full profile + magnitude curve
// PUT    /api/dsp/profile/:rendererId      → partial update {field: value, ...}
// GET    /api/dsp/eligible/:rendererId     → { eligible: bool, reason: string }
// GET    /api/dsp/autoeq/index             → list of available headphone models
// GET    /api/dsp/autoeq/preset/:name      → biquad list for a model
// POST   /api/dsp/autoeq/apply             → load a preset into a renderer's PEQ
// POST   /api/dsp/peq/preview              → return magnitude curve + preamp for filter list
//                                            (used by manual PEQ UI before save)

const express = require('express');
const fs = require('fs');
const path = require('path');
const dsp = require('../dsp');
const fir = require('../dsp/fir');
const profiles = require('../dsp/profiles');
const autoeqUpdater = require('../dsp/autoeq-updater');
const renderers = require('../renderers');
const paths = require('../paths');

const router = express.Router();

// Auto-restart helper (#29.4). Called after any endpoint that changes live
// DSP state — PEQ filters, AutoEQ apply, FIR upload, profile apply, etc.
// Re-issues the current track on the renderer so the new chain takes
// effect immediately rather than only on the user's next manual skip.
//
// Best-effort: failures don't break the response. We require playerState
// lazily because routes/dsp.js loads before the player module on cold boot
// and we want the route file to be require-safe in any order.
async function reapplyDspToRenderer(rendererId) {
  if (!rendererId) return;
  try {
    const playerState = require('../playerState');
    // v1.1.0.60 — refresh signalPath FIRST so the WebSocket state is
    // consistent before the URI-change transition. Otherwise the orb
    // colour (computed at last advanceTrack) and clipping_indicator
    // (recomputed on profile save) can disagree for the few hundred
    // ms of stream restart, producing the "bit-perfect but pulsing
    // red" report from v58 listening tests.
    if (typeof playerState.refreshSignalPathForRenderer === 'function') {
      await playerState.refreshSignalPathForRenderer(rendererId);
    }
    if (typeof playerState.restartCurrentTrack === 'function') {
      await playerState.restartCurrentTrack(rendererId);
    }
  } catch (e) {
    console.warn(`[dsp/reapply] ${rendererId}: ${e.message}`);
  }
}

// Look up a renderer's protocol so we can answer "is DSP eligible here".
// If the renderer isn't currently discovered (offline) we still answer based
// on the id prefix — id format is `${protocol}-${...}` for our discovery.
function resolveProtocol(rendererId) {
  const r = renderers.getRenderer && renderers.getRenderer(rendererId);
  if (r?.protocol) return r.protocol;
  // Fallback: id prefix. Not perfect (DLNA ids include UUIDs, Sonos use
  // 'sonos-...') but good enough for offline-renderer answers.
  if (typeof rendererId === 'string') {
    const dash = rendererId.indexOf('-');
    if (dash > 0) return rendererId.slice(0, dash);
  }
  return null;
}

// Resolve an AutoEQ preset slug to its absolute path on disk, refusing
// anything that escapes the presets directory. We use path.resolve and
// then verify the result is rooted at the canonical presets dir — this
// is robust to ".." sequences, encoded "..", repeated separators, and
// absolute-path injection in the slug. Returns null if the resolved
// path would escape the directory.
function resolveSafeAutoeqPath(slug) {
  if (!slug || typeof slug !== 'string') return null;
  const presetsDir = path.resolve(paths.AUTOEQ_DIR, 'presets');
  const candidate = path.resolve(presetsDir, `${slug}.txt`);
  // The resolved path must live INSIDE presetsDir (strict — equal-to is
  // not enough; that would be the directory itself, not a file).
  if (!candidate.startsWith(presetsDir + path.sep)) return null;
  return candidate;
}

router.get('/eligible/:rendererId', (req, res) => {
  const proto = resolveProtocol(req.params.rendererId);
  const eligible = dsp.isDspEligible(proto);
  // Reason text drives the UI's "DSP not applied to Sonos" notice.
  let reason = '';
  if (!proto)            reason = 'Renderer is offline; DSP eligibility unknown';
  else if (proto === 'sonos')      reason = 'DSP is bypassed for Sonos (it has its own internal EQ)';
  else if (eligible)               reason = `DSP active for ${proto.toUpperCase()}`;
  else                             reason = `DSP not supported for ${proto}`;
  res.json({ eligible, protocol: proto, reason });
});

router.get('/profile/:rendererId', (req, res) => {
  try {
    const profile = dsp.getProfile(req.params.rendererId);
    // Include magnitude curve so the PEQ UI can plot without a separate call
    const curve = dsp.magnitudeResponse(profile.peq_filters || []);
    const peakGain = dsp.calculatePeakGain(profile.peq_filters || []);
    const proto = resolveProtocol(req.params.rendererId);
    const eligible = dsp.isDspEligible(proto);
    res.json({
      profile,
      curve,
      peak_gain_db: peakGain,
      eligible,
      protocol: proto,
    });
  } catch (e) {
    console.error('GET /dsp/profile failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// Partial update. Body is the patch object — any subset of profile fields.
// We deliberately don't validate the shape too strictly; saveProfile()
// merges with the existing row so callers can send only what they changed.
router.put('/profile/:rendererId', async (req, res) => {
  try {
    const patch = req.body || {};
    // Whitelist the fields the client is allowed to set. peq_preamp_db
    // explicitly NOT in this list — it's calculated server-side on save so
    // the client can't bypass clipping protection.
    //
    // v1.1.0.60 — fixes a save-silently-fails bug. The v1.1.0.53 release
    // wired the HeadroomSection UI to PUT { headroom_enabled, headroom_db }
    // but this allow-list was the v29.6 ghost without those fields, so
    // every save was silently dropped before reaching saveProfile. The
    // UI showed "Saved ✓" because the response came back fine; what came
    // back was the *unchanged* row. Six releases later we re-added them
    // to the list. Confirmed by reading the route code with the user.
    const ALLOWED = new Set([
      'master_enabled', 'peq_enabled', 'peq_filters',
      'headroom_enabled', 'headroom_db',
      'conv_enabled', 'conv_irs', 'conv_dry_db', 'conv_wet_db',
      'crossfeed_enabled', 'crossfeed_profile',
      'autoeq_model',
      // v1.1.32.0 — volume levelling, now per zone.
      'vl_enabled', 'vl_mode', 'vl_target_lufs',
    ]);
    const filtered = {};
    for (const [k, v] of Object.entries(patch)) {
      if (ALLOWED.has(k)) filtered[k] = v;
    }
    const merged = dsp.saveProfile(req.params.rendererId, filtered);
    const curve = dsp.magnitudeResponse(merged.peq_filters || []);
    // Auto-restart after the response is sent — saves don't have to wait
    // on the renderer round-trip.
    res.json({ profile: merged, curve, peak_gain_db: dsp.calculatePeakGain(merged.peq_filters || []) });
    reapplyDspToRenderer(req.params.rendererId);
  } catch (e) {
    console.error('PUT /dsp/profile failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// Live preview endpoint — does NOT save. Lets the manual-PEQ UI show the
// curve and preamp for an in-progress filter list before the user hits Save.
router.post('/peq/preview', (req, res) => {
  try {
    const filters = Array.isArray(req.body?.filters) ? req.body.filters : [];
    const peak = dsp.calculatePeakGain(filters);
    res.json({
      curve: dsp.magnitudeResponse(filters),
      peak_gain_db: peak,
      // The preamp the system would auto-set if this filter list were saved.
      auto_preamp_db: -peak,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- AutoEQ ----

// Load and cache the AutoEQ index. The index is a flat list of
// `{ model, slug, category }` so the UI can build a searchable dropdown
// without having to enumerate the filesystem on every request.
let autoeqIndexCache = null;
let autoeqIndexCacheStat = null;

function loadAutoeqIndex() {
  const indexPath = path.join(paths.AUTOEQ_DIR, 'index.json');
  if (!fs.existsSync(indexPath)) return [];
  // Cache invalidates if the file mtime changes (e.g. user fetched a new
  // database). Cheap stat call avoids re-reading on every UI keystroke.
  try {
    const st = fs.statSync(indexPath);
    if (autoeqIndexCache && autoeqIndexCacheStat?.mtimeMs === st.mtimeMs) {
      return autoeqIndexCache;
    }
    autoeqIndexCache = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    autoeqIndexCacheStat = st;
    return autoeqIndexCache;
  } catch (e) {
    console.warn('AutoEQ index load failed:', e.message);
    return [];
  }
}

router.get('/autoeq/index', (req, res) => {
  const idx = loadAutoeqIndex();
  res.json({ models: idx, count: idx.length });
});

// Parse an AutoEQ ParametricEQ.txt file into our biquad shape.
// File format (from AutoEQ project):
//   Preamp: -6.5 dB
//   Filter 1: ON PK Fc 105 Hz Gain 6.0 dB Q 0.70
//   Filter 2: ON LSC Fc 105 Hz Gain 6.0 dB Q 0.70
//   ...
function parseAutoeqText(content) {
  const out = { preamp_db: 0, filters: [] };
  for (const line of content.split(/\r?\n/)) {
    const preMatch = line.match(/^\s*Preamp:\s*([-\d.]+)\s*dB/i);
    if (preMatch) { out.preamp_db = parseFloat(preMatch[1]); continue; }
    // "Filter N: ON PK Fc 105 Hz Gain 6.0 dB Q 0.70"
    const filtMatch = line.match(
      /^\s*Filter\s+\d+:\s*ON\s+(\w+)\s+Fc\s+([\d.]+)\s*Hz\s+Gain\s+([-\d.]+)\s*dB\s+Q\s+([\d.]+)/i
    );
    if (filtMatch) {
      const [, type, fc, gain, q] = filtMatch;
      out.filters.push({
        type:  String(type).toUpperCase(),
        fc:    parseFloat(fc),
        gain:  parseFloat(gain),
        q:     parseFloat(q),
      });
    }
  }
  return out;
}

router.get('/autoeq/preset/:slug', (req, res) => {
  try {
    const slug = String(req.params.slug);
    const presetPath = resolveSafeAutoeqPath(slug);
    if (!presetPath) return res.status(400).json({ error: 'Invalid slug' });
    if (!fs.existsSync(presetPath)) return res.status(404).json({ error: 'Preset not found' });
    const content = fs.readFileSync(presetPath, 'utf8');
    const parsed = parseAutoeqText(content);
    res.json({ slug, ...parsed, raw: content });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Apply an AutoEQ preset to a renderer's PEQ profile. This sets:
//   peq_filters    — from the preset
//   peq_enabled    — true (so the user sees the effect immediately)
//   autoeq_model   — display label for the UI
// preamp_db from the preset is *informational*; the server recomputes its
// own auto-preamp from the actual filters on save.
router.post('/autoeq/apply', (req, res) => {
  try {
    const { rendererId, slug } = req.body || {};
    if (!rendererId || !slug) return res.status(400).json({ error: 'rendererId and slug required' });
    const presetPath = resolveSafeAutoeqPath(String(slug));
    if (!presetPath) return res.status(400).json({ error: 'Invalid slug' });
    if (!fs.existsSync(presetPath)) return res.status(404).json({ error: 'Preset not found' });
    const parsed = parseAutoeqText(fs.readFileSync(presetPath, 'utf8'));
    // Look up display name from index — slug is path-safe but the index has
    // the human label.
    const idx = loadAutoeqIndex();
    const entry = idx.find(e => e.slug === slug);
    const modelLabel = entry?.model || slug;
    const merged = dsp.saveProfile(rendererId, {
      peq_filters: parsed.filters,
      peq_enabled: true,
      autoeq_model: modelLabel,
    });
    res.json({
      profile: merged,
      curve: dsp.magnitudeResponse(merged.peq_filters || []),
      peak_gain_db: dsp.calculatePeakGain(merged.peq_filters || []),
      autoeq_preamp_hint_db: parsed.preamp_db,
    });
    reapplyDspToRenderer(rendererId);
  } catch (e) {
    console.error('POST /dsp/autoeq/apply failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// List crossfeed profiles available
// Refresh the bundled AutoEQ database from GitHub. Long-running operation
// (~30-60s, ~3000 small fetches) so we kick it off in the background and
// return immediately. Client polls /autoeq/update/progress for status.
//   POST /api/dsp/autoeq/update            → start refresh
//   GET  /api/dsp/autoeq/update/progress   → status snapshot
router.post('/autoeq/update', (req, res) => {
  const replace = !!req.body?.replace;  // overwrite local files even if already present
  const r = autoeqUpdater.startRefresh({ replace });
  if (!r.ok) return res.status(409).json({ error: r.reason });
  // Invalidate the in-process index cache too, so when the refresh writes
  // the new index.json the /autoeq/index endpoint serves fresh data
  // immediately rather than the stale cache.
  autoeqIndexCache = null;
  autoeqIndexCacheStat = null;
  res.json({ ok: true });
});

router.get('/autoeq/update/progress', (req, res) => {
  res.json(autoeqUpdater.getProgress());
});

router.get('/crossfeed/profiles', (req, res) => {
  res.json([
    { id: 'default', name: 'Default (Bauer)',  desc: '700 Hz cut, 4.5 dB feed' },
    { id: 'cmoy',    name: 'Chu Moy',          desc: '700 Hz cut, 6 dB feed' },
    { id: 'jmeier',  name: 'Jan Meier',        desc: '650 Hz cut, 9.5 dB feed' },
    { id: 'meier',   name: 'Meier (alt)',      desc: 'Alternate Meier profile' },
  ]);
});

// ---- FIR / convolution (#29.1) ----
//
// Endpoints:
//   GET    /api/dsp/fir/:rendererId             → list of currently-uploaded
//                                                 IRs by sample rate
//   POST   /api/dsp/fir/:rendererId/:rate       → upload one IR (raw audio/wav body)
//   DELETE /api/dsp/fir/:rendererId/:rate       → remove one IR
//   GET    /api/dsp/fir/supported-rates         → static list of supported rates
//
// We use express.raw() with a generous size cap. The fir module enforces the
// real per-IR limits (length, channel count, bit depth) after parsing the
// header — getting clean errors at the parse stage is more useful than a
// blanket "413 too large" from middleware.
const wavBody = express.raw({ type: ['audio/wav', 'audio/wave', 'audio/x-wav', 'application/octet-stream'], limit: '20mb' });

router.get('/fir/supported-rates', (req, res) => {
  res.json({ rates: fir.SUPPORTED_RATES, max_duration_seconds: fir.MAX_IR_DURATION_SECONDS });
});

router.get('/fir/:rendererId', (req, res) => {
  try {
    const irs = fir.listIrs(req.params.rendererId);
    res.json({
      rendererId: req.params.rendererId,
      irs,
      supportedRates: fir.SUPPORTED_RATES,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/fir/:rendererId/:rate', wavBody, (req, res) => {
  try {
    const rendererId = req.params.rendererId;
    const rate = parseInt(req.params.rate, 10);
    if (!fir.SUPPORTED_RATES.includes(rate)) {
      return res.status(400).json({ error: `Rate ${rate} not in supported set: ${fir.SUPPORTED_RATES.join(', ')}` });
    }
    if (!req.body || !Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'No file body. Send the WAV bytes with Content-Type: audio/wav.' });
    }
    if (req.body.length > fir.MAX_IR_FILE_SIZE) {
      return res.status(413).json({ error: `File too large (${req.body.length} bytes). Max ${fir.MAX_IR_FILE_SIZE}.` });
    }
    // Parse the header. If the user uploaded an IR with a sample rate that
    // doesn't match the URL path's rate, that's a user error worth flagging
    // — silently going along would set them up for hours of debugging "why
    // does my room correction sound off."
    const parsed = fir.parseWavHeader(req.body);
    if (!parsed.ok) {
      return res.status(400).json({ error: parsed.error });
    }
    if (parsed.sampleRate !== rate) {
      return res.status(400).json({
        error: `IR is ${parsed.sampleRate} Hz but you uploaded it as ${rate} Hz. Either re-export the IR at ${rate} Hz, or upload it under the ${parsed.sampleRate} Hz slot.`,
      });
    }

    fir.saveIr(rendererId, rate, req.body);
    res.json({
      ok: true,
      sampleRate: parsed.sampleRate,
      channels: parsed.channels,
      bitDepth: parsed.bitDepth,
      format: parsed.format,
      sampleCount: parsed.sampleCount,
      durationSeconds: parsed.durationSeconds,
      fileSize: parsed.fileSize,
    });
    // Only restart if convolution is currently enabled — uploading an IR
    // for a renderer where conv is off doesn't change live audio.
    try {
      const profile = dsp.getProfile(rendererId);
      if (profile?.conv_enabled) reapplyDspToRenderer(rendererId);
    } catch {}
  } catch (e) {
    console.error('IR upload failed:', e);
    res.status(500).json({ error: e.message });
  }
});

router.delete('/fir/:rendererId/:rate', (req, res) => {
  const rate = parseInt(req.params.rate, 10);
  if (!fir.SUPPORTED_RATES.includes(rate)) {
    return res.status(400).json({ error: 'Bad rate' });
  }
  const rendererId = req.params.rendererId;
  // v1.1.0.85 — capture conv_enabled BEFORE the delete so we can
  // decide whether to reapply afterwards. Once we delete the IR,
  // and possibly clear conv_enabled (below), we can't tell whether
  // the live chain was using FIR.
  let convWasActive = false;
  try {
    const profileBefore = dsp.getProfile(rendererId);
    convWasActive = !!profileBefore?.conv_enabled;
  } catch {}

  const removed = fir.deleteIr(rendererId, rate);

  // v1.1.0.84 — if this was the last IR on the renderer and convolution
  // is still flagged enabled in the DSP profile, clear the flag. Without
  // this the user is left with a checked-but-greyed-out tickbox in the
  // DSP UI (because there are no IRs to convolve with), the signal path
  // shows "FIR Convolution · Skipped — no IR uploaded" as a permanent
  // bypassed node, and the underlying conv_enabled flag never aligns
  // with reality. The fix: when the IR count drops to zero, also save
  // conv_enabled = false. saveProfile will recompute peq_preamp_db,
  // clipping_indicator, etc. as a side-effect, which is correct
  // behaviour — without IRs, there's no FIR contribution to clip risk.
  if (removed) {
    try {
      const remaining = fir.listIrs(rendererId);
      const remainingCount = Object.keys(remaining || {}).length;
      if (remainingCount === 0) {
        const profile = dsp.getProfile(rendererId);
        if (profile?.conv_enabled) {
          dsp.saveProfile(rendererId, { conv_enabled: false });
          console.log(`[fir] last IR deleted for renderer ${rendererId.slice(0, 12)}; cleared conv_enabled`);
        }
      }
    } catch (e) {
      // Don't fail the delete on a profile-update hiccup — the IR is
      // gone either way. Log and move on.
      console.warn('[fir] post-delete profile sync failed:', e?.message);
    }
  }

  res.json({ ok: removed });

  // v1.1.0.85 — if convolution was active for this renderer at delete
  // time, the live chain just changed. Restart the current track so
  // the user hears the difference rather than waiting for the next
  // track. Skip when conv was already off (deleting an unused IR
  // doesn't affect playback).
  if (removed && convWasActive) {
    reapplyDspToRenderer(rendererId);
  }
});

// ---- DSP profile management (#29.3) ----
//
// Per-renderer named profile sets. Each renderer has its own list of saved
// configurations; one is marked active. Apply copies a saved profile's
// payload into the live renderer_dsp row that the stream pipeline reads.
//
// Endpoints:
//   GET    /api/dsp/profiles/:rendererId             → list (no payload)
//   POST   /api/dsp/profiles/:rendererId             → create from live state
//                                                      body: { name }
//   GET    /api/dsp/profile-detail/:profileId        → one profile with payload
//   PUT    /api/dsp/profile/:profileId/apply         → apply (copy → live)
//   PUT    /api/dsp/profile/:profileId/save          → overwrite from live
//   PUT    /api/dsp/profile/:profileId/rename        → body: { name }
//   DELETE /api/dsp/profiles                         → multi-delete
//                                                      body: { ids: [..] }
router.get('/profiles/:rendererId', (req, res) => {
  try {
    res.json({
      rendererId: req.params.rendererId,
      profiles: profiles.listProfiles(req.params.rendererId),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/profiles/:rendererId', (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name required' });
    const id = profiles.createFromLive(req.params.rendererId, name);
    res.json({ ok: true, id });
  } catch (e) {
    // Friendly user-facing errors (UNIQUE collisions, name validation) come
    // back as 409/400 so the UI can show them inline. Server-side problems
    // surface as 500.
    const msg = e.message || 'Create failed';
    const code = msg.includes('exists') ? 409 : msg.includes('required') || msg.includes('too long') ? 400 : 500;
    res.status(code).json({ error: msg });
  }
});

router.get('/profile-detail/:profileId', (req, res) => {
  try {
    const p = profiles.getProfile(parseInt(req.params.profileId, 10));
    if (!p) return res.status(404).json({ error: 'Profile not found' });
    res.json(p);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/profile/:profileId/apply', (req, res) => {
  try {
    const p = profiles.applyProfile(parseInt(req.params.profileId, 10));
    res.json({ ok: true, profile: p });
    // Apply changes the live state. Restart so the user hears it.
    if (p?.renderer_id) reapplyDspToRenderer(p.renderer_id);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/profile/:profileId/save', (req, res) => {
  try {
    const profileId = parseInt(req.params.profileId, 10);
    const detail = profiles.getProfile(profileId);
    if (!detail) return res.status(404).json({ error: 'Profile not found' });
    const p = profiles.saveLiveToProfile(profileId, detail.renderer_id);
    res.json({ ok: true, profile: p });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/profile/:profileId/rename', (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name required' });
    const p = profiles.renameProfile(parseInt(req.params.profileId, 10), name);
    res.json({ ok: true, profile: p });
  } catch (e) {
    const msg = e.message || 'Rename failed';
    const code = msg.includes('exists') ? 409 : msg.includes('too long') || msg.includes('required') ? 400 : 500;
    res.status(code).json({ error: msg });
  }
});

router.delete('/profiles', (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(n => parseInt(n, 10)).filter(n => !isNaN(n)) : [];
    if (ids.length === 0) return res.status(400).json({ error: 'No ids' });
    const r = profiles.deleteProfiles(ids);
    res.json({ ok: true, ...r });
  } catch (e) {
    // The "would leave zero profiles" rule is a 409 since the request is
    // valid but conflicts with state.
    const msg = e.message || 'Delete failed';
    const code = msg.includes('every profile') ? 409 : 500;
    res.status(code).json({ error: msg });
  }
});

module.exports = router;
