const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const axios = require('axios');

const PREFERRED_NAMES = [
  'cover', 'folder', 'front', 'album', 'artwork', 'art',
  'Cover', 'Folder', 'Front', 'Album', 'Artwork', 'Art',
];
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.tiff'];
const MB_HEADERS = { 'User-Agent': 'musicd/1.0 (self-hosted)' };

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

let lastMBRequest = 0;

async function findCoverArt(filePath, embeddedData, embeddedMime, artist, album) {
  if (embeddedData && embeddedData.length > 0) {
    return { data: embeddedData, mime: embeddedMime || 'image/jpeg' };
  }

  const folderArt = await findFolderArt(filePath ? path.dirname(filePath) : '');
  if (folderArt) return folderArt;

  const cacheKey = `${(artist||'').toLowerCase()}::${(album||'').toLowerCase()}`;
  if (artCache.has(cacheKey)) return artCache.get(cacheKey);

  const mbArt = await fetchMBArt(artist, album);
  if (mbArt) cachePut(cacheKey, mbArt);
  return mbArt;
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
          if (actual) return await readImageFile(path.join(dir, actual));
        }
      }
    }
    // Second pass: any image
    for (const entry of entries) {
      const ext = path.extname(entry).toLowerCase();
      if (IMAGE_EXTS.includes(ext)) {
        return await readImageFile(path.join(dir, entry));
      }
    }
  } catch (e) {}
  return null;
}

async function readImageFile(filePath) {
  try {
    const data = await fsp.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    return { data, mime: extToMime(ext) };
  } catch (e) { return null; }
}

function extToMime(ext) {
  const map = { '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png', '.webp':'image/webp', '.bmp':'image/bmp', '.gif':'image/gif', '.tiff':'image/tiff' };
  return map[ext] || 'image/jpeg';
}

async function fetchMBArt(artist, album) {
  if (!artist || !album || artist === 'Unknown Artist' || album === 'Unknown Album') {
    return null;
  }

  const now = Date.now();
  const wait = 1100 - (now - lastMBRequest);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastMBRequest = Date.now();

  try {
    const searchRes = await axios.get('https://musicbrainz.org/ws/2/release', {
      params: {
        query: `artist:"${sanitize(artist)}" AND release:"${sanitize(album)}"`,
        fmt: 'json',
        limit: 5,
      },
      headers: MB_HEADERS,
      timeout: 6000,
    });

    const releases = searchRes.data?.releases;
    if (!releases || releases.length === 0) return null;

    for (const release of releases) {
      const mbid = release.id;
      if (!mbid) continue;
      try {
        await new Promise(r => setTimeout(r, 300));
        const caaRes = await axios.get(
          `https://coverartarchive.org/release/${mbid}/front`,
          { responseType: 'arraybuffer', timeout: 8000, maxRedirects: 5, headers: { 'User-Agent': MB_HEADERS['User-Agent'] } }
        );
        if (caaRes.status === 200 && caaRes.data?.byteLength > 0) {
          const contentType = caaRes.headers['content-type'] || 'image/jpeg';
          return { data: Buffer.from(caaRes.data), mime: contentType.split(';')[0].trim() };
        }
      } catch (e) { continue; }
    }
  } catch (e) {}
  return null;
}

function sanitize(str) {
  return str.replace(/['"]/g, '').substring(0, 100);
}

module.exports = { findCoverArt };
