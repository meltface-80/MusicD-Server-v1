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
  ['DspTab',                   './components/DspTab.jsx',             '{}'],
  ['AutoEqTab (in DSP page)',  './components/AutoEqTab.jsx',          "{ rendererId: 'r1' }"],
  ['Sidebar',                  './components/Sidebar.jsx',            '{ onClose: () => {} }'],
  ['NowPlaying',               './components/NowPlaying.jsx',         '{}'],
  ['VolumeSheet',              './components/VolumeSheet.jsx',        '{ onClose: () => {} }'],
  ['AppearanceSection',        './components/AppearanceSection.jsx',  '{}'],
  ['HomeScreenSection',        './components/HomeScreenSection.jsx',  '{}'],
  // v1.1.33.0 — Qobuz / Tidal. Both services go through one component, so
  // both are probed: they take different tab lists, and Tidal has no Browse
  // tab, which is exactly the kind of difference that renders fine for one
  // and throws for the other.
  ['ServiceScreen (Qobuz)',    './components/ServiceScreen.jsx',      "{ service: 'qobuz', onAlbumSelect: () => {} }"],
  ['ServiceScreen (Tidal)',    './components/ServiceScreen.jsx',      "{ service: 'tidal', onAlbumSelect: () => {} }"],
  ['ServicesSection',          './components/ServicesSection.jsx',    '{}'],
  // v1.1.34.0 — Settings → Library → album version grouping.
  ['AlbumVersionsSection',     './components/AlbumVersionsSection.jsx', '{}'],
];

// Every sidebar section App can route to, rendered through App itself.
const SECTIONS = ['home', 'albums', 'artists', 'genres', 'favorites', 'tags',
                  'saved', 'playlists', 'random', 'settings',
                  // v1.1.33.0 — the two service routes. The side menu only
                  // offers these when signed in, but App must route them
                  // either way: the store can hold the section across a
                  // sign-out, and landing on an unroutable section renders a
                  // blank screen with no way back.
                  'qobuz', 'tidal'];

let built = null;
async function bundle() {
  if (built) return built;
  // Inner components that live behind state the probe cannot reach. The queue
  // is the reason this exists: it sits behind activeTab === 'queue', so
  // rendering NowPlayingFullScreen in its default state never touches it, and
  // a ReferenceError in it shipped twice unseen. Each is exported into a
  // throwaway copy of its file, which is deleted again below.
  const INNER = [
    ['QueueView', 'NowPlayingFullScreen.jsx', 'QueueView',
     '{ queue: PROBE_QUEUE, queueIndex: 2, onSelectTrack: () => {}, onSelectionChange: () => {} }'],
    ['QueueView (empty)', 'NowPlayingFullScreen.jsx', 'QueueView',
     '{ queue: [], queueIndex: 0, onSelectTrack: () => {}, onSelectionChange: () => {} }'],
    ['TrackOverflowMenu (now playing)', 'NowPlayingFullScreen.jsx', 'TrackOverflowMenu',
     "{ track: PROBE_TRACK, onClose: () => {} }"],
    ['TrackOverflowMenu (queue)', 'NowPlayingFullScreen.jsx', 'TrackOverflowMenu',
     "{ track: PROBE_TRACK, variant: 'queue', selection: { count: 2 }, onClose: () => {} }"],
    ['DspOverlay', 'VolumeSheet.jsx', 'DspOverlay', "{ rendererId: 'r1', onClose: () => {} }"],
    ['DeviceSettingsOverlay', 'VolumeSheet.jsx', 'DeviceSettingsOverlay',
     "{ rendererId: 'r1', renderer: { name: 'Test' }, onClose: () => {} }"],
    ['SelectionBar', 'AlbumSelection.jsx', 'SelectionBar',
     '{ count: 3, onCancel: () => {}, onAct: () => {} }'],
    ['SelectionSheet', 'AlbumSelection.jsx', 'SelectionSheet',
     '{ count: 3, onClose: () => {}, onPick: () => {} }'],
    // v1.1.32.0 — a DSP category with its body open. Every category is
    // collapsed until its switch is on, so the default render of the DSP page
    // reaches none of their bodies: exactly the blind spot the queue tab had.
    ['DSP Category (open)', 'DspTab.jsx', 'Category',
     "{ title: 'T', on: true, onToggle: () => {}, children: null }"],
    ['DSP Category (shut)', 'DspTab.jsx', 'Category',
     "{ title: 'T', on: false, onToggle: () => {}, children: null }"],
  ];

  // One throwaway copy per file, with `export` added to the inner components
  // named above. Rewriting rather than importing privately, because these are
  // deliberately not part of any module's public surface.
  const copies = new Map();
  for (const [, file, name] of INNER) {
    if (!copies.has(file)) {
      const from = path.join(CLIENT, 'src', 'components', file);
      copies.set(file, { src: fs.readFileSync(from, 'utf8'), names: new Set() });
    }
    copies.get(file).names.add(name);
  }
  const written = [];
  for (const [file, { src: original, names }] of copies) {
    let out = original;
    for (const name of names) {
      const decl = `function ${name}(`;
      assert.ok(out.includes(decl), `${file} no longer defines ${name}`);
      if (!out.includes(`export ${decl}`)) out = out.replace(decl, `export ${decl}`);
    }
    const probeName = `__probe_${file}`;
    fs.writeFileSync(path.join(CLIENT, 'src', 'components', probeName), out);
    written.push(path.join(CLIENT, 'src', 'components', probeName));
  }

  const entry = path.join(CLIENT, 'src', '__render_probe.jsx');
  const imports = SCREENS.map(([, p], i) => `import C${i} from '${p}'`).join('\n')
    + '\n' + INNER.map(([, file, name], i) =>
        `import { ${name} as I${i} } from './components/__probe_${file.replace('.jsx', '')}'`).join('\n');
  const cases = SCREENS.map(([n, , props], i) => `  [${JSON.stringify(n)}, C${i}, ${props}],`).join('\n')
    + '\n' + INNER.map(([n, , , props], i) => `  [${JSON.stringify(n)}, I${i}, ${props}],`).join('\n');
  fs.writeFileSync(entry, `
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import App from './App'
import { useStore } from './store'
${imports}
const PROBE_QUEUE = Array.from({ length: 6 }, (_, i) => ({
  id: 't' + i, title: 'Track ' + i, artist: 'A', album: 'Alb', duration: 200,
}))
const PROBE_TRACK = { id: 't1', title: 'Track', artist: 'A', album: 'Alb', genre: 'G' }
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
    for (const f of written) { try { fs.unlinkSync(f) } catch { /* already gone */ } }
  }
  test.after(() => { try { fs.unlinkSync(outfile) } catch { /* already gone */ } });
  built = require(outfile);
  return built;
}

// Every <Capitalised /> in a client file must be imported into that file or
// defined in it (v1.1.30.0).
//
// This is the cheap half of the same problem the render probe below solves
// expensively, and it exists because the probe MISSED one. v1.1.26.0 moved the
// volume sheet out of NowPlayingFullScreen and retyped its lucide import line
// in the process, dropping Plus and Minus — which the volume sheet used AND
// the QUEUE view used. The queue tab threw ReferenceError on render.
//
// The probe could not see it: it renders each screen in its default state, and
// the queue is behind activeTab === 'queue'. This check does not care what
// state a branch is behind — an identifier used in JSX and imported nowhere is
// wrong whether or not anything renders it today.
function jsxReferences(src) {
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const declared = new Set(['React']);
  for (const m of clean.matchAll(/import\s+([^;]*?)\s+from/g)) {
    for (const n of m[1].replace(/[{}]/g, ' ').split(',')) {
      declared.add(n.split(/\s+as\s+/).pop().trim());
    }
  }
  for (const m of clean.matchAll(/^(?:export )?(?:default )?(?:async )?function ([A-Z]\w*)/gm)) declared.add(m[1]);
  for (const m of clean.matchAll(/(?:const|let|var) ([A-Z]\w*)\s*=/g)) declared.add(m[1]);
  // Destructured renames — ({ icon: Icon }) — where the JSX name is the alias.
  for (const m of clean.matchAll(/\w+:\s*([A-Z]\w*)/g)) declared.add(m[1]);
  const used = new Set([...clean.matchAll(/<([A-Z]\w*)[\s/>]/g)].map(m => m[1]));
  return [...used].filter(n => !declared.has(n));
}

test('the JSX-reference check bites', async (t) => {
  await t.test('it finds a component used and imported nowhere', () => {
    // The exact shape of the v1.1.26.0 bug.
    const bad = `import { Play } from 'lucide-react'\nconst A = () => <Minus size={16} />`;
    assert.deepEqual(jsxReferences(bad), ['Minus']);
  });
  await t.test('an import satisfies it', () => {
    const good = `import { Play, Minus } from 'lucide-react'\nconst A = () => <Minus />`;
    assert.deepEqual(jsxReferences(good), []);
  });
  await t.test('so does a local definition, an alias, or a destructured rename', () => {
    for (const ok of [
      `function Row() { return null }\nconst A = () => <Row />`,
      `import { X as Close } from 'l'\nconst A = () => <Close />`,
      `const A = ({ icon: Icon }) => <Icon />`,
    ]) assert.deepEqual(jsxReferences(ok), [], ok);
  });
  await t.test('and a name inside a comment does not count as a use', () => {
    assert.deepEqual(jsxReferences(`// renders <Ghost /> one day\nconst A = 1`), []);
  });
});

test('every component the client renders is imported or defined', () => {
  const guilty = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue }
      if (!/\.jsx?$/.test(e.name)) continue;
      const missing = jsxReferences(fs.readFileSync(p, 'utf8'));
      if (missing.length) guilty.push(`${e.name}: ${missing.join(', ')}`);
    }
  };
  walk(path.join(CLIENT, 'src'));
  assert.deepEqual(guilty, [],
    'these are rendered but imported nowhere — a ReferenceError on first paint:\n  '
    + guilty.join('\n  '));
});

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

  assert.ok(CASES.length > SCREENS.length,
    'the inner state-gated components are not being rendered');

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
