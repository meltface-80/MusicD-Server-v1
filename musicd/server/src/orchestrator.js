/**
 * Orchestrator abstraction.
 *
 * musicd can run two ways:
 *
 *   1. Inside a Docker container (legacy install method, used since
 *      v1.1.0.0). The container has /var/run/docker.sock bind-mounted
 *      so it can rebuild and restart itself via the host daemon.
 *
 *   2. Native systemd service (introduced v1.1.0.48). musicd runs as
 *      the unprivileged `musicd` user under a systemd unit. Updates
 *      apply by atomically replacing /opt/musicd/{server,client} and
 *      asking systemd to restart the unit. A scoped sudoers entry
 *      (created by the installer) lets the musicd user invoke
 *      `systemctl restart musicd` without a password.
 *
 * This module hides that difference behind three operations:
 *   - detectMode()        — figure out which mode we're in
 *   - canSelfRestart()    — whether selfRestart is wired up
 *   - selfRestart()       — restart the running musicd
 *   - canApplyUpdate()    — whether update flow is available
 *
 * All updater/backup/auto-update code goes through these instead of
 * reaching for `docker` or `systemctl` directly. That way changes to
 * the deployment layer don't ripple through application code.
 */

const fs = require('fs');
const { spawn } = require('child_process');

/**
 * Detection precedence:
 *   1. explicit env var MUSICD_MODE=docker|systemd (set by installer)
 *   2. /.dockerenv exists -> docker
 *   3. systemd journal var present (INVOCATION_ID/JOURNAL_STREAM) -> systemd
 *   4. default to 'unknown'
 *
 * 'unknown' is a soft state, not an error -- the app still runs, just
 * with self-restart disabled and a clear "not orchestrated" status.
 */
function detectMode() {
  const explicit = (process.env.MUSICD_MODE || '').toLowerCase();
  if (explicit === 'docker' || explicit === 'systemd' || explicit === 'unknown') {
    return explicit;
  }
  if (fs.existsSync('/.dockerenv')) return 'docker';
  if (process.env.INVOCATION_ID || process.env.JOURNAL_STREAM) return 'systemd';
  return 'unknown';
}

/** Cached on first call -- mode is stable for the life of the process. */
let _mode = null;
function mode() {
  if (_mode === null) _mode = detectMode();
  return _mode;
}

/**
 * Is the relevant control surface (docker socket / systemctl) actually
 * usable from this process? Distinct from mode() because a container
 * may be running without /var/run/docker.sock mounted, and a systemd
 * service may have a misconfigured sudoers entry.
 */
function canSelfRestart() {
  switch (mode()) {
    case 'docker':
      try { return fs.statSync('/var/run/docker.sock').isSocket(); }
      catch { return false; }
    case 'systemd':
      // We can't easily check the sudoers state without spawning sudo
      // (which would prompt). The installer is responsible for getting
      // this right; assume true if we're in systemd mode and surface
      // any issue at restart time via the spawn's exit code.
      return true;
    default:
      return false;
  }
}

/**
 * Restart the running musicd. Returns a Promise that resolves when the
 * restart command has been ACKed (which is BEFORE the restart actually
 * happens -- the caller is expected to be about to be killed).
 *
 * For docker: spawns `docker restart musicd` via the mounted socket.
 * For systemd: spawns `sudo systemctl restart musicd` (relies on the
 * sudoers entry the installer dropped).
 */
function selfRestart() {
  return new Promise((resolve, reject) => {
    const m = mode();
    let cmd, args;
    if (m === 'docker') {
      cmd = 'docker';
      args = ['restart', 'musicd'];
    } else if (m === 'systemd') {
      cmd = 'sudo';
      args = ['-n', 'systemctl', 'restart', 'musicd'];
    } else {
      return reject(new Error(`selfRestart unavailable in mode '${m}'`));
    }

    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
    });
  });
}

/**
 * Update support detection. canApplyUpdate is true when we have a
 * working orchestrator AND the update tooling expected for that
 * orchestrator is in place (alpine sidecar for docker, write access
 * to /opt/musicd for systemd).
 */
function canApplyUpdate() {
  switch (mode()) {
    case 'docker':
      return canSelfRestart();
    case 'systemd':
      try {
        // Probe write access to the install dir as the running user.
        const probe = '/opt/musicd/.write-probe';
        fs.writeFileSync(probe, '');
        fs.unlinkSync(probe);
        return true;
      } catch {
        return false;
      }
    default:
      return false;
  }
}

/** Diagnostic string for status endpoints. */
function describe() {
  return {
    mode: mode(),
    canSelfRestart: canSelfRestart(),
    canApplyUpdate: canApplyUpdate(),
  };
}

module.exports = {
  detectMode,
  mode,
  canSelfRestart,
  selfRestart,
  canApplyUpdate,
  describe,
};
