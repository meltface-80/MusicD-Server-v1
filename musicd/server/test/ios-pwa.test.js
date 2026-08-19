// The iOS home-screen layout contract. This broke three times.
//
// Device behaviour cannot be observed from CI or from a headless browser —
// no browser chrome, no safe areas — so there is nothing to assert about
// what the phone actually draws. What CAN be done is pin the known-good
// configuration so it is not changed silently, which is what these do.
// MusicD-Remote's suite takes the same approach for the same reason.
//
// The failure being guarded: `apple-mobile-web-app-status-bar-style:
// black-translucent` shifts the document up under the status bar WITHOUT
// growing the layout viewport, leaving a gap at the bottom the size of the
// TOP inset (44-62px, not the 34px of a home indicator) and pushing the top
// controls out of reach. `apple-mobile-web-app-capable` opts into the legacy
// path where that style governs the window. A linked manifest makes iOS 17+
// letterbox the app instead of letting viewport-fit=cover fill it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CLIENT = path.join(__dirname, '..', '..', 'client');
const indexHtml = fs.readFileSync(path.join(CLIENT, 'index.html'), 'utf8');
const appJsx = fs.readFileSync(path.join(CLIENT, 'src', 'App.jsx'), 'utf8');
const indexCss = fs.readFileSync(path.join(CLIENT, 'src', 'index.css'), 'utf8');

test('index.html head', async (t) => {
  await t.test('carries exactly one viewport meta', () => {
    // A second one silently overrides the first and zeroes every inset.
    const n = (indexHtml.match(/<meta[^>]*name="viewport"/g) || []).length;
    assert.equal(n, 1, `found ${n} viewport metas`);
  });

  await t.test('the viewport opts into viewport-fit=cover', () => {
    const m = indexHtml.match(/<meta[^>]*name="viewport"[^>]*>/);
    assert.ok(m, 'no viewport meta at all');
    assert.match(m[0], /viewport-fit=cover/,
      'without this every env(safe-area-inset-*) resolves to 0 on iOS');
  });

  for (const name of [
    'apple-mobile-web-app-capable',
    'mobile-web-app-capable',
    'apple-mobile-web-app-status-bar-style',
  ]) {
    await t.test(`does not carry ${name}`, () => {
      // Match the TAG, not the word: index.html names these in a comment
      // explaining why they are absent, and a bare word-grep would fire on
      // that. A check that cries wolf gets ignored, which is how a real one
      // gets waved through.
      const re = new RegExp(`<meta[^>]*name="${name}"`, 'i');
      assert.ok(!re.test(indexHtml),
        `${name} is back — it stops the app filling the screen on iOS`);
    });
  }

  await t.test('does not link a web manifest', () => {
    assert.ok(!/<link[^>]*rel="manifest"/i.test(indexHtml),
      'iOS 17+ reads it and letterboxes the app; public/manifest.webmanifest ' +
      'is kept unlinked so it can be restored once verified on hardware');
  });

  await t.test('the unlinked manifest is still in the tree', () => {
    assert.ok(fs.existsSync(path.join(CLIENT, 'public', 'manifest.webmanifest')),
      'kept deliberately so the PWA install path can be restored');
  });
});

test('safe-area insets belong to screens, never to the app shell', async (t) => {
  // Padding the root grid reserves a visible band on EVERY screen — that
  // was the regression, and it is invisible from a headless harness.
  const root = appJsx.match(/^\s*root:\s*\{[^}]*\}/m);

  await t.test("App.jsx's root grid has no inset padding", () => {
    assert.ok(root, 'could not find the root style');
    assert.ok(!/safe-area-inset|--safe-(top|bot)/.test(root[0]),
      'the app shell is padding itself: ' + root[0].trim());
  });

  await t.test('the shell measures in %, not viewport units', () => {
    // Under viewport-fit=cover the viewport units and the physical display
    // disagree about whether the safe areas are included.
    assert.match(root[0], /height:\s*'100%'/,
      'root should be height:100% of #root, not a viewport unit');
    assert.ok(!/100vh/.test(root[0]), 'root is using 100vh');
  });

  await t.test('index.css defines the inset variables once', () => {
    for (const v of ['--safe-top', '--safe-bot']) {
      assert.ok(indexCss.includes(`${v}:`), `${v} is not defined`);
    }
    assert.match(indexCss, /--safe-top:\s*env\(safe-area-inset-top/);
    assert.match(indexCss, /--safe-bot:\s*env\(safe-area-inset-bottom/);
  });

  await t.test('html, body and #root are height:100%', () => {
    assert.match(indexCss, /html,\s*body,\s*#root\s*\{[^}]*height:\s*100%/,
      'the shell relies on a fixed-height ancestor chain');
  });
});

test('screens actually use the insets', () => {
  // Not an exhaustive per-screen assertion — that would be a list to forget
  // to update. This just proves the mechanism is wired to more than one
  // surface, so a wholesale revert is visible.
  const dir = path.join(CLIENT, 'src', 'components');
  const users = fs.readdirSync(dir)
    .filter(f => f.endsWith('.jsx'))
    .filter(f => /var\(--safe-(top|bot)\)/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
  assert.ok(users.length >= 8,
    `only ${users.length} screens pad themselves; the insets have been stripped`);
});
