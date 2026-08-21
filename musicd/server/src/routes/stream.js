const express = require('express');
const router = express.Router();
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const db = require('../db');
const loudness = require('../loudness');
const { probe } = require('../probe');
const renderers = require('../renderers');
const { planDownsample } = require('../downsamplePlan');
const dsp = require('../dsp');
const fir = require('../dsp/fir');

// All DSD sources land at this PCM rate. Rationale:
//   - DSD bitstreams are always 44.1×N (DSD64=2.8224 MHz, DSD128=5.6448 MHz, etc).
//     Native ffmpeg decode is dsd_rate / 8: DSD64→352.8 kHz, DSD128→705.6 kHz.
//   - We want the highest 44.1-family integer multiple ≤ 192 kHz, which is 176.4.
//   - Going to 192 (48-family) would force a 44.1↔48 conversion, audibly harmful.
//   - 176.4 is supported by every renderer we care about (WiiM Pro Plus 24/192 cap,
//     etc.) and stays well below their bandwidth ceilings.
const DSD_TARGET_RATE = 176400;

// HTTP headers can only contain printable ASCII (32-126) per RFC 7230.
// Some of our diagnostic strings use em dashes / bullets / curly quotes
// which the Node http layer rightly rejects with ERR_INVALID_CHAR. That
// crashes the response, the renderer never gets the stream, and the
// user-facing symptom is "play button spins forever".
//
// (#30.10 fix) Sanitise all header values through here. Anything outside
// printable ASCII is replaced with '?' so the header still goes out and
// the stream still works. Length-clamped at 200 chars belt-and-braces
// in case a long path or message ever sneaks in.
function safeHeader(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[^\x20-\x7E]/g, '?').slice(0, 200);
}

router.get('/:trackId', async (req, res) => {
  const database = db.get();
  const track = database.prepare('SELECT * FROM tracks WHERE id = ?').get(req.params.trackId);
  if (!track) return res.status(404).json({ error: 'Track not found' });

  try { await fsp.access(track.path); }
  catch { return res.status(404).json({ error: 'File not found' }); }

  const ext = path.extname(track.path).toLowerCase();
  const isDSD = ['.dsf', '.dff', '.dsd'].includes(ext);
  const isFlac = ext === '.flac';
  const isMp3 = ext === '.mp3';
  const isWav = ext === '.wav' || ext === '.aif' || ext === '.aiff';

  if (track.duration) {
    res.setHeader('X-Content-Duration', track.duration.toFixed(3));
    res.setHeader('Content-Duration', track.duration.toFixed(3));
  }

  // Volume levelling decision.
  //
  // v1.1.32.0 — per zone. This is the site that actually changes what comes
  // out of the encoder, so it reads the renderer's own profile; with no
  // ?renderer on the request there is no zone to read, and getProfile's
  // fallback (the frozen global) is what every unset zone resolves to anyway.
  //
  // dsp.getProfile is safe for ineligible renderers too — levelling is a gain
  // applied before the encoder, not part of the DSP chain, so it is NOT gated
  // on isDspEligible the way the filter chain below is. A Sonos zone can level
  // even though its EQ is bypassed.
  const vlProfile = dsp.getProfile(req.query.renderer || null);
  const vlEnabled = !!vlProfile.vl_enabled;
  const targetLufs = vlProfile.vl_target_lufs;
  let gainInfo = null;
  if (vlEnabled) gainInfo = loudness.computeStreamGain(track.id, targetLufs, vlProfile.vl_mode);

  // DSP profile lookup. Skip entirely for non-DSP-eligible renderers.
  let dspChain = { filters: [], summary: [] };
  let dspApplied = false;
  let dspProfile = null;
  let dspDiag = null;   // diagnostic info, surfaced via response headers
  // Sonos 16-bit override (#v1.1.0.8). Some users find their Sonos
  // pipeline more reliable when fed strict 16-bit material. When set
  // for a Sonos renderer, the encoder downstream uses 16-bit FLAC with
  // TPDF dither instead of 24-bit. Only meaningful for protocol === 'sonos';
  // the flag is ignored for other renderer types even if persisted.
  let force16bit = false;
  if (req.query.renderer) {
    const r = renderers.getRenderer(req.query.renderer);
    const proto = r?.protocol || null;
    if (proto === 'sonos') {
      try {
        const db = require('../db');
        const row = db.get().prepare(
          "SELECT sonos_force_16bit FROM renderer_settings WHERE renderer_id = ?"
        ).get(req.query.renderer);
        if (row && row.sonos_force_16bit) force16bit = true;
      } catch {}
    }
    if (!proto) {
      dspDiag = `renderer ${req.query.renderer} not in registry - DSP skipped`;
    } else if (!dsp.isDspEligible(proto)) {
      dspDiag = `protocol ${proto} not DSP-eligible - skipped`;
    } else {
      try {
        dspProfile = dsp.getProfile(req.query.renderer);
        const compiled = dsp.compileChain(dspProfile);
        // v1.1.0.84 — headroom-only profiles previously fell through here
        // because dspApplied gated on filters.length > 0, but headroom is
        // returned as a separate `headroomDb` field (it's applied at a
        // specific late-chain position by the stream route, not bundled
        // into the filter list). A profile with only headroom enabled
        // produces empty filters but a non-zero headroomDb, and was
        // silently treated as "no DSP" — meaning headroom never got
        // applied. Now we treat any non-trivial chain output (filters OR
        // a negative headroomDb) as DSP-active.
        const hasFilters = compiled.filters.length > 0;
        const hasHeadroom = compiled.headroomDb && compiled.headroomDb < 0;
        if (hasFilters || hasHeadroom) {
          dspChain = compiled;
          dspApplied = true;
          dspDiag = `applied: ${compiled.summary.join(' | ')}`;
        } else {
          dspDiag = `compile produced empty chain (master_enabled=${dspProfile.master_enabled} peq_enabled=${dspProfile.peq_enabled} peq_filters=${dspProfile.peq_filters?.length || 0} headroom_enabled=${dspProfile.headroom_enabled})`;
        }
      } catch (e) {
        dspDiag = `error: ${e.message}`;
      }
    }
    console.log(`[stream] track=${track.id.slice(0, 8)} renderer=${req.query.renderer.slice(0, 12)} dsp: ${dspDiag}`);
  } else {
    dspDiag = 'no renderer in query';
  }

  // Probe source for ground-truth sample rate (used by both downsample
  // planning and FIR rate matching).
  const probed = await probe(track.path).catch(() => null);
  const sourceRate = isDSD ? DSD_TARGET_RATE : (probed?.sampleRate || track.sample_rate || null);

  // FIR convolution selection (#29.1).
  // A renderer with conv_enabled=true and an IR matching the *source rate*
  // gets convolution applied. We deliberately don't substitute IRs across
  // rates — see fir.selectIrForRate for rationale.
  let firInfo = null;
  if (dspApplied && dspProfile?.master_enabled && dspProfile?.conv_enabled) {
    const ir = fir.selectIrForRate(req.query.renderer, sourceRate);
    if (ir) {
      firInfo = {
        ...ir,
        dryDb: dspProfile.conv_dry_db ?? -120,
        wetDb: dspProfile.conv_wet_db ?? 0,
      };
    } else if (sourceRate) {
      // Convolution requested but no rate-matched IR available. Note in headers
      // and skip — playback continues without conv rather than failing.
      res.setHeader('X-Musicd-FIR-Skipped', `no IR for ${sourceRate} Hz`);
    }
  }

  // Renderer-aware downsampling.
  let downsamplePlan = null;
  if (req.query.renderer) {
    try {
      const r = renderers.getRenderer(req.query.renderer);
      downsamplePlan = planDownsample(sourceRate, r?.capabilities);
    } catch (e) { /* non-fatal — proceed without downsample */ }
  }

  // Native pass-through path: only when no VL, no DSD, no renderer-driven
  // downsample, no DSP, no FIR, and renderer-friendly format.
  const canPassThrough = !gainInfo && !isDSD && !downsamplePlan && !dspApplied && !firInfo && (isFlac || isMp3 || isWav);
  if (canPassThrough) {
    const totalSize = track.file_size;
    const contentType = isFlac ? 'audio/flac' : isMp3 ? 'audio/mpeg' : 'audio/wav';

    // Honour Range requests properly. Earlier versions advertised
    // Accept-Ranges but ignored the Range header, so a renderer asking
    // for byte N got bytes 0..end. Symptoms ranged from "playback
    // restarts" to "playback stuck buffering" depending on the
    // renderer's tolerance for unexpected offsets.
    const rangeHeader = req.headers.range;
    if (rangeHeader && totalSize) {
      const m = /^bytes=(\d+)-(\d+)?$/.exec(rangeHeader);
      if (m) {
        const start = parseInt(m[1], 10);
        const end = m[2] ? parseInt(m[2], 10) : totalSize - 1;
        if (start >= totalSize || end >= totalSize || start > end) {
          res.status(416).setHeader('Content-Range', `bytes */${totalSize}`).end();
          return;
        }
        res.status(206);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Length', end - start + 1);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
        if (dspDiag) res.setHeader('X-Musicd-DSP-Diag', safeHeader(dspDiag));
        return fs.createReadStream(track.path, { start, end }).pipe(res);
      }
      // Unparseable Range header — fall through to full content below.
    }

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Content-Type', contentType);
    if (totalSize) res.setHeader('Content-Length', totalSize);
    if (dspDiag) res.setHeader('X-Musicd-DSP-Diag', safeHeader(dspDiag));
    return fs.createReadStream(track.path).pipe(res);
  }

  // Re-encode pipeline.
  //
  // Range requests against re-encoded streams are awkward: the response
  // is generated on-the-fly by ffmpeg, so we don't know the byte offset
  // for any given playback position without re-encoding the whole
  // prefix. Strategy:
  //   - Range: bytes=0-* (or unspecified end) -> treat as full GET.
  //     Renderer is just probing or starting fresh.
  //   - Range: bytes=N-* with N>0 -> reply 416 so the renderer falls
  //     back to a fresh GET. Most modern renderers handle this
  //     gracefully (Sonos, BubbleUPnP, WiiM all retry without Range).
  //   - No Range header -> normal full-stream response.
  //
  // The pre-v47 behaviour silently ignored Range headers, which made
  // some renderers either stall (waiting for byte N to arrive) or
  // misinterpret the resulting 0-byte-offset stream as track restart.
  const reRange = req.headers.range;
  if (reRange) {
    const m = /^bytes=(\d+)-(\d+)?$/.exec(reRange);
    if (m && parseInt(m[1], 10) > 0) {
      // Non-zero start: we cannot serve this from a live encode.
      res.status(416).setHeader('Content-Range', 'bytes */*').end();
      return;
    }
    // Range bytes=0- (no end specified) -> fall through to full-stream
    // response. Renderer gets what it asked for, just continuing past
    // its specified end. The HTTP/1.1 spec allows the server to ignore
    // a Range it can't satisfy and return 200 with the full entity, so
    // this is correct behaviour rather than a workaround.
    //
    // Suffix Range (`bytes=-N`) and explicit Range (`bytes=0-N`) are
    // also handled by this fall-through. In practice no DLNA / Sonos /
    // Squeezelite renderer issues these against a live stream.
  }

  res.removeHeader('Accept-Ranges');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Content-Type', 'audio/flac');
  res.setHeader('Transfer-Encoding', 'chunked');
  if (gainInfo) {
    res.setHeader('X-Musicd-Gain-Db', safeHeader(gainInfo.gain.toFixed(2)));
    res.setHeader('X-Musicd-Source-Lufs', safeHeader(gainInfo.measuredLufs.toFixed(2)));
    res.setHeader('X-Musicd-VL-Mode', safeHeader(gainInfo.mode));
  }
  res.setHeader('X-Musicd-Output-BitDepth', '24');
  if (isDSD) res.setHeader('X-Musicd-Output-Rate', String(DSD_TARGET_RATE));
  if (downsamplePlan) res.setHeader('X-Musicd-Output-Rate', String(downsamplePlan.targetRate));
  if (dspApplied) res.setHeader('X-Musicd-DSP', safeHeader(dspChain.summary.join(' | ')));
  if (dspDiag) res.setHeader('X-Musicd-DSP-Diag', safeHeader(dspDiag));
  if (firInfo) res.setHeader('X-Musicd-FIR', safeHeader(`${firInfo.sampleRate} Hz`));

  let cmd = ffmpeg(track.path);
  if (isDSD) cmd = cmd.inputOptions(['-f', ext === '.dsf' ? 'dsf' : 'dsd_lsbf_planar']);

  // Build the filter chain. The FIR path uses filter_complex (afir is a
  // dual-input filter); without FIR we use the simpler single-input -af
  // chain. Same audible result either way — afir is the only piece that
  // forces complexFilter mode.
  if (firInfo) {
    cmd = cmd.input(firInfo.path);

    // Build pre-conv stage: everything that should run BEFORE convolution.
    //   DSD resample → aformat float → VL gain → auto-preamp + PEQ
    // Crossfeed and downsample run AFTER convolution.
    const preFilters = [];
    if (isDSD) preFilters.push(`aresample=${DSD_TARGET_RATE}:resampler=swr`);
    preFilters.push('aformat=sample_fmts=dbl');
    if (gainInfo) preFilters.push(`volume=${gainInfo.gain.toFixed(3)}dB:precision=double`);

    // Split DSP filters: auto-preamp volume + PEQ go pre-conv; crossfeed goes
    // post-conv. dspChain.filters is in chain order: volume, peq filters,
    // bs2b. We pull bs2b out and put it after the convolution.
    const preDspFilters = [];
    const postDspFilters = [];
    if (dspApplied) {
      for (const f of dspChain.filters) {
        if (f.startsWith('bs2b')) postDspFilters.push(f);
        else preDspFilters.push(f);
      }
    }
    for (const f of preDspFilters) preFilters.push(f);

    // Headroom (v1.1.0.53; v1.1.0.75 placement change).
    // v53 placed headroom between PEQ output and FIR input — that
    // was reserving margin for FIR boost. v75 moves it to the END
    // of the chain (before the bit-narrow aresample), framing it
    // instead as "guard band before quantisation." This matches
    // the user's mental model: float-64 → headroom → bit convert.
    //
    // VL collision: when Volume Levelling is on AND has a measured
    // gain for this track, the stream is already being attenuated
    // to a LUFS target. Stacking headroom on top would over-
    // attenuate. We suppress headroom in that case and log the
    // override so it's visible in the journal.
    let headroomDbForStream = 0;
    if (dspApplied && dspChain.headroomDb && dspChain.headroomDb < 0) {
      if (gainInfo) {
        console.log(`[stream] headroom ${dspChain.headroomDb.toFixed(1)} dB suppressed (VL active for this track)`);
      } else {
        headroomDbForStream = dspChain.headroomDb;
      }
    }

    // Convolution must see stereo input (afir requires matching channel
    // count between input and IR). If the source is mono and the IR is
    // stereo, afir will fail. Force stereo before afir to dodge this.
    preFilters.push('aformat=channel_layouts=stereo');

    const postFilters = [];
    for (const f of postDspFilters) postFilters.push(f);
    if (downsamplePlan) {
      postFilters.push(`aresample=${downsamplePlan.targetRate}:resampler=swr`);
    }
    // v1.1.0.75: headroom slots in here, after all DSP and any rate
    // conversion but before bit-narrow. Always negative — it's
    // attenuation, never boost.
    if (headroomDbForStream < 0) {
      postFilters.push(`volume=${headroomDbForStream.toFixed(3)}dB:precision=double`);
    }
    // Bit depth: 16-bit dither for Sonos override, 24-bit otherwise.
    // s16 with TPDF dither is the canonical 16-bit endpoint (#v1.1.0.8).
    if (force16bit) {
      postFilters.push('aresample=osf=s16:dither_method=triangular');
    } else {
      postFilters.push('aresample=osf=s32:dither_method=triangular');
    }

    // Build filter_complex graph. afir takes [src][ir] and produces [conv].
    //   dry/wet in dB, length=1 means use the entire IR (in seconds), gtype=fft
    //   for partitioned FFT convolution (cheap and accurate for ≤ 1s IRs).
    const dryDb = Number(firInfo.dryDb).toFixed(2);
    const wetDb = Number(firInfo.wetDb).toFixed(2);
    const preChain  = preFilters.join(',');
    const postChain = postFilters.join(',');
    const filterComplex =
      `[0:a]${preChain}[pre];` +
      `[pre][1:a]afir=dry=${dryDb}:wet=${wetDb}:length=1:gtype=fft[conv];` +
      `[conv]${postChain}[out]`;

    cmd
      .complexFilter(filterComplex, ['out'])
      .outputOptions([
        '-map_metadata', '-1',
        '-bits_per_raw_sample', force16bit ? '16' : '24',
        '-frame_size', '1024',
        '-flush_packets', '1',
        '-compression_level', '0',
      ])
      .audioCodec('flac')
      .format('flac')
      .on('start', (cl) => console.log(`[stream] ffmpeg (FIR) cmd: ${cl}`))
      .on('stderr', (line) => {
        if (line && !/^(size=|frame=|stream_|input #|output #)/i.test(line)) {
          console.log(`[stream] ffmpeg (FIR): ${line}`);
        }
      })
      .on('error', (err) => {
        console.error(`[stream] ffmpeg (FIR) error: ${err.message}`);
        if (!res.headersSent) res.status(500).json({ error: err.message });
        else { try { res.end(); } catch {} }
      })
      .pipe(res, { end: true });
    return;
  }

  // Non-FIR path: simple audio filter list.
  const filters = [];
  if (isDSD) {
    filters.push(`aresample=${DSD_TARGET_RATE}:resampler=swr`);
  }
  filters.push('aformat=sample_fmts=dbl');
  if (gainInfo) filters.push(`volume=${gainInfo.gain.toFixed(3)}dB:precision=double`);

  if (dspApplied && dspChain.filters.length > 0) {
    for (const f of dspChain.filters) filters.push(f);
  }

  if (downsamplePlan) {
    filters.push(`aresample=${downsamplePlan.targetRate}:resampler=swr`);
  }

  // Headroom (v1.1.0.75). End-of-chain attenuation before bit-narrow,
  // applied whenever the user has the toggle on. Suppressed when VL
  // is active for this track to avoid double-attenuation. The same
  // logic lives in the FIR path above; keep the two in sync if you
  // change one.
  if (dspApplied && dspChain.headroomDb && dspChain.headroomDb < 0) {
    if (gainInfo) {
      console.log(`[stream] headroom ${dspChain.headroomDb.toFixed(1)} dB suppressed (VL active for this track)`);
    } else {
      filters.push(`volume=${dspChain.headroomDb.toFixed(3)}dB:precision=double`);
    }
  }

  // Bit depth: 16-bit with dither for Sonos override, 24-bit otherwise
  // (#v1.1.0.8).
  if (force16bit) {
    filters.push('aresample=osf=s16:dither_method=triangular');
  } else {
    filters.push('aresample=osf=s32:dither_method=triangular');
  }

  cmd.audioFilters(filters)
    .outputOptions([
      '-map_metadata', '-1',
      '-bits_per_raw_sample', force16bit ? '16' : '24',
      // Streaming-friendly FLAC encoding (#29.4). Some DLNA renderers
      // (WiiM Pro Plus, Mojo via certain bridges) appear to interpret long
      // pauses in chunked-encoded stream data as track-end. Two changes
      // help:
      //   -frame_size 1024:    small FLAC blocks, ~21 ms at 48 kHz, so
      //                        bytes flow continuously rather than in big
      //                        infrequent chunks.
      //   -flush_packets 1:    ffmpeg pushes each encoded packet to stdout
      //                        immediately rather than buffering. Crucial
      //                        for low-latency streaming over chunked HTTP.
      //   -compression_level 0: fastest FLAC encode (cost: ~10% larger
      //                        files, but the renderer doesn't see file
      //                        size for chunked streams).
      '-frame_size', '1024',
      '-flush_packets', '1',
      '-compression_level', '0',
    ])
    .audioCodec('flac')
    .format('flac')
    .on('start', (cl) => console.log(`[stream] ffmpeg cmd: ${cl}`))
    .on('stderr', (line) => {
      // Surface non-trivial ffmpeg stderr so playback errors are diagnosable.
      // We filter out normal "size= ... bitrate= ..." progress noise.
      if (line && !/^(size=|frame=|stream_|input #|output #)/i.test(line)) {
        console.log(`[stream] ffmpeg: ${line}`);
      }
    })
    .on('error', (err) => {
      console.error(`[stream] ffmpeg error: ${err.message}`);
      if (!res.headersSent) res.status(500).json({ error: err.message });
      else { try { res.end(); } catch {} }
    })
    .pipe(res, { end: true });
});

module.exports = router;
