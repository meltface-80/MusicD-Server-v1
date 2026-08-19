/**
 * Generate a landscape PNG share card for an album.
 *
 * Server-side port of the MusicD-Remote browser card
 * (musicd-remote/public/sharecard.js), which draws the same design with
 * canvas 2D. There is no canvas here: the whole design is emitted as one SVG
 * overlay that sharp rasterises on top of the composited album art.
 *
 * Layout (1200 × 600, fixed):
 *   ┌─────────────────────┬─────────────────────────────┐
 *   │                     │                             │
 *   │                     │   RELEASED 2009             │
 *   │  album art 600×600  │   Album Title               │
 *   │  (full bleed left)  │   (wraps up to 4)           │
 *   │                     │   by Artist Name            │
 *   │                     │                             │
 *   │                     │                    MusicD   │
 *   └─────────────────────┴─────────────────────────────┘
 *
 * Art fills the entire left half edge-to-edge, centre-cropped to a square.
 * Release date, title and artist form a single block, vertically centred in
 * the right half (nudged 10px up — optical centre sits above the maths).
 * The wordmark is pinned to the bottom-right corner.
 */
const sharp = require('sharp');
const db = require('./db');

// ── Geometry ────────────────────────────────────────────────────────────────
const CARD_W = 1200, CARD_H = 600;
const ART_W = 600, ART_H = 600;          // art fills the left half exactly
const DIVIDER = 40;                      // gap between art edge and text start
const TEXT_X = ART_W + DIVIDER;          // 640
const TEXT_PAD_R = 48;
const TEXT_W = CARD_W - TEXT_X - TEXT_PAD_R;   // 512px text column
const FADE_W = 40;                       // width of the fade over the art edge
const WORDMARK_PAD = 36;                 // wordmark inset from the bottom-right corner
const TOP_SAFE_Y = 40;                   // block never rides above this line

// ── Colours (identical to the browser card) ─────────────────────────────────
const COL_BG = '#0e1012';                // card background / right half
const COL_ART_EMPTY = '#1a1a1a';         // plate shown when there is no cover
const COL_META = '#7f868d';              // "RELEASED …" eyebrow
const COL_TITLE = '#ffffff';
const COL_ARTIST = '#c0c6cc';

// The browser card asks for "Manrope", sans-serif — a webfont that does not
// exist in the server container. librsvg fails silently when a family is
// missing (worst case it draws tofu boxes), so name the family the runtime
// image actually installs (fonts-dejavu-core) and keep a generic fallback.
const FONT_FAMILY = 'DejaVu Sans, sans-serif';

// ── Typography — sizes, weights and line-height ratios from the browser card ─
const META_SIZE = 26;
const META_WEIGHT = 600;
const META_H = META_SIZE + 4;            // eyebrow occupies size + 4px
const META_GAP = 24;                     // gap below the eyebrow
const BLOCK_GAP = 18;                    // gap between title and artist

// Title and artist are adaptive: up to 4 lines each, stepping the font size
// down until the text fits (56→27px title, 37→21px artist); only when even the
// smallest size overflows is the last line ellipsized. Worst case
// (meta + 4 title lines @27 + 4 artist lines @21 ≈ 355px) fits the 600px card.
const TITLE_WEIGHT = 700;
const TITLE_SIZES = [56, 48, 42, 36, 31, 27];
const TITLE_LH_RATIO = 68 / 56;
const TITLE_MAX_LINES = 4;
const ARTIST_WEIGHT = 400;
const ARTIST_SIZES = [37, 32, 28, 24, 21];
const ARTIST_LH_RATIO = 48 / 37;
const ARTIST_MAX_LINES = 4;

// The browser card draws with textBaseline='top'; SVG places <text> on its
// baseline. Push every line down by this fraction of its font size so a line
// laid out at top y lands where canvas would have put it.
const BASELINE_RATIO = 0.8;

// v1.1.5.0 — the mark is the MusicD logo lockup: the "MusicD" wordmark with
// the waveform beneath it. Drawn as vector — text plus rounded bars — rather
// than an embedded bitmap, so it stays crisp at any card size and the card
// remains a single self-contained SVG that sharp can rasterise.
//
// Authored in a 100 x 54 unit box and scaled to LOCKUP_W on the card, so the
// proportions are fixed and only one number moves it. The waveform is
// symmetric about its axis and carries the thin tails that run out to either
// side in the artwork.
const WORDMARK_OPACITY = 0.88;

// Unit box.
const LOCKUP_UW = 100, LOCKUP_UH = 54;
// Drawn width on the card; height follows from the box ratio.
const LOCKUP_W = 176;

// Wordmark: centred, sitting above the waveform. "MusicD" has no descenders,
// so its baseline is also its visual bottom.
const LOCKUP_TEXT = 'MusicD';
const LOCKUP_TEXT_SIZE = 31;
const LOCKUP_TEXT_BASELINE = 30;

// Waveform: axis, horizontal extent, bar geometry.
const WAVE_AXIS_Y = 46;
const WAVE_X0 = 7, WAVE_X1 = 93;
const WAVE_BAR_W = 0.9;
const WAVE_MAX_HALF = 10.5;       // half-height of the tallest bar
const WAVE_TAIL_X0 = 1, WAVE_TAIL_X1 = 99;
const WAVE_TAIL_THICK = 0.55;

// Bar half-heights, 0..1 of WAVE_MAX_HALF. Hand-authored to match the
// artwork's rhythm: short at the ends, dense variation through the middle,
// with a handful of full-height spikes.
// The floor is deliberately well above zero: in the artwork the waveform
// reads as a continuous band with spikes out of it, not as scattered ticks.
const WAVE_BARS = [
  0.26, 0.34, 0.28, 0.52, 0.40, 0.64, 0.48, 0.78, 0.56, 0.94,
  0.46, 0.72, 0.38, 0.62, 0.50, 0.84, 0.58, 0.42, 0.68, 1.00,
  0.52, 0.36, 0.46, 0.32, 0.42, 0.60, 0.38, 0.50, 0.74, 0.44,
  0.90, 0.48, 0.34, 0.64, 0.46, 0.80, 0.40, 0.96, 0.54, 0.38,
  0.68, 0.46, 0.86, 0.42, 0.60, 0.34, 0.50, 0.30, 0.38, 0.26,
];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function escXml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Accepts YYYY-MM-DD, YYYY-MM, YYYY (the albums table stores a bare year, but
// richer values survive if the schema ever grows one). Anything unrecognised is
// passed through verbatim; empty input yields null so the eyebrow is dropped.
function formatReleaseDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${d} ${MONTHS[mo - 1]} ${y}`;
  }
  m = s.match(/^(\d{4})-(\d{1,2})$/);
  if (m) { const mo = +m[2]; if (mo >= 1 && mo <= 12) return `${MONTHS[mo - 1]} ${m[1]}`; }
  m = s.match(/^(\d{4})$/);
  if (m) return m[1];
  return s;
}

// ── Text measurement ────────────────────────────────────────────────────────
// The browser card measures with ctx.measureText(); nothing equivalent exists
// here, so approximate the advance width per character class. The em values
// below come from DejaVu Sans (the family the runtime image installs), rounded
// up slightly so the estimate never lands under the true width — erring wide
// wraps or shrinks one step early instead of overrunning the right edge.
// Against a corpus of real album titles the estimate measures 1.00–1.09× true.
const NARROW_CHARS = "ijltfrI.,;:'\"!|()[]{}/\\-";
const WIDE_CHARS = 'mwMW@%';

function measureText(text, fontSizePx, weight) {
  const bold = weight >= 600;   // DejaVu ships Book and Bold; 600+ resolves to Bold
  let em = 0;
  for (const ch of String(text ?? '')) {
    if (ch === ' ') em += bold ? 0.35 : 0.32;
    else if (NARROW_CHARS.includes(ch)) em += bold ? 0.44 : 0.38;
    else if (WIDE_CHARS.includes(ch)) em += bold ? 1.10 : 1.00;
    else if (ch >= 'A' && ch <= 'Z') em += bold ? 0.80 : 0.72;
    else em += bold ? 0.70 : 0.63;
  }
  return em * fontSizePx;
}

// Word-wrap text to maxWidth. Returns { lines, overflow } — overflow is true
// when the text didn't fully fit in maxLines (or a single word is wider than
// the column). Ellipsis is NOT applied here: fitText() first tries smaller
// font sizes and only ellipsizes as the final fallback.
function wrapText(text, fontSizePx, weight, maxWidth, maxLines) {
  if (!text) return { lines: [], overflow: false };
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  let overflow = false;
  for (const w of words) {
    const candidate = cur ? cur + ' ' + w : w;
    if (measureText(candidate, fontSizePx, weight) <= maxWidth) {
      cur = candidate;
    } else {
      if (cur) lines.push(cur);
      if (lines.length >= maxLines) { cur = ''; overflow = true; break; }
      cur = w;
      if (measureText(w, fontSizePx, weight) > maxWidth) overflow = true;  // single over-wide word
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  else if (cur) overflow = true;
  return { lines, overflow };
}

// Fit text into maxLines within maxWidth by stepping the font size down until
// it fits; only when even the smallest size overflows is the last line
// ellipsized. Returns { lines, size, lh } for the chosen size.
function fitText(text, maxWidth, maxLines, weight, sizes, lhRatio) {
  let r = { lines: [], overflow: false };
  let size = sizes[0];
  for (const s of sizes) {
    size = s;
    r = wrapText(text, s, weight, maxWidth, maxLines);
    if (!r.overflow) break;
  }
  if (r.overflow && r.lines.length) {
    // Final fallback at the smallest size: trim the last line to an ellipsis.
    let last = r.lines[r.lines.length - 1];
    while (last.length && measureText(last + '…', size, weight) > maxWidth) last = last.slice(0, -1);
    r.lines[r.lines.length - 1] = last.replace(/\s+$/, '') + '…';
  }
  return { lines: r.lines, size, lh: Math.round(size * lhRatio) };
}

// One <text> per line. font-size is a presentation attribute rather than part
// of the CSS class because fitText() picks it per block, and a class rule would
// win over the attribute in the cascade.
function textLines(lines, topY, lineH, fontSize, cls) {
  return lines.map((line, i) =>
    `<text x="${TEXT_X}" y="${topY + i * lineH + Math.round(fontSize * BASELINE_RATIO)}"` +
    ` font-size="${fontSize}" class="${cls}">${escXml(line)}</text>`
  ).join('\n    ');
}

async function generateForAlbum(albumId) {
  const database = db.get();
  const album = database.prepare(`
    SELECT id, title, album_artist, year, cover_art FROM albums WHERE id = ?
  `).get(albumId);
  if (!album) throw new Error('Album not found');

  // ── Album art — centre-cropped square filling the whole left half ─────────
  // A missing or unreadable blob is not fatal: the SVG paints a flat plate in
  // its place, exactly as the browser card does when the image fails to load.
  let artImage = null;
  if (album.cover_art) {
    try {
      artImage = await sharp(Buffer.from(album.cover_art))
        .resize(ART_W, ART_H, { fit: 'cover', position: 'centre' })
        .toBuffer();
    } catch (e) {
      artImage = null;
    }
  }

  // ── Measure text blocks ──────────────────────────────────────────────────
  const releaseStr = formatReleaseDate(album.year);
  const metaText = releaseStr ? ('Released ' + releaseStr).toUpperCase() : null;

  const title = fitText(album.title || '', TEXT_W, TITLE_MAX_LINES, TITLE_WEIGHT, TITLE_SIZES, TITLE_LH_RATIO);
  const titleH = title.lines.length * title.lh;

  // The browser card always prints "by …"; with no album artist there is
  // nothing to print, so drop the line (and its gap) rather than show a lone "by".
  const artistName = (album.album_artist || '').trim();
  const artist = artistName
    ? fitText('by ' + artistName, TEXT_W, ARTIST_MAX_LINES, ARTIST_WEIGHT, ARTIST_SIZES, ARTIST_LH_RATIO)
    : { lines: [], size: ARTIST_SIZES[0], lh: 0 };
  const artistH = artist.lines.length * artist.lh;

  // ── Vertical layout — one block, optically centred in the right half ──────
  const blockH = (metaText ? META_H + META_GAP : 0)
    + titleH
    + (artist.lines.length ? BLOCK_GAP + artistH : 0);
  const metaTopY = Math.max(TOP_SAFE_Y, Math.round((CARD_H - blockH) / 2) - 10);
  const titleTopY = metaTopY + (metaText ? META_H + META_GAP : 0);
  const artistTopY = titleTopY + titleH + BLOCK_GAP;

  const metaSvg = metaText
    ? textLines([metaText], metaTopY, 0, META_SIZE, 'meta')
    : '';
  const titleSvg = textLines(title.lines, titleTopY, title.lh, title.size, 'title');
  const artistSvg = textLines(artist.lines, artistTopY, artist.lh, artist.size, 'artist');

  // Plate under the left half when no cover art was composited beneath.
  const emptyArtSvg = artImage
    ? ''
    : `<rect x="0" y="0" width="${ART_W}" height="${ART_H}" fill="${COL_ART_EMPTY}"/>`;

  // Logo lockup pinned bottom-right, WORDMARK_PAD clear of both edges. The
  // unit box is the drawn extent, so the box corner IS the ink corner.
  const lockupScale = LOCKUP_W / LOCKUP_UW;
  const lockupX = (CARD_W - WORDMARK_PAD) - LOCKUP_UW * lockupScale;
  const lockupY = (CARD_H - WORDMARK_PAD) - LOCKUP_UH * lockupScale;

  // Waveform bars, evenly spaced across the span, each centred on the axis
  // and fully rounded so the caps match the artwork.
  const waveStep = (WAVE_X1 - WAVE_X0) / (WAVE_BARS.length - 1);
  const waveBars = WAVE_BARS.map((amp, i) => {
    const half = Math.max(WAVE_BAR_W / 2, amp * WAVE_MAX_HALF);
    const x = WAVE_X0 + i * waveStep - WAVE_BAR_W / 2;
    return `<rect x="${x.toFixed(2)}" y="${(WAVE_AXIS_Y - half).toFixed(2)}" ` +
           `width="${WAVE_BAR_W}" height="${(half * 2).toFixed(2)}" rx="${WAVE_BAR_W / 2}"/>`;
  }).join('');
  const waveTail =
    `<rect x="${WAVE_TAIL_X0}" y="${(WAVE_AXIS_Y - WAVE_TAIL_THICK / 2).toFixed(2)}" ` +
    `width="${WAVE_TAIL_X1 - WAVE_TAIL_X0}" height="${WAVE_TAIL_THICK}" rx="${WAVE_TAIL_THICK / 2}"/>`;

  const svg = `<svg width="${CARD_W}" height="${CARD_H}" viewBox="0 0 ${CARD_W} ${CARD_H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="artFade" gradientUnits="userSpaceOnUse"
                      x1="${ART_W - FADE_W}" y1="0" x2="${ART_W}" y2="0">
        <stop offset="0" stop-color="${COL_BG}" stop-opacity="0"/>
        <stop offset="1" stop-color="${COL_BG}" stop-opacity="0.55"/>
      </linearGradient>
      <style>
        .meta       { fill: ${COL_META};   font-family: ${FONT_FAMILY}; font-weight: ${META_WEIGHT}; }
        .title      { fill: ${COL_TITLE};  font-family: ${FONT_FAMILY}; font-weight: ${TITLE_WEIGHT}; }
        .artist     { fill: ${COL_ARTIST}; font-family: ${FONT_FAMILY}; font-weight: ${ARTIST_WEIGHT}; }
      </style>
    </defs>
    ${emptyArtSvg}
    <rect x="${ART_W - FADE_W}" y="0" width="${FADE_W}" height="${CARD_H}" fill="url(#artFade)"/>
    ${metaSvg}
    ${titleSvg}
    ${artistSvg}
    <g transform="translate(${lockupX.toFixed(2)} ${lockupY.toFixed(2)}) scale(${lockupScale.toFixed(4)})"
       fill="${COL_TITLE}" opacity="${WORDMARK_OPACITY}">
      <text x="${LOCKUP_UW / 2}" y="${LOCKUP_TEXT_BASELINE}" text-anchor="middle"
            font-family="${FONT_FAMILY}" font-weight="700"
            font-size="${LOCKUP_TEXT_SIZE}" letter-spacing="-0.6">${LOCKUP_TEXT}</text>
      ${waveTail}${waveBars}
    </g>
  </svg>`;

  // Base plate is the card background; art goes under the SVG so the fade
  // gradient and the text land on top of it.
  const layers = [];
  if (artImage) layers.push({ input: artImage, top: 0, left: 0 });
  layers.push({ input: Buffer.from(svg), top: 0, left: 0 });

  const final = await sharp({
    create: { width: CARD_W, height: CARD_H, channels: 4, background: COL_BG },
  }).composite(layers).png({ quality: 92 }).toBuffer();
  return final;
}

async function generateForCurrent() {
  const playerState = require('./playerState');
  const state = playerState.getState();
  const track = state.currentTrack;
  if (!track) throw new Error('No track playing');
  const database = db.get();
  const album = database.prepare(`
    SELECT id FROM albums WHERE title = ? AND album_artist = ? LIMIT 1
  `).get(track.album, track.album_artist);
  if (!album) throw new Error('Album not found in DB');
  return generateForAlbum(album.id);
}

module.exports = { generateForAlbum, generateForCurrent };
