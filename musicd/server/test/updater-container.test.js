// The updater must operate on the container it is actually running in.
//
// The generated update script hardcoded the container name `musicd` and the
// image `musicd:latest`, because install.sh always passes --name musicd.
// The README tells people to run `--name musicd-server` from an image built
// as `musicd-server`, and on those installs every line of the script missed:
//
//   docker inspect musicd --format '{{range .Mounts}}...'   -> empty
//   docker stop musicd / docker rm musicd                   -> no match
//   docker run -d --name musicd ... musicd:latest           -> a SECOND container
//
// So nothing was preserved (the log showed one mount, /var/run/docker.sock,
// which the script contributes itself), the old container kept running, and
// a new one came up beside it under --network host with no /data and no
// /music. The update reported success and the server stayed on its version.
//
// resolveHostMountPath already identifies this container from
// /proc/self/mountinfo without guessing; resolveSelfIdentity reads the name
// and image off that same lookup. These pin the result.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC_PATH = path.join(__dirname, '..', 'src', 'updater.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');
const { buildUpdaterScript, rollbackTagFor } = require('../src/updater');

// A name nothing in the source could match by accident, so a script that
// still carries a hardcoded identity fails rather than coincidentally
// agreeing with the fixture.
const NAME = 'zz-fixture-container';
const IMAGE = 'zz-fixture-image:9.9';

const render = (identity) => buildUpdaterScript(
  'musicd-v1-1-10-0.tar',
  '/host/var/lib/musicd-server-v1/updates/pending/musicd-v1-1-10-0.tar',
  '/var/lib/musicd-server-v1/updates',
  identity,
);

// Comments in the generated script explain the old hardcoded names, so the
// greps below run against the script's code only. A check that fires on the
// explanation of a bug is a check that gets ignored.
const codeOnly = (script) => script
  .split('\n')
  .filter((l) => !/^\s*#/.test(l))
  .join('\n');

test('the generated script targets the running container, not a guess', async (t) => {
  const script = codeOnly(render({ name: NAME, image: IMAGE }));

  await t.test('it declares the resolved container and image', () => {
    assert.match(script, new RegExp(`CONTAINER="${NAME}"`));
    assert.match(script, new RegExp(`IMAGE="${IMAGE.replace('.', '\\.')}"`));
    assert.match(script, /ROLLBACK_IMAGE="zz-fixture-image:rollback"/);
  });

  await t.test('every docker inspect reads that container', () => {
    const inspects = script.match(/docker inspect \S+/g) || [];
    assert.ok(inspects.length >= 6, `only ${inspects.length} inspects found`);
    for (const i of inspects) {
      assert.match(i, /docker inspect "\$CONTAINER"/, `hardcoded target: ${i}`);
    }
  });

  await t.test('stop and rm target that container', () => {
    for (const verb of ['stop', 'rm']) {
      const hits = script.match(new RegExp(`docker ${verb} \\S+`, 'g')) || [];
      assert.ok(hits.length > 0, `no docker ${verb} at all`);
      for (const h of hits) {
        assert.match(h, new RegExp(`docker ${verb} "\\$CONTAINER"`), `hardcoded: ${h}`);
      }
    }
  });

  await t.test('build, tag and run use that image', () => {
    assert.match(script, /docker build -t "\$IMAGE" \./);
    assert.match(script, /docker tag "\$IMAGE" "\$ROLLBACK_IMAGE"/);
    assert.match(script, /docker tag "\$ROLLBACK_IMAGE" "\$IMAGE"/);
    const runs = script.match(/docker run -d .*$/gm) || [];
    assert.ok(runs.length >= 1, 'no docker run');
    for (const r of runs) {
      // One of the three is wrapped as `if ! docker run ...; then`.
      const cmd = r.trimEnd().replace(/;\s*then$/, '').trimEnd();
      assert.ok(cmd.endsWith('"$IMAGE"'), `runs a hardcoded image: ${r}`);
      assert.match(r, new RegExp(`"--name" "${NAME}"`), `names a different container: ${r}`);
    }
  });

  await t.test('the name "musicd" appears nowhere as an identifier', () => {
    // /mnt/musicd_updates, the tarball name and `cd musicd` (the directory
    // inside the tar) are legitimate; a bare `musicd` or `musicd:tag` used
    // as a docker argument is the bug.
    const bad = script.match(/docker \S+ [^"'\s]*musicd(:[\w.-]+)?(\s|$)/g) || [];
    assert.deepEqual(bad, [], 'docker is still being handed a hardcoded name');
  });
});

test('it refuses to touch a container that is not there', () => {
  // Without this, a wrong name silently proceeds to build an image, start a
  // second container and leave the first running — which is what shipped.
  const script = render({ name: NAME, image: IMAGE });
  const guard = script.indexOf('if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then');
  assert.ok(guard !== -1, 'no existence check before the destructive section');

  const firstDestructive = Math.min(
    ...['docker stop "$CONTAINER"', 'docker rm "$CONTAINER"', 'docker build -t "$IMAGE"']
      .map((needle) => {
        const i = script.indexOf(needle);
        return i === -1 ? Number.MAX_SAFE_INTEGER : i;
      }));
  assert.ok(guard < firstDestructive,
    'the existence check runs after something destructive');
  assert.match(script.slice(guard, firstDestructive), /exit 1/,
    'the check does not actually abort');
});

test('a stock install.sh container is unaffected', () => {
  // install.sh really does use --name musicd; the fix must not break it.
  const script = codeOnly(render({ name: 'musicd', image: 'musicd:latest' }));
  assert.match(script, /CONTAINER="musicd"/);
  assert.match(script, /IMAGE="musicd:latest"/);
  assert.match(script, /ROLLBACK_IMAGE="musicd:rollback"/);
  assert.match(script, /"--name" "musicd"/);
});

test('rollbackTagFor', async (t) => {
  await t.test('replaces an existing tag', () => {
    assert.equal(rollbackTagFor('musicd:latest'), 'musicd:rollback');
    assert.equal(rollbackTagFor('musicd-server:latest'), 'musicd-server:rollback');
    assert.equal(rollbackTagFor('musicd-server:1.1.9.0'), 'musicd-server:rollback');
  });
  await t.test('adds one when there is none', () => {
    assert.equal(rollbackTagFor('musicd'), 'musicd:rollback');
    assert.equal(rollbackTagFor('ghcr.io/me/musicd'), 'ghcr.io/me/musicd:rollback');
  });
  await t.test('does not mistake a registry port for a tag', () => {
    // The colon in host:5000 is not a tag separator — the tag is only the
    // last colon-segment when that segment carries no slash.
    assert.equal(rollbackTagFor('reg.local:5000/musicd'), 'reg.local:5000/musicd:rollback');
    assert.equal(rollbackTagFor('reg.local:5000/musicd:v2'), 'reg.local:5000/musicd:rollback');
  });
});

test('the source carries no hardcoded docker target', () => {
  // The grep that would have caught this. Comments explain the old names,
  // so strip them first rather than matching the explanation.
  const code = SRC
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|#)/.test(l))
    .join('\n');
  const hits = code.match(/docker (inspect|stop|rm|build -t|tag) [^"'\s]*musicd/g) || [];
  assert.deepEqual(hits, [],
    'updater.js still hands docker a hardcoded musicd name: ' + hits.join(' | '));
});

test('resolveSelfIdentity falls back rather than returning a digest', () => {
  // Config.Image is normally what the user typed, but a container started
  // from a bare id reports sha256:... — `docker build -t sha256:...` is
  // meaningless. Lifted and driven against a stubbed cache, the way
  // container-id.test.js drives _selfContainerId, because the real one
  // needs a Docker daemon.
  const fnSrc = SRC.slice(SRC.indexOf('function resolveSelfIdentity()'),
                          SRC.indexOf('// `musicd-server:latest` ->'));
  assert.ok(fnSrc.includes('looksLikeDigest'), 'could not lift resolveSelfIdentity');

  const drive = (identity) => new Function(
    '_selfIdentity', 'resolveHostMountPath',
    fnSrc + '; return resolveSelfIdentity();',
  )(identity, () => null);

  assert.deepEqual(drive({ name: 'musicd-server', image: 'musicd-server:latest', resolved: true }),
    { name: 'musicd-server', image: 'musicd-server:latest', resolved: true });

  assert.deepEqual(drive({ name: 'musicd-server', image: 'sha256:' + 'a'.repeat(64), resolved: true }),
    { name: 'musicd-server', image: 'musicd-server:latest', resolved: true });

  assert.deepEqual(drive({ name: 'musicd-server', image: 'b'.repeat(64), resolved: true }),
    { name: 'musicd-server', image: 'musicd-server:latest', resolved: true });

  // Lookup failed entirely: keep the install.sh defaults so a stock
  // install still updates, and report that it was not resolved so the
  // script's existence check is the thing that stops a wrong guess.
  assert.deepEqual(drive({ name: null, image: null, resolved: false }),
    { name: 'musicd', image: 'musicd:latest', resolved: false });
});
