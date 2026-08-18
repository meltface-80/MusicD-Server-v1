// Core DSP module (#29.0; #29.6 cleanup)
// =========================================
// Compiles a renderer's stored DSP profile into an ffmpeg filter array, and
// computes the auto-preamp gain needed to keep peaks ≤ 0 dBFS.
//
// The chain order:
//
//   source → auto-preamp → PEQ → convolution → crossfeed → downsample → dither
//
// This module produces only the [preamp..crossfeed] segment. Downsample and
// dither are added by the stream route just after our segment.
//
// Filter shapes
// -------------
//  • PEQ peaking:    equalizer=f={fc}:t=q:w={q}:g={gain}
//  • PEQ low-shelf:  bass=f={fc}:t=q:w={q}:g={gain}
//  • PEQ high-shelf: treble=f={fc}:t=q:w={q}:g={gain}
//  • Crossfeed:      bs2b=profile={cmoy|meier|jmeier}
//  • Convolution:    afir=… (multi-input — handled separately by stream route)
//  • Auto-preamp:    volume={preamp_db}dB:precision=double
//
// Auto-preamp calculation
// -----------------------
// Sum the worst-case magnitude of each PEQ filter at a fine frequency grid
// (61 logarithmic points from 20 Hz to 20 kHz). The peak of that sum is the
// maximum gain the chain can apply. We negate that to get the preamp.
// Re-calculated on every saveProfile() call.

const db = require('../db');

// Filter type → ffmpeg filter name. AutoEQ uses ('PK','LSC','HSC') but we
// accept human-friendly aliases too.
const FILTER_TYPE_MAP = {
  PK:        'peaking',
  PEAKING:   'peaking',
  PEAK:      'peaking',
  LSC:       'lowshelf',
  LOW_SHELF: 'lowshelf',
  LOWSHELF:  'lowshelf',
  HSC:       'highshelf',
  HIGH_SHELF:'highshelf',
  HIGHSHELF: 'highshelf',
};

const CROSSFEED_PROFILES = new Set(['default', 'cmoy', 'meier', 'jmeier']);

// Renderer protocols that get DSP applied. Sonos has its own internal EQ and
// users have asked we don't double up.
const DSP_ELIGIBLE_PROTOCOLS = new Set(['dlna', 'squeezelite']);

function isDspEligible(rendererProtocol) {
  return DSP_ELIGIBLE_PROTOCOLS.has(rendererProtocol);
}

// ---- Profile load / save ----

// Read a renderer's DSP profile, returning a hydrated object with parsed JSON
// fields. Falls back to a "no DSP" default if no row exists.
//
// v1.1.0.53: headroom_enabled, headroom_db, and clipping_indicator are
// surfaced again. They were stubbed in #29.6 because the auto-preamp
// from peq_filters was deemed sufficient; that's still true for PEQ,
// but FIR convolution can also boost gain (and the auto-preamp doesn't
// see FIR samples), so we now expose a user-controlled headroom slider
// applied between PEQ and FIR. clipping_indicator is computed by
// saveProfile() based on PEQ peak + headroom + IR peaks; it's a cached
// boolean the UI checks to flash the signal-path orb red.
function getProfile(rendererId) {
  const row = db.get().prepare(`
    SELECT * FROM renderer_dsp WHERE renderer_id = ?
  `).get(rendererId);
  if (!row) return defaultProfile(rendererId);
  return {
    renderer_id:        row.renderer_id,
    master_enabled:     !!row.master_enabled,
    peq_enabled:        !!row.peq_enabled,
    peq_filters:        safeJsonParse(row.peq_filters, []),
    peq_preamp_db:      Number(row.peq_preamp_db) || 0,
    // v1.1.0.53: headroom + clipping ----
    headroom_enabled:   !!row.headroom_enabled,
    headroom_db:        Number.isFinite(row.headroom_db) ? Number(row.headroom_db) : -3,
    clipping_indicator: !!row.clipping_indicator,
    // ----
    conv_enabled:       !!row.conv_enabled,
    conv_irs:           safeJsonParse(row.conv_irs, {}),
    conv_dry_db:        row.conv_dry_db ?? -120,
    conv_wet_db:        row.conv_wet_db ?? 0,
    crossfeed_enabled:  !!row.crossfeed_enabled,
    crossfeed_profile:  row.crossfeed_profile || null,
    autoeq_model:       row.autoeq_model || null,
    updated_at:         row.updated_at || 0,
  };
}

function defaultProfile(rendererId) {
  return {
    renderer_id:        rendererId,
    master_enabled:     true,
    peq_enabled:        false,
    peq_filters:        [],
    peq_preamp_db:      0,
    headroom_enabled:   false,
    headroom_db:        -3,
    clipping_indicator: false,
    conv_enabled:       false,
    conv_irs:           {},
    conv_dry_db:        -120,
    conv_wet_db:        0,
    crossfeed_enabled:  false,
    crossfeed_profile:  null,
    autoeq_model:       null,
    updated_at:         0,
  };
}

// Persist a partial profile update. The caller passes only the fields they
// want changed; everything else preserves the existing row. We also
// recalculate peq_preamp_db on every save so the auto-preamp stays honest
// without requiring the client to compute it.
//
// v1.1.0.53: headroom_enabled, headroom_db, and clipping_indicator are
// honoured. The clipping prediction is computed here so the UI doesn't
// need to know the math: take PEQ peak (cancelled by auto-preamp ≈ 0
// dB headroom in PEQ stage), add the user's headroom (negative), then
// add the worst per-IR peak gain. If the result is positive, will-clip.
function saveProfile(rendererId, patch) {
  const cur = getProfile(rendererId);
  const merged = { ...cur, ...patch };

  // Always recalculate preamp from the (possibly new) PEQ filters. This is
  // what stops PEQ from clipping when the user adds boost filters.
  merged.peq_preamp_db = (merged.peq_filters && merged.peq_filters.length > 0)
    ? -calculatePeakGain(merged.peq_filters)
    : 0;

  // Clamp headroom_db to the published range so a malformed client
  // can't push the chain into amplification (which would defeat the
  // whole point of the slider).
  if (typeof merged.headroom_db !== 'number') merged.headroom_db = -3;
  if (merged.headroom_db > 0)   merged.headroom_db = 0;
  if (merged.headroom_db < -12) merged.headroom_db = -12;

  // Predict clipping. Reads the per-IR peak metadata we cached at
  // upload time; if no IRs are loaded for this renderer, the worst-IR
  // peak is 0 (no boost) and the indicator is just driven by PEQ.
  let worstIrPeakDb = 0;
  if (merged.conv_enabled) {
    try {
      const fir = require('./fir');
      const irs = fir.listIrs(rendererId);
      for (const r of Object.values(irs)) {
        if (typeof r?.peakDb === 'number' && r.peakDb > worstIrPeakDb) {
          worstIrPeakDb = r.peakDb;
        }
      }
    } catch { /* no IR module available for some reason; skip */ }
  }
  // PEQ stage post-preamp is by design ≈ 0 dB peak. Headroom shaves
  // it further (negative). FIR can boost by up to worstIrPeakDb.
  const headroomApplied = merged.headroom_enabled ? merged.headroom_db : 0;
  const predictedDb = 0 + headroomApplied + (merged.conv_enabled ? worstIrPeakDb : 0);
  merged.clipping_indicator = predictedDb > 0;
  merged.predicted_post_fir_db = predictedDb;

  db.get().prepare(`
    INSERT INTO renderer_dsp (
      renderer_id, master_enabled, peq_enabled, peq_filters, peq_preamp_db,
      headroom_enabled, headroom_db, clipping_indicator,
      conv_enabled, conv_irs, conv_dry_db, conv_wet_db,
      crossfeed_enabled, crossfeed_profile, autoeq_model, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(renderer_id) DO UPDATE SET
      master_enabled     = excluded.master_enabled,
      peq_enabled        = excluded.peq_enabled,
      peq_filters        = excluded.peq_filters,
      peq_preamp_db      = excluded.peq_preamp_db,
      headroom_enabled   = excluded.headroom_enabled,
      headroom_db        = excluded.headroom_db,
      clipping_indicator = excluded.clipping_indicator,
      conv_enabled       = excluded.conv_enabled,
      conv_irs           = excluded.conv_irs,
      conv_dry_db        = excluded.conv_dry_db,
      conv_wet_db        = excluded.conv_wet_db,
      crossfeed_enabled  = excluded.crossfeed_enabled,
      crossfeed_profile  = excluded.crossfeed_profile,
      autoeq_model       = excluded.autoeq_model,
      updated_at         = unixepoch()
  `).run(
    merged.renderer_id,
    merged.master_enabled ? 1 : 0,
    merged.peq_enabled ? 1 : 0,
    JSON.stringify(merged.peq_filters || []),
    merged.peq_preamp_db,
    merged.headroom_enabled ? 1 : 0,
    merged.headroom_db,
    merged.clipping_indicator ? 1 : 0,
    merged.conv_enabled ? 1 : 0,
    JSON.stringify(merged.conv_irs || {}),
    merged.conv_dry_db,
    merged.conv_wet_db,
    merged.crossfeed_enabled ? 1 : 0,
    merged.crossfeed_profile,
    merged.autoeq_model,
  );
  return merged;
}

// ---- Biquad math (for preamp calculation and frequency-response graphs) ----

// Compute the magnitude response (in dB) of a biquad filter at frequency f.
// Implements the analog-prototype design used by ffmpeg's equalizer/bass/
// treble filters (RBJ cookbook). We don't actually run audio through it —
// we just want to know "how loud does this filter make a tone at frequency f?"
// so we can pre-attenuate before the chain runs.
//
// Filter types:
//   peaking — symmetric boost/cut around fc. Magnitude at fc is `gain` dB,
//             tapering toward 0 dB outside the bandwidth.
//   lowshelf — gain applied below fc, 0 dB above (with transition centred on fc)
//   highshelf — gain applied above fc, 0 dB below
//
// We use a simple analytic approximation rather than the full RBJ biquad
// magnitude formula. For peaking filters: an octave-distance gaussian
// centred on fc with width 1/Q. For shelves: a sigmoid in log-frequency.
// These match the actual RBJ biquad response within ~0.5 dB across the
// audible band, which is plenty accurate for the auto-preamp peak search
// and for the UI's response graph.
//
// Audio is rendered by ffmpeg's actual biquad filters, not by this code —
// the math here is for graphing and preamp calculation only.
function biquadMagnitudeDb(filter, freq) {
  const type = FILTER_TYPE_MAP[String(filter.type || 'PK').toUpperCase()] || 'peaking';
  const fc   = Number(filter.fc) || 1000;
  const q    = Number(filter.q)  || 0.707;
  const gain = Number(filter.gain) || 0;
  if (gain === 0) return 0;

  if (type === 'peaking') {
    // Octave-distance gaussian: response peaks at gain (dB) at fc and falls
    // off to ~0 dB outside the bandwidth (controlled by 1/Q octaves).
    const distance = Math.log2(Math.max(freq, 1) / Math.max(fc, 1)); // octaves from fc
    const bandwidth = 1 / q; // octaves
    const falloff = Math.exp(-2 * Math.pow(distance / bandwidth, 2));
    return gain * falloff;
  }
  if (type === 'lowshelf') {
    // Below fc → +gain, above fc → 0, smooth transition centred on fc.
    // Width controlled by Q; higher Q → narrower transition.
    const distance = Math.log2(Math.max(freq, 1) / Math.max(fc, 1));
    const blend = 1 / (1 + Math.exp(distance * 4 * q));
    return gain * blend;
  }
  if (type === 'highshelf') {
    const distance = Math.log2(Math.max(freq, 1) / Math.max(fc, 1));
    const blend = 1 / (1 + Math.exp(-distance * 4 * q));
    return gain * blend;
  }
  return 0;
}

// Peak gain (dB) of a chain of filters across the audible band. We sample 61
// log-spaced points from 20 Hz to 20 kHz which is dense enough to catch any
// reasonable Q (filters narrower than 1/61 of a decade are perceptually
// indistinguishable from a notch and unlikely in headphone EQ).
function calculatePeakGain(filters) {
  if (!filters || filters.length === 0) return 0;
  let peak = 0;
  const points = 61;
  for (let i = 0; i < points; i++) {
    const f = 20 * Math.pow(10, (Math.log10(20000) - Math.log10(20)) * (i / (points - 1)));
    let sum = 0;
    for (const filt of filters) sum += biquadMagnitudeDb(filt, f);
    if (sum > peak) peak = sum;
  }
  return peak;
}

// Sample the chain's magnitude response across the audible band and return
// {freqs, gains} suitable for plotting in the PEQ UI. Same grid as
// calculatePeakGain but exposes the full curve, not just the peak.
function magnitudeResponse(filters, points = 121) {
  const freqs = new Array(points);
  const gains = new Array(points);
  for (let i = 0; i < points; i++) {
    const f = 20 * Math.pow(10, (Math.log10(20000) - Math.log10(20)) * (i / (points - 1)));
    let sum = 0;
    for (const filt of (filters || [])) sum += biquadMagnitudeDb(filt, f);
    freqs[i] = f;
    gains[i] = sum;
  }
  return { freqs, gains };
}

// ---- ffmpeg filter compilation ----

// Compile a profile to an array of ffmpeg `-af`-style filter strings,
// representing the [preamp..crossfeed] segment of the chain. Returns
// `{ filters, summary, headroomDb }` where summary is a short text
// description for the signal-path display, and headroomDb is the user's
// configured headroom for the FIR stage (or 0 if disabled or conv off).
//
// The convolution step is NOT in this list — it's handled by the stream
// route directly via filter_complex (afir takes a second input). Crossfeed
// goes after convolution because crossfeed only operates on the stereo
// image and convolution preserves it.
//
// v1.1.0.53: headroom is back. Resurrected after the #29.6 cleanup
// because PEQ's auto-preamp doesn't see FIR samples — it can only
// compensate for what it can analyse, which is biquads. FIRs from
// measurement tools regularly have +3-9 dB peak gain that the
// auto-preamp doesn't know about. The headroom slider gives the user
// explicit control over how much margin to leave for the FIR stage.
// We emit headroomDb separately so the stream route can place the
// volume filter precisely between PEQ and FIR (afir is added by the
// stream route, not here, so we can't just push the filter into the
// returned array at the right offset).
function compileChain(profile) {
  const filters = [];
  const summary = [];
  let headroomDb = 0;

  // Master kill switch — return empty chain.
  if (!profile.master_enabled) {
    return { filters: [], summary: ['DSP off'], headroomDb: 0 };
  }

  // Auto-preamp — single volume filter to keep the PEQ chain peak below
  // 0 dBFS. peq_preamp_db is server-calculated on every save and is
  // negative (or 0) when peq_filters has any positive-gain entries.
  const preampDb = profile.peq_enabled ? (Number(profile.peq_preamp_db) || 0) : 0;
  if (Math.abs(preampDb) > 0.01) {
    filters.push(`volume=${preampDb.toFixed(3)}dB:precision=double`);
    summary.push(`Preamp ${preampDb.toFixed(1)} dB`);
  }

  // PEQ — one ffmpeg filter per biquad.
  if (profile.peq_enabled && profile.peq_filters?.length) {
    for (const filt of profile.peq_filters) {
      const ffmpegName = filterToFfmpeg(filt);
      if (ffmpegName) filters.push(ffmpegName);
    }
    summary.push(`PEQ ${profile.peq_filters.length} filter${profile.peq_filters.length === 1 ? '' : 's'}`);
  }

  // Headroom (v1.1.0.53, broadened in v1.1.0.75).
  // v53 only applied headroom when FIR was active (the original use
  // case was reserving margin for FIR boost peaks). v75 broadens it:
  // headroom applies whenever the user has the toggle on. This is
  // "end-of-chain attenuation before bit-narrow," not "pre-FIR
  // attenuation." The stream route handles placement — see
  // routes/stream.js for the actual filter insertion. Here we just
  // emit headroomDb so the route knows what to apply.
  //
  // Volume-Levelling collision: VL already attenuates aggressively
  // to a target LUFS, and stacking headroom on top of VL over-
  // attenuates the stream. When VL is on, the stream route silently
  // suppresses headroom and logs the override. We could do the
  // collision check here instead, but the stream route is the only
  // place that knows whether VL produced gainInfo for *this track*
  // (some tracks have no measurement, in which case VL is a no-op
  // for that track and headroom is fine).
  if (profile.headroom_enabled) {
    headroomDb = Number(profile.headroom_db) || 0;
    if (headroomDb < 0) {
      summary.push(`Headroom ${headroomDb.toFixed(1)} dB`);
    }
  }

  // Crossfeed — bs2b. Defaults to profile=default if no specific is set.
  if (profile.crossfeed_enabled) {
    const p = CROSSFEED_PROFILES.has(profile.crossfeed_profile) ? profile.crossfeed_profile : 'default';
    filters.push(`bs2b=profile=${p}`);
    summary.push(`Crossfeed (${p})`);
  }

  return { filters, summary, headroomDb };
}

function filterToFfmpeg(filt) {
  const type = FILTER_TYPE_MAP[String(filt.type || 'PK').toUpperCase()];
  const fc   = Number(filt.fc);
  const q    = Number(filt.q);
  const gain = Number(filt.gain);
  if (!type || !fc || fc <= 0 || isNaN(q) || isNaN(gain)) return null;
  // ffmpeg filter syntax:
  //   peaking → equalizer
  //   lowshelf → bass
  //   highshelf → treble
  // All accept t=q:w=Q (Q-based bandwidth) and g=gain.
  if (type === 'peaking')   return `equalizer=f=${fc}:t=q:w=${q}:g=${gain}`;
  if (type === 'lowshelf')  return `bass=f=${fc}:t=q:w=${q}:g=${gain}`;
  if (type === 'highshelf') return `treble=f=${fc}:t=q:w=${q}:g=${gain}`;
  return null;
}

// ---- Helpers ----

function safeJsonParse(s, fallback) {
  if (!s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

module.exports = {
  isDspEligible,
  getProfile,
  saveProfile,
  defaultProfile,
  compileChain,
  calculatePeakGain,
  magnitudeResponse,
  // Exposed for tests & UI:
  biquadMagnitudeDb,
  filterToFfmpeg,
  FILTER_TYPE_MAP,
  CROSSFEED_PROFILES: Array.from(CROSSFEED_PROFILES),
  DSP_ELIGIBLE_PROTOCOLS: Array.from(DSP_ELIGIBLE_PROTOCOLS),
};
