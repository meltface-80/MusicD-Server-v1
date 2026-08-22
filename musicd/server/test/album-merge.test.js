// test/album-merge.test.js — v1.1.43.0
//
// Album merging, the search-field focus, and the two new Home links.
//
// The merge tests are behavioural: they run the real module against a real
// SQLite database and check the rows afterwards. Merging is destructive —
// it deletes album rows — so "it looked right in the UI" is not a standard
// this can be held to.
//
// The one grep-shaped check here is the SCANNER REDIRECT, and it carries a
// detector self-test, because a merge that does not survive a rescan is
// the failure mode that would go unnoticed for a night and then look like
// a bug in something else entirely.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SERVER_SRC = path.join(__dirname, '..', 'src');
const CLIENT_SRC = path.join(__dirname, '..', '..', 'client', 'src');
const read = (...p) => fs.readFileSync(path.join(SERVER_SRC, ...p), 'utf8');
const readClient = (...p) => fs.readFileSync(path.join(CLIENT_SRC, ...p), 'utf8');

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:])\/\/.*$/gm, '$1');
}

// A throwaway database with three single-disc albums, two tracks each.
function withDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'musicd-merge-'));
  const prev = process.env.DB_PATH;
  process.env.DB_PATH = path.join(dir, 'm.db');
  const MODS = ['../src/db', '../src/albumMerge', '../src/streamingLibrary'];
  for (const m of MODS) delete require.cache[require.resolve(m)];
  const db = require('../src/db');
  try {
    db.init();
    const h = db.get();
    const A = h.prepare(
      'INSERT INTO albums (id,title,artist,album_artist,year,album_folder,track_count,excluded) VALUES (?,?,?,?,?,?,?,0)');
    const T = h.prepare(
      'INSERT INTO tracks (id,path,title,album,album_artist,album_id,disc_number,track_number,duration,excluded) VALUES (?,?,?,?,?,?,?,?,?,0)');
    for (const n of [1, 2, 3]) {
      A.run(`A${n}`, `Record CD${n}`, 'Prince', 'Prince', 1987, `/m/CD${n}`, 2);
      T.run(`t${n}a`, `/m/CD${n}/1.flac`, `Song ${n}a`, `Record CD${n}`, 'Prince', `A${n}`, 1, 1, 300);
      T.run(`t${n}b`, `/m/CD${n}/2.flac`, `Song ${n}b`, `Record CD${n}`, 'Prince', `A${n}`, 1, 2, 300);
    }
    return fn(require('../src/albumMerge'), h, db);
  } finally {
    try { db.close(); } catch (e) { /* already closed by a failed init */ }
    for (const m of MODS) delete require.cache[require.resolve(m)];
    if (prev === undefined) delete process.env.DB_PATH; else process.env.DB_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const tracksOf = (h) => h.prepare('SELECT id, album_id, disc_number FROM tracks ORDER BY id').all();
const albumIds = (h) => h.prepare('SELECT id FROM albums ORDER BY id').all().map(r => r.id);

test('merging joins albums in the order they were picked', async (t) => {
  await t.test('the first picked becomes disc 1, the rest follow', () => {
    withDb((M, h) => {
      const r = M.merge(['A2', 'A3', 'A1']);        // deliberately not id order
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.targetId, 'A2');
      const byId = Object.fromEntries(tracksOf(h).map(x => [x.id, x]));
      // A2 was picked first, so its tracks are disc 1 — even though A1
      // sorts first and would win any implicit ordering.
      assert.equal(byId.t2a.disc_number, 1);
      assert.equal(byId.t3a.disc_number, 2);
      assert.equal(byId.t1a.disc_number, 3);
      for (const t2 of Object.values(byId)) assert.equal(t2.album_id, 'A2');
      assert.deepEqual(albumIds(h), ['A2'], 'the absorbed album rows should be gone');
    });
  });

  await t.test('it refuses the cases that would corrupt the library', () => {
    withDb((M) => {
      assert.equal(M.merge(['A1']).reason, 'need-two');
      assert.equal(M.merge([]).reason, 'need-two');
      assert.equal(M.merge(['A1', 'A1']).reason, 'duplicate');
      assert.equal(M.merge(['A1', 'nope']).reason, 'missing');
    });
    withDb((M) => {
      M.merge(['A1', 'A2']);
      // A2 is merged away; folding it into something else would chain.
      assert.equal(M.merge(['A3', 'A2']).reason, 'already-merged');
      // A1 is a target with sources of its own; absorbing it would orphan them.
      assert.equal(M.merge(['A3', 'A1']).reason, 'is-target');
    });
  });
});

test('unmerging puts everything back exactly as it was', async (t) => {
  await t.test('albums return, and each track gets its ORIGINAL disc back', () => {
    withDb((M, h) => {
      // A3 is made genuinely multi-disc first, so the test can tell
      // "restored" apart from "flattened to disc 1".
      h.prepare("UPDATE tracks SET disc_number = 2 WHERE id = 't3b'").run();
      const before = tracksOf(h);
      const beforeAlbums = albumIds(h);

      assert.equal(M.merge(['A1', 'A2', 'A3']).ok, true);
      assert.deepEqual(albumIds(h), ['A1']);

      const r = M.unmerge('A1');
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.deepEqual(albumIds(h), beforeAlbums, 'the source albums did not come back');
      assert.deepEqual(tracksOf(h), before,
        'a track came back on the wrong album or the wrong disc — note t3b was '
        + 'disc 2 before the merge and must not be flattened to disc 1');
    });
  });

  await t.test('the restored album rows keep their own details', () => {
    withDb((M, h) => {
      M.merge(['A1', 'A2']);
      M.unmerge('A1');
      const a2 = h.prepare('SELECT title, album_folder, year FROM albums WHERE id = ?').get('A2');
      assert.equal(a2.title, 'Record CD2',
        'an albums row is not reconstructible from its tracks — the snapshot is');
      assert.equal(a2.album_folder, '/m/CD2');
      assert.equal(a2.year, 1987);
    });
  });

  await t.test('unmerging something that was never merged is refused', () => {
    withDb((M) => {
      assert.equal(M.unmerge('A1').reason, 'not-merged');
    });
  });
});

test('a merge survives the next library scan', async (t) => {
  // THE failure mode worth a test of its own. An album id is a hash of
  // (artist, title, folder). Move the tracks and the next scan recomputes
  // that hash from the files, finds the source album gone, recreates it and
  // pulls the tracks back — silently, overnight.
  await t.test('the mapping answers for a merged-away id', () => {
    withDb((M) => {
      M.merge(['A1', 'A2']);
      assert.deepEqual(M.redirect('A2'), { albumId: 'A1', disc: 2, merged: true });
      // The target must NOT redirect, or the scanner loops.
      assert.deepEqual(M.redirect('A1'), { albumId: 'A1', disc: null, merged: false });
      assert.deepEqual(M.redirect('A3'), { albumId: 'A3', disc: null, merged: false });
      M.unmerge('A1');
      assert.deepEqual(M.redirect('A2'), { albumId: 'A2', disc: null, merged: false });
    });
  });

  await t.test('the scanner consults it, and does not recreate the source', () => {
    const src = stripComments(read('scanner.js'));
    assert.match(src, /albumMerge\.redirect\(/,
      'the scanner does not consult the merge map — every merge will be undone '
      + 'by the next scan');
    // The redirect has to be resolved BEFORE the disc number, because the
    // merge's disc overrides the file's own tag and `const` is not hoisted.
    const atRedirect = src.indexOf('albumMerge.redirect(');
    const atDisc = src.indexOf('const discNo');
    assert.ok(atRedirect !== -1 && atRedirect < atDisc,
      'discNo is computed before the merge redirect, so the file tag wins');
    // And the source album row must not be rebuilt underneath the merge.
    assert.match(src, /if \(mergeInfo\.merged\) return/,
      'ensureAlbum still runs for a merged-away album, which puts an empty '
      + 'duplicate tile back on the wall');
  });

  await t.test('DETECTOR: the needles fail against a scanner with no redirect', () => {
    const old = `
      const albumFolder = albumFolderFor(filePath);
      const discNo = discNumberFor(filePath, common.disk?.no);
      const trackAlbumId = albumIdFor(albumArtist, album, albumFolder);
      ensureAlbum(albumArtist, album);
    `;
    assert.ok(!/albumMerge\.redirect\(/.test(old),
      'the redirect needle matches a scanner that has none');
    assert.ok(!/if \(mergeInfo\.merged\) return/.test(old),
      'the ensureAlbum-guard needle matches a scanner that has none');
  });
});

test('the selection remembers the order it was picked in', async (t) => {
  const src = stripComments(readClient('components', 'AlbumSelection.jsx'));

  await t.test('order is explicit state, not an incidental Set property', () => {
    // A JS Set does iterate in insertion order, so relying on that would
    // work — until someone filters or rebuilds it and disc 2 quietly
    // becomes disc 3.
    assert.match(src, /const \[order, setOrder\]/, 'the order is not kept');
    assert.match(src, /order,/, 'the hook does not expose the order');
    assert.match(src, /indexOf/, 'there is no way to show a tile its position');
  });

  await t.test('merge is ordered, confirmed, and hidden below two ticks', () => {
    const spec = src.slice(src.indexOf("id: 'merge'"), src.indexOf("id: 'merge'") + 200);
    assert.match(spec, /ordered: true/);
    assert.match(spec, /confirm: true/);
    assert.match(spec, /minCount: 2/);
    assert.match(src, /if \(minCount && count < minCount\) return null/,
      'merge is shown disabled rather than hidden on a single tick');
  });

  await t.test('the runner prefers the ordered list over the set', () => {
    assert.match(src, /runSelectionAction\(action, ids, order\)/);
    assert.match(src, /Array\.isArray\(order\) && order\.length \? \[\.\.\.order\] : \[\.\.\.ids\]/,
      'the order is ignored, so the disc numbering is whatever the Set says');
  });

  await t.test('every grid passes the order through — no partial migration', () => {
    for (const f of ['AlbumGrid.jsx', 'RandomAlbumsScreen.jsx', 'RecentAlbumsScreen.jsx']) {
      const g = readClient('components', f);
      assert.match(g, /runSelectionAction\(action, selection\.selected, selection\.order\)/,
        `${f} still calls the runner without the order, so merging from that `
        + 'grid would number the discs wrongly');
      assert.match(g, /selectionIndex=\{selection\.indexOf\(/,
        `${f} does not show the pick order on its tiles`);
      assert.match(g, /orderedIds=\{selection\.order\}/,
        `${f} does not give the confirmation the order to display`);
    }
    // And the wrapper in AlbumGrid must forward it rather than swallow it.
    const grid = readClient('components', 'AlbumGrid.jsx');
    const card = grid.slice(grid.indexOf('function AlbumCard'));
    assert.match(card.slice(0, 600), /selectionIndex=\{selectionIndex\}/,
      'AlbumCard drops selectionIndex, so the main Albums wall shows plain ticks');
  });
});

test('the search field can raise the iOS keyboard', async (t) => {
  const src = readClient('App.jsx');

  await t.test('focus happens inside the tap handler, not in a callback', () => {
    // iOS Safari only raises the keyboard for a focus() that runs inside the
    // user-gesture handler. A requestAnimationFrame callback is a fresh
    // task, the user activation is gone, and all you get is a caret.
    const fn = src.slice(src.indexOf('const expandSearch'), src.indexOf('const collapseSearch'));
    assert.ok(!/requestAnimationFrame/.test(fn),
      'the focus is deferred to a rAF again — the caret appears and the '
      + 'keyboard does not');
    assert.match(fn, /inputRef\.current\?\.focus\(\)/);
    const focusAt = fn.indexOf('focus()');
    const stateAt = fn.indexOf('setSearchExpanded');
    assert.ok(focusAt !== -1 && focusAt < stateAt,
      'focus() runs after the state change, so the input does not exist yet');
  });

  await t.test('the input is always mounted and focusably hidden', () => {
    // It has to be a real element at the moment of the tap. Hidden with
    // display:none or visibility:hidden it cannot take focus at all.
    assert.match(src, /searchWrapHidden/, 'there is no collapsed style');
    const style = src.slice(src.indexOf('searchWrapHidden:'), src.indexOf('searchWrapHidden:') + 200);
    assert.ok(!/display: 'none'/.test(style) && !/visibility: 'hidden'/.test(style),
      'the collapsed input is hidden in a way that makes it unfocusable');
    assert.match(style, /overflow: 'hidden'/);
    // Collapsed it must not be a tab stop or announced.
    assert.match(src, /tabIndex=\{searchExpanded \? 0 : -1\}/);
    assert.match(src, /aria-hidden=\{searchExpanded \? undefined : true\}/);
  });
});

test('all three Home carousels lead somewhere', () => {
  const home = readClient('components', 'HomeScreen.jsx');
  for (const section of ['recently-added', 'recently-played', 'random']) {
    assert.ok(home.includes(`onSidebarSection('${section}')`),
      `the ${section} heading is not a link — Random albums was the only one, `
      + 'which made the chevron read as "this row is special"');
  }
  const app = readClient('App.jsx');
  for (const section of ['recently-added', 'recently-played']) {
    assert.ok(app.includes(`sidebarSection === '${section}'`),
      `App.jsx does not route ${section}, so the heading leads to a blank screen`);
  }
  // One component, two types — not two near-copies of the same screen.
  assert.match(app, /<RecentAlbumsScreen type="added"/);
  assert.match(app, /<RecentAlbumsScreen type="played"/);
});
