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
const {
  buildUpdaterScript, rollbackTagFor, updaterContainerName, LEGACY_UPDATER_CONTAINER,
} = require('../src/updater');

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

// The config-preservation section, actually executed.
//
// Everything above asserts on the TEXT of the generated script. That is not
// enough for this part: the first version passed the docker socket to
// `docker run` twice — once from the preserved mounts and once from the
// launch args — and reading the script did not make that obvious, because the
// two halves are forty lines apart. Running it does.
//
// The script is /bin/sh against a stub `docker` that answers the six inspect
// calls, so the real shell parses the real quoting with no daemon involved.
test('the preserved flags are what a real shell builds', async (t) => {
  const os = require('node:os');
  const { execFileSync } = require('node:child_process');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'musicd-updater-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);

  // Answers keyed off the --format string, the way the real docker would.
  fs.writeFileSync(path.join(bin, 'docker'), [
    '#!/bin/sh',
    'fmt=""',
    'for a in "$@"; do case "$a" in --format) next=1;; *) [ "$next" = 1 ] && { fmt="$a"; next=0; };; esac; done',
    'case "$fmt" in',
    '  *".Mounts"*)',
    '    [ "$NO_SOCK" = 1 ] || printf \'/var/run/docker.sock|/var/run/docker.sock|rw\\n\'',
    '    printf \'/var/lib/musicd-server-v1|/data|rw\\n\'',
    '    printf \'/music/lib|/music|ro\\n\'',
    '    ;;',
    '  *".Config.Env"*) printf \'PATH=/usr/bin\\nPORT=32700\\nDB_PATH=/data/musicd.db\\n\' ;;',
    '  *".NetworkMode"*) printf \'host\\n\' ;;',
    '  *".RestartPolicy.Name"*) printf \'unless-stopped\\n\' ;;',
    '  *".Devices"*) printf \'/dev/snd:/dev/snd \\n\' ;;',
    '  *".GroupAdd"*) printf \'29 \\n\' ;;',
    '  *) exit 0 ;;',
    'esac',
  ].join('\n'), { mode: 0o755 });

  // Slice out the preservation section and ask it what it built.
  const script = render({ name: NAME, image: IMAGE });
  const from = script.indexOf('ALL_FLAGS=""');
  const to = script.indexOf('echo "[updater] config preservation complete"');
  assert.ok(from !== -1 && to > from, 'could not locate the preservation section');
  const section = script.slice(from, to) + '\necho "FLAGS:$ALL_FLAGS"\n';
  const runner = path.join(dir, 'preserve.sh');
  fs.writeFileSync(runner, section);

  const run = (env) => execFileSync('sh', [runner], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env },
  });

  const SOCK = '/var/run/docker.sock:/var/run/docker.sock';
  const flagsOf = (out) => out.split('\n').find(l => l.startsWith('FLAGS:')).slice(6);
  const countOf = (hay, needle) => hay.split(needle).length - 1;

  await t.test('the docker socket is passed exactly once', () => {
    // THE regression. Twice is tolerated by some Docker versions and rejected
    // by others as a duplicate mount destination — and when it is rejected,
    // the rollback path runs the byte-identical command and is rejected too,
    // leaving the user with no container at all.
    //
    // Counting inside ALL_FLAGS alone is not enough, and the first version of
    // this check made exactly that mistake: the duplicate came from the LAUNCH
    // ARGS, which are concatenated onto ALL_FLAGS at the docker run line and
    // are nowhere near the preservation section. Putting the socket back in
    // launchArgsFor passed. So compose the whole command and count that.
    const flags = flagsOf(run({}));
    for (const line of script.split('\n').filter(l => l.includes('docker run -d'))) {
      const composed = line.replace('$ALL_FLAGS', flags);
      assert.equal(countOf(composed, SOCK), 1,
        `the socket appears ${countOf(composed, SOCK)} times in: ${composed.trim()}`);
    }
  });

  await t.test('an install without the socket still gets one', () => {
    // The new container has to be able to run its own future updates.
    const out = run({ NO_SOCK: '1' });
    assert.equal(countOf(flagsOf(out), `-v ${SOCK}`), 1, 'the socket was not added');
    assert.match(out, /docker socket was not mounted/, 'it was added silently');
  });

  await t.test('nothing the container had is dropped', () => {
    const flags = flagsOf(run({}));
    for (const expected of [
      '-v /var/lib/musicd-server-v1:/data',
      '-v /music/lib:/music:ro',          // the :ro flag has to survive
      '-e PORT=32700',
      '-e DB_PATH=/data/musicd.db',
      '--network host',
      '--restart unless-stopped',
      '--device /dev/snd:/dev/snd',       // USB DAC output dies without this
      '--group-add 29',                   // and without this
    ]) {
      assert.ok(flags.includes(expected), `${expected} was not preserved: ${flags}`);
    }
  });

  await t.test('docker-injected env vars are left behind', () => {
    // PATH and friends belong to the image, not to the user's configuration.
    assert.ok(!flagsOf(run({})).includes('-e PATH='), 'PATH was carried over');
  });

  await t.test('every preserved category is reported', () => {
    // The mount bug survived several releases because this log printed one
    // line and stopped: there was no way to tell "preserved nothing" from
    // "preserved everything" without asking the user to run docker inspect.
    const out = run({});
    for (const line of [
      /preserving mounts:/, /preserving env:/, /preserving network mode: host/,
      /preserving restart policy: unless-stopped/, /preserving devices: /,
      /preserving group-adds: 29/,
    ]) {
      assert.match(out, line, 'a preserved category is not reported in the log');
    }
  });

  fs.rmSync(dir, { recursive: true, force: true });
});

test('two installs on one host cannot destroy each other\'s update', async (t) => {
  // A host that took one of the broken pre-v1.1.10.0 updates ends up running
  // BOTH `musicd` and `musicd-server`: two servers, both polling the same
  // manifest, both holding the Docker socket, both entitled to start an
  // update. The sidecar used to be the fixed name `musicd-updater` and every
  // update began by force-removing it, so whichever moved second ripped away
  // the other's IN-FLIGHT sidecar. Land that between the victim's
  // `docker rm <container>` and its `docker run` and the machine is left with
  // no container at all, and nothing in the log to say why.

  await t.test('each install gets its own sidecar name', () => {
    assert.notEqual(updaterContainerName('musicd'), updaterContainerName('musicd-server'));
  });

  await t.test('the name is derived from the container being updated', () => {
    assert.equal(updaterContainerName('musicd-server'), 'musicd-updater-musicd-server');
    assert.equal(updaterContainerName('musicd'), 'musicd-updater-musicd');
  });

  await t.test('the result is always a legal Docker name', () => {
    // [a-zA-Z0-9][a-zA-Z0-9_.-]* — an illegal name fails the spawn, and the
    // container name comes from `docker inspect`, not from us.
    for (const raw of ['ok', 'has space', 'sl/ash', 'uni¢ode', 'semi;colon',
                       '', null, undefined, 'trailing-', '.dot']) {
      const name = updaterContainerName(raw);
      assert.match(name, /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/, `${String(raw)} -> ${name}`);
    }
  });

  await t.test('an unnamed container still gets the legacy name, not a bare suffix', () => {
    assert.equal(updaterContainerName(''), LEGACY_UPDATER_CONTAINER);
    assert.equal(updaterContainerName(null), LEGACY_UPDATER_CONTAINER);
  });

  await t.test('the legacy shared name is cleaned up, but never forcibly', () => {
    // Removing the old shared container is worth doing — it is debris on every
    // install that ever updated. Forcing it is not: if another musicd on this
    // host is mid-update under the old name, -f is precisely the bug. Plain
    // `docker rm` fails on a running container, which is the behaviour wanted.
    const src = SRC.replace(/\/\*[\s\S]*?\*\//g, '')
                   .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
    assert.match(src, /rmQuiet\(`docker rm \$\{LEGACY_UPDATER_CONTAINER\}/,
      'the legacy sidecar is not cleaned up at all');
    assert.ok(!/docker rm -f \$\{LEGACY_UPDATER_CONTAINER\}/.test(src),
      'the legacy sidecar is force-removed — that is the bug being fixed');
    assert.ok(!/docker rm -f musicd-updater(?![-`$])/.test(src),
      'a hardcoded force-remove of the shared name is back');
  });

  await t.test('the stuck-update hint names the container that exists', () => {
    // "run: docker logs musicd-updater" is useless advice if the sidecar is
    // called something else.
    assert.match(SRC, /docker logs \$\{updaterName\}/,
      'the log still tells the user to inspect a fixed container name');
  });
});
