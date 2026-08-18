const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const chokidar = require('chokidar');
const { parseFile } = require('music-metadata');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const db = require('./db');
const { findCoverArt } = require('./coverArt');
const libraryScope = require('./libraryScope');

const SUPPORTED_FORMATS = new Set([
  '.flac', '.mp3', '.dsf', '.dff', '.dsd',
  '.wav', '.aiff', '.aif', '.ogg', '.opus', '.m4a', '.wv'
]);

const SCAN_CHUNK_SIZE = 16; // parallel files per batch

// ── Scan status (broadcast over WebSocket; readable via /api/library/status) ──
// Phase progression:
//   idle → walking → loading_existing → scanning → rebuilding_stats → enriching_art → idle
//   On startup with no DB: idle → walking → ... → idle (with isFirstScan: true)
const status = {
  phase: 'idle',          // 'idle' | 'walking' | 'loading_existing' | 'scanning' | 'rebuilding_stats' | 'enriching_art'
  startedAt: null,        // ms epoch when this scan run began
  finishedAt: null,
  totalFiles: 0,
  processedFiles: 0,
  added: 0,
  updated: 0,
  skipped: 0,
  artTotal: 0,
  artProcessed: 0,
  isFirstScan: false,     // true if DB had zero rows when scan began
  message: '',
  lastError: null,
};

function broadcastStatus() {
  if (global.broadcastState) global.broadcastState('library_status', { ...status });
}

function setPhase(phase, message) {
  status.phase = phase;
  if (message !== undefined) status.message = message;
  broadcastStatus();
}

function getStatus() { return { ...status }; }

// v1.1.0.92 — Album folder detection.
//
// The "album folder" is the directory that contains all the tracks
// of a single release. For most albums that's just `dirname(path)`.
// For multi-disc releases organised as one folder per disc:
//
//   /music/Pink Floyd/The Wall/CD1/01 In the Flesh.flac
//   /music/Pink Floyd/The Wall/CD2/01 Hey You.flac
//
// the album folder is `/music/Pink Floyd/The Wall/`, NOT the per-
// disc CD1/CD2 folder. We detect this by checking whether the
// parent directory name matches a "disc folder" pattern (CD1,
// CD 1, Disc 1, disc1, Disc-2, etc.). If so, we walk up one more
// level.
//
// Treats "CD" and "Disc" as synonymous per user spec.
//
// Examples:
//   /a/b/Album/CD1/track.flac → /a/b/Album      (multi-disc parent)
//   /a/b/Album/Disc 2/track.flac → /a/b/Album   (multi-disc parent)
//   /a/b/Album/track.flac → /a/b/Album          (flat album folder)
//   /a/b/Album/cd1/track.flac → /a/b/Album      (case-insensitive)
const DISC_FOLDER_RE = /^(?:cd|disc|disk)[\s_-]*\d+$/i;

function albumFolderFor(filePath) {
  const dir = path.dirname(filePath);
  const dirName = path.basename(dir);
  if (DISC_FOLDER_RE.test(dirName)) {
    return path.dirname(dir);
  }
  return dir;
}

// Same logic but returns the disc number (or null) for ordering
// tracks within a multi-disc album.
//
// Priority for picking the disc number:
//   1. The track's own disc tag (common.disk?.no) — the cleanest
//      source, written by the ripper into the file metadata
//   2. The folder name's number — handy when files are bare and
//      organised by folder but lack disc tags (very common for
//      old hand-ripped CD collections)
//   3. null — flat folder, single-disc, or unparseable
function discNumberFor(filePath, tagDiscNo) {
  if (tagDiscNo != null && tagDiscNo > 0) return tagDiscNo;
  const dirName = path.basename(path.dirname(filePath));
  const m = dirName.match(/^(?:cd|disc|disk)[\s_-]*(\d+)$/i);
  if (m) return parseInt(m[1], 10);
  return null;
}

// v1.1.0.92 — Album hash now folder-aware. The same album name in
// two different folders (e.g. Kind of Blue 16/44.1 vs Kind of Blue
// 24/192 in separate dirs) becomes two album entities so each shows
// once and tracks don't appear duplicated.
//
// The folder used is the *album folder* (see albumFolderFor), which
// for multi-disc releases is the parent of the per-disc folders so
// CD1/CD2 still group as one album.
function albumIdFor(albumArtist, albumTitle, albumFolder) {
  // If no folder given (legacy callers, like test fixtures),
  // fall back to the v77→v91 hash so we don't accidentally orphan
  // existing albums.
  const folder = albumFolder || '';
  return crypto.createHash('md5')
    .update(albumArtist + '\u0000' + albumTitle + '\u0000' + folder)
    .digest('hex');
}

function stripControl(s) {
  return typeof s === 'string' ? s.replace(/[\x00-\x1F\x7F]/g, '') : s;
}

// v1.1.0.97 — album type derivation.
//
// Returns one of: 'main' | 'ep' | 'single' | 'soundtrack' |
// 'deluxe' | 'limited'. The taxonomy is mutually exclusive — an
// album has a single primary type. When multiple signals fire
// (e.g. a deluxe-edition soundtrack), priority order resolves it.
//
// The canonical pattern matches and the priority order:
//
//   1. Soundtrack signals — most distinctive, run first because a
//      soundtrack can also be 'deluxe' on its title and we want
//      the soundtrack identity to win.
//   2. Deluxe / limited markers in title or folder.
//   3. Track-count / duration heuristics for EP/single discrimination.
//   4. Default to 'main'.
//
// MusicBrainz release-group secondary type (when present) is
// handled separately by the caller before falling back to this
// function — the MB type is authoritative when available.

const SOUNDTRACK_RE = /(?:\b(?:OST|O\.S\.T\.|soundtrack|original\s+(?:motion\s+picture\s+)?soundtrack|original\s+score|score|film\s+score|game\s+soundtrack)\b)/i;

// Deluxe markers: "(Deluxe Edition)", "[Deluxe]", "Deluxe Edition",
// "Bonus Tracks", "Anniversary Edition". The parenthesised form is
// most common but bare "Deluxe Edition" also appears.
const DELUXE_RE = /(?:\(deluxe(?:\s+edition)?\)|\[deluxe(?:\s+edition)?\]|\bdeluxe\s+edition\b|\(bonus\s+tracks?\)|\[bonus\s+tracks?\]|\banniversary\s+edition\b|\bextended\s+edition\b|\bexpanded\s+edition\b|\bsuper\s+deluxe\b)/i;

// Limited markers: "Limited Edition", "(Limited)", "Special Edition",
// "Collector's Edition". Distinct from deluxe — limited usually means
// pressing-quantity, deluxe usually means content-additions. Some
// overlap is fine; deluxe checked first wins.
const LIMITED_RE = /(?:\(limited(?:\s+edition)?\)|\[limited(?:\s+edition)?\]|\blimited\s+edition\b|\bspecial\s+edition\b|\bcollector(?:'s)?\s+edition\b)/i;

// EP markers in title — sometimes explicit. ".. - EP" is the iTunes
// convention; "(EP)" and bare "EP" also appear.
const EP_RE = /(?:\s+-\s+ep\b|\s+ep$|\(ep\)|\[ep\])/i;

// Single markers — same idea, much rarer in folder/tag layouts.
const SINGLE_RE = /(?:\s+-\s+single\b|\s+single$|\(single\)|\[single\])/i;

function deriveAlbumType(opts) {
  const {
    title = '',
    folder = '',
    trackCount = 0,
    totalDurationSec = 0,
    mbReleaseGroupTypes = [],   // array of MB secondary types
  } = opts || {};

  // 1. MusicBrainz authoritative when present. Common secondary
  // types we care about:
  //   - 'soundtrack'  → soundtrack
  //   - 'compilation' → main (we treat compilations as main albums
  //                     for browsing purposes)
  //   - 'live'        → main (live albums are full albums)
  //   - 'remix'       → main
  //   - 'demo'        → main
  // Primary types we treat:
  //   - 'ep'          → ep
  //   - 'single'      → single
  if (Array.isArray(mbReleaseGroupTypes)) {
    const lc = mbReleaseGroupTypes.map(t => String(t || '').toLowerCase());
    if (lc.includes('soundtrack')) return 'soundtrack';
    if (lc.includes('ep')) return 'ep';
    if (lc.includes('single')) return 'single';
  }

  // 2. Soundtrack signals from title or folder.
  if (SOUNDTRACK_RE.test(title) || SOUNDTRACK_RE.test(folder)) {
    return 'soundtrack';
  }

  // 3. Deluxe/limited (deluxe checked first — it's the more specific
  // claim about content rather than pressing quantity).
  if (DELUXE_RE.test(title) || DELUXE_RE.test(folder)) {
    return 'deluxe';
  }
  if (LIMITED_RE.test(title) || LIMITED_RE.test(folder)) {
    return 'limited';
  }

  // 4. Explicit EP/Single markers.
  if (EP_RE.test(title) || EP_RE.test(folder)) {
    return 'ep';
  }
  if (SINGLE_RE.test(title) || SINGLE_RE.test(folder)) {
    return 'single';
  }

  // 5. Track-count / duration heuristics. Apply only when we have
  // both metrics (trackCount > 0). The thresholds:
  //   ≤3 tracks                            → single
  //   4-7 tracks AND total duration <30min → ep
  //   anything else                        → main
  // Live albums and compilations often hit the EP threshold by
  // duration even though they're long-form (lots of short tracks);
  // we err on the side of 'main' by requiring BOTH bounds.
  if (trackCount > 0) {
    if (trackCount <= 3) return 'single';
    if (trackCount <= 7 && totalDurationSec > 0 && totalDurationSec < 30 * 60) {
      return 'ep';
    }
  }

  // 6. Default: full-length studio album.
  return 'main';
}

// v1.1.0.91 — normalise release-date strings from tag fields into a
// canonical YYYY-MM-DD or YYYY-MM or YYYY string. Music tags are wild:
//   "1982"        → keep
//   "1982-10-01"  → keep
//   "1982-10"     → keep
//   "Oct 1, 1982" → fail-soft (return null) — uncommon enough to ignore
//   "82"          → assume 1982 if 1900-1999 makes sense; we just don't
//                   try, return null
//   ""            → null
// The display layer falls back to the integer `year` column when this
// is null, so failing soft is fine.
function normaliseReleaseDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // YYYY-MM-DD
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const y = m[1], mo = m[2].padStart(2, '0'), d = m[3].padStart(2, '0');
    return `${y}-${mo}-${d}`;
  }
  // YYYY-MM
  m = s.match(/^(\d{4})-(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}`;
  // YYYY
  m = s.match(/^(\d{4})$/);
  if (m) return m[1];
  // YYYY/MM/DD or YYYY.MM.DD — convert to dashes
  m = s.match(/^(\d{4})[.\/](\d{1,2})[.\/](\d{1,2})$/);
  if (m) {
    const y = m[1], mo = m[2].padStart(2, '0'), d = m[3].padStart(2, '0');
    return `${y}-${mo}-${d}`;
  }
  return null;
}

async function scan(musicDir) {
  if (!fs.existsSync(musicDir)) {
    console.warn(`⚠️  Music directory not found: ${musicDir}`);
    status.lastError = 'Music directory not found';
    setPhase('idle');
    return;
  }

  // Reset status for this run
  status.startedAt = Date.now();
  status.finishedAt = null;
  status.totalFiles = 0;
  status.processedFiles = 0;
  status.added = 0; status.updated = 0; status.skipped = 0;
  status.artTotal = 0; status.artProcessed = 0;
  status.lastError = null;

  // Detect first scan = empty DB
  const database = db.get();
  const existingCount = database.prepare('SELECT COUNT(*) as c FROM tracks').get().c;
  status.isFirstScan = existingCount === 0;

  // Library scope (#30.9): determines which subfolders we scan. Empty scope
  // means "scan nothing"; the user has explicitly opted out of having any
  // library content. Existing v30.8 installs upgrading to v30.9 are
  // auto-seeded with [musicDir] on first read of the scope so behaviour
  // is unchanged for them.
  const scopePaths = libraryScope.getScope();
  if (scopePaths.length === 0) {
    console.log('🔍 Scan skipped — library scope is empty (no folders selected). Configure in Settings → Library.');
    // Still reconcile excluded flags: with an empty scope every track is excluded.
    reconcileExcludedFlags();
    status.finishedAt = Date.now();
    setPhase('idle', '');
    return;
  }

  console.log(`🔍 Scanning ${scopePaths.length} scope path${scopePaths.length === 1 ? '' : 's'}: ${scopePaths.join(', ')}`);
  setPhase('walking', `Looking for music files…`);

  // Walk each scope path independently. The accumulated file list drives
  // the rest of the scan exactly as before — once we have a flat list of
  // in-scope files, the existing per-file pipeline takes over.
  const files = [];
  for (const scopePath of scopePaths) {
    if (!fs.existsSync(scopePath)) {
      console.warn(`⚠️  Scope path missing: ${scopePath} — skipping`);
      continue;
    }
    files.push(...(await walkDir(scopePath)));
  }
  status.totalFiles = files.length;
  console.log(`📁 Found ${files.length} audio files in ${Math.round((Date.now() - status.startedAt) / 1000)}s`);
  broadcastStatus();

  // Bulk-load existing tracks into a Map
  setPhase('loading_existing', `Reading ${existingCount} existing tracks…`);
  const existingMap = new Map();
  for (const row of database.prepare('SELECT path, id, updated_at FROM tracks').all()) {
    existingMap.set(row.path, row);
  }
  console.log(`📋 ${existingMap.size} tracks already in DB`);

  setPhase('scanning', files.length > 0 ? `Reading metadata from ${files.length} files…` : '');
  let lastBroadcast = 0;
  for (let i = 0; i < files.length; i += SCAN_CHUNK_SIZE) {
    const batch = files.slice(i, i + SCAN_CHUNK_SIZE);
    // v1.1.1.1 — wrap each processFile in a defensive catch. processFile
    // already handles its own errors and returns 'skipped' on failure,
    // but a synchronous throw during stat() or other early-path code
    // could escape into Promise.all and abort the WHOLE scan after
    // partial progress. The wrapper turns any leaked exception into a
    // 'skipped' result so the scan continues. Belt-and-braces — in
    // practice processFile's try/catch covers everything I've seen.
    const results = await Promise.all(batch.map(p =>
      processFile(p, existingMap).catch(e => {
        console.warn(`[scan] unexpected throw from processFile(${p}):`, e?.message || e);
        return 'skipped';
      })
    ));
    for (const r of results) {
      if (r === 'added') status.added++;
      else if (r === 'updated') status.updated++;
      else status.skipped++;
    }
    status.processedFiles += batch.length;
    // Throttle WS broadcasts to 1/sec to avoid flooding the client
    const now = Date.now();
    if (now - lastBroadcast > 1000 || status.processedFiles === files.length) {
      lastBroadcast = now;
      broadcastStatus();
    }
    if (status.processedFiles % 2000 === 0 || status.processedFiles === files.length) {
      console.log(`  ... ${status.processedFiles} / ${files.length} (+${status.added} ~${status.updated} =${status.skipped})`);
    }
  }

  // Reconcile excluded flags. Even if no files were added, scope may have
  // changed (e.g. the user removed a folder mid-scan, or this is the first
  // scan after a scope edit). Cheap: a couple of UPDATEs over indexed cols.
  reconcileExcludedFlags();

  // Only rebuild stats / fetch art if something actually changed
  if (status.added > 0 || status.updated > 0) {
    setPhase('rebuilding_stats', 'Rebuilding album stats…');
    console.log('📊 Recomputing album stats...');
    db.rebuildAlbumStats();
    // v1.1.0.97 — derive album types now that track_count and
    // total_duration are fresh. The type uses MB release-group
    // secondary types (when matched), title/folder patterns, and
    // track-count/duration heuristics. See deriveAlbumType for
    // the full priority order.
    setPhase('classifying_albums', 'Classifying albums…');
    recomputeAlbumTypes();
    const took = Math.round((Date.now() - status.startedAt) / 1000);
    console.log(`✅ Scan complete in ${took}s — added ${status.added}, updated ${status.updated}`);
    // Run cover-art enrichment in the background.
    setPhase('enriching_art', 'Looking up missing cover art…');
    enrichMissingArt().then(() => {
      console.log('✅ Cover art enrichment complete');
      status.finishedAt = Date.now();
      setPhase('idle', '');
    }).catch(err => {
      console.warn('Cover art enrichment failed:', err.message);
      status.lastError = err.message;
      status.finishedAt = Date.now();
      setPhase('idle', '');
    });
  } else {
    const took = Math.round((Date.now() - status.startedAt) / 1000);
    console.log(`✅ Scan complete in ${took}s — no changes`);
    status.finishedAt = Date.now();
    setPhase('idle', '');
  }
}

/**
 * Update the `excluded` flag on every track and album to reflect the
 * current library scope. Tracks whose path falls under any active scope
 * entry get excluded=0; everything else gets excluded=1. Albums follow
 * their tracks: if any active track exists for an album, the album is
 * active. Otherwise it's excluded.
 *
 * We do this with two SQL passes rather than a per-row JS check because
 * SQLite's pattern matching is fast for a few thousand prefix tests.
 *
 * Cheap on a typical library — single-digit seconds even at 100k tracks.
 */
function reconcileExcludedFlags() {
  const database = db.get();
  const scope = libraryScope.getScope();

  database.transaction(() => {
    if (scope.length === 0) {
      // No scope — everything is excluded.
      database.prepare(`UPDATE tracks SET excluded = 1 WHERE excluded = 0`).run();
      database.prepare(`UPDATE albums SET excluded = 1 WHERE excluded = 0`).run();
      return;
    }

    // Build a single CASE expression that's true when the path is under
    // any scope entry. We use parameter binding for safety even though
    // scope values come from our own normaliser.
    //
    // Track rule: included iff path starts with one of the scope paths
    // (with a trailing slash, OR equals the scope path exactly — though
    // the equality case is unlikely for tracks since they're files).
    const conditions = scope.map(() => `(path = ? OR path LIKE ? || '/%')`).join(' OR ');
    const params = [];
    for (const p of scope) {
      params.push(p);
      params.push(p);
    }

    database.prepare(`
      UPDATE tracks
      SET excluded = CASE WHEN (${conditions}) THEN 0 ELSE 1 END
    `).run(...params);

    // Album rule: an album is active if it has at least one active track.
    // Compute that directly. Note: orphan albums (zero tracks at all) get
    // excluded=1 here too, which is what we want — they shouldn't be
    // visible in the UI either way.
    database.prepare(`
      UPDATE albums
      SET excluded = CASE
        WHEN EXISTS (
          SELECT 1 FROM tracks
          WHERE tracks.album = albums.title
            AND tracks.album_artist = albums.album_artist
            AND tracks.excluded = 0
        ) THEN 0
        ELSE 1
      END
    `).run();
  })();
}

async function walkDir(dir, _depth = 0, _seenInodes = new Set()) {
  const results = [];
  // v1.1.1.1 — protect against symlink loops. Some users symlink
  // /mnt/dietpi_userdata/4tb/Various into /mnt/dietpi_userdata/4tb,
  // which would walk forever without this. We track inodes of
  // already-visited directories and refuse to re-enter. Cap recursion
  // at a sanity depth too — a real music library doesn't nest 50 deep.
  if (_depth > 50) {
    console.warn(`[scan] walkDir bailing at depth ${_depth} for ${dir}`);
    return results;
  }
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      // v1.1.1.1 — handle symlinks. Pre-1.1.1.1 we silently skipped
      // every symlink because entry.isDirectory() is false for them
      // even when the target IS a directory. Users with their
      // library mounted via symlink saw empty scans. Now we resolve
      // the link, check what it points to, and recurse if it's a
      // directory (with loop protection via inode tracking).
      if (entry.isSymbolicLink()) {
        try {
          const stat = await fsp.stat(fullPath);  // follows link
          if (stat.isDirectory()) {
            const inode = `${stat.dev}:${stat.ino}`;
            if (_seenInodes.has(inode)) {
              console.warn(`[scan] symlink loop avoided: ${fullPath}`);
              continue;
            }
            _seenInodes.add(inode);
            results.push(...(await walkDir(fullPath, _depth + 1, _seenInodes)));
          } else if (stat.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if (SUPPORTED_FORMATS.has(ext)) results.push(fullPath);
          }
        } catch (e) {
          // Broken symlink — log once and skip. Don't fail the whole scan.
          console.warn(`[scan] broken symlink: ${fullPath} (${e.code || e.message})`);
        }
        continue;
      }
      if (entry.isDirectory()) {
        results.push(...(await walkDir(fullPath, _depth + 1, _seenInodes)));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SUPPORTED_FORMATS.has(ext)) results.push(fullPath);
      }
    }
  } catch (e) {
    // v1.1.1.1 — log instead of silent swallow. Most common is EACCES
    // (the user's library has a folder the container can't read). On
    // first install this is surprisingly common — a /lost+found dir
    // owned by root, or a folder the user copied with restrictive
    // permissions. With the silent swallow, the user saw "0 tracks
    // scanned" with no clue. Now they get a log line per unreadable
    // directory and can fix permissions or skip the path.
    console.warn(`[scan] walkDir ${dir}: ${e.code || ''} ${e.message}`);
  }
  return results;
}

async function processFile(filePath, existingMap) {
  const database = db.get();
  let stat;
  try { stat = await fsp.stat(filePath); } catch { return 'skipped'; }

  // If existingMap was provided (initial scan), look up there. Otherwise, fall back to DB.
  // The watcher path uses the DB lookup since map is only meaningful during the bulk scan.
  const existing = existingMap
    ? existingMap.get(filePath)
    : database.prepare('SELECT id, updated_at FROM tracks WHERE path = ?').get(filePath);

  if (existing && existing.updated_at >= Math.floor(stat.mtimeMs / 1000)) return 'skipped';

  try {
    const meta = await parseFile(filePath, { includeChapters: false, skipCovers: false });
    const common = meta.common;
    const format = meta.format;

    const id = existing ? existing.id : uuidv4();
    const ext = path.extname(filePath).toLowerCase();
    const isDSD = ['.dsf', '.dff', '.dsd'].includes(ext);

    // Embedded art only for the album row — not duplicated to tracks (#11)
    let coverArt = null;
    let coverArtMime = null;
    if (common.picture && common.picture.length > 0) {
      coverArt = common.picture[0].data;
      coverArtMime = common.picture[0].format;
    }
    if (!coverArt) {
      const folderResult = await findCoverArt(filePath, null, null,
        common.albumartist || common.artist || '',
        common.album || '');
      if (folderResult) {
        coverArt = folderResult.data;
        coverArtMime = folderResult.mime;
      }
    }

    let codec = format.codec || ext.replace('.', '').toUpperCase();
    if (isDSD) codec = 'DSD';

    const title = stripControl(common.title || path.basename(filePath, ext));
    const artist = stripControl(common.artist || common.albumartist || 'Unknown Artist');
    const albumArtist = stripControl(common.albumartist || common.artist || 'Unknown Artist');
    const album = stripControl(common.album || 'Unknown Album');
    const genre = (Array.isArray(common.genre) ? common.genre[0] : common.genre) || null;

    // v1.1.0.91 — release date extraction. music-metadata exposes
    // `common.date` (TEXT, often YYYY or YYYY-MM-DD), `common.year`
    // (INT), and `common.originaldate` (TEXT, sometimes more
    // precise). We pull the most specific value we can. If the tag
    // gives us only a year, we still write `release_date = "YYYY"`
    // so downstream code has a single field to look at; the display
    // layer formats it (year-only, or year+month, or full).
    const releaseDate = normaliseReleaseDate(
      common.originaldate || common.date || (common.year ? String(common.year) : null)
    );

    // v1.1.0.92 — album folder, disc number, album id.
    // The album folder is the directory that all tracks of this
    // album live under. Multi-disc releases collapse the per-disc
    // CD1/CD2/Disc 1 folders so all discs share one album entity.
    // The disc number prefers the file's own tag, falling back to
    // the disc-folder name for collections lacking disc tags.
    // The album id is now folder-aware so two copies of the same
    // album in different folders become two album rows.
    const albumFolder = albumFolderFor(filePath);
    const discNo = discNumberFor(filePath, common.disk?.no);
    const trackAlbumId = albumIdFor(albumArtist, album, albumFolder);

    database.prepare(`
      INSERT INTO tracks (
        id, path, filename, title, artist, album_artist, album,
        album_id, album_folder,
        year, release_date, track_number, disc_number, duration, bitrate,
        sample_rate, bit_depth, channels, format, codec,
        file_size, genre, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
      ON CONFLICT(path) DO UPDATE SET
        title=excluded.title, artist=excluded.artist, album_artist=excluded.album_artist,
        album=excluded.album,
        album_id=excluded.album_id, album_folder=excluded.album_folder,
        year=excluded.year, release_date=excluded.release_date,
        track_number=excluded.track_number,
        disc_number=excluded.disc_number, duration=excluded.duration, bitrate=excluded.bitrate,
        sample_rate=excluded.sample_rate, bit_depth=excluded.bit_depth, channels=excluded.channels,
        format=excluded.format, codec=excluded.codec, file_size=excluded.file_size,
        genre=excluded.genre, updated_at=unixepoch()
    `).run(
      id, filePath, path.basename(filePath),
      title, artist, albumArtist, album,
      trackAlbumId, albumFolder,
      common.year || null,
      releaseDate,
      common.track?.no || null,
      discNo,
      format.duration || null,
      format.bitrate ? Math.round(format.bitrate / 1000) : null,
      format.sampleRate || null,
      format.bitsPerSample || null,
      format.numberOfChannels || 2,
      ext.replace('.', ''),
      codec,
      stat.size,
      stripControl(genre),
    );

    ensureAlbum(albumArtist, album, common.year, coverArt, coverArtMime, ext.replace('.', ''), genre, {
      // Tag-sourced metadata IDs (#v1.1.0.20). music-metadata exposes
      // these as snake_case keys on `common` for any file format that
      // carries them (FLAC vorbis comments, ID3v2 TXXX:MUSICBRAINZ_*,
      // M4A iTunes-style atoms, etc.). The library quietly returns
      // undefined when a tag isn't present -- we map that to null.
      mb_release_group_id: common.musicbrainz_releasegroupid || null,
      mb_release_id:       common.musicbrainz_albumid || null,
      barcode:             common.barcode || null,
      // catalognumber is sometimes an array (multi-disc compilations
      // can have several catalog numbers); take the first if so.
      catalog_number: Array.isArray(common.catalognumber)
        ? common.catalognumber[0] || null
        : common.catalognumber || null,
    }, releaseDate, albumFolder);
    return existing ? 'updated' : 'added';
  } catch (e) {
    console.warn(`⚠️  Failed to read: ${filePath} — ${e.message}`);
    return 'skipped';
  }
}

function ensureAlbum(albumArtist, albumTitle, year, coverArt, coverArtMime, format, genre, tagIds = {}, releaseDate = null, albumFolder = null) {
  const database = db.get();
  // v1.1.0.92 — id now incorporates the album folder. Two copies of
  // the same album in different folders get different IDs, so they
  // surface as two album rows in the UI.
  const newId = albumIdFor(albumArtist, albumTitle, albumFolder);
  let existing = database.prepare(
    'SELECT id, cover_art, mb_release_group_id, barcode, catalog_number, release_date, album_folder FROM albums WHERE id = ?'
  ).get(newId);

  // v1.1.0.92 migration assist: when a track's album wasn't found by
  // its new (folder-aware) id, look for the legacy v77→v91 row (id
  // computed without folder) that this track logically used to belong
  // to. If found, rewrite that row's id to the new form in place.
  // FK tables that reference albums(id) (album_tags, anything else)
  // are updated in lockstep within a transaction so we don't orphan.
  //
  // Safety: this happens at most once per album. After the first
  // rescan post-v92, every album row has a folder-aware id.
  if (!existing && albumFolder) {
    const legacyId = crypto.createHash('md5')
      .update(albumArtist + '\u0000' + albumTitle)
      .digest('hex');
    const legacy = database.prepare(
      'SELECT id, cover_art, mb_release_group_id, barcode, catalog_number, release_date, album_folder FROM albums WHERE id = ?'
    ).get(legacyId);
    if (legacy) {
      // Migrate: rewrite this row's id to the new form, cascade FKs.
      // We do this in a transaction so a partial migration can't
      // orphan tag links etc.
      const migrate = database.transaction(() => {
        // Update FK tables first (UPDATE child rows that reference
        // the legacy id). The CASCADE clauses on the FKs only fire
        // on DELETE, not UPDATE, so we walk the references explicitly.
        try { database.prepare('UPDATE album_tags SET album_id = ? WHERE album_id = ?').run(newId, legacyId); } catch (e) {}
        try { database.prepare('UPDATE tracks SET album_id = ? WHERE album_id = ?').run(newId, legacyId); } catch (e) {}
        // Now move the album row itself.
        database.prepare('UPDATE albums SET id = ?, album_folder = ? WHERE id = ?').run(newId, albumFolder, legacyId);
      });
      try {
        migrate();
        existing = database.prepare(
          'SELECT id, cover_art, mb_release_group_id, barcode, catalog_number, release_date, album_folder FROM albums WHERE id = ?'
        ).get(newId);
      } catch (e) {
        // If the migration failed (e.g. another process raced us),
        // fall through to INSERT-OR-IGNORE which will produce a new
        // row. Worst case is one duplicate that the user can resolve
        // by deleting the orphan.
        console.warn(`[ensureAlbum] migration failed for ${legacyId}→${newId}: ${e.message}`);
      }
    }
  }

  // Tag-sourced metadata IDs (#v1.1.0.20). When the file's tags carry
  // a release-group MBID, we treat the album as already matched -- the
  // metadata matcher will skip it on its pending-albums sweep. Barcode
  // and catalog_number are stored even when not authoritative because
  // they sharpen subsequent MB queries when matching IS needed.
  const mbReleaseGroup = tagIds.mb_release_group_id || null;
  const mbRelease = tagIds.mb_release_id || null;
  const barcode = tagIds.barcode || null;
  const catno = tagIds.catalog_number || null;
  const id = newId;

  if (!existing) {
    database.prepare(`
      INSERT OR IGNORE INTO albums (
        id, title, artist, album_artist, year, release_date,
        album_folder,
        cover_art, cover_art_mime, primary_format, genre,
        mb_release_group_id, mb_release_id, barcode, catalog_number,
        match_status, match_confidence, matched_at, matched_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, albumTitle, albumArtist, albumArtist, year || null, releaseDate,
      albumFolder,
      coverArt, coverArtMime, format || null, stripControl(genre) || null,
      mbReleaseGroup, mbRelease, barcode, catno,
      // If we have a release-group MBID from tags, mark as matched
      // immediately. Otherwise leave at default 'pending' so the
      // matcher picks it up.
      mbReleaseGroup ? 'matched' : 'pending',
      mbReleaseGroup ? 100 : null,
      mbReleaseGroup ? Math.floor(Date.now() / 1000) : null,
      // matched_by='tag' marks this as authoritative-from-file so a
      // subsequent matcher reset doesn't undo it (#v1.1.0.21).
      mbReleaseGroup ? 'tag' : null,
    );
  } else {
    // Existing album: update cover art if missing, and back-fill any
    // tag-sourced metadata IDs that weren't previously known. We never
    // overwrite an MBID that's already there -- a manually-confirmed
    // match by the user beats a tag (the tag could be wrong; manual
    // intent is authoritative). We DO promote a pending album to
    // matched if the tag now provides a release-group ID.
    if (!existing.cover_art && coverArt) {
      database.prepare('UPDATE albums SET cover_art=?, cover_art_mime=? WHERE id=?').run(coverArt, coverArtMime, id);
    }
    // v1.1.0.91 — back-fill release_date if we now have one and the
    // album row didn't. Don't overwrite an existing release_date —
    // user-curated matches may have set a more authoritative value.
    if (releaseDate && !existing.release_date) {
      database.prepare('UPDATE albums SET release_date=? WHERE id=?').run(releaseDate, id);
    }
    // v1.1.0.92 — back-fill album_folder. Existing rows from before
    // the migration will have NULL here; once we know the folder we
    // record it. (Doesn't change the album id because for existing
    // rows the id was computed from title+artist+null-folder; the
    // hash collision is benign on the migration sweep.)
    if (albumFolder && !existing.album_folder) {
      database.prepare('UPDATE albums SET album_folder=? WHERE id=?').run(albumFolder, id);
    }
    const updates = [];
    const params = [];
    if (mbReleaseGroup && !existing.mb_release_group_id) {
      updates.push('mb_release_group_id = ?', 'match_status = ?', 'match_confidence = ?', 'matched_at = ?', 'matched_by = ?');
      params.push(mbReleaseGroup, 'matched', 100, Math.floor(Date.now() / 1000), 'tag');
    }
    if (mbRelease) {
      updates.push('mb_release_id = COALESCE(mb_release_id, ?)');
      params.push(mbRelease);
    }
    if (barcode && !existing.barcode) {
      updates.push('barcode = ?');
      params.push(barcode);
    }
    if (catno && !existing.catalog_number) {
      updates.push('catalog_number = ?');
      params.push(catno);
    }
    if (updates.length > 0) {
      params.push(id);
      database.prepare(`UPDATE albums SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    }
  }
}

// v1.1.0.97 — Recompute album_type for every album using
// deriveAlbumType. Called from scan() after rebuildAlbumStats so
// the helper has fresh track_count and total_duration. Cheap —
// one SELECT for the input row, one UPDATE per album, no network
// or filesystem work.
//
// v1.1.0.98 — respects album_type_locked. Albums where the user
// has manually set a type (POST /albums/:id/type) are skipped so
// the override survives subsequent rescans. The lock can be
// cleared via the same endpoint with {auto:true}.
//
// Runs in a single transaction so a partial run can't leave the
// table inconsistent.
function recomputeAlbumTypes() {
  const database = db.get();
  const rows = database.prepare(`
    SELECT id, title, album_folder, track_count, total_duration
    FROM albums
    WHERE excluded = 0
      AND COALESCE(album_type_locked, 0) = 0
  `).all();

  if (rows.length === 0) {
    console.log('🏷️  No albums to classify');
    return;
  }

  const update = database.prepare('UPDATE albums SET album_type = ? WHERE id = ?');
  const counts = { main: 0, ep: 0, single: 0, soundtrack: 0, deluxe: 0, limited: 0 };
  const tx = database.transaction(() => {
    for (const r of rows) {
      const type = deriveAlbumType({
        title: r.title || '',
        folder: r.album_folder || '',
        trackCount: r.track_count || 0,
        totalDurationSec: r.total_duration || 0,
        mbReleaseGroupTypes: [],   // not yet stored — see schema notes
      });
      update.run(type, r.id);
      counts[type] = (counts[type] || 0) + 1;
    }
  });
  tx();

  const summary = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}=${n}`)
    .join(' ');
  console.log(`🏷️  Album types classified: ${summary}`);
}

async function enrichMissingArt() {
  const database = db.get();
  const missing = database.prepare(`
    SELECT a.id, a.title, a.album_artist,
           (SELECT path FROM tracks WHERE album = a.title AND album_artist = a.album_artist LIMIT 1) as sample_path
    FROM albums a WHERE a.cover_art IS NULL
  `).all();

  status.artTotal = missing.length;
  status.artProcessed = 0;
  console.log(`🎨 ${missing.length} albums missing cover art, querying MusicBrainz...`);
  if (missing.length > 0) broadcastStatus();

  let lastBroadcast = 0;
  for (const album of missing) {
    try {
      const art = await findCoverArt(album.sample_path || '', null, null, album.album_artist, album.title);
      if (art) {
        database.prepare('UPDATE albums SET cover_art = ?, cover_art_mime = ? WHERE id = ?')
          .run(art.data, art.mime, album.id);
        console.log(`  ✓ ${album.album_artist} — ${album.title}`);
      }
    } catch (e) {}
    status.artProcessed++;
    const now = Date.now();
    if (now - lastBroadcast > 2000 || status.artProcessed === status.artTotal) {
      lastBroadcast = now;
      broadcastStatus();
    }
  }
}

/**
 * Called by the scope API endpoints after a scope mutation. Reconciles
 * the excluded flags immediately (so the UI reflects the change without
 * waiting for a scan) and triggers a scan of the new tree if the change
 * was an addition. Removals don't need a scan — soft-delete via flag
 * flip is enough.
 *
 * `addedPath`: optional absolute path under /music that was added to
 * scope. If provided, a scan is kicked off for that subtree only. The
 * scan reuses the global scan() infrastructure so it shares the
 * progress reporting and art-fetch tail.
 */
async function applyScopeChange({ addedPath } = {}) {
  reconcileExcludedFlags();
  if (addedPath) {
    // We don't have a single-folder scan helper — scan() walks the entire
    // active scope, which is what we want anyway. The newly added folder
    // is in scope now, so a normal scan picks it up. Existing folders
    // skip quickly because their tracks already exist in existingMap.
    //
    // We pass MUSIC_ROOT just because scan() requires a musicDir argument
    // for its existence check. The actual files come from the scope list.
    await scan(libraryScope.MUSIC_ROOT);
  } else {
    // Removal-only — broadcast an event so the UI refreshes without
    // running a full scan.
    if (global.broadcastState) {
      global.broadcastState('library_updated', { reason: 'scope_changed' });
    }
  }
}

let activeWatcher = null;

function stopWatcher() {
  if (activeWatcher) { try { activeWatcher.close(); } catch {} activeWatcher = null; }
}

function watch(musicDir) {
  // Polling is required for Docker bind mounts and NFS/SMB shares — inotify doesn't propagate.
  // Set CHOKIDAR_USEPOLLING=0 in env to disable if your setup supports inotify.
  const usePolling = process.env.CHOKIDAR_USEPOLLING === '0' ? false : true;
  const watcher = chokidar.watch(musicDir, {
    ignored: /(^|[\/\\])\../,
    persistent: true,
    ignoreInitial: true,
    usePolling,
    interval: 30000,        // poll every 30s (light on CPU + IO)
    binaryInterval: 60000,  // already-stable files polled less aggressively
    awaitWriteFinish: { stabilityThreshold: 5000, pollInterval: 500 },
  });
  console.log(`👁  Watcher: ${usePolling ? 'polling enabled (30s interval)' : 'inotify mode'}`);

  watcher
    .on('add', async (filePath) => {
      const ext = path.extname(filePath).toLowerCase();
      if (!SUPPORTED_FORMATS.has(ext)) return;
      // Scope check (#30.9): if the user has narrowed scope, skip events
      // for files outside it. We re-read the scope on each event because
      // the cost is negligible and the user can change scope live.
      if (!libraryScope.isPathInScope(filePath)) return;
      await processFile(filePath);
      if (global.broadcastState) global.broadcastState('library_updated', { path: filePath });
    })
    .on('unlink', (filePath) => {
      const database = db.get();
      // Look up the album_artist/album of the file we're about to delete so
      // we can check whether deleting it leaves the album with zero tracks
      // (orphan). Without this, the album row lingers in the UI until the
      // next full scan rebuilds stats.
      const track = database.prepare(
        'SELECT album, album_artist FROM tracks WHERE path = ?'
      ).get(filePath);
      database.prepare('DELETE FROM tracks WHERE path = ?').run(filePath);
      if (track) {
        const remaining = database.prepare(
          'SELECT COUNT(*) AS n FROM tracks WHERE album = ? AND album_artist = ?'
        ).get(track.album, track.album_artist);
        if (remaining && remaining.n === 0) {
          database.prepare(
            'DELETE FROM albums WHERE title = ? AND album_artist = ?'
          ).run(track.album, track.album_artist);
        } else {
          // Album still has tracks — refresh its stats so duration/track_count
          // reflect the deletion. Cheap (one UPDATE per affected album).
          database.prepare(`
            UPDATE albums SET
              track_count    = (SELECT COUNT(*)         FROM tracks WHERE album = albums.title AND album_artist = albums.album_artist),
              total_duration = (SELECT COALESCE(SUM(duration), 0) FROM tracks WHERE album = albums.title AND album_artist = albums.album_artist)
            WHERE title = ? AND album_artist = ?
          `).run(track.album, track.album_artist);
        }
      }
      if (global.broadcastState) global.broadcastState('library_updated', { deleted: filePath });
    });

  console.log(`👁  Watching for changes: ${musicDir}`);
  activeWatcher = watcher;
  return watcher;
}

module.exports = { scan, watch, stopWatcher, processFile, albumIdFor, getStatus, applyScopeChange, reconcileExcludedFlags, recomputeAlbumTypes, deriveAlbumType };
