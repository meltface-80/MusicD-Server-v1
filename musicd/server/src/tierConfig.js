/**
 * v1.1.1.3 — Tier configuration.
 *
 * Defines the five access tiers, their channel visibility, and
 * the demo tier's feature flags. Tier definitions are mostly
 * static — code hashes live in the manifest because they need
 * to be rotatable without shipping a build, but everything else
 * (which channels each tier can see, what features demo locks)
 * is the contract between server and client and lives here.
 *
 * The salt is fixed and known. It's not a secret — it lives in
 * the source — but it forces an attacker to brute-force the
 * 10,000-code space specifically for MusicD rather than using
 * a generic rainbow table. For a soft commercial gate this is
 * sufficient.
 *
 * Tier hierarchy (ascending):
 *   demo        — unreachable while DEFAULT_TIER is 'stable'
 *   stable      — code 7733 (baseline — every install starts here)
 *   earlyAccess — code 9632
 *   beta        — code 4261
 *   alpha       — code 8417 (in-house only)
 *
 * Higher tiers see all channels of lower tiers.
 *
 * v1.1.3.8 — the demo gate is disabled by baseline, not deleted.
 * DEFAULT_TIER is the floor every install sits on; the demo tier and
 * its feature flags are left defined and intact below so the gate can
 * be restored by setting DEFAULT_TIER back to 'demo'. The four codes
 * still work exactly as before — 7733 is simply already applied.
 */
const crypto = require('crypto');

const TIER_CODE_SALT = 'musicd-v1-tier-';

const TIER_ORDER = ['demo', 'stable', 'earlyAccess', 'beta', 'alpha'];

/**
 * v1.1.3.8 — the baseline tier. No install can sit below this.
 *
 * normaliseTier() floors every read of the settings table to this
 * tier, so a fresh install (no DB row), an install still carrying an
 * explicit 'demo' row, and an install with a corrupted value all
 * resolve here. Set back to 'demo' to re-enable the trial gate.
 */
const DEFAULT_TIER = 'stable';

const TIER_DEFINITIONS = {
  demo: {
    label: 'Demo',
    channels: ['stable'],
    defaultChannel: 'stable',
    requiresCode: false,
  },
  stable: {
    label: 'Stable',
    channels: ['stable'],
    defaultChannel: 'stable',
    isDefault: true,
    requiresCode: true,
  },
  earlyAccess: {
    label: 'Early Access',
    channels: ['stable', 'earlyAccess'],
    defaultChannel: 'earlyAccess',
    requiresCode: true,
  },
  beta: {
    label: 'Beta tester',
    channels: ['stable', 'earlyAccess', 'beta'],
    defaultChannel: 'beta',
    requiresCode: true,
  },
  alpha: {
    label: 'Internal / Developer',
    channels: ['stable', 'earlyAccess', 'beta', 'alpha', 'legacy'],
    defaultChannel: 'beta',
    requiresCode: true,
  },
};

// Demo tier's feature flags. Anything not listed here is implicitly
// allowed for demo. Tiers above demo (stable+) get full access by
// default — no flags needed.
//
// Flag semantics:
//   true   — feature ALLOWED for demo
//   false  — feature BLOCKED for demo
//   number — quantity limit (e.g. library_size_limit: 50)
//
// The server enforces these at the route level; the client also
// reads them to grey out / hide locked UI controls.
const DEMO_FEATURE_FLAGS = {
  // What demo CAN do
  playback: true,
  browse: true,
  search: true,
  settings_read: true,
  initial_scan: true,        // first scan IS allowed; cap kicks in for browsing

  // What demo CANNOT do
  settings_write: false,
  rescan: false,             // can't trigger additional scans after the first
  backup_restore: false,
  scrobbling: false,
  dsp: false,
  multi_zone: false,
  share_links: false,
  fingerprint_match: false,
  manual_metadata_match: false,

  // Quantity limits
  library_size_limit: 50,    // soft cap — server clamps album list to 50
};

/**
 * Hash a 4-digit code with the salt. Returns a hex string.
 * Used both to validate user input against the manifest's hashed
 * codes, and (offline, during release) to compute the hashes the
 * manifest publishes.
 */
function hashCode(code) {
  return crypto.createHash('sha256')
    .update(TIER_CODE_SALT + String(code))
    .digest('hex');
}

/**
 * Given a 4-digit code from user input and the access-tiers block
 * from the manifest, return the tier key the code unlocks, or null
 * if no tier matches.
 *
 * The accessTiers block is expected to look like:
 *   { stable: { codeHash: '...', channels: [...], ... }, ... }
 *
 * Demo tier has no codeHash — it's the default, no entry needed.
 */
function tierForCode(code, accessTiers) {
  if (!code || !accessTiers || typeof accessTiers !== 'object') return null;
  const hashed = hashCode(code);
  for (const [tierName, tierConfig] of Object.entries(accessTiers)) {
    if (tierConfig?.codeHash === hashed) return tierName;
  }
  return null;
}

/**
 * Numeric rank of a tier in TIER_ORDER. Used for "is this tier
 * higher than that one" comparisons (e.g. blocking accidental
 * downgrades).
 */
function tierRank(tierName) {
  const idx = TIER_ORDER.indexOf(tierName);
  return idx === -1 ? 0 : idx;
}

/**
 * v1.1.3.8 — clamp a stored tier name to the permitted range.
 *
 * Returns DEFAULT_TIER when the value is missing, unknown, or ranks
 * below the baseline; otherwise returns the tier unchanged. Every
 * reader of the settings table goes through this, so it is the single
 * place the baseline is enforced.
 */
function normaliseTier(tierName) {
  if (!tierName || !TIER_DEFINITIONS[tierName]) return DEFAULT_TIER;
  if (tierRank(tierName) < tierRank(DEFAULT_TIER)) return DEFAULT_TIER;
  return tierName;
}

/**
 * Given a tier name, return the channels that tier can access.
 * Falls back to the baseline tier's channel list for unknown tiers
 * (defensive — a corrupted DB entry shouldn't unlock anything).
 */
function channelsForTier(tierName) {
  const def = TIER_DEFINITIONS[tierName];
  if (!def) return TIER_DEFINITIONS[DEFAULT_TIER].channels;
  return def.channels;
}

/**
 * Feature flag lookup. For demo tier, returns DEMO_FEATURE_FLAGS.
 * For any tier above demo, returns null (everything allowed).
 */
function featureFlagsForTier(tierName) {
  if (tierName === 'demo') return DEMO_FEATURE_FLAGS;
  return null;
}

/**
 * Convenience: is this feature allowed for the given tier?
 *
 * Returns:
 *   true   — feature allowed
 *   false  — feature blocked
 *   number — quantity limit (caller decides how to enforce)
 *
 * For tiers above demo, always returns true.
 */
function featureAllowed(tierName, featureKey) {
  const flags = featureFlagsForTier(tierName);
  if (!flags) return true;
  if (!(featureKey in flags)) return true;  // unknown flag = allowed
  return flags[featureKey];
}

module.exports = {
  TIER_ORDER,
  TIER_DEFINITIONS,
  DEMO_FEATURE_FLAGS,
  TIER_CODE_SALT,
  DEFAULT_TIER,
  hashCode,
  tierForCode,
  tierRank,
  normaliseTier,
  channelsForTier,
  featureFlagsForTier,
  featureAllowed,
};
