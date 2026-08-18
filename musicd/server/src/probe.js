/**
 * Audio stream probing — uses ffprobe to read the actual properties of a media
 * file, independent of whatever the music-metadata library tagged at scan time.
 *
 * This module exists because the database-stored sample rate / bit depth / format
 * can be wrong: some files (notably DSD-sourced FLACs and oddly-tagged content)
 * carry metadata that doesn't match the actual decoded stream. The signal path
 * needs to display ground truth, not stale metadata.
 *
 * Cached in-memory by file path + mtime. Probe cost is ~30–80ms per file.
 */
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const cache = new Map();
const MAX_CACHE = 1024;

/**
 * Probe a media file. Returns:
 *  {
 *    ok: true,
 *    container: 'flac' | 'mp3' | 'dsf' | 'wav' | ...,
 *    codec: 'flac' | 'mp3' | 'dsd_lsbf_planar' | ...,
 *    sampleRate: 44100,           // Hz, decoded PCM rate
 *    bitDepth: 16 | 24 | 32 | null,
 *    channels: 2,
 *    bitrate: 856000,             // bps, may be null for VBR/lossless
 *    isDSD: boolean,              // true if the codec is one of ffmpeg's DSD variants
 *    dsdRate: 2822400 | null,     // 1-bit DSD bitrate when isDSD; null otherwise
 *    durationSec: number | null,
 *  }
 *
 *  or { ok: false, error: '...' } on failure.
 */
function probe(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return Promise.resolve({ ok: false, error: 'File not found' });
  }
  let mtime;
  try { mtime = fs.statSync(filePath).mtimeMs; } catch { mtime = 0; }
  const cacheKey = `${filePath}:${mtime}`;
  if (cache.has(cacheKey)) return Promise.resolve(cache.get(cacheKey));

  return new Promise((resolve) => {
    execFile('ffprobe', [
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_name,sample_rate,sample_fmt,bits_per_raw_sample,bits_per_sample,channels,bit_rate,duration:format=format_name,duration,bit_rate',
      '-of', 'json',
      filePath,
    ], { timeout: 6000, maxBuffer: 256 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const result = { ok: false, error: (stderr || err.message || '').trim().slice(0, 200) };
        return resolve(result);
      }
      try {
        const j = JSON.parse(stdout);
        const stream = (j.streams || [])[0] || {};
        const fmt = j.format || {};
        const codec = stream.codec_name || '';
        const isDSD = /dsd/i.test(codec);

        // For DSD codecs, ffprobe reports the 1-bit bitstream rate as sample_rate.
        // The decoded PCM rate is what we care about for the signal path. ffmpeg's
        // built-in DSD decoder decimates by 8 (default).
        const reportedRate = parseInt(stream.sample_rate || '0', 10) || null;
        const dsdRate = isDSD ? reportedRate : null;
        const decodedRate = isDSD && reportedRate ? Math.round(reportedRate / 8) : reportedRate;

        // Bit depth: bits_per_raw_sample is most accurate when present, else
        // bits_per_sample, else infer from sample_fmt.
        let bitDepth = parseInt(stream.bits_per_raw_sample || '0', 10) ||
                       parseInt(stream.bits_per_sample || '0', 10) || null;
        if (!bitDepth && stream.sample_fmt) {
          const sf = stream.sample_fmt;
          if (/^s16/.test(sf)) bitDepth = 16;
          else if (/^s32/.test(sf)) bitDepth = 32;
          else if (/^flt/.test(sf)) bitDepth = 32;     // float
          else if (/^dbl/.test(sf)) bitDepth = 64;
          else if (/^u8/.test(sf)) bitDepth = 8;
        }
        if (isDSD) bitDepth = 1; // DSD is a 1-bit format by definition

        const result = {
          ok: true,
          container: (fmt.format_name || '').split(',')[0] || null,
          codec,
          sampleRate: decodedRate,
          bitDepth,
          channels: parseInt(stream.channels || '0', 10) || null,
          bitrate: parseInt(stream.bit_rate || fmt.bit_rate || '0', 10) || null,
          isDSD,
          dsdRate,
          durationSec: parseFloat(stream.duration || fmt.duration || '0') || null,
        };
        // Trim cache
        if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
        cache.set(cacheKey, result);
        resolve(result);
      } catch (e) {
        resolve({ ok: false, error: 'ffprobe parse error: ' + e.message });
      }
    });
  });
}

function clearCache() { cache.clear(); }

module.exports = { probe, clearCache };
