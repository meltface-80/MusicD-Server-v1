const express = require('express');
const router = express.Router();
const loudness = require('../loudness');
const artistLogos = require('../artistLogos');
const tierMiddleware = require('../tierMiddleware');

// GET /api/settings
router.get('/', (req, res) => {
  res.json({
    vl_enabled:       loudness.getSetting('vl_enabled', false),
    vl_target_lufs:   loudness.getSetting('vl_target_lufs', -18),
    vl_mode:          loudness.getSetting('vl_mode', 'track'),
    // v1.1.3.5 — CPU Tweaks settings. Resolved from the same keys
    // the loudness scanner reads at scan-start time, so the UI shows
    // exactly what's in effect for the next scan.
    vl_max_concurrency: loudness.getSetting('vl_max_concurrency', null),
    vl_max_cpu_temp_c:  loudness.getSetting('vl_max_cpu_temp_c', null),
    // MusicBrainz contact (#30.19) -- required for the album matcher.
    // MB's TOS says clients must identify themselves so they can
    // contact us if our app misbehaves. The user fills this in
    // (URL or email); we never default it to anything.
    //
    // The fanart/audiodb/lastfm API keys are no longer per-user
    // settings -- they're baked in (#v1.1.0.23, see apiCredentials.js).
    // We keep their setting rows in the DB harmlessly so old installs
    // aren't disrupted; nothing reads them anymore.
    mb_contact:       loudness.getSetting('mb_contact', ''),
    // v1.1.34.0 — collapse multiple versions of one album (the original,
    // the deluxe, the remaster) into a single tile on the album wall and
    // artist pages. Off by default: an upgrade should not silently
    // change what the library looks like.
    library_group_versions: require('../settings').getBool('library_group_versions', false),
    // v1.1.38.0 — the metadata pipeline's new switches.
    //
    // listenbrainz_token is what makes the fast matching path available
    // at all. ListenBrainz runs MusicBrainz's own fuzzy matcher as a
    // public endpoint, at fifty lookups per request and fifty requests
    // per ten seconds against MusicBrainz's one per second — but it was
    // closed to anonymous callers over AI scraping, so it needs a free
    // account token. With no token the matcher behaves exactly as it did
    // before this release.
    //
    // The token itself is never sent back to the client. A settings page
    // that echoes a credential is a credential in every browser cache and
    // every screenshot; the UI needs to know whether one is SET, not what
    // it is.
    listenbrainz_token_set: require('../settings').get('listenbrainz_token', '') !== '',
    matcher_use_listenbrainz: require('../settings').getBool('matcher_use_listenbrainz', true),
    matcher_use_fingerprint:  require('../settings').getBool('matcher_use_fingerprint', true),
    works_enabled:            require('../settings').getBool('works_enabled', true),
  });
});

// v1.1.1.3 — settings PATCH is gated by settings_write. Demo
// users can read settings but can't change them.
router.patch('/', tierMiddleware.requireFeature('settings_write'), (req, res) => {
  const updates = req.body || {};
  // v1.1.3.5: added vl_max_concurrency and vl_max_cpu_temp_c.
  // These power the new CPU Tweaks settings page.
  const allowed = ['vl_enabled', 'vl_target_lufs', 'vl_mode', 'mb_contact', 'vl_max_concurrency', 'vl_max_cpu_temp_c',
    // v1.1.34.0 — album version grouping toggle.
    'library_group_versions',
    // v1.1.38.0 — metadata pipeline switches. See the GET above.
    'listenbrainz_token', 'matcher_use_listenbrainz',
    'matcher_use_fingerprint', 'works_enabled'];
  // Settings that hold opaque tokens or credentials we paste from
  // external services. Mobile copy-paste sometimes drags in surrounding
  // quotes (smart quotes from rich rendered pages) or trailing whitespace
  // newlines. Strip these on save (#v1.1.0.1). With the lastfm/fanart/
  // audiodb keys baked in, only mb_contact remains in this set.
  // v1.1.38.0 — the ListenBrainz token joins this set for exactly the
  // reason the comment above gives: it is pasted from a web page on a
  // phone, and mobile copy-paste drags in smart quotes and trailing
  // newlines. A token with a trailing newline fails auth with a message
  // that says nothing about whitespace.
  const TRIMMED = new Set(['mb_contact', 'listenbrainz_token']);
  // v1.1.3.5: numeric settings with bounds. Out-of-range values are
  // clamped before write rather than rejected — the UI sliders
  // already enforce bounds, so an out-of-range value here means
  // someone's hand-crafting a request and we just want safety.
  const NUMERIC_BOUNDS = {
    vl_max_concurrency: { min: 1, max: 16 },
    vl_max_cpu_temp_c:  { min: 40, max: 95 },
  };

  // v1.1.0.85 — track which settings change so we know whether to
  // trigger a stream restart. VL settings affect the live audio
  // pipeline; mb_contact does not. We capture the per-key change
  // first, then apply all writes, then decide whether to restart.
  const VL_KEYS = new Set(['vl_enabled', 'vl_target_lufs', 'vl_mode']);
  let vlSettingChanged = false;
  for (const k of allowed) {
    if (!(k in updates)) continue;
    let v = updates[k];
    if (TRIMMED.has(k) && typeof v === 'string') {
      // Strip leading/trailing whitespace AND any leading/trailing
      // straight or smart quotes. We don't strip quotes from inside
      // the value because that could mangle real data; only the ends.
      v = v.replace(/^[\s"'\u201C\u201D\u2018\u2019]+/, '')
           .replace(/[\s"'\u201C\u201D\u2018\u2019]+$/, '');
    }
    if (k in NUMERIC_BOUNDS) {
      const n = parseInt(v, 10);
      if (isNaN(n)) continue;  // silently skip garbage
      v = Math.max(NUMERIC_BOUNDS[k].min, Math.min(NUMERIC_BOUNDS[k].max, n));
    }
    // Compare against current value to detect actual change. A no-op
    // PATCH (e.g. UI re-saves the same value) shouldn't trigger a
    // restart — that would feel like the app interrupting playback
    // for no reason.
    if (VL_KEYS.has(k)) {
      const before = loudness.getSetting(k, undefined);
      // Use loose equality so '−18' (string) and -18 (number) compare
      // equal; the UI sends numbers but older settings values may be
      // stored as strings from manual SQL edits.
      // eslint-disable-next-line eqeqeq
      if (before != v) vlSettingChanged = true;
    }
    // v1.1.34.0 — toggling version grouping changes what the album wall
    // contains, and that list is cached for 30 seconds. Without this the
    // switch appears to do nothing for half a minute, which reads as the
    // setting being broken rather than as a cache.
    if (k === 'library_group_versions') {
      try { require('./library').invalidateCache(); } catch (e) {
        // Router not loaded yet — there is no cache to clear.
      }
    }
    loudness.setSetting(k, v);
  }
  res.json({ ok: true });

  // v1.1.0.85 — fire-and-forget restart of every playing zone when a
  // VL setting actually changed. Async, after the response is sent,
  // so the UI gets immediate feedback ("Saved") and the audio
  // catches up over the next second or two.
  //
  // Without this, toggling VL on or off mid-track left the current
  // track playing with whatever pipeline started it: VL on but
  // disabled in settings → still attenuated; VL off but enabled in
  // settings → still flat. Only the next track picked up the change.
  // The signal path was correctly showing what was actually happening,
  // which made it look like a bug ("VL is on but signal path doesn't
  // show it" or vice versa).
  if (vlSettingChanged) {
    try {
      const playerState = require('../playerState');
      if (typeof playerState.restartAllPlayingZones === 'function') {
        playerState.restartAllPlayingZones()
          .then(count => {
            if (count > 0) console.log(`[settings] VL change → restarted ${count} zone(s)`);
          })
          .catch(e => console.warn('[settings] VL restart failed:', e?.message));
      }
    } catch (e) {
      // Module load failure is non-fatal — settings still saved.
      console.warn('[settings] could not load playerState for restart:', e?.message);
    }
  }
});

// Loudness scan routes (renamed from analyse)
router.get('/loudness/progress', (req, res) => res.json(loudness.getScanProgress()));
router.post('/loudness/scan', (req, res) => {
  const { force } = req.body || {};
  res.json({ ok: true, started: true });
  loudness.runScan({ force }).catch(() => {});
});
router.post('/loudness/abort', (req, res) => {
  loudness.abortScan();
  res.json({ ok: true });
});

// Artist logo controls
router.get('/logos/progress', (req, res) => res.json(artistLogos.getProgress()));
router.post('/logos/run', (req, res) => {
  const { force } = req.body || {};
  res.json({ ok: true, started: true });
  artistLogos.runFetch({ force }).catch(() => {});
});
router.post('/logos/abort', (req, res) => {
  artistLogos.abortRun();
  res.json({ ok: true });
});

// Service health snapshot (#v1.1.0.24). Returns the current
// success/failure state of each external service we depend on.
// Polled by the Settings → Built-in services UI to show status dots.
router.get('/health', (req, res) => {
  const serviceHealth = require('../serviceHealth');
  res.json(serviceHealth.getStatus());
});

// GET /api/settings/cpu — host CPU info + suggested scan limits.
//
// v1.1.3.5 — used by the new "CPU Tweaks" Settings page. Returns
// the auto-detected hardware bucket and SUGGESTED defaults for
// that bucket, alongside the limits actually in use right now.
// The user can choose to apply the suggestions via the regular
// settings UI; nothing is auto-applied.
//
// v1.1.3.6 — also returns sensor diagnostics so the UI can show
// the user which thermal sensor we picked and what other sensors
// were available. This makes "27.8°C is wrong, the CPU is at 56°C"
// debuggable from the UI rather than only from console logs.
router.get('/cpu', (req, res) => {
  const cpuProfile = require('../cpuProfile');
  const loudness = require('../loudness');
  const profile = cpuProfile.detectProfile();
  // Surface what's currently effective so the UI can show "you're
  // running at X / your hardware suggests Y" side by side.
  const status = loudness.getScanProgress();
  const sensorInfo = loudness.getTempSensorInfo();
  res.json({
    detected: {
      bucket: profile.bucket,
      label: profile.label,
      modelName: profile.modelName,
      cores: profile.cores,
    },
    suggested: {
      tempCeiling: profile.tempCeiling,
      concurrency: profile.concurrency,
    },
    current: status.limits,
    cpuTempC: status.cpuTempC,
    sensor: {
      type: sensorInfo.selectedType,
      path: sensorInfo.selectedPath,
      // Only return the `type` and `valueC` for each candidate;
      // the full path is not interesting to the UI and adds noise.
      candidates: sensorInfo.allCandidates.map(c => ({
        type: c.type,
        valueC: c.valueC,
        source: c.source,
      })),
    },
  });
});

// POST /api/settings/restart — restart the musicd server.
//
// v1.1.3.3 — added so the user can recover from misbehaving state
// (a stuck scrobbler, a frozen MusicBrainz fetch, etc.) without
// SSH'ing into the host. Restart works because Docker's restart
// policy is "unless-stopped" by default (set by install.sh), so
// when the Node process exits with code 0, Docker automatically
// brings the container back up. The client polls /api/health until
// the new process is responding and then reloads.
//
// Tier-gated to settings_write — demo users cannot restart the
// server. Restarting drops playback and resets the in-memory state
// (the demo playback timer, when we add one), so it shouldn't be a
// trivial DoS button.
//
// Why a 200ms delay before exit: gives Express time to finish
// flushing the response body so the client sees the 200 OK and
// starts polling /api/health. Without the delay the response and
// the exit race; the client may see a connection-reset before the
// 200 lands.
router.post('/restart', tierMiddleware.requireFeature('settings_write'), (req, res) => {
  console.log('[settings] restart requested via /api/settings/restart');
  res.json({ ok: true, message: 'Server restarting' });
  setTimeout(() => {
    console.log('[settings] exiting now; Docker restart policy will bring us back');
    process.exit(0);
  }, 200);
});

module.exports = router;
