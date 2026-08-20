// Long-press on album artwork.
//
// Two separate things fired on the same gesture, and both had to go:
//
//   - Safari's own image callout. Touch-and-hold on a cover raised the
//     Copy / Share / Add to Photos sheet and lifted the art into a drag
//     preview. Nothing in the app sits behind that gesture, so it reads as
//     the app misbehaving. -webkit-touch-callout is the property that
//     suppresses the sheet; -webkit-user-drag stops the lift and has no
//     dependable camelCase form in React, which is why the whole set lives
//     in index.css rather than in a dozen inline style maps.
//
//   - The app's own 600ms long-press menu on the album tile (Fetch artwork /
//     Open album / Cancel). Removed at the owner's request. Removing the JS
//     timer does NOT stop the native callout — the CSS above is what does
//     that — and suppressing the callout does not remove the menu, so
//     neither change makes the other redundant.
//
// Device behaviour cannot be observed from here: the harness is headless
// Chromium with no callout, no drag preview and no long-press. What can be
// pinned is the configuration, which is what these do.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', 'client', 'src');
const readRaw = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

// Declarations of every rule whose selector list contains `selector` exactly.
// Comments are stripped first: index.css explains these properties at length
// and a bare word-grep would be satisfied by the explanation. A check that
// passes on its own documentation is worse than no check.
function declarationsFor(css, selector) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = {};
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].split(',').map(s => s.trim());
    if (!selectors.includes(selector)) continue;
    for (const decl of m[2].split(';')) {
      const i = decl.indexOf(':');
      if (i === -1) continue;
      out[decl.slice(0, i).trim()] = decl.slice(i + 1).trim();
    }
  }
  return out;
}

test('the declaration reader actually reads', () => {
  // Prove it bites: it must find the real rule, ignore a look-alike inside a
  // comment, and not confuse `img` with `.thing img`.
  const sample = `
/* img { -webkit-touch-callout: none; } <- prose, not a rule */
img { -webkit-touch-callout: none; -webkit-user-drag: none }
.thing img { -webkit-touch-callout: default }
button, img { color: red; }
`;
  assert.deepEqual(declarationsFor(sample, 'img'), {
    '-webkit-touch-callout': 'none',
    '-webkit-user-drag': 'none',
    color: 'red',
  });
  assert.deepEqual(declarationsFor(sample, '.thing img'),
    { '-webkit-touch-callout': 'default' });
  assert.deepEqual(declarationsFor(sample, 'nothing'), {});
  assert.deepEqual(declarationsFor('/* img { color: red } */', 'img'), {},
    'a commented-out rule was read as a real one');
});

test('the OS image callout is suppressed wherever art is drawn', async (t) => {
  const css = readRaw('index.css');
  const img = declarationsFor(css, 'img');

  await t.test('every img suppresses the callout, the drag and the selection', () => {
    assert.equal(img['-webkit-touch-callout'], 'none',
      'this is the one that kills the Copy / Share / Add to Photos sheet');
    assert.equal(img['-webkit-user-drag'], 'none',
      'without this the art still lifts into a drag preview');
    assert.equal(img['-webkit-user-select'], 'none');
    assert.equal(img['user-select'], 'none');
  });

  await t.test('the whole gesture is suppressed from the root', () => {
    // v1.1.23.0 — this used to be an enumerated list: img and button. That
    // shape is why a hold on a settings-row label still selected it and
    // raised Copy / Look Up / Translate — the label is a <div>, and an
    // opt-out written per element type only ever covers the ones somebody
    // remembered. The root rule inherits down to everything instead, which
    // is what the owner asked for: no long-press anywhere but the share card.
    const html = declarationsFor(css, 'html');
    assert.equal(html['-webkit-touch-callout'], 'none',
      'the Copy / Look Up / Translate bar is back on every screen');
    assert.equal(html['-webkit-user-select'], 'none');
    assert.equal(html['user-select'], 'none',
      'text still highlights on a long press');
    // A <button> (an album tile) and a <div> (a settings label) are both
    // covered by inheritance, so neither needs a rule of its own. Asserting
    // the root instead of re-listing elements is the point of the change.
  });

  await t.test('text inputs keep selection and the callout', () => {
    // Suppressing the gesture inside a field is not "no long-press", it is a
    // search box with no caret placement, no Select All and no Paste. These
    // are the deliberate exception and must be spelled out: WebKit does not
    // hand selection back once an ancestor has taken it away.
    for (const sel of ['input', 'textarea', 'select', '[contenteditable="true"]']) {
      const d = declarationsFor(css, sel);
      assert.equal(d['user-select'], 'text', `${sel} cannot be selected in`);
      assert.equal(d['-webkit-user-select'], 'text', `${sel} cannot be selected in`);
      assert.equal(d['-webkit-touch-callout'], 'default',
        `${sel} has no Paste / Select All menu`);
    }
  });

  await t.test('the share-card preview keeps its callout', () => {
    // Holding that image to add it to Photos is a real thing to want, and
    // the callout is the only route to it. It is now the ONLY thing in the
    // app that a long press does anything on.
    assert.equal(declarationsFor(css, '.allow-callout img')['-webkit-touch-callout'],
      'default', '.allow-callout does not opt back in');
    for (const f of ['NowPlayingFullScreen.jsx', 'AlbumDetail.jsx']) {
      const src = readRaw('components', f);
      assert.match(src, /alt="Share card"[^>]*className="allow-callout"/,
        `${f}'s share card cannot be saved to Photos any more`);
    }
  });

  await t.test('the share card opts back in with `text`, not `auto`', () => {
    // The trap in inverting the root rule. The used value of
    // `user-select: auto` is `none` whenever the parent's used value is
    // `none` — so under a root that says none, `auto` is a no-op and this
    // class silently protects nothing. It read `auto` for three releases and
    // worked only because the root had not said none yet.
    for (const sel of ['.allow-callout', '.allow-callout img']) {
      const d = declarationsFor(css, sel);
      assert.notEqual(d['user-select'], 'auto',
        `${sel} { user-select: auto } resolves to none under the root rule`);
      assert.notEqual(d['-webkit-user-select'], 'auto',
        `${sel} { -webkit-user-select: auto } resolves to none under the root rule`);
      assert.equal(d['user-select'], 'text');
      assert.equal(d['-webkit-user-select'], 'text');
    }
  });

  await t.test('artwork images are not draggable either', () => {
    // -webkit-user-drag covers WebKit; draggable={false} covers the rest.
    // Every surface that draws cover art, artist art or a track cover.
    const surfaces = [
      'AlbumGrid.jsx', 'AlbumDetail.jsx', 'ArtistAlbums.jsx', 'ArtistList.jsx',
      'GenreScreen.jsx', 'HomeScreen.jsx', 'SearchResults.jsx',
      'NowPlaying.jsx', 'NowPlayingFullScreen.jsx', 'UnmatchedScreen.jsx',
      'RandomAlbumsScreen.jsx',
    ];
    const missing = surfaces.filter(f => !/draggable=\{false\}/.test(readRaw('components', f)));
    assert.deepEqual(missing, [],
      'these draw artwork and never mark it undraggable: ' + missing.join(', '));
  });
});

test('the long-press menu on album thumbnails is gone', async (t) => {
  const grid = readRaw('components', 'AlbumGrid.jsx');

  await t.test('no state, no overlay, no styles left behind', () => {
    const orphans = [
      'contextMenu', 'setContextMenu',
      'ctxOverlay', 'ctxMenu', 'ctxTitle', 'ctxItem',
      'onLongPress', 'cancelLongPress', 'handleTouchStart',
      'handleRescanAlbum', 'artwork-album',
    ].filter(name => grid.includes(name));
    assert.deepEqual(orphans, [],
      'the long-press path left corpses behind: ' + orphans.join(', '));
  });

  await t.test('no touch timer arms on the card', () => {
    const card = grid.slice(grid.indexOf('function AlbumCard'));
    assert.ok(!/setTimeout/.test(card),
      'AlbumCard is still timing a touch');
    for (const h of ['onTouchStart', 'onTouchEnd', 'onTouchMove']) {
      assert.ok(!card.includes(h), `AlbumCard still handles ${h}`);
    }
  });

  await t.test('the browser menu is still suppressed on the tile', () => {
    // Kept deliberately after the app menu went: right-click on desktop and
    // long-press in some Android browsers open the browser's own image menu,
    // which is the thing the callout rules exist to prevent.
    assert.match(grid, /onContextMenu=\{e => e\.preventDefault\(\)\}/,
      'right-click on a tile now opens the browser image menu');
  });
});
