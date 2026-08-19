/**
 * Player state — multi-zone aware (#v1.1.0.9, real multi-zone).
 *
 * Each zone is one renderer (group support deferred). Multiple zones
 * can play independently — each maintains its own queue, position,
 * volume, and renderer poll loop. The UI tracks one "focused" zone at
 * a time (which zone the mini-player is showing), but all zones keep
 * playing regardless of focus. v1.1.0.x prior to .9 had only one
 * "active" zone at a time and switching renderers stopped the previous
 * one. That's now fully removed.
 *
 * Per-zone state survives server restart: each zone's queue+position
 * is persisted on every meaningful change.
 */
const renderers = require('./renderers');
const db = require('./db');
const { probe } = require('./probe');
const scrobbler = require('./scrobbler');

const zones = new Map(); // zoneId -> ZoneState
// The "focused" zone is the one the UI is currently showing in the
// mini-player. It does NOT mean other zones are stopped; they continue
// playing independently. Renamed from activeZoneId in v1.1.0.9 to make
// the multi-zone intent explicit.
let focusedZoneId = null;

// v1.1.1.1 — rate-limited scrobbler error logger. The polling loop
// fires every second; if the scrobbler is silently failing (e.g. a
// bug we introduced, not just last.fm being offline) we don't want
// to spam the log every tick. One warning per minute per call site
// is enough to surface the problem without drowning useful logs.
//
// Why warn at all when we previously just `catch {}`'d these? For a
// beta release we need bugs to be visible. The original silence was
// defensive — last.fm offline is a non-event. But our own code
// throwing is a bug, and that should show. The 60s rate limit is
// the compromise: visible without being noisy.
const _scrobbleLogTimes = new Map();
function _logScrobbleErrorRateLimited(callSite, err) {
  const now = Date.now();
  const last = _scrobbleLogTimes.get(callSite) || 0;
  if (now - last >= 60_000) {
    console.warn(`[scrobbler] ${callSite} failed:`, err?.message || err);
    _scrobbleLogTimes.set(callSite, now);
  }
}

// v1.1.1.1 — verbose playback tracing. Default off for beta. Set
// MUSICD_DEBUG_PLAYBACK=1 in the docker-compose environment to
// re-enable the per-advance and per-restart traces that v88-89
// added during the cascade investigation. Bail/skip/abandoned-early
// logs are NOT gated — those fire only when something unusual
// happens and are useful at any log level.
//
// What gets gated:
//   [advance] zone=.. via=.. from=N to=M  ← fires on EVERY track advance
//   [restart] zone=.. renderer=.. track=..  ← fires on every settings-driven restart
// What stays unconditional:
//   [advance] SKIP (already advancing)  ← rare, signals re-entrant call
//   [poll-stopped] BAIL  ← rare, signals restart-in-progress race
//   [poll-stopped] ABANDONED EARLY  ← v89 anti-cascade fire, ALWAYS visible
//   [poll-stopped] queue exhausted  ← natural end of queue
//   [restart] BAIL  ← unusual, no zone or wrong status
const _DEBUG_PLAYBACK = !!process.env.MUSICD_DEBUG_PLAYBACK;
function _dbgPlayback(...args) {
  if (_DEBUG_PLAYBACK) console.warn(...args);
}

// Hardcoded "default" zone id pattern: the renderer's id, or "group:<uuid>"
function makeZoneId(rendererIdOrGroupId) { return rendererIdOrGroupId; }

// v1.1.0.87 — Force a renderer (or every renderer in a zone) into a known
// idle state by issuing Stop. Called before any SetAVTransportURI on a
// renderer that's potentially mid-playback or mid-fetch.
//
// Why this exists: DLNA renderers (specifically WiiM Pro Plus, but
// others have the same shape) cache the current AVTransportURI and any
// pre-queued NextAVTransportURI with framing assumptions. When we issue
// a new SetAVTransportURI mid-stream, the renderer is in a transition
// state. If the new stream's framing differs from the old (chunked vs
// finite Content-Length), the renderer hangs up early on the new
// stream. Polling sees STOPPED, calls advanceTrack, which fires another
// SetAVTransportURI, and the cascade goes — sometimes 3-5 tracks,
// sometimes the whole album.
//
// Stop-before-Set forces the renderer fully out of any
// fetch/play/transition state so the new SetAVTransportURI lands on a
// clean slate. It costs ~100-200ms (one extra SOAP round-trip).
//
// Squeezelite and other server-push protocols don't need this — they
// have no concept of "current URI" with cached metadata, so framing
// changes are handled by the server cleanly. The Stop on those
// protocols is a near-no-op.
//
// Acceptable to fail silently — if Stop fails, the worst case is the
// pre-v87 behaviour (occasional cascade), and we'd rather proceed with
// the new track than refuse to play.
async function ensureRendererIdle(rendererIds) {
  if (!rendererIds || rendererIds.length === 0) return;
  await Promise.all(rendererIds.map(rid =>
    renderers.stop(rid).catch(e => {
      console.warn(`[ensureRendererIdle] stop ${rid}: ${e?.message}`);
    })
  ));
}

// Volume defaults and persistence (#v1.1.0.6).
// Default is intentionally low (10) -- a sane "won't blow your ears off"
// starting point for first-time renderer use. Subsequent volume changes
// are persisted per-renderer to renderer_settings.volume so restart and
// renderer-switch retain the level.
const DEFAULT_INITIAL_VOLUME = 10;

function loadPersistedVolume(rendererId) {
  try {
    const row = db.get().prepare(
      'SELECT volume FROM renderer_settings WHERE renderer_id = ?'
    ).get(rendererId);
    if (row && typeof row.volume === 'number' && row.volume >= 0 && row.volume <= 100) {
      return row.volume;
    }
  } catch (e) {
    // DB hiccup -- fall back to default. Better to play quietly than to
    // refuse to start a zone.
  }
  return DEFAULT_INITIAL_VOLUME;
}

function persistVolume(rendererId, vol) {
  try {
    db.get().prepare(`
      INSERT INTO renderer_settings (renderer_id, volume)
      VALUES (?, ?)
      ON CONFLICT(renderer_id) DO UPDATE SET volume = excluded.volume
    `).run(rendererId, Math.max(0, Math.min(100, Math.round(vol))));
  } catch (e) {
    console.warn('[playerState] failed to persist volume:', e.message);
  }
}

function newZone(zoneId, rendererIds) {
  return {
    id: zoneId,
    rendererIds: rendererIds.slice(),
    status: 'stopped',
    currentTrack: null,
    queue: [],
    queueIndex: 0,
    // Volume is hydrated from DB on first use of this zone if any of its
    // renderers have a persisted value; ensureZone() handles that. The
    // value here is just a safe fallback if zone is created bare.
    volume: DEFAULT_INITIAL_VOLUME,
    position: 0,
    positionAt: Date.now(),
    duration: 0,
    signalPath: [],
    pollTimer: null,
    consecutiveFailures: 0,
    advancing: false,
    // Gapless tracking — see startPolling() / maybePreQueueNext()
    gaplessQueued: false,
    lastPolledPosition: 0,
    // MusicD Radio (#14): when true, advanceTrack appends a random album
    // instead of stopping when the queue runs out. radioHistory keeps a small
    // ring of recent album ids so we don't repeat ourselves on each pick.
    radio: false,
    radioHistory: [],
  };
}

function getZone(id) { return zones.get(id); }
function getFocusedZone() {
  if (focusedZoneId && zones.has(focusedZoneId)) return zones.get(focusedZoneId);
  return null;
}
// Backwards-compat alias. Many callers historically said "active zone"
// when they meant "the one the user is looking at right now". With true
// multi-zone there's no single "active" zone -- they can all be active --
// so we map the term to focused for compatibility while internal code
// uses getFocusedZone(). (#v1.1.0.9)
function getActiveZone() { return getFocusedZone(); }

function setFocusedZone(zoneId) {
  // Bring this zone into focus for the UI. This does NOT touch any other
  // zone -- they keep playing/paused as they were. (#v1.1.0.9)
  focusedZoneId = zoneId;
  broadcastFullState();
}
// Compat alias.
function setActiveZone(zoneId) { setFocusedZone(zoneId); }

// Output mode lookup (#v1.1.0.8). Fixed-mode renderers feed an
// integrated amp where the analogue stage owns the volume; the
// container forces them to 100% so the digital stream is full-scale
// every time the renderer is engaged.
function getOutputMode(rendererId) {
  try {
    const row = db.get().prepare(
      "SELECT output_mode FROM renderer_settings WHERE renderer_id = ?"
    ).get(rendererId);
    return (row && row.output_mode) || 'variable';
  } catch (e) {
    return 'variable';
  }
}

function ensureZone(rendererId) {
  // For a single-renderer zone, the zoneId is the rendererId
  if (!zones.has(rendererId)) {
    const z = newZone(rendererId, [rendererId]);
    // Inherit the persisted Radio toggle (#14) so a fresh zone created after
    // server restart respects the user's last setting even if no queue was
    // restored to drive restorePersistedQueue().
    z.radio = loadRadioSetting();
    // Volume hydration depends on output mode (#v1.1.0.8):
    // - fixed:    always 100, ignore persisted value
    // - variable: persisted value, falling back to DEFAULT_INITIAL_VOLUME
    if (getOutputMode(rendererId) === 'fixed') {
      z.volume = 100;
      // Fire-and-forget: ensure the renderer actually goes to 100 too.
      // Some renderers retain their last set value across power cycles.
      renderers.setVolume(rendererId, 100).catch(() => {});
    } else {
      z.volume = loadPersistedVolume(rendererId);
    }
    zones.set(rendererId, z);
  }
  return zones.get(rendererId);
}

// ---- Helper: build signal path for a track on a renderer ----
/**
 * Build the signal path with ground-truth data from ffprobe — NOT from the DB.
 * The DB's stored sample_rate / bit_depth can be wrong (e.g. DSD-sourced FLACs
 * carry the 1-bit bitstream rate where a sample rate should be). Every node
 * in the path either reports a probed/measured value or is omitted entirely.
 *
 * Pipeline mirrors stream.js:
 *  - Pass-through (lossless source, no VL): file bytes streamed verbatim
 *  - Re-encode: ffmpeg → 64-bit float → optional gain → s32 narrowed to 24-bit
 *    with TPDF dither via aresample → FLAC encoder
 */
async function buildSignalPath(track, rendererId) {
  const path = [];
  if (!track) return path;

  // Probe the file for ground-truth stream properties. If probing fails (file
  // missing, ffprobe error), we still build a partial path from DB metadata
  // but flag the source node as 'unverified'.
  const probeResult = await probe(track.path).catch(() => ({ ok: false, error: 'probe threw' }));
  const probed = probeResult.ok ? probeResult : null;

  // Codec/format detection prefers probed data, falls back to extension/db.
  const ext = (track.format || '').toLowerCase();
  const probedCodec = (probed?.codec || '').toLowerCase();
  const isDSD = probed ? probed.isDSD : ['dsf', 'dff', 'dsd'].includes(ext);
  const isFlac = probedCodec === 'flac' || ext === 'flac';
  const isMp3 = probedCodec === 'mp3' || ext === 'mp3';
  const isWav = ['pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le'].includes(probedCodec) || ['wav', 'aif', 'aiff'].includes(ext);
  const lossyFormats = ['mp3', 'aac', 'm4a', 'ogg', 'opus', 'wma'];
  const lossyCodecs = ['mp3', 'aac', 'vorbis', 'opus', 'wmav2'];
  const isLossy = lossyCodecs.includes(probedCodec) || lossyFormats.includes(ext);

  // Probed values are authoritative; DB used only as fallback for display when
  // ffprobe couldn't be run.
  const trueRate = probed?.sampleRate ?? null;
  const trueBitDepth = probed?.bitDepth ?? null;
  const trueChannels = probed?.channels ?? track.channels ?? null;
  const trueBitrate = probed?.bitrate ?? (track.bitrate ? track.bitrate * 1000 : null); // db is kbps, probe is bps

  // Determine VL state (this isn't probed — it's a decision musicd makes)
  let vlActive = false, gainInfo = null, vlTarget = null;
  try {
    const loudness = require('./loudness');
    if (loudness.getSetting('vl_enabled', false)) {
      vlTarget = loudness.getSetting('vl_target_lufs', -18);
      gainInfo = loudness.computeStreamGain(track.id, vlTarget);
      if (gainInfo) vlActive = true;
    }
  } catch {}

  // Renderer-aware downsample plan. Sonos S2 caps at 48 kHz; high-res tracks
  // (88.2 / 96 / 176.4 / 192) get integer-divided down to 44.1 or 48 within the
  // source family, in 64-bit float. The plan returned here is the same one the
  // stream pipeline applies — see /server/src/downsamplePlan.js for the rules.
  const rendererForCaps = renderers.getRenderer(rendererId);
  const { planDownsample } = require('./downsamplePlan');
  // For DSD, the post-decimate rate is 176.4 kHz (DSD_TARGET_RATE in stream.js)
  // — that's what the renderer-cap check applies to.
  const ratePostDsd = isDSD ? 176400 : trueRate;
  const downsamplePlan = planDownsample(ratePostDsd, rendererForCaps?.capabilities);

  // Sonos 16-bit override (#v1.1.0.8). Mirror the lookup in stream.js
  // so the signal path display reflects what the encoder actually does.
  let force16bit = false;
  if (rendererForCaps && (rendererForCaps.protocol === 'sonos')) {
    try {
      const row = db.get().prepare(
        "SELECT sonos_force_16bit FROM renderer_settings WHERE renderer_id = ?"
      ).get(rendererId);
      if (row && row.sonos_force_16bit) force16bit = true;
    } catch {}
  }

  // Check whether DSP would actually compile to a non-empty chain — used in
  // both the passThrough decision (DSP forces re-encode) and the signal-path
  // node emission below. Pre-loading the profile here so the same answer
  // drives both decisions.
  let dspProfileForPath = null;
  let dspChainForPath = null;
  try {
    const dsp = require('./dsp');
    if (dsp.isDspEligible(rendererForCaps?.protocol)) {
      dspProfileForPath = dsp.getProfile(rendererId);
      dspChainForPath = dsp.compileChain(dspProfileForPath);
    }
  } catch {}
  // v1.1.0.84 — must mirror stream.js's "is DSP doing anything?" check.
  // Headroom is returned as a separate field, not bundled into filters,
  // so a headroom-only profile compiles to filters=[] but a non-zero
  // headroomDb. Both forms count as DSP-active.
  const dspWouldApply = !!(dspChainForPath && (
    dspChainForPath.filters.length > 0 ||
    (dspChainForPath.headroomDb && dspChainForPath.headroomDb < 0)
  ));

  // FIR convolution check — match stream.js's selection logic.
  let firWouldApply = false;
  if (dspProfileForPath?.master_enabled && dspProfileForPath?.conv_enabled) {
    try {
      const fir = require('./dsp/fir');
      const ir = fir.selectIrForRate(rendererId, ratePostDsd);
      if (ir) firWouldApply = true;
    } catch {}
  }

  // Mirrors stream.js's `canPassThrough` decision: DSP / FIR / 16-bit override
  // force re-encode because the source bytes have to be filtered or
  // re-quantised before going out.
  const passThrough = !gainInfo && !isDSD && !downsamplePlan && !dspWouldApply && !firWouldApply && !force16bit && (isFlac || isMp3 || isWav);

  // ── Step 1: Source File ────────────────────────────────────────────────
  const fileLabel = (track.path?.split('/').pop()) || track.title || 'Unknown';
  const sourceParts = [];
  if (probedCodec) sourceParts.push(probedCodec.toUpperCase());
  else if (ext) sourceParts.push(ext.toUpperCase());
  if (isDSD && probed?.dsdRate) {
    sourceParts.push(`1-bit ${(probed.dsdRate / 1e6).toFixed(4).replace(/\.?0+$/, '')} MHz`);
  } else {
    if (trueRate) sourceParts.push(`${(trueRate / 1000).toFixed(1)} kHz`);
    if (trueBitDepth) sourceParts.push(`${trueBitDepth}-bit`);
  }
  if (trueChannels) sourceParts.push(trueChannels === 2 ? 'stereo' : trueChannels === 1 ? 'mono' : `${trueChannels}-channel`);
  if (trueBitrate) sourceParts.push(`${Math.round(trueBitrate / 1000)} kbps`);
  path.push({
    type: 'source',
    label: 'Source File',
    detail: fileLabel,
    sub: sourceParts.join(' · '),
    icon: 'file',
    quality: isLossy ? 'lossy' : 'lossless',
    unverified: !probed,
    probeError: probed ? null : probeResult.error,
  });

  // ── Step 2: Decoder ────────────────────────────────────────────────────
  const decoderLabel = isDSD ? 'DSD Demodulator'
                     : isFlac ? 'FLAC Decoder'
                     : isMp3 ? 'MP3 Decoder'
                     : isWav ? 'PCM Reader'
                     : isLossy ? `${(probedCodec || ext).toUpperCase()} Decoder`
                     : 'libavcodec';
  path.push({
    type: 'decoder',
    label: decoderLabel,
    sub: passThrough ? 'Bypassed — file streamed verbatim' : 'libavcodec (FFmpeg)',
    icon: 'decoder',
    bypassed: passThrough,
  });

  // Re-encode pipeline only — pass-through skips straight to transport
  if (!passThrough) {
    // ── Step 3: DSD → PCM (only if actually DSD) ──────────────────────────
    // ffmpeg's DSD decoder always outputs at dsd_rate / 8, e.g. DSD64 → 352.8 kHz
    if (isDSD && probed?.dsdRate && trueRate) {
      path.push({
        type: 'processing',
        label: 'DSD → PCM',
        sub: `1-bit ${(probed.dsdRate / 1e6).toFixed(4).replace(/\.?0+$/, '')} MHz → ${(trueRate / 1000).toFixed(1)} kHz 24-bit (8× decimation)`,
        icon: 'dsd',
      });
      // ── Step 3b: Resample DSD to 176.4 kHz target ────────────────────────
      path.push({
        type: 'processing',
        label: 'Sample Rate',
        sub: `${(trueRate / 1000).toFixed(1)} kHz → 176.4 kHz (anti-aliased, 44.1 family preserved)`,
        icon: 'srate',
      });
    }

    // ── Step 4: Internal format ───────────────────────────────────────────
    path.push({
      type: 'processing',
      label: 'Internal Format',
      sub: '64-bit floating point (double precision)',
      icon: 'precision',
    });

    // ── Step 5: Volume Levelling ──────────────────────────────────────────
    if (vlActive) {
      const sign     = gainInfo.gain >= 0 ? '+' : '';
      const modeLabel = gainInfo.mode === 'album' ? 'Album' : 'Track';
      path.push({
        type: 'processing',
        label: 'Volume Levelling',
        sub: `${sign}${gainInfo.gain.toFixed(2)} dB · ${modeLabel} · target ${vlTarget} LUFS · measured ${gainInfo.measuredLufs.toFixed(1)} LUFS`,
        icon: 'volume',
        measuredLufs: gainInfo.measuredLufs,
        targetLufs: vlTarget,
        gainDb: gainInfo.gain,
        vlMode: gainInfo.mode,
      });
    }

    // ── Step 5a: DSP chain (#29.0; #29.6 cleanup) ────────────────────────
    // Per-renderer DSP profile — auto-preamp, parametric EQ, crossfeed,
    // FIR convolution. We render DSP nodes whenever a profile has the
    // corresponding feature enabled — independent of whether the renderer
    // is currently in our discovery registry.
    //
    // Eligibility is expressed via a separate "bypass" badge added when
    // the renderer protocol is one of the bypass-DSP set (Sonos has its
    // own EQ).
    try {
      const dsp = require('./dsp');
      const dspProfile = dsp.getProfile(rendererId);
      const protocol = rendererForCaps?.protocol || null;
      const eligible = dsp.isDspEligible(protocol);

      if (dspProfile.master_enabled) {
        // If the renderer is known and not eligible, surface a single
        // "bypass" node so the user understands why their saved DSP isn't
        // being applied. We still render the configured nodes after — they
        // describe what *would* be applied if a different renderer were used.
        if (protocol && !eligible) {
          path.push({
            type: 'processing',
            label: 'DSP bypassed',
            sub: protocol === 'sonos'
              ? 'Sonos has its own internal EQ'
              : `Not supported for ${protocol}`,
            icon: 'volume',
            bypassed: true,
          });
        }

        // Auto-preamp — only emitted when PEQ is on AND the calculated
        // preamp is a non-trivial cut. peq_preamp_db is server-recalculated
        // from the filter chain on every save.
        if (dspProfile.peq_enabled && Math.abs(dspProfile.peq_preamp_db || 0) > 0.01) {
          path.push({
            type: 'processing',
            label: 'Auto-preamp',
            sub: `${Number(dspProfile.peq_preamp_db).toFixed(1)} dB clip-protection`,
            icon: 'volume',
            gainDb: dspProfile.peq_preamp_db,
          });
        }

        // PEQ filters
        if (dspProfile.peq_enabled && dspProfile.peq_filters?.length > 0) {
          const summary = `${dspProfile.peq_filters.length} filter${dspProfile.peq_filters.length === 1 ? '' : 's'}`;
          path.push({
            type: 'processing',
            label: 'Parametric EQ',
            sub: dspProfile.autoeq_model
              ? `${dspProfile.autoeq_model} · ${summary}`
              : summary,
            icon: 'eq',
            filterCount: dspProfile.peq_filters.length,
            autoeqModel: dspProfile.autoeq_model || null,
          });
        }

        // FIR convolution (#29.1). Only shown when conv_enabled AND we have
        // an IR matching the source rate. If conv_enabled but no rate-match,
        // we surface a "skipped" node so the user can see why convolution
        // isn't active rather than silently dropping it.
        if (dspProfile.conv_enabled) {
          try {
            const fir = require('./dsp/fir');
            const matchRate = isDSD ? 176400 : trueRate;
            const ir = fir.selectIrForRate(rendererId, matchRate);
            if (ir) {
              const dryDb = Number(dspProfile.conv_dry_db ?? -120);
              const wetDb = Number(dspProfile.conv_wet_db ?? 0);
              const mix = (dryDb <= -100) ? 'wet only' : `dry ${dryDb} dB · wet ${wetDb} dB`;
              path.push({
                type: 'processing',
                label: 'FIR Convolution',
                sub: `IR @ ${(ir.sampleRate / 1000).toFixed(1)} kHz · ${mix}`,
                icon: 'eq',
                irRate: ir.sampleRate,
                dryDb,
                wetDb,
              });
            } else if (matchRate) {
              path.push({
                type: 'processing',
                label: 'FIR Convolution',
                sub: `Skipped — no IR uploaded for ${(matchRate/1000).toFixed(1)} kHz`,
                icon: 'eq',
                bypassed: true,
              });
            }
          } catch (e) { /* fir lookup non-fatal */ }
        }

        // Crossfeed
        if (dspProfile.crossfeed_enabled) {
          path.push({
            type: 'processing',
            label: 'Crossfeed',
            sub: `Bauer · profile ${dspProfile.crossfeed_profile || 'default'}`,
            icon: 'eq',
            profile: dspProfile.crossfeed_profile,
          });
        }

        // Headroom (v1.1.0.75). End-of-chain attenuation before
        // bit-narrow. Surfaced in the signal path so the user can
        // see the configured headroom is actually being applied.
        // When VL is active for this track, headroom is suppressed
        // by the stream route — we mirror that here with a
        // bypassed badge so the user understands why the
        // attenuation isn't being shown as active.
        if (dspProfile.headroom_enabled) {
          const hdb = Number(dspProfile.headroom_db) || 0;
          if (hdb < 0) {
            if (vlActive) {
              path.push({
                type: 'processing',
                label: 'Headroom',
                sub: `${hdb.toFixed(1)} dB suppressed — Volume Levelling already attenuating`,
                icon: 'volume',
                bypassed: true,
                gainDb: hdb,
              });
            } else {
              path.push({
                type: 'processing',
                label: 'Headroom',
                sub: `${hdb.toFixed(1)} dB · guard band before bit-narrow`,
                icon: 'volume',
                gainDb: hdb,
              });
            }
          }
        }
      }
    } catch (e) { /* DSP module errors don't break the signal path */ }

    // ── Step 5b: Renderer-driven sample-rate conversion ───────────────────
    // Only emitted when the destination renderer can't handle the source rate
    // (e.g. Sonos receiving 96 kHz: must downsample to 48 kHz). The conversion
    // happens in the 64-bit float domain before the dither/narrow stage below,
    // and stays within the source's 44.1-/48-kHz family.
    if (downsamplePlan) {
      const fromKHz = (downsamplePlan.sourceRate / 1000).toFixed(1);
      const toKHz   = (downsamplePlan.targetRate / 1000).toFixed(1);
      path.push({
        type: 'processing',
        label: 'Sample Rate',
        sub: `${fromKHz} kHz → ${toKHz} kHz · ${downsamplePlan.family} family preserved · 64-bit float, anti-aliased`,
        icon: 'srate',
        fromRate: downsamplePlan.sourceRate,
        toRate: downsamplePlan.targetRate,
        family: downsamplePlan.family,
        reason: rendererForCaps?.capabilities?.maxSampleRate
          ? `${rendererForCaps.name || 'renderer'} accepts max ${(rendererForCaps.capabilities.maxSampleRate / 1000).toFixed(0)} kHz`
          : null,
      });
    }

    // ── Step 6: Bit Depth conversion with TPDF dither ─────────────────────
    // stream.js applies aresample=osf=s32:dither_method=triangular which is
    // genuine TPDF dither — see the matching change there. The Sonos 16-bit
    // override (#v1.1.0.8) instead applies osf=s16 with the same dither.
    if (force16bit) {
      path.push({
        type: 'processing',
        label: 'Bit Depth (Sonos 16-bit)',
        sub: '64-bit float → 16-bit integer · TPDF dither (aresample triangular) · forced for this Sonos device',
        icon: 'bitdepth',
      });
    } else {
      path.push({
        type: 'processing',
        label: 'Bit Depth',
        sub: '64-bit float → 24-bit integer · TPDF dither (aresample triangular)',
        icon: 'bitdepth',
      });
    }

    // ── Step 7: Encoder ───────────────────────────────────────────────────
    // Output rate selection (in priority order):
    //   1. Downsample plan target (renderer cap forced a SRC)
    //   2. DSD pipeline fixed at 176.4 kHz
    //   3. Source rate preserved (PCM + VL only, no SRC)
    const outputRate = downsamplePlan ? downsamplePlan.targetRate
                     : isDSD ? 176400
                     : trueRate;
    const encoderRate = outputRate ? `${(outputRate / 1000).toFixed(1)} kHz` : null;
    const encoderCh = trueChannels === 2 ? 'stereo' : trueChannels === 1 ? 'mono' : trueChannels ? `${trueChannels}-ch` : null;
    const encoderBitDepth = force16bit ? 16 : 24;
    const encoderLabel = `FLAC ${encoderBitDepth}-bit`;
    path.push({
      type: 'output',
      label: 'FLAC Encoder',
      sub: [encoderLabel, encoderRate, encoderCh].filter(Boolean).join(' · '),
      icon: 'encode',
      sampleRate: outputRate,
      bitDepth: encoderBitDepth,
      channels: trueChannels || 2,
    });
  }

  // ── Step 8: Transport ────────────────────────────────────────────────────
  const renderer = renderers.getRenderer(rendererId);
  if (renderer) {
    const protocol = (renderer.protocol || '').toLowerCase();
    let transportLabel = 'HTTP';
    let transportSub = '';
    if (protocol === 'dlna' || protocol === 'sonos') {
      transportLabel = protocol === 'sonos' ? 'Sonos UPnP/AVTransport' : 'DLNA UPnP/AVTransport';
      transportSub = `SOAP control · HTTP stream → ${renderer.ip}`;
    } else if (protocol === 'squeezelite') {
      transportLabel = 'Lyrion / Squeezelite';
      transportSub = `LMS JSON-RPC · ${renderer.ip}`;
    } else {
      transportSub = `direct HTTP → ${renderer.ip}`;
    }
    path.push({
      type: 'transport',
      label: transportLabel,
      sub: transportSub,
      icon: 'transport',
      protocol,
    });

    // ── Step 9: Renderer ──────────────────────────────────────────────────
    // We do NOT claim what the renderer "received as" — we have no way to verify.
    // Once bytes leave musicd, the renderer might decode, downsample, EQ, or do
    // anything with them. We show only the renderer name + IP + transport.
    const rendererSub = [renderer.model, renderer.ip].filter(Boolean).join(' · ');
    path.push({
      type: 'renderer',
      label: renderer.name,
      sub: rendererSub,
      ip: renderer.ip,
      icon: 'speaker',
    });
  }

  // Compute orb colour (uses probed values where available)
  let orbColor = 'green'; // lossless + bit-perfect (pass-through)
  if (isLossy) orbColor = 'yellow';
  else if (!passThrough) orbColor = 'purple';

  // v1.1.0.53: clipping prediction overrides everything else. If the
  // DSP profile for this renderer says the chain will exceed 0 dBFS,
  // the orb pulses red so the user can see the warning during
  // playback without having to navigate to the DSP page.
  let clippingPredicted = false;
  try {
    const renderer = renderers.getRenderer(rendererId);
    if (renderer && renderer.protocol !== 'sonos') {
      // Sonos has DSP bypassed, so its clipping_indicator (if any) is moot.
      const dsp = require('./dsp');
      const profile = dsp.getProfile(rendererId);
      if (profile?.master_enabled && profile?.clipping_indicator) {
        clippingPredicted = true;
        orbColor = 'red';
      }
    }
  } catch { /* non-fatal — keep the original colour */ }

  if (path[0]) {
    path[0].orbColor = orbColor;
    path[0].clippingPredicted = clippingPredicted;
  }

  return path;
}

// ---- Polling ----
//
// Polling cadence and progress accuracy
// -------------------------------------
// We poll the renderer ~once per second so the broadcast `position` field
// closely tracks the device's actual transport position. The client doesn't
// blindly tick +1 between polls — it timestamp-anchors the most recent
// server-reported position (`positionAt`) and computes display as
//   displayed = position + (now - positionAt)/1000
// while playing. With sub-second polling on top, that yields a smooth bar
// that follows the real renderer instead of drifting and snapping back.
//
// Gapless playback
// ----------------
// When the current track has GAPLESS_PRELOAD_SEC or less remaining, we
// pre-queue the next track on the renderer (UPnP SetNextAVTransportURI for
// DLNA/Sonos; LMS playlist add for Squeezelite). The renderer then transitions
// from current to next without an inter-track gap. We track the pre-queue with
// `zone.gaplessQueued` to avoid sending duplicate SOAP calls each second.
//
// Auto-advance detection: when the renderer crosses into the next track, the
// reported `position` drops back to (~0 + buffer time). We treat any large
// negative jump in position as "track transitioned" and locally bump the
// queue index without calling `play()` again — the renderer's already moved
// on. We then queue the *new* next-next track.
//
// 1 Hz polling is well within budget: each cycle is two SOAP/JSON-RPC calls
// to one device on the LAN.
const POLL_INTERVAL_MS = 1000;
const GAPLESS_PRELOAD_SEC = 8;     // start pre-queue this many sec before end
const TRANSITION_DROP_SEC = 5;     // position drop greater than this = next track
// After this many consecutive poll failures we declare the renderer
// unreachable and stop polling. At 1-second polls this is an 8-second
// hard timeout — long enough to ride out brief network blips, short
// enough that a really-gone renderer doesn't sit there forever.
const POLL_FAILURE_THRESHOLD = 8;

function startPolling(zone) {
  stopPolling(zone);
  zone.consecutiveFailures = 0;
  zone.gaplessQueued = false;
  zone.lastPolledPosition = 0;
  zone.pollTick = 0;     // v1.1.6.0 — counts polls since this track started
  zone.polling = false;  // re-entrancy guard: skip ticks while a poll is in flight
  zone.pollTimer = setInterval(async () => {
    // If a previous poll is still in flight (slow LAN, device under load),
    // skip this tick rather than queue overlapping SOAP calls. We'll catch up
    // on the next tick once the in-flight call completes.
    if (zone.polling) return;
    zone.polling = true;
    try {
      // Use the first renderer in the zone for polling state
      const rid = zone.rendererIds[0];
      const transportInfo = await renderers.getTransportInfo(rid);
      const positionInfo = await renderers.getPositionInfo(rid);
      if (!transportInfo) throw new Error('no transport info');

      zone.consecutiveFailures = 0;
      const newPos = (positionInfo?.position !== undefined && positionInfo.position !== null)
        ? positionInfo.position
        : null;

      // v1.1.6.0 — trace the first few samples of each track. A progress bar
      // that starts part-way in has three possible sources: the renderer
      // reporting a stale or offset position, our state, or the client's
      // extrapolation. This pins down which, by recording exactly what the
      // device said before anything downstream touches it. First five polls
      // only, so it costs nothing during normal playback.
      zone.pollTick++;
      if (zone.pollTick <= 5) {
        _dbgPlayback(
          `[poll-head] zone=${zone.id?.slice(0, 12)} tick=${zone.pollTick} ` +
          `rawPos=${positionInfo?.position} rawDur=${positionInfo?.duration} ` +
          `state=${transportInfo.state} trackDur=${zone.currentTrack?.duration ?? '?'}`
        );
      }

      // Detect a gapless transition: when the renderer auto-advanced from the
      // pre-queued URI, the reported playhead drops back near zero while the
      // device is still PLAYING. We bump our queue index locally and refresh
      // the now-playing track without stopping/restarting playback.
      const transitioned = (
        newPos !== null &&
        zone.gaplessQueued &&
        zone.lastPolledPosition - newPos > TRANSITION_DROP_SEC &&
        transportInfo.state !== 'STOPPED'
      );

      if (newPos !== null) {
        zone.position = newPos;
        zone.positionAt = Date.now();
        zone.lastPolledPosition = newPos;
        // Last.fm scrobble eligibility check (#30.25). Cheap synchronous
        // call; scrobbler internally guards against not-connected and
        // already-scrobbled cases. Only triggers when the threshold
        // (50% played or 4 min, per Last.fm spec) is crossed.
        if (transportInfo.state !== 'STOPPED' && transportInfo.state !== 'PAUSED_PLAYBACK') {
          try { scrobbler.onPlaybackTick(zone.id, newPos); } catch (e) { _logScrobbleErrorRateLimited('onPlaybackTick', e); }
        }
      }

      if (transitioned) {
        await onGaplessTransition(zone);
        broadcastPosition(zone);
        return;
      }

      if (transportInfo.state === 'STOPPED') {
        // v1.1.0.88 diagnostic — log every STOPPED observation. Trace
        // shows: zone status (playing/paused/loading), queue position,
        // whether pollTimer is active, current position. Lets us
        // distinguish "renderer hung up early" (status=playing,
        // position < duration) from "track ended naturally"
        // (position ≈ duration) and from "Stop SOAP we sent ourselves"
        // (pollTimer null).
        // v1.1.1.1 — gated behind MUSICD_DEBUG_PLAYBACK. Fires on
        // every track end during normal playback.
        const trackDur = zone.currentTrack?.duration || 0;
        _dbgPlayback(`[poll-stopped] zone=${zone.id?.slice(0, 12)} status=${zone.status} qIdx=${zone.queueIndex}/${zone.queue.length - 1} pos=${zone.position}/${trackDur} pollTimer=${zone.pollTimer ? 'set' : 'null'} track=${zone.currentTrack?.id?.slice(0, 8) || '?'}`);

        // If the zone status is already 'paused', the STOPPED here is
        // ours -- v1.1.0.46 treats Sonos pause as Stop-with-bookmark,
        // so the renderer reports STOPPED while the user is "paused".
        // Don't let it trigger advanceTrack.
        if (zone.status === 'paused') {
          return;
        }
        // v1.1.0.86 — if stopPolling was called between this tick
        // starting and the STOPPED branch being entered, the timer
        // is now null. That means a higher-priority operation
        // (restartCurrentTrack, switchToRenderer) is in progress
        // and our advanceTrack would race against it. Bail out.
        // Without this check, restartCurrentTrack could see its own
        // explicit Stop SOAP echoed back through the polling loop
        // as a "track ended" event, fire advanceTrack, and undo
        // the restart — landing the user one track ahead of where
        // they were. Same shape as the comment further down at
        // restartCurrentTrack.
        if (!zone.pollTimer) {
          console.warn(`[poll-stopped] zone=${zone.id?.slice(0, 12)} BAIL (pollTimer null — restart in progress)`);
          return;
        }

        // v1.1.0.89 — refuse to advance the queue when the renderer
        // hung up at or near position 0. This breaks the cascade.
        //
        // Diagnosis from v88 trace: when the user toggles Headroom
        // mid-album, we restart the current track cleanly. The WiiM
        // accepts the new SetAVTransportURI, fetches the first packet
        // of the new stream, then reports STOPPED at position 0. Our
        // polling loop saw STOPPED, called advanceTrack, fetched the
        // next track. The WiiM did the same thing — STOPPED at pos=0.
        // Polling advanced again. Cascade.
        //
        // Every cascade step in the v88 trace had `pos=0/N` where N
        // was the track duration. The renderer was abandoning every
        // stream immediately. By advancing the queue on each abandoned
        // stream, we were chasing the renderer through the queue.
        //
        // This fix: if the renderer reports STOPPED but the playhead
        // is well below the track duration, the renderer didn't
        // finish the track — it abandoned it. Don't advance. Mark
        // the zone stopped and let the user manually resume (Play /
        // Next / Prev all force a fresh URI which usually works).
        //
        // Threshold: 5 seconds before the track duration. Anything
        // closer to the end is "near enough" — some renderers report
        // STOPPED a fraction of a second early.
        //
        // Edge case: tracks with duration=0 (some live streams or
        // zero-length test files) bypass this check and advance
        // normally. We only suppress when we have a real duration to
        // compare against.
        const trackDuration = zone.currentTrack?.duration || 0;
        const playedToEnd = trackDuration === 0 || zone.position >= trackDuration - 5;
        if (!playedToEnd) {
          console.warn(`[poll-stopped] zone=${zone.id?.slice(0, 12)} ABANDONED EARLY pos=${zone.position}/${trackDuration} — refusing to advance, marking stopped`);
          updateZone(zone, { status: 'stopped', position: 0 });
          stopPolling(zone);
          return;
        }

        try { scrobbler.onTrackEnd(zone.id); } catch (e) { _logScrobbleErrorRateLimited('onTrackEnd', e); }
        if (zone.queue.length > 0 && zone.queueIndex < zone.queue.length - 1) {
          stopPolling(zone);
          advanceTrack(zone);
        } else {
          console.warn(`[poll-stopped] zone=${zone.id?.slice(0, 12)} queue exhausted, going stopped`);
          updateZone(zone, { status: 'stopped', position: 0 });
          stopPolling(zone);
        }
      } else if (transportInfo.state === 'PAUSED_PLAYBACK') {
        if (zone.status !== 'paused') updateZone(zone, { status: 'paused' });
        broadcastPosition(zone);
      } else {
        if (zone.status !== 'playing') updateZone(zone, { status: 'playing' });
        broadcastPosition(zone);
        // Maybe pre-queue the next track for gapless transition.
        await maybePreQueueNext(zone);
      }
    } catch (e) {
      zone.consecutiveFailures++;
      // With faster polling we tolerate more transient failures before giving
      // up — a 1-second poll cycle hits more network noise than a 3-second one.
      if (zone.consecutiveFailures >= POLL_FAILURE_THRESHOLD) {
        updateZone(zone, { status: 'stopped', position: 0 });
        stopPolling(zone);
      }
    } finally {
      zone.polling = false;
    }
  }, POLL_INTERVAL_MS);
}

function stopPolling(zone) {
  if (zone.pollTimer) { clearInterval(zone.pollTimer); zone.pollTimer = null; }
  zone.consecutiveFailures = 0;
  zone.gaplessQueued = false;
  zone.polling = false;
}

// Pre-queue the next track on the renderer when the current track is in its
// final GAPLESS_PRELOAD_SEC. Idempotent: zone.gaplessQueued guards against
// repeated SOAP calls. If the renderer doesn't support gapless pre-queue
// (e.g. AirPlay), this is a no-op and we'll fall back to stop-then-play.
async function maybePreQueueNext(zone) {
  if (zone.gaplessQueued) return;
  const cur = zone.currentTrack;
  if (!cur || !cur.duration) return;
  const remaining = cur.duration - zone.position;
  if (remaining > GAPLESS_PRELOAD_SEC || remaining < 0) return;
  // Is there a next track to queue?
  let nextIdx = zone.queueIndex + 1;
  if (nextIdx >= zone.queue.length) {
    // No next track. If MusicD Radio is on, top up the queue with a random
    // album so the gapless engine has something to pre-queue. If radio is off
    // we just bail and let advanceTrack handle the STOPPED branch later.
    if (!zone.radio) return;
    const appended = await maybeAppendRadioAlbum(zone);
    if (!appended) return;
    nextIdx = zone.queueIndex + 1;
    if (nextIdx >= zone.queue.length) return; // safety
  }
  const nextTrackId = zone.queue[nextIdx];
  const database = db.get();
  const nextTrack = database.prepare('SELECT * FROM tracks WHERE id = ?').get(nextTrackId);
  if (!nextTrack) return;

  const PORT = process.env.PORT || 32700;
  const lanHost = inferLanHost(zone.rendererIds[0]);
  if (!lanHost) {
    // Falling back to 127.0.0.1 here would tell the renderer to fetch
    // from its own loopback, which silently fails. Better to abandon
    // the pre-queue attempt -- the polling loop's STOPPED branch will
    // handle the inter-track transition via a fresh play() call instead.
    console.warn(`⚠ inferLanHost failed for zone ${zone.id}; skipping gapless pre-queue`);
    return;
  }
  const primaryRid = zone.rendererIds[0];

  // DSP cache-buster — same rationale as playTrackOnZone. Without this,
  // a DSP profile change won't take effect on the gapless-queued next
  // track until the user manually skips.
  let dspVersion = 0;
  try {
    const dsp = require('./dsp');
    dspVersion = dsp.getProfile(primaryRid).updated_at || 0;
  } catch (e) { /* non-fatal */ }
  const nextStreamUrl = `http://${lanHost}/api/stream/${nextTrackId}?renderer=${encodeURIComponent(primaryRid)}&v=${dspVersion}`;

  // Pre-queue on every renderer in the zone in parallel. A failure is
  // non-fatal — the renderer just won't transition gaplessly and we'll handle
  // STOPPED in the polling loop instead.
  // v1.1.0.88 diagnostic — log the URL with its dspVersion so we can spot
  // stale pre-queue URLs (a pre-queue fired with dspVersion=N1, then a
  // profile change bumped the version to N2, but the renderer still has
  // the N1 URL queued — when the renderer auto-advances to the stale URL
  // it hits framing mismatch and we cascade).
  console.warn(`[prequeue] zone=${zone.id?.slice(0, 12)} track=${nextTrackId.slice(0, 8)} dspVersion=${dspVersion} url=${nextStreamUrl}`);
  const results = await Promise.all(zone.rendererIds.map(rid => renderers.playNext(rid, nextStreamUrl, nextTrack)));
  // We mark queued even on partial failure so we don't hammer the device with
  // retries every second; if it didn't take, the STOPPED branch will kick in.
  zone.gaplessQueued = true;
  if (results.every(Boolean)) {
    console.log(`🔗 Gapless pre-queued: "${nextTrack.title}" on zone ${zone.id}`);
  }
}

// Called when the polling loop detects the renderer has rolled over from the
// pre-queued URI to the next track (position drop, still PLAYING). We update
// our local queue index and refresh now-playing metadata WITHOUT issuing a new
// play() — the renderer is already on the new track.
async function onGaplessTransition(zone) {
  const nextIdx = zone.queueIndex + 1;
  if (nextIdx >= zone.queue.length) {
    // Defensive: should never happen because we only pre-queue when there *is*
    // a next track. Treat as STOPPED.
    updateZone(zone, { status: 'stopped', position: 0 });
    stopPolling(zone);
    return;
  }
  const database = db.get();
  const newTrack = database.prepare('SELECT * FROM tracks WHERE id = ?').get(zone.queue[nextIdx]);
  if (!newTrack) return;
  zone.queueIndex = nextIdx;
  zone.gaplessQueued = false; // permit pre-queue of the *next* next track
  // Log play_history — gapless transitions don't go through playTrackOnZone so
  // we have to log here too. Same fire-and-forget shape.
  try {
    database.prepare(`
      INSERT INTO play_history (track_id, album_title, album_artist, played_at)
      VALUES (?, ?, ?, unixepoch())
    `).run(newTrack.id, newTrack.album || null, newTrack.album_artist || null);
  } catch (e) { /* non-fatal */ }
  // Last.fm scrobble hook (#30.25). Same as playTrackOnZone -- resets
  // per-track scrobble state and sends updateNowPlaying.
  scrobbler.onTrackStart(zone.id, newTrack).catch(e => _logScrobbleErrorRateLimited("onTrackStart", e));
  const signalPath = await buildSignalPath(newTrack, zone.rendererIds[0]);
  updateZone(zone, { currentTrack: newTrack, signalPath, status: 'playing' });
  console.log(`▶ Gapless transition → "${newTrack.title}" (queue ${nextIdx + 1}/${zone.queue.length})`);
  // v1.1.0.88 diagnostic — also log at WARN level with same identifiers
  // as the other diagnostic lines so a single grep filters the trace.
  console.warn(`[gapless] zone=${zone.id?.slice(0, 12)} from=${nextIdx - 1} to=${nextIdx} track=${newTrack.id?.slice(0, 8)}`);
}

// ---- Auto-advance ----
//
// Used by both auto-end (renderer reports STOPPED on a non-gapless device) and
// manual prev/next skips. Before issuing the new SetAVTransportURI, we clear
// any previously-pre-queued NextURI on every renderer in the zone — without
// this, a Sonos that's already accepted a NextURI may "carry it over" and
// play it after the user-skipped track ends, instead of cleanly switching to
// the user's chosen track.
//
// v1.1.0.87 — `opts.via` distinguishes the entry point:
//   'manual'      — user pressed Next/Prev. Renderer is likely mid-playback;
//                   we issue ensureRendererIdle (Stop SOAP) before the new
//                   SetAVTransportURI to defeat the same DLNA framing-mismatch
//                   race that v86 fixed for the DSP-toggle path.
//                   Without this, manual skip during re-encoded playback can
//                   cascade through several tracks when the new track's
//                   framing differs from the old.
//   'auto-end'    — renderer reported STOPPED in the polling loop. Already
//                   stopped; another Stop is redundant (but harmless).
//                   Skipped to keep auto-end transitions snappy.
//   'radio-append'— internal call from the queue-end → radio top-up path.
//                   Renderer is already STOPPED (queue was exhausted).
async function advanceTrack(zone, opts = {}) {
  const via = opts.via || 'auto-end';
  if (zone.advancing) {
    console.warn(`[advance] zone=${zone.id?.slice(0, 12)} via=${via} SKIP (already advancing)`);
    return;
  }
  // v1.1.0.88 diagnostic — log every advanceTrack fire so we can trace
  // the cascade. trackId of the queue position we're moving FROM
  // (i.e. the just-finished/aborted track) and TO (the about-to-start).
  // If a cascade is happening we'll see this fire repeatedly.
  // v1.1.1.1 — gated behind MUSICD_DEBUG_PLAYBACK. Quiet for beta.
  const fromIdx = zone.queueIndex;
  const toIdx = fromIdx + 1;
  const fromTrack = zone.queue[fromIdx]?.slice(0, 8) || '?';
  const toTrack = zone.queue[toIdx]?.slice(0, 8) || 'END';
  _dbgPlayback(`[advance] zone=${zone.id?.slice(0, 12)} via=${via} from=${fromIdx}(${fromTrack}) to=${toIdx}(${toTrack}) queueLen=${zone.queue.length}`);
  zone.advancing = true;
  try {
    const next = zone.queueIndex + 1;
    if (next >= zone.queue.length) {
      // Queue exhausted. If MusicD Radio is on, top up with a random album
      // and continue playing instead of stopping (#14).
      if (zone.radio) {
        const appended = await maybeAppendRadioAlbum(zone);
        if (appended) {
          // We appended new tracks past the current end. The "next" track is
          // now the first of the freshly-appended album.
          await Promise.all(zone.rendererIds.map(rid => renderers.clearNext(rid)));
          zone.gaplessQueued = false;
          zone.queueIndex = next;
          await playTrackOnZone(zone, zone.queue[next]);
          return;
        }
      }
      // Best-effort cancel any leftover pre-queue before stopping
      await Promise.all(zone.rendererIds.map(rid => renderers.clearNext(rid)));
      zone.gaplessQueued = false;
      updateZone(zone, { status: 'stopped', position: 0, currentTrack: null });
      stopPolling(zone);
      return;
    }

    // v1.1.0.87 — manual skip needs a hard Stop on every renderer in the
    // zone before the new SetAVTransportURI to defeat the framing-mismatch
    // cascade. Auto-end transitions (renderer already STOPPED) skip the
    // Stop to stay snappy. See ensureRendererIdle() near top of file.
    //
    // We also stopPolling first, so the polling loop can't observe our
    // explicit Stop and mis-interpret it as a track-ended event. The v86
    // pollTimer-null guard would catch this anyway, but stopping polling
    // first is belt-and-braces.
    if (via === 'manual') {
      stopPolling(zone);
      await ensureRendererIdle(zone.rendererIds);
    }

    // Cancel any previously-pre-queued URI before playTrackOnZone issues a
    // fresh SetAVTransportURI. Done in parallel; failures are non-fatal.
    await Promise.all(zone.rendererIds.map(rid => renderers.clearNext(rid)));
    zone.gaplessQueued = false;
    zone.queueIndex = next;
    await playTrackOnZone(zone, zone.queue[next]);
  } catch (e) {
    console.warn('advanceTrack failed:', e.message);
    updateZone(zone, { status: 'stopped' });
    stopPolling(zone);
  } finally {
    zone.advancing = false;
  }
}

// ---- Queue mutation (#21 / #22) ----
//
// Reorder a track within the active queue WITHOUT restarting playback. This
// is the move-and-continue semantics #22 asked for: the currently-playing
// track keeps playing exactly where it is, only the upcoming-tracks order
// changes around it. Returns the new queue/queueIndex on success, null on
// invalid arguments or no active zone.
//
// Math:
//   - Moving the currently-playing entry: queueIndex follows the track to `to`.
//   - Moving an entry from before queueIndex to after: queueIndex -= 1
//   - Moving an entry from after queueIndex to before: queueIndex += 1
//   - Both endpoints on the same side of queueIndex: queueIndex unchanged.
async function reorderQueue(from, to, rendererId) {
  const zone = resolveZone(rendererId);
  if (!zone) return null;
  const len = zone.queue.length;
  if (from < 0 || from >= len || to < 0 || to >= len) return null;
  if (from === to) {
    return { queue: zone.queue.slice(), queueIndex: zone.queueIndex };
  }

  // Compute the new queueIndex BEFORE mutating the array.
  let newIdx = zone.queueIndex;
  if (from === zone.queueIndex) {
    newIdx = to;
  } else if (from < zone.queueIndex && to >= zone.queueIndex) {
    newIdx -= 1;
  } else if (from > zone.queueIndex && to <= zone.queueIndex) {
    newIdx += 1;
  }

  // Remember what the pre-queued "next" track WAS so we can detect a change
  // and invalidate the renderer's NextURI if needed.
  const prevNextId = zone.queue[zone.queueIndex + 1] || null;

  // Pull the moved item out, then splice it in at the destination. With a
  // single-pass approach the destination index is correct as-is regardless
  // of direction, because splice removes from `from` first.
  const [moved] = zone.queue.splice(from, 1);
  zone.queue.splice(to, 0, moved);
  zone.queueIndex = newIdx;

  const newNextId = zone.queue[zone.queueIndex + 1] || null;
  if (prevNextId !== newNextId) {
    // The pre-queued NextURI is no longer the right next track. Clear it on
    // the renderer and let the polling loop re-pre-queue the correct one.
    await Promise.all(zone.rendererIds.map(rid => renderers.clearNext(rid).catch(() => {})));
    zone.gaplessQueued = false;
  }

  // Broadcast the new queue to clients. Position/track are unchanged so we
  // don't touch zone.position or currentTrack.
  broadcastFullState();
  return { queue: zone.queue.slice(), queueIndex: zone.queueIndex };
}

// Remove a single track from the queue. Refuses to remove the currently-
// playing track (the user has to use Stop or Next for that). Returns the
// updated queue/queueIndex on success, null on invalid argument.
async function removeFromQueue(index, rendererId) {
  const zone = resolveZone(rendererId);
  if (!zone) return null;
  const len = zone.queue.length;
  if (index < 0 || index >= len) return null;
  if (index === zone.queueIndex) return null; // refuse to remove current

  const prevNextId = zone.queue[zone.queueIndex + 1] || null;
  zone.queue.splice(index, 1);
  if (index < zone.queueIndex) zone.queueIndex -= 1;

  const newNextId = zone.queue[zone.queueIndex + 1] || null;
  if (prevNextId !== newNextId) {
    await Promise.all(zone.rendererIds.map(rid => renderers.clearNext(rid).catch(() => {})));
    zone.gaplessQueued = false;
  }

  broadcastFullState();
  return { queue: zone.queue.slice(), queueIndex: zone.queueIndex };
}

// v1.1.0.55: batch-remove. Takes a list of queue indices, drops all
// of them in a single pass, preserving the currently-playing track.
// Indices that match the current queueIndex are silently ignored
// rather than refused so a user "remove all played + upcoming"
// command works without bookkeeping the current index out of the
// list. Returns the new queue and queueIndex.
async function removeFromQueueBatch(indices, rendererId) {
  const zone = resolveZone(rendererId);
  if (!zone) return null;
  const len = zone.queue.length;
  if (!Array.isArray(indices) || indices.length === 0) return null;

  // Filter to valid indices that aren't the current track, dedupe,
  // and sort descending so splicing doesn't shift later indices.
  const valid = [...new Set(
    indices
      .map(i => parseInt(i, 10))
      .filter(i => Number.isFinite(i) && i >= 0 && i < len && i !== zone.queueIndex)
  )].sort((a, b) => b - a);
  if (valid.length === 0) return null;

  const prevNextId = zone.queue[zone.queueIndex + 1] || null;

  // Splice out each. Indices below the current shift it down by 1
  // for each one removed; indices above don't affect queueIndex.
  let shift = 0;
  for (const i of valid) {
    zone.queue.splice(i, 1);
    if (i < zone.queueIndex) shift += 1;
  }
  zone.queueIndex -= shift;

  const newNextId = zone.queue[zone.queueIndex + 1] || null;
  if (prevNextId !== newNextId) {
    await Promise.all(zone.rendererIds.map(rid => renderers.clearNext(rid).catch(() => {})));
    zone.gaplessQueued = false;
  }

  broadcastFullState();
  return { queue: zone.queue.slice(), queueIndex: zone.queueIndex };
}

// ---- MusicD Radio (#14) ----
//
// Persistent toggle in the settings table; in-memory mirror on each zone.
// When on, `advanceTrack` will append a random album rather than stopping
// when the queue is exhausted. We also track a small ring of recently-played
// album IDs to avoid repeating ourselves on consecutive radio picks.
const RADIO_HISTORY_SIZE = 8;

function setRadio(enabled) {
  const z = getActiveZone();
  if (z) z.radio = !!enabled;
  // Persist so it survives restarts.
  try {
    const database = db.get();
    database.prepare(`
      INSERT INTO settings (key, value) VALUES ('radio_enabled', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(enabled ? '1' : '0');
  } catch (e) { /* non-fatal */ }
  if (z) broadcastFullState();
  return !!enabled;
}

function loadRadioSetting() {
  try {
    const database = db.get();
    const row = database.prepare("SELECT value FROM settings WHERE key='radio_enabled'").get();
    return row?.value === '1';
  } catch { return false; }
}

// Append a random album to the queue. Returns the number of tracks appended,
// or 0 if nothing was found. Avoids repeating any album whose ID appears in
// `zone.radioHistory`.
async function maybeAppendRadioAlbum(zone) {
  try {
    const database = db.get();
    if (!zone.radioHistory) zone.radioHistory = [];
    // Build NOT IN clause over recent album ids (cap to keep the query small)
    const recent = zone.radioHistory.slice(-RADIO_HISTORY_SIZE);
    const placeholders = recent.map(() => '?').join(',');
    const exclusionClause = recent.length ? `AND id NOT IN (${placeholders})` : '';
    const album = database.prepare(`
      SELECT id, title, album_artist
      FROM albums
      WHERE track_count > 0 AND excluded = 0 ${exclusionClause}
      ORDER BY RANDOM() LIMIT 1
    `).get(...recent);
    if (!album) return 0;
    // Fetch tracks in order. We already know the album is in scope (excluded=0)
    // and reconcile keeps tracks in sync, so the per-track filter is belt and
    // braces — but cheap and protects against edge cases.
    const tracks = database.prepare(`
      SELECT id FROM tracks WHERE album = ? AND album_artist = ? AND excluded = 0
      ORDER BY disc_number ASC, track_number ASC
    `).all(album.title, album.album_artist);
    if (tracks.length === 0) return 0;
    const ids = tracks.map(t => t.id);
    zone.queue = [...zone.queue, ...ids];
    zone.radioHistory = [...recent, album.id];
    console.log(`📻 Radio appended: "${album.title}" by ${album.album_artist} (${ids.length} tracks)`);
    broadcastFullState();
    return ids.length;
  } catch (e) {
    console.warn('Radio append failed:', e.message);
    return 0;
  }
}

async function playTrackOnZone(zone, trackId) {
  const database = db.get();
  const track = database.prepare('SELECT * FROM tracks WHERE id = ?').get(trackId);
  if (!track) throw new Error('Track not found');

  updateZone(zone, { status: 'loading', currentTrack: track, position: 0, positionAt: Date.now() });
  const PORT = process.env.PORT || 32700;
  const lanHost = inferLanHost(zone.rendererIds[0]);
  if (!lanHost) {
    // Falling back to 127.0.0.1 silently tells the renderer to fetch
    // from its own loopback, where there's no server -- result is the
    // dreaded "play button works briefly, then stops" with nothing in
    // the logs. Throw a real error so the user sees the misconfig.
    updateZone(zone, { status: 'stopped' });
    throw new Error(
      `Cannot reach renderer at ${zone.rendererIds[0]}: no host IP shares its subnet. ` +
      `Check that the host is on the same network as the renderer.`
    );
  }
  // Tag the stream URL with the destination renderer so /api/stream can decide
  // whether to downsample (e.g. Sonos's 48 kHz cap). The renderer in question
  // is the *first* of the zone — for now multi-renderer zones must share caps,
  // which is the case for any group of identical Sonos units.
  const primaryRid = zone.rendererIds[0];

  // DSP cache-buster (#29.7). When DSP toggles between pass-through and
  // re-encode pipelines for the same track, the URL we issue is
  // identical to the previous one even though the response framing is
  // completely different (chunked re-encoded FLAC vs native file with
  // Content-Length). Some DLNA renderers (WiiM Pro Plus is the
  // confirmed offender) cache URI metadata and apply old framing
  // assumptions to the new response, which causes the disable case
  // to stutter for several tracks before recovering.
  //
  // The fix: append a version param whose value changes whenever the
  // renderer's DSP profile is saved. updated_at is set to unixepoch()
  // by saveProfile() on every change, so it gives us a free "the DSP
  // chain has changed" signal. The stream route ignores unknown query
  // params, so no server-side change is required to consume this.
  let dspVersion = 0;
  try {
    const dsp = require('./dsp');
    dspVersion = dsp.getProfile(primaryRid).updated_at || 0;
  } catch (e) { /* non-fatal — fall back to a no-op version of 0 */ }
  const streamUrl = `http://${lanHost}/api/stream/${trackId}?renderer=${encodeURIComponent(primaryRid)}&v=${dspVersion}`;

  // Send to all renderers in the zone (multi-zone group)
  await Promise.all(zone.rendererIds.map(rid => renderers.play(rid, streamUrl, track)));

  // Log the play. We do this fire-and-forget, after the play() calls are
  // queued, so a slow disk write can't delay actual playback. We dedupe at
  // the read endpoint by GROUP BY rather than here; that keeps the write
  // path simple and lets us see "I played this track 4 times today" if we
  // ever want a stats screen later.
  try {
    database.prepare(`
      INSERT INTO play_history (track_id, album_title, album_artist, played_at)
      VALUES (?, ?, ?, unixepoch())
    `).run(track.id, track.album || null, track.album_artist || null);
  } catch (e) { /* non-fatal */ }

  // Last.fm scrobble hook (#30.25). Resets per-track state and fires
  // updateNowPlaying. Fire-and-forget; scrobbler internally guards
  // against errors, missing config, disabled status.
  scrobbler.onTrackStart(zone.id, track).catch(e => _logScrobbleErrorRateLimited("onTrackStart", e));

  const signalPath = await buildSignalPath(track, zone.rendererIds[0]);
  updateZone(zone, { status: 'playing', signalPath });
  startPolling(zone);
}

function inferLanHost(rendererId) {
  const r = renderers.getRenderer(rendererId);
  if (!r?.ip) return null;
  const os = require('os');
  const PORT = process.env.PORT || 32700;
  const ifaces = os.networkInterfaces();
  const rPrefix = r.ip.split('.').slice(0, 3).join('.');
  for (const list of Object.values(ifaces)) {
    for (const ifc of list || []) {
      if (ifc.family === 'IPv4' && !ifc.internal && ifc.address.startsWith(rPrefix + '.')) {
        return `${ifc.address}:${PORT}`;
      }
    }
  }
  return null;
}

// ---- Broadcast helpers ----
function updateZone(zone, updates) {
  Object.assign(zone, updates);
  broadcastFullState();
}
function broadcastPosition(zone) {
  if (global.broadcastState) global.broadcastState('position', {
    zoneId: zone.id,
    position: zone.position,
    // Wall-clock timestamp (ms) of when this position was sampled from the
    // renderer. The client uses this to interpolate between polls without
    // drifting away from the device's actual playhead.
    positionAt: zone.positionAt || Date.now(),
  });
}

// Build the multi-zone broadcast payload (#v1.1.0.9). Sends every zone's
// public state plus the focusedZoneId so the client can render the
// mini-player for the focused zone AND show indicator dots / a sheet for
// other zones playing in parallel. The legacy 'state' message (one zone)
// is also emitted for backwards-compat with older client builds that
// haven't been upgraded yet -- so a v1.1.0.8 client connecting to a
// v1.1.0.9 server still sees a working mini-player.
function broadcastFullState() {
  if (!global.broadcastState) return;
  // The all-zones payload.
  const allZones = {};
  for (const [zid, z] of zones.entries()) {
    allZones[zid] = publicState(z);
  }
  global.broadcastState('zones', {
    focusedZoneId: focusedZoneId || null,
    zones: allZones,
  });
  // Backwards-compat: legacy single-zone 'state' message for v1.1.0.x
  // clients. Maps to the focused zone.
  const focused = getFocusedZone();
  if (focused) {
    global.broadcastState('state', publicState(focused));
  }
  // Persist on every meaningful state change so a server restart can
  // restore. Cheap (single SQLite UPSERT of a small JSON blob).
  persistAllZones();
}
// Hydrate a queue of track IDs into full track objects so the client can
// render titles, artists, durations etc without a separate lookup. Called
// from publicState — the marginal cost is a single small SELECT per
// broadcast, which is fine at our state-broadcast frequency (a few per
// minute under normal use; not per-position-tick).
function hydrateQueue(trackIds) {
  if (!Array.isArray(trackIds) || trackIds.length === 0) return [];
  try {
    const database = db.get();
    // Build a single IN-clause SELECT, then re-order to match input.
    const placeholders = trackIds.map(() => '?').join(',');
    const rows = database.prepare(`
      SELECT id, title, artist, album, album_artist, duration, format, codec, track_number, disc_number
      FROM tracks WHERE id IN (${placeholders})
    `).all(...trackIds);
    const byId = new Map(rows.map(r => [r.id, r]));
    // Preserve queue order; drop any missing IDs (shouldn't happen normally).
    return trackIds.map(id => byId.get(id)).filter(Boolean);
  } catch (e) {
    // On DB error fall back to bare IDs so the client at least gets the count.
    return trackIds.map(id => ({ id }));
  }
}

function publicState(zone) {
  if (!zone) return { status: 'stopped', currentTrack: null, queue: [], queueIndex: 0, rendererId: null, volume: DEFAULT_INITIAL_VOLUME, signalPath: [], position: 0, positionAt: Date.now(), radio: false, outputMode: 'variable' };
  // Output mode is surfaced in the state so the player UI can hide
  // the volume slider for fixed-mode renderers (#v1.1.0.8).
  const outputMode = zone.rendererIds[0]
    ? getOutputMode(zone.rendererIds[0])
    : 'variable';
  return {
    status: zone.status,
    currentTrack: zone.currentTrack,
    queue: hydrateQueue(zone.queue),
    queueIndex: zone.queueIndex,
    rendererId: zone.rendererIds[0],
    rendererIds: zone.rendererIds,
    volume: zone.volume,
    signalPath: zone.signalPath,
    position: zone.position,
    positionAt: zone.positionAt || Date.now(),
    radio: !!zone.radio,
    zoneId: zone.id,
    outputMode,
  };
}

// Persist a snapshot of the active zone's queue so we can restore it after a
// server restart. Stored as JSON in the settings table under a single key.
// The snapshot is intentionally minimal — track IDs only — so on startup we
// re-resolve track metadata from the DB (which is the source of truth).
// Persist all zones (#v1.1.0.9). Each zone gets a snapshot in a single
// JSON blob keyed by zoneId. Restored on boot in 'stopped' state.
function persistAllZones() {
  try {
    const database = db.get();
    const snapshot = {};
    for (const [zid, z] of zones.entries()) {
      // Skip empty zones -- no point persisting a zone that has nothing.
      if (!z.queue || z.queue.length === 0) continue;
      snapshot[zid] = {
        rendererId: z.rendererIds[0],
        queue: z.queue,
        queueIndex: z.queueIndex,
        currentTrackId: z.currentTrack?.id || null,
        radio: !!z.radio,
        savedAt: Date.now(),
      };
    }
    database.prepare(`
      INSERT INTO settings (key, value) VALUES ('persisted_zones', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(JSON.stringify(snapshot));
  } catch (e) { /* non-fatal */ }
}

// Backwards-compat shim: callers historically called persistActiveQueue()
// when they wanted to write state. Map it to persistAllZones() so nothing
// breaks. (#v1.1.0.9)
function persistActiveQueue() { persistAllZones(); }

// Restore the persisted zones on startup. Returns the map of snapshots.
// Older v1.1.0.x stored a single-zone snapshot under 'persisted_queue';
// we read both keys for backwards-compat -- the legacy one becomes a
// single-entry map.
function loadPersistedZones() {
  try {
    const database = db.get();
    // Prefer the new key.
    const newRow = database.prepare("SELECT value FROM settings WHERE key='persisted_zones'").get();
    if (newRow?.value) {
      const obj = JSON.parse(newRow.value);
      if (obj && typeof obj === 'object') return obj;
    }
    // Fall back to the legacy single-zone key.
    const legacyRow = database.prepare("SELECT value FROM settings WHERE key='persisted_queue'").get();
    if (legacyRow?.value) {
      const snap = JSON.parse(legacyRow.value);
      if (snap?.rendererId && Array.isArray(snap.queue) && snap.queue.length > 0) {
        return { [snap.rendererId]: snap };
      }
    }
    return {};
  } catch (e) { return {}; }
}

// Restore the persisted queue on startup. Legacy single-zone path,
// kept around because some callers still use it. New code should use
// restoreAllPersistedZones() (#v1.1.0.9).
function loadPersistedQueue() {
  try {
    const database = db.get();
    const row = database.prepare("SELECT value FROM settings WHERE key='persisted_queue'").get();
    if (!row?.value) return null;
    const snap = JSON.parse(row.value);
    if (!Array.isArray(snap.queue) || snap.queue.length === 0) return null;
    return snap;
  } catch (e) { return null; }
}

// ---- Public API ----
function getState() { return publicState(getActiveZone()); }
function setState(updates) {
  const z = getActiveZone();
  if (!z) return;
  updateZone(z, updates);
}

// Public snapshot of all zones for the multi-zone client (#v1.1.0.9).
// Returns the same shape as the WS 'zones' broadcast payload.
function getAllZonesState() {
  const out = {};
  for (const [zid, z] of zones.entries()) {
    out[zid] = publicState(z);
  }
  return { focusedZoneId: focusedZoneId || null, zones: out };
}

async function startPlayback(rendererId, trackId, queueIds, queueIndex) {
  const zone = ensureZone(rendererId);

  // v1.1.0.87 — if this zone was already playing or paused, the
  // renderer is potentially mid-fetch of the existing stream.
  // Replacing the queue and immediately issuing a new
  // SetAVTransportURI without first stopping puts us back in the
  // same DLNA framing-mismatch race that the v86/v87 fixes address
  // for restartCurrentTrack and advanceTrack-manual. Send Stop
  // first so the renderer is fully idle before the new URI lands.
  //
  // The most common trigger: user is listening to album A, picks
  // album B from the library and presses Play. Without this Stop,
  // the renderer may carry stale framing assumptions from album A's
  // stream into album B and cascade.
  //
  // Stop on a renderer that's already idle is a near-no-op SOAP
  // call. ensureRendererIdle's Stop failures are non-fatal so we
  // won't block startup if the renderer is unreachable.
  if (zone.status === 'playing' || zone.status === 'paused') {
    stopPolling(zone);
    await ensureRendererIdle(zone.rendererIds);
  }

  zone.queue = (queueIds && queueIds.length) ? queueIds.slice() : [trackId];
  zone.queueIndex = queueIndex || 0;
  setActiveZone(zone.id);
  await playTrackOnZone(zone, trackId);
}

// Resolve which zone an operation should target (#v1.1.0.9). With true
// multi-zone, every operation should be tied to a specific zone. We
// accept undefined for backwards-compat with old clients that don't yet
// pass a rendererId on every call -- those fall back to the focused
// zone. But if a rendererId IS passed, we only use it if it matches an
// existing zone; we do NOT silently re-target to the focused zone, as
// that would cause "pause my Sonos" to accidentally pause the DAC.
function resolveZone(rendererId) {
  if (rendererId) {
    const z = zones.get(rendererId);
    return z || null;
  }
  return getFocusedZone();
}

async function pause(rendererId) {
  const zone = resolveZone(rendererId);
  if (!zone) return;

  // Sonos-only stop-with-bookmark behaviour (#v1.1.0.46).
  //
  // Background: pressing Pause-then-Play on Sonos has been unreliable
  // since some firmware change -- the Play SOAP issued from
  // PAUSED_PLAYBACK briefly transitions through STOPPED, which the
  // polling loop interpreted as "track ended" and skipped to next.
  // v1.1.0.40-45 attempted half a dozen variations on the resume SOAP
  // sequence; none worked reliably.
  //
  // Different angle: don't rely on PAUSED_PLAYBACK at all. Treat the
  // pause button on a Sonos zone as Stop-with-position-saved, and
  // treat the play button on a "paused" Sonos zone as a fresh play of
  // the same track at the saved position. This is exactly what the
  // skip-forward path does (which works), and avoids the firmware
  // pause-resume quirk entirely.
  //
  // Trade-off: small (1-2s) gap on resume because we re-load the URI.
  // Acceptable for now while we keep the code path identical to skip-
  // forward, which is rock solid.
  //
  // Other renderers (DLNA, Squeezelite, ALSA) keep real pause/resume.
  const sonos = isSonosZone(zone);

  if (zone.status === 'paused') {
    if (sonos && zone.currentTrack) {
      // "Resume" = fresh play + seek.
      const savedPosition = zone.position;
      const savedTrackId = zone.currentTrack.id;
      await playTrackOnZone(zone, savedTrackId);
      if (savedPosition > 1) {
        // The Seek is the whole point of this branch -- it is what turns a
        // fresh play into a resume. It can be refused: playTrackOnZone has
        // only just issued SetAVTransportURI + Play, and a renderer still
        // loading that URI answers Seek with a transition-not-available
        // fault. The longer the pause, the colder that load is, so this is
        // likeliest on exactly the resume the user cares most about.
        //
        // A refused Seek used to be swallowed whole and the saved position
        // asserted anyway, which told the client the playhead was at the
        // bookmark while the renderer played the track from 0:00. Say so in
        // the log instead, and only claim the bookmark if a renderer
        // actually took it -- if none did, the next poll a second later
        // reports the truth and the bar lands on it rather than jumping.
        const sought = await Promise.all(zone.rendererIds.map(rid =>
          renderers.seek(rid, savedPosition)
            .then(() => true)
            .catch(e => {
              console.warn(`[resume] zone=${zone.id?.slice(0, 12)} seek ${rid?.slice(0, 12)} to ${savedPosition}s failed: ${e?.message || e} — renderer will play from the start of the track`);
              return false;
            })
        ));
        if (sought.some(Boolean)) {
          updateZone(zone, { position: savedPosition, positionAt: Date.now() });
        }
      }
    } else {
      // Real resume on non-Sonos renderers.
      await Promise.all(zone.rendererIds.map(rid => renderers.resume(rid).catch(() => {})));
      updateZone(zone, { status: 'playing' });
      startPolling(zone);
    }
  } else if (zone.status === 'stopped' && zone.currentTrack && zone.queue.length > 0) {
    // Restored queue scenario (after server restart): kick off a real play.
    await playTrackOnZone(zone, zone.currentTrack.id);
  } else {
    if (sonos) {
      // "Pause" = Stop with position saved. Stop polling first so the
      // stop's own STOPPED tick doesn't slip past the pause-status guard.
      stopPolling(zone);
      await Promise.all(zone.rendererIds.map(rid => renderers.stop(rid).catch(() => {})));
      updateZone(zone, { status: 'paused' });
      // No startPolling -- stay quiet while "paused".
    } else {
      // Real pause on non-Sonos renderers.
      await Promise.all(zone.rendererIds.map(rid => renderers.pause(rid).catch(() => {})));
      updateZone(zone, { status: 'paused' });
    }
  }
}

// True if any renderer in the zone speaks the Sonos protocol.
// (In practice zones are homogeneous, but checking all rendererIds is cheap
// and robust to future grouping work.)
function isSonosZone(zone) {
  if (!zone || !zone.rendererIds) return false;
  for (const rid of zone.rendererIds) {
    const r = renderers.getRenderer(rid);
    if (r && r.protocol === 'sonos') return true;
  }
  return false;
}

async function stopAll(rendererId) {
  const zone = resolveZone(rendererId);
  if (!zone) return;
  // Cancel any pre-queued gapless URI alongside the stop call so the renderer
  // doesn't briefly start the queued track between the stop SOAP and the
  // following queue-clear.
  await Promise.all(zone.rendererIds.map(rid => renderers.clearNext(rid).catch(() => {})));
  await Promise.all(zone.rendererIds.map(rid => renderers.stop(rid).catch(() => {})));
  stopPolling(zone);
  zone.queue = []; zone.queueIndex = 0;
  zone.gaplessQueued = false;
  updateZone(zone, { status: 'stopped', currentTrack: null, signalPath: [], position: 0 });
}

async function setVolume(rendererId, vol) {
  const zone = resolveZone(rendererId);
  if (!zone) return;
  // Fixed-mode renderers ignore volume changes (#v1.1.0.8). The UI
  // hides the slider but a stale request could still arrive (e.g.
  // from a queued event); guard server-side too.
  if (getOutputMode(zone.rendererIds[0]) === 'fixed') {
    return;
  }
  zone.volume = vol;
  // Persist to DB for each renderer in this zone -- restoration on
  // restart works whether the user comes back to this zone OR routes
  // playback to one of its renderers from a different zone (#v1.1.0.6).
  for (const rid of zone.rendererIds) {
    persistVolume(rid, vol);
  }
  await Promise.all(zone.rendererIds.map(rid => renderers.setVolume(rid, vol).catch(() => {})));
  broadcastFullState();
}

function appendQueue(trackIds, rendererId) {
  const zone = resolveZone(rendererId);
  if (!zone) return;
  zone.queue = [...zone.queue, ...trackIds];
  broadcastFullState();
}

// v1.1.0.56 — insert tracks immediately after the currently-playing
// one. Conceptually "play next". Clears the renderer's pre-queued
// gapless next-stream so the new track wins; without that, the user
// taps "Play Next" but the *old* next track keeps playing because it
// was already pre-rolled.
async function insertNextInQueue(trackIds, rendererId) {
  const zone = resolveZone(rendererId);
  if (!zone) return null;
  if (!Array.isArray(trackIds) || trackIds.length === 0) return null;

  const insertAt = Math.max(zone.queueIndex + 1, 0);
  zone.queue.splice(insertAt, 0, ...trackIds);

  // Bust any pre-queued next stream — it's no longer "next".
  await Promise.all(zone.rendererIds.map(rid => renderers.clearNext(rid).catch(() => {})));
  zone.gaplessQueued = false;

  broadcastFullState();
  return { queue: zone.queue.slice(), queueIndex: zone.queueIndex };
}

async function next(rendererId) {
  const zone = resolveZone(rendererId);
  if (!zone) return;
  await advanceTrack(zone, { via: 'manual' });
}
async function prev(rendererId) {
  const zone = resolveZone(rendererId);
  if (!zone) return;
  if (zone.queueIndex <= 0) return;
  zone.queueIndex -= 2; // advanceTrack does +1
  await advanceTrack(zone, { via: 'manual' });
}

// Focus the UI on a zone (#v1.1.0.9). With true multi-zone, switching
// renderers no longer moves the queue or stops anything -- it just
// changes which zone the UI's mini-player is showing. If the requested
// zone doesn't exist yet, an empty one is created (the user has tapped
// a renderer that's never had a queue). Other zones keep playing
// independently. The old "switch and move queue" behaviour is now
// available as moveQueueToRenderer() below.
async function switchToRenderer(newRendererId) {
  // ensureZone creates an empty zone if not present. No playback action,
  // no stop on old zone. The zone keeps whatever state it had.
  ensureZone(newRendererId);
  setFocusedZone(newRendererId);
}

// Move a queue from one zone to another (#v1.1.0.9). The old zone
// stops (to free the renderer); the new zone picks up at the same
// queue position and starts playing. Used by the "Move queue to..."
// action in the queue screen.
async function moveQueueToRenderer(fromRendererId, toRendererId) {
  const oldZone = zones.get(fromRendererId);
  if (!oldZone) {
    // No source zone -- treat as a fresh focus instead.
    return switchToRenderer(toRendererId);
  }
  if (fromRendererId === toRendererId) return; // no-op

  const queue = oldZone.queue.slice();
  const queueIndex = oldZone.queueIndex;
  const trackId = oldZone.currentTrack?.id;

  // Stop the old zone -- clear pre-queued NextURI, stop renderer playback.
  await Promise.all(oldZone.rendererIds.map(rid => renderers.clearNext(rid).catch(() => {})));
  await Promise.all(oldZone.rendererIds.map(rid => renderers.stop(rid).catch(() => {})));
  stopPolling(oldZone);
  oldZone.gaplessQueued = false;
  oldZone.status = 'stopped';
  oldZone.currentTrack = null;
  oldZone.queue = [];
  oldZone.queueIndex = 0;
  // Persist the now-empty old zone too, otherwise on restart the move
  // would silently undo. (#v1.1.0.9)
  persistAllZones();

  const newZone = ensureZone(toRendererId);
  newZone.queue = queue;
  newZone.queueIndex = queueIndex;
  setFocusedZone(toRendererId);

  if (trackId) {
    await playTrackOnZone(newZone, trackId);
  }
  persistAllZones();
}

// Restore a persisted queue from the DB (saved before the previous shutdown)
// and attach it to its zone in 'paused' state. Called at boot. Does NOT start
// playback — the user has to press Play. The renderer may not have been
// rediscovered yet by the time we run this; if it isn't present, we still
// attach the queue to the placeholder zone so the UI can show what was
// queued, and a later switchToRenderer() / play call will fall through.
function restorePersistedQueue() {
  // Multi-zone restoration (#v1.1.0.9). We try the new map-based key
  // first; if not present, the legacy single-zone format is also handled
  // by loadPersistedZones() which returns a map.
  const snapshots = loadPersistedZones();
  if (!snapshots || Object.keys(snapshots).length === 0) {
    // No persisted zones. Still load the radio setting so a fresh focused
    // zone (whenever created) inherits it.
    return null;
  }
  const database = db.get();
  const stillPresent = (id) => {
    try { return !!database.prepare('SELECT 1 FROM tracks WHERE id = ?').get(id); }
    catch { return false; }
  };

  let firstRestored = null;
  let totalTracks = 0;

  for (const [zoneId, snap] of Object.entries(snapshots)) {
    if (!snap || !snap.rendererId) continue;
    const cleanQueue = (snap.queue || []).filter(stillPresent);
    if (cleanQueue.length === 0) continue;
    const cleanIndex = Math.max(0, Math.min(snap.queueIndex || 0, cleanQueue.length - 1));
    const zone = ensureZone(snap.rendererId);
    zone.queue = cleanQueue;
    zone.queueIndex = cleanIndex;
    // Always 'stopped' on boot -- never auto-resume because we don't
    // know if anyone's still in the room. The user has to press Play.
    zone.status = 'stopped';
    zone.position = 0;
    zone.positionAt = Date.now();
    // Per-zone radio setting persisted in v1.1.0.9. Older zones fall
    // back to the global radio setting via loadRadioSetting().
    zone.radio = (typeof snap.radio === 'boolean') ? snap.radio : loadRadioSetting();
    const curId = cleanQueue[cleanIndex];
    zone.currentTrack = curId ? database.prepare('SELECT * FROM tracks WHERE id = ?').get(curId) : null;
    totalTracks += cleanQueue.length;
    if (!firstRestored) firstRestored = { rendererId: snap.rendererId, queueLength: cleanQueue.length, queueIndex: cleanIndex };
  }

  // Focus the first restored zone for backwards-compat -- the UI starts
  // up showing the same zone the user last interacted with. Without a
  // single "active" concept this is just a sensible default; the user
  // can swipe between zones once we've shipped the multi-zone client UI.
  if (firstRestored) {
    setFocusedZone(firstRestored.rendererId);
    console.log(`💾 Restored ${Object.keys(snapshots).length} zone(s), ${totalTracks} track(s) total`);
  }
  return firstRestored;
}

// Restart the current track on a specific renderer's zone (#29.4). Used by
// DSP profile saves to make changes audible without forcing the user to
// manually skip. Position is reset to 0 — preserving position would require
// per-renderer Seek implementations (DLNA SetAVTransportURI + Seek REL_TIME,
// LMS playlist time, etc) which we'll add as a follow-up if needed.
//
// IMPORTANT: we stop the polling loop before issuing the new URI. Without
// this, the polling loop catches the brief STOPPED state between the old
// URI ending and the new URI starting, mis-interprets it as a track-ended
// event, and calls advanceTrack() — which kicks the queue forward. Each
// polling tick then triggers another advance, cascading through the album
// in seconds. That's the "tracks skip to last in album" symptom from 29.3.
//
// Returns true if a restart was issued, false if no track was playing on
// that renderer (no-op).
// v1.1.0.60 — recompute and broadcast the signal-path for the zone
// using this renderer, WITHOUT restarting the stream. Called as part
// of reapplyDspToRenderer so the orb / SignalPathModal reflect the
// new DSP profile immediately on save, even before playTrackOnZone
// has finished swapping the stream URI. Without this, the WebSocket
// state can sit stale for the few hundred ms it takes the renderer
// to acknowledge the URI change — a window that produced
// "bit-perfect orb pulsing red" reports during v58 testing.
async function refreshSignalPathForRenderer(rendererId) {
  if (!rendererId) return false;
  let zone = null;
  for (const z of zones.values()) {
    if (z.rendererIds[0] === rendererId && z.currentTrack) { zone = z; break; }
  }
  if (!zone) return false;
  try {
    const signalPath = await buildSignalPath(zone.currentTrack, rendererId);
    updateZone(zone, { signalPath });
    return true;
  } catch (e) {
    console.warn(`[refreshSignalPath] ${rendererId}: ${e.message}`);
    return false;
  }
}

async function restartCurrentTrack(rendererId) {
  // Find zone(s) using this renderer. The renderer may be the primary or a
  // secondary in a grouped zone — we only restart if it's primary, otherwise
  // we'd be restarting the whole zone unnecessarily.
  let zone = null;
  for (const z of zones.values()) {
    if (z.rendererIds[0] === rendererId && z.currentTrack) { zone = z; break; }
  }
  if (!zone) {
    console.warn(`[restart] renderer=${rendererId?.slice(0, 12)} BAIL (no zone with currentTrack)`);
    return false;
  }
  if (zone.status !== 'playing' && zone.status !== 'paused') {
    console.warn(`[restart] renderer=${rendererId?.slice(0, 12)} BAIL (status=${zone.status})`);
    return false;
  }
  const trackId = zone.currentTrack.id;
  // v1.1.0.88 diagnostic — log every restartCurrentTrack fire. If the
  // cascade is firing additional restarts we'll see it. Each restart
  // should be paired with a single advanceTrack-from-the-restart's-
  // success — anything else is the cascade.
  // v1.1.1.1 — gated behind MUSICD_DEBUG_PLAYBACK.
  _dbgPlayback(`[restart] zone=${zone.id?.slice(0, 12)} renderer=${rendererId?.slice(0, 12)} track=${trackId.slice(0, 8)} qIdx=${zone.queueIndex}/${zone.queue.length - 1} status=${zone.status}`);
  try {
    // Halt polling so the URI-change transition doesn't get mis-read as
    // track-ended → advance-queue. playTrackOnZone restarts polling on the
    // way out via its own startPolling() call.
    stopPolling(zone);

    // v1.1.0.86 → v1.1.0.87 — explicit Stop before the new SetAVTransportURI.
    // v87 refactored: now uses the shared ensureRendererIdle() helper
    // so the same protection covers every callsite that issues a new
    // URI on a potentially-active renderer (advanceTrack, startPlayback,
    // and this one). See ensureRendererIdle() near top of file for the
    // full rationale.
    //
    // Cost: an audible click during the transition. The user has
    // explicitly accepted this — the previous "Music playing > turn
    // off HR > skipping tracks" behaviour is the bug being fixed,
    // and "start track from start, playback continues instead of
    // skipping" is what they asked for.
    await ensureRendererIdle(zone.rendererIds);

    // Cancel any pre-queued NextURI so the renderer doesn't fast-skip past.
    // After Stop above, this is belt-and-braces — Stop should already
    // have cleared the auto-advance, but some renderers retain their
    // NextURI across Stop and would resume it on Play.
    await renderers.clearNext(rendererId).catch(() => {});
    zone.gaplessQueued = false;
    await playTrackOnZone(zone, trackId);
    return true;
  } catch (e) {
    console.warn(`[restartCurrentTrack] failed for ${rendererId}: ${e.message}`);
    return false;
  }
}

// v1.1.0.85 — Restart the current track on EVERY zone with active
// playback. Used for global settings changes (Volume Levelling on/off,
// VL target LUFS, VL mode) that affect every renderer's stream
// pipeline, not just one. Without this, toggling VL during playback
// would leave the current track playing with the old chain and only
// the next track would pick up the new setting — the symptom the
// user reported as "VL toggle requires track skip to take effect."
//
// Implementation reuses restartCurrentTrack per zone, which already
// has the correct polling-loop / pre-queue handling to avoid the
// queue-advance race. Running these sequentially (await per zone)
// rather than in parallel keeps the stream restarts staggered, which
// experimentally produces fewer transient renderer hiccups when
// multiple zones are active.
//
// Returns the number of zones actually restarted.
async function restartAllPlayingZones() {
  let count = 0;
  for (const z of zones.values()) {
    if (!z) continue;
    if (z.status !== 'playing' && z.status !== 'paused') continue;
    if (!z.currentTrack || !z.rendererIds || z.rendererIds.length === 0) continue;
    const rendererId = z.rendererIds[0];
    try {
      await refreshSignalPathForRenderer(rendererId);
      const ok = await restartCurrentTrack(rendererId);
      if (ok) count++;
    } catch (e) {
      console.warn(`[restartAllPlayingZones] zone ${z.id}: ${e.message}`);
    }
  }
  return count;
}

// v1.1.0.77 — Playback gate for the metadata scheduler.
// Returns true if at least one zone has status === 'playing'. The
// scheduler uses this to skip its tick when music is being played,
// so background metadata work doesn't compete for renderer time
// or network bandwidth with active streaming. Paused zones are
// considered idle (the user can resume any time, but right now
// nothing is being decoded or sent).
function isAnyZonePlaying() {
  for (const z of zones.values()) {
    if (z?.status === 'playing') return true;
  }
  return false;
}

module.exports = {
  getState, setState, startPlayback, pause, stopAll, setVolume, appendQueue,
  next, prev, switchToRenderer, buildSignalPath,
  getActiveZone, setActiveZone, ensureZone,
  restorePersistedQueue,
  // Queue mutation (#21/#22) and radio mode (#14)
  reorderQueue, removeFromQueue, setRadio,
  // v1.1.0.55 — batch queue operations
  removeFromQueueBatch,
  // v1.1.0.56 — play-next (album header dropdown / track ⋯ menu)
  insertNextInQueue,
  // DSP profile auto-restart (#29.4)
  restartCurrentTrack,
  // v1.1.0.85 — global settings auto-restart (VL toggle, target, mode)
  restartAllPlayingZones,
  // v1.1.0.60 — refresh signalPath without restarting stream
  refreshSignalPathForRenderer,
  // Multi-zone surface (#v1.1.0.9)
  getAllZonesState, getFocusedZone, setFocusedZone, moveQueueToRenderer,
  // v1.1.0.77 — playback gate for the metadata scheduler
  isAnyZonePlaying,
};
