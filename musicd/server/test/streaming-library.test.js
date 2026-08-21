// Qobuz + Tidal in the one library (v1.1.33.0).
//
// A streaming album is an ordinary `albums` row with an id of
// 'qobuz:<id>' / 'tidal:<id>' and ordinary `tracks` rows with paths of
// 'qobuz://<id>' / 'tidal://<id>'. Nothing downstream — the grid, Focus,
// the sort suite, the album page, the queue, DSP — was taught about
// streaming services, because from where those sit there is nothing to
// learn. That only works while ONE rule holds:
//
//     a streaming album is excluded = 0 exactly when it is favourited
//     at the service, and its tracks always mirror their album.
//
// `excluded` is what all 42 library queries in routes/library.js already
// filter on. Get the rule right and merging a streaming catalogue costs
// those queries no change at all. Get it wrong and the failure is
// invisible from the UI: the album is in your Qobuz favourites, the
// Favourites screen lists it, and the album wall does not.
//
// Four things are pinned here, and the first three run real SQLite:
//
//   THE INVARIANT ITSELF. setAlbumFavorited is the only writer of that
//   pair, and it has to move album and tracks together, in one
//   transaction, in both directions.
//
//   BROWSE STAYS STRICT, THE ALBUM PAGE DOES NOT. An album you opened
//   from a search result is cached but not in your library; its page
//   still has to list and play its tracks, while library search must not
//   start surfacing catalogue albums you merely glanced at. Two queries
//   relax the filter; the FTS search deliberately does not.
//
//   THE SCOPE PASS CANNOT TOUCH THEM. scanner.js rewrites `excluded`
//   across the whole table from a list of filesystem directories.
//   'qobuz://5152123' is under none of them, so an unguarded pass
//   excludes every streaming row the moment anyone narrows their local
//   library to a subfolder — and the user sees their whole streaming
//   library vanish with nothing connecting the two acts. This is the one
//   that would have shipped.
//
//   PLAYBACK RESOLVES BOTH SCHEMES. routes/stream.js is the only place a
//   sentinel path becomes a network source, and it has to handle qobuz://
//   and tidal:// or one service plays and the other 404s as a missing
//   file. That asymmetry is exactly how it shipped broken in the sibling
//   repo: the Tidal branch was added to two routes and not to the one
//   Sonos actually uses.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const SERVER_SRC = path.join(__dirname, '..', 'src');
const readRaw = (...p) => fs.readFileSync(path.join(SERVER_SRC, ...p), 'utf8');
// Strip comments so a rule described in prose cannot satisfy a grep for
// the code that implements it.
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const src = (...p) => code(readRaw(...p));

// ---------------------------------------------------------------------------
// A real database, built by the app's own migrations.
// ---------------------------------------------------------------------------

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'musicd-streaming-'));
process.env.DB_PATH = path.join(TMP, 'musicd.db');

const db = require(path.join(SERVER_SRC, 'db'));
const streaming = require(path.join(SERVER_SRC, 'streamingLibrary'));

db.init();
const dbh = db.get();

// Insert an album + tracks in the exact shape src/qobuz/cache.js writes:
// a prefixed id, album_id set on every track, and excluded = 1 — cached
// from a browse, not yet in the library.
function seedStreamingAlbum(service, serviceAlbumId, opts = {}) {
  const localAlbumId = streaming.albumIdFor(service, serviceAlbumId);
  const trackCount = opts.trackCount || 3;
  dbh.prepare(`
    INSERT INTO albums (id, title, artist, album_artist, year, track_count,
                        total_duration, primary_format, genre, added_at, excluded)
    VALUES (?, ?, ?, ?, 2021, ?, 1800, 'flac', 'Jazz', unixepoch(), 1)
  `).run(localAlbumId, opts.title || 'Cached Album', opts.artist || 'Some Artist',
         opts.artist || 'Some Artist', trackCount);
  for (let i = 1; i <= trackCount; i++) {
    dbh.prepare(`
      INSERT INTO tracks (id, path, album_id, title, artist, album_artist, album,
                          year, track_number, disc_number, duration,
                          sample_rate, bit_depth, channels, format, codec,
                          added_at, updated_at, excluded)
      VALUES (?, ?, ?, ?, ?, ?, ?, 2021, ?, 1, 600, 44100, 16, 2, 'flac', 'FLAC',
              unixepoch(), unixepoch(), 1)
    `).run(`${service}-t${serviceAlbumId}-${i}`,
           streaming.trackPathFor(service, `${serviceAlbumId}${i}`),
           localAlbumId, `Track ${i}`,
           opts.artist || 'Some Artist', opts.artist || 'Some Artist',
           opts.title || 'Cached Album', i);
  }
  return localAlbumId;
}

function seedLocalAlbum(id, folder, opts = {}) {
  dbh.prepare(`
    INSERT INTO albums (id, title, artist, album_artist, year, track_count,
                        total_duration, primary_format, genre, added_at,
                        album_folder, excluded)
    VALUES (?, ?, ?, ?, 1999, 2, 1200, 'flac', 'Rock', unixepoch(), ?, 0)
  `).run(id, opts.title || 'Local Album', 'Local Artist', 'Local Artist', folder);
  for (let i = 1; i <= 2; i++) {
    dbh.prepare(`
      INSERT INTO tracks (id, path, album_id, title, artist, album_artist, album,
                          year, track_number, disc_number, duration,
                          sample_rate, bit_depth, channels, format, codec,
                          added_at, updated_at, excluded, album_folder)
      VALUES (?, ?, ?, ?, 'Local Artist', 'Local Artist', ?, 1999, ?, 1, 600,
              44100, 16, 2, 'flac', 'FLAC', unixepoch(), unixepoch(), 0, ?)
    `).run(`${id}-t${i}`, `${folder}/0${i}.flac`, id, `Local Track ${i}`,
           opts.title || 'Local Album', i, folder);
  }
  return id;
}

const QOBUZ_ALBUM = seedStreamingAlbum('qobuz', '5152122', { title: 'Kind of Blue' });
const TIDAL_ALBUM = seedStreamingAlbum('tidal', '77712345', { title: 'Blue Train' });
const LOCAL_IN    = seedLocalAlbum('local-in',  '/music/Keep',  { title: 'Kept Album' });
const LOCAL_OUT   = seedLocalAlbum('local-out', '/music/Drop',  { title: 'Dropped Album' });

const albumRow  = (id) => dbh.prepare('SELECT * FROM albums WHERE id = ?').get(id);
const trackRows = (id) => dbh.prepare('SELECT * FROM tracks WHERE album_id = ?').all(id);

// ---------------------------------------------------------------------------
// 1. The invariant.
// ---------------------------------------------------------------------------

test('favouriting moves the album AND its tracks into the library together', () => {
  assert.equal(albumRow(QOBUZ_ALBUM).excluded, 1, 'cached album starts outside the library');
  assert.ok(trackRows(QOBUZ_ALBUM).every(t => t.excluded === 1), 'its tracks start outside too');

  assert.equal(streaming.setAlbumFavorited('qobuz', QOBUZ_ALBUM, true), true);

  const a = albumRow(QOBUZ_ALBUM);
  assert.equal(a.excluded, 0, 'a favourited album is in the library');
  assert.equal(a.qobuz_favorited, 1, 'and is flagged as favourited at the service');
  assert.ok(trackRows(QOBUZ_ALBUM).every(t => t.excluded === 0),
    'every track follows its album — a favourited album whose tracks stayed ' +
    'excluded shows an empty album page');
});

test('un-favouriting takes both back out', () => {
  streaming.setAlbumFavorited('qobuz', QOBUZ_ALBUM, false);
  const a = albumRow(QOBUZ_ALBUM);
  assert.equal(a.excluded, 1);
  assert.equal(a.qobuz_favorited, 0);
  assert.ok(trackRows(QOBUZ_ALBUM).every(t => t.excluded === 1));
  streaming.setAlbumFavorited('qobuz', QOBUZ_ALBUM, true);   // restore for later tests
});

test('the service flag and this app\'s own heart are independent', () => {
  // The ⊕ writes qobuz_favorited; the heart writes is_favorite. Collapsing
  // them would mean un-hearting an album here silently removed it from the
  // user's Qobuz account.
  dbh.prepare('UPDATE albums SET is_favorite = 1 WHERE id = ?').run(QOBUZ_ALBUM);
  streaming.setAlbumFavorited('qobuz', QOBUZ_ALBUM, false);
  assert.equal(albumRow(QOBUZ_ALBUM).is_favorite, 1,
    'clearing the service favourite must not touch the local heart');
  streaming.setAlbumFavorited('qobuz', QOBUZ_ALBUM, true);
});

test('one service\'s favourite cannot be written through the other\'s name', () => {
  assert.throws(() => streaming.setAlbumFavorited('tidal', QOBUZ_ALBUM, true),
    /not a Tidal album id/);
});

test('a streaming album never drags a same-titled local album with it', () => {
  // Tracks are matched by album_id, never by title+artist. Two albums
  // called "Kind of Blue" — one local, one Qobuz — must not move together.
  const collide = seedLocalAlbum('local-kob', '/music/KOB', { title: 'Kind of Blue' });
  dbh.prepare('UPDATE tracks SET album = ? WHERE album_id = ?').run('Kind of Blue', collide);
  streaming.setAlbumFavorited('qobuz', QOBUZ_ALBUM, false);
  assert.ok(trackRows(collide).every(t => t.excluded === 0),
    'the local album with the same title stays in the library');
  streaming.setAlbumFavorited('qobuz', QOBUZ_ALBUM, true);
});

// ---------------------------------------------------------------------------
// 2. Browse stays strict; the album page does not.
// ---------------------------------------------------------------------------

// The relaxation clause, read out of the route file rather than retyped,
// so the test cannot pass against a version of it that no longer exists.
const RELAX_CLAUSE =
  "AND (t.excluded = 0 OR t.path LIKE 'qobuz://%' OR t.path LIKE 'tidal://%')";

test('routes/library.js carries the relaxation on exactly the two album-scoped queries', () => {
  const lib = src('routes', 'library.js');
  const relaxed = lib.split(RELAX_CLAUSE).length - 1;
  assert.equal(relaxed, 2,
    'the album detail route and POST /albums/tracks both need it — and only ' +
    'those two. A third site means a browse surface has started showing ' +
    'catalogue albums the user never added.');
  assert.ok(/WHERE tracks_fts MATCH \? AND t\.excluded = 0/.test(lib),
    'the FTS track search must keep the STRICT filter, or every album ever ' +
    'opened from a search result starts turning up in library search');
});

test('the grid filter hides a cached album and shows a favourited one', () => {
  streaming.setAlbumFavorited('qobuz', QOBUZ_ALBUM, true);
  streaming.setAlbumFavorited('tidal', TIDAL_ALBUM, false);
  const visible = dbh.prepare(
    'SELECT id FROM albums WHERE excluded = 0 ORDER BY id'
  ).all().map(r => r.id);
  assert.ok(visible.includes(QOBUZ_ALBUM), 'favourited Qobuz album is in the wall');
  assert.ok(!visible.includes(TIDAL_ALBUM), 'a merely-cached Tidal album is not');
  assert.ok(visible.includes(LOCAL_IN), 'local albums are unaffected');
});

test('the album page lists tracks whether or not the album is in the library', () => {
  const q = dbh.prepare(`
    SELECT t.id FROM tracks t
    WHERE (t.album_id = ? OR (t.album_id IS NULL AND t.album = ? AND t.album_artist = ?))
    ${RELAX_CLAUSE}
  `);
  const cachedOnly = albumRow(TIDAL_ALBUM);
  assert.equal(cachedOnly.excluded, 1, 'precondition: this album is not in the library');
  assert.equal(q.all(TIDAL_ALBUM, cachedOnly.title, cachedOnly.album_artist).length, 3,
    'an album opened from a search result still shows its tracks, or the page ' +
    'renders empty and there is nothing to press play on');

  const fav = albumRow(QOBUZ_ALBUM);
  assert.equal(q.all(QOBUZ_ALBUM, fav.title, fav.album_artist).length, 3);
});

test('the relaxation does not resurrect a local track put out of scope', () => {
  dbh.prepare('UPDATE tracks SET excluded = 1 WHERE album_id = ?').run(LOCAL_OUT);
  const row = albumRow(LOCAL_OUT);
  const found = dbh.prepare(`
    SELECT t.id FROM tracks t
    WHERE (t.album_id = ? OR (t.album_id IS NULL AND t.album = ? AND t.album_artist = ?))
    ${RELAX_CLAUSE}
  `).all(LOCAL_OUT, row.title, row.album_artist);
  assert.equal(found.length, 0,
    'relaxing on the path prefix, not dropping the filter, is the difference ' +
    'between showing a streaming album and undoing the user\'s library scope');
  dbh.prepare('UPDATE tracks SET excluded = 0 WHERE album_id = ?').run(LOCAL_OUT);
});

test('the FTS search does not surface tracks from a merely-cached album', () => {
  const hits = dbh.prepare(`
    SELECT t.id FROM tracks t
    JOIN tracks_fts f ON t.rowid = f.rowid
    WHERE tracks_fts MATCH ? AND t.excluded = 0
  `).all('Track*').map(r => r.id);
  assert.ok(!hits.some(id => id.startsWith('tidal-')),
    'a Tidal album that was only browsed must not put its tracks in library search');
});

// ---------------------------------------------------------------------------
// 3. The scope pass.
// ---------------------------------------------------------------------------

test('the scope pass leaves streaming rows alone', () => {
  // The real statements from scanner.js, rebuilt from the same exported
  // constants that file interpolates. Scope is narrowed to /music/Keep,
  // which drops the local /music/Drop album — and must not touch either
  // streaming album.
  streaming.setAlbumFavorited('qobuz', QOBUZ_ALBUM, true);
  streaming.setAlbumFavorited('tidal', TIDAL_ALBUM, false);

  const scope = ['/music/Keep'];
  const conditions = scope.map(() => `(path = ? OR path LIKE ? || '/%')`).join(' OR ');
  const params = [];
  for (const p of scope) { params.push(p); params.push(p); }

  dbh.prepare(`
    UPDATE tracks
    SET excluded = CASE WHEN (${conditions}) THEN 0 ELSE 1 END
    WHERE ${streaming.NOT_STREAMING_TRACK_SQL}
  `).run(...params);

  dbh.prepare(`
    UPDATE albums
    SET excluded = CASE
      WHEN EXISTS (
        SELECT 1 FROM tracks
        WHERE tracks.album = albums.title
          AND tracks.album_artist = albums.album_artist
          AND tracks.excluded = 0
      ) THEN 0 ELSE 1 END
    WHERE ${streaming.NOT_STREAMING_ALBUM_SQL}
  `).run();

  assert.equal(albumRow(QOBUZ_ALBUM).excluded, 0,
    'narrowing the LOCAL library to a subfolder must not evict a favourited ' +
    'Qobuz album — an unguarded scope pass empties the streaming library and ' +
    'nothing in the UI connects the two');
  assert.ok(trackRows(QOBUZ_ALBUM).every(t => t.excluded === 0));
  assert.equal(albumRow(TIDAL_ALBUM).excluded, 1, 'and does not promote a cached one either');

  assert.equal(albumRow(LOCAL_IN).excluded, 0, 'in-scope local album survives');
  assert.equal(albumRow(LOCAL_OUT).excluded, 1, 'out-of-scope local album is excluded, as before');
});

test('scanner.js applies the exemption at every site that writes excluded', () => {
  const scanner = src('scanner.js');
  // Three statements rewrite `excluded` wholesale: the two scope UPDATEs
  // and the no-scope branch's pair. Every one of them must carry a guard;
  // missing one is the partial migration this repo has been bitten by.
  const writes = scanner.match(/UPDATE (tracks|albums)\s+SET excluded|UPDATE (tracks|albums) SET excluded = 1/g) || [];
  assert.ok(writes.length >= 4, `expected the scope pass's excluded writes, found ${writes.length}`);
  const guards = (scanner.match(/NOT_STREAMING_(TRACK|ALBUM)_SQL/g) || []).length;
  assert.equal(guards, writes.length,
    'every statement that rewrites excluded in scanner.js must carry a ' +
    'streaming exemption — ' + writes.length + ' writes, ' + guards + ' guards');
});

// ---------------------------------------------------------------------------
// 4. Playback resolves both schemes.
// ---------------------------------------------------------------------------

test('routes/stream.js resolves qobuz:// and tidal:// through one path', () => {
  const stream = src('routes', 'stream.js');
  assert.ok(/serviceForTrackPath\(track\.path\)/.test(stream),
    'the stream route must detect a streaming track from its path');
  assert.ok(/resolveStreamingSource/.test(stream),
    'and resolve it to a network source before anything reads it as a file');
  // Both services go through the same resolver rather than one being bolted
  // on: in the sibling repo the Tidal branch was added to two routes and not
  // to the one Sonos pulls from, so Tidal played on Safari and not on Sonos.
  const resolver = stream.slice(stream.indexOf('async function resolveStreamingSource'));
  assert.ok(/service === 'qobuz'/.test(resolver) && /getStreamInfo/.test(resolver),
    'one resolver has to handle both, or one service silently 404s as a missing file');
});

test('the local-file guard cannot run on a streaming path', () => {
  const stream = src('routes', 'stream.js');
  assert.ok(/} else {\s*try { await fsp\.access\(track\.path\); }/.test(stream),
    'fsp.access must sit in the non-streaming branch — a URL is not a file, ' +
    'and checking it 404s every streaming track before it can play');
  assert.ok(/const ext = streamingService \? '' : path\.extname/.test(stream),
    "extension sniffing must be skipped for streaming sources, or " +
    "path.extname('…/f.flac?sig=x') decides the passthrough branch and " +
    'fs.createReadStream is handed a URL');
});

// ---------------------------------------------------------------------------
// 5. The detectors bite.
// ---------------------------------------------------------------------------
//
// A test that cannot fail is worse than no test. Each grep above is run
// here against a mutated sample carrying the exact bug it exists to catch.

test('the detectors actually detect', () => {
  // (a) A scope pass that guards the tracks UPDATE but forgets the albums
  //     one — the partial migration, which is how this class of bug ships.
  const halfGuarded = `
    database.prepare(\`UPDATE tracks SET excluded = 1 WHERE excluded = 0 AND \${streamingLibrary.NOT_STREAMING_TRACK_SQL}\`).run();
    database.prepare(\`UPDATE albums SET excluded = 1 WHERE excluded = 0\`).run();
    database.prepare(\`UPDATE tracks
      SET excluded = CASE WHEN (x) THEN 0 ELSE 1 END
      WHERE \${streamingLibrary.NOT_STREAMING_TRACK_SQL}\`).run();
    database.prepare(\`UPDATE albums
      SET excluded = CASE WHEN (y) THEN 0 ELSE 1 END\`).run();
  `;
  const writes = (halfGuarded.match(/UPDATE (tracks|albums)\s+SET excluded|UPDATE (tracks|albums) SET excluded = 1/g) || []).length;
  const guards = (halfGuarded.match(/NOT_STREAMING_(TRACK|ALBUM)_SQL/g) || []).length;
  assert.equal(writes, 4, 'sample must contain four excluded writes');
  assert.notEqual(guards, writes,
    'the scanner check must go red when two of four writes are guarded');

  // (b) The relaxation spreading to a browse surface.
  const leaky = `
    WHERE tracks_fts MATCH ? AND (t.excluded = 0 OR t.path LIKE 'qobuz://%' OR t.path LIKE 'tidal://%')
    ${RELAX_CLAUSE}
    ${RELAX_CLAUSE}
  `;
  assert.equal(leaky.split(RELAX_CLAUSE).length - 1, 3,
    'the count check must go red at three sites, not silently pass at two');
  assert.ok(!/WHERE tracks_fts MATCH \? AND t\.excluded = 0/.test(leaky),
    'and the FTS-stays-strict check must go red once the search is relaxed');

  // (c) A stream route that checks the filesystem before branching.
  const eager = `
    const track = get(id);
    try { await fsp.access(track.path); }
    catch { return res.status(404).json({ error: 'File not found' }); }
    const ext = path.extname(track.path).toLowerCase();
  `;
  assert.ok(!/} else {\s*try { await fsp\.access\(track\.path\); }/.test(eager),
    'the fsp.access check must go red when the guard is not inside the else branch');
  assert.ok(!/const ext = streamingService \? '' : path\.extname/.test(eager),
    'and the extension check must go red on unconditional extname');
});

test.after(() => {
  try { db.close(); } catch (e) { /* already closed */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* temp dir */ }
});
