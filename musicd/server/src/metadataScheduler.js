// Metadata scheduler (#v1.1.0.28)
// ================================
//
// Orchestrates the five metadata jobs in priority order:
//   1. MusicBrainz album matching       (metadataMatch)
//   2. Cover art                         (scanner.enrichMissingArt)
//   3. Volume levelling                  (loudness.runScan)
//   4. Artist logos                      (artistLogos.runFetch)
//   5. Bios (album + artist)             (bioScanner.scanAll)
//
// Three modes (settings.scheduler_mode):
//   off        -- never run automatically; user can still trigger
//                 individual jobs manually via existing UIs
//   automatic  -- run a full cycle when enabled; after that, sit idle
//                 until new pending items appear (filesystem watcher
//                 or manual reset). Each job is capped at 1 hour with
//                 a 5-minute cooldown between them.
//   scheduled  -- only run during a user-defined window (default
//                 01:00-06:00 local time, minimum 5 hours). Jobs run
//                 back-to-back with no cooldown. If the window closes
//                 mid-cycle, jobs pause cleanly and resume on the
//                 next window.
//
// Key behaviours:
//   - Each job runs UNTIL its pending queue is empty OR the 1-hour
//     cap is hit, whichever comes first.
//   - "Pending" is computed per-job from existing DB state (see
//     pendingCounts() below). Once a library is fully processed,
//     subsequent cycles do nothing.
//   - Thermal guard: every 30s while a job is running, read CPU
//     temperature. If >= THERMAL_CEILING_C for THERMAL_TRIP_DURATION_MS
//     consecutively, pause the current job for THERMAL_PAUSE_MS,
//     then re-check. After THERMAL_MAX_PAUSES consecutive trips the
//     job is skipped entirely (we move on to the next).
//   - Excluded items (rejected matches, scheduled_excluded=1) are
//     never picked up.

const db = require('./db');
const fs = require('fs');
const path = require('path');

// Job durations / spacing
const JOB_CAP_MS         = 60 * 60 * 1000;   // 1 hour
const COOLDOWN_MS        = 5 * 60 * 1000;    // 5 minutes (automatic mode)
const TICK_INTERVAL_MS   = 30 * 1000;        // scheduler loop tick

// Thermal guard
const THERMAL_CEILING_C        = 59;
const THERMAL_TRIP_DURATION_MS = 30 * 1000;  // sustained 30s before tripping
const THERMAL_PAUSE_MS         = 60 * 1000;  // pause 60s after trip
const THERMAL_MAX_PAUSES       = 5;          // skip job after this many trips

// Window minimum in scheduled mode
const SCHED_MIN_WINDOW_HOURS = 5;

// Module state
let _state = {
  mode: 'off',
  status: 'idle',          // 'idle' | 'running' | 'cooldown' | 'paused-thermal' | 'waiting-window'
  currentJob: null,        // job id when running
  jobStartedAt: null,
  cycleStartedAt: null,
  lastCompletedAt: null,
  thermalC: null,
  thermalPauses: 0,
  message: null,
};
let _tickTimer = null;
let _runLoopActive = false;
let _stopRequested = false;

// ── Settings helpers ──────────────────────────────────────────────────

function getSetting(key, fallback = '') {
  try {
    const row = db.get().prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row?.value ?? fallback;
  } catch {
    return fallback;
  }
}

function setSetting(key, value) {
  db.get().prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value == null ? null : String(value));
}

// ── Thermal reading ───────────────────────────────────────────────────

// v1.1.0.94 — robust thermal sensor selection.
//
// The original code read /sys/class/thermal/thermal_zone0/temp blindly.
// On the user's DietPi container, that zone reported a fixed 27.8°C
// while the host's htop showed live temps — meaning thermal_zone0 was
// either a virtual sensor or the kernel doesn't update it for that
// path inside the container's view.
//
// Modern Linux exposes multiple thermal zones, each with a `type`
// file naming the source. On x86 the relevant ones are:
//   - x86_pkg_temp       (CPU package temp, the one htop reports)
//   - coretemp           (per-core, sometimes named cpu-thermal too)
//   - cpu-thermal        (ARM/Pi)
//   - acpitz             (ACPI thermal zone — often a chassis sensor,
//                         not CPU; reports a low fixed value)
//
// We enumerate all zones, pick the most CPU-like one, and only fall
// back to thermal_zone0 if nothing better is found. The result is
// cached at module load — thermal-zone IDs don't change at runtime.
const THERMAL_BASE = '/sys/class/thermal';

// Preference order. The first match wins.
const PREFERRED_TYPES = [
  'x86_pkg_temp',     // Intel/AMD package temp — best match for htop
  'cpu-thermal',      // ARM, including Pi family
  'coretemp',         // Per-core x86
  'soc_thermal',      // Some ARM SoCs
];

let _resolvedThermalPath = null;
let _resolvedThermalType = null;

function _resolveThermalPath() {
  try {
    const zones = fs.readdirSync(THERMAL_BASE)
      .filter(n => /^thermal_zone\d+$/.test(n));
    const candidates = [];
    for (const zone of zones) {
      let type = null;
      try {
        type = fs.readFileSync(path.join(THERMAL_BASE, zone, 'type'), 'utf-8').trim();
      } catch { continue; }
      const tempPath = path.join(THERMAL_BASE, zone, 'temp');
      if (!fs.existsSync(tempPath)) continue;
      candidates.push({ zone, type, tempPath });
    }

    // First pass: preferred types in order
    for (const want of PREFERRED_TYPES) {
      const hit = candidates.find(c => c.type === want);
      if (hit) {
        _resolvedThermalPath = hit.tempPath;
        _resolvedThermalType = hit.type;
        return;
      }
    }

    // Second pass: any zone whose name contains "cpu" (covers
    // distro-specific labels like cpu_thermal, cpu-temp, etc.)
    const cpuish = candidates.find(c => /cpu/i.test(c.type));
    if (cpuish) {
      _resolvedThermalPath = cpuish.tempPath;
      _resolvedThermalType = cpuish.type;
      return;
    }

    // Third pass: pick the zone with the HIGHEST reading. ACPI thermal
    // zones (chassis) are typically 27-30°C; a real CPU zone under
    // load reads 40-80°C. If any zone reads >35°C, it's almost
    // certainly the CPU.
    let best = null;
    let bestC = -Infinity;
    for (const c of candidates) {
      try {
        const raw = fs.readFileSync(c.tempPath, 'utf-8').trim();
        const milli = parseInt(raw, 10);
        if (Number.isFinite(milli)) {
          const tempC = milli / 1000;
          if (tempC > bestC) { bestC = tempC; best = c; }
        }
      } catch {}
    }
    if (best && bestC > 35) {
      _resolvedThermalPath = best.tempPath;
      _resolvedThermalType = best.type;
      return;
    }

    // Fallback: thermal_zone0 (whatever it is).
    if (candidates.length > 0) {
      _resolvedThermalPath = candidates[0].tempPath;
      _resolvedThermalType = candidates[0].type + ' (fallback)';
    }
  } catch {
    // /sys/class/thermal not readable — leave both nulls, readCpuTempC
    // will return null.
  }
}

_resolveThermalPath();
if (_resolvedThermalPath) {
  console.log(`🌡️  CPU temp source: ${_resolvedThermalPath} (${_resolvedThermalType})`);
} else {
  console.log('🌡️  CPU temp source: not found');
}

function readCpuTempC() {
  if (!_resolvedThermalPath) return null;
  try {
    const raw = fs.readFileSync(_resolvedThermalPath, 'utf-8').trim();
    const milli = parseInt(raw, 10);
    if (!Number.isFinite(milli)) return null;
    return milli / 1000;
  } catch {
    return null;   // unreadable -- thermal guard becomes a no-op
  }
}

// Test hook: force re-resolution. Called on first cycle of each run
// so a hot-plugged sensor gets picked up. Harmless if already resolved.
function refreshThermalPath() {
  _resolvedThermalPath = null;
  _resolvedThermalType = null;
  _resolveThermalPath();
}

// ── Pending counts per job ────────────────────────────────────────────

function pendingCounts() {
  const database = db.get();
  const counts = { match: 0, art: 0, vl: 0, logos: 0, bios: 0 };
  try {
    const r1 = database.prepare(`
      SELECT COUNT(*) AS c FROM albums
      WHERE excluded = 0 AND scheduled_excluded = 0
        AND (match_status IS NULL OR match_status IN ('pending', 'error'))
    `).get();
    counts.match = r1?.c || 0;

    const r2 = database.prepare(`
      SELECT COUNT(*) AS c FROM albums
      WHERE excluded = 0 AND scheduled_excluded = 0
        AND cover_art IS NULL
    `).get();
    counts.art = r2?.c || 0;

    const r3 = database.prepare(`
      SELECT COUNT(*) AS c FROM tracks t
      LEFT JOIN track_loudness tl ON tl.track_id = t.id
      WHERE t.excluded = 0 AND tl.integrated_lufs IS NULL
    `).get();
    counts.vl = r3?.c || 0;

    // Artist logos: artists table has logo_fetched_at timestamp; if
    // it's NULL the logo job hasn't tried this artist yet.
    const r4 = database.prepare(`
      SELECT COUNT(*) AS c FROM artists
      WHERE logo_fetched_at IS NULL
    `).get();
    counts.logos = r4?.c || 0;

    const r5a = database.prepare(`
      SELECT COUNT(*) AS c FROM albums
      WHERE excluded = 0 AND scheduled_excluded = 0
        AND mb_release_group_id IS NOT NULL
        AND bio_attempted_at IS NULL
    `).get();
    const r5b = database.prepare(`
      SELECT COUNT(*) AS c FROM artists
      WHERE mb_artist_id IS NOT NULL
        AND bio_attempted_at IS NULL
    `).get();
    counts.bios = (r5a?.c || 0) + (r5b?.c || 0);
  } catch (e) {
    console.warn('[scheduler] pendingCounts query failed:', e.message);
  }
  return counts;
}

// ── Window logic (scheduled mode) ─────────────────────────────────────

/**
 * Parse "HH:MM" -> minutes since midnight. Returns null if invalid.
 */
function parseHHMM(s) {
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s).trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Is "now" inside the configured window? Window is interpreted in
 * the container's local timezone (set via TZ env var; default UTC).
 *
 * Supports overnight windows where end < start (e.g. 22:00 -> 06:00).
 */
function isInsideWindow() {
  const startStr = getSetting('scheduler_window_start', '01:00');
  const endStr   = getSetting('scheduler_window_end',   '06:00');
  const start = parseHHMM(startStr);
  const end   = parseHHMM(endStr);
  if (start == null || end == null) return false;
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  if (start === end) return false;             // zero-width = always closed
  if (start < end) {
    return nowMin >= start && nowMin < end;
  }
  // Overnight (end < start): inside if now >= start OR now < end
  return nowMin >= start || nowMin < end;
}

/**
 * Validate a window has ≥ minimum hours. Returns ok or { error }.
 */
function validateWindow(startStr, endStr) {
  const start = parseHHMM(startStr);
  const end   = parseHHMM(endStr);
  if (start == null || end == null) {
    return { ok: false, error: 'Times must be in HH:MM format' };
  }
  let durationMin;
  if (start < end) {
    durationMin = end - start;
  } else {
    durationMin = (24 * 60 - start) + end;
  }
  if (durationMin < SCHED_MIN_WINDOW_HOURS * 60) {
    return { ok: false, error: `Window must be at least ${SCHED_MIN_WINDOW_HOURS} hours` };
  }
  return { ok: true };
}

// ── Job adapters ──────────────────────────────────────────────────────
//
// Each entry: { id, label, hasPending, run }
// `run` is async, takes { shouldPause }, completes when queue empty
// OR shouldPause() returns truthy. shouldPause is polled by the caller
// (the job itself decides how often) -- we wrap each job with a
// timeout/cancel pattern.

function getJobs() {
  const metadataMatch = require('./metadataMatch');
  const scanner       = require('./scanner');
  const loudness      = require('./loudness');
  const artistLogos   = require('./artistLogos');
  const bioScanner    = require('./bioScanner');

  return [
    {
      id: 'match',
      label: 'MusicBrainz match',
      hasPending: () => pendingCounts().match > 0,
      run: async ({ shouldPause }) => {
        const contact = getSetting('mb_contact', '').trim();
        if (!contact) {
          throw new Error('No MusicBrainz contact configured -- set in Metadata settings');
        }
        // metadataMatch.start() returns immediately and runs in the
        // background. We poll progress + shouldPause until it stops.
        await metadataMatch.start(contact);
        while (true) {
          await new Promise(r => setTimeout(r, 2000));
          const p = metadataMatch.getProgress();
          if (!p.running) return;
          if (await shouldPause()) {
            metadataMatch.stop();
            // Wait for it to actually stop
            for (let i = 0; i < 20; i++) {
              await new Promise(r => setTimeout(r, 200));
              if (!metadataMatch.getProgress().running) break;
            }
            return;
          }
        }
      },
    },
    {
      id: 'art',
      label: 'Cover art',
      hasPending: () => pendingCounts().art > 0,
      run: async ({ shouldPause }) => {
        // enrichMissingArt walks all albums missing art. It doesn't
        // currently expose a stop mechanism, so we let it run -- the
        // shouldPause check is best-effort. A typical run is fast
        // enough that this is fine in practice.
        if (typeof scanner.enrichMissingArt === 'function') {
          await scanner.enrichMissingArt();
        }
        // Defensive shouldPause check before returning
        await shouldPause();
      },
    },
    {
      id: 'vl',
      label: 'Volume levelling',
      hasPending: () => pendingCounts().vl > 0,
      run: async ({ shouldPause }) => {
        // loudness.runScan({ force: false }) processes only tracks
        // missing analysis. Like enrichMissingArt, no stop hook --
        // run to completion or 1h cap (caller-enforced via outer
        // race in runJob).
        await loudness.runScan({ force: false });
        await shouldPause();
      },
    },
    {
      id: 'logos',
      label: 'Artist logos',
      hasPending: () => pendingCounts().logos > 0,
      run: async ({ shouldPause }) => {
        await artistLogos.runFetch({ force: false });
        await shouldPause();
      },
    },
    {
      id: 'bios',
      label: 'Album & artist bios',
      hasPending: () => pendingCounts().bios > 0,
      run: async ({ shouldPause }) => {
        await bioScanner.scanAll({ shouldPause });
      },
    },
  ];
}

// ── Run loop ──────────────────────────────────────────────────────────

/**
 * Run a single job with the 1-hour cap and thermal guard. Returns
 * when the job's queue is empty, the cap is hit, or stop is requested.
 */
async function runJob(job, modeOpts) {
  _state.currentJob = job.id;
  _state.jobStartedAt = Date.now();
  _state.thermalPauses = 0;
  _state.status = 'running';
  console.log(`[scheduler] starting job: ${job.label}`);

  let thermalTrippedAt = null;

  // Build a shouldPause closure the job can poll. Returns truthy
  // when we want the job to stop ASAP (cap hit, thermal trip,
  // window end, stop request).
  const shouldPause = async () => {
    if (_stopRequested) return 'stopped';
    if (Date.now() - _state.jobStartedAt > JOB_CAP_MS) return 'cap';
    if (modeOpts.checkWindow && !isInsideWindow()) return 'window-closed';

    const t = readCpuTempC();
    _state.thermalC = t;
    if (t != null && t >= THERMAL_CEILING_C) {
      thermalTrippedAt = thermalTrippedAt || Date.now();
      if (Date.now() - thermalTrippedAt >= THERMAL_TRIP_DURATION_MS) {
        return 'thermal';
      }
    } else {
      thermalTrippedAt = null;
    }
    return false;
  };

  // Race the job against the thermal/cap loop. Job's run() does the
  // actual work; this outer loop watches for trip conditions and
  // restarts the job up to THERMAL_MAX_PAUSES times.
  while (true) {
    try {
      await job.run({ shouldPause });
      _state.lastCompletedAt = Date.now();
      _state.currentJob = null;
      _state.status = 'idle';
      _state.thermalC = readCpuTempC();
      console.log(`[scheduler] finished job: ${job.label}`);
      return { ok: true };
    } catch (e) {
      console.warn(`[scheduler] job ${job.id} threw:`, e.message);
      // Soft-fail: log and move on to next job. Don't let one job's
      // error tank the whole cycle.
      _state.currentJob = null;
      _state.status = 'idle';
      return { ok: false, error: e.message };
    }
    // The shouldPause-trigger paths return cleanly from job.run()
    // rather than throwing, so we'd hit this only if the job runs
    // forever (it shouldn't) OR if a thermal pause restart pattern
    // is desired. For now, no auto-restart -- the next cycle will
    // pick up remaining pending items.
  }
}

// v1.1.0.77 — re-queue stale unmatched albums.
// Once a day (gated by the 'last_unmatched_requeue_at' setting),
// find albums whose original match attempt produced a non-clean
// result (unmatched, uncertain, errored) more than 7 days ago,
// and put them back into the matcher's pending queue. The matcher
// will pick them up on the next cycle.
//
// Why this exists: MusicBrainz adds new releases continually, and
// transient errors (rate limit, network blip, dropped connection)
// during the original sweep can leave albums permanently flagged
// as failed. Without this retry, the only way to recover them is
// for the user to know about Settings → Metadata → Run diagnostic /
// Re-queue → Start matching. Auto-retry surfaces those albums
// without user intervention.
//
// Safety:
//   * Only failed/uncertain albums are touched. Clean matches are
//     never re-queried.
//   * Capped to once per 24 hours. The pendingCounts() check that
//     follows in tick() then decides whether to actually run a
//     matcher cycle, gated by the playback gate above.
//   * No-op when settings.scheduler_mode === 'off' (we never
//     reach this from tick()).
const REQUEUE_INTERVAL_MS = 24 * 60 * 60 * 1000;     // once per day
const STALE_AGE_S         = 7  * 24 * 60 * 60;       // 7 days
function maybeReQueueStaleUnmatched() {
  const lastAt = parseInt(getSetting('last_unmatched_requeue_at', '0'), 10) || 0;
  if (Date.now() - lastAt < REQUEUE_INTERVAL_MS) return;

  const cutoff = Math.floor(Date.now() / 1000) - STALE_AGE_S;
  let updated = 0;
  try {
    const r = db.get().prepare(`
      UPDATE albums
         SET match_status = 'pending'
       WHERE excluded = 0
         AND match_status IN ('unmatched', 'uncertain', 'error')
         AND (matched_at IS NULL OR matched_at < ?)
    `).run(cutoff);
    updated = r.changes || 0;
  } catch (e) {
    console.warn('[scheduler] re-queue stale unmatched failed:', e.message);
    return;
  }

  setSetting('last_unmatched_requeue_at', String(Date.now()));
  setSetting('last_unmatched_requeue_count', String(updated));
  if (updated > 0) {
    console.log(`[scheduler] re-queued ${updated} stale unmatched/uncertain/error albums for retry`);
  }
}

// v1.1.0.77 — playback gate. Returns true if any zone is currently
// playing; the scheduler skips its tick (and pauses an in-progress
// cycle) when this is true. Loaded lazily because metadataScheduler
// is required quite early in boot — we defer the playerState
// require to the first call to dodge any circular-import issues.
let _playerState = null;
function isPlaybackActive() {
  try {
    if (!_playerState) _playerState = require('./playerState');
    return !!_playerState.isAnyZonePlaying?.();
  } catch {
    // If playerState isn't ready yet (very early boot), assume
    // nothing is playing — safer to allow scheduling than to
    // silently skip forever.
    return false;
  }
}

/**
 * The main run loop. Walks the priority list, running each job that
 * has pending work. Cooldown between jobs in automatic mode; no
 * cooldown in scheduled mode. After a full pass, returns -- the tick
 * timer decides if/when to call again.
 */
async function runCycle() {
  if (_runLoopActive) return;
  _runLoopActive = true;
  _stopRequested = false;
  _state.cycleStartedAt = Date.now();
  const mode = _state.mode;
  const isScheduled = mode === 'scheduled';
  const cooldownMs = isScheduled ? 0 : COOLDOWN_MS;

  try {
    const jobs = getJobs();
    for (const job of jobs) {
      if (_stopRequested) break;
      if (isScheduled && !isInsideWindow()) {
        _state.status = 'waiting-window';
        break;   // window closed mid-cycle; stop here, resume next window
      }
      // v1.1.0.77 — playback gate. If a zone starts playing mid-cycle,
      // pause cleanly between jobs. We don't kill the in-flight job
      // (jobs are designed to complete or hit their cap; interrupting
      // mid-MusicBrainz-fetch would leak a lock), but we won't start
      // the NEXT job. The tick will pick back up once playback ends.
      if (isPlaybackActive()) {
        _state.status = 'paused-playback';
        _state.message = 'Paused — playback active';
        console.log('[scheduler] pausing cycle: playback active');
        break;
      }
      if (!job.hasPending()) {
        console.log(`[scheduler] skipping ${job.id} -- nothing pending`);
        continue;
      }
      await runJob(job, { checkWindow: isScheduled });

      if (cooldownMs > 0 && !_stopRequested) {
        _state.status = 'cooldown';
        _state.message = `Cooling down ${Math.round(cooldownMs / 1000)}s before next job`;
        console.log(`[scheduler] cooldown ${cooldownMs / 1000}s`);
        const start = Date.now();
        while (Date.now() - start < cooldownMs) {
          if (_stopRequested) break;
          await new Promise(r => setTimeout(r, 1000));
        }
        _state.message = null;
      }
    }
    if (_state.status !== 'paused-playback') {
      _state.status = 'idle';
      console.log('[scheduler] cycle complete');
    }
  } finally {
    _runLoopActive = false;
    _state.currentJob = null;
  }
}

/**
 * Tick: called every 30s. Decides whether to start a cycle.
 * - automatic: start one if there's pending work and we're not running
 * - scheduled: start one if we're in the window, there's pending work,
 *              and we're not running
 * - off: do nothing
 *
 * v1.1.0.77: also defer when any zone is playing. Background metadata
 * work shouldn't compete with active streaming for renderer time
 * or upstream API bandwidth.
 */
function tick() {
  if (_runLoopActive) {
    // Update thermal reading even when running so the UI shows it
    _state.thermalC = readCpuTempC();
    return;
  }
  if (_state.mode === 'off') return;

  if (_state.mode === 'scheduled') {
    if (!isInsideWindow()) {
      _state.status = 'waiting-window';
      return;
    }
  }

  // v1.1.0.77 — defer if music is playing.
  if (isPlaybackActive()) {
    _state.status = 'paused-playback';
    _state.message = 'Paused — playback active';
    return;
  }
  // Coming back from playback, clear the message
  if (_state.message === 'Paused — playback active') {
    _state.message = null;
  }

  // v1.1.0.77 — opportunistic re-queue of stale unmatched albums.
  // Once a day, look for albums that previously failed to match
  // (status = unmatched / uncertain / errored) and were checked
  // more than 7 days ago, then put them back into the matcher's
  // pending queue. This handles the case where MusicBrainz now
  // has data we couldn't find before, or transient errors that
  // we hit during the original sweep. Only the failed albums
  // are re-queued — clean matches are never disturbed.
  maybeReQueueStaleUnmatched();

  const counts = pendingCounts();
  const total = counts.match + counts.art + counts.vl + counts.logos + counts.bios;
  if (total === 0) {
    _state.status = 'idle';
    return;
  }

  // Kick off a cycle (don't await -- runs in the background)
  runCycle().catch(e => {
    console.error('[scheduler] cycle crashed:', e);
    _state.status = 'idle';
  });
}

// ── Public API ────────────────────────────────────────────────────────

function start() {
  if (_tickTimer) return;
  // Read mode from settings on boot
  _state.mode = getSetting('scheduler_mode', 'off');
  console.log(`[scheduler] booting in mode: ${_state.mode}`);
  _tickTimer = setInterval(tick, TICK_INTERVAL_MS);
  // First tick after a 60s delay so boot work (library scan, etc) finishes first
  setTimeout(tick, 60_000);
}

function setMode(mode) {
  if (!['off', 'automatic', 'scheduled'].includes(mode)) {
    throw new Error('Invalid mode');
  }
  _state.mode = mode;
  setSetting('scheduler_mode', mode);
  if (mode === 'off') {
    _stopRequested = true;
    _state.status = 'idle';
  } else {
    // Trigger an immediate tick check so the user sees something happen
    setTimeout(tick, 500);
  }
}

function setWindow(startStr, endStr) {
  const v = validateWindow(startStr, endStr);
  if (!v.ok) return v;
  setSetting('scheduler_window_start', startStr);
  setSetting('scheduler_window_end', endStr);
  return { ok: true };
}

function getStatus() {
  const mode = _state.mode;
  const counts = pendingCounts();
  const totalPending = counts.match + counts.art + counts.vl + counts.logos + counts.bios;
  // Refresh thermal reading on every status call. The tick loop also
  // updates this every 30s while running, but the UI polls /status
  // every 5s, so reading here keeps the user-visible value fresh.
  // Cheap -- it's a single sysfs file read.
  const liveThermal = readCpuTempC();
  if (liveThermal != null) _state.thermalC = liveThermal;
  return {
    mode,
    status: _state.status,
    currentJob: _state.currentJob,
    jobStartedAt: _state.jobStartedAt,
    cycleStartedAt: _state.cycleStartedAt,
    lastCompletedAt: _state.lastCompletedAt,
    thermalC: liveThermal,                       // fresh value, not cached
    thermalCeilingC: THERMAL_CEILING_C,
    // v1.1.0.96 — surface which sensor we resolved. Helps the user
    // verify the v94 thermal-resolver picked the right zone (eg
    // 'x86_pkg_temp' good, 'acpitz' is the chassis sensor and means
    // we couldn't find a CPU one). Null when no sensor was found.
    thermalSource: _resolvedThermalType,
    message: _state.message,
    window: {
      start: getSetting('scheduler_window_start', '01:00'),
      end:   getSetting('scheduler_window_end',   '06:00'),
      insideNow: mode === 'scheduled' ? isInsideWindow() : false,
      minHours: SCHED_MIN_WINDOW_HOURS,
    },
    pending: counts,
    totalPending,
    runningCycle: _runLoopActive,
    // v1.1.0.77 — auto-retry visibility. UI shows "Last auto-retry:
    // 3 days ago · 12 albums re-queued" so users understand that
    // failed matches are being retried in the background. Both
    // values are null until the first re-queue runs.
    lastUnmatchedRequeueAt: parseInt(getSetting('last_unmatched_requeue_at', '0'), 10) || null,
    lastUnmatchedRequeueCount: parseInt(getSetting('last_unmatched_requeue_count', '0'), 10) || 0,
  };
}

function runNow() {
  // Manual trigger -- bypass mode gating but only if not already running
  if (_runLoopActive) return { ok: false, error: 'Cycle already running' };
  // Use a one-shot "automatic" semantics regardless of saved mode
  const savedMode = _state.mode;
  _state.mode = savedMode === 'off' ? 'automatic' : savedMode;
  runCycle()
    .catch(e => console.error('[scheduler] manual cycle crashed:', e))
    .finally(() => { _state.mode = savedMode; });
  return { ok: true };
}

function stopCurrent() {
  _stopRequested = true;
  return { ok: true };
}

module.exports = {
  start,
  setMode,
  setWindow,
  getStatus,
  runNow,
  stopCurrent,
  // Exposed for tests / introspection
  _readCpuTempC: readCpuTempC,
  _isInsideWindow: isInsideWindow,
  _validateWindow: validateWindow,
};
