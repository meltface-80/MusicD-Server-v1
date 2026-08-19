// The album library's sort suite.
//
// Seven sorts, each with a direction, one of them seeded — and the option list
// exists twice, once on each side of the wire. Three things can go wrong that
// no amount of reading catches:
//
//   1. The two lists drift. A sort added to the client's sheet that the server
//      does not know falls back to Album name, so the pill says "Most played"
//      and the wall is alphabetical. Nothing errors.
//   2. The ORDER BY is not total. This list is paged with LIMIT/OFFSET and
//      SQLite may return equal-keyed rows in any order, so two pages overlap:
//      the grid shows duplicates and silently drops albums. Invisible until a
//      user with a big library scrolls.
//   3. The random sort does not shuffle. The first implementation multiplied
//      the rowid by a constant and reduced mod a prime, inline in SQL. For the
//      small consecutive rowids a real library has, the products come out in
//      increasing order — the "shuffle" was rowid order, and every seed
//      produced the same one. It looked completely reasonable in review; it
//      was running it against a real SQLite that showed it.
//
// So these run the actual SQL against an actual database.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const Database = require('better-sqlite3');
const server = require('../src/librarySort');
const CLIENT_SRC = path.join(__dirname, '..', '..', 'client', 'src');

// A library with every awkward case in it: no year, year 0, no album artist,
// a lower-case title that must not sort apart from the capitals, two albums
// sharing a year so the tiebreaker is exercised, and one never played.
function makeDb() {
  const db = new Database(':memory:');
  server.registerSqlFunctions(db);
  db.exec(`
    CREATE TABLE albums (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, artist TEXT, album_artist TEXT,
      year INTEGER, excluded INTEGER DEFAULT 0, added_at INTEGER
    );
    CREATE TABLE play_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, track_id TEXT NOT NULL,
      album_title TEXT, album_artist TEXT, played_at INTEGER NOT NULL
    );
  `);
  const ins = db.prepare(
    'INSERT INTO albums (id,title,artist,album_artist,year,added_at) VALUES (?,?,?,?,?,?)');
  ins.run('a', 'Kind of Blue', 'Miles Davis', 'Miles Davis', 1959, 1000);
  ins.run('b', 'Blue Train', 'John Coltrane', 'John Coltrane', 1957, 2000);
  ins.run('c', 'Undated Record', 'Nobody', null, null, 3000);
  ins.run('d', 'Zero Year', 'Someone', 'Someone', 0, 4000);
  ins.run('e', 'aardvark lower', 'Aaa', 'Aaa', 1959, 5000);
  const play = db.prepare(
    'INSERT INTO play_history (track_id,album_title,album_artist,played_at) VALUES (?,?,?,?)');
  play.run('t1', 'Kind of Blue', 'Miles Davis', 5000);
  play.run('t2', 'Kind of Blue', 'Miles Davis', 9000);
  play.run('t3', 'Blue Train', 'John Coltrane', 7000);
  return db;
}

const order = (db, sort, dir, seed = 1) => db.prepare(
  `SELECT id FROM albums WHERE excluded = 0 ORDER BY ${server.orderByFor(sort, dir, seed)}`
).all().map(r => r.id);

test('every sort produces SQL SQLite will run', async (t) => {
  const db = makeDb();
  for (const id of server.SORT_IDS) {
    for (const dir of ['asc', 'desc']) {
      await t.test(`${id} ${dir}`, () => {
        const rows = order(db, id, dir);
        assert.equal(rows.length, 5, 'the sort dropped or duplicated albums');
      });
    }
  }
});

test('every sort orders totally, so paging cannot overlap or skip', async (t) => {
  // The real failure: without a unique tiebreaker, `ORDER BY year DESC LIMIT 2
  // OFFSET 2` may re-serve a row page 1 already gave. Two albums here share
  // 1959 precisely so this bites if the tiebreaker goes.
  const db = makeDb();
  for (const id of server.SORT_IDS) {
    for (const dir of ['asc', 'desc']) {
      await t.test(`${id} ${dir}`, () => {
        const seen = [];
        for (let off = 0; off < 6; off += 2) {
          seen.push(...db.prepare(
            `SELECT id FROM albums WHERE excluded = 0 ` +
            `ORDER BY ${server.orderByFor(id, dir, 1)} LIMIT 2 OFFSET ${off}`
          ).all().map(r => r.id));
        }
        assert.equal(seen.length, 5, `paged ${seen.length} rows out of 5`);
        assert.equal(new Set(seen).size, 5,
          `paging repeated an album: ${seen.join(',')}`);
        assert.deepEqual(seen, order(db, id, dir),
          'the paged order differs from the unpaged one');
      });
    }
  }
});

test('an album with no year or no added date sorts last BOTH ways', async (t) => {
  // Reversing Release year to oldest-first must not float every undated album
  // to the top of the wall. On a library the scanner could not read dates for,
  // that is most of the first screen.
  const db = makeDb();
  const UNKNOWN_YEAR = ['c', 'd'];          // null year, and year 0

  for (const dir of ['asc', 'desc']) {
    await t.test(`year ${dir}`, () => {
      const rows = order(db, 'year', dir);
      assert.deepEqual(rows.slice(-2).sort(), UNKNOWN_YEAR,
        `undated albums are not at the end: ${rows.join(',')}`);
    });
  }

  await t.test('the unknown block does not reorder when the direction flips', () => {
    // Both spellings of "no year" -- NULL and 0 -- collapse to one value, so
    // the block falls through to the title tiebreaker and reads the same
    // either way. Without that, reversing visibly reshuffles the undated
    // albums for no reason the user can see.
    assert.deepEqual(order(db, 'year', 'asc').slice(-2),
                     order(db, 'year', 'desc').slice(-2));
  });

  await t.test('a zero added_at is unknown too, not 1970', () => {
    const db2 = makeDb();
    db2.prepare('UPDATE albums SET added_at = 0 WHERE id = ?').run('b');
    for (const dir of ['asc', 'desc']) {
      assert.equal(order(db2, 'added', dir).at(-1), 'b',
        `added ${dir} did not put the undated album last`);
    }
  });
});

test('the random sort is a seeded shuffle, not an ordering', async (t) => {
  // Enough albums that "it happens to match" is not a plausible explanation.
  const db = new Database(':memory:');
  server.registerSqlFunctions(db);
  db.exec('CREATE TABLE albums (id TEXT PRIMARY KEY, title TEXT, album_artist TEXT, excluded INTEGER DEFAULT 0)');
  const ins = db.prepare('INSERT INTO albums (id,title,album_artist) VALUES (?,?,?)');
  const ids = [];
  for (let i = 0; i < 200; i++) {
    const id = `album-${String(i).padStart(3, '0')}`;
    ids.push(id);
    ins.run(id, `Title ${i}`, `Artist ${i % 17}`);
  }
  const shuffled = (seed) => db.prepare(
    `SELECT id FROM albums ORDER BY ${server.orderByFor('random', 'asc', seed)}`
  ).all().map(r => r.id);

  await t.test('the same seed gives the same order', () => {
    // Without this the grid re-rolls the shuffle between pages and serves the
    // same album twice while missing others.
    assert.deepEqual(shuffled(7), shuffled(7));
  });

  await t.test('a different seed gives a different order', () => {
    assert.notDeepEqual(shuffled(7), shuffled(8), 'reshuffling changed nothing');
  });

  // THE regression, and it needs measuring rather than eyeballing.
  //
  // The arithmetic-in-SQL version ordered by ((rowid + seed) * K) % P. That
  // IS a permutation, and it scatters well enough that counting albums left
  // in their original position does not notice it — the first version of this
  // test passed the broken code. What gives it away is that the permutation
  // is AFFINE: consecutive positions differ by a constant stride mod N, so
  // the shuffled wall is really the library read at a fixed interval, and
  // every seed produces the same cycle at a different starting point.
  //
  // Measured on 200 albums: the broken version puts 128 of 199 successive
  // steps at the same stride and seed 8 is an exact rotation of seed 7. The
  // hash puts its most common stride at 4 of 199 and rotates for neither.
  const stepsOf = (out) => {
    const pos = out.map(id => ids.indexOf(id));
    return pos.slice(1).map((v, i) => ((v - pos[i]) % ids.length + ids.length) % ids.length);
  };

  await t.test('the order is not the library read at a fixed stride', () => {
    for (const seed of [1, 2, 7, 99, 12345]) {
      const steps = stepsOf(shuffled(seed));
      const counts = new Map();
      for (const d of steps) counts.set(d, (counts.get(d) || 0) + 1);
      const worst = Math.max(...counts.values());
      assert.ok(worst < steps.length / 4,
        `seed ${seed}: ${worst} of ${steps.length} steps share one stride — ` +
        'this is an affine permutation of insertion order, not a shuffle');
    }
  });

  await t.test('two seeds are not the same cycle at a different start', () => {
    const a = shuffled(7);
    for (const seed of [8, 9, 100, 5000]) {
      const b = shuffled(seed);
      const j = b.indexOf(a[0]);
      const rotation = a.every((id, i) => id === b[(j + i) % a.length]);
      assert.ok(!rotation,
        `seed ${seed} is a rotation of seed 7 — reshuffling only moves the ` +
        'starting point, so the same albums stay adjacent for ever');
    }
  });

  await t.test('few albums keep their original position', () => {
    for (const seed of [1, 7, 12345]) {
      const fixed = shuffled(seed).filter((id, i) => id === ids[i]).length;
      assert.ok(fixed < 10, `seed ${seed}: ${fixed} of 200 albums did not move`);
    }
  });

  await t.test('every album appears exactly once', () => {
    const out = shuffled(3);
    assert.equal(new Set(out).size, ids.length);
  });

  await t.test('the hash spreads across the range', () => {
    // A hash that clumps would still pass the tests above while paging badly.
    const buckets = new Array(8).fill(0);
    for (const id of ids) {
      const h = server.shuffleRank(id, 5) >>> 0;
      buckets[Math.floor(h / (2 ** 32) * 8)]++;
    }
    for (const [i, n] of buckets.entries()) {
      assert.ok(n > 5, `bucket ${i} holds only ${n} of 200 — the hash clumps`);
    }
  });
});

test('parameter validation never lets caller text reach the SQL', async (t) => {
  await t.test('an unknown sort falls back to the default', () => {
    assert.equal(server.normaliseSort('; DROP TABLE albums;--'), server.DEFAULT_SORT);
    assert.equal(server.normaliseSort(undefined), server.DEFAULT_SORT);
    assert.equal(server.normaliseSort(null), server.DEFAULT_SORT);
    assert.equal(server.normaliseSort({}), server.DEFAULT_SORT);
  });

  await t.test("the legacy 'title' id still resolves", () => {
    // /api/library/albums is public and an older client may still send it.
    assert.equal(server.normaliseSort('title'), 'album');
  });

  await t.test('an unknown direction means the SORT\'s default, not ASC', () => {
    // Picking Release year has to open newest-first; a blanket ASC default
    // would open every quantitative sort at the wrong end.
    assert.equal(server.normaliseDir('year', 'sideways'), 'desc');
    assert.equal(server.normaliseDir('album', undefined), 'asc');
    assert.equal(server.normaliseDir('plays', null), 'desc');
    assert.equal(server.normaliseDir('year', 'ASC'), 'asc');   // case-insensitive
  });

  await t.test('the seed is always a positive integer', () => {
    for (const bad of [undefined, null, 'abc', -5, 0, {}, NaN, Infinity]) {
      const n = server.normaliseSeed(bad);
      assert.ok(Number.isInteger(n) && n > 0, `${String(bad)} produced ${n}`);
    }
  });

  await t.test('the generated ORDER BY contains no caller text', () => {
    const evil = "1; DROP TABLE albums; --";
    for (const dir of [evil, 'desc']) {
      for (const id of [evil, 'year']) {
        const sql = server.orderByFor(id, dir, evil);
        assert.ok(!sql.includes('DROP'), `caller text reached the SQL: ${sql}`);
      }
    }
  });
});

test('the client and the server describe the same suite', async (t) => {
  // The drift guard. A sort in the sheet that the server does not know falls
  // back to Album name: the chip reads "Most played" and the wall is
  // alphabetical, with nothing logged at either end.
  const client = await import(pathToFileURL(path.join(CLIENT_SRC, 'librarySort.js')).href);

  await t.test('the same ids, in the same order', () => {
    assert.deepEqual(client.SORTS.map(o => o.id), server.SORTS.map(o => o.id));
  });

  await t.test('the same default direction for each', () => {
    for (const c of client.SORTS) {
      const s = server.sortById(c.id);
      assert.equal(c.defaultDir, s.defaultDir, `${c.id} opens differently on each side`);
    }
  });

  await t.test('the same labels, notes and direction wording', () => {
    for (const c of client.SORTS) {
      const s = server.sortById(c.id);
      for (const field of ['label', 'note', 'asc', 'desc', 'hasDir']) {
        assert.equal(c[field], s[field], `${c.id}.${field} differs across the wire`);
      }
    }
  });

  await t.test('the same default sort', () => {
    assert.equal(client.DEFAULT_SORT, server.DEFAULT_SORT);
  });

  await t.test('normalisation agrees on every id the client can hold', () => {
    for (const id of [...server.SORT_IDS, 'title', 'nonsense', '', null]) {
      assert.equal(client.normaliseSort(id), server.normaliseSort(id), `id ${String(id)}`);
      assert.equal(client.normaliseDir(id, undefined), server.normaliseDir(id, undefined));
      assert.equal(client.sortHasDir(id), server.sortHasDir(id), `hasDir ${String(id)}`);
    }
  });

  await t.test('the client asks for exactly what the server validates', () => {
    // A query string the server would have to fall back on is a silent
    // mis-sort, so check the client emits ids the server accepts verbatim.
    for (const o of client.SORTS) {
      const q = new URLSearchParams(client.sortQuery({ sort: o.id, dir: o.defaultDir, seed: 42 }));
      assert.equal(server.normaliseSort(q.get('sort')), o.id, `${o.id} round-trips`);
      assert.equal(server.normaliseDir(o.id, q.get('dir')), o.defaultDir);
      // The seed rides along only for random: carrying it otherwise splits
      // the server's response cache per reshuffle for every other sort.
      assert.equal(q.has('seed'), o.id === 'random', `${o.id} seed parameter`);
    }
  });
});

test('the stored sort preference survives the app being closed', async (t) => {
  const client = await import(pathToFileURL(path.join(CLIENT_SRC, 'librarySort.js')).href);

  // localStorage, not sessionStorage and not component state: iOS discards
  // the page when the PWA is backgrounded, and the home-screen shortcut
  // relaunches it cold. Stubbed here because node has no DOM.
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };

  await t.test('a saved view comes back', () => {
    store.clear();
    client.saveSortView('albums', { sort: 'plays', dir: 'asc', seed: 12 });
    assert.deepEqual(client.loadSortView('albums'), { sort: 'plays', dir: 'asc', seed: 12 });
  });

  await t.test('each grid keeps its own', () => {
    // Sorting Favourites by Most played must not re-sort the main wall.
    store.clear();
    client.saveSortView('albums', { sort: 'added', dir: 'desc', seed: 1 });
    client.saveSortView('favorites', { sort: 'plays', dir: 'desc', seed: 1 });
    assert.equal(client.loadSortView('albums').sort, 'added');
    assert.equal(client.loadSortView('favorites').sort, 'plays');
    assert.equal(client.loadSortView('saved').sort, client.DEFAULT_SORT);
  });

  await t.test('it is written on change, not on unmount', () => {
    // An unmount handler is exactly what does not run when iOS discards the
    // page, so the write has to have happened already.
    store.clear();
    client.saveSortView('albums', { sort: 'year', dir: 'asc', seed: 1 });
    assert.ok(store.get(client.STORAGE_KEY).includes('year'),
      'nothing reached localStorage at the moment of the change');
  });

  await t.test('a corrupt blob does not break the grid', () => {
    // JSON can parse cleanly and still be the wrong SHAPE — a partial write, a
    // hand-edited value, a blob from a future build. An unvalidated sort would
    // reach the query string and come back as an empty grid with no way out
    // short of clearing site data.
    for (const junk of ['{', 'null', '[]', '"nope"', '{"views":null}',
                        '{"views":{"albums":{"sort":null,"dir":7,"seed":"x"}}}',
                        '{"views":{"albums":"not an object"}}']) {
      store.clear();
      store.set(client.STORAGE_KEY, junk);
      const v = client.loadSortView('albums');
      assert.ok(server.SORT_IDS.includes(v.sort), `junk ${junk} produced sort ${v.sort}`);
      assert.ok(v.dir === 'asc' || v.dir === 'desc', `junk ${junk} produced dir ${v.dir}`);
      assert.ok(Number.isInteger(v.seed) && v.seed > 0, `junk ${junk} produced seed ${v.seed}`);
    }
  });

  await t.test('a preference written by an older build still loads', () => {
    store.clear();
    store.set(client.STORAGE_KEY, JSON.stringify({ v: 1, views: { albums: { sort: 'title' } } }));
    const v = client.loadSortView('albums');
    assert.equal(v.sort, 'album', "the pre-suite 'title' id was dropped rather than migrated");
    assert.equal(v.dir, 'asc');
  });

  await t.test('storage being unavailable is not fatal', () => {
    // Private browsing, or storage disabled. The app must still render.
    const saved = globalThis.localStorage;
    globalThis.localStorage = {
      getItem() { throw new Error('SecurityError'); },
      setItem() { throw new Error('QuotaExceededError'); },
    };
    assert.equal(client.loadSortView('albums').sort, client.DEFAULT_SORT);
    assert.doesNotThrow(() => client.saveSortView('albums', { sort: 'year', dir: 'desc', seed: 1 }));
    globalThis.localStorage = saved;
  });

  await t.test('reshuffling always lands on a new seed', () => {
    for (let i = 0; i < 50; i++) {
      const cur = 1 + Math.floor(Math.random() * 100000);
      assert.notEqual(client.nextSeed(cur), cur, 'a reshuffle repainted the same shuffle');
    }
  });

  delete globalThis.localStorage;
});

test('the grid asks for the whole view, not just the column', () => {
  // Direction and seed change the ORDER the server answers with, so they are
  // part of "which list is this". Leaving the seed out of the view key would
  // let a reshuffle mirror the previous shuffle's albums under the new seed
  // and then restore them as if they were it.
  const grid = fs.readFileSync(path.join(CLIENT_SRC, 'components', 'AlbumGrid.jsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  // Lifted and run, not grepped: the first version of this check only asserted
  // that the word "seed" appeared in the function, and the parameter list
  // alone satisfied that — deleting the line that actually used it passed.
  const raw = fs.readFileSync(path.join(CLIENT_SRC, 'components', 'AlbumGrid.jsx'), 'utf8');
  const fnSrc = raw.slice(raw.indexOf('function albumsViewKey('),
                          raw.indexOf('export default function AlbumGrid'));
  assert.ok(fnSrc.includes('JSON.stringify'), 'could not lift albumsViewKey');
  const albumsViewKey = new Function(
    'normaliseDir', fnSrc + '; return albumsViewKey;'
  )(server.normaliseDir);

  const base = {
    sort: 'album', dir: 'asc', seed: 1,
    showOnlyFavorites: false, savedOnly: false, tagFilter: new Set(), focusQuery: '',
  };
  const key = (over) => albumsViewKey({ ...base, ...over });

  assert.notEqual(key({ dir: 'desc' }), key({}),
    'reversing the sort does not change the view key — the cache would mirror ' +
    'the old order under the new direction and restore it as if it were right');

  assert.notEqual(key({ sort: 'random', seed: 2 }), key({ sort: 'random', seed: 1 }),
    'reshuffling does not change the view key — the cache would mirror the ' +
    'previous shuffle under the new seed');

  assert.notEqual(key({ sort: 'year' }), key({}), 'the sort itself is not in the key');

  // The seed rides in the key only where it means something. If it counted
  // for every sort, an unrelated reshuffle would invalidate the cached list
  // of a sort that never looked at it.
  assert.equal(key({ seed: 2 }), key({ seed: 1 }),
    'the seed splits the view key for a sort that does not use it');

  assert.match(grid, /sortQuery\(s\)/,
    'fetchPage builds its own query string instead of using the shared one');
  assert.ok(!/sort=\$\{s\}/.test(grid),
    'a call site still sends the bare sort id without direction or seed');
});
