// The side menu, the volume sheet, and the artists wall (v1.1.26.0).
//
// Four changes that look unrelated and share one shape: something existed in
// two copies, or existed and did nothing.
//
//   THE VOLUME SHEET existed twice. The full-screen Now Playing one grew an
//   icon row, discrete − / + steps and a fixed-output state; the mini bar's
//   kept a title, a "0", a slider and a number — under a comment claiming it
//   was "the same layout as the full-screen NP one for consistency". Every
//   improvement since v54 landed on one of them. It is one component now, and
//   most of what is checked here is that it stayed one.
//
//   SIX SAFE-AREA INSETS existed and did nothing. Each was a paddingTop or
//   paddingBottom written at the FRONT of a style object that already carried
//   a `padding` shorthand. React writes style keys in insertion order, so the
//   shorthand reset all four sides and the inset never applied — silently, in
//   a project whose CLAUDE.md opens with how many times safe areas have bitten
//   it. The detector for that has its own self-test below, because a check
//   this cheap to get subtly wrong is worth proving.
//
//   THE ARTISTS WALL is three across now with a grid/list switch, and the list
//   row writes the artist's name even when the grid would not.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CLIENT_SRC = path.join(__dirname, '..', '..', 'client', 'src');
const readRaw = (...p) => fs.readFileSync(path.join(CLIENT_SRC, ...p), 'utf8');
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const read = (...p) => code(readRaw(...p));

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

// ---------------------------------------------------------------------------
// Shorthand-after-longhand detector.
// ---------------------------------------------------------------------------

const SHORTHANDS = {
  padding:    ['paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight'],
  margin:     ['marginTop', 'marginBottom', 'marginLeft', 'marginRight'],
  border:     ['borderTop', 'borderBottom', 'borderLeft', 'borderRight',
               'borderColor', 'borderWidth', 'borderStyle'],
  background: ['backgroundColor', 'backgroundImage', 'backgroundSize', 'backgroundPosition'],
};

// Every place a longhand is written BEFORE a shorthand that covers it, inside
// one object literal. Nesting is not walked: these style maps are one level of
// object per key and the inner ones are matched on their own pass.
function overriddenLonghands(src) {
  const found = [];
  for (const m of src.matchAll(/\{[^{}]*\}/g)) {
    const body = m.group ? m.group(0) : m[0];
    const keys = [...body.matchAll(/(\w+)\s*:/g)].map(k => [k.index, k[1]]);
    for (const [short, longs] of Object.entries(SHORTHANDS)) {
      const shortAt = keys.filter(([, k]) => k === short).map(([i]) => i);
      if (!shortAt.length) continue;
      const last = Math.max(...shortAt);
      for (const [i, k] of keys) {
        if (longs.includes(k) && i < last) {
          found.push({ longhand: k, shorthand: short, line: src.slice(0, m.index).split('\n').length });
        }
      }
    }
  }
  return found;
}

test('the override detector actually bites', async (t) => {
  await t.test('it finds a longhand written before its shorthand', () => {
    const bad = `const s = { header: { paddingTop: 'calc(14px + var(--safe-top))', padding: '14px' } }`;
    assert.deepEqual(overriddenLonghands(bad).map(f => f.longhand), ['paddingTop']);
  });

  await t.test('and leaves the correct order alone', () => {
    // This is the fix, and it must not read as the bug.
    const good = `const s = { header: { padding: '14px', paddingTop: 'calc(14px + var(--safe-top))' } }`;
    assert.deepEqual(overriddenLonghands(good), []);
  });

  await t.test('it does not confuse two different objects', () => {
    // A shorthand in a LATER sibling must not condemn a longhand in an
    // earlier one — that would make the check unusable noise.
    const fine = `const s = { a: { paddingTop: 1 }, b: { padding: 2 } }`;
    assert.deepEqual(overriddenLonghands(fine), []);
  });

  await t.test('it covers margin, border and background too', () => {
    for (const [longhand, decl] of [
      ['marginTop', `{ marginTop: 1, margin: 2 }`],
      ['borderColor', `{ borderColor: 'red', border: '1px solid' }`],
      ['backgroundColor', `{ backgroundColor: 'red', background: 'blue' }`],
    ]) {
      assert.deepEqual(overriddenLonghands(decl).map(f => f.longhand), [longhand]);
    }
  });
});

test('no style object discards a longhand it meant to set', () => {
  // Six of these shipped, and every single one was a safe-area inset: the
  // sidebar header, the DSP overlay header, the Library-scope page header, the
  // album-detail sheet, the audio diagnostics sheet and the ⋯ overflow box.
  // On a notched phone that is a menu header under the status bar and four
  // sheets under the home indicator.
  const guilty = [];
  for (const f of clientFiles()) {
    for (const hit of overriddenLonghands(code(fs.readFileSync(f, 'utf8')))) {
      guilty.push(`${path.basename(f)}:${hit.line} ${hit.longhand} < ${hit.shorthand}`);
    }
  }
  assert.deepEqual(guilty, [], 'silently discarded declarations:\n  ' + guilty.join('\n  '));
});

test('there is one volume sheet, and both bars use it', async (t) => {
  const sheet = read('components', 'VolumeSheet.jsx');
  const mini = read('components', 'NowPlaying.jsx');
  const full = read('components', 'NowPlayingFullScreen.jsx');

  await t.test('both bars render the shared component', () => {
    assert.match(mini, /<VolumeSheet\b/, 'the mini bar is not using the shared sheet');
    assert.match(full, /<VolumeSheet\b/, 'the full-screen player is not using the shared sheet');
  });

  await t.test('neither keeps a copy of the sheet', () => {
    // The markup, not just the component name: a second <input type="range">
    // wired to /player/volume is the fork coming back.
    for (const [name, src] of [['NowPlaying.jsx', mini], ['NowPlayingFullScreen.jsx', full]]) {
      assert.doesNotMatch(src, /type="range"/, `${name} still draws its own volume slider`);
      assert.doesNotMatch(src, /player\/volume/, `${name} still posts its own volume`);
    }
  });

  await t.test('the three settings buttons are in the shared sheet', () => {
    for (const label of ['DSP', 'Switch', 'Device']) {
      assert.match(sheet, new RegExp(`<span style=\\{s\\.volIconLabel\\}>${label}</span>`),
        `the ${label} button is missing`);
    }
    // And they open something. Buttons that only close the sheet would satisfy
    // a check on the labels alone.
    for (const dest of ['dsp', 'switch', 'device']) {
      assert.match(sheet, new RegExp(`goto\\('${dest}'\\)`), `the ${dest} button goes nowhere`);
    }
    assert.match(sheet, /<DspOverlay\b/);
    assert.match(sheet, /<DeviceSettingsOverlay\b/);
    assert.match(sheet, /<RendererModal\b/);
  });

  await t.test('the fixed-output state and the step buttons come with it', () => {
    // These are two of the things the mini bar never had.
    assert.match(sheet, /Fixed Output/);
    assert.match(sheet, /handleVolumeStep\(-VOLUME_STEP\)/);
    assert.match(sheet, /handleVolumeStep\(VOLUME_STEP\)/);
  });

  await t.test('the mini bar offers it on fixed-output renderers too', () => {
    // It used to hide the button whenever outputMode was 'fixed', which was
    // right about the slider and wrong about the three buttons behind it —
    // the sheet already swaps the slider for a "Fixed Output" label.
    assert.doesNotMatch(mini, /outputMode !== 'fixed'/,
      'the mini bar still hides the whole sheet on fixed output');
    assert.match(mini, /aria-label="Volume and output"/);
  });

  await t.test('the full-screen player still suppresses its swipe', () => {
    // The sheet owns the DSP and device overlays now, so the screen cannot see
    // them directly; it is told instead. Without this the queue swipe fires
    // underneath whatever the sheet opened.
    assert.match(full, /onOverlayChange=\{setVolumeOverlayOpen\}/);
    assert.match(full, /volumeOverlayOpen \|\|/);
    assert.match(sheet, /onOverlayChange\(!!dest\)/);
    // And cleared on unmount, or a host is left suppressing gestures forever.
    assert.match(sheet, /useEffect\(\(\) => \(\) => \{ if \(onOverlayChange\) onOverlayChange\(false\) \}/);
  });
});

test('the side menu leads with Home and no longer says Library', async (t) => {
  const sidebar = read('components', 'Sidebar.jsx');

  await t.test('the LIBRARY heading is gone', () => {
    assert.doesNotMatch(sidebar, /navLabel\}>Library</,
      'the Library heading is still over the list');
    // The Output heading stays — it labels a genuinely different group.
    assert.match(sidebar, /navLabel\}>Output</);
  });

  await t.test('Home is the first row, and goes home', () => {
    assert.match(sidebar, /<span>Home<\/span>/, 'there is no Home row');
    const home = sidebar.indexOf('<span>Home</span>');
    const first = sidebar.indexOf('{sections.map(');
    assert.ok(home !== -1 && first !== -1 && home < first,
      'Home is not above the rest of the list');
    // Same handler as the wordmark, so the two cannot diverge.
    assert.match(sidebar, /onClick=\{handleHome\}>\s*<HomeIcon/);
    assert.match(sidebar, /const handleHome = \(\) => \{[\s\S]*?setSidebarSection\('home'\)[\s\S]*?onClose\(\)/);
  });
});

test('the artists wall is three across, with a switch', async (t) => {
  const list = read('components', 'ArtistList.jsx');
  const css = fs.readFileSync(path.join(CLIENT_SRC, 'index.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  await t.test('three columns on a phone', () => {
    // The default (no media query) rule is the phone one; the breakpoints
    // below it already went 3 / 4 / 5 and are unchanged.
    const at = css.indexOf('.jp-artist-grid {');
    assert.notEqual(at, -1, 'the artist grid class is gone');
    const block = css.slice(at, css.indexOf('}', at));
    assert.match(block, /grid-template-columns:\s*repeat\(3, 1fr\)/,
      'the artists wall is not three across by default');
  });

  await t.test('both layouts exist and only one renders', () => {
    assert.match(list, /view === 'list' \? \(/);
    assert.match(list, /<ArtistRow\b/);
    assert.match(list, /<ArtistCard\b/);
    assert.match(list, /className="jp-artist-grid"/);
  });

  await t.test('the switch is at the top of the screen', () => {
    // The closing brace is part of the needle: `s.viewToggle` alone also
    // matches `s.viewToggleX`, so a renamed style satisfied this and the
    // check passed on a switch that was no longer styled.
    const toggle = list.indexOf('style={s.viewToggle}');
    const grid = list.indexOf('className="jp-artist-grid"');
    assert.ok(toggle !== -1, 'there is no layout switch');
    assert.ok(toggle < grid, 'the switch is below the artists');
    assert.match(list, /aria-checked=\{view === 'grid'\}/);
    assert.match(list, /aria-checked=\{view === 'list'\}/);
  });

  await t.test('the choice survives leaving the screen', () => {
    // It unmounts on every artist you open, so component state would forget it
    // immediately.
    assert.match(list, /loadArtistView\(\)/);
    assert.match(list, /saveArtistView\(v\)/);
    const store = read('artistView.js');
    assert.match(store, /localStorage/);
    assert.match(store, /ARTIST_VIEWS\.includes\(v\) \? v : DEFAULT_ARTIST_VIEW/,
      'an unknown stored value is trusted');
  });

  await t.test('a list row shows a mini avatar, the name and the album count', () => {
    const at = list.indexOf('function ArtistRow');
    assert.notEqual(at, -1, 'there is no list row');
    const body = list.slice(at, list.indexOf('\n}', at));
    assert.match(body, /<ArtistAvatar artist=\{artist\} size=\{40\}/, 'no mini avatar');
    assert.match(body, /\{artist\.name\}/, 'the row does not write the name');
    assert.match(body, /album\{artist\.album_count !== 1 \? 's' : ''\}/, 'no album count');
  });

  await t.test('the row writes the name even when the grid would not', () => {
    // The grid hides it for artists whose logo IS the artwork. At 40px beside
    // a line of text the logo does not say the name, and a column of
    // unlabelled circles is not a list.
    const at = list.indexOf('function ArtistRow');
    const body = list.slice(at, list.indexOf('\n}', at));
    assert.doesNotMatch(body, /isRealLogo/, 'the list row inherited the grid\'s hide-the-name rule');
    // …and the grid still has it.
    assert.match(list, /const isRealLogo =/);
  });

  await t.test('one avatar component serves both, so a logo cannot render in only one', () => {
    assert.match(list, /function ArtistAvatar\(/);
    assert.equal((list.match(/artists\/\$\{encodeURIComponent\(artist\.name\)\}\/logo/g) || []).length, 1,
      'the logo URL is built in more than one place');
    assert.match(list, /draggable=\{false\}/);
  });
});
