// The Home screen's three album carousels (v1.1.21.0).
//
// "Recent activity" was one row behind PLAYED/ADDED tabs: seeing both meant
// tapping between them, and whichever you were not looking at was invisible.
// It is two rows now, plus a third for random albums whose heading opens a
// full 3-across wall.
//
// Three things here are worth pinning rather than eyeballing:
//
//   1. The defaults. These rows read the local library and cost nothing, so
//      unlike the news sources they are ON. Two of them have been on the Home
//      screen since #28.5 and an upgrade must not quietly take them away — a
//      copy-paste from news.js's all-off default would do exactly that.
//   2. The route order. /albums/random-set is declared in a file that also has
//      /albums/:id. Express matches in declaration order, so putting the new
//      one after :id makes it 404 with `id = "random-set"` — and the symptom
//      is an empty carousel, not an error anyone would trace back here.
//   3. That the tabs are actually GONE and three separate rows replaced them.
//      A half-done split leaves the tab strip rendering above the new rows.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const Database = require('better-sqlite3');

const CLIENT_SRC = path.join(__dirname, '..', '..', 'client', 'src');
const SERVER_SRC = path.join(__dirname, '..', 'src');
const readClient = (...p) => fs.readFileSync(path.join(CLIENT_SRC, ...p), 'utf8');
const readServer = (...p) => fs.readFileSync(path.join(SERVER_SRC, ...p), 'utf8');
// Comments say what the code should do; they are not evidence that it does.
// Strip them before asserting on structure.
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ---------------------------------------------------------------------------
// homePrefs, against a real SQLite settings table.
// ---------------------------------------------------------------------------

// Also the place the "no background work" promise is checked: axios is
// replaced by something that throws, and setInterval/setTimeout by counters.
// A carousel switch must not schedule anything — that is news.js's job and it
// has its own timer.
function loadHomePrefs() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
  const net = { calls: 0 };
  const timers = { intervals: 0, timeouts: 0 };

  const realInterval = global.setInterval;
  const realTimeout = global.setTimeout;
  global.setInterval = (...a) => { timers.intervals++; return realInterval(...a); };
  global.setTimeout = (...a) => { timers.timeouts++; return realTimeout(...a); };

  const orig = Module._load;
  Module._load = function (req) {
    if (req === './db' || req === '../db') return { get: () => db, isReady: () => true };
    if (req === 'axios') {
      return { get: () => { net.calls++; return Promise.reject(new Error('network must not be touched')); } };
    }
    return orig.apply(this, arguments);
  };
  let homePrefs;
  try {
    delete require.cache[require.resolve('../src/homePrefs')];
    homePrefs = require('../src/homePrefs');
  } finally {
    Module._load = orig;
    // Restored immediately, not in an after() hook: leaving the globals
    // swapped for the rest of the run is how the first version of the news
    // harness hung the process.
    global.setInterval = realInterval;
    global.setTimeout = realTimeout;
  }
  return { homePrefs, db, net, timers };
}

const stored = (db) =>
  db.prepare('SELECT value FROM settings WHERE key = ?').get('home_carousels');

test('the carousels are on unless the user turned them off', async (t) => {
  await t.test('a fresh install shows all three', () => {
    const { homePrefs } = loadHomePrefs();
    assert.deepEqual(homePrefs.getHomePrefs(), {
      recentlyAdded: true, recentlyPlayed: true, randomAlbums: true,
    });
  });

  await t.test('and writes nothing until something is changed', () => {
    const { homePrefs, db } = loadHomePrefs();
    homePrefs.getHomePrefs();
    assert.equal(stored(db), undefined, 'a plain read created a settings row');
  });

  await t.test('the defaults are not the news module\'s', () => {
    // news.js's four are all-off and this file's three are all-on. They read
    // and write different settings keys, so one cannot be edited into the
    // other by accident.
    const src = readServer('homePrefs.js');
    assert.match(src, /home_carousels/);
    assert.doesNotMatch(src, /home_news_sources/,
      'homePrefs reaches into the news preferences blob');
    assert.doesNotMatch(code(src), /setInterval|setTimeout|axios|require\(['"]axios/,
      'a local carousel switch has grown background work');
  });

  await t.test('reading and writing schedules nothing and fetches nothing', () => {
    const { homePrefs, net, timers } = loadHomePrefs();
    homePrefs.getHomePrefs();
    homePrefs.setHomePrefs({ randomAlbums: false });
    homePrefs.getHomePrefs();
    assert.equal(net.calls, 0, 'something reached for the network');
    assert.equal(timers.intervals, 0, 'an interval was registered');
    assert.equal(timers.timeouts, 0, 'a timeout was registered');
  });
});

test('switching one row does not disturb the others', async (t) => {
  await t.test('a patch changes only the key it names', () => {
    const { homePrefs } = loadHomePrefs();
    const after = homePrefs.setHomePrefs({ recentlyPlayed: false });
    assert.deepEqual(after, {
      recentlyAdded: true, recentlyPlayed: false, randomAlbums: true,
    });
    assert.deepEqual(homePrefs.getHomePrefs(), after, 'it did not survive the write');
  });

  await t.test('two patches in sequence both stick', () => {
    const { homePrefs } = loadHomePrefs();
    homePrefs.setHomePrefs({ recentlyAdded: false });
    homePrefs.setHomePrefs({ randomAlbums: false });
    assert.deepEqual(homePrefs.getHomePrefs(), {
      recentlyAdded: false, recentlyPlayed: true, randomAlbums: false,
    });
  });

  await t.test('the stored blob always carries all three keys', () => {
    // A blob holding only the key that changed would read as "the rest are
    // default" — correct today, and wrong the moment a default changes.
    const { homePrefs, db } = loadHomePrefs();
    homePrefs.setHomePrefs({ recentlyAdded: false });
    assert.deepEqual(
      Object.keys(JSON.parse(stored(db).value)).sort(),
      ['randomAlbums', 'recentlyAdded', 'recentlyPlayed'],
    );
  });

  await t.test('a key this build does not know is not stored', () => {
    const { homePrefs, db } = loadHomePrefs();
    homePrefs.setHomePrefs({ recentlyAdded: false, somethingElse: true });
    const blob = JSON.parse(stored(db).value);
    assert.equal('somethingElse' in blob, false);
  });

  await t.test('a non-boolean is not a value on the way in', () => {
    const { homePrefs } = loadHomePrefs();
    // 'false' the string is truthy, and "off" spelled as a string is exactly
    // what an older or hand-edited client would send.
    homePrefs.setHomePrefs({ recentlyAdded: 'false' });
    assert.equal(homePrefs.getHomePrefs().recentlyAdded, true);
  });

  await t.test('or on the way out', () => {
    // The read path has its own type check and needs its own case: a value
    // already in the blob is checked by getHomePrefs, not by setHomePrefs.
    // Both of these differ from the default under a truthiness test and
    // agree with it under a type test, which is the whole point.
    const { homePrefs, db } = loadHomePrefs();
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
      'home_carousels',
      JSON.stringify({ recentlyAdded: 0, recentlyPlayed: '', randomAlbums: 1 }),
    );
    assert.deepEqual(homePrefs.getHomePrefs(), {
      recentlyAdded: true, recentlyPlayed: true, randomAlbums: true,
    });
  });
});

test('a settings row this build cannot read costs nobody their Home screen', async (t) => {
  await t.test('malformed JSON reads as the defaults', () => {
    const { homePrefs, db } = loadHomePrefs();
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('home_carousels', '{not json');
    assert.deepEqual(homePrefs.getHomePrefs(), {
      recentlyAdded: true, recentlyPlayed: true, randomAlbums: true,
    });
  });

  await t.test('a blob from a later build cannot switch anything on or off', () => {
    const { homePrefs, db } = loadHomePrefs();
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
      'home_carousels',
      JSON.stringify({ recentlyAdded: false, futureRow: false, randomAlbums: true }),
    );
    assert.deepEqual(homePrefs.getHomePrefs(), {
      recentlyAdded: false, recentlyPlayed: true, randomAlbums: true,
    });
  });
});

// ---------------------------------------------------------------------------
// /api/library/albums/random-set
// ---------------------------------------------------------------------------

// The route's own SQL, lifted out of the source and run against a real
// database. Asserting on the shape of the string would pass a query that does
// not run; this one has to.
function randomSetSql() {
  const src = readServer('routes', 'library.js');
  const at = src.indexOf(`router.get('/albums/random-set'`);
  assert.notEqual(at, -1, '/albums/random-set is gone');
  const m = /database\.prepare\(`([\s\S]*?)`\)/.exec(src.slice(at));
  assert.ok(m, 'could not find the statement inside /albums/random-set');
  return m[1];
}

function libraryDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE albums (
      id TEXT PRIMARY KEY, title TEXT, album_artist TEXT, artist TEXT,
      year INTEGER, primary_format TEXT, track_count INTEGER,
      is_favorite INTEGER DEFAULT 0, excluded INTEGER DEFAULT 0,
      cover_art BLOB, added_at INTEGER)`);
  const ins = db.prepare(`INSERT INTO albums
    (id, title, album_artist, artist, year, primary_format, track_count, excluded, cover_art)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (let i = 0; i < 40; i++) {
    ins.run(`a${i}`, `Album ${i}`, `Artist ${i}`, `Artist ${i}`, 2000 + (i % 20),
      'flac', 10, 0, i % 2 ? Buffer.from('art') : null);
  }
  // The three that must never come back.
  ins.run('empty', 'No tracks', 'X', 'X', 1999, 'flac', 0, 0, null);
  ins.run('excluded', 'Excluded', 'X', 'X', 1999, 'flac', 10, 1, null);
  ins.run('both', 'Excluded and empty', 'X', 'X', 1999, 'flac', 0, 1, null);
  return db;
}

test('/albums/random-set returns a random handful of real albums', async (t) => {
  const db = libraryDb();
  const stmt = db.prepare(randomSetSql());

  await t.test('it honours the limit', () => {
    assert.equal(stmt.all(15).length, 15);
    assert.equal(stmt.all(3).length, 3);
  });

  await t.test('it never returns an empty or excluded album', () => {
    const seen = new Set();
    for (let i = 0; i < 60; i++) for (const r of stmt.all(15)) seen.add(r.id);
    for (const banned of ['empty', 'excluded', 'both']) {
      assert.equal(seen.has(banned), false, `${banned} came back from random-set`);
    }
  });

  await t.test('it is actually random', () => {
    // The bug this catches is a query that says RANDOM() and is not: an
    // ORDER BY that resolves to rowid returns the same fifteen every time,
    // and the Refresh button then does nothing visible.
    const first = stmt.all(15).map(r => r.id).join(',');
    let differed = false;
    for (let i = 0; i < 20 && !differed; i++) {
      if (stmt.all(15).map(r => r.id).join(',') !== first) differed = true;
    }
    assert.ok(differed, 'twenty rolls of fifteen from forty albums were all identical');
  });

  await t.test('it selects what the tile needs', () => {
    const row = stmt.all(1)[0];
    for (const col of ['id', 'title', 'album_artist', 'artist', 'year', 'has_art']) {
      assert.ok(col in row, `random-set does not select ${col}`);
    }
    // has_art is a flag, not the blob: sending 40 covers inline would be
    // megabytes on a request that only needs to know whether to show ♫.
    assert.equal('cover_art' in row, false, 'random-set is shipping the artwork blob');
  });
});

test('/albums/random-set is declared where Express will reach it', () => {
  const src = readServer('routes', 'library.js');
  const randomSet = src.indexOf(`router.get('/albums/random-set'`);
  const byId = src.indexOf(`router.get('/albums/:id'`);
  assert.notEqual(randomSet, -1, '/albums/random-set is gone');
  assert.notEqual(byId, -1, '/albums/:id is gone');
  assert.ok(randomSet < byId,
    '/albums/random-set is declared after /albums/:id, so :id swallows it and ' +
    'the carousel gets a 404 with id="random-set"');
});

test('the /api/home routes are mounted', async (t) => {
  const routes = readServer('routes', 'home.js');
  const index = readServer('index.js');

  await t.test('the router is wired into the app', () => {
    assert.match(index, /require\('\.\/routes\/home'\)/);
    assert.match(index, /app\.use\('\/api\/home', homeRouter\)/);
  });

  await t.test('both verbs exist', () => {
    assert.match(routes, /router\.get\('\/prefs'/);
    assert.match(routes, /router\.put\('\/prefs'/);
  });

  await t.test('a PUT naming nothing we know is refused', () => {
    // Without this a typo'd key round-trips as 200 OK and the switch springs
    // back a moment later with no explanation.
    assert.match(code(routes), /HOME_PREF_KEYS\.some\(k => typeof patch\[k\] === 'boolean'\)/);
    assert.match(code(routes), /status\(400\)/);
  });
});

// ---------------------------------------------------------------------------
// The Home screen itself.
// ---------------------------------------------------------------------------

test('Recent activity is two rows now, not one with tabs', async (t) => {
  const home = readClient('components', 'HomeScreen.jsx');
  const bare = code(home);

  await t.test('the tab strip is gone, and so is everything that fed it', () => {
    const orphans = ['setTab', 'tabBtn', 'tabBtnActive', 'tabUnderline', 'loadingRecent', 'RecentRow'];
    const left = orphans.filter(o => bare.includes(o));
    assert.deepEqual(left, [], 'left behind by the tab removal: ' + left.join(', '));
    assert.doesNotMatch(bare, /Recent activity/,
      'the old single-row heading is still rendered');
  });

  await t.test('there are three carousels, each with its own heading', () => {
    for (const title of ['Recently added', 'Recently played', 'Random albums']) {
      assert.match(bare, new RegExp(`title="${title}"`), `no carousel titled ${title}`);
    }
    assert.equal((bare.match(/<Carousel\b/g) || []).length, 3);
  });

  await t.test('each row fetches only when its switch is on', () => {
    // The guard has to sit in the same effect as the request, or a row that is
    // off still costs a query on every visit to Home.
    const effects = bare.split('useEffect(');
    const guarded = {
      'recentlyAdded':  `/library/albums/recent?type=added`,
      'recentlyPlayed': `/library/albums/recent?type=played`,
      'randomAlbums':   `/library/albums/random-set`,
    };
    for (const [key, url] of Object.entries(guarded)) {
      const body = effects.find(e => e.includes(url));
      assert.ok(body, `nothing fetches ${url}`);
      assert.match(body, new RegExp(`if \\(!prefs \\|\\| !prefs\\.${key}\\) return`),
        `the ${key} row fetches without checking whether it is switched on`);
    }
  });

  await t.test('a row that is switched off is not rendered', () => {
    for (const key of ['recentlyAdded', 'recentlyPlayed', 'randomAlbums']) {
      assert.match(bare, new RegExp(`prefs && prefs\\.${key} && \\(`),
        `the ${key} carousel renders regardless of its switch`);
    }
  });

  await t.test('the library counters are still at the top', () => {
    // They were explicitly kept. A tile lost in the rewrite would be a
    // regression nobody asked for.
    for (const label of ['ARTISTS', 'ALBUMS', 'TRACKS', 'GENRES']) {
      assert.match(bare, new RegExp(`label="${label}"`), `the ${label} counter is gone`);
    }
    assert.ok(bare.indexOf('s.tilesRow') < bare.indexOf('<Carousel'),
      'the counters no longer come before the carousels');
  });

  await t.test('only the Random row\'s heading opens something', () => {
    // The chevron is the affordance for "there is a screen behind this". If
    // the other two grew one it would stop meaning anything.
    assert.equal((bare.match(/onTitleClick=/g) || []).length, 1);
    assert.match(bare, /onTitleClick=\{\(\) => onSidebarSection && onSidebarSection\('random'\)\}/);
  });
});

test('the Random-albums wall is three across and reachable', async (t) => {
  const wall = readClient('components', 'RandomAlbumsScreen.jsx');
  const app = readClient('App.jsx');
  const bare = code(wall);

  await t.test('App routes the section to it', () => {
    assert.match(app, /import RandomAlbumsScreen from '\.\/components\/RandomAlbumsScreen'/);
    assert.match(code(app), /sidebarSection === 'random'\) return <RandomAlbumsScreen/);
  });

  await t.test('3 columns, 5 rows, 15 albums', () => {
    assert.match(bare, /const COLS = 3\b/);
    assert.match(bare, /const ROWS = 5\b/);
    assert.match(bare, /const COUNT = COLS \* ROWS/);
    // The grid must be built FROM the constant, not from a 3 typed again
    // beside it — two spellings of the same number drift.
    assert.match(bare, /gridTemplateColumns: `repeat\(\$\{COLS\}, 1fr\)`/);
    assert.match(bare, /random-set\?limit=\$\{COUNT\}/);
  });

  await t.test('there is a refresh at the top', () => {
    assert.match(bare, /aria-label="Refresh"/);
    assert.match(bare, /onClick=\{load\}/);
    assert.ok(bare.indexOf('aria-label="Refresh"') < bare.indexOf('style={s.grid}'),
      'the refresh button is not above the grid');
  });

  await t.test('the artwork is not draggable', () => {
    // Same rule as every other surface that draws cover art — see
    // artwork-longpress.test.js, which lists this file too.
    assert.match(bare, /draggable=\{false\}/);
  });
});

test('Settings puts the local rows above the break line', async (t) => {
  const section = readClient('components', 'HomeScreenSection.jsx');
  const bare = code(section);

  await t.test('both groups are there', () => {
    for (const key of ['recentlyAdded', 'recentlyPlayed', 'randomAlbums']) {
      assert.match(bare, new RegExp(`key: '${key}'`), `${key} has no switch`);
    }
    for (const key of ['qobuzReleases', 'bandcampReleases', 'pitchforkArticles', 'bandcampArticles']) {
      assert.match(bare, new RegExp(`key: '${key}'`), `${key} lost its switch`);
    }
  });

  await t.test('the carousels come first, then a rule, then the news', () => {
    const carousels = bare.indexOf('rows={CAROUSEL_ROWS}');
    const rule = bare.indexOf('<hr style={s.rule} />');
    const news = bare.indexOf('rows={NEWS_ROWS}');
    assert.ok(carousels !== -1 && rule !== -1 && news !== -1, 'one of the three is missing');
    assert.ok(carousels < rule, 'the carousel switches are not above the break line');
    assert.ok(rule < news, 'the news switches are not below the break line');
  });

  await t.test('each group writes to its own endpoint', () => {
    // One endpoint for both would have forced one default onto both groups.
    assert.match(bare, /makeToggle\('\/home\/prefs', carousels, setCarousels\)/);
    assert.match(bare, /makeToggle\('\/news\/prefs', news, setNews\)/);
  });
});
