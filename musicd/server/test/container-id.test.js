// The updater's "which container am I?" lookup.
//
// Installing an update needs the host-side path of /mnt/musicd_updates,
// which is resolved by asking Docker about this container. Identifying the
// container by guessing went wrong three ways: the name "musicd" misses any
// install started with a different --name; /etc/hostname is the HOST's name
// under --network host, so it inspects something that is not a container;
// and the scan required a candidate to already have /mnt/musicd_updates,
// which is circular because that is the mount whose absence is being
// reported. The result was an error listing another container's mounts.
//
// _selfContainerId reads the id out of our own mount table instead. These
// pin the parsing against the shapes /proc actually takes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The function is deliberately not exported — it is an implementation
// detail of resolveHostMountPath — so it is lifted out of the source and
// evaluated against a stubbed fs. That keeps the module's surface honest
// while still testing the real code rather than a copy of it.
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'updater.js'), 'utf8');
const fnSrc = SRC.slice(SRC.indexOf('function _selfContainerId()'),
                        SRC.indexOf('function resolveHostMountPath'));
assert.ok(fnSrc.includes('mountinfo'), 'could not lift _selfContainerId out of updater.js');

function withProc(files) {
  const fakeFs = {
    readFileSync(p) {
      if (p in files) return files[p];
      const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e;
    },
  };
  return new Function('fs', fnSrc + '; return _selfContainerId;')(fakeFs);
}

const ID = 'a3f2c1d4e5b6a7980' + '9'.repeat(47);

test('reads the container id from /proc/self/mountinfo', () => {
  // Docker bind-mounts /etc/hostname, /etc/hosts and /etc/resolv.conf from
  // /var/lib/docker/containers/<id>/, so the id is in our own mount table
  // whatever the container is named and whatever network mode it uses.
  const f = withProc({
    '/proc/self/mountinfo':
      '1466 1443 0:78 / / rw,relatime - overlay overlay rw\n' +
      `1479 1466 254:1 /var/lib/docker/containers/${ID}/hostname /etc/hostname rw - ext4 /dev/vda1 rw\n`,
  });
  assert.equal(f(), ID);
});

test('falls back to cgroup v1', () => {
  const f = withProc({
    '/proc/self/mountinfo': '1466 1443 0:78 / / rw,relatime - overlay overlay rw\n',
    '/proc/self/cgroup': `12:memory:/docker/${ID}\n11:cpu:/docker/${ID}\n`,
  });
  assert.equal(f(), ID);
});

test("falls back to systemd's docker-<id>.scope", () => {
  const f = withProc({
    '/proc/self/mountinfo': '',
    '/proc/self/cgroup': `0::/system.slice/docker-${ID}.scope\n`,
  });
  assert.equal(f(), ID);
});

test('returns null rather than a bad guess outside a container', () => {
  // cgroup v2 on a plain host reports "0::/" and nothing else. Guessing
  // here is what produced mounts belonging to somebody else's container.
  const f = withProc({
    '/proc/self/mountinfo': '1466 1443 0:78 / / rw,relatime - ext4 /dev/vda1 rw\n',
    '/proc/self/cgroup': '0::/\n',
  });
  assert.equal(f(), null);
});

test('an unreadable /proc returns null instead of throwing', () => {
  assert.equal(withProc({})(), null);
});

test('the resolver no longer scans for the mount it is reporting missing', () => {
  // The circular scan could never help the install that lacks the mount.
  const scan = SRC.slice(SRC.indexOf('Method 3'), SRC.indexOf('if (result) {'));
  assert.ok(!/r\.map\['\/mnt\/musicd_updates'\]\s*\)\s*\{\s*result\s*=\s*r;\s*break/.test(scan),
    'the scan still requires the missing mount as its only match criterion');
  assert.ok(/looksLikeUs/.test(scan), 'the scan should match on marks a musicd actually has');
});
