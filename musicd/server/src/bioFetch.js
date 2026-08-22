// Album/artist bio fetcher (#30.23)
// ==================================
//
// Fetches narrative content (bios, reviews, summaries) for albums and
// artists by walking a chain of free sources, taking the first one
// that returns substantial prose. Results are cached in album_bio /
// artist_bio so subsequent reads are instant.
//
// Sources tried, in order:
//   Albums:   Wikipedia → MB annotation → Last.fm → AudioDB
//
// (Until v1.1.38.0 that album line described an intention rather than
// the code: AudioDB was never wired in for albums at all, and the
// Last.fm step passed a release-group mbid to an endpoint that indexes
// release mbids. Both are real now.)
//   Artists:  Wikipedia → Last.fm → AudioDB → MB annotation
//
// Why this order: Wikipedia is highest-quality (edited prose), and
// once we have an MBID the canonical-URL lookup avoids the
// disambiguation issues that plagued the v1 attempt at this. Last.fm
// often serves Wikipedia-derived content anyway but with cleaner
// formatting. AudioDB tends to be terse but has good coverage for
// metal/rock that Wikipedia might miss.
//
// MusicBrainz-mediated lookups respect the 1 req/sec rate limit set
// up in metadataMatch.js. We share that throttle across both modules
// to stay polite -- otherwise running the matcher AND opening album
// pages simultaneously would breach 1 req/sec.

const axios = require('axios');
const db = require('./db');

const REQUEST_TIMEOUT_MS = 8000;
const MIN_USEFUL_CHARS = 200;       // bios shorter than this aren't useful
const MAX_BIO_CHARS = 8000;         // cap stored content; UI scrolls

// Shared MB throttle. We need to keep 1 req/sec across the matcher
// and bio fetcher, so this gets imported and updated by both.
const mbHttp = require('./mbHttp');

// ── Settings helpers ─────────────────────────────────────────────────

function getSetting(key, fallback = '') {
  try {
    const row = db.get().prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row?.value ?? fallback;
  } catch {
    return fallback;
  }
}

// Cached at module load (#30.24 — was rebuilt on every request).
// Version doesn't change at runtime; contact may, so we re-read it.
let _cachedVersion = null;
function getVersion() {
  if (_cachedVersion) return _cachedVersion;
  try {
    const fs = require('fs');
    const path = require('path');
    _cachedVersion = fs.readFileSync(path.join(__dirname, '../../VERSION'), 'utf-8').trim();
  } catch {
    _cachedVersion = 'unknown';
  }
  return _cachedVersion;
}

function buildUserAgent() {
  // Includes mb_contact when available -- MB requires it, Wikipedia
  // and Last.fm don't but accept it cheerfully. When contact is
  // empty, we still produce a valid UA for non-MB services. MB
  // calls validate contact separately before invoking us (#30.24).
  const contact = getSetting('mb_contact', '').trim();
  if (contact) {
    return `musicd/${getVersion()} ( ${contact} )`;
  }
  return `musicd/${getVersion()}`;
}

// ── Source: MusicBrainz URL relationships ────────────────────────────
// Given an MBID for an entity, return its URL relationships -- the
// list of external sites MB has cross-referenced. The Wikipedia URL
// we use to find a canonical article; the Last.fm URL we use as
// confirmation that LFM has a record for this MBID.
//
// Refuses to call MB if the user hasn't set mb_contact (#30.24).
// MB's TOS requires identifying contact info; without it we'd be
// sending fake info that could get the IP blocked. The matcher
// validates the same way at start time.

async function fetchMbUrls(entityType, mbid) {
  const contact = getSetting('mb_contact', '').trim();
  if (!contact) {
    // Throw rather than return null so the caller can distinguish
    // "no contact configured" from "MB had no data". The route
    // surfaces this as a recognisable error in the bio modal.
    const err = new Error('NO_MB_CONTACT');
    err.code = 'NO_MB_CONTACT';
    throw err;
  }
  // v1.1.38.0 — through src/mbHttp.js rather than a local axios call.
  // This module called mbThrottle itself and then talked to MusicBrainz
  // directly, which was fine for the throttle but meant it had no 503
  // handling at all: a rate-limit response surfaced as a bio failure and
  // was cached as one. mbHttp honours Retry-After and shares the single
  // process-wide throttle with the matcher, the art fetcher and the logo
  // fetcher — which, before this release, were three separate pacers.
  const data = (await mbHttp.request(
    `/${entityType}/${mbid}`, { inc: 'url-rels+annotation' }, { contact }
  )) || {};
  const rels = data.relations || [];
  const urls = {};
  for (const rel of rels) {
    if (!rel.url?.resource) continue;
    // Common type slugs we care about. MB has more (discogs, allmusic,
    // bandcamp, etc) -- they're available in this same response if we
    // want to extend later.
    if (rel.type === 'wikipedia') urls.wikipedia = rel.url.resource;
    if (rel.type === 'last.fm') urls.lastfm = rel.url.resource;
    if (rel.type === 'allmusic') urls.allmusic = rel.url.resource;
    if (rel.type === 'discogs') urls.discogs = rel.url.resource;
    if (rel.type === 'official homepage') urls.homepage = rel.url.resource;
  }
  return {
    urls,
    annotation: data.annotation || null,
  };
}

// ── Source: Wikipedia ────────────────────────────────────────────────
// Wikipedia has a dedicated REST endpoint for page summaries that
// returns a clean text extract (no HTML, no infoboxes, no nav). We
// hit that rather than parsing the full article.
//
// Input is a Wikipedia URL like:
//   https://en.wikipedia.org/wiki/Famous_Last_Words_(Supertramp_album)
// We extract the "Famous_Last_Words_(Supertramp_album)" slug and
// query the summary endpoint.

async function fetchWikipediaSummary(wikipediaUrl) {
  // Parse out the language and article slug
  const match = wikipediaUrl.match(/^https?:\/\/([a-z]{2,3})\.wikipedia\.org\/wiki\/(.+)$/i);
  if (!match) return null;
  const [, lang, slug] = match;
  // The slug from MB may already be URL-decoded or encoded depending
  // on how it was stored. Normalise: decode then re-encode the path
  // segment exactly once.
  let decodedSlug;
  try {
    decodedSlug = decodeURIComponent(slug);
  } catch {
    decodedSlug = slug;
  }
  const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(decodedSlug)}`;
  try {
    const res = await axios.get(url, {
      headers: { 'User-Agent': buildUserAgent() },
      timeout: REQUEST_TIMEOUT_MS,
    });
    const data = res.data || {};
    // The "extract" field is plain-text prose. "extract_html" is the
    // HTML version. We use the plain version for safety -- no XSS
    // surface, no link rendering decisions for now.
    if (!data.extract || data.extract.length < MIN_USEFUL_CHARS) return null;
    // Type=disambiguation means we hit a disambiguation page -- skip
    // it rather than serve "X may refer to..." as a bio.
    if (data.type === 'disambiguation') return null;
    return {
      content: data.extract.slice(0, MAX_BIO_CHARS),
      url: data.content_urls?.desktop?.page || wikipediaUrl,
    };
  } catch (e) {
    if (e.response?.status === 404) return null; // article moved/deleted
    throw e;
  }
}

// ── Source: Last.fm ──────────────────────────────────────────────────
// Last.fm's "wiki" content has been declining since they deprecated
// their bio editor in 2019. Many entries are now just one sentence
// with a link out. We accept what they give us and cache it; if it's
// shorter than MIN_USEFUL_CHARS we treat it as no result.
//
// Authenticated with the user's API key. Free signup at last.fm/api.
// If no key is configured, we skip Last.fm entirely.

async function fetchLastfm(method, params) {
  // Last.fm app credentials baked in (#v1.1.0.23). See apiCredentials.js
  // for context.
  const { LASTFM_API_KEY } = require('./apiCredentials');
  const serviceHealth = require('./serviceHealth');
  try {
    const res = await axios.get('https://ws.audioscrobbler.com/2.0/', {
      params: { method, api_key: LASTFM_API_KEY, format: 'json', ...params },
      headers: { 'User-Agent': buildUserAgent() },
      timeout: REQUEST_TIMEOUT_MS,
    });
    serviceHealth.recordSuccess('lastfm');
    return res.data;
  } catch (e) {
    if (e.response?.status === 404) {
      // 404 on bio lookup is "no record" -- not a service failure.
      // Still counts as a successful round-trip to the API.
      serviceHealth.recordSuccess('lastfm');
      return null;
    }
    serviceHealth.recordFailure('lastfm', e.message || 'unknown error');
    throw e;
  }
}

/**
 * Last.fm album bio.
 *
 * v1.1.38.0 — this was a near-guaranteed miss.
 *
 * It was called as `fetchLastfmAlbumBio(album.mb_release_group_id)`, and
 * `album.getInfo`'s mbid parameter indexes RELEASE mbids, not release
 * GROUP mbids. So step three of the album bio chain almost never
 * returned anything, and the chain was effectively Wikipedia, then the
 * MusicBrainz annotation, then nothing.
 *
 * Now: the release mbid when the album row actually has one — that IS
 * the right kind of id and it is exact — then artist and album by name,
 * which is how every other Last.fm client looks an album up and which
 * needs no MusicBrainz id at all.
 */
async function fetchLastfmAlbumBio({ releaseMbid, artist, album }) {
  let data = null;
  if (releaseMbid) data = await fetchLastfm('album.getInfo', { mbid: releaseMbid });
  if (!data?.album?.wiki?.summary && artist && album) {
    data = await fetchLastfm('album.getInfo', { artist, album });
  }
  if (!data?.album?.wiki?.summary) return null;
  // Last.fm wraps their summary in HTML and tacks on a "Read more on
  // Last.fm" link. Strip the markup, drop everything after the
  // "<a href" attribution link.
  const raw = data.album.wiki.content || data.album.wiki.summary;
  const stripped = stripHtml(raw).replace(/\s*Read more on Last\.fm.*$/i, '').trim();
  if (stripped.length < MIN_USEFUL_CHARS) return null;
  return {
    content: stripped.slice(0, MAX_BIO_CHARS),
    url: data.album.url || null,
  };
}

async function fetchLastfmArtistBio(mbid) {
  const data = await fetchLastfm('artist.getInfo', { mbid });
  if (!data?.artist?.bio?.summary) return null;
  const raw = data.artist.bio.content || data.artist.bio.summary;
  const stripped = stripHtml(raw).replace(/\s*Read more on Last\.fm.*$/i, '').trim();
  if (stripped.length < MIN_USEFUL_CHARS) return null;
  return {
    content: stripped.slice(0, MAX_BIO_CHARS),
    url: data.artist.url || null,
  };
}

// ── Source: TheAudioDB ───────────────────────────────────────────────
// Already integrated for artist images; the same API also exposes
// biography fields. We use the existing API key.

async function fetchAudioDbArtistBio(mbid) {
  // v1.1.39.0 — getAudioDbKey(), not the raw constant: the baked-in
  // value is the service's public TEST key and this lets an install use
  // its own. See apiCredentials.js.
  const key = require('./apiCredentials').getAudioDbKey();
  const serviceHealth = require('./serviceHealth');
  try {
    const res = await axios.get(`https://www.theaudiodb.com/api/v1/json/${key}/artist-mb.php`, {
      params: { i: mbid },
      timeout: REQUEST_TIMEOUT_MS,
    });
    serviceHealth.recordSuccess('audiodb');
    const artist = res.data?.artists?.[0];
    if (!artist?.strBiographyEN) return null;
    const content = artist.strBiographyEN.trim();
    if (content.length < MIN_USEFUL_CHARS) return null;
    return {
      content: content.slice(0, MAX_BIO_CHARS),
      url: artist.strWebsite ? `https://${artist.strWebsite}` : null,
    };
  } catch (e) {
    serviceHealth.recordFailure('audiodb', e.message || 'unknown error');
    return null;
  }
}

// ── Source: TheAudioDB, albums ───────────────────────────────────────
// The artist path has used this API since #30.23. The album path never
// did, even though album-mb.php is keyed on the RELEASE GROUP mbid —
// exactly the id this server stores, and the one Last.fm could not use.
// Same key, same health key, same length rules as the artist call above.

async function fetchAudioDbAlbumBio(releaseGroupMbid) {
  if (!releaseGroupMbid) return null;
  const key = require('./apiCredentials').getAudioDbKey();
  const serviceHealth = require('./serviceHealth');
  try {
    const res = await axios.get(`https://www.theaudiodb.com/api/v1/json/${key}/album-mb.php`, {
      params: { i: releaseGroupMbid },
      timeout: REQUEST_TIMEOUT_MS,
    });
    serviceHealth.recordSuccess('audiodb');
    const album = res.data?.album?.[0];
    if (!album?.strDescriptionEN) return null;
    const content = album.strDescriptionEN.trim();
    if (content.length < MIN_USEFUL_CHARS) return null;
    return {
      content: content.slice(0, MAX_BIO_CHARS),
      url: album.strMusicBrainzID
        ? `https://musicbrainz.org/release-group/${album.strMusicBrainzID}`
        : null,
    };
  } catch (e) {
    serviceHealth.recordFailure('audiodb', e.message || 'unknown error');
    return null;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function stripHtml(s) {
  if (!s) return '';
  // Preserve paragraph structure BEFORE stripping tags. We replace
  // common block-level breaks with a sentinel newline pair, then strip
  // remaining tags, then collapse other whitespace. This way the
  // BioModal can split on \n\n+ to render paragraphs correctly.
  // Without this, all multi-paragraph bios from Last.fm/AudioDB
  // come through as a single wall of text (#30.24).
  return String(s)
    // Block-level elements that signal paragraph breaks. We use a
    // distinctive sentinel rather than raw \n\n so the whitespace
    // collapse below doesn't eat them.
    .replace(/<\/p>\s*<p[^>]*>/gi, '\u0000\u0000')   // </p><p> → break
    .replace(/<br\s*\/?>\s*<br\s*\/?>/gi, '\u0000\u0000') // <br><br> → break
    .replace(/<\/p>/gi, '\u0000\u0000')              // closing </p> alone
    .replace(/<p[^>]*>/gi, '')                       // opening <p> drop
    .replace(/<br\s*\/?>/gi, '\u0000')               // single <br> → soft newline
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // Collapse runs of regular whitespace (but NOT our sentinels)
    .replace(/[ \t\r\f\v]+/g, ' ')
    // Now turn the sentinels back into real newlines for rendering
    .replace(/\u0000\u0000/g, '\n\n')
    .replace(/\u0000/g, '\n')
    // Tidy: collapse 3+ newlines, trim per-line whitespace
    .replace(/\n{3,}/g, '\n\n')
    .split('\n').map(line => line.trim()).join('\n')
    .trim();
}

// ── Public: get album bio ────────────────────────────────────────────
//
// Returns an object: { source, source_url, content, fetched_at } or
// null if no bio could be obtained. Caches the result in album_bio.
//
// If we have a cached row (any status), we return it without
// re-fetching unless `force=true`. Errors don't get permanently
// cached -- they re-try on next call.

async function getAlbumBio(albumId, { force = false } = {}) {
  const database = db.get();

  // Cache check
  if (!force) {
    const cached = database.prepare(
      `SELECT source, source_url, content, fetched_at, fetch_status
       FROM album_bio WHERE album_id = ?`
    ).get(albumId);
    if (cached && cached.fetch_status !== 'error') {
      return cached;
    }
  }

  // Get the album's MBID
  const album = database.prepare(
    `SELECT id, title, album_artist, mb_release_group_id, mb_release_id, match_status
     FROM albums WHERE id = ?`
  ).get(albumId);
  if (!album) return null;

  if (!album.mb_release_group_id || album.match_status !== 'matched') {
    // No MBID we can work with -- record the negative result so the
    // UI knows to hide the button rather than showing "loading".
    saveAlbumBio(albumId, { fetch_status: 'no_mbid' });
    return loadAlbumBio(albumId);
  }

  // Try sources in order
  let result = null;
  let mbInfo = null;
  let mbContactMissing = false;
  try {
    mbInfo = await fetchMbUrls('release-group', album.mb_release_group_id);
  } catch (e) {
    if (e.code === 'NO_MB_CONTACT') {
      mbContactMissing = true;
      // Don't warn -- this is a config issue, not a runtime failure.
    } else {
      console.warn('[bio] MB lookup failed for album', albumId, e.message);
    }
  }

  // 1. Wikipedia
  if (!result && mbInfo?.urls?.wikipedia) {
    try {
      const wiki = await fetchWikipediaSummary(mbInfo.urls.wikipedia);
      if (wiki) result = { source: 'wikipedia', ...wiki };
    } catch (e) {
      console.warn('[bio] Wikipedia fetch failed:', e.message);
    }
  }

  // 2. MB annotation (often short but accurate)
  if (!result && mbInfo?.annotation && mbInfo.annotation.length >= MIN_USEFUL_CHARS) {
    result = {
      source: 'mb-annotation',
      content: mbInfo.annotation.slice(0, MAX_BIO_CHARS),
      url: `https://musicbrainz.org/release-group/${album.mb_release_group_id}`,
    };
  }

  // 3. Last.fm
  if (!result) {
    try {
      const lfm = await fetchLastfmAlbumBio({
        releaseMbid: album.mb_release_id || null,
        artist: album.album_artist || null,
        album: album.title || null,
      });
      if (lfm) result = { source: 'lastfm', ...lfm };
    } catch (e) {
      console.warn('[bio] Last.fm fetch failed:', e.message);
    }
  }

  // 4. TheAudioDB, keyed on the release group — see above. Costs no
  //    MusicBrainz request, which matters: bios are already the largest
  //    single block of MusicBrainz traffic in this server.
  if (!result) {
    try {
      const adb = await fetchAudioDbAlbumBio(album.mb_release_group_id);
      if (adb) result = { source: 'audiodb', ...adb };
    } catch (e) {
      console.warn('[bio] AudioDB album fetch failed:', e.message);
    }
  }

  if (result) {
    saveAlbumBio(albumId, {
      source: result.source,
      source_url: result.url,
      content: result.content,
      fetch_status: 'ok',
    });
  } else if (mbContactMissing) {
    // Don't permanently cache this -- once the user sets the contact,
    // the next view should re-attempt. Use 'error' status which we
    // treat as a soft cache (re-tries on next access).
    saveAlbumBio(albumId, { fetch_status: 'error', source: 'no_mb_contact' });
  } else {
    saveAlbumBio(albumId, { fetch_status: 'no_match' });
  }
  return loadAlbumBio(albumId);
}

// ── Public: get artist bio ───────────────────────────────────────────

async function getArtistBio(artistName, { force = false } = {}) {
  const database = db.get();

  if (!force) {
    const cached = database.prepare(
      `SELECT source, source_url, content, fetched_at, fetch_status
       FROM artist_bio WHERE artist_name = ?`
    ).get(artistName);
    if (cached && cached.fetch_status !== 'error') {
      return cached;
    }
  }

  // Look up the MBID from the artists table (populated by the artist
  // logo fetcher previously). Without an MBID we can't reliably
  // disambiguate; record negative result.
  const artist = database.prepare(
    `SELECT name, mb_artist_id FROM artists WHERE name = ?`
  ).get(artistName);
  const mbid = artist?.mb_artist_id;
  if (!mbid) {
    saveArtistBio(artistName, { fetch_status: 'no_mbid' });
    return loadArtistBio(artistName);
  }

  let result = null;
  let mbInfo = null;
  let mbContactMissing = false;
  try {
    mbInfo = await fetchMbUrls('artist', mbid);
  } catch (e) {
    if (e.code === 'NO_MB_CONTACT') {
      mbContactMissing = true;
    } else {
      console.warn('[bio] MB lookup failed for artist', artistName, e.message);
    }
  }

  // 1. Wikipedia
  if (!result && mbInfo?.urls?.wikipedia) {
    try {
      const wiki = await fetchWikipediaSummary(mbInfo.urls.wikipedia);
      if (wiki) result = { source: 'wikipedia', ...wiki };
    } catch (e) {
      console.warn('[bio] Wikipedia fetch failed:', e.message);
    }
  }

  // 2. Last.fm
  if (!result) {
    try {
      const lfm = await fetchLastfmArtistBio(mbid);
      if (lfm) result = { source: 'lastfm', ...lfm };
    } catch (e) {
      console.warn('[bio] Last.fm fetch failed:', e.message);
    }
  }

  // 3. AudioDB
  if (!result) {
    try {
      const adb = await fetchAudioDbArtistBio(mbid);
      if (adb) result = { source: 'audiodb', ...adb };
    } catch (e) {
      console.warn('[bio] AudioDB fetch failed:', e.message);
    }
  }

  // 4. MB annotation
  if (!result && mbInfo?.annotation && mbInfo.annotation.length >= MIN_USEFUL_CHARS) {
    result = {
      source: 'mb-annotation',
      content: mbInfo.annotation.slice(0, MAX_BIO_CHARS),
      url: `https://musicbrainz.org/artist/${mbid}`,
    };
  }

  if (result) {
    saveArtistBio(artistName, {
      source: result.source,
      source_url: result.url,
      content: result.content,
      fetch_status: 'ok',
    });
  } else if (mbContactMissing) {
    saveArtistBio(artistName, { fetch_status: 'error', source: 'no_mb_contact' });
  } else {
    saveArtistBio(artistName, { fetch_status: 'no_match' });
  }
  return loadArtistBio(artistName);
}

// ── DB persistence ───────────────────────────────────────────────────

function saveAlbumBio(albumId, fields) {
  db.get().prepare(`
    INSERT INTO album_bio (album_id, source, source_url, content, fetched_at, fetch_status)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(album_id) DO UPDATE SET
      source = excluded.source,
      source_url = excluded.source_url,
      content = excluded.content,
      fetched_at = excluded.fetched_at,
      fetch_status = excluded.fetch_status
  `).run(
    albumId,
    fields.source || null,
    fields.source_url || null,
    fields.content || null,
    Date.now(),
    fields.fetch_status || 'ok'
  );
}

function loadAlbumBio(albumId) {
  return db.get().prepare(
    `SELECT source, source_url, content, fetched_at, fetch_status
     FROM album_bio WHERE album_id = ?`
  ).get(albumId);
}

function saveArtistBio(artistName, fields) {
  db.get().prepare(`
    INSERT INTO artist_bio (artist_name, source, source_url, content, fetched_at, fetch_status)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(artist_name) DO UPDATE SET
      source = excluded.source,
      source_url = excluded.source_url,
      content = excluded.content,
      fetched_at = excluded.fetched_at,
      fetch_status = excluded.fetch_status
  `).run(
    artistName,
    fields.source || null,
    fields.source_url || null,
    fields.content || null,
    Date.now(),
    fields.fetch_status || 'ok'
  );
}

function loadArtistBio(artistName) {
  return db.get().prepare(
    `SELECT source, source_url, content, fetched_at, fetch_status
     FROM artist_bio WHERE artist_name = ?`
  ).get(artistName);
}

module.exports = {
  getAlbumBio,
  getArtistBio,
  // v1.1.0.99 — synchronous cache reads exposed for inline album-page
  // sections. The /related endpoint reads the bio from cache without
  // triggering a fetch — proactive fetches happen via bioScanner in
  // the background, so by the time the user opens an album the cache
  // is usually warm. If it's not, the section just shows nothing.
  loadAlbumBio,
  loadArtistBio,
};
