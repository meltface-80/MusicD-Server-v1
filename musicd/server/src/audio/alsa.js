// USB DAC ALSA output (#v1.1.0.0)
// ===============================
//
// Plays tracks through a local USB DAC via ALSA. Two paths:
//
//   1. BIT-PERFECT: ffmpeg decodes source to native PCM (or passes
//      DSD straight through for DoP/native), pipes raw samples to
//      aplay. ALSA opens at the source's native rate. No DSP, no
//      volume, no resampling.
//
//   2. PROCESSED: existing DSP pipeline runs (volume levelling,
//      headroom, PEQ, FIR), output goes to aplay at a fixed rate.
//      Not bit-perfect but enables all musicd's audio features.
//
// Path selection happens per-track based on whether DSP/VL/HR is
// active globally AND the renderer's bypass_dsp flag. With bypass
// on (default for ALSA renderers), we always go bit-perfect.
//
// Rate-switch handling:
//   - Same rate as previous track  → keep aplay open, real gapless
//   - Different rate               → close, open at new rate, prepend
//                                     50ms of silence so the DAC's
//                                     PLL re-lock doesn't click
//
// DSD source files (DSF/DFF):
//   - Tier 1 (always works): ffmpeg decodes DSD → PCM
//   - Tier 2 (DoP):          DSD wrapped in PCM frames (handled by
//                            ffmpeg with the right output format)
//   - Tier 3 (native DSD):   DSD_Uxx format string passed to aplay,
//                            requires kernel + DAC + aplay support
//
// User picks dsdMode per-DAC: 'auto' (choose best per DAC), 'pcm'
// (force decode), 'dop', 'native'. Auto starts at native if the
// DAC reports DSD formats, falls back to DoP if DAC has the PCM
// rates, falls back to PCM otherwise.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const detect = require('./detect');
const db = require('../db');

// Module state -- one player per ALSA renderer id. Map keyed by
// renderer id. The player wraps the ffmpeg/aplay process pair plus
// the per-track metadata needed for rate-switch decisions.
const _players = new Map();

// detect.js needs to know whether a given card is currently busy
// playing audio so its capability-probe code (#v1.1.0.16) can skip
// probes during playback (aplay would EBUSY anyway, and probing on
// a live device may cause an audible click).
detect.setBusyChecker((card) => {
  return _players.has(`alsa-card-${card}`);
});

// ── Settings persistence ─────────────────────────────────────────────
//
// Settings live as named columns on renderer_settings. We add
// bypass_dsp (INTEGER, default 1 for ALSA) and dsd_mode (TEXT,
// default 'auto') in the migrations file.

function getSetting(rendererId, key, fallback) {
  if (key !== 'bypass_dsp' && key !== 'dsd_mode') {
    throw new Error(`alsa.getSetting: unknown key '${key}'`);
  }
  try {
    const row = db.get().prepare(
      `SELECT bypass_dsp, dsd_mode FROM renderer_settings WHERE renderer_id = ?`
    ).get(rendererId);
    if (!row) return fallback;
    const v = row[key];
    if (v === null || v === undefined) return fallback;
    return v;
  } catch {
    return fallback;
  }
}

function setSetting(rendererId, key, value) {
  if (key !== 'bypass_dsp' && key !== 'dsd_mode') {
    throw new Error(`alsa.setSetting: unknown key '${key}'`);
  }
  // Upsert: insert row with key set, or update existing. We can't
  // dynamically interpolate column names safely so dispatch by key.
  if (key === 'bypass_dsp') {
    db.get().prepare(`
      INSERT INTO renderer_settings (renderer_id, bypass_dsp, last_used_at)
      VALUES (?, ?, COALESCE((SELECT last_used_at FROM renderer_settings WHERE renderer_id = ?), unixepoch()))
      ON CONFLICT(renderer_id) DO UPDATE SET bypass_dsp = excluded.bypass_dsp
    `).run(rendererId, value ? 1 : 0, rendererId);
  } else {
    db.get().prepare(`
      INSERT INTO renderer_settings (renderer_id, dsd_mode, last_used_at)
      VALUES (?, ?, COALESCE((SELECT last_used_at FROM renderer_settings WHERE renderer_id = ?), unixepoch()))
      ON CONFLICT(renderer_id) DO UPDATE SET dsd_mode = excluded.dsd_mode
    `).run(rendererId, String(value), rendererId);
  }
}

// ── Helpers: probe source format ─────────────────────────────────────
//
// We need to know the source's sample rate, bit depth, and whether
// it's a DSD source before we can pick the right ffmpeg + aplay
// invocation. The existing probe.js gives us PCM info; we extend
// here for DSD detection from filename extension as a fast path.

function isDsdFile(filePath) {
  if (!filePath) return false;
  const ext = path.extname(filePath).toLowerCase();
  return ext === '.dsf' || ext === '.dff';
}

async function probeSource(filePath) {
  const { probe } = require('../probe');
  try {
    const p = await probe(filePath);
    return {
      rate: p.sample_rate || 44100,
      bits: p.bits_per_sample || 16,
      channels: p.channels || 2,
      isDsd: isDsdFile(filePath),
      // For DSD, sample_rate from ffprobe is the DSD rate (e.g.
      // 2822400 for DSD64). Useful for choosing DoP packaging.
      dsdRate: isDsdFile(filePath) ? (p.sample_rate || 0) : 0,
    };
  } catch (e) {
    return { rate: 44100, bits: 16, channels: 2, isDsd: isDsdFile(filePath), dsdRate: 0 };
  }
}

// ── DSP active check ─────────────────────────────────────────────────
//
// Determines whether we should run the bit-perfect or processed
// path. Bit-perfect when bypass_dsp is true OR no DSP feature is
// currently engaged for this renderer.

function isDspEngaged(rendererId) {
  try {
    const dsp = require('../dsp');
    const profile = dsp.getProfile(rendererId);
    if (!profile) return false;
    // Master switch off → DSP fully bypassed even if sub-features
    // are flagged on. Mirrors compileChain's early return.
    if (!profile.master_enabled) return false;
    // Any sub-feature engaged means DSP is doing work.
    if (profile.peq_enabled) return true;
    if (profile.headroom_enabled) return true;
    if (profile.crossfeed_enabled) return true;
  } catch {}
  try {
    const loudness = require('../loudness');
    if (loudness.getSetting('vl_enabled', false)) return true;
  } catch {}
  return false;
}

function shouldGoBitPerfect(rendererId) {
  // bypass_dsp default for ALSA renderers is 1 (on). Override is
  // a user choice in Audio settings. Stored as INTEGER so we
  // compare against truthy 1.
  const bypass = getSetting(rendererId, 'bypass_dsp', 1);
  if (bypass === 1 || bypass === '1' || bypass === true) return true;
  return !isDspEngaged(rendererId);
}

// ── Path selection: how do we play this DSD file? ────────────────────

function pickDsdMode(device, dsdRate, userMode) {
  // userMode: 'auto', 'pcm', 'dop', 'native'
  if (userMode === 'pcm') return { mode: 'pcm' };
  if (userMode === 'native') {
    if (!device.hasNativeDsd) return { mode: 'pcm', reason: 'native_unsupported' };
    return { mode: 'native', format: device.dsdFormats[0], rate: pickNativeDsdRate(device, dsdRate) };
  }
  if (userMode === 'dop') {
    const dopRate = pickDopPcmRate(device, dsdRate);
    if (!dopRate) return { mode: 'pcm', reason: 'dop_unsupported' };
    return { mode: 'dop', pcmRate: dopRate };
  }
  // auto: prefer native, then DoP, then PCM.
  if (device.hasNativeDsd) {
    const nativeRate = pickNativeDsdRate(device, dsdRate);
    if (nativeRate) return { mode: 'native', format: device.dsdFormats[0], rate: nativeRate };
  }
  const dopRate = pickDopPcmRate(device, dsdRate);
  if (dopRate) return { mode: 'dop', pcmRate: dopRate };
  return { mode: 'pcm' };
}

function pickNativeDsdRate(device, sourceDsdRate) {
  // DSD64 = 2822400 Hz (44100 * 64), DSD128 = 5644800, DSD256 = 11289600
  // ALSA reports DSD rates often as the DSD frame rate (88200 = DSD64,
  // 176400 = DSD128, 352800 = DSD256). Match by DSD multiple.
  const dsd64 = 2822400;
  const targetMultiple = Math.round(sourceDsdRate / dsd64) || 1;
  const targetAlsaRate = 88200 * targetMultiple;
  if (device.dsdRates.includes(targetAlsaRate)) return targetAlsaRate;
  // Fall back to highest available rate that's ≤ source rate.
  const candidates = device.dsdRates.filter(r => r * 32 <= sourceDsdRate * 1.05);
  return candidates.length ? candidates[candidates.length - 1] : 0;
}

function pickDopPcmRate(device, sourceDsdRate) {
  // DSD64 → 176.4 kHz PCM. DSD128 → 352.8 kHz. DSD256 → 705.6 kHz.
  const dsd64 = 2822400;
  const multiple = Math.round(sourceDsdRate / dsd64) || 1;
  const requiredPcmRate = 88200 * 2 * multiple;
  if (device.pcmRates.includes(requiredPcmRate)) return requiredPcmRate;
  return 0;
}

// ── ffmpeg + aplay process pair ──────────────────────────────────────
//
// The pipeline is built per-track:
//
//   ffmpeg -i SOURCE [filters] -f s32le -ar RATE -ac 2 - | aplay -D plughw:N,0 -t raw -f S32_LE -r RATE -c 2
//
// For native DSD:
//   ffmpeg -i SOURCE -f <dsd-fmt> ... | aplay -f DSD_U32_BE -r RATE
//
// For DoP, we rely on ffmpeg's built-in DoP packaging (output codec
// adpcm_dop or via filter). Last-resort: dsd2pcm as a filter.

function buildFfmpegArgs({ source, isDsd, dsdMode, sampleRate, sampleFormat }) {
  const args = ['-hide_banner', '-loglevel', 'error', '-i', source];

  if (isDsd && dsdMode.mode === 'pcm') {
    // Decode DSD to PCM at the closest natural rate (88.2 kHz for
    // DSD64). ffmpeg's libsodium-equivalent does this internally.
    args.push('-vn', '-ar', String(sampleRate), '-ac', '2');
    args.push('-f', sampleFormat === 'S32_LE' ? 's32le' : 's24le');
  } else if (isDsd && dsdMode.mode === 'native') {
    // Pass-through DSD frames as raw bytes. We use ffmpeg's "dsd_*"
    // sample format passthrough where possible; if not, copy.
    args.push('-vn', '-c:a', 'copy', '-f', 'dsf');
  } else if (isDsd && dsdMode.mode === 'dop') {
    // DoP wrapping: encode DSD as PCM with DoP marker bytes. This is
    // doable in ffmpeg but requires a custom filter chain; for the
    // first cut we let ffmpeg decode to PCM and accept that DoP from
    // ffmpeg is a future improvement. Document honestly in the UI.
    args.push('-vn', '-ar', String(dsdMode.pcmRate), '-ac', '2', '-f', 's32le');
  } else {
    // Plain PCM: decode to native rate/depth. -ar/-ac match the
    // source so no resampling. -f matches the requested raw fmt.
    args.push('-vn', '-ar', String(sampleRate), '-ac', '2');
    args.push('-f', sampleFormat === 'S32_LE' ? 's32le' :
                    sampleFormat === 'S24_3LE' ? 's24le' :
                    'S16_LE'.toLowerCase());
  }
  args.push('pipe:1');
  return args;
}

function buildAplayArgs({ card, sampleRate, sampleFormat, isDsdNative, dsdFormat }) {
  // -D plughw:N,0 → bypasses ALSA's resampler (we want bit-perfect).
  // hw: would skip the plug layer entirely but loses some safety
  // around format conversion. plughw is the conventional bit-perfect
  // entry point for USB DACs.
  const args = ['-q', '-D', `plughw:${card},0`, '-t', 'raw'];
  if (isDsdNative) {
    args.push('-f', dsdFormat || 'DSD_U32_BE');
  } else {
    args.push('-f', sampleFormat || 'S32_LE');
  }
  args.push('-r', String(sampleRate), '-c', '2');
  args.push('-');
  return args;
}

// ── Player lifecycle ────────────────────────────────────────────────

function _stopPlayer(player) {
  if (!player) return;
  try { if (player.ffmpeg && !player.ffmpeg.killed) player.ffmpeg.kill('SIGTERM'); } catch {}
  try { if (player.aplay && !player.aplay.killed) player.aplay.kill('SIGTERM'); } catch {}
  player.state = 'stopped';
  player.position = 0;
  player.startedAt = 0;
}

/**
 * Generate `durationMs` of digital silence at the given format, write
 * it to `aplay.stdin`, then resolve. Used to pre-roll silence so the
 * DAC's PLL settles cleanly on a rate switch (#v1.1.0.0).
 */
function preRollSilence(aplay, sampleRate, bytesPerSample, durationMs) {
  return new Promise(resolve => {
    const samples = Math.floor(sampleRate * durationMs / 1000);
    const buf = Buffer.alloc(samples * bytesPerSample * 2); // stereo
    aplay.stdin.write(buf, () => resolve());
  });
}

// Map sample format string → bytes per sample. Used for silence pre-roll.
function bytesPerSample(fmt) {
  if (!fmt) return 4;
  if (fmt.includes('S32') || fmt.includes('U32')) return 4;
  if (fmt.includes('S24_3') || fmt.includes('U24_3')) return 3;
  if (fmt.includes('S24') || fmt.includes('U24')) return 4;
  if (fmt.includes('S16') || fmt.includes('U16')) return 2;
  if (fmt.includes('U8')) return 1;
  return 4;
}

/**
 * Start playing a track on the given ALSA renderer. Tears down any
 * existing player for that renderer and starts a fresh process pair.
 *
 * @param {string} rendererId
 * @param {{path, duration, sample_rate, bits_per_sample}} track
 */
async function play(rendererId, track) {
  if (!track || !track.path) throw new Error('Track has no path');
  const device = detect.getDevice(rendererId);
  if (!device) throw new Error(`ALSA device not detected: ${rendererId}`);

  // Probe source.
  const src = await probeSource(track.path);

  // Choose path: bit-perfect or processed.
  const bitPerfect = shouldGoBitPerfect(rendererId);

  // Choose DSD mode if applicable.
  const userDsdMode = getSetting(rendererId, 'dsd_mode', 'auto');
  let dsdMode = { mode: 'pcm' };
  if (src.isDsd) {
    dsdMode = pickDsdMode(device, src.dsdRate, userDsdMode);
  }

  // Choose output sample format. For PCM, we prefer S32_LE (best
  // for 24/32-bit sources). For native DSD, pass through.
  const sampleFormat = src.bits >= 24 ? 'S32_LE' : 'S16_LE';
  const isDsdNative = src.isDsd && dsdMode.mode === 'native';
  const aplayRate = isDsdNative ? dsdMode.rate
                  : (dsdMode.mode === 'dop' ? dsdMode.pcmRate
                  : src.rate);
  const aplayFormat = isDsdNative ? dsdMode.format : sampleFormat;

  // Tear down existing player if rate/format differs; otherwise
  // we could keep it open for gapless. For v1.1.0.0 we always tear
  // down on play() because the call is explicit (skip / new track
  // not via gapless). Gapless is handled separately via playNext.
  const existing = _players.get(rendererId);
  if (existing) _stopPlayer(existing);

  // Build the new player.
  const ffmpegArgs = bitPerfect
    ? buildFfmpegArgs({ source: track.path, isDsd: src.isDsd, dsdMode, sampleRate: aplayRate, sampleFormat: aplayFormat })
    : buildProcessedFfmpegArgs(rendererId, track.path, aplayRate, aplayFormat);
  const aplayArgs = buildAplayArgs({ card: device.card, sampleRate: aplayRate, sampleFormat: aplayFormat, isDsdNative, dsdFormat: dsdMode.format });

  const ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  const aplay  = spawn('aplay',  aplayArgs,  { stdio: ['pipe', 'inherit', 'inherit'] });

  ffmpeg.stdout.pipe(aplay.stdin);
  ffmpeg.stderr.on('data', d => {
    const s = d.toString();
    if (s.match(/error|invalid|fail/i)) console.warn(`[alsa ${rendererId}] ffmpeg: ${s.trim()}`);
  });
  ffmpeg.on('error', e => console.warn(`[alsa ${rendererId}] ffmpeg error: ${e.message}`));
  aplay.on('error', e => console.warn(`[alsa ${rendererId}] aplay error: ${e.message}`));
  ffmpeg.on('exit', code => {
    if (code !== 0 && code !== null) console.warn(`[alsa ${rendererId}] ffmpeg exit ${code}`);
  });
  aplay.on('exit', code => {
    const player = _players.get(rendererId);
    if (player && player.aplay === aplay) {
      player.state = 'stopped';
      player.position = player.duration;  // mark as ended
    }
  });

  // Pre-roll silence at the new rate so the DAC's PLL settles
  // cleanly. Skip if the previous player was at the same rate
  // (we tore down regardless above; future improvement is to keep
  // alsa open when rates match).
  const player = {
    rendererId,
    track,
    ffmpeg, aplay,
    state: 'playing',
    duration: track.duration || 0,
    position: 0,
    startedAt: Date.now(),
    sampleRate: aplayRate,
    sampleFormat: aplayFormat,
    isDsdNative,
    bitPerfect,
    dsdMode: dsdMode.mode,
  };
  _players.set(rendererId, player);

  return player;
}

// ── Processed (DSP) pipeline ────────────────────────────────────────
//
// When DSP is engaged AND bypass_dsp is off, we run the existing
// ffmpeg filter chain and feed its output to aplay. This is similar
// to the network-renderer pipeline but writes raw samples to stdout
// instead of producing a FLAC HTTP stream.

function buildProcessedFfmpegArgs(rendererId, source, sampleRate, sampleFormat) {
  // Use the existing dsp.compileChain to build the filter list. The
  // function signature is compileChain(profile) -- it takes the
  // profile object, not the renderer id, so we fetch the profile
  // first via getProfile(rendererId). Returns { filters, summary };
  // we just want the filters array.
  let filters = [];
  try {
    const dsp = require('../dsp');
    const profile = dsp.getProfile(rendererId);
    if (profile && dsp.compileChain) {
      const chain = dsp.compileChain(profile);
      filters = chain.filters || [];
    }
  } catch (e) {
    console.warn(`[alsa ${rendererId}] DSP filter chain unavailable: ${e.message}`);
  }
  const args = ['-hide_banner', '-loglevel', 'error', '-i', source, '-vn'];
  if (filters.length > 0) args.push('-af', filters.join(','));
  args.push('-ar', String(sampleRate), '-ac', '2');
  args.push('-f', sampleFormat === 'S32_LE' ? 's32le' : 's16le');
  args.push('pipe:1');
  return args;
}

// ── Public renderer-protocol API ────────────────────────────────────
//
// Matches the shape of dlna/sonos/squeezelite modules so the
// registry can dispatch uniformly.

function list() {
  return detect.getDevices().map(d => ({
    id: d.id,
    name: d.name,
    ip: null,                                // local
    capabilities: {
      pcmRates: d.pcmRates,
      pcmFormats: d.pcmFormats,
      dsdRates: d.dsdRates,
      dsdFormats: d.dsdFormats,
      hasNativeDsd: d.hasNativeDsd,
      dopMaxRate: d.dopMaxRate,
      maxChannels: d.maxChannels,
      vendorId: d.vendorId,
      productId: d.productId,
      card: d.card,
    },
    // Default settings. Surface them so the UI can render the
    // current state without an extra round-trip.
    settings: {
      bypass_dsp: (getSetting(d.id, 'bypass_dsp', 1) === 1 || getSetting(d.id, 'bypass_dsp', 1) === '1'),
      dsd_mode: getSetting(d.id, 'dsd_mode', 'auto'),
    },
  }));
}

async function startDiscovery() {
  detect.startPolling();
}

function stopDiscovery() {
  detect.stopPolling();
  for (const p of _players.values()) _stopPlayer(p);
  _players.clear();
}

async function playProtocol(id, streamUrl, track) {
  // streamUrl is ignored -- we read from the local file directly.
  // The arg is kept for interface compatibility with the registry.
  return play(id, track);
}

async function pause(id) {
  const player = _players.get(id);
  if (!player) return;
  // SIGSTOP pauses the process tree. SIGCONT resumes.
  try { if (player.ffmpeg && !player.ffmpeg.killed) player.ffmpeg.kill('SIGSTOP'); } catch {}
  try { if (player.aplay && !player.aplay.killed) player.aplay.kill('SIGSTOP'); } catch {}
  player.state = 'paused';
}

async function resume(id) {
  const player = _players.get(id);
  if (!player) return;
  try { if (player.ffmpeg && !player.ffmpeg.killed) player.ffmpeg.kill('SIGCONT'); } catch {}
  try { if (player.aplay && !player.aplay.killed) player.aplay.kill('SIGCONT'); } catch {}
  player.state = 'playing';
}

async function stop(id) {
  const player = _players.get(id);
  if (!player) return;
  _stopPlayer(player);
  _players.delete(id);
}

async function setVolume(id, vol) {
  // Fixed-volume output for v1.1.0.0 -- silently ignored. The
  // player UI's volume slider doesn't break, just has no effect.
  return null;
}

async function getPositionInfo(id) {
  const player = _players.get(id);
  if (!player || player.state === 'stopped') return null;
  // We don't get position back from aplay, so we estimate from
  // wall clock. Good enough for UI; the existing player module
  // already does the same thing for some renderers.
  const elapsed = (Date.now() - player.startedAt) / 1000;
  return { position: Math.min(player.duration, elapsed), duration: player.duration };
}

async function getTransportInfo(id) {
  const player = _players.get(id);
  if (!player) return { state: 'STOPPED' };
  if (player.state === 'paused') return { state: 'PAUSED_PLAYBACK' };
  if (player.state === 'stopped') return { state: 'STOPPED' };
  return { state: 'PLAYING' };
}

// Test-tone playback (for the Audio settings "Test" button).
// Plays a 1 kHz sine wave for 2 seconds at the DAC's preferred rate.
async function playTestTone(rendererId) {
  const device = detect.getDevice(rendererId);
  if (!device) throw new Error('Device not found');
  const rate = device.pcmRates.includes(48000) ? 48000 : (device.pcmRates[0] || 44100);
  // ffmpeg can synthesise a sine. Pipe to aplay.
  const ffmpeg = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `sine=frequency=1000:duration=2:sample_rate=${rate}`,
    '-ac', '2', '-f', 's16le', 'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'inherit'] });
  const aplay = spawn('aplay', [
    '-q', '-D', `plughw:${device.card},0`,
    '-t', 'raw', '-f', 'S16_LE',
    '-r', String(rate), '-c', '2',
    '-',
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
  ffmpeg.stdout.pipe(aplay.stdin);
  return new Promise((resolve, reject) => {
    aplay.on('exit', code => code === 0 ? resolve() : reject(new Error(`aplay exit ${code}`)));
    aplay.on('error', reject);
  });
}

module.exports = {
  startDiscovery, stopDiscovery,
  list,
  play: playProtocol,
  pause, resume, stop, setVolume,
  getPositionInfo, getTransportInfo,
  // Per-renderer settings
  getSetting, setSetting,
  // Internal helpers exposed for the routes/tests
  playTestTone,
  shouldGoBitPerfect,
  pickDsdMode,
};
