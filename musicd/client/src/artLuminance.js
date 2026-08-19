// How bright is the album art where the share button sits?
//
// The button is pinned to the bottom-right of the cover. A single translucent
// dark chip disappears into dark artwork; a single light one disappears into a
// bright sleeve. There is no one colour that works against arbitrary album
// covers, so the button samples the corner it actually sits on and takes the
// opposite palette.
//
// Only the corner, not the whole cover: the button has to contrast with what
// is directly behind it. A sleeve that is mostly black with a white corner
// would pick the wrong palette on a whole-image average — which is the case
// this exists to get right.
//
// The maths lives here rather than in the component so it can be tested
// without a canvas, the same reason queueFold.js and scrollRestore.js are
// their own modules.

// sRGB channel (0-255) to its linear-light value.
//
// The naive 0.299R + 0.587G + 0.114B weighting operates on gamma-encoded
// values and gets mid-tones noticeably wrong — it reads a saturated yellow as
// darker than it looks, which is exactly the sleeve in the report.
function channelToLinear(c) {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

// WCAG relative luminance, 0 (black) to 1 (white).
export function relativeLuminance(r, g, b) {
  return 0.2126 * channelToLinear(r) +
         0.7152 * channelToLinear(g) +
         0.0722 * channelToLinear(b)
}

// Mean relative luminance of an RGBA buffer, as produced by
// CanvasRenderingContext2D.getImageData().
//
// Fully transparent pixels are ignored rather than counted as black: a cover
// with a transparent corner sits on the page behind it, which is dark, and
// counting those as black happens to give the right answer — but counting a
// transparent pixel over LIGHT art would not, and the caller knows which.
// Returns null for an empty or fully transparent sample so the caller can keep
// whatever it had rather than act on nothing.
export function meanLuminance(rgba) {
  if (!rgba || rgba.length < 4) return null
  let sum = 0
  let n = 0
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3]
    if (a === 0) continue
    sum += relativeLuminance(rgba[i], rgba[i + 1], rgba[i + 2])
    n++
  }
  return n === 0 ? null : sum / n
}

// Above this the art is "light" and the button goes dark.
//
// 0.5 in linear-light terms, not in 0-255 terms: mid-grey #808080 has a
// relative luminance of about 0.216, so a threshold of 0.5 sits well above
// mid-grey and only genuinely bright artwork flips the button. That is the
// right bias — the dark chip is the established look, and it should give way
// only when it would actually disappear.
export const LIGHT_THRESHOLD = 0.5

// True when the sampled region is light enough that the button needs the dark
// palette. Falsy input keeps the dark default.
export function isLightSample(rgba) {
  const mean = meanLuminance(rgba)
  return mean === null ? false : mean > LIGHT_THRESHOLD
}

// The corner of an image the button covers, as a source-pixel rectangle.
//
// Expressed as a fraction so it holds whatever size the cover is decoded at.
// A quarter of each edge is a little larger than the button itself, which is
// deliberate: a chip that contrasts with only the pixels directly under it,
// against a corner that changes sharply just outside it, still reads as lost.
export const CORNER_FRACTION = 0.25

export function cornerRect(width, height, fraction = CORNER_FRACTION) {
  const w = Math.max(1, Math.round(width * fraction))
  const h = Math.max(1, Math.round(height * fraction))
  return { x: Math.max(0, width - w), y: Math.max(0, height - h), w, h }
}
