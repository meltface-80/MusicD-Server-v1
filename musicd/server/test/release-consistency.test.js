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
