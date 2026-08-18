const express = require('express');
const router = express.Router();
const updater = require('../updater');
const remoteUpdater = require('../remoteUpdater');
const version = require('../version');
const db = require('../db');
const tierConfig = require('../tierConfig');

// v1.1.1.3 — tier/channel helpers used by /check, /check-now, and
// the dedicated /tier routes. Reads the persisted tier and channel
// from the settings table, defaulting to demo + stable for fresh
// installs.
function readTier(database) {
  const row = database.prepare("SELECT value FROM settings WHERE key = 'update_tier'").get();
  // v1.1.3.8: floored to tierConfig.DEFAULT_TIER — see normaliseTier.
  return tierConfig.normaliseTier(row?.value);
}

function readChannel(database, tier) {
  const row = database.prepare("SELECT value FROM settings WHERE key = 'update_channel'").get();
  const stored = row?.value;
  const allowed = tierConfig.channelsForTier(tier);
  if (stored && allowed.includes(stored)) return stored;
  return tierConfig.TIER_DEFINITIONS[tier]?.defaultChannel || 'stable';
}

function writeTier(database, tier) {
  database.prepare(`
    INSERT INTO settings (key, value) VALUES ('update_tier', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(tier);
}

function writeChannel(database, channel) {
  database.prepare(`
    INSERT INTO settings (key, value) VALUES ('update_channel', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(channel);
}

// GET /api/update/check — fast cached check.
//
// Returns either:
//   { currentVersion, availableVersion, tarFilename, source, ...}
//     if an update is found (source: 'local' | 'remote')
//   { currentVersion, availableVersion: null }
//     if no update available
//
// Reads the cache only — does not block on a fresh remote fetch.
//
// v1.1.0.73 — opportunistic refresh: if the cached manifest is more
// than 30 minutes stale, kick off a background re-check (no await).
// The HomeScreen poll fires every 60s on the client; this means a
// stuck tester whose manifest cache locked in v69 a week ago will
// see v72 (or whatever's current) within a poll cycle, without
// having to manually hit "Check now."
const REFRESH_AFTER_S = 30 * 60;
router.get('/check', (req, res) => {
  // v1.1.1.3 — channel-aware. Read user's channel from settings;
  // findAvailableUpdate uses it to pick the right manifest entry.
  const database = db.get();
  const tier = readTier(database);
  const channel = readChannel(database, tier);
  const found = updater.findAvailableUpdate(channel);
  // Fire-and-forget refresh if cache is stale.
  try {
    const status = remoteUpdater.getStatus();
    const ageS = status.lastCheck ? (Math.floor(Date.now() / 1000) - status.lastCheck) : Infinity;
    if (ageS > REFRESH_AFTER_S) {
      remoteUpdater.checkNow().catch(e => {
        console.warn('[update] opportunistic refresh failed:', e.message);
      });
    }
  } catch { /* non-fatal */ }
  if (found) return res.json(found);
  res.json({
    currentVersion: version.getVersion(),
    availableVersion: null,
    channel,
  });
});

// POST /api/update/check-now — force an immediate manifest fetch.
router.post('/check-now', async (req, res) => {
  try {
    // v1.1.2.8: opportunistically wipe stale pending tars before
    // checking for updates. "Stale" means older than the running
    // version — typically left over from a failed apply step in an
    // earlier release (the v1.1.2.4 → v1.1.2.5 loop, etc.). Tars at
    // or newer than the running version are kept (they might be a
    // download the user already initiated and is about to install).
    // Errors are logged but don't fail the check; the cleanup is a
    // best-effort housekeeping pass, not a precondition.
    try {
      const cleanup = updater.clearPendingTars({ staleOnly: true });
      if (cleanup.deleted.length > 0) {
        console.log(`[update] check-now cleanup: removed ${cleanup.deleted.length} stale pending tar(s): ${cleanup.deleted.join(', ')}`);
      }
      if (cleanup.errors.length > 0) {
        console.warn(`[update] check-now cleanup encountered errors: ${cleanup.errors.join('; ')}`);
      }
    } catch (e) {
      console.warn('[update] check-now cleanup failed:', e.message);
    }

    await remoteUpdater.checkNow();
    const database = db.get();
    const tier = readTier(database);
    const channel = readChannel(database, tier);
    const found = updater.findAvailableUpdate(channel);
    if (found) return res.json(found);
    res.json({
      currentVersion: version.getVersion(),
      availableVersion: null,
      channel,
      remoteStatus: remoteUpdater.getStatus(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/update/status — full update subsystem status.
// Used by the Settings page to show last-check time, current URL, etc.
router.get('/status', (req, res) => {
  const found = updater.findAvailableUpdate();
  res.json({
    currentVersion: version.getVersion(),
    available: found || null,
    remote: remoteUpdater.getStatus(),
  });
});

// PATCH /api/update/manifest-url — set the configured manifest URL.
router.patch('/manifest-url', express.json(), (req, res) => {
  const { url } = req.body || {};
  const r = remoteUpdater.setManifestUrl(url == null ? '' : String(url));
  if (!r.ok) return res.status(400).json(r);
  res.json({ ok: true });
});

// POST /api/update/run — start the update.
// If the available update came from the remote manifest, this will
// first download the tar into the local downloads dir, then hand off
// to runUpdate() with the standard tarFilename.
router.post('/run', async (req, res) => {
  try {
    const found = updater.findAvailableUpdate();
    if (!found) {
      return res.status(400).json({ error: 'No update available' });
    }

    // Remote source: download the tar first.
    if (found.source === 'remote') {
      console.log(`[update] downloading remote tar: ${found.tarFilename} from ${found.downloadUrl}`);
      const dl = await remoteUpdater.downloadTar(found.downloadUrl, found.tarFilename);
      if (!dl.ok) {
        return res.status(500).json({ error: `download failed: ${dl.error}` });
      }
      console.log(`[update] download complete (${dl.size} bytes), invoking runUpdate`);
    }

    const result = await updater.runUpdate(found.tarFilename, { source: found.source });
    res.status(202).json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/update/log — last update attempt log (for debugging failures)
router.get('/log', (req, res) => {
  const log = updater.getLastUpdateLog();
  res.json({ log });
});

// v1.1.0.73 — POST /api/update/clear-pending. Wipes any pending
// musicd-vX-Y-Z-W.tar files from the local watch dir and the remote
// pending dir, then forces a manifest re-fetch on the way out.
// Recovery path for the stuck-local-tar scenario.
router.post('/clear-pending', async (req, res) => {
  try {
    const summary = updater.clearPendingTars();
    remoteUpdater.checkNow().catch(() => {});
    res.json({ ok: true, ...summary });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/update/changelog — full bundled CHANGELOG.md (#v1.1.0.25).
// Returns the raw markdown for client-side rendering. Cached at the
// module level since the changelog file ships with the build and
// doesn't change at runtime.
const fs = require('fs');
const path = require('path');
let _cachedChangelog = null;

router.get('/changelog', (req, res) => {
  if (_cachedChangelog === null) {
    try {
      // CHANGELOG.md sits at the root of the project. Server runs from
      // /app/server in the container; the changelog is at /app/CHANGELOG.md.
      const p = path.join(__dirname, '..', '..', '..', 'CHANGELOG.md');
      _cachedChangelog = fs.readFileSync(p, 'utf-8');
    } catch (e) {
      _cachedChangelog = '';
      console.warn('[update] CHANGELOG.md not found:', e.message);
    }
  }
  res.type('text/markdown').send(_cachedChangelog || '# No changelog available');
});

// GET /api/update/release-notes — current version's release notes
// (#v1.1.0.25). Parses CHANGELOG.md and returns just the most recent
// version block. Used by the Update screen's "What's in this version"
// panel without making the client download the whole changelog.
router.get('/release-notes', (req, res) => {
  // Reuse the cached changelog body
  if (_cachedChangelog === null) {
    try {
      const p = path.join(__dirname, '..', '..', '..', 'CHANGELOG.md');
      _cachedChangelog = fs.readFileSync(p, 'utf-8');
    } catch {
      _cachedChangelog = '';
    }
  }
  // The changelog uses "## vX.Y.Z.W" as a section marker. Grab the
  // first such block. The first H2 might be "## Earlier versions" or
  // similar -- our format always puts the most recent release first
  // so the simplest correct parser is: from the first "## v" through
  // the next "## ".
  const text = _cachedChangelog || '';
  const startMatch = text.match(/^## v[\d.]+.*$/m);
  if (!startMatch) {
    return res.json({ version: version.getVersion(), notes: null });
  }
  const startIdx = startMatch.index;
  const rest = text.slice(startIdx + startMatch[0].length);
  const nextMatch = rest.match(/^## /m);
  const endIdx = nextMatch ? startIdx + startMatch[0].length + nextMatch.index : text.length;
  const notesSection = text.slice(startIdx, endIdx).trim();
  // Pull the version label out of the heading for the client.
  const verMatch = startMatch[0].match(/v([\d.]+)/);
  res.json({
    version: verMatch ? verMatch[1] : version.getVersion(),
    notes: notesSection,
  });
});

// ─────────────────────────────────────────────────────────────────
// v1.1.1.3 — Tier and channel management
// ─────────────────────────────────────────────────────────────────
//
// The five-tier system gates channel visibility behind 4-digit
// codes. New installs default to demo (no code, sees stable
// channel only, demo feature flags applied). Users enter a code
// in Settings to upgrade their tier; the new tier persists in
// the settings table.
//
// Helpers (readTier/readChannel/writeTier/writeChannel) and the
// db/tierConfig requires live at the top of this file so the
// /check and /check-now routes can use them too.

// GET /api/update/tier — current tier state and what's available
router.get('/tier', (req, res) => {
  const database = db.get();
  const tier = readTier(database);
  const channel = readChannel(database, tier);
  const definition = tierConfig.TIER_DEFINITIONS[tier];
  const availableChannels = tierConfig.channelsForTier(tier);
  const featureFlags = tierConfig.featureFlagsForTier(tier);
  // Manifest channel info, if available — lets the UI show
  // per-channel version + release date next to each option.
  const manifestChannels = remoteUpdater.getAvailableChannels() || {};
  const channelMetadata = remoteUpdater.getChannelMetadata() || {};
  res.json({
    tier,
    tierLabel: definition.label,
    channel,
    channels: availableChannels.map(name => ({
      name,
      label: channelMetadata[name]?.label || name,
      description: channelMetadata[name]?.description || null,
      stability: channelMetadata[name]?.stability || null,
      version: manifestChannels[name]?.version || null,
      releasedAt: manifestChannels[name]?.releasedAt || null,
    })),
    featureFlags,  // null for tiers above demo (no flags = no restrictions)
  });
});

// POST /api/update/tier/code — try a 4-digit code
//
// Body: { code: '7733' }
//
// Validates against the manifest's accessTiers block. On match:
//   - Upgrade ONLY: silently set new tier and switch to that
//     tier's default channel. We block accidental DOWNGRADES
//     because they mean entering a lower-tier code on a
//     higher-tier install (rare, almost certainly a mistake).
//     User must hit /tier/reset first.
//   - Persist tier and channel in settings table.
//
// Errors:
//   400 — body missing code
//   401 — code didn't match any tier
//   409 — code matches a lower tier than currently active
//   503 — manifest not yet fetched (no tiers available to validate)
router.post('/tier/code', express.json(), (req, res) => {
  const code = String(req.body?.code || '').trim();
  if (!/^\d{4}$/.test(code)) {
    return res.status(400).json({ error: 'code must be a 4-digit number' });
  }
  const accessTiers = remoteUpdater.getAccessTiers();
  if (!accessTiers) {
    return res.status(503).json({
      error: 'Update manifest not available yet. Try again after the next manifest check.',
    });
  }
  const newTier = tierConfig.tierForCode(code, accessTiers);
  if (!newTier) {
    return res.status(401).json({ error: 'Invalid code' });
  }
  const database = db.get();
  const currentTier = readTier(database);
  if (tierConfig.tierRank(newTier) < tierConfig.tierRank(currentTier)) {
    return res.status(409).json({
      error: `You are currently on a higher tier (${currentTier}). Use Reset to demo first if you want to switch down.`,
      currentTier,
      attemptedTier: newTier,
    });
  }
  writeTier(database, newTier);
  // Switch to new tier's default channel automatically — most users
  // entering a beta code want to be ON beta, not lingering on stable.
  const defaultChannel = tierConfig.TIER_DEFINITIONS[newTier]?.defaultChannel || 'stable';
  writeChannel(database, defaultChannel);
  console.log(`[tier] upgraded ${currentTier} → ${newTier}, channel → ${defaultChannel}`);
  res.json({
    ok: true,
    tier: newTier,
    tierLabel: tierConfig.TIER_DEFINITIONS[newTier].label,
    channel: defaultChannel,
  });
});

// POST /api/update/tier/reset — drop back to the baseline tier
//
// v1.1.3.8: resets to tierConfig.DEFAULT_TIER rather than demo. Demo
// is unreachable by baseline, and resetting into it would only be
// undone by the next normaliseTier() read anyway. The endpoint keeps
// its real purpose: stepping down from a higher tier so a lower code
// can be entered without tripping the 409 downgrade guard.
router.post('/tier/reset', (req, res) => {
  const database = db.get();
  const previous = readTier(database);
  const base = tierConfig.DEFAULT_TIER;
  const baseChannel = tierConfig.TIER_DEFINITIONS[base]?.defaultChannel || 'stable';
  writeTier(database, base);
  writeChannel(database, baseChannel);
  console.log(`[tier] reset ${previous} → ${base}`);
  res.json({ ok: true, tier: base, channel: baseChannel });
});

// POST /api/update/channel — switch channel within current tier
//
// Body: { channel: 'beta' }
//
// The channel must be in the user's tier's allowed list. Otherwise
// 403. (A demo user can't switch to beta without first entering
// the beta code.)
router.post('/channel', express.json(), (req, res) => {
  const channel = String(req.body?.channel || '').trim();
  if (!channel) return res.status(400).json({ error: 'channel required' });
  const database = db.get();
  const tier = readTier(database);
  const allowed = tierConfig.channelsForTier(tier);
  if (!allowed.includes(channel)) {
    return res.status(403).json({
      error: `Channel "${channel}" not available on tier "${tier}". Allowed: ${allowed.join(', ')}.`,
    });
  }
  writeChannel(database, channel);
  console.log(`[tier] channel set to ${channel} (tier=${tier})`);
  res.json({ ok: true, tier, channel });
});

module.exports = router;
