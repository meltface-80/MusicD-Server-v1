/**
 * Artist logo fetcher — three-stage waterfall:
 *
 *   1. Resolve MusicBrainz Artist ID (cached after first lookup)
 *   2. Try fanart.tv hdmusiclogo endpoint
 *   3. Try TheAudioDB strArtistLogo endpoint
 *   4. Fall back to a typographic SVG rendered locally
 *
 * Logo binaries stored in artists.logo (BLOB) + artists.logo_mime + artists.logo_source.
 *
 * Rate limits:
 *   - MusicBrainz: 1 req/sec hard cap (their TOS). NOT enforced here —
 *     stage 1 goes through src/mbHttp.js, which owns the one shared
 *     throttle for the whole server. This file used to keep its own
 *     `mbGuard` alongside the ones in coverArt.js and metadataMatch.js,
 *     which is how a single host ended up running three independent
 *     1-req/sec streams at a service that allows one in total.
 *   - fanart.tv: undocumented; we keep to ~5 req/sec to be polite
 *   - TheAudioDB: documented at 2 req/sec for free keys
 *
 * Those last two are different services with their own limits, so they
 * keep their own guards below; only the MusicBrainz leg moved out.
 *
 * Settings keys (in `settings` table):
 *   - fanart_api_key:   fanart.tv project API key
 *   - audiodb_api_key:  TheAudioDB API key (often '2' works for testing)
 *   - mb_contact:       contact for the MusicBrainz User-Agent. Without
 *                       it stage 1 is skipped entirely (see fetchOneArtist).
 *
 * No external image processing — we store the raw bytes the API gives us.
 */
const axios = require('axios');
const sharp = require('sharp');
const db = require('./db');
const mbHttp = require('./mbHttp');

// UA was a hard-coded `musicd/1.0 (self-hosted)`: the wrong version, and
// no contact, on requests that included MusicBrainz. It is now built per
// call from the real VERSION and the user's mb_contact. fanart.tv and
// TheAudioDB do not require a contact, so with the field empty they
// still get a well-formed `musicd/<version>` and keep working — only
// the MusicBrainz leg is gated on it.
function userAgent() {
  return mbHttp.buildUserAgent(mbHttp.getContact());
}

// MB_RATE_MS and its mbGuard were removed with the local MusicBrainz
// resolver. The one throttle now lives in src/mbThrottle.js and is
// reached only through src/mbHttp.js.
const FANART_RATE_MS = 250;
const AUDIODB_RATE_MS = 600;

async function pace(lastVar, gapMs) {
  const wait = gapMs - (Date.now() - lastVar.value);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastVar.value = Date.now();
}
// Each rate-limit guard tracks the last-call timestamp on .value so multiple
// concurrent callers serialise correctly through pace() without racing on a
// raw module-level scalar.
const fanartGuard = { value: 0 };
const audiodbGuard = { value: 0 };

function getSetting(key, fallback = null) {
  const row = db.get().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

// resolveMbid() lived here. It searched MusicBrainz itself and took
// artists[0] whenever MusicBrainz's OWN score was >= 90 — no alias
// check, no sort-name check, no comparison of the returned name to the
// one we asked for. That is a lower bar than it looks: MB's score is a
// text-relevance figure, and for a short or common artist name the top
// hit can clear 90 while being a different act entirely.
//
// It mattered because of where the answer went. It wrote
// artists.mb_artist_id — the SAME column mbArtist.resolveArtistMbid
// writes, and that function is deliberately strict for the reason its
// own comment gives: "a wrong artist MBID poisons every album we then
// match from their discography". Whichever job happened to run first on
// a given artist won the column, and the matcher then trusted it as a
// cache hit. A logo fetch could quietly decide which discography every
// one of that artist's albums would be matched against.
//
// So there is now one resolver, the strict one. This file calls it.
async function resolveArtistMbid(name, contact, database) {
  const mbArtist = require('./mbArtist');
  try {
    return await mbArtist.resolveArtistMbid(name, {
      // mbArtist calls ctx.mbRequest(path, params, ctx.userAgent); the
      // third argument is redundant here because mbHttp builds the
      // User-Agent from the contact itself, so it is accepted and
      // ignored rather than changing mbArtist's shape.
      mbRequest: (path, params) => mbHttp.request(path, params, { contact }),
      userAgent: mbHttp.buildUserAgent(contact),
      dbh: database,
    });
  } catch (e) {
    // Not silent, but not fatal either: a failed MBID lookup costs this
    // artist the fanart.tv stage and nothing else. The waterfall below
    // still runs and still ends in a logo.
    console.warn(`[artist-logos] MBID lookup failed for "${name}": ${e.message}`);
    return null;
  }
}

async function fetchFanartLogo(mbid) {
  const serviceHealth = require('./serviceHealth');
  if (!mbid) return null;
  await pace(fanartGuard, FANART_RATE_MS);
  const ua = userAgent();
  try {
    const r = await axios.get(`https://webservice.fanart.tv/v3/music/${mbid}`, {
      // v1.1.39.0 — the project key ALWAYS, plus the install's personal
      // key when it has one. fanart rejects a request with no project
      // key even when a personal key is present, so this is not an
      // either/or; getFanartParams() owns that rule and the "omit when
      // empty" part, because an empty client_key parameter reads to
      // fanart as a malformed key rather than as absent.
      params: require('./apiCredentials').getFanartParams(),
      headers: { 'User-Agent': ua },
      timeout: 10000,
    });
    serviceHealth.recordSuccess('fanart');
    // hdmusiclogo > musiclogo. Both are arrays of { url, likes, lang }
    const candidates = [...(r.data?.hdmusiclogo || []), ...(r.data?.musiclogo || [])];
    if (!candidates.length) return null;
    // Pick the one with most likes (fanart.tv community-curated quality signal)
    const sorted = candidates.sort((a, b) => parseInt(b.likes || 0) - parseInt(a.likes || 0));
    const url = sorted[0].url;
    if (!url) return null;
    const img = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000, headers: { 'User-Agent': ua } });
    return { data: Buffer.from(img.data), mime: 'image/png', source: 'fanart' };
  } catch (e) {
    // 404 on a specific MBID is "no logo for this artist" -- that's
    // a legitimate API response, not a service failure.
    if (e.response?.status === 404) {
      serviceHealth.recordSuccess('fanart');
      return null;
    }
    serviceHealth.recordFailure('fanart', e.message || 'unknown error');
    return null;
  }
}

async function fetchAudioDbLogo(mbid, name) {
  // v1.1.39.0 — see apiCredentials.getAudioDbKey(). Both branches below
  // put the key in the PATH, so it has to be resolved before either.
  const AUDIODB_API_KEY = require('./apiCredentials').getAudioDbKey();
  const serviceHealth = require('./serviceHealth');
  await pace(audiodbGuard, AUDIODB_RATE_MS);
  const ua = userAgent();
  try {
    let url, params;
    if (mbid) {
      url = `https://www.theaudiodb.com/api/v1/json/${AUDIODB_API_KEY}/artist-mb.php`;
      params = { i: mbid };
    } else {
      url = `https://www.theaudiodb.com/api/v1/json/${AUDIODB_API_KEY}/search.php`;
      params = { s: name };
    }
    const r = await axios.get(url, { params, timeout: 10000, headers: { 'User-Agent': ua } });
    serviceHealth.recordSuccess('audiodb');
    const a = r.data?.artists?.[0];
    const logoUrl = a?.strArtistLogo;
    if (!logoUrl) return null;
    const img = await axios.get(logoUrl, { responseType: 'arraybuffer', timeout: 15000, headers: { 'User-Agent': ua } });
    return { data: Buffer.from(img.data), mime: 'image/png', source: 'audiodb' };
  } catch (e) {
    serviceHealth.recordFailure('audiodb', e.message || 'unknown error');
    return null;
  }
}

async function generateTypographicLogo(name) {
  // Render artist name as a clean SVG → PNG. Background transparent, white text.
  const safe = String(name).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Pick a font weight by name length — long names need lighter weight to fit
  const weight = name.length > 18 ? 600 : 800;
  const fontSize = name.length > 26 ? 56 : name.length > 16 ? 72 : 96;
  const svg = `<svg width="900" height="280" xmlns="http://www.w3.org/2000/svg">
    <text x="450" y="160" text-anchor="middle"
          font-family="DM Sans, system-ui, sans-serif"
          font-size="${fontSize}" font-weight="${weight}"
          letter-spacing="-1" fill="white">${safe}</text>
  </svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return { data: png, mime: 'image/png', source: 'typographic' };
}

async function fetchOneArtist(name) {
  const database = db.get();
  // Look up artist row (may be missing if scanner never inserted it explicitly — auto-create)
  let row = database.prepare('SELECT * FROM artists WHERE name = ?').get(name);
  if (!row) {
    const id = require('crypto').createHash('md5').update('artist:' + name).digest('hex');
    database.prepare('INSERT OR IGNORE INTO artists (id, name) VALUES (?, ?)').run(id, name);
    row = database.prepare('SELECT * FROM artists WHERE name = ?').get(name);
  }

  // Resolve MBID if we don't have it.
  //
  // With no mb_contact configured we skip this stage entirely rather
  // than sending MusicBrainz an anonymous request, and the waterfall
  // below copes: fanart.tv needs an MBID so it is skipped, TheAudioDB's
  // search.php?s=<name> path already handles the no-MBID case, and the
  // typographic fallback always succeeds. Every artist still ends the
  // run with a logo.
  let mbid = row.mb_artist_id;
  if (!mbid) {
    const contact = mbHttp.getContact();
    if (contact) {
      mbid = await resolveArtistMbid(name, contact, database);
      if (mbid) {
        // mbArtist caches the MBID itself, matched on LOWER(name). This
        // write is by row id, so the row we just created or read is
        // certain to carry it even if the name differs in case.
        database.prepare('UPDATE artists SET mb_artist_id = ? WHERE id = ?').run(mbid, row.id);
      }
    }
  }

  // Waterfall
  let logo = null;
  if (mbid) logo = await fetchFanartLogo(mbid);
  if (!logo) logo = await fetchAudioDbLogo(mbid, name);
  if (!logo) logo = await generateTypographicLogo(name);

  database.prepare(`
    UPDATE artists SET logo = ?, logo_mime = ?, logo_source = ?, logo_fetched_at = unixepoch()
    WHERE id = ?
  `).run(logo.data, logo.mime, logo.source, row.id);

  return { name, source: logo.source };
}

// ── batch runner ──
let progress = { running: false, processed: 0, total: 0, sources: { fanart: 0, audiodb: 0, typographic: 0 }, lastError: null };
let abortFlag = false;

function getProgress() { return { ...progress }; }
function abortRun() { abortFlag = true; }

async function runFetch({ force = false } = {}) {
  if (progress.running) return { error: 'already running' };
  abortFlag = false;
  const database = db.get();
  const allArtists = database.prepare(`
    SELECT DISTINCT album_artist as name FROM albums
    WHERE album_artist IS NOT NULL AND album_artist != '' AND album_artist != 'Unknown Artist'
    ORDER BY album_artist COLLATE NOCASE
  `).all();

  // Filter to those needing a logo (unless forcing all)
  const todo = force ? allArtists : allArtists.filter(a => {
    const row = database.prepare('SELECT logo FROM artists WHERE name = ?').get(a.name);
    return !row?.logo;
  });

  progress = { running: true, processed: 0, total: todo.length, sources: { fanart: 0, audiodb: 0, typographic: 0 }, lastError: null };
  console.log(`🎨 Artist logo fetch: ${todo.length} artists${force ? ' (forced)' : ''}`);
  if (global.broadcastState) global.broadcastState('artist_logos_progress', progress);

  let lastBroadcast = 0;
  for (const a of todo) {
    if (abortFlag) break;
    try {
      const { source } = await fetchOneArtist(a.name);
      progress.sources[source] = (progress.sources[source] || 0) + 1;
    } catch (e) {
      progress.lastError = e.message;
    }
    progress.processed++;
    const now = Date.now();
    if (now - lastBroadcast > 1500 || progress.processed === todo.length) {
      lastBroadcast = now;
      if (global.broadcastState) global.broadcastState('artist_logos_progress', progress);
    }
  }

  progress.running = false;
  console.log(`🎨 Artist logo fetch complete — fanart:${progress.sources.fanart} audiodb:${progress.sources.audiodb} typographic:${progress.sources.typographic}`);
  if (global.broadcastState) global.broadcastState('artist_logos_progress', progress);
}

async function setManualLogo(name, buffer, mime) {
  const database = db.get();
  let row = database.prepare('SELECT id FROM artists WHERE name = ?').get(name);
  if (!row) {
    const id = require('crypto').createHash('md5').update('artist:' + name).digest('hex');
    database.prepare('INSERT INTO artists (id, name) VALUES (?, ?)').run(id, name);
    row = { id };
  }
  database.prepare(`
    UPDATE artists SET logo = ?, logo_mime = ?, logo_source = 'manual', logo_fetched_at = unixepoch()
    WHERE id = ?
  `).run(buffer, mime, row.id);
}

async function clearLogo(name) {
  db.get().prepare(`
    UPDATE artists SET logo = NULL, logo_mime = NULL, logo_source = NULL, logo_fetched_at = NULL
    WHERE name = ?
  `).run(name);
}

module.exports = { runFetch, abortRun, getProgress, fetchOneArtist, setManualLogo, clearLogo };
