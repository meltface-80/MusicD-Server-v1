// Getting the bug report off the phone.
//
// The report screen said "Your browser doesn't support sharing files directly"
// and told the user to go and find the JSON on the server. Both halves were
// wrong. Safari on iOS shares files perfectly well; what it will not do is
// expose the API on an insecure origin — and MusicD is served over plain HTTP
// on a LAN address, so it is not one.
//
// The same gating is why "Copy as text" threw
// "undefined is not an object (evaluating 'navigator.clipboard.writeText')":
// navigator.clipboard is withheld on exactly the same terms. One cause, two
// visible failures, neither of them the browser's fault and neither fixed by
// switching browsers.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const CLIENT_SRC = path.join(__dirname, '..', '..', 'client', 'src');
const SERVER_SRC = path.join(__dirname, '..', 'src');
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// A navigator that can share files, one that exposes share but refuses files,
// and one with nothing at all.
const probe = () => ({ name: 'probe.txt' });
const navFull = { share: () => {}, canShare: () => true };
const navNoFiles = { share: () => {}, canShare: () => false };
const navThrows = { share: () => {}, canShare: () => { throw new Error('nope') } };

test('the screen says which of the two problems it actually has', async (t) => {
  const { classifyShare, SHARE_FILES, SHARE_INSECURE, SHARE_UNSUPPORTED } =
    await import(pathToFileURL(path.join(CLIENT_SRC, 'bugReportShare.js')).href);

  await t.test('a secure origin that can attach files gets the good path', () => {
    assert.equal(classifyShare(navFull, true, probe), SHARE_FILES);
  });

  await t.test('the LAN install is diagnosed as the origin, not the browser', () => {
    // THE bug. On http://192.168.x.x:32700 navigator.share is undefined, and
    // the old code read that as "this browser cannot" and sent the user to go
    // and find a file on the server.
    assert.equal(classifyShare({}, false, probe), SHARE_INSECURE);
    assert.equal(classifyShare(undefined, false, probe), SHARE_INSECURE);
    assert.equal(classifyShare(null, false, probe), SHARE_INSECURE);
  });

  await t.test('a secure origin genuinely without the API says so instead', () => {
    // Desktop Firefox, for one. Blaming the origin there would be as wrong as
    // blaming the browser on a LAN install.
    assert.equal(classifyShare({}, true, probe), SHARE_UNSUPPORTED);
    assert.equal(classifyShare(navNoFiles, true, probe), SHARE_UNSUPPORTED);
  });

  await t.test('share() present but files refused is still not a file path', () => {
    assert.equal(classifyShare(navNoFiles, false, probe), SHARE_INSECURE);
    assert.equal(classifyShare(navNoFiles, true, probe), SHARE_UNSUPPORTED);
  });

  await t.test('a probe that throws does not take the screen down with it', () => {
    assert.equal(classifyShare(navThrows, true, probe), SHARE_UNSUPPORTED);
    assert.equal(classifyShare(navThrows, false, probe), SHARE_INSECURE);
  });

  await t.test('a half-present API is not mistaken for a whole one', () => {
    assert.equal(classifyShare({ share: () => {} }, true, probe), SHARE_UNSUPPORTED);
    assert.equal(classifyShare({ canShare: () => true }, true, probe), SHARE_UNSUPPORTED);
    assert.equal(classifyShare({ share: 'yes', canShare: 'yes' }, true, probe), SHARE_UNSUPPORTED);
  });
});

test('the copy button works on the origin that needs it most', async (t) => {
  const { hasAsyncClipboard } = await import(
    pathToFileURL(path.join(CLIENT_SRC, 'bugReportShare.js')).href);

  await t.test('it detects the async clipboard when there is one', () => {
    assert.equal(hasAsyncClipboard({ clipboard: { writeText: () => {} } }), true);
  });

  await t.test('it does not reach into an absent clipboard', () => {
    // This is the exact throw from the screenshot: navigator.clipboard is
    // undefined on an insecure origin, and the old code dereferenced it.
    for (const nav of [undefined, null, {}, { clipboard: null }, { clipboard: {} },
                       { clipboard: { writeText: 'not a function' } }]) {
      assert.equal(hasAsyncClipboard(nav), false, `${JSON.stringify(nav)} passed`);
    }
  });

  await t.test('the component has a fallback for when it is absent', () => {
    const src = code(fs.readFileSync(
      path.join(CLIENT_SRC, 'components', 'SettingsScreen.jsx'), 'utf8'));
    assert.match(src, /hasAsyncClipboard\(navigator\)/,
      'the clipboard is still dereferenced without checking');
    assert.match(src, /document\.execCommand\('copy'\)/,
      'there is no fallback for an insecure origin, so Copy still fails there');
    assert.match(src, /setSelectionRange\(0, text\.length\)/,
      'iOS ignores select() on its own, so the copy would silently copy nothing');
  });
});

test('the saved report can be pulled onto the device', async (t) => {
  const { reportDownloadUrl } = await import(
    pathToFileURL(path.join(CLIENT_SRC, 'bugReportShare.js')).href);

  await t.test('it points at the endpoint that already exists', () => {
    assert.equal(reportDownloadUrl('2026-08-19T20-38-09-129Z-m01rt8.json'),
      '/api/bug-report/file/2026-08-19T20-38-09-129Z-m01rt8.json');
  });

  await t.test('the server serves it as an attachment', () => {
    // res.download() sets Content-Disposition: attachment, which is what makes
    // iOS put it in Files rather than rendering it in a tab.
    const route = fs.readFileSync(path.join(SERVER_SRC, 'routes', 'bugReport.js'), 'utf8');
    assert.match(route, /router\.get\('\/file\/:name'/, 'the download route is gone');
    assert.match(route, /res\.download\(full\)/,
      'the route no longer sends the report as an attachment');
  });

  await t.test('the client rejects exactly what the server would', () => {
    // A name the server's own guard refuses must not be turned into a URL that
    // 400s after the user has tapped the button.
    const serverGuard = /^[\w\-:.]+\.json$/;
    for (const name of ['../../etc/passwd', 'report.json/../x', 'no-extension',
                        'report.txt', '', null, undefined, 'a b.json', 'x/y.json']) {
      assert.equal(reportDownloadUrl(name), null, `${String(name)} produced a URL`);
      if (typeof name === 'string') {
        assert.ok(!serverGuard.test(name),
          `${name} is accepted by the server but rejected here — the two guards disagree`);
      }
    }
  });

  await t.test('a legal name the server accepts is not rejected here', () => {
    for (const name of ['a.json', '2026-08-19T20-38-09-129Z-m01rt8.json', 'A_b-c.d.json']) {
      assert.ok(/^[\w\-:.]+\.json$/.test(name), 'fixture is not server-legal');
      assert.ok(reportDownloadUrl(name), `${name} was rejected by the client`);
    }
  });
});

test('the screen no longer sends the user to the server for the file', async (t) => {
  const src = fs.readFileSync(
    path.join(CLIENT_SRC, 'components', 'SettingsScreen.jsx'), 'utf8');

  await t.test('the misdiagnosis is gone', () => {
    assert.ok(!/Your browser doesn't support sharing files directly/.test(src),
      'the screen still blames the browser for a secure-context restriction');
    assert.ok(!/ask the developer for/.test(src),
      'the screen still tells the user to go and find the file on their box');
  });

  await t.test('there is a button that fetches the report', () => {
    assert.match(src, /onClick=\{downloadReport\}/, 'no way to get the file');
    assert.match(src, /Save report file/, 'the download button has no label');
  });

  await t.test('it explains where the file lands', () => {
    // "Downloaded" is useless on iOS without saying where it went.
    assert.match(src, /Files\s*→\s*Downloads/,
      'the user is not told where to find what they just downloaded');
  });

  await t.test('the success line does not promise an attachment it did not make', () => {
    // The mailto: path cannot carry one, and saying otherwise is how a report
    // arrives with nothing attached and nobody noticing.
    assert.match(src, /canShareFiles\s*\n?\s*\?\s*'Thanks — your mail app should be open with the report attached\.'/,
      'the confirmation no longer distinguishes the attach path from the summary path');
  });
});
