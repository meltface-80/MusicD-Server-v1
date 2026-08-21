// Release coherence: VERSION, both package.json files, install.sh, the
// manifest, and the tarball must all describe the same release.
//
// Two real failures motivate this. install.sh sat a whole release behind —
// it still declared EXPECTED_VERSION 1.1.3.6 after 1.1.3.7 shipped, so the
// published installer downloaded the wrong tar and then refused it for
// failing its own version check. release.sh rewrites whichever version
// string it finds, so once install.sh drifted the sed matched nothing and
// the bump silently no-op'd. Separately, the manifest's accessTiers block
// is what the four unlock codes validate against; drop it and every code
// stops working with a 503.
//
// The tarball is checked by hash, not by name, because it is rebuilt after
// the last source edit — including CHANGELOG edits, since the changelog is
// inside it — and a stale hash means the updater rejects the download.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MUSICD = path.join(__dirname, '..', '..');
const ROOT = path.join(MUSICD, '..');

const version = fs.readFileSync(path.join(MUSICD, 'VERSION'), 'utf8').trim();
const dashed = version.replace(/\./g, '-');
const pkgVersion = version.split('.').slice(1).join('.');   // 1.1.9.0 -> 1.9.0
const installSh = fs.readFileSync(path.join(MUSICD, 'install.sh'), 'utf8');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

test('VERSION is the canonical four-part form', () => {
  assert.match(version, /^\d+\.\d+\.\d+\.\d+$/, `VERSION reads "${version}"`);
});

test('every file that carries a version agrees with VERSION', async (t) => {
  await t.test('server/package.json', () => {
    assert.equal(readJson(path.join(MUSICD, 'server', 'package.json')).version, pkgVersion);
  });
  await t.test('client/package.json', () => {
    assert.equal(readJson(path.join(MUSICD, 'client', 'package.json')).version, pkgVersion);
  });
  await t.test('install.sh EXPECTED_VERSION', () => {
    assert.ok(installSh.includes(`EXPECTED_VERSION="${version}"`),
      'install.sh is out of step — release.sh\'s sed will have matched nothing');
  });
  await t.test('install.sh TAR_FILENAME', () => {
    assert.ok(installSh.includes(`TAR_FILENAME="musicd-v${dashed}.tar"`),
      'the installer would fetch a different release than it checks for');
  });
  await t.test('install.sh header comment', () => {
    assert.ok(installSh.includes(`musicd installer -- v${version}`));
  });
});

// The two PUBLISHED faces of a release: the repo's front page and the GitHub
// Pages site. Both sat seven releases behind — still announcing v1.1.20.0
// after v1.1.27.0 shipped — because release.sh did not touch them and nothing
// here checked them. The script rewrites them now; these are what stop it
// silently matching nothing, the same failure install.sh had.
//
// Each pattern below is anchored to a phrase only the CURRENT release uses.
// Both files also talk about v1.1.3.7 and v1.1.9.0 in upgrade notes, and those
// are history: a check that simply banned old version strings would force
// those to be falsified at every release.
test('the repo front page announces this release', async (t) => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

  await t.test('the current-release line', () => {
    assert.ok(readme.includes(`**Current release:** v${version}`),
      `README.md still announces a different release than VERSION (${version})`);
  });

  await t.test('the repository-layout table', () => {
    assert.ok(readme.includes(`(React/Vite), v${version}`),
      'the layout table names a different version');
    assert.ok(readme.includes(`musicd-v${dashed}.tar`),
      'the layout table names a different tarball');
  });

  await t.test('and it names no OTHER release tarball', () => {
    // The tarball is renamed every release and only one exists at a time. A
    // second name in here is a line release.sh's sed did not reach.
    const named = [...new Set([...readme.matchAll(/musicd-v(\d+-\d+-\d+-\d+)\.tar/g)]
      .map(m => m[1]))];
    assert.deepEqual(named, [dashed],
      `README.md names tarballs that do not exist: ${named.join(', ')}`);
  });

  await t.test('the upgrade note points at this release', () => {
    // The sentence wraps in the source, so the needle stops at the line break:
    // "…and it\nis over — v1.1.27.0 has…". release.sh's sed is anchored the
    // same way, and was not, which is how this assertion found it.
    assert.ok(readme.includes(`is over — v${version} has`), 'stale version in the upgrade note');
    assert.ok(readme.includes(`so it will offer v${version} and`), 'stale version in the upgrade note');
  });
});

test('the GitHub Pages site announces this release', async (t) => {
  const docs = fs.readFileSync(path.join(ROOT, 'docs', 'index.html'), 'utf8');

  await t.test('the header badge', () => {
    assert.ok(docs.includes(`<span class="badge">v${version}</span>`),
      `docs/index.html's badge still reads a different version than VERSION (${version})`);
  });

  await t.test('the meta description and the footer', () => {
    // Two separate sites' worth of stale text used to hide here: the <meta>
    // is what search results and link previews show.
    assert.equal((docs.match(new RegExp(`MusicD Server v${version.replace(/\./g, '\\.')}`, 'g')) || []).length, 2,
      'the meta description and the footer must both name this release');
  });

  await t.test("the What's-new heading", () => {
    assert.ok(docs.includes(`What&rsquo;s new in ${version}`),
      "the What's-new heading names a different release");
  });

  await t.test('and there is something under it', () => {
    // The heading is bumped by release.sh; the cards are written by hand. A
    // heading that says the new version over the last one's cards is worse
    // than a stale heading, because it reads as current.
    const at = docs.indexOf(`What&rsquo;s new in ${version}`);
    const end = docs.indexOf('</section>', at);
    const section = docs.slice(at, end);
    const cards = section.split('<div class="card new">').length - 1;
    assert.ok(cards >= 3, `the What's-new section has ${cards} card(s)`);
    // Every card carries a heading and at least one paragraph: a card whose
    // markup broke would swallow its siblings and shorten the page silently.
    for (const card of section.split('<div class="card new">').slice(1)) {
      assert.match(card, /<h3\b/, 'a What\'s-new card has no heading');
      assert.match(card, /<p>/, 'a What\'s-new card has no text');
    }
  });

  await t.test('no earlier release is still described as the current one', () => {
    // The four anchors above are what release.sh rewrites. This catches the
    // shape of the original failure — one of them bumped, another missed —
    // by insisting the PREVIOUS release appears at none of them.
    const changelog = fs.readFileSync(path.join(MUSICD, 'CHANGELOG.md'), 'utf8');
    const versions = [...changelog.matchAll(/^## v(\d+\.\d+\.\d+\.\d+)/gm)].map(m => m[1]);
    const previous = versions.find(v => v !== version);
    if (!previous) return;   // first release; nothing to be stale against
    for (const anchor of [
      `<span class="badge">v${previous}</span>`,
      `MusicD Server v${previous}`,
      `What&rsquo;s new in ${previous}`,
    ]) {
      assert.ok(!docs.includes(anchor),
        `docs/index.html still carries "${anchor}" from the previous release`);
    }
  });
});

// release.sh's seds are anchored to exact phrases, so a file that drifts makes
// the pattern match NOTHING and the bump silently no-op — which is how
// install.sh shipped a whole release behind. The script has a verify step for
// exactly that, and this runs it: a throwaway tree carrying only the files it
// edits, bumped to a version nothing else uses, checked for a clean pass.
//
// Running it is the point. Reading the script would only prove the patterns
// are written down, not that they still match what is in the files.
test('release.sh can still bump every file it claims to', () => {
  const os = require('node:os');
  const { execFileSync } = require('node:child_process');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'musicd-release-'));
  const put = (rel, from) => {
    const dest = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(from, dest);
  };
  try {
    // Only the files the script reads or writes — copying musicd/ wholesale
    // would drag both node_modules trees along.
    put('musicd/VERSION',              path.join(MUSICD, 'VERSION'));
    put('musicd/install.sh',           path.join(MUSICD, 'install.sh'));
    put('musicd/server/package.json',  path.join(MUSICD, 'server', 'package.json'));
    put('musicd/client/package.json',  path.join(MUSICD, 'client', 'package.json'));
    put('musicd/scripts/release.sh',   path.join(MUSICD, 'scripts', 'release.sh'));
    put('README.md',                   path.join(ROOT, 'README.md'));
    put('docs/index.html',             path.join(ROOT, 'docs', 'index.html'));
    fs.chmodSync(path.join(tmp, 'musicd/scripts/release.sh'), 0o755);

    const out = execFileSync('bash', ['./scripts/release.sh', '9.9.9.9', '--apply'],
      { cwd: path.join(tmp, 'musicd'), encoding: 'utf8' });

    assert.ok(!out.includes('✗'),
      'release.sh reported a pattern that matched nothing:\n' + out);
    // The verify LIST as well as its result: a check quietly dropped from the
    // script still leaves a clean run, and the next file to drift would then
    // go unreported to whoever is running it.
    for (const label of ['README.md current release', 'README.md tarball name',
                         'docs/index.html badge', 'docs/index.html version',
                         "docs/index.html What's new heading"]) {
      assert.ok(out.includes(`✓ ${label}`),
        `release.sh no longer verifies "${label}":\n` + out);
    }
    // Every file it names must actually carry the new version afterwards.
    const readme = fs.readFileSync(path.join(tmp, 'README.md'), 'utf8');
    const docs = fs.readFileSync(path.join(tmp, 'docs', 'index.html'), 'utf8');
    assert.ok(readme.includes('**Current release:** v9.9.9.9'), 'README.md was not bumped');
    assert.ok(readme.includes('musicd-v9-9-9-9.tar'), 'the README tarball name was not bumped');
    assert.ok(docs.includes('<span class="badge">v9.9.9.9</span>'), 'the docs badge was not bumped');
    assert.ok(docs.includes('What&rsquo;s new in 9.9.9.9'), "the docs What's-new heading was not bumped");
    assert.equal((docs.match(/MusicD Server v9\.9\.9\.9/g) || []).length, 2,
      'the docs meta description and footer were not both bumped');
    // And nothing of the release it started from is left at those anchors.
    for (const stale of [`**Current release:** v${version}`, `musicd-v${dashed}.tar`]) {
      assert.ok(!readme.includes(stale), `README.md still carries "${stale}"`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the CHANGELOG documents this release', () => {
  const log = fs.readFileSync(path.join(MUSICD, 'CHANGELOG.md'), 'utf8');
  assert.ok(log.includes(`## v${version}`), `no entry for v${version}`);
});

// The manifest and tarball live at the repo root, one level above musicd/.
// A source checkout without them is still a valid tree to run tests in, so
// these skip rather than fail when the release artefacts are absent.
const manifestPath = path.join(ROOT, 'manifest.json');
const haveRelease = fs.existsSync(manifestPath);

test('the update manifest describes this release', { skip: !haveRelease && 'no manifest.json' },
  async (t) => {
    const m = readJson(manifestPath);
    const tarName = `musicd-v${dashed}.tar`;

    await t.test('top-level version matches VERSION', () => {
      assert.equal(m.version, version);
    });
    await t.test('top-level tarUrl points at this release', () => {
      assert.ok(m.tarUrl.endsWith(tarName), `tarUrl is ${m.tarUrl}`);
    });
    await t.test('every channel matches too', () => {
      // A channel left on an older version silently pins anyone on it.
      for (const [name, ch] of Object.entries(m.channels || {})) {
        assert.equal(ch.version, version, `channel ${name} is on ${ch.version}`);
        assert.ok(ch.tarUrl.endsWith(tarName), `channel ${name} points elsewhere`);
      }
    });
    await t.test('the legacy top-level pair is still present', () => {
      // Carried so a pre-v1.1.1.3 server can read this file; it is what
      // lets an old install take the update that moves it to GitHub.
      assert.equal(typeof m.version, 'string');
      assert.equal(typeof m.tarUrl, 'string');
    });
  });

test('the manifest carries the access tiers', { skip: !haveRelease && 'no manifest.json' },
  async (t) => {
    const m = readJson(manifestPath);
    const tiers = m.accessTiers;

    await t.test('the block exists', () => {
      assert.ok(tiers, 'without it POST /api/update/tier/code answers 503 ' +
        'and all four unlock codes stop working');
    });
    await t.test('each code-bearing tier has a well-formed hash', () => {
      for (const name of ['stable', 'earlyAccess', 'beta', 'alpha']) {
        assert.ok(tiers[name], `tier ${name} is missing`);
        assert.match(tiers[name].codeHash, /^[0-9a-f]{64}$/,
          `tier ${name} has no usable codeHash`);
      }
    });
    await t.test('the hashes are the ones the server computes', () => {
      // Recomputed from tierConfig's own salt, so a manifest edit that
      // breaks the codes fails here rather than on a user's device.
      const { hashCode } = require('../src/tierConfig');
      for (const [name, code] of Object.entries({
        stable: '7733', earlyAccess: '9632', beta: '4261', alpha: '8417',
      })) {
        assert.equal(tiers[name].codeHash, hashCode(code),
          `tier ${name} no longer accepts its documented code`);
      }
    });
  });

test('the published tarball matches its manifest hash',
  { skip: !haveRelease && 'no manifest.json' }, () => {
    const m = readJson(manifestPath);
    const tar = path.join(ROOT, `musicd-v${dashed}.tar`);
    if (!fs.existsSync(tar)) {
      assert.fail(`manifest names musicd-v${dashed}.tar but it is not in the repo`);
    }
    if (!m.tarSha256) return;   // null means "no hash published", which is allowed
    const actual = crypto.createHash('sha256').update(fs.readFileSync(tar)).digest('hex');
    assert.equal(m.tarSha256, actual,
      'the tar was rebuilt after the hash was written, or vice versa — ' +
      'the updater will refuse this download');
    if (m.tarball_sha256) assert.equal(m.tarball_sha256, actual, 'the two spellings disagree');
  });

test('the updates bind mount is documented everywhere it must be', async (t) => {
  // In-app updates install via a sidecar container that reads the staged
  // tarball from the HOST side, so this must be a real bind mount. Dropping
  // it from any one of these leaves an install that downloads and then
  // cannot install.
  const MOUNT = '/mnt/musicd_updates';
  const files = {
    'README.md': path.join(ROOT, 'README.md'),
    'docs/index.html': path.join(ROOT, 'docs', 'index.html'),
    'docker-compose.yml': path.join(MUSICD, 'docker-compose.yml'),
  };
  for (const [label, p] of Object.entries(files)) {
    await t.test(`${label} mounts ${MOUNT}`, { skip: !fs.existsSync(p) && 'absent' }, () => {
      const body = fs.readFileSync(p, 'utf8');
      assert.ok(body.includes(MOUNT), `${label} no longer mentions ${MOUNT}`);
      assert.match(body, /updates:\/mnt\/musicd_updates/,
        `${label} does not bind a host path to ${MOUNT}`);
    });
  }
});
