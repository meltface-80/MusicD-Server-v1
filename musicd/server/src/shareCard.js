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
const COL_ACCENT = '#5b7fff';            // the "D" of the wordmark

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

// The browser card composites a 110px-wide wordmark image at 88% opacity. No
// image exists server-side, so the wordmark is set as text at the size that
// renders it that wide in DejaVu Sans Bold (measured: 111px at 28px), in the
// same corner. "MusicD" has no descenders, so its baseline is also its visual
// bottom and can sit straight on the WORDMARK_PAD line.
const WORDMARK_TEXT_A = 'Music';
const WORDMARK_TEXT_D = 'D';
const WORDMARK_SIZE = 28;
const WORDMARK_OPACITY = 0.88;

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

  // Wordmark pinned bottom-right, its feet WORDMARK_PAD clear of both edges.
  const wordmarkY = CARD_H - WORDMARK_PAD;

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
        .wordmark   { fill: ${COL_TITLE};  font-family: ${FONT_FAMILY}; font-weight: 800; }
        .wordmark-d { fill: ${COL_ACCENT}; }
      </style>
    </defs>
    ${emptyArtSvg}
    <rect x="${ART_W - FADE_W}" y="0" width="${FADE_W}" height="${CARD_H}" fill="url(#artFade)"/>
    ${metaSvg}
    ${titleSvg}
    ${artistSvg}
    <text x="${CARD_W - WORDMARK_PAD}" y="${wordmarkY}" text-anchor="end"
          font-size="${WORDMARK_SIZE}" opacity="${WORDMARK_OPACITY}"
          class="wordmark">${WORDMARK_TEXT_A}<tspan class="wordmark-d">${WORDMARK_TEXT_D}</tspan></text>
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
