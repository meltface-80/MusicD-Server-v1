// The library screen forgetting where it was left.
//
// One scroll container serves every screen; App.jsx remembers a scrollTop per
// screen and puts it back when that screen comes round again. Three things
// conspired to make that never work on the album grid:
//
//   1. AlbumGrid is infinite-scrolling and holds its pages in component
//      state. Opening an album unmounts it, so the way back rebuilt the list
//      from page 1 — a couple of hundred albums where there had been a couple
//      of thousand.
//   2. The restore was a blind `setTimeout(…, 50)`. Fifty milliseconds in,
//      the album fetch has not landed and the container is a spinner:
//      `el.scrollTop = 4200` on a 900px container clamps to the maximum and
//      the offset is simply gone.
//   3. A clamp dispatches a scroll event exactly like a finger does, and the
//      container's own onScroll handler wrote that clamped 0 straight back
//      over the saved position. The memory was destroyed, not merely missed —
//      which is why the saved number never got a second chance.
//
// The arithmetic test proves the model (a single assignment cannot survive
// content that has not arrived, a settling one can); the greps prove no site
// was left on the old model.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SRC = path.join(__dirname, '..', '..', 'client', 'src');

// Strip comments so prose about the rule can neither satisfy nor trip a check.
function code(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
const read = (...p) => code(fs.readFileSync(path.join(SRC, ...p), 'utf8'));

// A scroll container that clamps like a real one: you cannot scroll past the
// content you have.
function fakeScroller(contentHeight, viewport = 900) {
  return {
    contentHeight,
    viewport,
    _top: 0,
    get scrollTop() { return this._top; },
    set scrollTop(v) {
      const max = Math.max(0, this.contentHeight - this.viewport);
      this._top = Math.max(0, Math.min(v, max));
    },
  };
}

// A hand-driven requestAnimationFrame + clock.
function fakeFrames() {
  let now = 0;
  let nextId = 1;
  let queue = new Map();
  return {
    now: () => now,
    raf: (cb) => { const id = nextId++; queue.set(id, cb); return id; },
    cancelRaf: (id) => { queue.delete(id); },
    pending: () => queue.size,
    tick(ms = 16) {
      now += ms;
      const due = [...queue.values()];
      queue = new Map();
      for (const cb of due) cb();
    },
  };
}

test('a scroll offset cannot be restored onto content that is not there yet', async (t) => {
  const { restoreScrollTop } = await import(
    pathToFileURL(path.join(SRC, 'scrollRestore.js')).href);

  await t.test('the shipped model: one assignment, and the number is gone', () => {
    // This is what setTimeout(…, 50) did. No loop, no retry.
    const el = fakeScroller(900);          // spinner only
    el.scrollTop = 4200;
    assert.equal(el.scrollTop, 0,
      'the assignment clamps to the maximum — that is the reported symptom');
    el.contentHeight = 12000;              // the album list finally arrives
    assert.equal(el.scrollTop, 0,
      'and nothing brings it back, because nothing tries again');
  });

  await t.test('the settling model lands it when the content arrives', () => {
    const el = fakeScroller(900);
    const clock = fakeFrames();
    const h = restoreScrollTop(el, 4200,
      { raf: clock.raf, cancelRaf: clock.cancelRaf, now: clock.now });

    assert.equal(el.scrollTop, 0, 'still nothing to scroll to');
    assert.equal(h.settled, false, 'and the restore knows it is not done');

    for (let i = 0; i < 5; i++) clock.tick();
    el.contentHeight = 12000;              // pages restored, grid full height
    clock.tick();

    assert.equal(el.scrollTop, 4200, 'the offset is back');
    assert.equal(h.settled, true);
    assert.equal(clock.pending(), 0, 'and nothing is left running');
  });

  await t.test('it gives up rather than looping for ever', () => {
    const el = fakeScroller(900);          // content never arrives
    const clock = fakeFrames();
    const h = restoreScrollTop(el, 4200, {
      deadlineMs: 100,
      raf: clock.raf, cancelRaf: clock.cancelRaf, now: clock.now,
    });
    let frames = 0;
    while (!h.settled && frames < 1000) { clock.tick(16); frames++; }
    assert.ok(h.settled, 'the restore never stopped');
    assert.ok(frames <= 10, `took ${frames} frames to hit a 100ms deadline`);
    assert.equal(clock.pending(), 0);
  });

  await t.test('the user always wins', () => {
    const el = fakeScroller(900);
    const clock = fakeFrames();
    const h = restoreScrollTop(el, 4200,
      { raf: clock.raf, cancelRaf: clock.cancelRaf, now: clock.now });

    el.contentHeight = 12000;
    el.scrollTop = 600;                    // a finger, mid-restore
    clock.tick();

    assert.equal(el.scrollTop, 600, 'the restore dragged the user back');
    assert.equal(h.settled, true);
    assert.equal(clock.pending(), 0);
  });

  await t.test('cancelling stops it dead — nothing survives the unmount', () => {
    const el = fakeScroller(900);
    const clock = fakeFrames();
    const h = restoreScrollTop(el, 4200,
      { raf: clock.raf, cancelRaf: clock.cancelRaf, now: clock.now });

    h.cancel();
    assert.equal(h.settled, true);
    assert.equal(clock.pending(), 0);

    el.contentHeight = 12000;
    clock.tick();
    assert.equal(el.scrollTop, 0, 'a cancelled restore touched the element again');
  });

  await t.test('the handle exposes what the scroll handler needs', () => {
    // App.jsx tells its own clamped assignments apart from the user by
    // comparing the incoming scrollTop against these two fields.
    const el = fakeScroller(900);
    const clock = fakeFrames();
    const h = restoreScrollTop(el, 4200,
      { raf: clock.raf, cancelRaf: clock.cancelRaf, now: clock.now });
    assert.equal(h.target, 4200);
    assert.equal(typeof h.settled, 'boolean');
    assert.equal(typeof h.cancel, 'function');
    h.cancel();
  });
});

test('App.jsx no longer times the restore and hopes', async (t) => {
  const app = read('App.jsx');

  await t.test('no timer schedules a scroll assignment', () => {
    assert.ok(!/setTimeout|setInterval/.test(app),
      'a scroll restore is being timed again — 50ms was never long enough ' +
      'for a network fetch, and no fixed delay ever will be');
    assert.match(app, /restoreScrollTop\(/,
      'the settling restore is not being used');
  });

  await t.test('it is armed before a scroll event can be dispatched', () => {
    // A passive effect can be scheduled after the browser has already fired
    // the clamp's scroll event, which leaves the handler unguarded for
    // exactly long enough to overwrite the saved position.
    assert.match(app, /import\s+React,\s*\{[^}]*useLayoutEffect[^}]*\}\s*from\s*'react'/,
      'useLayoutEffect is not imported');
    assert.match(app, /useLayoutEffect\(\(\) => \{[\s\S]{0,1200}?restoreScrollTop\(/,
      'the restore does not run in a layout effect');
  });

  await t.test('the scroll handler refuses to record a restore in flight', () => {
    const fn = app.match(/const onScrollCapture = \(e\) => \{[\s\S]*?\n  \}/);
    assert.ok(fn, 'onScrollCapture not found');
    assert.match(fn[0], /scrollRestore\.current/,
      'the handler does not consult the restore — a clamped 0 will be ' +
      'written straight over the position being restored');
    assert.ok(
      fn[0].indexOf('settled') !== -1 &&
      fn[0].indexOf('settled') < fn[0].indexOf('scrollPositions.current.set'),
      'the guard has to come before the write, or it guards nothing');
  });

  await t.test('the restore is cancelled when the screen changes', () => {
    assert.match(app, /handle\.cancel\(\)/,
      'nothing cancels the in-flight restore on cleanup');
  });

  await t.test('a screen with nothing remembered still starts at the top', () => {
    // Otherwise it inherits whatever offset the previous screen was left at.
    assert.match(app, /if \(target <= 0\) \{[\s\S]{0,240}?el\.scrollTop = 0/);
  });
});

test('the album grid comes back with the pages it had', async (t) => {
  const grid = read('components', 'AlbumGrid.jsx');

  await t.test('the cache is module-level and declared before its first use', () => {
    // const is not hoisted; a use above the declaration is a ReferenceError
    // the moment anything reaches it during module init.
    const decl = grid.indexOf('const _albumPagesCache');
    assert.ok(decl !== -1, 'there is no page cache');
    const firstUse = grid.indexOf('_albumPagesCache.');
    assert.ok(firstUse === -1 || decl < firstUse,
      '_albumPagesCache is used before it is declared');
    assert.ok(decl < grid.indexOf('export default function AlbumGrid'),
      'the cache must outlive the component, so it cannot live inside it');
  });

  await t.test('every piece of paged state hydrates from it', () => {
    // Miss one and the grid remounts inconsistent with its own list: the
    // classic partial migration.
    for (const [name, setter] of [
      ['albums', 'setAlbums'],
      ['offset', 'setOffset'],
      ['hasMore', 'setHasMore'],
      ['sort', 'setSort'],
    ]) {
      const m = grid.match(
        new RegExp(`const \\[${name}, ${setter}\\] = useState\\(([^\\n]*)`));
      assert.ok(m, `${name} state not found`);
      assert.match(m[1], /restoredView/,
        `${name} does not hydrate from the cache: ${m[0].trim()}`);
    }
  });

  await t.test('a hydrated grid is not put behind a spinner', () => {
    // A spinner has no height, and a container with no height cannot have a
    // scroll offset restored onto it.
    assert.match(grid, /const \[loading, setLoading\] = useState\(!restoredView\)/);
  });

  await t.test('a hydrated mount refreshes the whole restored range', () => {
    // Refetching page 1 here would replace N pages with one and collapse the
    // very scroll position the hydration exists to preserve.
    assert.match(grid, /fetchPage\(sort, 0, false, rehydrate \|\| PAGE_SIZE\)/,
      'the hydrated mount is not refreshing the restored range in one request');
    assert.match(grid, /async \(s, off, append, limit = PAGE_SIZE\)/,
      'fetchPage cannot be asked for anything other than one page');
    assert.match(grid, /limit=\$\{limit\}/,
      'fetchPage still hard-codes PAGE_SIZE into the query');
  });

  await t.test('it is invalidated when the ground moves', () => {
    // A stale grid is worse than a lost scroll position.
    const dels = grid.match(/_albumPagesCache\.delete\(/g) || [];
    assert.ok(dels.length >= 2,
      `only ${dels.length} invalidation site(s): a completed scan and an ` +
      'active focus filter must both drop the entry');
    assert.match(grid, /ALBUM_PAGES_CACHE_TTL_MS/, 'the entry never expires');
    assert.match(grid, /savedAt:\s*Date\.now\(\)/, 'nothing stamps the entry');
    assert.match(grid, /if \(focusEnabled && focus\.queryString\) \{[\s\S]{0,600}?_albumPagesCache\.delete/,
      'a focus-filtered list is being cached — focus picks do not survive ' +
      'the remount, so it would come back filtered with nothing on screen ' +
      'explaining why');
  });
});

test('a genre album list survives the album detour too', async (t) => {
  const genre = read('components', 'GenreScreen.jsx');

  await t.test('the open genre is remembered across the remount', () => {
    assert.match(genre, /const _genreViewCache/,
      'opening an album still drops the genre, so the back button lands on ' +
      'the genre browser and the remembered offset is applied to the wrong ' +
      'screen entirely');
    assert.ok(genre.indexOf('const _genreViewCache') <
              genre.indexOf('export default function GenreScreen'));
  });

  await t.test('the restored list is drawn before the catalogue spinner', () => {
    // Anchored on the render's own two early returns, not on the bare
    // words: `if (selectedGenre)` also appears in the cache-mirror effect
    // above, and matching that one made the ordering check meaningless.
    const selected = genre.indexOf('if (selectedGenre) {\n    return (');
    const spinner = genre.indexOf('if (loading) return <div style={s.loadWrap}>');
    assert.ok(selected !== -1, "the render's selectedGenre branch not found");
    assert.ok(spinner !== -1, "the render's loading branch not found");
    assert.ok(selected < spinner,
      'the genre catalogue spinner is drawn over the restored album list, ' +
      'which leaves the screen with no height to restore onto');
  });
});
