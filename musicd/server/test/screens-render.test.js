// Every screen actually renders (v1.1.27.0).
//
// WHY THIS EXISTS
//
// v1.1.25.0 shipped an Albums screen and a Saved-for-later screen that came up
// blank and needed the app force-quitting. The cause was one line:
//
//     const [sortSheetOpen, setSortSheetOpen] = useState(false)
//
// deleted by accident. It was the SORT SHEET's state, and it happened to sit
// between two of the saved-focus handlers being removed in that release; the
// splice took it. AlbumGrid then referenced it at four sites with nothing
// declaring it, which is a ReferenceError the first time the component renders
// — and AlbumGrid is both the Albums screen and Saved for later.
//
// Nothing in this suite could have caught that, because every check in it is a
// grep. `node --check` passes: the file is syntactically perfect. `vite build`
// passes: an undeclared identifier is not a bundling error. Only running the
// component finds it.
//
// So this runs them. React and react-dom are already client dependencies and
// esbuild comes with vite, so the whole thing needs nothing new: esbuild
// bundles a generated entry point that imports every screen, and
// renderToStaticMarkup executes their render bodies in this process.
//
// WHAT IT DOES AND DOES NOT COVER
//
// renderToStaticMarkup runs the component body and its hooks; it does NOT run
// effects. So a screen that fetches its data renders in its loading state, and
// the JSX below that early return is not exercised. That is a real limit and
// worth stating rather than implying otherwise: this catches a screen that
// cannot mount at all, which is the reported failure, not every bug below the
// fold. The store is seeded before each App render so the router itself, and
// each screen's position in it, is walked properly.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLIENT = path.join(__dirname, '..', '..', 'client');
const esbuild = require(path.join(CLIENT, 'node_modules', 'esbuild'));

// Screens reachable from the shell, with the props App gives them.
const SCREENS = [
  ['AlbumGrid (Albums)',       './components/AlbumGrid.jsx',          '{}'],
  ['AlbumGrid (Favourites)',   './components/AlbumGrid.jsx',          '{ favoritesOnly: true }'],
  ['AlbumGrid (Saved)',        './components/AlbumGrid.jsx',          '{ savedOnly: true }'],
  ['ArtistList',               './components/ArtistList.jsx',         '{ onArtistClick: () => {} }'],
  ['GenreScreen',              './components/GenreScreen.jsx',        '{ onAlbumSelect: () => {} }'],
  ['HomeScreen',               './components/HomeScreen.jsx',         '{}'],
  ['RandomAlbumsScreen',       './components/RandomAlbumsScreen.jsx', '{}'],
  ['PlaylistsScreen',          './components/PlaylistsScreen.jsx',    '{}'],
  ['TagsScreen',               './components/TagsScreen.jsx',         '{}'],
  ['UnmatchedScreen',          './components/UnmatchedScreen.jsx',    '{}'],
  ['SettingsScreen',           './components/SettingsScreen.jsx',     '{ onBack: () => {} }'],
  ['Sidebar',                  './components/Sidebar.jsx',            '{ onClose: () => {} }'],
  ['NowPlaying',               './components/NowPlaying.jsx',         '{}'],
  ['VolumeSheet',              './components/VolumeSheet.jsx',        '{ onClose: () => {} }'],
  ['AppearanceSection',        './components/AppearanceSection.jsx',  '{}'],
  ['HomeScreenSection',        './components/HomeScreenSection.jsx',  '{}'],
];

// Every sidebar section App can route to, rendered through App itself.
const SECTIONS = ['home', 'albums', 'artists', 'genres', 'favorites', 'tags',
                  'saved', 'playlists', 'random', 'settings'];

let built = null;
async function bundle() {
  if (built) return built;
  const entry = path.join(CLIENT, 'src', '__render_probe.jsx');
  const imports = SCREENS.map(([, p], i) => `import C${i} from '${p}'`).join('\n');
  const cases = SCREENS.map(([n, , props], i) => `  [${JSON.stringify(n)}, C${i}, ${props}],`).join('\n');
  fs.writeFileSync(entry, `
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import App from './App'
import { useStore } from './store'
${imports}
export const CASES = [
${cases}
]
export const APP = App
export const STORE = useStore
export function renderOne(Comp, props) {
  return renderToStaticMarkup(React.createElement(Comp, props))
}
`);
  const outfile = path.join(os.tmpdir(), `musicd-render-probe-${process.pid}.cjs`);
  try {
    await esbuild.build({
      entryPoints: [entry], bundle: true, format: 'cjs', platform: 'node',
      outfile, jsx: 'automatic', logLevel: 'error',
      loader: { '.png': 'dataurl', '.svg': 'dataurl' },
      // The client is built for production; render it the same way, so a
      // development-only guard cannot mask a production-only throw.
      define: { 'process.env.NODE_ENV': '"production"' },
    });
  } finally {
    fs.unlinkSync(entry);
  }
  test.after(() => { try { fs.unlinkSync(outfile) } catch { /* already gone */ } });
  built = require(outfile);
  return built;
}

test('the probe fails when a screen cannot render', async () => {
  // Prove it bites, with the shape of the bug it was written for: an
  // identifier used in the render body and declared nowhere. A smoke test
  // that cannot go red is decoration.
  const { renderOne } = await bundle();
  const Broken = () => {
    // eslint-disable-next-line no-undef
    return sortSheetOpen ? null : null;   // exactly v1.1.25.0's failure
  };
  assert.throws(() => renderOne(Broken, {}), /is not defined/,
    'the probe swallowed a ReferenceError — it would have passed the blank screens');
});

test('every screen renders', async (t) => {
  const { CASES, renderOne } = await bundle();

  assert.equal(CASES.length, SCREENS.length, 'a screen went missing from the probe');

  for (const [name, Comp, props] of CASES) {
    await t.test(name, () => {
      assert.ok(Comp, `${name} did not export a component`);
      let html;
      assert.doesNotThrow(() => { html = renderOne(Comp, props) },
        `${name} throws on first render — this is a blank screen`);
      // A screen that renders nothing at all is the same symptom by another
      // route, so an empty string is a failure too.
      assert.ok(html.length > 0, `${name} rendered nothing`);
    });
  }
});

test('every sidebar route renders through App', async (t) => {
  const { APP, STORE, renderOne } = await bundle();

  for (const section of SECTIONS) {
    await t.test(section, () => {
      STORE.setState({
        sidebarSection: section,
        searchQuery: '',
        selectedAlbumId: null,
        settingsSubSection: null,
      });
      let html;
      assert.doesNotThrow(() => { html = renderOne(APP, {}) },
        `the ${section} route throws — that screen comes up blank`);
      assert.ok(html.length > 0, `the ${section} route rendered nothing`);
    });
  }

  await t.test('and the search results route', () => {
    STORE.setState({ sidebarSection: 'albums', searchQuery: 'test' });
    assert.doesNotThrow(() => renderOne(APP, {}));
    STORE.setState({ searchQuery: '' });
  });

  await t.test('every section the sidebar offers is one App can render', () => {
    // A menu row pointing at a section App has no branch for falls through to
    // the Home screen — silently, so the row looks broken rather than missing.
    const sidebar = fs.readFileSync(path.join(CLIENT, 'src', 'components', 'Sidebar.jsx'), 'utf8');
    const offered = [...sidebar.matchAll(/\{ id: '(\w+)'/g)].map(m => m[1]);
    assert.ok(offered.length >= 7, 'the sidebar section list could not be read');
    const missing = offered.filter(id => !SECTIONS.includes(id));
    assert.deepEqual(missing, [],
      'the sidebar offers sections this test never renders: ' + missing.join(', '));
  });
});
