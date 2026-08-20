// Playlists, and the three menu rows that shipped disabled.
//
// The track menu carried four greyed-out rows with version badges on them —
// "Add to Playlist v60", "Add to Tag v61", "Save for later v61",
// "Suggestions v62+". Two of the four were waiting on nothing: the
// save-for-later route and the per-track tag endpoints both already existed
// and were already wired for albums. Only playlists needed building.
//
// These run the real route handlers against a real in-memory SQLite, using
// the schema db.js actually declares, so the behaviour asserted is the
// behaviour shipped rather than a description of it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const Module = require('node:module');

const SERVER_SRC = path.join(__dirname, '..', 'src');
const CLIENT_SRC = path.join(__dirname, '..', '..', 'client', 'src');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// Build the playlist tables from db.js's own DDL, so a schema change that
// breaks the routes fails here rather than on a user's device.
const DB_SRC = read(SERVER_SRC, 'db.js');
function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE tracks (
    id TEXT PRIMARY KEY, title TEXT, artist TEXT, album TEXT, album_artist TEXT,
    duration REAL, format TEXT, codec TEXT, track_number INT, disc_number INT)`);
  // Start at the try{, not at the first CREATE — the opening db.exec( sits
  // above it and the lift below matches on db.exec(...).
  const block = DB_SRC.slice(DB_SRC.indexOf('// ── Playlists (v1.1.19.0)'),
                             DB_SRC.indexOf("} catch (e) { console.error('[db] playlists create:"));
  assert.ok(block, 'could not find the playlists DDL block in db.js');
  // Take the argument of each db.exec(...) verbatim — backtick or quoted —
  // rather than pattern-matching the SQL, so what runs here is exactly the
  // text db.js runs.
  const ddl = [...block.matchAll(/db\.exec\(\s*(?:`([^`]*)`|'([^']*)')\s*\)/g)]
    .map(m => (m[1] || m[2]).trim());
  assert.equal(ddl.length, 4,
    `expected 2 tables + 2 indexes from db.js, lifted ${ddl.length}`);
  for (const stmt of ddl) db.exec(stmt);
  for (let i = 1; i <= 5; i++) {
    db.prepare('INSERT INTO tracks (id,title,duration) VALUES (?,?,?)').run('t' + i, 'Track ' + i, 180);
  }
  return db;
}

// Load the router with ../db swapped for our in-memory handle.
function loadRouter(db) {
  const orig = Module._load;
  Module._load = function (req) {
    if (req === '../db') return { get: () => db };
    return orig.apply(this, arguments);
  };
  try {
    delete require.cache[require.resolve('../src/routes/playlists')];
    return require('../src/routes/playlists');
  } finally { Module._load = orig; }
}

// Minimal express-route driver: match path + method, run the handler.
function driver(router) {
  return (method, url, body) => new Promise((resolve) => {
    for (const layer of router.stack.filter(l => l.route)) {
      const keys = [];
      const re = new RegExp('^' + layer.route.path
        .replace(/:([A-Za-z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
      const m = url.match(re);
      if (m && layer.route.methods[method.toLowerCase()]) {
        const params = {};
        keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        const res = {
          statusCode: 200,
          status(c) { this.statusCode = c; return this; },
          json(o) { resolve({ status: this.statusCode, body: o }); },
        };
        return layer.route.stack[0].handle({ params, body: body || {}, query: {} }, res, () => {});
      }
    }
    resolve({ status: 404, body: { error: 'no route' } });
  });
}

test('a playlist holds an ordered set of tracks', async (t) => {
  const db = makeDb();
  const call = driver(loadRouter(db));

  const created = await call('POST', '/', { name: '  My   Mix  ' });
  const id = created.body.playlist.id;

  await t.test('the name is normalised, not stored as typed', () => {
    assert.equal(created.body.playlist.name, 'My Mix',
      'runs of whitespace should collapse so two "My  Mix" playlists are not distinct');
  });

  await t.test('tracks are added and kept in order', async () => {
    const r = await call('POST', `/${id}/tracks`, { trackIds: ['t1', 't2', 't3'] });
    assert.deepEqual(r.body, { ok: true, added: 3, requested: 3 });
    const got = await call('GET', `/${id}`);
    assert.deepEqual(got.body.tracks.map(x => x.id), ['t1', 't2', 't3']);
  });

  await t.test('adding again is idempotent, and says so', async () => {
    // The menu action can be tapped twice. Duplicating the row silently is
    // the wrong answer; so is failing.
    const r = await call('POST', `/${id}/tracks`, { trackIds: ['t2', 't4'] });
    assert.deepEqual(r.body, { ok: true, added: 1, requested: 2 });
    const got = await call('GET', `/${id}`);
    assert.deepEqual(got.body.tracks.map(x => x.id), ['t1', 't2', 't3', 't4']);
  });

  await t.test('a track the library does not have is skipped, not an error', async () => {
    const r = await call('POST', `/${id}/tracks`, { trackIds: ['nope'] });
    assert.equal(r.status, 200);
    assert.equal(r.body.added, 0);
  });

  await t.test('re-adding after a removal cannot collide with a live position', async () => {
    // Positions continue from the current MAXIMUM, not from the row count.
    // Counting would reuse a position a later track still holds, and ORDER BY
    // position would then be ambiguous between them.
    //
    // Asserting the resulting ORDER is not enough to catch that: on a tie
    // SQLite happens to return them in rowid order, which is the order the
    // test wanted anyway. The first version of this check passed the bug. So
    // assert the invariant itself — positions within a playlist are unique.
    assert.equal((await call('DELETE', `/${id}/tracks/t2`)).status, 200);
    let got = await call('GET', `/${id}`);
    assert.deepEqual(got.body.tracks.map(x => x.id), ['t1', 't3', 't4']);
    await call('POST', `/${id}/tracks`, { trackIds: ['t2'] });

    const rows = db.prepare(
      'SELECT track_id, position FROM playlist_tracks WHERE playlist_id = ? ORDER BY position'
    ).all(id);
    const positions = rows.map(r => r.position);
    assert.equal(new Set(positions).size, positions.length,
      `two tracks share a position: ${JSON.stringify(rows)}`);

    got = await call('GET', `/${id}`);
    assert.deepEqual(got.body.tracks.map(x => x.id), ['t1', 't3', 't4', 't2'],
      're-added track did not land at the end');
  });

  await t.test('the list carries counts and total duration', async () => {
    const r = await call('GET', '/');
    assert.equal(r.body.playlists.length, 1);
    assert.equal(r.body.playlists[0].trackCount, 4);
    assert.equal(r.body.playlists[0].duration, 720);
  });

  await t.test('it can say which playlists a track is in', async () => {
    const r = await call('GET', '/for-track/t2');
    assert.deepEqual(r.body.playlistIds, [id]);
    assert.deepEqual((await call('GET', '/for-track/t5')).body.playlistIds, []);
  });

  await t.test('renaming works and deleting takes its rows with it', async () => {
    assert.equal((await call('PATCH', `/${id}`, { name: 'Renamed' })).body.name, 'Renamed');
    assert.equal((await call('DELETE', `/${id}`)).status, 200);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM playlist_tracks').get().c, 0,
      'ON DELETE CASCADE did not fire — orphan rows left behind');
    assert.equal((await call('GET', `/${id}`)).status, 404);
  });
});

test('the routes refuse what they cannot act on', async (t) => {
  const call = driver(loadRouter(makeDb()));

  await t.test('a blank name is rejected', async () => {
    assert.equal((await call('POST', '/', { name: '   ' })).status, 400);
    assert.equal((await call('POST', '/', {})).status, 400);
  });

  await t.test('adding to a playlist that is not there is a 404', async () => {
    assert.equal((await call('POST', '/nosuch/tracks', { trackIds: ['t1'] })).status, 404);
  });

  await t.test('an empty add is a 400, not a silent success', async () => {
    const p = await call('POST', '/', { name: 'X' });
    assert.equal((await call('POST', `/${p.body.playlist.id}/tracks`, { trackIds: [] })).status, 400);
  });

  await t.test('removing a track that is not in it is a 404', async () => {
    const p = await call('POST', '/', { name: 'Y' });
    assert.equal((await call('DELETE', `/${p.body.playlist.id}/tracks/t1`)).status, 404);
  });

  await t.test('a very long name is capped rather than rejected', async () => {
    const r = await call('POST', '/', { name: 'z'.repeat(500) });
    assert.equal(r.status, 200);
    assert.ok(r.body.playlist.name.length <= 80);
  });
});

test('creating with tracks is one round trip', async () => {
  // "New playlist" from the add-to-playlist sheet has to create AND fill,
  // or the user makes an empty playlist and has to add the track again.
  const call = driver(loadRouter(makeDb()));
  const r = await call('POST', '/', { name: 'Mix', trackIds: ['t1', 't2'] });
  assert.equal(r.body.playlist.trackCount, 2);
  const got = await call('GET', `/${r.body.playlist.id}`);
  assert.deepEqual(got.body.tracks.map(t => t.id), ['t1', 't2']);
});

test('the menu rows that shipped disabled now do something', async (t) => {
  const np = code(read(CLIENT_SRC, 'components', 'NowPlayingFullScreen.jsx'));

  await t.test('Add to Playlist opens the sheet', () => {
    assert.match(np, /onClick=\{\(\) => setShowPlaylistSheet\(true\)\}/);
    assert.match(np, /<AddToPlaylistSheet/);
  });

  await t.test('Add to Tag opens the existing TagPicker', () => {
    // The component and its endpoints already existed for albums; the row
    // was disabled anyway.
    assert.match(np, /onClick=\{\(\) => setShowTagPicker\(true\)\}/);
    assert.match(np, /entityKind="track"/);
  });

  await t.test('Save for later calls the route that already existed', () => {
    assert.match(np, /onClick=\{toggleSaved\}/);
    assert.match(np, /toggleTrackSaved\(track\.id, next\)/);
  });

  await t.test('none of the three is still rendered disabled', () => {
    for (const label of ['Add to Playlist', 'Add to Tag', 'Save for later']) {
      const at = np.indexOf(label);
      assert.ok(at !== -1, `${label} row is gone entirely`);
      // Walk back to the <button that owns the label and check it.
      const btn = np.lastIndexOf('<button', at);
      const decl = np.slice(btn, at);
      assert.ok(!/overflowItemDisabled/.test(decl), `${label} is still disabled`);
    }
  });

  await t.test('the version badges are gone from them', () => {
    assert.ok(!/<span style=\{s\.overflowSoon\}>v6[01]<\/span>/.test(np),
      'a "v60"/"v61" badge is still promising a feature that now exists');
  });

  await t.test('Suggestions is still honestly disabled', () => {
    // It has no backing and no single meaning; leaving it enabled would be
    // worse than leaving it greyed out.
    const at = np.indexOf('Suggestions');
    const btn = np.lastIndexOf('<button', at);
    assert.match(np.slice(btn, at), /overflowItemDisabled/,
      'Suggestions was enabled without anything behind it');
  });
});

test('the share card clears the transport bar and has no Download', async (t) => {
  for (const file of ['AlbumDetail.jsx', 'NowPlayingFullScreen.jsx']) {
    const src = read(CLIENT_SRC, 'components', file);
    const overlay = src.slice(src.indexOf('  shareOverlay: {'),
                              src.indexOf('  shareSheet: {'));

    await t.test(`${file}: the card is centred, not bottom-anchored`, () => {
      // flex-end put it under the mini player, which is where its own
      // Download button ended up.
      assert.match(overlay, /alignItems: 'center'/,
        'the share card still sits at the bottom of the screen');
      assert.ok(!/alignItems: 'flex-end'/.test(overlay));
    });

    await t.test(`${file}: it clears the safe areas itself`, () => {
      assert.match(overlay, /var\(--safe-bot\)/, 'no home-indicator inset');
      assert.match(overlay, /var\(--safe-top\)/, 'no status-bar inset');
    });

    await t.test(`${file}: the Download button is gone`, () => {
      assert.ok(!/navigator\.canShare \? 'Share…' : 'Download'/.test(src),
        'the Download/Share button is still there');
      assert.ok(!/handleShareSend/.test(src),
        'the button is gone but its handler is still here');
    });

    await t.test(`${file}: the card is still long-pressable`, () => {
      // .allow-callout is what lets iOS offer Save/Share on the image, which
      // is the whole replacement for the button.
      assert.match(src, /className="allow-callout"/,
        'the share card image opted out of the OS callout');
    });
  }
});
