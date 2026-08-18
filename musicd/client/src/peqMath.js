// Client-side biquad / PEQ math (#29.2)
// =======================================
// Mirror of the server's biquad magnitude calculation in dsp/index.js. We
// duplicate it on the client so slider drags produce instant graph updates
// without server round-trips. The two implementations stay in sync because
// the same approximation formulas are used both sides — see the server file
// for the analytic rationale.
//
// IMPORTANT: This is NOT used for audio rendering — audio still flows through
// ffmpeg's `equalizer`/`bass`/`treble` filters on the server. This file
// exists purely for graph display + auto-preamp preview.

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
}

// Magnitude response in dB at frequency `freq` Hz for a single biquad.
// Same approximation as the server: octave-distance gaussian for peaking,
// log-frequency sigmoid for shelves. Accurate enough for graphing and
// preamp peak search; not sample-accurate (we don't need it to be — ffmpeg
// is the actual filter).
export function biquadMagnitudeDb(filter, freq) {
  const type = FILTER_TYPE_MAP[String(filter.type || 'PK').toUpperCase()] || 'peaking'
  const fc   = Number(filter.fc) || 1000
  const q    = Number(filter.q)  || 0.707
  const gain = Number(filter.gain) || 0
  if (gain === 0) return 0

  if (type === 'peaking') {
    const distance = Math.log2(Math.max(freq, 1) / Math.max(fc, 1))
    const bandwidth = 1 / q
    const falloff = Math.exp(-2 * Math.pow(distance / bandwidth, 2))
    return gain * falloff
  }
  if (type === 'lowshelf') {
    const distance = Math.log2(Math.max(freq, 1) / Math.max(fc, 1))
    const blend = 1 / (1 + Math.exp(distance * 4 * q))
    return gain * blend
  }
  if (type === 'highshelf') {
    const distance = Math.log2(Math.max(freq, 1) / Math.max(fc, 1))
    const blend = 1 / (1 + Math.exp(-distance * 4 * q))
    return gain * blend
  }
  return 0
}

// Sample the chain's combined magnitude across the audible band. Returns
// arrays suitable for SVG polyline plotting.
export function magnitudeResponse(filters, points = 121) {
  const freqs = new Array(points)
  const gains = new Array(points)
  const perFilter = filters?.map(() => new Array(points)) || []
  for (let i = 0; i < points; i++) {
    const f = 20 * Math.pow(10, (Math.log10(20000) - Math.log10(20)) * (i / (points - 1)))
    let sum = 0
    if (filters) {
      for (let fi = 0; fi < filters.length; fi++) {
        const g = biquadMagnitudeDb(filters[fi], f)
        perFilter[fi][i] = g
        sum += g
      }
    }
    freqs[i] = f
    gains[i] = sum
  }
  return { freqs, gains, perFilter }
}

// Peak gain across the audible band — same logic as server. Used to compute
// the auto-preamp the server WILL set on save, so the UI can show it before
// the user commits.
export function calculatePeakGain(filters) {
  if (!filters || filters.length === 0) return 0
  let peak = 0
  const points = 61
  for (let i = 0; i < points; i++) {
    const f = 20 * Math.pow(10, (Math.log10(20000) - Math.log10(20)) * (i / (points - 1)))
    let sum = 0
    for (const filt of filters) sum += biquadMagnitudeDb(filt, f)
    if (sum > peak) peak = sum
  }
  return peak
}
