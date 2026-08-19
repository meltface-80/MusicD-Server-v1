// The now-playing artwork, and the two things that were wrong with it.
//
// 1. Grey bands above and below the cover. One element was doing two jobs: the
//    flexible box that absorbs whatever vertical space the screen has left,
//    AND the surface the art is drawn on — with a --jp-bg-surface background
//    and objectFit:'contain'. On a tall phone that box is far taller than it
//    is wide, so a square cover fitted to the width and left the surface
//    showing above and below. Splitting the two jobs is the fix, and a grep is
//    the only way to hold it: this environment is headless with no layout to
//    measure.
//
// 2. The share button vanished into the artwork. It sits on the bottom-right
//    of the cover with one fixed translucent-dark palette, which disappears on
//    a bright sleeve. It now samples that corner and takes the opposite
//    palette — and the sampling maths is a pure function precisely so it can
//    be tested here rather than eyeballed on a phone.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const CLIENT_SRC = path.join(__dirname, '..', '..', 'client', 'src');
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const read = (...p) => code(fs.readFileSync(path.join(...p), 'utf8'));

// One flat RGBA colour, as getImageData would hand it over.
const solid = (r, g, b, a = 255, n = 64) => {
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) { out[i*4] = r; out[i*4+1] = g; out[i*4+2] = b; out[i*4+3] = a; }
  return out;
};

test('the corner sample decides the palette the way a person would', async (t) => {
  const { relativeLuminance, meanLuminance, isLightSample, cornerRect, LIGHT_THRESHOLD } =
    await import(pathToFileURL(path.join(CLIENT_SRC, 'artLuminance.js')).href);

  await t.test('black and white sit at the ends', () => {
    assert.equal(relativeLuminance(0, 0, 0), 0);
    assert.equal(Math.round(relativeLuminance(255, 255, 255) * 1000) / 1000, 1);
  });

  await t.test('the Hard-Fi yellow reads as light', () => {
    // The actual sleeve from the report: saturated yellow, on which the dark
    // chip was invisible. A naive 0.299R+0.587G+0.114B on gamma-encoded values
    // is what gets this kind of colour wrong.
    assert.ok(isLightSample(solid(255, 237, 0)), 'a bright yellow sleeve read as dark');
  });

  await t.test('an ordinary dark sleeve keeps the dark chip', () => {
    for (const [r, g, b] of [[0,0,0], [18,18,20], [40,30,70], [120,20,20]]) {
      assert.ok(!isLightSample(solid(r, g, b)),
        `rgb(${r},${g},${b}) flipped the button to the light palette`);
    }
  });

  await t.test('mid-grey does not flip it', () => {
    // #808080 is only about 0.216 in linear light, so the dark chip — the
    // established look — holds until the art is genuinely bright.
    assert.ok(!isLightSample(solid(128, 128, 128)));
    assert.ok(relativeLuminance(128, 128, 128) < LIGHT_THRESHOLD);
  });

  await t.test('near-white artwork flips it', () => {
    for (const [r, g, b] of [[255,255,255], [240,240,235], [255,240,200]]) {
      assert.ok(isLightSample(solid(r, g, b)),
        `rgb(${r},${g},${b}) left the button on the dark palette`);
    }
  });

  await t.test('it averages a mixed corner rather than reading one pixel', () => {
    const half = new Uint8ClampedArray(8 * 4);
    for (let i = 0; i < 4; i++) { half[i*4] = half[i*4+1] = half[i*4+2] = 255; half[i*4+3] = 255; }
    for (let i = 4; i < 8; i++) { half[i*4+3] = 255; }   // black
    const mean = meanLuminance(half);
    assert.ok(mean > 0.4 && mean < 0.6, `half white half black averaged to ${mean}`);
  });

  await t.test('transparent pixels are skipped, not counted as black', () => {
    const withHole = solid(255, 255, 255, 255, 8);
    for (let i = 0; i < 4; i++) withHole[i*4+3] = 0;
    assert.ok(isLightSample(withHole), 'transparent pixels dragged a white corner dark');
  });

  await t.test('nothing to sample keeps the default palette', () => {
    assert.equal(meanLuminance(new Uint8ClampedArray(0)), null);
    assert.equal(meanLuminance(null), null);
    assert.equal(isLightSample(null), false, 'an unsampleable cover must not flip the button');
    assert.equal(isLightSample(solid(255, 255, 255, 0)), false);
  });

  await t.test('the sampled rectangle is the corner the button sits in', () => {
    const r = cornerRect(1000, 1000);
    assert.equal(r.w, 250); assert.equal(r.h, 250);
    assert.equal(r.x + r.w, 1000, 'not flush to the right edge');
    assert.equal(r.y + r.h, 1000, 'not flush to the bottom edge');
  });

  await t.test('the rectangle survives a tiny or oblong cover', () => {
    for (const [w, h] of [[1, 1], [2, 3], [3000, 300], [300, 3000]]) {
      const r = cornerRect(w, h);
      assert.ok(r.w >= 1 && r.h >= 1, `${w}x${h} produced a zero-area sample`);
      assert.ok(r.x >= 0 && r.y >= 0, `${w}x${h} produced a negative origin`);
      assert.ok(r.x + r.w <= w && r.y + r.h <= h, `${w}x${h} sampled outside the image`);
    }
  });
});

test('no surface is left for a grey band to appear on', async (t) => {
  const view = read(CLIENT_SRC, 'components', 'NowPlayingFullScreen.jsx');

  const styleBlock = (name) => {
    const at = view.indexOf(`  ${name}: {`);
    assert.ok(at !== -1, `${name} style not found`);
    return view.slice(at, view.indexOf('\n  },', at));
  };

  await t.test('the flexible wrapper paints nothing', () => {
    // This is the regression. A background here shows wherever the art does
    // not reach, which on a tall phone is a band top and bottom.
    const wrap = styleBlock('artWrap');
    assert.ok(!/background/.test(wrap),
      'artWrap has a background again: ' + wrap.trim());
  });

  await t.test('the art element paints nothing either', () => {
    const art = view.slice(view.indexOf('  art: {'), view.indexOf('\n  artEmpty:'));
    assert.ok(!/background/.test(art), 'the img carries a background: ' + art.trim());
  });

  await t.test('the cover fills its box rather than being fitted inside it', () => {
    const art = view.slice(view.indexOf('  art: {'), view.indexOf('\n  artEmpty:'));
    assert.match(art, /objectFit: 'cover'/,
      "objectFit:'contain' frames an odd-shaped cover in bands");
  });

  await t.test('the box is square, so every cover is the same size', () => {
    const box = styleBlock('artBox');
    assert.match(box, /aspectRatio: '1 \/ 1'/, 'the art box is not square');
    assert.match(box, /overflow: 'hidden'/, "'cover' would spill without this");
  });

  await t.test('the share button is positioned against the art, not the wrapper', () => {
    // Anchored to the wrapper it would float in the empty space below the
    // cover — which is what splitting these two elements risks getting wrong.
    const box = styleBlock('artBox');
    assert.match(box, /position: 'relative'/, 'artBox is not a positioning context');
    const wrap = styleBlock('artWrap');
    assert.ok(!/position: 'relative'/.test(wrap),
      'artWrap is still a positioning context, so the button anchors to the wrong box');
  });
});

test('the share button has two palettes and picks one from the art', async (t) => {
  const view = read(CLIENT_SRC, 'components', 'NowPlayingFullScreen.jsx');

  await t.test('both palettes exist', () => {
    assert.match(view, /shareOnArtDark: \{/);
    assert.match(view, /shareOnArtLight: \{/);
  });

  await t.test('they are actually opposites', () => {
    const dark = view.slice(view.indexOf('shareOnArtDark: {'), view.indexOf('shareOnArtLight: {'));
    const light = view.slice(view.indexOf('shareOnArtLight: {'));
    assert.match(dark, /color: '#fff'/);
    assert.match(light.slice(0, 200), /color: '#000'/);
  });

  await t.test('the button applies whichever the sample chose', () => {
    assert.match(view, /artCornerLight \? s\.shareOnArtDark : s\.shareOnArtLight/,
      'the palettes exist but nothing selects between them');
  });

  await t.test('a cover already in cache is still sampled', () => {
    // onLoad does not fire for an image the browser had cached before React
    // attached the handler, so the corner would never be read and the button
    // would keep the default on exactly the covers seen most often.
    assert.match(view, /if \(img && img\.complete\) measureArtCorner\(\)/,
      'a cached cover never gets sampled');
  });

  await t.test('a failed sample cannot break the screen', () => {
    const fn = view.slice(view.indexOf('const measureArtCorner'),
                          view.indexOf('useEffect', view.indexOf('const measureArtCorner')));
    assert.match(fn, /try \{/, 'getImageData is unguarded');
    assert.match(fn, /setArtCornerLight\(false\)/, 'the catch does not fall back to a palette');
  });
});

test('the MusicD mark is gone from the menu and settings, the name is not', async (t) => {
  const sidebar = fs.readFileSync(path.join(CLIENT_SRC, 'components', 'Sidebar.jsx'), 'utf8');
  const settings = fs.readFileSync(path.join(CLIENT_SRC, 'components', 'SettingsScreen.jsx'), 'utf8');

  await t.test('neither screen imports the icon any more', () => {
    for (const [name, src] of [['Sidebar', sidebar], ['SettingsScreen', settings]]) {
      assert.ok(!/md-icon/.test(src), `${name} still imports the mark`);
      assert.ok(!/mdIcon/.test(src), `${name} still references mdIcon`);
    }
  });

  await t.test('no dead style is left behind', () => {
    assert.ok(!/logoMark/.test(sidebar), 'Sidebar keeps an orphan logoMark style');
    assert.ok(!/brandIcon/.test(settings), 'SettingsScreen keeps an orphan brandIcon style');
  });

  await t.test('the wordmark stays', () => {
    // Removing the mark should not quietly remove the name with it.
    assert.match(sidebar, /Music<\/span><span style=\{s\.logoD\}>D/,
      'the MusicD wordmark went with the logo');
  });
});

test('the update screen keeps the action that still does something', async (t) => {
  const settings = read(CLIENT_SRC, 'components', 'SettingsScreen.jsx');

  await t.test('"Clear stuck update files" is gone', () => {
    // Its one purpose — a stale tar pinning findAvailableUpdate on an old
    // version — was removed twice over: v1.1.0.73 made the highest version win
    // regardless of source, and v1.1.2.8 made the check itself sweep stale
    // tars. All it had left was deleting downloads the user started on purpose.
    assert.ok(!/Clear stuck update files/.test(settings));
    assert.ok(!/clearStuckTars|clearingTars|clearTarsResult/.test(settings),
      'the button is gone but its handler and state are still here');
    assert.ok(!/clear-pending/.test(settings), 'the endpoint is still being called');
  });

  await t.test('the manifest re-check stays', () => {
    // The manifest is polled on a schedule; this is the only way to pick up a
    // release the moment it is published.
    assert.match(settings, /onClick=\{checkForUpdate\}/,
      'there is no way left to check for an update on demand');
  });

  await t.test('the automatic sweep that replaced it is still wired', () => {
    const route = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'routes', 'update.js'), 'utf8');
    assert.match(route, /clearPendingTars\(\{ staleOnly: true \}\)/,
      'the check no longer sweeps stale tars, so removing the button DID lose ' +
      'something — put it back or restore the sweep');
  });
});
