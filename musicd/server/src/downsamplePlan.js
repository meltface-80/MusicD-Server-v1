/**
 * Renderer-aware sample-rate planning.
 *
 * Some renderers (notably Sonos S2) cap incoming streams at 48 kHz / 24-bit.
 * For tracks above that ceiling we have to downsample server-side; the question
 * is "to what target rate?".
 *
 * Audio engineers care about staying within the source's sample-rate family
 * to keep the rate-conversion ratio a clean integer:
 *
 *   44.1 family:  44.1, 88.2, 176.4, 352.8   →  44.1 kHz target
 *   48   family:  48,   96,   192,   384     →  48   kHz target
 *
 * Cross-family conversions (e.g. 96 → 44.1) introduce non-integer ratios that
 * audibly degrade SRC quality, so we never do them. If the source rate isn't
 * a 44.1 or 48 multiple (rare — DSD-decoded PCM lands at 176.4, etc.), we
 * pick the closest family by integer division.
 *
 * The whole stream pipeline runs in 64-bit float internally before the final
 * narrowing to 24-bit integer with TPDF dither (see stream.js); resampling
 * happens in that float domain.
 */

/**
 * Given a source sample rate (Hz) and a renderer's capabilities, return either
 * `null` (no resample needed) or a plan describing the target rate and the
 * sample-rate family preserved.
 *
 * @param {number|null} sourceRate     Source PCM rate in Hz (e.g. 96000)
 * @param {object}      capabilities   { maxSampleRate?: number }
 * @returns {{ targetRate: number, family: '44.1k'|'48k', sourceRate: number }|null}
 */
function planDownsample(sourceRate, capabilities) {
  if (!sourceRate) return null;
  const cap = capabilities && capabilities.maxSampleRate;
  if (!cap || sourceRate <= cap) return null;

  // Family detection: integer multiple of 44100 or 48000 wins.
  const is441Family = sourceRate % 44100 === 0;
  const is48Family  = sourceRate % 48000 === 0;
  let family, baseRate;
  if (is441Family && !is48Family) { family = '44.1k'; baseRate = 44100; }
  else if (is48Family && !is441Family) { family = '48k'; baseRate = 48000; }
  else {
    // Ambiguous (only 8000) or non-standard. Pick the family whose base rate
    // gives the smaller resample ratio so we stay closer to source.
    const r441 = sourceRate / 44100;
    const r48  = sourceRate / 48000;
    if (Math.abs(r441 - Math.round(r441)) < Math.abs(r48 - Math.round(r48))) {
      family = '44.1k'; baseRate = 44100;
    } else {
      family = '48k';   baseRate = 48000;
    }
  }

  // Target = highest multiple of baseRate not exceeding the renderer cap.
  // For the typical Sonos cap of 48000 this is just baseRate itself.
  const multiplier = Math.max(1, Math.floor(cap / baseRate));
  const targetRate = baseRate * multiplier;
  return { targetRate, family, sourceRate };
}

module.exports = { planDownsample };
