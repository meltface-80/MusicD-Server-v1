// The four themes (v1.1.24.0).
//
// Two things are checked, and only one of them is about CSS.
//
// 1. THE PALETTES ARE COMPLETE AND ACCESSIBLE. Every contrast ratio is
//    computed from the REAL tokens in index.css — including the ones built
//    out of rgba(var(--tint-rgb), α), which is where the interesting failures
//    live — and asserted against WCAG. This is worth automating because
//    contrast is invisible to review: a palette that fails looks fine to
//    whoever picked the colours, and the failure only lands on the people who
//    could least afford it. Two ratios genuinely fall short and are asserted
//    at the level they actually meet, with the gap named; a test that
//    pretended they passed would be worse than no test.
//
// 2. NOTHING STILL PAINTS ITSELF A FIXED COLOUR. 154 hairlines and washes were
//    literal rgba(255,255,255,α): correct on a dark ground, invisible on a
//    light one. A theme is only as good as its least-migrated component, and
//    one file left behind would look broken in exactly half the palettes.
//
// The harness is headless Chromium with no way to look at the result, so this
// verifies by construction. That is the standing rule for anything visual in
// this project.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CLIENT_SRC = path.join(__dirname, '..', '..', 'client', 'src');
const read = (...p) => fs.readFileSync(path.join(CLIENT_SRC, ...p), 'utf8');
const CSS = read('index.css');

// ---------------------------------------------------------------------------
// A very small CSS-variable resolver. It only understands what these palettes
// use: hex literals, rgba() literals, rgba(var(--tint-rgb), α) and
// rgba(var(--tint-rgb), var(--jp-dim|--jp-faint)).
// ---------------------------------------------------------------------------

function declarations(selector) {
  const at = CSS.indexOf(selector);
  assert.notEqual(at, -1, `selector is gone from index.css: ${selector}`);
  const open = CSS.indexOf('{', at);
  const close = CSS.indexOf('}', open);
  const body = CSS.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, '');
  const out = {};
  for (const decl of body.split(';')) {
    const i = decl.indexOf(':');
    if (i === -1) continue;
    const k = decl.slice(0, i).trim();
    if (k.startsWith('--')) out[k] = decl.slice(i + 1).trim();
  }
  return out;
}

// Parsed on first use, not at module load: a renamed selector should fail the
// test that needed it, not throw before any test runs and hide the rest.
let _palettes = null;
function palettes() {
  if (!_palettes) {
    _palettes = {
      'dark':        declarations(':root,\n[data-theme="dark"][data-palette="classic"]'),
      'light':       declarations('[data-theme="light"][data-palette="classic"]'),
      'copper-dark': declarations('[data-theme="dark"][data-palette="copper"]'),
      'brass-light': declarations('[data-theme="light"][data-palette="copper"]'),
    };
  }
  return _palettes;
}
let _derived = null;
function derived() {
  if (!_derived) _derived = declarations('/* Everything derived from the palette above');
  return _derived;
}

function hexToRgb(h) {
  const s = h.replace('#', '');
  const full = s.length === 3 ? [...s].map(c => c + c).join('') : s;
  return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16));
}

// Returns [r, g, b, a].
function token(name, palette) {
  const raw = palette[name] !== undefined ? palette[name] : derived()[name];
  assert.ok(raw !== undefined, `token ${name} is defined in neither the palette nor the derived block`);
  if (raw.startsWith('#')) return [...hexToRgb(raw), 1];

  let m = /^rgba\(var\(--tint-rgb\),\s*(?:var\(--([a-z-]+)\)|([\d.]+))\)$/.exec(raw);
  if (m) {
    const tint = (palette['--tint-rgb'] || derived()['--tint-rgb']).split(',').map(n => parseInt(n, 10));
    const alpha = m[1] ? parseFloat(palette['--' + m[1]]) : parseFloat(m[2]);
    assert.ok(Number.isFinite(alpha), `${name} has an unresolvable alpha in this palette`);
    return [...tint, alpha];
  }
  m = /^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(raw);
  if (m) return [+m[1], +m[2], +m[3], +m[4]];
  assert.fail(`cannot resolve ${name} = ${raw}`);
}

const composite = (fg, bg) => fg.slice(0, 3).map((c, i) => c * fg[3] + bg[i] * (1 - fg[3]));

function luminance([r, g, b]) {
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// Contrast of `fg` over `bg`, compositing both onto opaque ground first.
function contrast(fgName, bgName, palette) {
  const bgRaw = token(bgName, palette);
  const bg = bgRaw[3] === 1 ? bgRaw.slice(0, 3) : composite(bgRaw, [0, 0, 0]);
  const fg = composite(token(fgName, palette), bg);
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

// ---------------------------------------------------------------------------

test('the contrast maths is right before it is trusted', () => {
  // Prove the reader and the formula bite, against values with known answers.
  const fake = { '--tint-rgb': '255, 255, 255', '--jp-faint': '0.5',
                 '--w': '#ffffff', '--k': '#000000', '--half': 'rgba(var(--tint-rgb), var(--jp-faint))' };
  const round = (n) => Math.round(n * 100) / 100;
  assert.equal(round(contrast('--w', '--k', fake)), 21, 'white on black is not 21:1');
  assert.equal(round(contrast('--k', '--w', fake)), 21, 'the ratio is not symmetric');
  assert.equal(round(contrast('--w', '--w', fake)), 1);
  // 50% white over black composites to #808080 — 5.28:1 on black, not the
  // 21:1 an uncomposited read of the raw white would give.
  assert.equal(round(contrast('--half', '--k', fake)), 5.28,
    'the alpha channel is not being composited');
});

test('every palette defines every token', async (t) => {
  // A token missing from one palette does not fall back to a sensible value —
  // it falls back to the :root block, i.e. to the DARK palette, and paints a
  // near-black surface into the middle of a light theme.
  const reference = Object.keys(palettes()['dark']).filter(k => k !== '--tint-rgb');

  for (const [name, pal] of Object.entries(palettes())) {
    if (name === 'dark') continue;
    await t.test(`${name} is complete`, () => {
      const missing = reference.filter(k => pal[k] === undefined);
      assert.deepEqual(missing, [],
        `${name} inherits these from the dark palette: ${missing.join(', ')}`);
    });
  }

  await t.test('and every palette names its own tint channel', () => {
    for (const [name, pal] of Object.entries(palettes())) {
      assert.ok(pal['--tint-rgb'], `${name} has no --tint-rgb`);
      assert.match(pal['--tint-rgb'], /^\d+,\s*\d+,\s*\d+$/,
        `${name}'s --tint-rgb must be bare rgb components for rgba() to take it`);
    }
  });
});

test('body text clears WCAG AA in every palette', async (t) => {
  // 4.5:1, the normal-text bar.
  const AA = 4.5;
  const PAIRS = [
    ['--text-primary',   '--bg-base'],
    ['--text-primary',   '--bg-elevated'],
    ['--text-primary',   '--bg-surface'],
    ['--text-secondary', '--bg-base'],
    ['--text-secondary', '--bg-elevated'],
    ['--jp-text',        '--jp-bg'],
    ['--jp-text',        '--jp-bg-elevated'],
    ['--jp-text-2',      '--jp-bg'],
    // The near-white "Play" pill and its label — an inversion, so both
    // directions have to hold.
    ['--jp-bg',          '--jp-accent'],
    ['--red',            '--bg-base'],
  ];
  for (const [name, pal] of Object.entries(palettes())) {
    await t.test(name, () => {
      for (const [fg, bg] of PAIRS) {
        const r = contrast(fg, bg, pal);
        assert.ok(r >= AA, `${name}: ${fg} on ${bg} is ${r.toFixed(2)}:1, below AA ${AA}`);
      }
    });
  }
});

test('auxiliary text clears the 3:1 large-text bar', async (t) => {
  // --text-tertiary and --jp-text-3 are hints, durations and unit labels. AA
  // proper would flatten them into the tier above and cost the hierarchy that
  // makes the screens readable, so 3:1 is the bar they are held to — and they
  // are all held to it, in all four palettes.
  const LARGE = 3.0;
  const PAIRS = [
    ['--text-tertiary', '--bg-base'],
    ['--text-tertiary', '--bg-elevated'],
    ['--jp-text-3',     '--jp-bg'],
    ['--jp-text-3',     '--jp-bg-elevated'],
  ];
  for (const [name, pal] of Object.entries(palettes())) {
    await t.test(name, () => {
      for (const [fg, bg] of PAIRS) {
        const r = contrast(fg, bg, pal);
        assert.ok(r >= LARGE, `${name}: ${fg} on ${bg} is ${r.toFixed(2)}:1, below ${LARGE}`);
      }
    });
  }
});

test('a label on an accent fill is readable, and where it is not, says so', async (t) => {
  // --on-accent over --accent. Three of the four clear AA comfortably.
  await t.test('the three palettes that clear AA do clear it', () => {
    for (const name of ['light', 'copper-dark', 'brass-light']) {
      const r = contrast('--on-accent', '--accent', palettes()[name]);
      assert.ok(r >= 4.5, `${name}: ${r.toFixed(2)}:1 on its own accent`);
    }
  });

  await t.test('the classic dark palette ships a known 3.13:1 and is pinned there', () => {
    // White on #6b8aff. This is the accent this app has always used and the
    // label colour it has always used, and it is a real AA failure for the
    // 12-13px button labels it carries. Fixing it means either darkening the
    // accent — which also serves as link text ON dark surfaces, where
    // darkening makes things worse — or flipping the label to near-black,
    // which visibly changes every primary button in the theme people are
    // already using. Neither was asked for. It is pinned at what it measures,
    // so a change either way shows up here rather than passing silently.
    const r = contrast('--on-accent', '--accent', palettes()['dark']);
    assert.ok(r >= 3.0, `classic dark on-accent fell below 3:1 (${r.toFixed(2)})`);
    assert.ok(r < 4.5, 'classic dark on-accent now clears AA — raise this bar and delete the excuse');
  });

  await t.test('the accent is readable as text in every palette', () => {
    // It is used for links and active labels as well as for fills.
    for (const [name, pal] of Object.entries(palettes())) {
      for (const bg of ['--bg-base', '--bg-elevated']) {
        const r = contrast('--accent', bg, pal);
        assert.ok(r >= 4.5, `${name}: accent on ${bg} is ${r.toFixed(2)}:1`);
      }
    }
  });
});

test('the light palettes actually invert', async (t) => {
  await t.test('their tint channel darkens rather than lightens', () => {
    // The whole migration rests on this: a hairline is rgba(var(--tint-rgb),
    // α), so on a light palette the channel has to be dark or every border in
    // the app is white-on-white.
    for (const name of ['light', 'brass-light']) {
      const tint = palettes()[name]['--tint-rgb'].split(',').map(n => parseInt(n, 10));
      assert.ok(luminance(tint) < 0.2, `${name}'s tint is not a dark channel: ${tint}`);
    }
    for (const name of ['dark', 'copper-dark']) {
      const tint = palettes()[name]['--tint-rgb'].split(',').map(n => parseInt(n, 10));
      assert.ok(luminance(tint) > 0.6, `${name}'s tint is not a light channel: ${tint}`);
    }
  });

  await t.test('their page really is lighter than their text', () => {
    for (const name of ['light', 'brass-light']) {
      const pal = palettes()[name];
      assert.ok(luminance(token('--bg-base', pal)) > luminance(token('--text-primary', pal)),
        `${name} is not a light theme`);
      assert.ok(luminance(token('--jp-bg', pal)) > luminance(token('--jp-accent', pal)),
        `${name}'s Now Playing screen is not a light surface`);
    }
  });
});

test('nothing in the client paints itself a fixed white any more', async (t) => {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(jsx?|css)$/.test(e.name)) files.push(p);
    }
  };
  walk(CLIENT_SRC);
  // index.css explains this migration at length and quotes the literals it
  // replaced. Both sweeps below read the source WITHOUT its comments, or they
  // fail on their own documentation — which is the same sin as passing on it.
  const bodyOf = (f) => fs.readFileSync(f, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  await t.test('no rgba(255,255,255,…) is left', () => {
    // All 154 of them are rgba(var(--tint-rgb), α) now. One file left behind
    // would show as invisible hairlines on exactly the two light palettes,
    // which is the half of the app nobody testing on a dark screen would see.
    const guilty = files
      .filter(f => /rgba\(\s*255\s*,\s*255\s*,\s*255/.test(bodyOf(f)))
      .map(f => path.basename(f));
    assert.deepEqual(guilty, [], 'still hard-coded white: ' + guilty.join(', '));
  });

  await t.test('the fixed white/black that remains is only on fixed fills', () => {
    // A short, named list: toggle knobs (white in every theme, like iOS), the
    // share chip's deliberate light/dark pair over arbitrary album art, and
    // labels on fills that are themselves fixed colours (--red, the update
    // button's blue, a tag swatch). Anything NEW joining this list is a
    // migration someone stopped halfway through.
    const allowed = new Set([
      'NowPlayingFullScreen.jsx',  // share-chip pair + the radio toggle knob
      'SettingsScreen.jsx',        // white on --red, on the fixed update blue, toggle knob
      'HomeScreenSection.jsx',     // toggle knob
      'FocusLibraryScreen.jsx',    // white on a fixed #ff3b5c
      'ProfileBar.jsx',            // white on a fixed #d04848
      'TagManagementSection.jsx',  // the tick on a user-chosen tag swatch
    ]);
    const guilty = files
      // index.css is where a literal colour BELONGS: the palettes are the one
      // place in the client that may name a colour outright.
      .filter(f => path.basename(f) !== 'index.css')
      .filter(f => /'#(?:fff|ffffff|000|000000)'|"#(?:fff|ffffff|000)"/.test(bodyOf(f)))
      .map(f => path.basename(f))
      .filter(f => !allowed.has(f));
    assert.deepEqual(guilty, [],
      'these paint a fixed black or white outside the agreed list: ' + guilty.join(', '));
  });
});

test('the picker applies a theme and remembers it', async (t) => {
  const theme = read('theme.js');
  const section = read('components', 'AppearanceSection.jsx');
  const main = read('main.jsx');
  const settings = read('components', 'SettingsScreen.jsx');

  await t.test('all four are offered, and their ids match the remote', () => {
    for (const id of ['dark', 'light', 'copper-dark', 'brass-light']) {
      assert.match(theme, new RegExp(`id: '${id}'`), `${id} is missing from THEMES`);
    }
  });

  await t.test('every theme names an existing palette block', () => {
    const declared = [...theme.matchAll(/theme: '(\w+)',\s*\n\s*palette: '(\w+)'/g)]
      .map(m => `[data-theme="${m[1]}"][data-palette="${m[2]}"]`);
    assert.equal(declared.length, 4, 'a theme is missing its theme/palette pair');
    for (const sel of declared) {
      assert.ok(CSS.includes(sel), `${sel} is offered in the picker but not defined in index.css`);
    }
  });

  await t.test('the theme is applied before the first paint', () => {
    // From an effect it would run after paint and flash the default palette on
    // every launch — most visibly for someone who chose a light theme.
    assert.match(main, /applyTheme\(loadThemeId\(\)\)/);
    assert.ok(main.indexOf('applyTheme(loadThemeId())') < main.indexOf('createRoot'),
      'the theme is applied after React mounts, so every launch flashes the default');
  });

  await t.test('an unknown stored id cannot leave the app unthemed', () => {
    assert.match(theme, /function normaliseThemeId/);
    assert.match(theme, /themeById\(id\) \? id : DEFAULT_THEME/);
  });

  await t.test('storage failure is caught, and says why silence is safe', () => {
    // CLAUDE.md: no silent catch.
    const catches = [...theme.matchAll(/catch \(e\) \{([\s\S]*?)\n  \}/g)].map(m => m[1]);
    assert.ok(catches.length >= 2, 'the storage helpers no longer guard against private mode');
    for (const body of catches) {
      assert.match(body, /\/\//, 'a catch block in theme.js has no comment saying why silence is safe');
    }
  });

  await t.test('each swatch previews its own palette, not the applied one', () => {
    // The whole reason the palette selectors are plain attribute selectors
    // rather than :root[...] — see the note above them in index.css.
    assert.match(section, /data-theme=\{t\.theme\}/);
    assert.match(section, /data-palette=\{t\.palette\}/);
    assert.doesNotMatch(CSS, /:root\[data-theme/,
      'the palettes are root-only again, so the swatches all preview the same theme');
  });

  await t.test('Appearance sits directly below Backup in Settings', () => {
    const list = settings.slice(settings.indexOf('const SECTIONS = ['));
    const backup = list.indexOf("id: 'backup'");
    const appearance = list.indexOf("id: 'appearance'");
    const update = list.indexOf("id: 'update'");
    assert.ok(backup !== -1 && appearance !== -1 && update !== -1, 'a section is missing');
    assert.ok(backup < appearance && appearance < update,
      'Appearance is not between Backup and Update');
    assert.match(settings, /<Section id="appearance"/, 'the section list has an entry with no page');
  });
});
