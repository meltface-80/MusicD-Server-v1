// Multi-select on the album grids (v1.1.29.0).
//
// Ticking albums and acting on the lot is one behaviour on four screens — the
// Albums wall, Favourites, Saved for later and the Random wall. All four draw
// the same tiles, so all four share one implementation, and most of what is
// checked here is that they still do. This project has paid for the
// alternative twice: the volume sheet and the queue view each existed in two
// copies, and both times every improvement landed on only one of them.
//
// The server side is one endpoint, and its interesting property is ORDER. With
// eight albums ticked, "Play now" needs every track of all eight in the order
// the ALBUMS were picked — not the order SQLite hands the rows back, which is
// whatever the query planner finds convenient. That is run against real SQLite
// below rather than asserted from the source, because "does this ORDER BY do
// what I think" is exactly the kind of thing reading cannot settle.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const SERVER_SRC = path.join(__dirname, '..', 'src');
const CLIENT_SRC = path.join(__dirname, '..', '..', 'client', 'src');
const readRaw = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const client = (...p) => code(readRaw(CLIENT_SRC, ...p));

// ---------------------------------------------------------------------------
// The endpoint, lifted out of library.js and run on a real database.
// ---------------------------------------------------------------------------

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE albums (id TEXT PRIMARY KEY, title TEXT, album_artist TEXT)`);
  // `path` is in the shipping table and was simply not needed here until
  // v1.1.33.0, when the query started reading it to tell a streaming track
  // from a local one.
  db.exec(`CREATE TABLE tracks (
    id TEXT PRIMARY KEY, path TEXT, title TEXT, artist TEXT, album TEXT, album_artist TEXT,
    album_id TEXT, track_number INT, disc_number INT, duration REAL,
    format TEXT, codec TEXT, sample_rate INT, bit_depth INT,
    is_favorite INT DEFAULT 0, user_rating INT DEFAULT 0,
    is_saved_for_later INT DEFAULT 0, excluded INT DEFAULT 0)`);

  const album = db.prepare('INSERT INTO albums (id,title,album_artist) VALUES (?,?,?)');
  // Local tracks get a filesystem path; the streaming album below gets
  // sentinel paths, which is the only thing that distinguishes them.
  const track = db.prepare(`INSERT INTO tracks
    (id,path,title,album_id,album,album_artist,track_number,disc_number,excluded)
    VALUES (?,?,?,?,?,?,?,?,?)`);

  // Three albums, deliberately inserted so that natural row order is NOT
  // selection order for the cases below.
  for (const [id, title] of [['A', 'Alpha'], ['B', 'Bravo'], ['C', 'Charlie']]) {
    album.run(id, title, 'Someone');
    // tracks inserted out of order, and across two discs, so the ORDER BY has
    // something to do
    track.run(`${id}2`, `/music/${id}/02.flac`, `${id} two`,   id, title, 'Someone', 2, 1, 0);
    track.run(`${id}1`, `/music/${id}/01.flac`, `${id} one`,   id, title, 'Someone', 1, 1, 0);
    track.run(`${id}d2`, `/music/${id}/d2-01.flac`, `${id} d2t1`, id, title, 'Someone', 1, 2, 0);
  }
  // An excluded track, which must never be queued.
  track.run('Ax', '/music/A/09.flac', 'A excluded', 'A', 'Alpha', 'Someone', 9, 1, 1);
  // An album whose tracks predate the album_id column, matched by title+artist.
  album.run('L', 'Legacy', 'Old Band');
  track.run('L1', '/music/Legacy/01.flac', 'L one', null, 'Legacy', 'Old Band', 1, 1, 0);
  // v1.1.33.0 — a Qobuz album opened from a search result: cached, so its
  // rows exist, but not favourited, so album and tracks are excluded. It has
  // to queue anyway. Everything else about excluded rows is unchanged, which
  // is what the pair of assertions below is for.
  album.run('qobuz:900', 'Cached Qobuz', 'Some Artist');
  track.run('q1', 'qobuz://9001', 'Q one', 'qobuz:900', 'Cached Qobuz', 'Some Artist', 1, 1, 1);
  track.run('q2', 'qobuz://9002', 'Q two', 'qobuz:900', 'Cached Qobuz', 'Some Artist', 2, 1, 1);
  return db;
}

// Lift the handler from the shipping source and give it the three things it
// closes over. Reading the source is the point: a change to the route that is
// not made here fails at the lift, not silently.
function loadHandler(db) {
  const src = code(readRaw(SERVER_SRC, 'routes', 'library.js'));
  const at = src.indexOf("router.post('/albums/tracks'");
  assert.notEqual(at, -1, 'POST /albums/tracks is gone from library.js');
  const end = src.indexOf('\n});', at);
  const body = src.slice(src.indexOf('{', src.indexOf('(req, res) =>', at)) + 1, end);
  const cap = /const MULTI_SELECT_MAX_ALBUMS = (\d+);/.exec(src);
  assert.ok(cap, 'the album cap is gone');
  const fn = new Function('db', 'MULTI_SELECT_MAX_ALBUMS', 'req', 'res', body);
  return (ids) => new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this },
      json(o) { resolve({ status: this.statusCode, body: o }) },
    };
    fn({ get: () => db }, Number(cap[1]), { body: { ids } }, res);
  });
}

const ids = (r) => r.body.tracks.map(t => t.id).join(',');

test('the batch endpoint returns whole albums in the order they were picked', async (t) => {
  const db = makeDb();
  const call = await loadHandler(db);

  await t.test('one album, in disc then track order', async () => {
    const r = await call(['A']);
    assert.equal(r.status, 200);
    assert.equal(ids(r), 'A1,A2,Ad2',
      'tracks came back in row order rather than disc/track order');
  });

  await t.test('several albums, in SELECTION order', async () => {
    // The whole point. C then A is not the order the rows sit in, and not the
    // order any index would produce.
    const r = await call(['C', 'A']);
    assert.equal(ids(r), 'C1,C2,Cd2,A1,A2,Ad2');
    const back = await call(['A', 'C']);
    assert.equal(ids(back), 'A1,A2,Ad2,C1,C2,Cd2',
      'the two orderings gave the same answer — selection order is being ignored');
  });

  await t.test('excluded tracks never come back', async () => {
    const r = await call(['A']);
    assert.ok(!ids(r).includes('Ax'), 'an excluded track was queued');
  });

  await t.test('a streaming album queues even when it is not in the library', async () => {
    // v1.1.33.0. A Qobuz album reached from a search result is excluded — it
    // is not in the library until the ⊕ adds it — but the user is looking at
    // its page with the play button right there. Excluding its tracks here
    // meant pressing play queued nothing at all, silently.
    const r = await call(['qobuz:900']);
    assert.equal(ids(r), 'q1,q2',
      'a browsed streaming album queued nothing — the relaxation on the ' +
      'excluded filter is missing from POST /albums/tracks');
  });

  await t.test('and the relaxation is on the path, not on the filter', async () => {
    // The lazy fix is to drop `excluded` from this query entirely, which also
    // resurrects every local track the user put out of scope. Ax is a local
    // excluded track on album A; it must still never be queued.
    const r = await call(['A', 'qobuz:900']);
    assert.equal(ids(r), 'A1,A2,Ad2,q1,q2',
      'the excluded LOCAL track came back too — the filter was dropped ' +
      'rather than relaxed for streaming paths');
  });

  await t.test('albums scanned before album_id existed still resolve', async () => {
    // The detail page falls back to title + album_artist for these. If this
    // endpoint did not, a half-migrated library would show the album fine and
    // then queue nothing from it.
    const r = await call(['L']);
    assert.equal(ids(r), 'L1');
  });

  await t.test('a repeated id is not queued twice', async () => {
    const r = await call(['A', 'A', 'A']);
    assert.equal(ids(r), 'A1,A2,Ad2');
    assert.equal(r.body.albums, 1);
  });

  await t.test('an album that has gone costs that album, not the action', async () => {
    // A rescan can delete an album between the tap and the request. Failing
    // the whole selection over it would be the wrong trade.
    const r = await call(['A', 'nope', 'C']);
    assert.equal(r.status, 200);
    assert.equal(ids(r), 'A1,A2,Ad2,C1,C2,Cd2');
    assert.deepEqual(r.body.missing, ['nope']);
  });

  await t.test('an empty or missing list is a 400, not an empty success', async () => {
    for (const bad of [[], null, undefined, 'A']) {
      const r = await call(bad);
      assert.equal(r.status, 400, `${JSON.stringify(bad)} was accepted`);
    }
  });

  await t.test('the album count is capped', async () => {
    const many = Array.from({ length: 900 }, (_, i) => 'x' + i);
    const r = await call([...many, 'A']);
    // 'A' is past the cap, so nothing comes back — proving the slice happens
    // before the lookups rather than after.
    assert.equal(r.body.tracks.length, 0);
  });
});

// ---------------------------------------------------------------------------
// The client.
// ---------------------------------------------------------------------------

test('both album grids use one selection implementation', async (t) => {
  const shared = client('components', 'AlbumSelection.jsx');
  const grid = client('components', 'AlbumGrid.jsx');
  const random = client('components', 'RandomAlbumsScreen.jsx');

  await t.test('both import it, neither reimplements it', () => {
    for (const [name, src] of [['AlbumGrid.jsx', grid], ['RandomAlbumsScreen.jsx', random]]) {
      assert.match(src, /from '\.\/AlbumSelection'/, `${name} does not use the shared module`);
      assert.match(src, /useAlbumSelection\(\)/, `${name} has no selection state`);
      assert.match(src, /runSelectionAction\(action, selection\.selected\)/,
        `${name} does not run the shared actions`);
      // The tell-tale of a fork: its own copy of the action list.
      assert.doesNotMatch(src, /'Play now'/, `${name} has its own copy of the actions`);
      assert.doesNotMatch(src, /albums\/tracks/, `${name} fetches tracks itself`);
    }
  });

  await t.test('the five actions are the album page\'s, in its order', () => {
    const listed = [...shared.matchAll(/\{ id: '(\w+)',\s*label: '([^']+)'/g)].map(m => m[2]);
    assert.deepEqual(listed,
      ['Play now', 'Play next', 'Add to queue', 'Shuffle play', 'Save for later']);
  });

  await t.test('each action reaches a different store call', () => {
    // Four playback actions wired to one store function would look right and
    // do one thing.
    for (const [action, call] of [
      ['playNow',  'store.playQueue(tracks, 0)'],
      ['playNext', 'store.insertNextInQueue(tracks)'],
      ['queue',    'store.appendIdsToQueue(tracks.map(t => t.id))'],
      ['shuffle',  'store.shufflePlay(tracks)'],
    ]) {
      assert.ok(shared.includes(`case '${action}':`), `${action} has no branch`);
      assert.ok(shared.includes(call), `${action} does not call ${call}`);
    }
    assert.match(shared, /save-for-later/, 'Save for later posts nothing');
  });

  await t.test('Save for later does not fetch tracks it has no use for', () => {
    // It is an album-level flag. Fetching a thousand track rows to set it
    // would be wasted work on the one action that is likely to be used on a
    // big selection.
    const at = shared.indexOf("if (action === 'saveLater')");
    assert.notEqual(at, -1, 'saveLater is not handled ahead of the fetch');
    assert.ok(at < shared.indexOf("api.post('/library/albums/tracks'"),
      'Save for later fetches the tracks first');
  });

  await t.test('one album failing does not cost the rest of the selection', () => {
    const at = shared.indexOf("if (action === 'saveLater')");
    const end = shared.indexOf('return { ok: saved > 0', at);
    assert.match(shared.slice(at, end), /catch \(e\)/,
      'a single failed save aborts the whole selection');
  });

  await t.test('the actions that need an output say so instead of failing', () => {
    assert.match(shared, /needsRenderer: true/);
    assert.match(shared, /if \(spec\.needsRenderer && !store\.rendererId\)/);
    // Add to queue and Save for later work with nothing playing.
    const queue = /\{ id: 'queue',[^}]*needsRenderer: (\w+)/.exec(shared);
    const save = /\{ id: 'saveLater',[^}]*needsRenderer: (\w+)/.exec(shared);
    assert.equal(queue[1], 'false', 'Add to queue was made to require an output');
    assert.equal(save[1], 'false', 'Save for later was made to require an output');
  });
});

test('selecting changes what a tap does, and says so', async (t) => {
  const grid = client('components', 'AlbumGrid.jsx');
  const random = client('components', 'RandomAlbumsScreen.jsx');
  const shared = client('components', 'AlbumSelection.jsx');

  await t.test('a tap picks instead of opening', () => {
    for (const [name, src] of [['AlbumGrid.jsx', grid], ['RandomAlbumsScreen.jsx', random]]) {
      assert.match(src, /if \(selection\.selecting\) \{ selection\.toggle\(/,
        `${name} still opens the album while selecting`);
    }
  });

  await t.test('picked tiles are marked and unpicked ones step back', () => {
    // v1.1.34.0 — these three lived in each grid's own tile component.
    // There were FOUR of those (the wall, the artist page, the random
    // wall and the Qobuz / Tidal screens) and they had drifted; they are
    // one shared AlbumTile now, so the rendering is asserted there once.
    // The BEHAVIOUR assertions below stay per grid, because deciding what
    // a tap does is still each screen's own job.
    const tile = client('components', 'AlbumTile.jsx');
    assert.match(tile, /\{selecting && <SelectionTick on=\{selected\} \/>\}/,
      'the shared tile draws no selection tick');
    assert.match(tile, /selecting && !selected \?/,
      'the shared tile does not dim unpicked albums');
    assert.match(tile, /aria-pressed=\{selecting \? selected : undefined\}/,
      'the shared tile does not announce its selected state');

    // And every grid that supports selecting must actually pass it down,
    // or the tick is implemented and never drawn.
    for (const [name, src] of [['AlbumGrid.jsx', grid], ['RandomAlbumsScreen.jsx', random]]) {
      assert.match(src, /selecting=\{selection\.selecting\}/,
        `${name} does not pass selecting to its tiles`);
      assert.match(src, /selected=\{selection\.selected\.has\(/,
        `${name} does not pass selected to its tiles`);
    }
  });

  await t.test('the tick is drawn only while selecting', () => {
    // An empty circle on every tile the rest of the time would be permanent
    // chrome over the artwork, which is what these walls are for.
    assert.doesNotMatch(client('components', 'AlbumTile.jsx'),
      /<SelectionTick on=\{selected\} \/>(?!\})/);
  });

  await t.test('the controls that would undo a selection are hidden', () => {
    // Re-sorting or re-filtering the wall, or re-rolling the random one, all
    // throw away what the user has ticked with no way back.
    assert.match(grid, /\{!selection\.selecting && \(favoritesOnly \?/,
      'the album wall keeps its sort and filter chips while selecting');
    assert.match(random, /\{!selection\.selecting && \(\s*<>/,
      'the random wall keeps its Refresh while selecting');
  });

  await t.test('a failed action leaves the sheet open with the reason', () => {
    // Closing on failure hides the message that says what went wrong.
    for (const [name, src] of [['AlbumGrid.jsx', grid], ['RandomAlbumsScreen.jsx', random]]) {
      const at = src.indexOf('const runSelection = async (action)');
      const end = src.indexOf('\n  }', at);
      const body = src.slice(at, end);
      assert.match(body, /if \(!r\.ok\) \{[\s\S]*?return\s*\n?\s*\}/,
        `${name} does not bail on failure`);
      assert.ok(body.indexOf('return') < body.indexOf('setSelectionSheet(false)'),
        `${name} closes the sheet even when the action failed`);
    }
  });

  await t.test('selection is NOT put back on the long press', () => {
    // The long-press menu on album thumbnails was removed at the owner's
    // request and artwork-longpress.test.js keeps it removed. Putting
    // selection on that gesture would reintroduce exactly what was taken away.
    for (const [name, src] of [['AlbumGrid.jsx', grid], ['RandomAlbumsScreen.jsx', random],
                               ['AlbumSelection.jsx', shared]]) {
      for (const banned of ['onLongPress', 'longPressTimer', 'holdTimer', 'HOLD_MS']) {
        assert.doesNotMatch(src, new RegExp(`\\b${banned}\\b`),
          `${name} puts selection back on a long press`);
      }
    }
    // It is a chip, on both walls.
    assert.match(grid, /<SelectChip/);
    assert.match(random, /<SelectChip/);
  });
});
