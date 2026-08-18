// FIR / convolution module (#29.1)
// =================================
// Manages user-uploaded impulse response (IR) WAV files, one per supported
// sample rate per renderer. Provides:
//
//   • Strict WAV header validation (refuses anything ffmpeg would silently
//     accept-but-mangle, like 44.1 kHz floats labelled as integers)
//   • IR storage at <data>/dsp/ir/<rendererId>/<rate>.wav
//   • Rate-aware selection given a source rate
//   • Frequency-response summary for the signal-path display
//
// Why we're strict about WAVs:
//   ffmpeg's afir filter reads any WAV file the WAV demuxer accepts, but
//   silently picks up the IR's sample rate and convolves at the chain's rate
//   regardless. If those don't match, the filter's frequency response gets
//   stretched/squashed (a 48 kHz IR running at 96 kHz becomes a
//   half-frequency low-pass filter — audibly wrong for room correction).
//   We protect users from this by enforcing rate-matched IRs at upload time.

const fs = require('fs');
const path = require('path');
const paths = require('../paths');

// Sample rates the FIR system supports. These are the canonical PCM rates
// for music — we don't bother with 22.05 / 11.025 (legacy) or higher than
// 192 (SACD/DXD territory; if the user has those they have bigger problems).
const SUPPORTED_RATES = [44100, 48000, 88200, 96000, 176400, 192000];

// Maximum IR length we'll accept. 8192 samples at 48 kHz ≈ 170ms, plenty for
// either room correction (typical 5-50 ms) or headphone correction (typical
// minimum-phase, < 1024 taps). At 192 kHz the same time becomes 32 768 taps —
// CPU still fine on a Raspberry Pi 4 with afir's partitioned FFT convolution.
const MAX_IR_DURATION_SECONDS = 1.0;

// Maximum IR file size as a final safety net. 192 kHz × 32 bit × 2 ch × 1 s
// = 1.5 MB. Round up to 16 MB to allow some slack for unusual encodings.
const MAX_IR_FILE_SIZE = 16 * 1024 * 1024;

// ---- WAV header parser ----
//
// We read just enough of the header to validate the file. RIFF format is
// chunk-based: "RIFF" header, "fmt " chunk with format params, "data" chunk
// with samples. Most WAVs we'll see are PCM int16/24 or IEEE float32.
//
// Returns { ok, error?, sampleRate, channels, bitDepth, format, sampleCount }
function parseWavHeader(buffer) {
  if (!Buffer.isBuffer(buffer)) return { ok: false, error: 'Not a buffer' };
  if (buffer.length < 44) return { ok: false, error: 'File too short to be a WAV' };

  // RIFF / RF64 / BW64 — all three are valid container magic for a WAV.
  // RF64 (EBU broadcast spec) and BW64 (Wave64) are extensions that
  // support files >4GB. The actual chunk parsing below is identical
  // for all three; we just have to allow any of the three magic
  // values at offset 0. (#v1.1.0.49+ — was RIFF-only, which rejected
  // exports from REW post-2022 and most pro tools.)
  const magic = buffer.toString('ascii', 0, 4);
  if (magic !== 'RIFF' && magic !== 'RF64' && magic !== 'BW64') {
    // Detect specific common "wrong format" cases and give a tailored
    // error that's actionable (#v1.1.0.50). Otherwise fall back to a
    // generic "got these bytes, expected RIFF" message.
    return { ok: false, error: explainWrongFormat(buffer, magic) };
  }
  if (buffer.toString('ascii', 8, 12) !== 'WAVE') {
    return { ok: false, error: 'Not a WAVE file (missing "WAVE" type at offset 8)' };
  }

  // Walk chunks looking for "fmt " and "data". Some WAVs have intermediate
  // chunks (LIST, JUNK, etc) so we can't assume "fmt " is at offset 12.
  let pos = 12;
  let fmt = null;
  let dataSize = null;
  while (pos + 8 <= buffer.length) {
    const chunkId   = buffer.toString('ascii', pos, pos + 4);
    const chunkSize = buffer.readUInt32LE(pos + 4);
    const chunkBody = pos + 8;
    if (chunkId === 'fmt ') {
      if (chunkSize < 16) return { ok: false, error: 'fmt chunk too short' };
      const formatTag    = buffer.readUInt16LE(chunkBody + 0);
      const channels     = buffer.readUInt16LE(chunkBody + 2);
      const sampleRate   = buffer.readUInt32LE(chunkBody + 4);
      const bitDepth     = buffer.readUInt16LE(chunkBody + 14);
      // Format tag: 1 = PCM int, 3 = IEEE float, 0xFFFE = WAVEFORMATEXTENSIBLE
      // (which is what most modern recording tools produce; the actual format
      // is in the SubFormat GUID).
      let format;
      if (formatTag === 1)        format = 'pcm_int';
      else if (formatTag === 3)   format = 'pcm_float';
      else if (formatTag === 0xFFFE) {
        // WAVEFORMATEXTENSIBLE: subformat GUID lives at chunkBody+24..40.
        // The first 2 bytes of the GUID match formatTag (1=PCM, 3=float).
        if (chunkSize >= 40) {
          const subTag = buffer.readUInt16LE(chunkBody + 24);
          if (subTag === 1)      format = 'pcm_int';
          else if (subTag === 3) format = 'pcm_float';
          else                   format = `unknown (extensible subtag ${subTag})`;
        } else {
          format = 'extensible (truncated)';
        }
      }
      else format = `compressed (formatTag ${formatTag})`;
      fmt = { formatTag, format, channels, sampleRate, bitDepth };
    } else if (chunkId === 'data') {
      dataSize = chunkSize;
      break; // we have everything we need
    }
    // Chunks are word-aligned (always pad to even length)
    pos = chunkBody + chunkSize + (chunkSize & 1);
  }

  if (!fmt) return { ok: false, error: 'No fmt chunk found' };
  if (dataSize == null) return { ok: false, error: 'No data chunk found' };

  // Now run validation rules. We're conservative; if anything looks off we
  // refuse. Better to surface a clear error than feed a malformed IR through
  // ffmpeg and get silently wrong sound.
  if (!fmt.format.startsWith('pcm_')) {
    return { ok: false, error: `Unsupported format: ${fmt.format}. Need PCM int or IEEE float.` };
  }
  if (fmt.channels < 1 || fmt.channels > 2) {
    return { ok: false, error: `Unsupported channel count: ${fmt.channels}. Need mono or stereo.` };
  }
  if (!SUPPORTED_RATES.includes(fmt.sampleRate)) {
    return { ok: false, error: `Unsupported sample rate: ${fmt.sampleRate} Hz. Use 44.1, 48, 88.2, 96, 176.4 or 192 kHz.` };
  }
  if (![16, 24, 32].includes(fmt.bitDepth)) {
    return { ok: false, error: `Unsupported bit depth: ${fmt.bitDepth}. Use 16, 24 or 32 bit.` };
  }

  // Sample count = dataSize / (channels * bitDepth/8)
  const bytesPerFrame = fmt.channels * (fmt.bitDepth / 8);
  const sampleCount = Math.floor(dataSize / bytesPerFrame);
  const durationSec = sampleCount / fmt.sampleRate;

  if (durationSec > MAX_IR_DURATION_SECONDS) {
    return { ok: false, error: `IR too long: ${durationSec.toFixed(2)}s (max ${MAX_IR_DURATION_SECONDS}s).` };
  }
  if (sampleCount < 16) {
    return { ok: false, error: `IR too short: ${sampleCount} samples.` };
  }

  return {
    ok: true,
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitDepth: fmt.bitDepth,
    format: fmt.format,
    sampleCount,
    durationSeconds: durationSec,
    fileSize: buffer.length,
  };
}

// ---- IR storage ----
//
// One subdirectory per renderer (sanitised id), one file per supported rate
// named "<rate>.wav". This means the user can have 6 IRs per renderer, all
// addressed by sample rate — which is the only thing that matters at stream
// time.
function rendererIrDir(rendererId) {
  const safe = String(rendererId).replace(/[^a-zA-Z0-9_.-]/g, '_');
  return path.join(paths.IR_DIR, safe);
}

function irPath(rendererId, sampleRate) {
  return path.join(rendererIrDir(rendererId), `${sampleRate}.wav`);
}

// Write a validated WAV buffer to <ir>/<renderer>/<rate>.wav. Caller has
// already validated; this just persists. Returns the absolute path.
//
// v1.1.0.53: also computes the peak gain of the IR samples and writes a
// sidecar JSON file alongside the wav. The peak is needed for clipping
// prediction in the headroom feature; computing it once at save time
// is cheaper than recomputing on every listIrs() call.
function saveIr(rendererId, sampleRate, buffer) {
  const dir = rendererIrDir(rendererId);
  fs.mkdirSync(dir, { recursive: true });
  const fp = irPath(rendererId, sampleRate);
  fs.writeFileSync(fp, buffer);
  // Compute and persist peak. Failure here is non-fatal — the IR
  // itself is fine; we just won't have a peak badge in the UI until
  // the next save or the boot-time backfill.
  try {
    const peakDb = computeIrPeakDb(buffer);
    fs.writeFileSync(metaPath(rendererId, sampleRate), JSON.stringify({
      peakDb, computedAt: Date.now(), version: 1,
    }));
  } catch (e) {
    // Log but don't throw.
    console.warn(`[fir] could not compute peak for ${fp}: ${e.message}`);
  }
  return fp;
}

// Sidecar file holding cached peak gain. Lives next to the wav so a
// renderer's IR directory is self-contained and a wipe-the-renderer
// clean removes both. Format is intentionally simple JSON so it's
// easy to inspect or edit by hand if needed.
function metaPath(rendererId, sampleRate) {
  return irPath(rendererId, sampleRate) + '.meta.json';
}

function readMeta(rendererId, sampleRate) {
  try {
    const raw = fs.readFileSync(metaPath(rendererId, sampleRate), 'utf8');
    return JSON.parse(raw);
  } catch { return null; }
}

// Compute the peak amplitude of an IR's samples and return it in dBFS.
// Walks the data chunk by bit-depth, taking max(abs(sample)) across all
// channels. Returns the result as 20*log10(peak/full_scale).
//
// For stereo files we take the global max (not per-channel) because
// the headroom we apply is shared across channels — the limiting case
// is whichever channel hits hardest.
//
// Cost: ~1ms for a 1-second 24-bit mono IR. Fine for upload-time, fine
// for boot-time backfill.
function computeIrPeakDb(buffer) {
  const parsed = parseWavHeader(buffer);
  if (!parsed.ok) throw new Error(parsed.error || 'parse failed');

  // Find the data chunk. parseWavHeader walks chunks but doesn't return
  // the data offset, so re-walk here. (Cheap; chunks are few.)
  let pos = 12;
  let dataOffset = null;
  let dataSize = null;
  while (pos + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', pos, pos + 4);
    const chunkSize = buffer.readUInt32LE(pos + 4);
    if (chunkId === 'data') {
      dataOffset = pos + 8;
      dataSize = chunkSize;
      break;
    }
    pos = pos + 8 + chunkSize + (chunkSize & 1);
  }
  if (dataOffset == null) throw new Error('no data chunk');

  const { bitDepth, format, channels } = parsed;
  const bytesPerSample = bitDepth / 8;
  const sampleCount = Math.floor(dataSize / bytesPerSample);
  let maxAbs = 0;

  if (format === 'pcm_int') {
    if (bitDepth === 16) {
      const fullScale = 32768;
      for (let i = 0; i < sampleCount; i++) {
        const v = Math.abs(buffer.readInt16LE(dataOffset + i * 2));
        if (v > maxAbs) maxAbs = v;
      }
      maxAbs = maxAbs / fullScale;
    } else if (bitDepth === 24) {
      const fullScale = 8388608;
      for (let i = 0; i < sampleCount; i++) {
        const off = dataOffset + i * 3;
        // 24-bit signed little-endian
        let v = buffer[off] | (buffer[off+1] << 8) | (buffer[off+2] << 16);
        if (v & 0x800000) v |= ~0xffffff; // sign-extend
        const a = Math.abs(v);
        if (a > maxAbs) maxAbs = a;
      }
      maxAbs = maxAbs / fullScale;
    } else if (bitDepth === 32) {
      const fullScale = 2147483648;
      for (let i = 0; i < sampleCount; i++) {
        const v = Math.abs(buffer.readInt32LE(dataOffset + i * 4));
        if (v > maxAbs) maxAbs = v;
      }
      maxAbs = maxAbs / fullScale;
    } else {
      throw new Error(`unsupported pcm_int bit depth: ${bitDepth}`);
    }
  } else if (format === 'pcm_float') {
    if (bitDepth === 32) {
      for (let i = 0; i < sampleCount; i++) {
        const v = Math.abs(buffer.readFloatLE(dataOffset + i * 4));
        if (v > maxAbs) maxAbs = v;
      }
    } else if (bitDepth === 64) {
      for (let i = 0; i < sampleCount; i++) {
        const v = Math.abs(buffer.readDoubleLE(dataOffset + i * 8));
        if (v > maxAbs) maxAbs = v;
      }
    } else {
      throw new Error(`unsupported pcm_float bit depth: ${bitDepth}`);
    }
  } else {
    throw new Error(`unsupported format: ${format}`);
  }

  if (maxAbs <= 0) return -Infinity;
  return 20 * Math.log10(maxAbs);
}

function deleteIr(rendererId, sampleRate) {
  const fp = irPath(rendererId, sampleRate);
  let ok = false;
  try { fs.unlinkSync(fp); ok = true; } catch {}
  // Also remove the sidecar so a re-upload starts clean.
  try { fs.unlinkSync(metaPath(rendererId, sampleRate)); } catch {}
  return ok;
}

// One-time backfill of peak metadata for IRs uploaded before v1.1.0.53.
// Walks every renderer's IR dir, and for any wav lacking a sidecar,
// reads the file, computes peak, writes the sidecar. Returns counts.
//
// Designed to be safe to call repeatedly — only does work for files
// missing a sidecar, so a second call is essentially free. Designed to
// not throw on individual file errors so a single bad IR doesn't stop
// the rest.
function backfillPeakMeta() {
  const root = paths.IR_DIR;
  let scanned = 0, computed = 0, skipped = 0, failed = 0;
  if (!fs.existsSync(root)) return { scanned, computed, skipped, failed };
  for (const rendererSafeId of fs.readdirSync(root)) {
    const dir = path.join(root, rendererSafeId);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const fn of fs.readdirSync(dir)) {
      if (!fn.endsWith('.wav')) continue;
      scanned++;
      const wavPath = path.join(dir, fn);
      const sideCarPath = wavPath + '.meta.json';
      if (fs.existsSync(sideCarPath)) { skipped++; continue; }
      try {
        const buf = fs.readFileSync(wavPath);
        const peakDb = computeIrPeakDb(buf);
        fs.writeFileSync(sideCarPath, JSON.stringify({
          peakDb, computedAt: Date.now(), version: 1,
        }));
        computed++;
      } catch (e) {
        console.warn(`[fir] backfill failed for ${wavPath}: ${e.message}`);
        failed++;
      }
    }
  }
  return { scanned, computed, skipped, failed };
}

// List of IRs currently saved for a renderer, with metadata. Used by the UI
// to show "44.1 kHz: my-room.wav (8192 taps, 22 ms)" per row.
function listIrs(rendererId) {
  const dir = rendererIrDir(rendererId);
  const out = {};
  if (!fs.existsSync(dir)) return out;
  for (const rate of SUPPORTED_RATES) {
    const fp = irPath(rendererId, rate);
    if (!fs.existsSync(fp)) continue;
    try {
      // Read enough of the file to find the data chunk header. The
      // earlier 1KB read was too small for files with bext/JUNK/LIST
      // chunks between fmt and data — REW, HouseCurve, and other
      // broadcast-style WAVs embed metadata that can push the data
      // chunk past 1KB. 64KB is comfortably past anything sane while
      // still being small enough not to matter at memory usage.
      // (Past v1.1.0.50 we returned "No data chunk found" for any
      // such file — the IR was on disk and usable, just not visible
      // in the UI.)
      const stat = fs.statSync(fp);
      const readSize = Math.min(stat.size, 65536);
      const fd = fs.openSync(fp, 'r');
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, 0);
      fs.closeSync(fd);
      const parsed = parseWavHeader(buf);
      const meta = readMeta(rendererId, rate);
      out[String(rate)] = {
        sampleRate:  rate,
        path:        fp,
        relPath:     `${rate}.wav`,
        fileSize:    stat.size,
        mtime:       stat.mtimeMs,
        // parseWavHeader's sampleCount and durationSeconds will be wrong if
        // we couldn't read the data chunk header in the first 64 KB; for any
        // normally-formed WAV the fmt chunk and data chunk header fit easily.
        ok:          parsed.ok,
        error:       parsed.error || null,
        channels:    parsed.channels,
        bitDepth:    parsed.bitDepth,
        format:      parsed.format,
        // v1.1.0.53: peak gain in dBFS, from the sidecar. Null if the
        // sidecar is missing (older IR, backfill hasn't run yet).
        peakDb:      meta?.peakDb ?? null,
      };
    } catch (e) {
      out[String(rate)] = { sampleRate: rate, error: e.message };
    }
  }
  return out;
}

// ---- Rate selection ----
//
// At stream time, given the source's sample rate, return the path of the IR
// to use. v29.1 policy: exact match only. If the user has uploaded a 96 kHz
// IR but the source is 88.2 kHz, we DO NOT silently substitute — convolution
// is skipped that track and the signal-path display warns. This protects
// against the silent-frequency-response-stretch failure mode.
//
// Returns { path, sampleRate, exact: true } or null if no match.
function selectIrForRate(rendererId, sourceRate) {
  if (!sourceRate || !SUPPORTED_RATES.includes(sourceRate)) return null;
  const fp = irPath(rendererId, sourceRate);
  if (!fs.existsSync(fp)) return null;
  return { path: fp, sampleRate: sourceRate, exact: true };
}

module.exports = {
  SUPPORTED_RATES,
  MAX_IR_DURATION_SECONDS,
  MAX_IR_FILE_SIZE,
  parseWavHeader,
  saveIr,
  deleteIr,
  listIrs,
  selectIrForRate,
  irPath,
  rendererIrDir,
  // v1.1.0.53
  computeIrPeakDb,
  backfillPeakMeta,
  metaPath,
  readMeta,
};

// ---------------------------------------------------------------
// Format detection for "wrong file" diagnostics (#v1.1.0.50).
//
// When the file at upload time isn't a RIFF/RF64/BW64 WAV, this
// function inspects enough of the header to identify what it
// actually is and produce a tailored, actionable error. The
// distinction matters because the recovery path is different
// per format:
//
//   - MP4/QuickTime + AAC: lossy compression destroys IR precision;
//     conversion to PCM WAV is technically possible but the result
//     won't make a meaningful FIR filter. User should re-export
//     from source.
//   - MP4 + ALAC: lossless inside an MP4 container; ffmpeg can
//     transcode to WAV without loss. Tell the user that.
//   - FLAC / WavPack: lossless; direct ffmpeg transcode is fine.
//   - MP3 / OGG Vorbis / Opus: lossy; same caveat as AAC.
//   - AIFF: pretty much equivalent to WAV; ffmpeg transcode is fine.
//
// The returned string is shown directly to the user, so it has
// to read as plain English rather than a stack trace.
function explainWrongFormat(buffer, magic) {
  const hex = buffer.slice(0, 4).toString('hex');
  const printable = magic.replace(/[\x00-\x1F\x7F]/g, '?');
  const generic = `Not a WAV file. Got "${printable}" (hex ${hex}); expected "RIFF".`;

  // MP4 / QuickTime / M4A. The format is { 4 bytes box length }{ 'ftyp' }{ 4 bytes brand }
  // Box length is big-endian and varies (commonly 0x14, 0x18, 0x20, 0x1C).
  // What's reliable is bytes 4-8 = 'ftyp'.
  if (buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buffer.toString('ascii', 8, 12).trim();
    // Try to identify the actual audio codec inside. For an MP4
    // audio file with a single track, the codec four-cc shows up
    // somewhere in the moov box. Cheap heuristic: scan first 8KB
    // for known audio four-ccs.
    const headSlice = buffer.slice(0, Math.min(buffer.length, 8192));
    const codec = detectMp4AudioCodec(headSlice);

    if (codec === 'aac') {
      return (
        `This is an MP4/AAC audio file (brand "${brand}"), not a WAV. ` +
        `The .wav extension is wrong — the contents are AAC-compressed audio. ` +
        `AAC compression destroys the precision needed for FIR convolution; ` +
        `re-export the impulse response from your measurement tool (REW, Audiolense, ` +
        `etc.) as PCM WAV. If this came from iOS Voice Memos or screen recording, ` +
        `the audio was AAC-encoded and isn't usable as an IR.`
      );
    }
    if (codec === 'alac') {
      return (
        `This is an MP4/ALAC file (Apple Lossless), not a WAV. ` +
        `ALAC is lossless so the data is recoverable -- convert it on the host with: ` +
        `ffmpeg -i input.m4a -c:a pcm_s24le output.wav`
      );
    }
    return (
      `This is an MP4/QuickTime container (brand "${brand}"), not a WAV. ` +
      `Re-export the impulse response from your measurement tool as PCM WAV. ` +
      `If you only have this file, try: ffmpeg -i input.m4a -c:a pcm_s24le output.wav ` +
      `(but lossy codecs inside MP4 like AAC won't make a meaningful IR).`
    );
  }

  // FLAC.
  if (magic === 'fLaC') {
    return (
      `This is a FLAC file, not a WAV. Convert with: ` +
      `ffmpeg -i input.flac -c:a pcm_s24le output.wav (lossless, safe for FIR).`
    );
  }

  // OGG (Vorbis/Opus). Lossy.
  if (magic === 'OggS') {
    return (
      `This is an Ogg container (Vorbis/Opus), not a WAV. The contents are ` +
      `lossy-compressed and won't make a meaningful FIR; re-export from your ` +
      `measurement tool as PCM WAV.`
    );
  }

  // AIFF. Lossless.
  if (magic === 'FORM' && buffer.length >= 12 &&
      (buffer.toString('ascii', 8, 12) === 'AIFF' || buffer.toString('ascii', 8, 12) === 'AIFC')) {
    return (
      `This is an AIFF file, not a WAV. Convert with: ` +
      `ffmpeg -i input.aiff -c:a pcm_s24le output.wav.`
    );
  }

  // MP3 (ID3v2 tag prefix or raw MPEG sync).
  if (magic.startsWith('ID3') ||
      (buffer[0] === 0xFF && (buffer[1] & 0xE0) === 0xE0 && (buffer[1] & 0x18) !== 0x08)) {
    return (
      `This is an MP3 file, not a WAV. MP3 is lossy and won't make a meaningful ` +
      `FIR; re-export from your measurement tool as PCM WAV.`
    );
  }

  // AAC raw stream (ADTS).
  if (buffer[0] === 0xFF && (buffer[1] & 0xF6) === 0xF0) {
    return (
      `This is a raw AAC stream, not a WAV. AAC is lossy and won't make a ` +
      `meaningful FIR; re-export from your measurement tool as PCM WAV.`
    );
  }

  // Fallthrough: unknown. Keep the original diagnostic so a future
  // unknown format produces a debuggable error.
  return (
    `${generic} The file you picked may not be a WAV — common cause on ` +
    `iOS is the picker handing back a placeholder or converted file. ` +
    `Try uploading from the Files app rather than Photos.`
  );
}

// Cheap heuristic for which audio codec lives inside an MP4 moov box.
// Looks for four-cc strings that appear in the stsd entry. Returns
// 'aac', 'alac', or null if it can't determine.
function detectMp4AudioCodec(headSlice) {
  const s = headSlice.toString('binary');
  if (s.includes('alac')) return 'alac';
  if (s.includes('mp4a')) return 'aac';
  return null;
}

