// src/coverArt.js — find a front cover for one album.
// ===================================================
//
// The waterfall, cheapest first:
//
//   1. Art embedded in the audio file's tags.
//   2. An image sitting next to the file (cover.jpg, folder.png, ...).
//   3. The Cover Art Archive, addressed by MBID when we know one.
//   4. Only if we know no MBID: a fuzzy MusicBrainz search, then the
//      archive for whatever that search returned.
//
// v1.1.38.0 rewrote steps 3 and 4, and the reasons are worth recording
// because two of them were outright bugs:
//
//   - This file used to keep its OWN rate limiter — a module-level
//     `lastMBRequest` and an 1100ms gate — which knew nothing about
//     mbThrottle. MusicBrainz allows one request per second PER IP, not
//     per module, so a scan with the matcher running was two independent
//     1-req/sec streams from one address. Every MusicBrainz request in
//     this file now goes through src/mbHttp.js, which owns the single
//     throttle.
//
//   - It sent `User-Agent: musicd/1.0 (self-hosted)`. No contact, no
//     real version. metadataMatch.js refuses to run at all without a
//     contact on terms-of-service grounds; this file was sending
//     unattributable traffic from the same IP anyway. It now carries the
//     same identity as everything else, and if no contact is configured
//     it does not talk to MusicBrainz at all.
//
//   - It ran a fuzzy `release?query=artist:"..." AND release:"..."`
//     search for EVERY album, including the ones whose release-group
//     MBID the matcher had already resolved and stored. That is a
//     rate-limited request, and a guess, spent on a question we already
//     had the exact answer to. When the caller passes an MBID we go
//     straight to the archive: one CDN request, zero MusicBrainz
//     requests, and the art is the one belonging to THIS album rather
//     than to the best of five search hits.
//
// The Cover Art Archive is a CDN sitting in front of the Internet
// Archive. It is NOT part of the MusicBrainz web service and is not
// subject to its rate limit, so CAA requests deliberately do not go
// through mbThrottle — putting them there would slow art fetching to
// one album per second for no reason. We still send a proper
// User-Agent, because being identifiable is good manners even where it
// is not enforced.

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const axios = require('axios');
const mbHttp = require('./mbHttp');
const log = require('./serviceLog').forModule('cover-art');

const PREFERRED_NAMES = [
  'cover', 'folder', 'front', 'album', 'artwork', 'art',
  'Cover', 'Folder', 'Front', 'Album', 'Artwork', 'Art',
];
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.tiff'];

// MB_HEADERS lived here — a hard-coded `musicd/1.0 (self-hosted)` with
// no contact in it. Gone: the User-Agent now comes from
// mbHttp.buildUserAgent(), which reads the real version and the user's
// contact, so MusicBrainz and the archive see one consistent identity
// from this server instead of three different ones.
const CAA_BASE = 'https://coverartarchive.org';
const CAA_TIMEOUT_MS = 8000;
// The archive is a CDN with no published limit, but a scan can ask it
// for hundreds of covers back to back. A small gap between the requests
// of one fuzzy-search fallback keeps that civil without meaningfully
// slowing anything down.
const CAA_POLITE_GAP_MS = 300;
const MB_SEARCH_LIMIT = 5;

// Bounded LRU cache for successful hits only — failures don't poison the cache (#5)
const MAX_CACHE = 5000;
const artCache = new Map();
function cachePut(key, value) {
  if (artCache.has(key)) artCache.delete(key);
  else if (artCache.size >= MAX_CACHE) {
    const firstKey = artCache.keys().next().value;
    artCache.delete(firstKey);
  }
  artCache.set(key, value);
}

/**
 * findCoverArt(filePath, embeddedData, embeddedMime, artist, album, opts)
 *
 *   opts.releaseGroupId  when set, ask the archive for this release
 *                        group's front cover and skip MusicBrainz
 *                        entirely
 *   opts.releaseId       likewise for a specific release
 *
 * Returns { data, mime, source } — source is one of 'embedded',
 * 'folder', 'caa-release-group', 'caa-release' or 'mb-search' — or null
 * when nothing was found.
 *
 * Never throws: the scanner calls this inline per album, and a network
 * blip must cost one cover, not the scan.
 */
async function findCoverArt(filePath, embeddedData, embeddedMime, artist, album, opts = {}) {
  if (embeddedData && embeddedData.length > 0) {
    return { data: embeddedData, mime: embeddedMime || 'image/jpeg', source: 'embedded' };
  }

  const folderArt = await findFolderArt(filePath ? path.dirname(filePath) : '');
  if (folderArt) return folderArt;

  const cacheKey = `${(artist||'').toLowerCase()}::${(album||'').toLowerCase()}`;
  if (artCache.has(cacheKey)) return artCache.get(cacheKey);

  const remoteArt = await fetchRemoteArt(artist, album, opts || {});
  if (remoteArt) cachePut(cacheKey, remoteArt);
  return remoteArt;
}

async function findFolderArt(dir) {
  if (!dir) return null;
  try {
    const entries = await fsp.readdir(dir);
    const lowerSet = new Set(entries.map(e => e.toLowerCase()));
    // First pass: preferred filenames
    for (const name of PREFERRED_NAMES) {
      for (const ext of IMAGE_EXTS) {
        const candidate = name + ext;
        if (lowerSet.has(candidate.toLowerCase())) {
          // Find the actual filename (case may differ)
          const actual = entries.find(e => e.toLowerCase() === candidate.toLowerCase());
          if (actual) {
            const img = await readImageFile(path.join(dir, actual));
            return img ? { ...img, source: 'folder' } : null;
          }
        }
      }
    }
    // Second pass: any image
    for (const entry of entries) {
      const ext = path.extname(entry).toLowerCase();
      if (IMAGE_EXTS.includes(ext)) {
        const img = await readImageFile(path.join(dir, entry));
        return img ? { ...img, source: 'folder' } : null;
      }
    }
  } catch (e) {
    // Silent by intent: the overwhelmingly common cause is a directory
    // we cannot read or that no longer exists (a removable drive, a
    // permissions quirk on a NAS share). "No folder art here" is the
    // correct answer to that, and the waterfall continues below.
  }
  return null;
}

async function readImageFile(filePath) {
  try {
    const data = await fsp.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    return { data, mime: extToMime(ext) };
  } catch (e) {
    // Same reasoning as findFolderArt: an unreadable file is a missing
    // cover, not an error the caller can do anything with.
    return null;
  }
}

function extToMime(ext) {
  const map = { '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png', '.webp':'image/webp', '.bmp':'image/bmp', '.gif':'image/gif', '.tiff':'image/tiff' };
  return map[ext] || 'image/jpeg';
}

// The User-Agent for Cover Art Archive requests. The archive does not
// require a contact the way MusicBrainz does, so a user who has not
// filled that field in still gets cover art — they just get it under
// the bare `musicd/<version>` form that buildUserAgent() returns for an
// empty contact.
function caaUserAgent() {
  return mbHttp.buildUserAgent(mbHttp.getContact());
}

/**
 * One request to the Cover Art Archive for an entity's front cover.
 * `entity` is 'release-group' or 'release'; `mbid` the id.
 * Returns { data, mime } or null. Never throws.
 */
async function fetchCaaFront(entity, mbid) {
  try {
    const res = await axios.get(`${CAA_BASE}/${entity}/${encodeURIComponent(mbid)}/front`, {
      responseType: 'arraybuffer',
      timeout: CAA_TIMEOUT_MS,
      maxRedirects: 5,
      headers: { 'User-Agent': caaUserAgent() },
    });
    if (res.status === 200 && res.data && res.data.byteLength > 0) {
      const contentType = res.headers['content-type'] || 'image/jpeg';
      return { data: Buffer.from(res.data), mime: contentType.split(';')[0].trim() };
    }
  } catch (e) {
    const status = e.response && e.response.status;
    // 404 is the archive's normal way of saying "nobody has uploaded a
    // front cover for this entity". That is an answer, not a failure,
    // and logging it would put a line in the journal for a large share
    // of every scan — so this one is silent on purpose.
    if (status !== 404) {
      log.warn(`archive lookup failed for ${entity} ${mbid}: ${e.message}`);
    }
  }
  return null;
}

/**
 * Steps 3 and 4 of the waterfall. Prefers an MBID we already hold;
 * falls back to a fuzzy MusicBrainz search only when we hold none.
 */
async function fetchRemoteArt(artist, album, opts) {
  // When the caller knows which release group this album is, the
  // archive can answer directly. This is the whole point of the
  // rewrite: no search, no guess, no MusicBrainz request at all.
  if (opts.releaseGroupId) {
    const art = await fetchCaaFront('release-group', opts.releaseGroupId);
    if (art) return { ...art, source: 'caa-release-group' };
    // A specific release of that group may carry art the group does
    // not, and asking costs one more CDN request and nothing from the
    // rate limit — so it is worth the second look when we have the id.
    if (opts.releaseId) {
      const relArt = await fetchCaaFront('release', opts.releaseId);
      if (relArt) return { ...relArt, source: 'caa-release' };
    }
    // Deliberately no fuzzy-search fallback here. We know exactly which
    // album this is; a text search can only return art belonging to
    // something else, at the cost of a rate-limited request.
    return null;
  }

  if (opts.releaseId) {
    const art = await fetchCaaFront('release', opts.releaseId);
    if (art) return { ...art, source: 'caa-release' };
    return null;
  }

  return await fetchSearchedArt(artist, album);
}

/**
 * Last resort: we hold no MBID for this album, so ask MusicBrainz which
 * releases look like it and try the archive on each in turn.
 *
 * Skipped entirely when no contact is configured. That is not a
 * degradation dressed up as a policy — the embedded-art and folder-art
 * passes above have already run, and for a user who has not filled in
 * the contact field their answer is the correct final answer.
 */
async function fetchSearchedArt(artist, album) {
  if (!artist || !album || artist === 'Unknown Artist' || album === 'Unknown Album') {
    return null;
  }

  const contact = mbHttp.getContact();
  if (!contact) return null;

  let releases;
  try {
    const data = await mbHttp.request('/release', {
      query: `artist:"${sanitize(artist)}" AND release:"${sanitize(album)}"`,
      limit: MB_SEARCH_LIMIT,
    }, { contact });
    releases = data && data.releases;
  } catch (e) {
    // Swallowed on purpose, and mbHttp has already recorded the failure
    // against the musicbrainz service health so the Settings page shows
    // it. findCoverArt is called inline per album by the scanner: a
    // rate-limit or an outage must cost this one cover, not the scan.
    log.warn(`release search failed for "${artist} — ${album}": ${e.message}`);
    return null;
  }

  if (!releases || releases.length === 0) return null;

  for (const release of releases) {
    const mbid = release.id;
    if (!mbid) continue;
    await new Promise(r => setTimeout(r, CAA_POLITE_GAP_MS));
    const art = await fetchCaaFront('release', mbid);
    if (art) return { ...art, source: 'mb-search' };
  }
  return null;
}

function sanitize(str) {
  return str.replace(/['"]/g, '').substring(0, 100);
}

module.exports = { findCoverArt };
