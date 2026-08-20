// Home-screen news sources, and the promise that off means off.
//
// Until v1.1.20.0 the news loop ran unconditionally: an interval was
// registered at boot and five upstream feeds — three Pitchfork RSS, a Qobuz
// scrape, and a Bandcamp crawl that fetches five articles and then up to 24
// album pages — were fetched every 30 minutes whether or not anyone wanted
// them. There was no way to say no.
//
// The requirement is stronger than "hide the row": a fresh install must make
// NO outside request until someone asks, and switching the last source off
// must stop the timer rather than keep fetching into a hidden panel. That is
// only demonstrable by running it, so these run it — with axios replaced by a
// counter that throws if anything reaches for the network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const Database = require('better-sqlite3');

const CLIENT_SRC = path.join(__dirname, '..', '..', 'client', 'src');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// A news module wired to an in-memory database and a network that counts
// every call and refuses to make one.
function loadNews() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE news_items (
      id TEXT PRIMARY KEY, source TEXT, section TEXT, title TEXT, excerpt TEXT,
      url TEXT UNIQUE, image_url TEXT, published_at INTEGER, fetched_at INTEGER,
      kind TEXT, artist TEXT)`);
  const net = { calls: 0, urls: [] };

  // Whether a refresh is scheduled is read from the module itself
  // (_hasRefreshTimer) rather than by stubbing global.setInterval. The first
  // version of this harness swapped the global out for the duration of the
  // require and put it back afterwards — so every later applyPrefs() got the
  // REAL setInterval, registered a live 30-minute handle, and hung the run.
  const orig = Module._load;
  Module._load = function (req) {
    if (req === './db' || req === '../db') return { get: () => db, isReady: () => true };
    if (req === 'axios') {
      return { get: (url) => { net.calls++; net.urls.push(url); return Promise.reject(new Error('network must not be touched')); } };
    }
    return orig.apply(this, arguments);
  };
  let news;
  try {
    delete require.cache[require.resolve('../src/news')];
    news = require('../src/news');
  } finally {
    Module._load = orig;
  }
  // Leaving a source enabled at the end of a test would leave a real interval
  // registered and hold the process open, so every harness registers its own
  // teardown rather than trusting each test to remember.
  test.after(() => {
    try {
      news.setNewsPrefs({
        qobuzReleases: false, bandcampReleases: false,
        pitchforkArticles: false, bandcampArticles: false,
      });
      news.stop();
    } catch { /* the module may already be torn down */ }
  });
  return { news, db, net };
}

test('a fresh install asks for nothing', async (t) => {
  const { news, net } = loadNews();

  await t.test('every source is off by default', () => {
    const p = news.getNewsPrefs();
    assert.deepEqual(p, {
      qobuzReleases: false, bandcampReleases: false,
      pitchforkArticles: false, bandcampArticles: false,
    });
    assert.equal(news.anyNewsEnabled(p), false);
  });

  await t.test('an absent settings row means all-off, not all-on', () => {
    // The easy mistake, and the one that would have a new install phone out
    // to three sites on first boot.
    assert.equal(news.anyNewsEnabled(news.getNewsPrefs()), false);
  });

  await t.test('no feed is selected for fetching', () => {
    assert.equal(news.enabledFeeds(news.getNewsPrefs()).length, 0);
  });

  await t.test('start() registers no interval', () => {
    news.start();
    assert.equal(news._hasRefreshTimer(), false,
      'a refresh interval was scheduled with nothing enabled');
  });

  await t.test('a refresh makes no upstream request at all', async () => {
    // Not "fetches and discards" — does not fetch.
    const r = await news.refresh();
    assert.equal(r.skipped, true);
    assert.equal(net.calls, 0, `made ${net.calls} network calls: ${net.urls.join(', ')}`);
  });
});

test('switching a source on starts the work, and off stops it', async (t) => {
  const { news, net } = loadNews();
  news.start();
  assert.equal(news._hasRefreshTimer(), false);

  await t.test('enabling one schedules the refresh', () => {
    news.setNewsPrefs({ pitchforkArticles: true });
    assert.equal(news._hasRefreshTimer(), true,
      'enabling a source did not start the refresh loop');
  });

  await t.test('switching one off leaves the loop running for the other', () => {
    news.setNewsPrefs({ qobuzReleases: true });
    news.setNewsPrefs({ pitchforkArticles: false });
    assert.equal(news._hasRefreshTimer(), true,
      'the loop stopped while a source was still on');
  });

  await t.test('switching the LAST one off stops the loop', () => {
    // The half that is easy to forget. Hiding the row is not enough; the
    // fetching has to stop.
    news.setNewsPrefs({ qobuzReleases: false });
    assert.equal(news._hasRefreshTimer(), false,
      'the refresh loop kept running with every source off');
    assert.equal(news.anyNewsEnabled(news.getNewsPrefs()), false);
  });

  await t.test('and then nothing reaches the network again', async () => {
    const before = net.calls;
    await news.refresh();
    assert.equal(net.calls, before, 'a disabled install still made a request');
  });
});

test('only the feeds a switched-on row needs are fetched', async (t) => {
  const { news } = loadNews();
  const ids = (prefs) => news.enabledFeeds(prefs).map(f => `${f.source}/${f.section}`);

  await t.test('Pitchfork pulls its three RSS feeds and nothing else', () => {
    const got = ids(news.setNewsPrefs({ pitchforkArticles: true }));
    assert.equal(got.length, 3);
    assert.ok(got.every(x => x.startsWith('pitchfork/')), got.join(', '));
  });

  await t.test('Qobuz pulls only the Qobuz feed', () => {
    news.setNewsPrefs({ pitchforkArticles: false });
    assert.deepEqual(ids(news.setNewsPrefs({ qobuzReleases: true })), ['qobuz/Magazine']);
  });

  await t.test('either Bandcamp row runs the one Bandcamp crawl', () => {
    // Both rows come out of a single crawl of daily.bandcamp.com, so it must
    // run for either — and only once when both are on.
    news.setNewsPrefs({ qobuzReleases: false });
    assert.deepEqual(ids(news.setNewsPrefs({ bandcampReleases: true })), ['bandcamp/Daily']);
    news.setNewsPrefs({ bandcampReleases: false });
    assert.deepEqual(ids(news.setNewsPrefs({ bandcampArticles: true })), ['bandcamp/Daily']);
    assert.deepEqual(ids(news.setNewsPrefs({ bandcampReleases: true })), ['bandcamp/Daily'],
      'the crawl was queued twice when both Bandcamp rows are on');
  });
});

test('switching a source off clears what it left behind', async (t) => {
  const { news, db } = loadNews();
  // published_at must be recent: pruneOld() deletes anything older than 30
  // days, which would empty the table for reasons that have nothing to do
  // with the purge being tested here.
  const nowSec = Math.floor(Date.now() / 1000);
  const insert = db.prepare(`INSERT INTO news_items
    (id, source, section, title, url, published_at, fetched_at, kind)
    VALUES (?, ?, 'x', 't', ?, ${nowSec}, ${nowSec}, ?)`);
  insert.run('a', 'pitchfork', 'u1', 'article');
  insert.run('b', 'qobuz', 'u2', 'release');
  insert.run('c', 'bandcamp', 'u3', 'release');
  insert.run('d', 'bandcamp', 'u4', 'article');
  const count = (where) => db.prepare(`SELECT COUNT(*) c FROM news_items WHERE ${where}`).get().c;

  await t.test('a refresh with everything off empties the table', async () => {
    // Otherwise the row a user just switched off keeps showing its last fetch
    // for up to 30 days, until pruneOld gets to it.
    await news.refresh();
    assert.equal(count('1=1'), 0, 'stale items survived with every source off');
  });

  await t.test('one Bandcamp row off drops only its own kind', async () => {
    insert.run('e', 'bandcamp', 'u5', 'release');
    insert.run('f', 'bandcamp', 'u6', 'article');
    news.setNewsPrefs({ bandcampArticles: true, bandcampReleases: false });
    await news.refresh().catch(() => {});   // the crawl will fail; the purge still ran
    assert.equal(count("source='bandcamp' AND kind='release'"), 0,
      'releases survived with only the articles row enabled');
    assert.equal(count("source='bandcamp' AND kind='article'"), 1,
      'the articles row was cleared even though it is switched on');
  });
});

test('the preferences row cannot be talked into switching itself on', async (t) => {
  const { news, db } = loadNews();
  const write = (v) => db.prepare(
    "INSERT INTO settings (key,value) VALUES ('home_news_sources',?) " +
    'ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(v);

  await t.test('malformed JSON reads as all-off', () => {
    write('{not json');
    assert.equal(news.anyNewsEnabled(news.getNewsPrefs()), false);
  });

  await t.test('a non-object reads as all-off', () => {
    for (const v of ['null', '[]', '"yes"', '42']) {
      write(v);
      assert.equal(news.anyNewsEnabled(news.getNewsPrefs()), false, `blob ${v} enabled something`);
    }
  });

  await t.test('only true means true', () => {
    // A truthy string or 1 from some future writer must not count.
    write(JSON.stringify({ qobuzReleases: 'yes', bandcampReleases: 1, pitchforkArticles: {} }));
    assert.equal(news.anyNewsEnabled(news.getNewsPrefs()), false);
    write(JSON.stringify({ qobuzReleases: true }));
    assert.equal(news.getNewsPrefs().qobuzReleases, true);
  });

  await t.test('unknown keys from a later build are ignored', () => {
    write(JSON.stringify({ somethingNew: true }));
    assert.equal(news.anyNewsEnabled(news.getNewsPrefs()), false);
  });

  await t.test('a partial patch leaves the others alone', () => {
    news.setNewsPrefs({ qobuzReleases: true, bandcampArticles: true });
    const after = news.setNewsPrefs({ qobuzReleases: false });
    assert.equal(after.bandcampArticles, true, 'an unrelated switch was reset');
    assert.equal(after.qobuzReleases, false);
  });
});

test('the UI moved where it was asked to', async (t) => {
  const settings = code(read(CLIENT_SRC, 'components', 'SettingsScreen.jsx'));
  const sidebar = code(read(CLIENT_SRC, 'components', 'Sidebar.jsx'));
  const app = code(read(CLIENT_SRC, 'App.jsx'));
  const news = code(read(CLIENT_SRC, 'components', 'NewsSection.jsx'));

  await t.test('Tags is gone from Settings', () => {
    assert.ok(!/TagManagementSection/.test(settings),
      'Settings still renders the tag manager');
    assert.ok(!/id: 'tags'/.test(settings), 'the Settings section registry still lists Tags');
  });

  await t.test('Tags is in the side menu, directly under Favourites', () => {
    const fav = sidebar.indexOf("id: 'favorites'");
    const tags = sidebar.indexOf("id: 'tags'");
    const saved = sidebar.indexOf("id: 'saved'");
    assert.ok(tags > fav, 'Tags is not below Favourites');
    assert.ok(tags < saved, 'Tags did not land directly under Favourites');
    assert.match(app, /sidebarSection === 'tags'\) return <TagsScreen \/>/,
      'the sidebar entry has no screen behind it');
  });

  await t.test('Home Screen took the slot Tags left', () => {
    assert.match(settings, /id: 'home',\s+title: 'Home Screen'/);
    assert.match(settings, /<HomeScreenSection \/>/);
  });

  await t.test('the Home screen hides the block rather than emptying it', () => {
    assert.match(news, /if \(phase === 'disabled'\) return null/,
      'an empty news panel is still rendered when every source is off');
    assert.match(news, /r\.enabled === false/,
      'the client never checks whether anything is enabled');
  });
});
