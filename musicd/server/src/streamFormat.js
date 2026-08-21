/**
 * predictStreamFormat — given a track and a renderer context, predict
 * what the /api/stream endpoint will actually serve.
 *
 * Returns { mime, willPassThrough } where:
 *   mime: the Content-Type string the response will carry
 *   willPassThrough: true if the file goes straight from disk to the renderer
 *
 * Used by:
 *   - renderers/sonos.js and renderers/dlna.js to populate DIDL-Lite
 *     `protocolInfo` accurately, so the renderer's claim matches what
 *     it'll actually receive.
 *   - the stream route itself, indirectly, by mirroring the same logic.
 *
 * The decision tree must match routes/stream.js exactly. If you change
 * the pass-through criteria there, change them here too.
 */
const path = require('path');
// Loaded lazily inside the function to avoid a circular require
// (renderers/dlna -> streamFormat -> renderers). At import time the
// renderers module may not yet have its `module.exports` populated.
let _renderers, _loudness, _dsp, _planDownsample;
function lazyImports() {
  if (!_renderers) {
    _renderers     = require('./renderers');
    _loudness      = require('./loudness');
    _dsp           = require('./dsp');
    _planDownsample = require('./downsamplePlan').planDownsample;
  }
}

const PASS_THROUGH_EXTS = new Set(['.flac', '.mp3', '.wav', '.aif', '.aiff']);
const MIME_BY_EXT = {
  '.flac': 'audio/flac',
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
  '.aif':  'audio/wav',
  '.aiff': 'audio/wav',
};
const DSD_EXTS = new Set(['.dsf', '.dff', '.dsd']);

function extOf(track) {
  if (!track || !track.path) return '';
  return path.extname(track.path).toLowerCase();
}

function predictStreamFormat(track, rendererId, sourceRate) {
  lazyImports();
  const ext = extOf(track);
  const isDSD = DSD_EXTS.has(ext);
  const couldPassThrough = PASS_THROUGH_EXTS.has(ext) && !isDSD;

  // Volume-levelling forces re-encode when enabled.
  //
  // v1.1.32.0 — per zone. Without the rendererId this cannot be answered, and
  // guessing "off" would make the DIDL claim pass-through for a stream that
  // is about to be re-encoded — so with no renderer we fall back to the
  // global, which is what every zone resolves to until it is set anyway.
  // getProfile resolves an unknown or absent renderer to the same frozen
  // global every unset zone resolves to, so there is no second path to write
  // here — and no way for this to disagree with the stream route, which is
  // what would put a pass-through claim on a re-encoded stream.
  let vlEnabled = false;
  try { vlEnabled = !!_dsp.getProfile(rendererId || null).vl_enabled; } catch { /* leave false */ }

  // DSP forces re-encode when the renderer is DSP-eligible AND has a
  // non-empty compiled chain. Conservative check -- if any of these
  // gates is uncertain, assume re-encode so the DIDL claim is the
  // safer 'audio/flac'.
  let dspWillApply = false;
  if (rendererId) {
    try {
      const r = _renderers.getRenderer(rendererId);
      const proto = r?.protocol || null;
      if (proto && _dsp.isDspEligible(proto)) {
        const profile = _dsp.getProfile(rendererId);
        const compiled = _dsp.compileChain(profile);
        if (compiled && compiled.filters && compiled.filters.length > 0) {
          dspWillApply = true;
        }
      }
    } catch { /* leave dspWillApply false */ }
  }

  // Renderer-aware downsample fires when source rate exceeds the
  // renderer's maxSampleRate cap.
  let willDownsample = false;
  if (rendererId && sourceRate) {
    try {
      const r = _renderers.getRenderer(rendererId);
      if (r) {
        const plan = _planDownsample(sourceRate, r.capabilities);
        if (plan) willDownsample = true;
      }
    } catch { /* leave willDownsample false */ }
  }

  // Per-renderer Sonos 16-bit force triggers re-encode even at
  // otherwise-pass-through-eligible rates.
  let force16bit = false;
  if (rendererId) {
    try {
      const r = _renderers.getRenderer(rendererId);
      if (r?.protocol === 'sonos') {
        const db = require('./db');
        const row = db.get().prepare(
          "SELECT sonos_force_16bit FROM renderer_settings WHERE renderer_id = ?"
        ).get(rendererId);
        if (row && row.sonos_force_16bit) force16bit = true;
      }
    } catch { /* leave force16bit false */ }
  }

  const willReEncode =
    isDSD || vlEnabled || dspWillApply || willDownsample || force16bit ||
    !couldPassThrough;

  if (willReEncode) {
    return { mime: 'audio/flac', willPassThrough: false };
  }

  return {
    mime: MIME_BY_EXT[ext] || 'audio/flac',
    willPassThrough: true,
  };
}

module.exports = { predictStreamFormat };
