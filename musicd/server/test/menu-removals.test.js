// Two side-menu entries, and everything behind them (v1.1.25.0).
//
// QUEUE opened a second, separate queue screen. The one behind the Now Playing
// screen's tab switcher is the real one — it has the fold, the pinning, the
// multi-select and the ⋯ actions — and the modal had none of that. Two views of
// the same queue that had drifted apart in what they could do was one more than
// anybody needed.
//
// FOCUS LIBRARY listed saved focus combinations. The owner's reason for
// removing it also removes the feature: a focus combination worth keeping is a
// tag. That matters, because the Focus library was the ONLY screen that could
// list, load, rename or delete a saved focus. Removing just the menu row would
// have left the album grid's "Save as new…" and "Update X" buttons writing rows
// that nothing could ever read again — a feature that is worse broken than
// absent, and precisely the half-finished removal this project has shipped
// before (the album-thumbnail long-press menu; see artwork-longpress.test.js).
//
// So the sweep is the test. Both removals reach through the sidebar, the app
// router, the store, a component file, and — for focus — the album grid, the
// focus hook, the focus bar and four server routes. Every one of those is a
// place a leftover could hide.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CLIENT_SRC = path.join(__dirname, '..', '..', 'client', 'src');
const SERVER_SRC = path.join(__dirname, '..', 'src');
const exists = (p) => fs.existsSync(p);
const readRaw = (...p) => fs.readFileSync(path.join(...p), 'utf8');
// Both removals are explained by name in comments — in the sidebar, in
// library.js, in db.js. Assert on stripped source or the prose satisfies the
// check it was written to explain.
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const client = (...p) => code(readRaw(CLIENT_SRC, ...p));
const server = (...p) => code(readRaw(SERVER_SRC, ...p));

// Every source file in the client, for the sweeps below.
function clientFiles() {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.jsx?$/.test(e.name)) out.push(p);
    }
  })(CLIENT_SRC);
  return out;
}

// Where does `token` still appear, in code rather than in prose?
function survivors(token) {
  return clientFiles()
    .filter(f => new RegExp(`\\b${token}\\b`).test(code(fs.readFileSync(f, 'utf8'))))
    .map(f => path.basename(f));
}

test('the Queue entry and the screen behind it are gone', async (t) => {
  await t.test('the menu row is gone', () => {
    const sidebar = client('components', 'Sidebar.jsx');
    assert.doesNotMatch(sidebar, /<span>Queue<\/span>/, 'the Queue row still renders');
    assert.doesNotMatch(sidebar, /handleQueue/, 'its handler is still here');
  });

  await t.test('the component file is gone', () => {
    assert.equal(exists(path.join(CLIENT_SRC, 'components', 'QueueModal.jsx')), false,
      'QueueModal.jsx is still on disk');
  });

  await t.test('nothing imports or renders it', () => {
    assert.deepEqual(survivors('QueueModal'), [],
      'a dangling import will fail the build, not this test — but only if it is reached');
  });

  await t.test('the store flag that opened it is gone', () => {
    // showQueue had exactly one writer (the sidebar) and one reader (App). A
    // flag nothing can set is a switch with no wire.
    assert.deepEqual(survivors('showQueue'), []);
    assert.deepEqual(survivors('setShowQueue'), []);
  });

  await t.test('the queue behind the Now Playing tab is untouched', () => {
    // The whole justification for removing the other one. If this went too,
    // there would be no queue screen at all.
    const npfs = client('components', 'NowPlayingFullScreen.jsx');
    assert.match(npfs, /function QueueView\(/, 'the real queue view is gone');
    assert.match(npfs, /activeTab === 'queue'/, 'the queue tab is gone');
    assert.match(npfs, /foldSkippedRuns/, 'the queue lost its skipped-run fold');
    assert.match(npfs, /<span>Play now<\/span>/, 'the queue lost its selection actions');
  });
});

test('the Focus library entry and the saved-focus feature are gone', async (t) => {
  await t.test('the menu row and the route are gone', () => {
    assert.doesNotMatch(client('components', 'Sidebar.jsx'), /focusLibrary/);
    assert.doesNotMatch(client('App.jsx'), /focusLibrary/);
  });

  await t.test('the screen file is gone', () => {
    assert.equal(exists(path.join(CLIENT_SRC, 'components', 'FocusLibraryScreen.jsx')), false,
      'FocusLibraryScreen.jsx is still on disk');
  });

  await t.test('the store hand-off it used is gone', () => {
    assert.deepEqual(survivors('pendingFocusToLoad'), []);
    assert.deepEqual(survivors('setPendingFocusToLoad'), []);
  });

  await t.test('the album grid can no longer save a focus', () => {
    // THE point of this test. Leaving these behind is not a tidiness problem:
    // they would write saved_focuses rows that no screen can list, load,
    // rename or delete.
    const grid = client('components', 'AlbumGrid.jsx');
    for (const orphan of ['handleSaveAsNew', 'handleUpdateLoaded', 'handleConfirmSave',
                          'saveModal', 'saveError']) {
      assert.doesNotMatch(grid, new RegExp(`\\b${orphan}\\b`),
        `${orphan} survived — the grid can still write a focus nothing can read`);
    }
    assert.doesNotMatch(grid, /focus\/saved/, 'the grid still posts to the saved-focus routes');
  });

  await t.test('the focus hook no longer tracks a loaded focus', () => {
    const focus = client('components', 'Focus.jsx');
    for (const orphan of ['loadedFocus', 'setLoadedFocus', 'isDirty',
                          'serialisePicks', 'loadSaved', 'markSaved']) {
      assert.doesNotMatch(focus, new RegExp(`\\b${orphan}\\b`), `${orphan} survived in Focus.jsx`);
    }
  });

  await t.test('the focus bar no longer offers to save one', () => {
    const focus = client('components', 'Focus.jsx');
    assert.doesNotMatch(focus, /onSaveAsNew|onUpdateLoaded|barSaveBtnPrimary/);
    assert.doesNotMatch(focus, /Save as new/);
  });

  await t.test('the four server routes are gone', () => {
    const lib = server('routes', 'library.js');
    for (const verb of ['get', 'post', 'put', 'delete']) {
      assert.doesNotMatch(lib, new RegExp(`router\\.${verb}\\('/focus/saved`),
        `${verb.toUpperCase()} /focus/saved survived with nothing to call it`);
    }
    assert.doesNotMatch(lib, /SAVED_FOCUS_MAX/, 'the route-layer constants survived');
    assert.doesNotMatch(lib, /serialisePickRow/, 'the row serialiser survived');
  });
});

test('what the two removals must NOT have taken with them', async (t) => {
  await t.test('the live focus filter still works', () => {
    // Only SAVING a focus went. Filtering the library by one is the feature
    // itself and was never in question.
    const focus = client('components', 'Focus.jsx');
    const grid = client('components', 'AlbumGrid.jsx');
    for (const kept of ['useFocusState', 'FocusBar', 'togglePick', 'queryString', 'anyPicks']) {
      assert.match(focus, new RegExp(`\\b${kept}\\b`), `${kept} went with the saved focuses`);
    }
    assert.match(grid, /<FocusBar/, 'the album grid lost its focus bar');
    assert.match(grid, /focus\.queryString/, 'the grid no longer filters by the focus');
  });

  await t.test('the column-order feature is untouched', () => {
    // It shared the bar's action row with the save buttons and is a different
    // feature with its own routes.
    const focus = client('components', 'Focus.jsx');
    assert.match(focus, /onResetOrder/);
    assert.match(focus, /Reset order/);
    const lib = server('routes', 'library.js');
    for (const verb of ['get', 'put', 'delete']) {
      // The closing quote is part of the pattern on purpose: without it,
      // renaming the route to /focus/section-orderX still matched the prefix
      // and this assertion passed on a route that no longer existed.
      assert.match(lib, new RegExp(`router\\.${verb}\\('/focus/section-order'`),
        `${verb.toUpperCase()} /focus/section-order was taken too`);
    }
  });

  await t.test('every other side-menu entry is still there', () => {
    const sidebar = client('components', 'Sidebar.jsx');
    for (const id of ['albums', 'artists', 'genres', 'favorites', 'tags', 'saved', 'playlists']) {
      assert.match(sidebar, new RegExp(`id: '${id}'`), `the ${id} entry went too`);
    }
    assert.match(sidebar, /handleSettings/, 'Settings went too');
    assert.match(sidebar, /unmatchedCount > 0/, 'the Unmatched entry went too');
  });

  await t.test('the saved_focuses table is kept, and marked as a tombstone', () => {
    // Dropping it would destroy whatever anyone had saved and gain a schema
    // line. It stays, with a comment saying nothing may read it again — so the
    // next person to find it does not wire it back up by accident.
    const db = readRaw(SERVER_SRC, 'db.js');
    // \s(? — anchored past the name for the same reason as above: without it,
    // renaming the table to saved_focuses_x passed on the prefix.
    assert.match(db, /CREATE TABLE IF NOT EXISTS saved_focuses\s*\(/,
      'the table was dropped or renamed — that destroys saved rows for no gain');
    assert.match(db, /tombstone, not an API/,
      'the table is kept but nothing says why, so it reads like a live feature');
    // And nothing on the server touches it.
    const serverFiles = fs.readdirSync(path.join(SERVER_SRC, 'routes'))
      .map(f => path.join(SERVER_SRC, 'routes', f))
      .concat([path.join(SERVER_SRC, 'index.js')]);
    const readers = serverFiles
      .filter(f => /saved_focuses/.test(code(fs.readFileSync(f, 'utf8'))))
      .map(f => path.basename(f));
    assert.deepEqual(readers, [], 'something still queries the tombstoned table: ' + readers.join(', '));
  });
});
