/**
 * Single source of truth for the running musicd version.
 *
 * v1.1.1.3 — semver migration. Supports both legacy four-part
 * (1.1.1.2) and semver (1.0.0-beta.1). Comparison rules:
 *
 *   semver-stable (1.0.0)       > prerelease of same MMP (1.0.0-beta.1)
 *   legacy-build (1.1.1.2)      > stable of same MMP (1.1.1)
 *   legacy-build (1.1.1.2)      > prerelease of same MMP (1.1.1-beta.1)
 *   M.m bumps                   > any post-release on lower M.m
 *
 * The migration case from a user's POV:
 *   running 1.1.1.3 (legacy)
 *   beta channel shows 1.0.0-beta.1
 *   compareVersions returns -1 → "no update on this channel"
 *   That's correct: 1.0.0-beta.1 IS numerically older. The user
 *   needs to wait for the beta channel to surpass 1.1.1 (e.g.
 *   1.1.2-beta.1 or 2.0.0-beta.1) for an update offer.
 *   The Settings UI explains this when user is on legacy + beta.
 */
const fs = require('fs');
const path = require('path');

let cached = null;

function getVersion() {
  if (cached) return cached;
  const candidates = [
    path.resolve(__dirname, '../../VERSION'),
    '/app/VERSION',
  ];
  for (const p of candidates) {
    try {
      const raw = fs.readFileSync(p, 'utf8').trim();
      if (raw) {
        cached = raw;
        return raw;
      }
    } catch {}
  }
  return '0.0.0';
}

function parseVersion(v) {
  const fail = { format: 'semver', major: 0, minor: 0, patch: 0, prerelease: null, build: null, raw: String(v || '') };
  if (!v || typeof v !== 'string') return fail;
  const s = v.trim();

  // Semver M.m.p[-prerelease][+buildmeta]
  const semverMatch = s.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (semverMatch) {
    const [, M, m, p, pre] = semverMatch;
    return {
      format: 'semver',
      major: parseInt(M, 10),
      minor: parseInt(m, 10),
      patch: parseInt(p, 10),
      prerelease: pre ? pre.split('.').map(part => /^\d+$/.test(part) ? parseInt(part, 10) : part) : null,
      build: null,
      raw: s,
    };
  }

  // Legacy four-part M.m.p.b
  const legacyMatch = s.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (legacyMatch) {
    const [, M, m, p, b] = legacyMatch;
    return {
      format: 'legacy',
      major: parseInt(M, 10),
      minor: parseInt(m, 10),
      patch: parseInt(p, 10),
      prerelease: null,
      build: parseInt(b, 10),
      raw: s,
    };
  }

  return fail;
}

function compareVersions(aIn, bIn) {
  const a = typeof aIn === 'string' ? parseVersion(aIn) : aIn;
  const b = typeof bIn === 'string' ? parseVersion(bIn) : bIn;

  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;

  // Same M.m.p. Rank: 0=prerelease (lowest), 1=legacy-build, 2=stable (highest)
  const aRank = rankRelease(a);
  const bRank = rankRelease(b);
  if (aRank !== bRank) return aRank < bRank ? -1 : 1;

  if (aRank === 2) {
    // Both legacy-build: compare build numbers numerically.
    return a.build < b.build ? -1 : a.build > b.build ? 1 : 0;
  }
  if (aRank === 0) {
    // Both prerelease: per-identifier compare per semver spec.
    return comparePrerelease(a.prerelease, b.prerelease);
  }
  // Both stable.
  return 0;
}

function rankRelease(v) {
  // Rank order at the same M.m.p:
  //   0 = semver prerelease (lowest)   — 1.0.0-beta.1
  //   1 = semver stable                — 1.0.0
  //   2 = legacy build (highest)        — 1.0.0.5 = "post-1.0.0 build 5"
  //
  // The legacy build counter was historically used as a fourth dotted
  // component AFTER a notional stable version. So 1.1.1.3 means
  // "the third post-1.1.1 build during the legacy era." It must
  // therefore rank above 1.1.1 stable (and above 1.1.1-beta.x).
  // Higher M.m.p still wins regardless: 1.1.2 > 1.1.1.99.
  if (v.prerelease !== null) return 0;
  if (v.build !== null) return 2;
  return 1;
}

function comparePrerelease(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const aNum = typeof a[i] === 'number';
    const bNum = typeof b[i] === 'number';
    if (aNum && bNum) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    } else if (aNum && !bNum) {
      return -1;
    } else if (!aNum && bNum) {
      return 1;
    } else {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
  }
  return 0;
}

function formatVersion(v) {
  if (typeof v === 'string') return v;
  if (!v) return '0.0.0';
  if (v.raw) return v.raw;
  if (v.format === 'legacy') {
    return `${v.major}.${v.minor}.${v.patch}.${v.build}`;
  }
  let out = `${v.major}.${v.minor}.${v.patch}`;
  if (v.prerelease) out += '-' + v.prerelease.join('.');
  return out;
}

function parseFilenameVersion(filename) {
  if (!filename || typeof filename !== 'string') return null;

  // Semver: musicd-1.2.3 or musicd-1.2.3-beta.1
  const semverMatch = filename.match(/^musicd-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.tar(?:\.gz)?$/i);
  if (semverMatch) {
    return parseVersion(semverMatch[1]);
  }

  // Legacy: musicd-v1-1-1-3.tar
  const legacyMatch = filename.match(/^musicd-v(\d+)-(\d+)-(\d+)-(\d+)\.tar(?:\.gz)?$/i);
  if (legacyMatch) {
    return parseVersion(`${legacyMatch[1]}.${legacyMatch[2]}.${legacyMatch[3]}.${legacyMatch[4]}`);
  }

  return null;
}

function tarFilenameFor(versionInput) {
  const v = typeof versionInput === 'string' ? parseVersion(versionInput) : versionInput;
  if (v.format === 'legacy') {
    return `musicd-v${v.major}-${v.minor}-${v.patch}-${v.build}.tar`;
  }
  return `musicd-${formatVersion(v)}.tar`;
}

module.exports = {
  getVersion,
  parseVersion,
  compareVersions,
  formatVersion,
  parseFilenameVersion,
  tarFilenameFor,
};
