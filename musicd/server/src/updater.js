/**
 * Auto-update — detects new musicd-vX-Y-Z-W.tar files and applies them.
 *
 * Tars come from one of two places:
 *   • Local watch folder (/mnt/downloads): the dev workflow — drop a tar
 *     onto the host and the running musicd picks it up
 *   • Remote pending dir (/mnt/musicd_updates/pending): downloaded by
 *     remoteUpdater from the configured manifest URL. Lives here rather
 *     than in the watch folder because /mnt/downloads is sometimes
 *     mounted :ro (#30.8 — earlier remote downloads failed with EROFS).
 *
 * Apply pipeline (runs inside an ephemeral alpine container we spawn via
 * the docker socket — the running musicd can't outlive its own docker
 * stop):
 *   1. Tag current image as <image>:rollback
 *   2. Extract tar to a working dir on the host
 *   3. docker build a new <image> image
 *   4. docker stop / rm the running container
 *      (<image> and the container name are read off THIS container at
 *       generation time — see resolveSelfIdentity)
 *   5. docker run the new container with preserved launch flags
 *   6. If build fails, retag rollback → latest and restart from rollback
 *   7. Move consumed tar to /mnt/dietpi_userdata/musicd_updates
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const version = require('./version');

// DOWNLOADS_DIR resolves differently per orchestrator (#v1.1.0.48).
// Docker mode: /mnt/downloads -> /var/lib/musicd/downloads on host.
// Native mode: /var/lib/musicd/downloads directly.
const DOWNLOADS_DIR = (() => {
  // Lazy require to avoid load-order issues at module-eval time.
  try {
    const orch = require('./orchestrator');
    if (orch.mode() === 'systemd') return '/var/lib/musicd/downloads';
  } catch { /* orchestrator missing -- shouldn't happen, default to docker layout */ }
  return '/mnt/downloads';
})();
const UPDATES_DIR   = '/mnt/musicd_updates';

// v1.1.2.5 — host-side path resolution.
// =====================================
// The in-container path /mnt/musicd_updates is always the same because
// it's set by LAUNCH_ARGS / install.sh. But the HOST-side path that the
// updater container needs to read from depends on how install.sh was
// invoked. Different installs have used different host paths over time:
//
//   /mnt/dietpi_userdata/musicd_updates  (DietPi default, all installs
//                                         pre-v1.1.0.11 and many later ones)
//   /var/lib/musicd/updates              (v1.1.0.11+ migration target)
//
// The updater spawns an alpine container that bind-mounts the host root
// at /host and reads /host/<host-path>/update.sh. Hardcoding the host
// path means it only works on installs that match the hardcoded value.
// v1.1.2.4 and earlier hardcoded /var/lib/musicd/updates, which broke
// any install that didn't migrate (e.g. fresh installs done after
// v1.1.0.11 if install.sh still pointed at the legacy DietPi paths).
//
// The fix: look up the actual host-side path of /mnt/musicd_updates by
// asking docker about the running musicd container's bind mounts. The
// musicd container already has the docker socket, so this works without
// needing any extra plumbing from install.sh.
//
// resolveHostMountPath(containerPath) returns the host path that the
// running container has bind-mounted to containerPath, or null if no
// such mount exists. Cached after first call (mounts don't change).
//
// v1.1.2.7: rewritten because v1.1.2.5's approach was broken in real
// installs. The original code tried to identify "this" container by:
//   1. Reading /proc/self/cgroup — fails on cgroup v2 (returns "0::/")
//   2. Falling back to /etc/hostname — fails when --hostname is set
//      (e.g. on DietPi, hostname is inherited and reads "DietPi", not
//      the container ID).
// When both fail, `docker inspect` is called with an invalid identifier,
// throws, and the resolver returns an empty mount map for everything.
//
// New strategy: try several identifiers in order of reliability.
//   1. Container name "musicd" — install.sh always uses --name musicd.
//      Reliable for any standard install. (Most cases hit this.)
//   2. /etc/hostname's value, but treated as a possible container ID
//      not as the literal hostname. Inspect will also accept hex IDs.
//   3. Search all containers for one whose Destinations include the
//      query path. Catches non-standard container names.
// The first method that yields a valid mount map for `containerPath`
// wins. We log which method succeeded for diagnostics.
//
// v1.1.7.0: all three of those are guesses, and the guessing showed. A
// container started with a different --name misses (1); --network host
// makes /etc/hostname the HOST's name, so (2) inspects something that
// isn't a container; and (3) only accepted a candidate that already had
// /mnt/musicd_updates — circular, because that is precisely the mount
// whose absence it is trying to explain. An install missing that mount
// therefore got a mount map belonging to some other container, and an
// error listing mounts the user had never configured.
//
// So a method that does not guess now runs first: read our own container
// id out of /proc/self/mountinfo (see _selfContainerId). v1.1.2.5 tried
// /proc/self/cgroup and /etc/hostname and was right that both are
// unreliable — but mountinfo is neither. Docker bind-mounts
// /etc/hostname, /etc/hosts and /etc/resolv.conf from
// /var/lib/docker/containers/<id>/, so the id is in our own mount table
// regardless of container name or network mode. cgroup is kept only as
// a second-choice fallback, and (3) now matches on marks a musicd
// actually has rather than the one it is missing.
let _hostMountCache = null;
let _hostMountCacheSource = null;
// The running container's own name and image, learned from the same
// inspect that resolves the mounts. Both are needed by the updater
// script, which must stop, remove and re-create THIS container.
let _selfIdentity = null;
// v1.1.7.0 — our own container id, straight from the kernel.
//
// /proc/self/mountinfo lists the files Docker bind-mounts in from
// /var/lib/docker/containers/<id>/, so the id is in our own mount table
// whatever the container is named and whatever network mode it uses.
// /proc/self/cgroup is the fallback: it carries the id under cgroup v1,
// but frequently just "0::/" under v2.
function _selfContainerId() {
  const ID = /[0-9a-f]{64}/;
  for (const [file, re] of [
    ['/proc/self/mountinfo', /\/containers\/([0-9a-f]{64})\//],
    ['/proc/self/cgroup',    /[:/-]([0-9a-f]{64})/],
  ]) {
    try {
      const m = fs.readFileSync(file, 'utf8').match(re);
      if (m && ID.test(m[1])) return m[1];
    } catch { /* not in a container, or the file is unreadable */ }
  }
  return null;
}

function resolveHostMountPath(containerPath) {
  if (_hostMountCache === null) {
    const { execSync } = require('child_process');
    // One inspect, three answers. The mounts are what this function was
    // written for; the container's own name and image are what the
    // updater script needs, and asking for them here means the whole
    // identity comes from a single lookup that has already proved it
    // found the right container.
    const tryInspect = (id, label) => {
      try {
        const out = execSync(
          `docker inspect --format='{\"mounts\":{{json .Mounts}},` +
            `\"name\":{{json .Name}},\"image\":{{json .Config.Image}}}' ${id}`,
          { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }
        );
        const info = JSON.parse(out);
        const mounts = info && info.mounts;
        if (!Array.isArray(mounts) || mounts.length === 0) return null;
        const map = {};
        for (const m of mounts) {
          if (m && m.Destination && m.Source) map[m.Destination] = m.Source;
        }
        // Docker reports the name with a leading slash.
        const name = typeof info.name === 'string' ? info.name.replace(/^\//, '') : null;
        const image = typeof info.image === 'string' ? info.image : null;
        return { map, name, image, label };
      } catch {
        return null;
      }
    };

    let result = null;

    // v1.1.7.0 — Method 0: ask the kernel which container we are.
    //
    // This runs first because it is the only method that identifies THIS
    // container rather than guessing. Docker bind-mounts /etc/hostname,
    // /etc/hosts and /etc/resolv.conf from
    // /var/lib/docker/containers/<id>/, so our own mountinfo contains our
    // container id. cgroup v1 carries it too; v2 often does not, which is
    // why mountinfo is tried first.
    //
    // The methods below it are all guesses, and two of them are actively
    // unreliable here: the container is usually started with --network
    // host, which makes /etc/hostname the HOST's name rather than the
    // container id, and the scan looked for a container that already had
    // /mnt/musicd_updates — circular, since that is the mount whose
    // absence we are trying to report.
    if (!result) {
      const id = _selfContainerId();
      if (id) result = tryInspect(id, `self=${id.slice(0, 12)}`);
    }

    // Method 1: container name 'musicd' (install.sh standard).
    if (!result) result = tryInspect('musicd', 'name=musicd');

    // Method 2: /etc/hostname (works when --hostname is the container ID).
    if (!result) {
      try {
        const h = fs.readFileSync('/etc/hostname', 'utf8').trim();
        if (h) result = tryInspect(h, `hostname=${h}`);
      } catch { /* */ }
    }

    // Method 3: scan all containers and take the one that looks like us.
    //
    // v1.1.7.0: this used to require a candidate to already have
    // /mnt/musicd_updates, which meant it could never help the install
    // that is missing exactly that mount. It now accepts any container
    // carrying the marks of a musicd: the data directory, or the docker
    // socket plus a music mount. Whichever it settles on, the label says
    // which, so a wrong guess is visible in the error rather than silent.
    if (!result) {
      try {
        const ids = execSync('docker ps -q', { encoding: 'utf8', timeout: 5000 })
          .split('\n').filter(Boolean);
        const looksLikeUs = (m) =>
          m['/mnt/musicd_updates'] || m['/data'] ||
          (m['/var/run/docker.sock'] && m['/music']);
        for (const id of ids) {
          const r = tryInspect(id, `scan-found=${id.slice(0, 12)}`);
          if (r && looksLikeUs(r.map)) { result = r; break; }
        }
      } catch { /* */ }
    }

    if (result) {
      _hostMountCache = result.map;
      _hostMountCacheSource = result.label;
      _selfIdentity = { name: result.name, image: result.image, resolved: true };
      console.log(`[updater] host mount paths resolved via ${result.label}: ${Object.keys(result.map).length} mounts`);
      console.log(`[updater] this container is ${result.name || '(unnamed)'} from image ${result.image || '(unknown)'}`);
    } else {
      _hostMountCache = {};
      _hostMountCacheSource = 'failed';
      _selfIdentity = { name: null, image: null, resolved: false };
      console.warn('[updater] could not resolve host mount paths via any method');
    }
  }
  return _hostMountCache[containerPath] || null;
}

// Diagnostic accessor — used by error paths to explain HOW lookup failed.
function _hostMountResolutionInfo() {
  return {
    source: _hostMountCacheSource,
    knownDestinations: Object.keys(_hostMountCache || {}),
  };
}

// The name and image of the container we are running in.
//
// v1.1.10.0. The updater script has to stop, remove and re-create THIS
// container. It hardcoded `musicd` for the name and `musicd:latest` for
// the image, because install.sh always passes --name musicd. Anyone who
// followed the README instead has a container called musicd-server built
// as musicd-server, and then every `docker inspect musicd` in the
// generated script returned nothing: no mounts, no env vars, no network
// mode, no devices and no group-adds preserved. `docker stop musicd` and
// `docker rm musicd` matched nothing either, so the old container kept
// running while a second one was started beside it — under --network
// host, fighting it for the port, with none of the user's data.
//
// That is exactly the reported failure: a log saying "preserving mounts:
// /var/run/docker.sock" (the one mount the script contributes itself) and
// an update that reports success while the server stays on its old
// version.
//
// resolveHostMountPath already identifies this container without guessing
// (see _selfContainerId); this reads the name and image off the same
// lookup, so the script operates on whatever the container is actually
// called. The defaults below keep a stock install.sh install working if
// the lookup fails, and the generated script verifies the container
// exists before it touches anything — so a wrong fallback stops with a
// message instead of orphaning the user's data.
function resolveSelfIdentity() {
  if (_selfIdentity === null) {
    // Populates _selfIdentity as a side effect. The argument is
    // immaterial: any path drives the same one-time resolution.
    resolveHostMountPath('/data');
  }
  const id = _selfIdentity || {};
  // Config.Image is normally what the user typed at `docker run`, but a
  // container started from a bare id reports a digest. Building and
  // tagging that would be meaningless, so fall back to a name we can use.
  const name = id.name || 'musicd';
  const looksLikeDigest = (s) => /^sha256:/.test(s) || /^[0-9a-f]{64}$/.test(s);
  const image = (id.image && !looksLikeDigest(id.image)) ? id.image : `${name}:latest`;
  return { name, image, resolved: Boolean(id.resolved && id.name) };
}

// `musicd-server:latest` -> `musicd-server:rollback`; `musicd` ->
// `musicd:rollback`; `ghcr.io/me/musicd:1.2` -> `ghcr.io/me/musicd:rollback`.
// The tag is the part after the LAST colon, and only when that part
// carries no slash — otherwise the colon belongs to a registry port.
function rollbackTagFor(image) {
  const cut = image.lastIndexOf(':');
  const repo = (cut > 0 && !image.slice(cut + 1).includes('/')) ? image.slice(0, cut) : image;
  return `${repo}:rollback`;
}

// Launch flags used to start the new musicd container after build. Keep this
// in sync with the install command in the README. Mounts include the docker
// socket and update folders so the new musicd can also self-update.
//
// (#30.10) Adds the optional backups mount. Containers started by v30.9 or
// earlier won't have this mount — the backup module probes for it at
// runtime and the UI shows a "not configured" hint rather than failing.
// From v30.10 onward, every self-update preserves it.
// Container launch args used by the in-app self-updater (#v1.1.0.11).
// MUST match what the installer creates on the host. If these get out
// of sync, post-update containers come up with empty bind mounts and
// the user's data appears to vanish.
//
// As of v1.1.0.11 all musicd host state lives consolidated under
// /var/lib/musicd/ instead of being scattered across multiple
// /mnt/dietpi_userdata/musicd-* directories. The container's internal
// view (/data, /mnt/downloads, /mnt/musicd_updates, /mnt/backups) is
// unchanged, so server code needs no modification beyond this list.
//
// Music location is intentionally NOT in this template -- it varies
// per install. The first-install installer prompts for it and writes
// the result somewhere readable; the in-app updater reads the running
// container's existing -v flags and preserves the music mount across
// updates. (See findExistingMusicMount() below.)
// Container launch flags that DON'T vary per install. Just a name +
// the docker socket (so the new container can do its own future
// updates). Everything else -- mounts, env vars, devices, groups,
// restart policy, network mode -- is preserved from the running
// container at update time via `docker inspect`. See
// buildUpdaterScript() below.
//
// Pre-v47 this contained hardcoded mounts like /var/lib/musicd/data:
// /data. That was correct for installs done via the official
// first-install installer, but if a user installed via a different
// path (e.g. /var/lib/musicd:/data) the in-app update would create a
// new container at the wrong host path and the user's library state
// would appear to vanish. Now we preserve whatever the user already
// has, so it survives across updates regardless of how the original
// container was set up.
// The name is filled in per install by resolveSelfIdentity() — see the note
// there. Everything else about the container (mounts, env, devices, groups,
// restart policy, network mode) is read back off the running container by the
// generated script, INCLUDING the docker socket.
//
// v1.1.12.0: the socket used to be listed here as well. It is always among the
// preserved mounts already — musicd cannot have spawned the updater without it
// — so every update ran `docker run` with the same -v twice. The Docker this
// was observed on tolerates that, but a version that rejects a repeated mount
// destination would fail the run and then fail the byte-identical rollback
// run, leaving the user with no container at all. The script now appends it
// only if the preserved mounts somehow lack it.
const DOCKER_SOCK_MOUNT = '/var/run/docker.sock:/var/run/docker.sock';

function launchArgsFor(containerName) {
  return ['--name', containerName];
}

/**
 * Scan downloads dir for tars; return the highest-version one that's newer
 * than the running version, or null.
 *
 * Includes a fallback to the remote update path (#30.6): if no local tar
 * is newer, we check the cached remote-manifest result. Local takes
 * priority so the dev workflow (drop a tar in /mnt/downloads) still works
 * without going through Dropbox.
 *
 * Note: a remote-only update returns `source: 'remote'` and a
 * `downloadUrl` field. The runUpdate() path checks for this and downloads
 * the tar before applying — local updates skip the download step.
 */
/**
 * Find the highest available update.
 *
 * v1.1.0.73 — changed from "local takes priority, fall back to remote
 * if no local is newer" to "pick the highest version, regardless of
 * source." The old rule had a dev-workflow rationale (drop a custom
 * tar in /mnt/downloads, see it win over the manifest) but in
 * practice it caused a real user issue: a stale local tar from an
 * earlier manual push could pin the user on an older version
 * indefinitely if they never thought to clear DOWNLOADS_DIR. The
 * new rule preserves the dev workflow (drop a v99 test tar → it
 * still wins because it's the highest) while letting the manifest
 * version pull users forward whenever it's newer than anything in
 * the local watch dir.
 *
 * Tie-breaking: if local and remote are exactly equal, prefer
 * local (no point downloading what we already have on disk).
 *
 * Note: a remote-only update returns `source: 'remote'` and a
 * `downloadUrl` field. The runUpdate() path checks for this and
 * downloads the tar before applying — local updates skip the
 * download step.
 */
// v1.1.1.3 — optional channel parameter. When provided, the
// remote check uses the channel-specific entry from the new
// manifest format (channels.<channel>.version) instead of the
// top-level legacy version field. Calling with no channel
// preserves pre-1.1.1.3 behaviour for any callsite that hasn't
// been migrated yet.
function findAvailableUpdate(channel = null) {
  let entries;
  try {
    entries = fs.readdirSync(DOWNLOADS_DIR);
  } catch {
    entries = [];
  }
  const current = version.parseVersion(version.getVersion());
  let bestLocal = null;
  for (const name of entries) {
    const parsed = version.parseFilenameVersion(name);
    if (!parsed) continue;
    if (version.compareVersions(parsed, current) <= 0) continue; // not newer
    if (!bestLocal || version.compareVersions(parsed, bestLocal.parts) > 0) {
      bestLocal = { filename: name, parts: parsed };
    }
  }

  // Look up the cached remote candidate too. Lazy require to keep the
  // dependency loose; remoteUpdater requires version.js which requires
  // nothing back, so no actual cycle.
  let remote = null;
  try {
    const ru = require('./remoteUpdater');
    remote = channel
      ? ru.findRemoteUpdateForChannel(channel)
      : ru.findRemoteUpdate();
  } catch (e) {
    // Remote check disabled or failed — fall through; local-only.
  }

  // Compare the two candidates by version. If local is missing, take
  // remote. If remote is missing, take local. If both, pick the
  // higher; on a tie, prefer local (no need to redownload).
  if (!bestLocal && !remote) return null;
  if (!remote) {
    return {
      currentVersion: version.formatVersion(current),
      availableVersion: version.formatVersion(bestLocal.parts),
      tarFilename: bestLocal.filename,
      source: 'local',
    };
  }
  if (!bestLocal) {
    return remote;
  }
  // Both exist — pick the higher version. On equality, prefer local.
  const remoteParts = version.parseVersion(remote.availableVersion);
  const cmp = version.compareVersions(bestLocal.parts, remoteParts);
  if (cmp >= 0) {
    if (cmp === 0) {
      console.log(`[update] local and remote both at v${remote.availableVersion}; using local tar ${bestLocal.filename}`);
    }
    return {
      currentVersion: version.formatVersion(current),
      availableVersion: version.formatVersion(bestLocal.parts),
      tarFilename: bestLocal.filename,
      source: 'local',
    };
  }
  console.log(`[update] remote v${remote.availableVersion} > local v${version.formatVersion(bestLocal.parts)} (${bestLocal.filename}); using remote`);
  return remote;
}

/**
 * Build the bash script that the updater container will run. The script must
 * be self-contained — it has /host mounted at the host root and Docker access
 * via the socket. Logs go to /host/var/lib/musicd/updates/last.log so we can
 * show errors after the fact.
 */
function buildUpdaterScript(tarFilename, tarHostPath, hostUpdatesPath, identity) {
  // Note: $SOMEVAR / ${SOMEVAR} inside this template literal are JS interpolations.
  // Bash variables in the generated script are escaped with \$.
  // tarHostPath is the path the alpine container sees (typically begins with
  // /host/mnt/...). Caller has already validated it points at an existing file.
  // hostUpdatesPath is the host-side path that /mnt/musicd_updates is mounted
  // from (e.g. /var/lib/musicd/updates or /mnt/dietpi_userdata/musicd_updates).
  // The alpine container reads /host${hostUpdatesPath}/...
  // Which container and image to operate on. Injectable so the test suite
  // can drive this without a Docker daemon; production passes nothing and
  // gets the running container's real identity.
  const self = identity || resolveSelfIdentity();
  const containerName = self.name;
  const image = self.image;
  const rollbackImage = rollbackTagFor(image);
  const launchArgsBash = launchArgsFor(containerName).map(a => `"${a}"`).join(' ');

  return `#!/bin/sh
# We mkdir the log dir BEFORE redirecting, so the redirect itself can never
# fail because of a missing parent. Otherwise 'set -e' would silently kill us.
mkdir -p /host${hostUpdatesPath} 2>/dev/null
LOGFILE=/host${hostUpdatesPath}/last.log
exec >> "\$LOGFILE" 2>&1
set -e
echo ""
echo "[updater] === starting at \$(date) ==="

# The container and image this install actually uses. Resolved by the
# server from its own container id, NOT assumed — see resolveSelfIdentity
# in updater.js. Hardcoding "musicd" here meant every install that used a
# different --name (the README's is musicd-server) preserved nothing and
# left the old container running beside the new one.
CONTAINER="${containerName}"
IMAGE="${image}"
ROLLBACK_IMAGE="${rollbackImage}"
echo "[updater] container=\$CONTAINER image=\$IMAGE"

# Refuse to continue against a container that isn't there. Everything
# below this line either reads config off \$CONTAINER or destroys and
# re-creates it; running it against a name that matches nothing is how a
# user ends up with two containers and an empty data directory.
if ! docker inspect "\$CONTAINER" >/dev/null 2>&1; then
  echo "[updater] ABORT: no container named '\$CONTAINER' is known to docker."
  echo "[updater] Nothing has been changed. The running server is untouched."
  echo "[updater] Containers currently present:"
  docker ps -a --format '  {{.Names}} ({{.Image}}, {{.Status}})' 2>/dev/null || true
  exit 1
fi

# Preserve container config across update (#v1.1.0.47).
#
# Pre-v47 this section preserved only --device, --group-add and the
# /music mount. Hardcoded LAUNCH_ARGS provided everything else. That
# meant if the user installed with a non-standard data path or env
# var, the updater would create a new container with the LAUNCH_ARGS
# defaults and the user's actual data would appear to vanish.
#
# Now we preserve ALL existing -v mounts, -e env vars, --network mode,
# --restart policy, --device entries and --group-add entries. The
# updater script's only additions are --name (the container's own,
# resolved above) and the docker.sock mount needed for self-update.
ALL_FLAGS=""
KEPT_ENV=""

# Mounts: all bind mounts, with their original :ro/:rw flag preserved.
MOUNT_LINES=\$(docker inspect "\$CONTAINER" --format '{{range .Mounts}}{{if eq .Type "bind"}}{{.Source}}|{{.Destination}}|{{.Mode}}{{println}}{{end}}{{end}}' 2>/dev/null || echo "")
if [ -n "\$MOUNT_LINES" ]; then
  echo "[updater] preserving mounts:"
  echo "\$MOUNT_LINES" | while IFS='|' read -r src dst mode; do
    [ -z "\$src" ] && continue
    case "\$mode" in
      *ro*) echo "  \$src -> \$dst (ro)" ;;
      *)    echo "  \$src -> \$dst" ;;
    esac
  done
  # Re-emit as docker -v flags. Done in a second pass because the loop
  # above runs in a subshell so its variable mutations don't escape.
  while IFS='|' read -r src dst mode; do
    [ -z "\$src" ] && continue
    case "\$mode" in
      *ro*) ALL_FLAGS="\$ALL_FLAGS -v \$src:\$dst:ro" ;;
      *)    ALL_FLAGS="\$ALL_FLAGS -v \$src:\$dst"     ;;
    esac
  done <<MOUNT_EOF
\$MOUNT_LINES
MOUNT_EOF
fi

# Env vars: skip the kernel/system-injected ones (PATH, HOSTNAME, etc.)
# but keep app-relevant ones the user or installer set.
ENV_LINES=\$(docker inspect "\$CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null || echo "")
if [ -n "\$ENV_LINES" ]; then
  while IFS= read -r kv; do
    [ -z "\$kv" ] && continue
    case "\$kv" in
      PATH=*|HOSTNAME=*|HOME=*|TERM=*|NODE_VERSION=*|YARN_VERSION=*|LANG=*|LC_*) continue ;;
      *)
        # Quote the value to survive spaces; the shell-parsing of
        # docker run handles this correctly.
        key=\${kv%%=*}
        val=\${kv#*=}
        ALL_FLAGS="\$ALL_FLAGS -e \$key=\$val"
        KEPT_ENV="\$KEPT_ENV \$key"
        ;;
    esac
  done <<ENV_EOF
\$ENV_LINES
ENV_EOF
fi
[ -n "\$KEPT_ENV" ] && echo "[updater] preserving env:\$KEPT_ENV"


# Network mode: usually "host" for musicd, but preserve whatever the
# user has.
NET_MODE=\$(docker inspect "\$CONTAINER" --format '{{.HostConfig.NetworkMode}}' 2>/dev/null || echo "")
if [ -n "\$NET_MODE" ] && [ "\$NET_MODE" != "default" ]; then
  ALL_FLAGS="\$ALL_FLAGS --network \$NET_MODE"
  echo "[updater] preserving network mode: \$NET_MODE"
fi

# Restart policy.
RESTART_POL=\$(docker inspect "\$CONTAINER" --format '{{.HostConfig.RestartPolicy.Name}}' 2>/dev/null || echo "")
if [ -n "\$RESTART_POL" ] && [ "\$RESTART_POL" != "no" ]; then
  ALL_FLAGS="\$ALL_FLAGS --restart \$RESTART_POL"
  echo "[updater] preserving restart policy: \$RESTART_POL"
fi

# Devices (USB DACs, /dev/snd).
DEVICE_PATHS=\$(docker inspect "\$CONTAINER" --format '{{range .HostConfig.Devices}}{{.PathOnHost}}{{":"}}{{.PathInContainer}}{{" "}}{{end}}' 2>/dev/null || echo "")
if [ -n "\$DEVICE_PATHS" ]; then
  echo "[updater] preserving devices: \$DEVICE_PATHS"
  for d in \$DEVICE_PATHS; do
    ALL_FLAGS="\$ALL_FLAGS --device \$d"
  done
fi

# Group adds (audio group access).
GROUP_ADDS=\$(docker inspect "\$CONTAINER" --format '{{range .HostConfig.GroupAdd}}{{.}}{{" "}}{{end}}' 2>/dev/null || echo "")
if [ -n "\$GROUP_ADDS" ]; then
  echo "[updater] preserving group-adds: \$GROUP_ADDS"
  for g in \$GROUP_ADDS; do
    ALL_FLAGS="\$ALL_FLAGS --group-add \$g"
  done
fi

# The socket is what lets the NEW container run its own future updates. It is
# normally already in ALL_FLAGS as a preserved mount; adding it unconditionally
# passed it to docker run twice. See DOCKER_SOCK_MOUNT in updater.js.
case "\$ALL_FLAGS" in
  *"${DOCKER_SOCK_MOUNT}"*)
    ;;
  *)
    echo "[updater] docker socket was not mounted — adding it so the new container can self-update"
    ALL_FLAGS="\$ALL_FLAGS -v ${DOCKER_SOCK_MOUNT}"
    ;;
esac

echo "[updater] config preservation complete"

TAR=${tarHostPath}
WORK=/host/tmp/musicd-update-\$\$
mkdir -p "\$WORK"
cd "\$WORK"

echo "[updater] extracting \$TAR..."
tar -xf "\$TAR"
cd musicd

echo "[updater] tagging current image as \$ROLLBACK_IMAGE..."
docker tag "\$IMAGE" "\$ROLLBACK_IMAGE" || true

echo "[updater] building new image..."
if ! docker build -t "\$IMAGE" .; then
  echo "[updater] BUILD FAILED — rolling back"
  docker tag "\$ROLLBACK_IMAGE" "\$IMAGE" || true
  docker stop "\$CONTAINER" 2>/dev/null || true
  docker rm "\$CONTAINER" 2>/dev/null || true
  docker run -d ${launchArgsBash} \$ALL_FLAGS "\$IMAGE"
  echo "[updater] rolled back to previous version"
  exit 1
fi

echo "[updater] stopping old container..."
docker stop "\$CONTAINER" 2>/dev/null || true
docker rm "\$CONTAINER" 2>/dev/null || true

echo "[updater] starting new container..."
if ! docker run -d ${launchArgsBash} \$ALL_FLAGS "\$IMAGE"; then
  echo "[updater] START FAILED — rolling back"
  docker tag "\$ROLLBACK_IMAGE" "\$IMAGE" || true
  docker rm "\$CONTAINER" 2>/dev/null || true
  docker run -d ${launchArgsBash} \$ALL_FLAGS "\$IMAGE"
  echo "[updater] rolled back to previous version"
  exit 1
fi

echo "[updater] moving consumed tar to updates dir..."
mkdir -p /host${hostUpdatesPath}
# 'mv' across the same filesystem is a rename; works for both local
# (downloads dir) and remote (pending subdir) sources. If the target
# already has a tar with this name from a previous run, overwrite it.
mv -f "\$TAR" /host${hostUpdatesPath}/

echo "[updater] cleaning up working dir..."
rm -rf "\$WORK"

echo "[updater] === complete at \$(date) ==="
`;
}

/**
 * Verify musicd can talk to the host docker daemon (and that the image we
 * need to spawn is available). Returns a status object describing what we
 * found. Used both at startup (warm cache) and as a preflight before update.
 */
function preflightCheck() {
  return new Promise((resolve) => {
    const result = { ok: true, dockerWorks: false, imagePresent: false, error: null };
    const proc = require('child_process').execFile('docker',
      ['version', '--format', '{{.Server.Version}}'],
      { timeout: 8000 },
      (err, stdout, stderr) => {
        if (err) {
          result.ok = false;
          result.error = `docker daemon unreachable: ${(stderr || err.message || '').trim()}`;
          return resolve(result);
        }
        result.dockerWorks = true;
        // Check if docker:cli image is locally available
        require('child_process').execFile('docker',
          ['image', 'inspect', 'docker:cli', '--format', '{{.Id}}'],
          { timeout: 5000 },
          (err2) => {
            result.imagePresent = !err2;
            resolve(result);
          });
      });
  });
}

/**
 * Pre-pull the docker:cli image so the actual update doesn't have to wait/fail
 * on a network pull. Run this in the background after musicd boots; failures
 * here are non-fatal — we just log a warning and the update will pull on demand.
 */
function ensureUpdaterImage() {
  return new Promise((resolve) => {
    require('child_process').execFile('docker',
      ['pull', 'docker:cli'],
      { timeout: 60_000 },
      (err, stdout, stderr) => {
        if (err) {
          console.warn(`⚠️  Failed to pre-pull docker:cli: ${(stderr || err.message || '').trim().split('\n')[0]}`);
          return resolve(false);
        }
        console.log('✓ docker:cli image ready for auto-update');
        resolve(true);
      });
  });
}

/**
 * Kick off the update process. Runs synchronously up to the spawn, so any
 * preflight failures bubble back to the caller. The actual update work happens
 * inside a detached alpine container that survives this container's death.
 *
 * `opts.source`: 'local' (default) or 'remote'. Remote means the tar was
 * downloaded by remoteUpdater.downloadTar() and lives in the writable
 * pending dir, not the watch folder. Local means it was placed by hand
 * in the local watch folder /mnt/downloads (the dev workflow).
 *
 * The two locations differ because /mnt/downloads is sometimes mounted
 * :ro (it was deliberately read-only in early v30.6 deployments to keep
 * the dev workflow's host-side files immutable to the container). The
 * pending dir under /mnt/musicd_updates is always :rw — see the comments
 * in remoteUpdater.js for the full rationale.
 */
async function runUpdate(tarFilename, opts = {}) {
  // Dispatch by orchestrator mode (#v1.1.0.48). The docker path stays
  // exactly as it was -- only added a thin entry above. The systemd
  // path is implemented in runUpdateNative below.
  const orchestrator = require('./orchestrator');
  const m = orchestrator.mode();
  if (m === 'systemd') {
    return runUpdateNative(tarFilename, opts);
  }
  if (m !== 'docker') {
    throw new Error(`In-app updates not supported in orchestrator mode '${m}'`);
  }
  return runUpdateDocker(tarFilename, opts);
}

async function runUpdateDocker(tarFilename, opts = {}) {
  // Sanity-check the filename format
  const parsed = version.parseFilenameVersion(tarFilename);
  if (!parsed) {
    throw new Error(`Invalid tar filename: ${tarFilename}`);
  }
  const source = opts.source === 'remote' ? 'remote' : 'local';

  // Verify the tar exists on the side of the filesystem the running
  // musicd can actually see. Remote-downloaded tars live in the writable
  // pending dir (PENDING_DIR / PENDING_DIR_HOST). Local tars live in the
  // watch folder.
  let musicdSidePath;     // path the running musicd can stat
  let hostSidePath;       // path the alpine updater container will read

  if (source === 'remote') {
    const remoteUpdater = require('./remoteUpdater');
    // remoteUpdater resolves the host-side path; the musicd-side path is
    // the same dir under /mnt/musicd_updates/pending.
    // v1.1.2.9: was remoteUpdater.PENDING_DIR_HOST (a hardcoded constant);
    // now getPendingDirHost() resolves it from the container's actual
    // mounts via docker inspect.
    musicdSidePath = path.join('/mnt/musicd_updates/pending', tarFilename);
    hostSidePath   = path.join(remoteUpdater.getPendingDirHost(), tarFilename);
  } else {
    // Local-source tars live in the watch folder /mnt/downloads which
    // is bind-mounted from the host (path varies by install).
    // v1.1.2.5: resolve host path dynamically rather than hardcoding it,
    // so installs that mount /mnt/downloads from /mnt/dietpi_userdata/downloads,
    // /var/lib/musicd/downloads, or anywhere else, all work the same.
    musicdSidePath = path.join(DOWNLOADS_DIR, tarFilename);
    const downloadsHost = resolveHostMountPath('/mnt/downloads');
    if (!downloadsHost) {
      const info = _hostMountResolutionInfo();
      throw new Error(
        `Cannot resolve host path for /mnt/downloads. ` +
        `Resolution method: ${info.source}. ` +
        `Known destinations: ${info.knownDestinations.length ? info.knownDestinations.join(', ') : '(none)'}. ` +
        `If the resolver returned (none), the musicd container's docker socket access is not working. ` +
        `If destinations are listed but /mnt/downloads is missing, install.sh used a non-standard mount path.`
      );
    }
    hostSidePath = `/host${downloadsHost}/${tarFilename}`;
  }
  if (!fs.existsSync(musicdSidePath)) {
    throw new Error(`Tar not found: ${musicdSidePath}`);
  }

  // Preflight: confirm docker daemon is reachable from inside the container
  const flight = await preflightCheck();
  if (!flight.ok) {
    throw new Error(flight.error || 'Docker daemon unreachable from container');
  }

  // Make sure the directory exists. If this throws (permission denied), the
  // route handler will surface it to the UI.
  fs.mkdirSync('/mnt/musicd_updates', { recursive: true });

  // Initialise last.log so the UI can surface our spawn output even if the
  // alpine container fails to start. We write a header indicating preflight passed.
  const logPath = '/mnt/musicd_updates/last.log';
  const stamp = new Date().toISOString();
  fs.writeFileSync(logPath, `[musicd] update requested at ${stamp}\n` +
    `[musicd] target tar: ${tarFilename} (source: ${source})\n` +
    `[musicd] alpine-side path: ${hostSidePath}\n` +
    `[musicd] docker daemon: ${flight.dockerWorks ? 'OK' : 'UNREACHABLE'}\n` +
    `[musicd] docker:cli image: ${flight.imagePresent ? 'present locally' : 'will be pulled'}\n` +
    `[musicd] spawning updater container...\n`);

  // v1.1.2.5: resolve the host-side path of /mnt/musicd_updates rather
  // than hardcoding it. The updater script needs to be readable by the
  // alpine container at /host${updatesHost}/update.sh, and the consumed-
  // tar archive lives at /host${updatesHost}/. Hardcoding the path
  // broke any install whose install.sh chose a different host location
  // (notably DietPi default /mnt/dietpi_userdata/musicd_updates).
  const updatesHost = resolveHostMountPath('/mnt/musicd_updates');
  if (!updatesHost) {
    const info = _hostMountResolutionInfo();
    fs.appendFileSync(logPath,
      `[musicd] FATAL: cannot resolve host path for /mnt/musicd_updates.\n` +
      `[musicd] Resolution method tried: ${info.source}\n` +
      `[musicd] Known destinations: ${info.knownDestinations.length ? info.knownDestinations.join(', ') : '(none)'}\n` +
      `[musicd] If destinations are (none), the resolver couldn't find this container\n` +
      `[musicd] in docker. If destinations are listed but /mnt/musicd_updates is missing,\n` +
      `[musicd] install.sh used a non-standard mount path.\n`);
    // v1.1.4.0 — say what to do about it. This fires when
    // /mnt/musicd_updates is not a bind mount from the host: the
    // directory exists inside the container (we just created it), the
    // download succeeded, and the only thing missing is a host path for
    // the sidecar to read the tar from. The bare "cannot resolve" text
    // gave no clue that the fix is a -v flag on the run command.
    throw new Error(
      'Cannot resolve host path for /mnt/musicd_updates. The update downloaded, ' +
      'but installing it needs that directory to be a real bind mount from the ' +
      'host, because a sidecar container reads the tarball from the host side. ' +
      'Add "-v /var/lib/musicd-server-v1/updates:/mnt/musicd_updates" to your ' +
      'docker run (or the equivalent volume in docker-compose.yml), create the ' +
      'directory first so it belongs to UID 1000, and restart. ' +
      `Resolved this container via ${info.source}; its mounts are: ` +
      `${info.knownDestinations.length ? info.knownDestinations.join(', ') : '(none — the Docker socket is not reachable)'}. ` +
      `If those are not the mounts you started musicd with, the resolver matched the wrong container — say so and it can be pinned.`
    );
  }
  fs.appendFileSync(logPath,
    `[musicd] resolved host updates path: ${updatesHost}\n` +
    `[musicd] alpine will read script from: /host${updatesHost}/update.sh\n`);

  // Write the helper script
  const scriptPath = '/mnt/musicd_updates/update.sh';
  fs.writeFileSync(scriptPath, buildUpdaterScript(tarFilename, hostSidePath, updatesHost), { mode: 0o755 });

  // Spawn the updater container.
  //
  // (#v1.1.0.13) Three improvements to make future failures debuggable:
  //
  //   1. We log the FULL spawn args to last.log before spawning. If the
  //      docker daemon refuses or argv is wrong, the user-visible log
  //      now shows exactly what we tried to run.
  //
  //   2. We DON'T pass --rm. Previously the container was --rm so it
  //      auto-deleted on exit -- which meant ANY pre-script failure (like
  //      "sh: cannot open ...") was lost forever, with nothing in
  //      last.log and no docker logs to retrieve. Without --rm, the
  //      exited container sticks around and `docker logs musicd-updater`
  //      retrieves whatever stdout/stderr the alpine container emitted
  //      before opening the script's own log redirect. We clean it up
  //      proactively at the START of the next spawn (step 3).
  //
  //   3. Before spawning, we `docker rm -f musicd-updater` to clear out
  //      any stale container from a previous run. Without --rm, repeated
  //      updates would fail with "name already in use" otherwise. The
  //      `-f` handles the case where the previous run is somehow still
  //      executing (it won't be in normal flow, but defensive).

  try {
    require('child_process').execSync('docker rm -f musicd-updater 2>/dev/null', { stdio: 'ignore' });
  } catch {
    // No stale container to clean up; that's fine.
  }

  const args = [
    'run', '-d',
    '--name', 'musicd-updater',
    '-v', '/var/run/docker.sock:/var/run/docker.sock',
    '-v', '/:/host',
    'docker:cli',
    'sh', `/host${updatesHost}/update.sh`,
  ];
  // Log the full spawn args before spawning so post-mortem analysis
  // can see exactly what was attempted, even if the spawn never
  // produces any output.
  fs.appendFileSync(logPath,
    `[musicd] spawn cmd: docker ${args.join(' ')}\n`);
  console.log('🔄 Spawning updater container:', args.join(' '));

  const child = spawn('docker', args, { detached: true });
  let spawnOutput = '';
  child.stdout.on('data', d => { spawnOutput += d.toString(); });
  child.stderr.on('data', d => { spawnOutput += d.toString(); });
  child.on('error', (err) => {
    fs.appendFileSync(logPath, `[musicd] spawn error: ${err.message}\n`);
  });
  child.on('exit', (code) => {
    // The 'docker run -d' command itself returns the new container ID on success
    // (rc 0). Non-zero means the spawn failed (image pull error, socket auth,
    // etc.) BEFORE our script could even start. Capture that for the UI.
    if (code !== 0) {
      fs.appendFileSync(logPath,
        `[musicd] spawn exited with code ${code}\n` +
        `[musicd] output:\n${spawnOutput}\n`);
    } else {
      fs.appendFileSync(logPath,
        `[musicd] updater container started (id: ${spawnOutput.trim()})\n` +
        `[musicd] (if this update appears stuck, run: docker logs musicd-updater)\n`);
    }
  });
  child.unref();

  return { ok: true, tarFilename, message: 'Update started — server will restart shortly' };
}

/**
 * Native-systemd update flow (#v1.1.0.48).
 *
 * Layout:
 *   /opt/musicd/server/           current server code (running)
 *   /opt/musicd/client/           current built client
 *   /opt/musicd/VERSION
 *   /opt/musicd/CHANGELOG.md
 *   /opt/musicd/.staging/         staging area for in-flight updates
 *   /opt/musicd/.previous/        last version, kept for rollback
 *   /var/lib/musicd/updates/last.log
 *   /var/lib/musicd/updates/pending/   downloaded remote tars
 *   /var/lib/musicd/downloads/    user-dropped local tars
 *
 * Sequence:
 *   1. Extract tar to .staging/v{ver}/ (alongside any previous staging)
 *   2. Run `npm ci --omit=dev` in staging/server (only if package.json changed)
 *   3. If staging/client/dist is missing, run `npm ci && npm run build`
 *      in staging/client. Otherwise the tar shipped pre-built assets.
 *   4. Move current /opt/musicd/{server,client,VERSION,CHANGELOG.md}
 *      to .previous/ (atomic rename)
 *   5. Move staging/v{ver}/{server,client,VERSION,CHANGELOG.md} into
 *      /opt/musicd/ (atomic rename)
 *   6. Spawn `sudo -n systemctl restart musicd` (relies on the sudoers
 *      entry the installer dropped)
 *
 * Errors during 1-3 are recoverable: nothing has been swapped yet.
 * Errors during 4-5 are not safe: the installer ships a `roll-back.sh`
 * helper for the user to manually invoke.
 */
const NATIVE_INSTALL_DIR = '/opt/musicd';
const NATIVE_STATE_DIR   = '/var/lib/musicd';

async function runUpdateNative(tarFilename, opts = {}) {
  const parsed = version.parseFilenameVersion(tarFilename);
  if (!parsed) throw new Error(`Invalid tar filename: ${tarFilename}`);
  const source = opts.source === 'remote' ? 'remote' : 'local';

  let tarPath;
  if (source === 'remote') {
    tarPath = path.join(NATIVE_STATE_DIR, 'updates', 'pending', tarFilename);
  } else {
    tarPath = path.join(NATIVE_STATE_DIR, 'downloads', tarFilename);
  }
  if (!fs.existsSync(tarPath)) throw new Error(`Tar not found: ${tarPath}`);

  const logPath = path.join(NATIVE_STATE_DIR, 'updates', 'last.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const stamp = new Date().toISOString();
  const log = (msg) => {
    fs.appendFileSync(logPath, msg + '\n');
    console.log('[updater]', msg);
  };
  fs.writeFileSync(logPath, `[musicd] native update at ${stamp}\n[musicd] tar: ${tarPath}\n`);

  // Stage extract.
  const stagingRoot = path.join(NATIVE_INSTALL_DIR, '.staging');
  const targetVer = version.formatVersion(parsed);
  const stagingDir = path.join(stagingRoot, `v${targetVer}`);
  log(`extracting -> ${stagingDir}`);
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });
  await execLogged('tar', ['-xf', tarPath, '-C', stagingDir, '--strip-components=1'], log);

  // Sanity: required dirs/files exist in staging.
  for (const required of ['server', 'client', 'VERSION']) {
    if (!fs.existsSync(path.join(stagingDir, required))) {
      throw new Error(`Tar missing required path: ${required}`);
    }
  }

  // Server deps: install only if package.json changed (or node_modules
  // missing). Cheap to compare; saves ~30s when the change is JS-only.
  const stagingServerPkg = path.join(stagingDir, 'server', 'package.json');
  const currentServerPkg = path.join(NATIVE_INSTALL_DIR, 'server', 'package.json');
  let needServerDeps = true;
  try {
    const a = fs.readFileSync(stagingServerPkg, 'utf8');
    const b = fs.readFileSync(currentServerPkg, 'utf8');
    needServerDeps = (a !== b);
  } catch { /* missing -- treat as need install */ }

  if (needServerDeps) {
    log('npm ci (server) -- package.json changed');
    await execLogged('npm', ['ci', '--omit=dev', '--prefix', path.join(stagingDir, 'server')], log);
  } else {
    // Reuse current node_modules if present. Hard-link rather than
    // copy to keep update fast.
    const cur = path.join(NATIVE_INSTALL_DIR, 'server', 'node_modules');
    const stg = path.join(stagingDir, 'server', 'node_modules');
    if (fs.existsSync(cur) && !fs.existsSync(stg)) {
      log('reusing existing server/node_modules');
      await execLogged('cp', ['-al', cur, stg], log);
    }
  }

  // Client build: if dist/ is in the tar, use it. Otherwise build.
  const clientDist = path.join(stagingDir, 'client', 'dist');
  if (!fs.existsSync(clientDist)) {
    log('building client (no prebuilt dist/ in tar)');
    await execLogged('npm', ['ci', '--prefix', path.join(stagingDir, 'client')], log);
    await execLogged('npm', ['run', 'build', '--prefix', path.join(stagingDir, 'client')], log);
  }

  // Atomic-ish swap. We do .previous rotation so manual rollback is
  // possible if the new version doesn't start.
  const prevDir = path.join(NATIVE_INSTALL_DIR, '.previous');
  fs.rmSync(prevDir, { recursive: true, force: true });
  fs.mkdirSync(prevDir, { recursive: true });
  log('moving current install to .previous/');
  for (const item of ['server', 'client', 'VERSION', 'CHANGELOG.md']) {
    const src = path.join(NATIVE_INSTALL_DIR, item);
    if (fs.existsSync(src)) {
      fs.renameSync(src, path.join(prevDir, item));
    }
  }

  log('moving staging into place');
  for (const item of ['server', 'client', 'VERSION', 'CHANGELOG.md']) {
    const src = path.join(stagingDir, item);
    if (fs.existsSync(src)) {
      fs.renameSync(src, path.join(NATIVE_INSTALL_DIR, item));
    }
  }
  fs.rmSync(stagingDir, { recursive: true, force: true });

  // Move consumed tar to updates/ for archive (mirrors docker behaviour).
  try {
    const archiveDir = path.join(NATIVE_STATE_DIR, 'updates');
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.renameSync(tarPath, path.join(archiveDir, tarFilename));
  } catch (e) {
    log(`(non-fatal) failed to archive tar: ${e.message}`);
  }

  log('install complete -- requesting systemd restart');
  // Spawn with detached + unref so the running process can exit
  // cleanly. systemd brings the new version up.
  const orchestrator = require('./orchestrator');
  // Don't await -- the restart kills us mid-await otherwise.
  orchestrator.selfRestart().catch(err => {
    fs.appendFileSync(logPath, `[musicd] restart failed: ${err.message}\n`);
  });

  return { ok: true, tarFilename, message: 'Update applied — server restarting' };
}

/** Spawn a command with stdio piped to the update log. Promise resolves on success. */
function execLogged(cmd, args, log) {
  return new Promise((resolve, reject) => {
    log(`+ ${cmd} ${args.join(' ')}`);
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout.on('data', d => log(d.toString().trimEnd()));
    proc.stderr.on('data', d => log(d.toString().trimEnd()));
    proc.on('error', reject);
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}`));
    });
  });
}

/** Read the last update log if available — for showing failure messages. */
function getLastUpdateLog() {
  // Try both possible log locations. Docker mode writes to
  // /mnt/musicd_updates/last.log; native systemd mode writes to
  // /var/lib/musicd/updates/last.log.
  for (const candidate of [
    '/var/lib/musicd/updates/last.log',
    '/mnt/musicd_updates/last.log',
  ]) {
    try { return fs.readFileSync(candidate, 'utf8'); }
    catch { /* try next */ }
  }
  return null;
}

/**
 * v1.1.0.73 — clear any pending update tars from both the local watch
 * folder (DOWNLOADS_DIR) and the remote pending dir. UI-accessible
 * recovery path for the stuck-local-tar problem: a stale tar can
 * pin findAvailableUpdate() on an older version regardless of what
 * the manifest says. We only delete files matching the canonical
 * musicd tar pattern (musicd-vX-Y-Z-W.tar) — anything else is left
 * alone so we don't accidentally nuke unrelated files in shared
 * mount points.
 */
// v1.1.2.8 — clearPendingTars now optionally skips tars at or
// newer than the running version. The default behaviour
// (opts.staleOnly = false) is the original v1.1.0.73 wipe-all
// recovery semantic; the new opts.staleOnly = true mode wipes
// only tars older than the running version, used by the
// auto-cleanup-on-check path so users don't lose a download
// they already initiated.
function clearPendingTars(opts) {
  const staleOnly = !!(opts && opts.staleOnly);
  const result = { deleted: [], kept: [], errors: [] };
  const dirsToClean = [DOWNLOADS_DIR];
  // Add the remote pending dir.
  let pendingDir;
  try {
    const orch = require('./orchestrator');
    pendingDir = orch.mode() === 'systemd'
      ? '/var/lib/musicd/updates/pending'
      : '/mnt/musicd_updates/pending';
  } catch {
    pendingDir = '/mnt/musicd_updates/pending';
  }
  dirsToClean.push(pendingDir);

  // For staleOnly mode, parse the running version once.
  const runningVersion = staleOnly ? version.parseVersion(version.getVersion()) : null;

  for (const dir of dirsToClean) {
    let entries;
    try { entries = fs.readdirSync(dir); }
    catch { continue; }
    for (const name of entries) {
      const fileVer = version.parseFilenameVersion(name);
      if (!fileVer) continue;
      const full = path.join(dir, name);

      if (staleOnly && runningVersion) {
        // Keep this tar if it's at-or-newer than what we're running.
        // The user might have already downloaded it intentionally.
        const cmp = version.compareVersions(fileVer, runningVersion);
        if (cmp >= 0) {
          result.kept.push(full);
          continue;
        }
      }

      try {
        fs.unlinkSync(full);
        result.deleted.push(full);
      } catch (e) {
        result.errors.push(`${full}: ${e.message}`);
      }
    }
  }
  return result;
}

module.exports = {
  findAvailableUpdate, runUpdate, getLastUpdateLog, preflightCheck,
  ensureUpdaterImage, clearPendingTars,
  // Exported for the test suite: buildUpdaterScript takes an injected
  // identity so the generated script can be asserted on without a
  // Docker daemon. Nothing in the server calls these.
  buildUpdaterScript, resolveSelfIdentity, rollbackTagFor,
};
