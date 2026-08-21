// Volume levelling, per zone (v1.1.32.0).
//
// It was three GLOBAL settings rows — vl_enabled, vl_mode, vl_target_lufs —
// read straight from the settings table by three separate places in the
// playback path and applied to every zone at once. The owner wanted it per
// zone like the rest of the DSP chain.
//
// The migration is where this could hurt someone. There is no backfill: the
// new columns are nullable and NULL resolves to what the global said, so a
// zone nobody has touched keeps behaving exactly as it did. That is the
// property worth running rather than reading, because "an upgrade changes
// nothing until you change something" is not visible in a diff — so the
// resolution is exercised against real SQLite below, with a settings table
// holding a real global.
//
// The other half is that all three read sites moved. A site left on the global
// would keep working perfectly on the zone whose setting happens to match, and
// silently ignore every other zone — the kind of bug that gets reported as
// "levelling doesn't work on the kitchen speaker" months later.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const Module = require('node:module');

const SERVER_SRC = path.join(__dirname, '..', 'src');
const CLIENT_SRC = path.join(__dirname, '..', '..', 'client', 'src');
const readRaw = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const client = (...p) => code(readRaw(CLIENT_SRC, ...p));

// The renderer_dsp DDL, taken from db.js itself so a schema change that breaks
// the module fails here rather than on a device.
function makeDb() {
  const db = new Database(':memory:');
  const src = readRaw(SERVER_SRC, 'db.js');
  const at = src.indexOf('CREATE TABLE IF NOT EXISTS renderer_dsp (');
  assert.notEqual(at, -1, 'the renderer_dsp DDL is gone from db.js');
  db.exec(src.slice(at, src.indexOf(');', at) + 2));
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
  return db;
}

// Load the dsp module against our in-memory handle.
function loadDsp(db) {
  const orig = Module._load;
  Module._load = function (req) {
    if (req === '../db' || req === './db') return { get: () => db };
    return orig.apply(this, arguments);
  };
  try {
    for (const m of ['../src/dsp', '../src/dsp/index', '../src/loudness']) {
      try { delete require.cache[require.resolve(m)] } catch { /* not loaded */ }
    }
    // loudness FIRST, and inside the stub. dsp requires it lazily — at call
    // time, by which point this stub is long gone — so it has to be in the
    // module cache already bound to our database, or getProfile's fallback
    // reads the real one on disk and this test proves nothing.
    require('../src/loudness');
    return require('../src/dsp');
  } finally { Module._load = orig; }
}

const setGlobal = (db, k, v) =>
  db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(k, JSON.stringify(v));

test('the schema carries levelling per zone, nullable', async (t) => {
  const db = makeDb();
  const cols = db.prepare('PRAGMA table_info(renderer_dsp)').all();
  const by = Object.fromEntries(cols.map(c => [c.name, c]));

  await t.test('the three columns exist', () => {
    for (const c of ['vl_enabled', 'vl_mode', 'vl_target_lufs']) {
      assert.ok(by[c], `renderer_dsp.${c} is missing`);
    }
  });

  await t.test('and none of them has a default', () => {
    // A default would make "never set" indistinguishable from "set to off",
    // and the upgrade would flip levelling off for anyone who had it on.
    for (const c of ['vl_enabled', 'vl_mode', 'vl_target_lufs']) {
      assert.equal(by[c].dflt_value, null,
        `renderer_dsp.${c} has a default — NULL must mean "follow the global"`);
    }
  });

  await t.test('db.js migrates existing installs too', () => {
    // A fresh install gets the DDL; everyone else needs the ALTER.
    const src = code(readRaw(SERVER_SRC, 'db.js'));
    for (const c of ['vl_enabled', 'vl_mode', 'vl_target_lufs']) {
      assert.match(src, new RegExp(`safeAddColumn\\('renderer_dsp', *'${c}'`),
        `${c} is in the DDL but no migration adds it to an existing database`);
    }
  });
});

test('an upgrade changes nothing until the user changes something', async (t) => {
  const db = makeDb();
  // Someone who had levelling ON globally, in album mode, at -16.
  setGlobal(db, 'vl_enabled', true);
  setGlobal(db, 'vl_mode', 'album');
  setGlobal(db, 'vl_target_lufs', -16);
  const dsp = loadDsp(db);

  await t.test('a zone with no row at all inherits it', () => {
    const p = dsp.getProfile('never-seen');
    assert.equal(p.vl_enabled, true);
    assert.equal(p.vl_mode, 'album');
    assert.equal(p.vl_target_lufs, -16);
  });

  await t.test('and so does a zone whose row predates the columns', () => {
    // Exactly what the migration leaves behind: a row with NULLs.
    db.prepare('INSERT INTO renderer_dsp (renderer_id, peq_enabled) VALUES (?, 1)').run('old');
    const p = dsp.getProfile('old');
    assert.equal(p.vl_enabled, true, 'an upgraded zone lost its levelling');
    assert.equal(p.vl_mode, 'album');
    assert.equal(p.vl_target_lufs, -16);
  });

  await t.test('setting one zone leaves the others alone', () => {
    dsp.saveProfile('kitchen', { vl_enabled: false });
    assert.equal(dsp.getProfile('kitchen').vl_enabled, false);
    assert.equal(dsp.getProfile('lounge').vl_enabled, true,
      'turning levelling off in one zone turned it off everywhere');
  });

  await t.test('a SECOND save keeps what the first one set', () => {
    // The first save of a zone INSERTs; every one after it takes the ON
    // CONFLICT branch, which is a separate list of columns. A field left out
    // of that list persists once and is then silently reverted by the next
    // save of anything else on that zone — which is the shape of the
    // headroom bug this project shipped in v1.1.0.53.
    // The second save must CHANGE each value, not merely repeat it: a column
    // missing from the conflict list keeps whatever the INSERT wrote, so
    // re-saving the same value passes either way. That is how the first
    // version of this missed it.
    dsp.saveProfile('twice', { vl_enabled: true, vl_mode: 'album', vl_target_lufs: -16 });
    dsp.saveProfile('twice', { vl_enabled: false });
    assert.equal(dsp.getProfile('twice').vl_enabled, false,
      'the second save did not reach vl_enabled — check the ON CONFLICT list');
    dsp.saveProfile('twice', { vl_mode: 'track' });
    assert.equal(dsp.getProfile('twice').vl_mode, 'track',
      'the second save did not reach vl_mode — check the ON CONFLICT list');
    dsp.saveProfile('twice', { vl_target_lufs: -21 });
    assert.equal(dsp.getProfile('twice').vl_target_lufs, -21,
      'the second save did not reach vl_target_lufs — check the ON CONFLICT list');
    // And an unrelated save must not revert any of them.
    dsp.saveProfile('twice', { peq_enabled: true });
    const p = dsp.getProfile('twice');
    assert.equal(p.vl_enabled, false);
    assert.equal(p.vl_mode, 'track');
    assert.equal(p.vl_target_lufs, -21);
  });

  await t.test('a zone saved for any reason pins its levelling', () => {
    // Saving PEQ writes the whole row, so the levelling it was resolving to
    // becomes explicit. That is deliberate: a zone the user has configured
    // should not shift later because of a global they can no longer see.
    dsp.saveProfile('study', { peq_enabled: true });
    const row = db.prepare('SELECT vl_enabled, vl_mode, vl_target_lufs FROM renderer_dsp WHERE renderer_id = ?').get('study');
    assert.equal(row.vl_enabled, 1);
    assert.equal(row.vl_mode, 'album');
    assert.equal(row.vl_target_lufs, -16);
  });
});

test('the target is clamped to the range the slider publishes', async (t) => {
  const db = makeDb();
  const dsp = loadDsp(db);
  await t.test('out of range either way', () => {
    assert.equal(dsp.saveProfile('a', { vl_target_lufs: 6 }).vl_target_lufs, -14);
    assert.equal(dsp.saveProfile('b', { vl_target_lufs: -99 }).vl_target_lufs, -23);
  });
  await t.test('and junk', () => {
    assert.equal(dsp.saveProfile('c', { vl_target_lufs: 'loud' }).vl_target_lufs, -18);
  });
  await t.test('the mode only ever stores one of two values', () => {
    assert.equal(dsp.saveProfile('d', { vl_mode: 'nonsense' }).vl_mode, 'track');
    assert.equal(dsp.saveProfile('e', { vl_mode: 'album' }).vl_mode, 'album');
  });
});

test('every place that reads levelling reads it per zone', async (t) => {
  // Three sites decide whether a stream is levelled: the one that actually
  // applies the gain, the one that predicts the format for DIDL, and the one
  // that reports the signal path. A site left on the global would work on
  // whichever zone happened to match and quietly ignore the rest.
  const SITES = [
    ['routes/stream.js', 'applies the gain to the audio'],
    ['streamFormat.js', 'predicts whether the stream is re-encoded'],
    ['playerState.js', 'reports the signal path'],
  ];
  for (const [file, what] of SITES) {
    await t.test(`${file} — ${what}`, () => {
      const src = code(readRaw(SERVER_SRC, ...file.split('/')));
      assert.doesNotMatch(src, /getSetting\(\s*'vl_enabled'/,
        `${file} still reads the GLOBAL vl_enabled`);
      assert.doesNotMatch(src, /getSetting\(\s*'vl_target_lufs'/,
        `${file} still reads the GLOBAL vl_target_lufs`);
      assert.match(src, /getProfile\(/, `${file} does not read a zone's profile`);
    });
  }

  await t.test('the gain calculation is told which mode, not left to guess', () => {
    // computeStreamGain used to read the global vl_mode itself. Album vs track
    // is per zone now, so the caller has to pass it.
    const loudness = code(readRaw(SERVER_SRC, 'loudness.js'));
    assert.match(loudness, /function computeStreamGain\(trackId, targetLufs, modeArg\)/);
    assert.match(loudness, /const mode\s*=\s*modeArg \?\?/);
    for (const f of ['routes/stream.js', 'playerState.js']) {
      assert.match(code(readRaw(SERVER_SRC, ...f.split('/'))),
        /computeStreamGain\([^)]*vl_mode\)/,
        `${f} calls computeStreamGain without the zone's mode`);
    }
  });

  await t.test('levelling is not gated on DSP eligibility', () => {
    // It is a gain applied before the encoder, not part of the filter chain.
    // A Sonos zone bypasses the EQ and must still be able to level.
    const stream = code(readRaw(SERVER_SRC, 'routes', 'stream.js'));
    const at = stream.indexOf('const vlProfile =');
    assert.notEqual(at, -1, 'the stream route no longer resolves a levelling profile');
    const before = stream.slice(Math.max(0, at - 400), at);
    assert.doesNotMatch(before, /isDspEligible[\s\S]*\{\s*$/,
      'levelling has been moved inside the DSP-eligibility branch');
  });

  await t.test('the route lets the client set them', () => {
    const dspRoute = code(readRaw(SERVER_SRC, 'routes', 'dsp.js'));
    for (const f of ['vl_enabled', 'vl_mode', 'vl_target_lufs']) {
      assert.match(dspRoute, new RegExp(`'${f}'`), `${f} is not in the PUT allow-list`);
    }
  });
});

test('the DSP page is one page, per zone, with collapsing categories', async (t) => {
  const dspTab = client('components', 'DspTab.jsx');
  const settings = client('components', 'SettingsScreen.jsx');

  await t.test('the zone picker is at the top', () => {
    const picker = dspTab.indexOf('style={s.rendererSelect}');
    const firstCat = dspTab.indexOf('<Category');
    assert.ok(picker !== -1, 'the zone picker is gone');
    assert.ok(firstCat !== -1, 'there are no categories');
    assert.ok(picker < firstCat, 'the zone picker is below the categories');
    // And above the profile bar too, which is the next thing on the page.
    const bar = dspTab.indexOf('<ProfileBar');
    assert.ok(bar === -1 || picker < bar, 'the zone picker is below the profile bar');
  });

  await t.test('all five categories are there, in order', () => {
    const titles = [...dspTab.matchAll(/<Category\s+title="([^"]+)"/g)].map(m => m[1]);
    assert.deepEqual(titles, [
      'Volume levelling', 'Headroom', 'FIR Convolution',
      'Parametric EQ', 'AutoEQ headphone presets',
    ]);
  });

  await t.test('a category renders nothing while it is off', () => {
    // Not merely hidden: a collapsed FIR section would keep polling its IR
    // list, and a collapsed PEQ would hold a draft the user cannot see.
    assert.match(dspTab, /\{on && <div style=\{s\.subBody\}>\{children\}<\/div>\}/,
      'the body is rendered while the category is off');
    assert.match(dspTab, /aria-expanded=\{on\}/);
  });

  await t.test('the switch writes through immediately', () => {
    // It collapses its own section, so a staged value would need the Save
    // button that just disappeared with the body.
    assert.match(dspTab, /const setFlag = async \(patch\) => \{[\s\S]{0,240}?api\.put\(`\/dsp\/profile\//);
    for (const flag of ['vl_enabled', 'headroom_enabled', 'conv_enabled', 'peq_enabled']) {
      assert.match(dspTab, new RegExp(`setFlag\\(\\{ ${flag}: v \\}\\)`),
        `${flag} is not written by its heading switch`);
    }
  });

  await t.test('and the section bodies no longer send it', () => {
    // saveProfile merges a patch, so leaving the key out is what keeps the
    // heading authoritative. Sending it would let a stale draft undo the
    // switch on the next Save.
    for (const [file, flag] of [
      ['HeadroomSection.jsx', 'headroom_enabled'],
      ['FirSection.jsx', 'conv_enabled'],
      ['PeqEditor.jsx', 'peq_enabled'],
    ]) {
      const src = client('components', file);
      assert.doesNotMatch(src, new RegExp(`${flag}:`), `${file} still saves ${flag}`);
      assert.doesNotMatch(src, /setEnabled/, `${file} still owns an enable of its own`);
      assert.match(src, /enabled = false \}\)/, `${file} does not take enabled as a prop`);
    }
  });

  await t.test('volume levelling has left the global Settings page', () => {
    assert.doesNotMatch(settings, /vl_enabled|vl_target_lufs|vl_mode/,
      'the global volume-levelling controls are still on the Settings page');
  });

  await t.test('AutoEQ has left too, and lost its second zone picker', () => {
    assert.doesNotMatch(settings, /AutoEqTab/, 'AutoEQ still has its own Settings section');
    assert.doesNotMatch(settings, /id: 'autoeq'/, 'the Settings index still lists AutoEQ');
    const autoeq = client('components', 'AutoEqTab.jsx');
    assert.match(autoeq, /rendererId: fixedRid = null/, 'AutoEqTab does not take the zone');
    assert.match(autoeq, /\{!fixedRid && \(\s*<div style=\{s\.headerRow\}>/,
      'AutoEqTab still shows a zone picker inside the DSP page');
    // Applying a preset rewrites the PEQ the section above is displaying.
    assert.match(autoeq, /if \(onProfileChange\) onProfileChange\(\)/,
      'applying a preset leaves the PEQ section showing the old curve');
  });
});
