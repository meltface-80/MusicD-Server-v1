/**
 * Loudness Levelling — reads ReplayGain / R128 tags written by r128gain.
 *
 * Pipeline:
 *  1. Read embedded tags: REPLAYGAIN_TRACK_GAIN / REPLAYGAIN_TRACK_PEAK
 *     REPLAYGAIN_ALBUM_GAIN / REPLAYGAIN_ALBUM_PEAK (dB linear)
 *     or R128_TRACK_GAIN / R128_ALBUM_GAIN (Q7.8 fixed-point) from each file.
 *  2. Store track gain, album gain, and true peaks in track_loudness.
 *  3. At stream time, computeStreamGain() returns the dB delta to apply,
 *     honouring the vl_mode setting ('track' | 'album').
 *
 * No ffmpeg or loudgain processes are spawned — r128gain handles all analysis
 * and writes tags before this script is called.
 *
 * Concurrency: up to MAX_CONCURRENCY parallel tag-reads. CPU temperature is
 * checked before dispatching each worker; scanning pauses above MAX_CPU_TEMP_C.
 */

'use strict';

const fs   = require('fs');
const db   = require('./db');
const { parseFile } = require('music-metadata');

// ---- tunables ---------------------------------------------------------------
const TARGET_LUFS_DEFAULT      = -18.0;
// v1.1.3.5: these two used to be hardcoded constants; they're now
// the FALLBACK defaults if the user hasn't set their own. Resolved
// at scan-start time via resolveScanLimits() below, which reads
// the settings table (vl_max_concurrency, vl_max_cpu_temp_c) and
// falls back to these if the keys are missing.
//
// Renamed *_DEFAULT to make it clear these aren't the operative
// values — they're the bottom of the resolution chain.
const MAX_CONCURRENCY_DEFAULT  = 4;   // was 6; conservative new default
const MAX_CPU_TEMP_C_DEFAULT   = 65;  // was 60; modest bump as new default
const TEMP_RECHECK_INTERVAL_MS = 5_000;
const TEMP_THROTTLE_PAUSE_MS   = 8_000;

// ---- settings helpers -------------------------------------------------------
//
// Asymmetric on purpose: setSetting always JSON-stringifies (so we can store
// booleans, numbers, and arrays uniformly), but getSetting falls back to the
// raw text if JSON.parse fails. The fallback is important because some
// settings keys are written by other paths (e.g. via SQLite directly when
// debugging), and we don't want a one-time bad write to permanently break a
// readable setting.
function getSetting(key, fallback) {
  const row = db.get().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

function setSetting(key, value) {
  db.get()
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

// ---- CPU temperature --------------------------------------------------------
//
// v1.1.3.6 — proper sensor selection.
//
// Earlier versions grabbed the first thermal_zone or hwmon entry that
// existed and parsed as a sane number. On a Raspberry Pi this works
// fine because there's only one sensor (cpu_thermal). On Intel x86
// it's a real problem — `thermal_zone0` is typically `acpitz` (the
// ACPI motherboard sensor) which reads ~25-30°C cooler than the
// actual CPU package. The throttle was operating on misleading data.
//
// New approach: prefer sensor types that are known-good for actual
// CPU temperature, in this order:
//
//   x86_pkg_temp   — Intel "package temperature" thermal_zone
//   coretemp       — Intel coretemp driver (per-core + package)
//   k10temp        — AMD K10+ family driver
//   cpu_thermal    — Raspberry Pi 4/5 SoC sensor
//   cpu-thermal    — alt naming on some ARM kernels
//
// We explicitly REJECT these (they're real sensors but not the CPU):
//
//   acpitz         — motherboard ACPI zone (reads cool)
//   pch_*          — chipset (Platform Controller Hub)
//   nvme           — SSD temperature
//   iwlwifi, mt76* — WiFi card
//   any other      — unknown, treat as "not a CPU sensor"
//
// If we find none of the preferred types, we log a warning and fall
// back to the first thermal_zone with a sane value, with an explicit
// note in the log that throttling may be inaccurate. That preserves
// some throttling behaviour rather than disabling it entirely on
// weird hardware.

const PREFERRED_TEMP_TYPES = [
  'x86_pkg_temp',
  'coretemp',
  'k10temp',
  'cpu_thermal',
  'cpu-thermal',
];
const REJECTED_TEMP_TYPES = [
  'acpitz',
  'nvme',
];
const REJECTED_TEMP_PREFIXES = [
  'pch_',     // Intel chipset
  'iwlwifi',  // WiFi
  'mt76',     // WiFi
  'enp',      // network
  'wlp',      // wireless network
];

function isRejected(name) {
  if (REJECTED_TEMP_TYPES.includes(name)) return true;
  for (const p of REJECTED_TEMP_PREFIXES) {
    if (name.startsWith(p)) return true;
  }
  return false;
}

/**
 * Enumerate all thermal_zone* entries with their type + temp paths.
 * Returns [{ type, tempPath, value }] for ones that read a sensible
 * value, sorted in PREFERRED_TEMP_TYPES order.
 */
function probeThermalZones() {
  const found = [];
  let i = 0;
  for (;;) {
    const dir = `/sys/class/thermal/thermal_zone${i}`;
    if (!fs.existsSync(dir)) break;
    i++;
    if (i > 32) break;  // safety bound — no machine has 32 thermal zones

    let type = null;
    try { type = fs.readFileSync(`${dir}/type`, 'utf8').trim().toLowerCase(); }
    catch { continue; }
    if (!type) continue;

    const tempPath = `${dir}/temp`;
    let value;
    try {
      value = parseInt(fs.readFileSync(tempPath, 'utf8').trim(), 10);
    } catch { continue; }
    if (!(value >= 1_000 && value <= 200_000)) continue;

    found.push({ type, tempPath, value });
  }
  return found;
}

/**
 * Enumerate all hwmon* entries with name + temp paths. For coretemp
 * specifically, prefer the "Package id 0" label (CPU package average)
 * over individual core temps. For others, use temp1_input.
 */
function probeHwmon() {
  const found = [];
  let i = 0;
  for (;;) {
    const dir = `/sys/class/hwmon/hwmon${i}`;
    if (!fs.existsSync(dir)) break;
    i++;
    if (i > 32) break;

    let name = null;
    try { name = fs.readFileSync(`${dir}/name`, 'utf8').trim().toLowerCase(); }
    catch { continue; }
    if (!name) continue;

    // For coretemp, look for "Package id 0" label specifically. The
    // package sensor reflects the hottest core (it's actually the
    // max of all cores in hardware), which is what we want for
    // throttling decisions.
    let tempPath = null;
    if (name === 'coretemp') {
      // Iterate temp*_label entries to find Package
      for (let t = 1; t <= 20; t++) {
        const labelPath = `${dir}/temp${t}_label`;
        try {
          const label = fs.readFileSync(labelPath, 'utf8').trim().toLowerCase();
          if (label.startsWith('package')) {
            tempPath = `${dir}/temp${t}_input`;
            break;
          }
        } catch { /* this index doesn't exist or has no label, try next */ }
      }
    }
    // Default: temp1_input
    if (!tempPath) tempPath = `${dir}/temp1_input`;

    let value;
    try { value = parseInt(fs.readFileSync(tempPath, 'utf8').trim(), 10); }
    catch { continue; }
    if (!(value >= 1_000 && value <= 200_000)) continue;

    found.push({ type: name, tempPath, value });
  }
  return found;
}

let _tempPath        = null;
let _tempPathChecked = false;
let _tempSensorType  = null;  // exposed via getTempSensorInfo()

function findTempPath() {
  if (_tempPathChecked) return _tempPath;
  _tempPathChecked = true;

  // Combine candidates from both sources. Same sensor often appears
  // in both /sys/class/thermal/ and /sys/class/hwmon/ — that's fine,
  // we pick whichever instance we encounter first in the preferred
  // order.
  const all = [...probeThermalZones(), ...probeHwmon()];

  // Try preferred types in order.
  for (const wantedType of PREFERRED_TEMP_TYPES) {
    const match = all.find(s => s.type === wantedType);
    if (match) {
      _tempPath = match.tempPath;
      _tempSensorType = match.type;
      console.log(`🌡  CPU temp sensor: ${match.tempPath} (${match.type})`);
      return _tempPath;
    }
  }

  // No preferred sensor found. Look for ANY non-rejected sensor.
  for (const s of all) {
    if (isRejected(s.type)) continue;
    _tempPath = s.tempPath;
    _tempSensorType = s.type;
    console.warn(`🌡  No preferred CPU sensor found; falling back to ${s.tempPath} (${s.type}). Throttling may be inaccurate — set vl_max_cpu_temp_c manually if scans run too hot.`);
    return _tempPath;
  }

  // Last resort: any sensor at all, even if it's rejected.
  if (all.length > 0) {
    const s = all[0];
    _tempPath = s.tempPath;
    _tempSensorType = s.type;
    console.warn(`🌡  Only "${s.type}" sensor available — this is NOT a CPU sensor. Thermal throttling will be unreliable.`);
    return _tempPath;
  }

  console.warn('🌡  No CPU temperature sensor found — thermal throttling disabled');
  return null;
}

/**
 * Diagnostics for the CPU Tweaks page. Returns the sensor we ended
 * up using AND the full list of candidates so the UI can show the
 * user "we picked X because Y wasn't available".
 */
function getTempSensorInfo() {
  if (!_tempPathChecked) findTempPath();
  return {
    selectedPath: _tempPath,
    selectedType: _tempSensorType,
    allCandidates: [
      ...probeThermalZones().map(s => ({ ...s, source: 'thermal_zone', valueC: s.value / 1000 })),
      ...probeHwmon().map(s => ({ ...s, source: 'hwmon', valueC: s.value / 1000 })),
    ],
  };
}

let _lastTempReadAt = 0;
let _lastTempC      = null;

function getCpuTempC() {
  const p = findTempPath();
  if (!p) return null;
  const now = Date.now();
  if (now - _lastTempReadAt < TEMP_RECHECK_INTERVAL_MS && _lastTempC !== null) return _lastTempC;
  try {
    _lastTempC      = parseInt(fs.readFileSync(p, 'utf8').trim(), 10) / 1_000;
    _lastTempReadAt = now;
    return _lastTempC;
  } catch {
    return null;
  }
}

async function waitForCool(ceiling) {
  let logged = false;
  for (;;) {
    const t = getCpuTempC();
    if (t === null || t < ceiling) return;
    if (!logged) {
      console.log(`🌡  CPU at ${t.toFixed(1)}°C — pausing until <${ceiling}°C`);
      logged = true;
    }
    await new Promise(r => setTimeout(r, TEMP_THROTTLE_PAUSE_MS));
    _lastTempReadAt = 0;
  }
}

/**
 * Resolve the operative MAX_CONCURRENCY and MAX_CPU_TEMP_C from
 * the settings table, falling back to the *_DEFAULT constants if
 * the user hasn't set them. Called once at scan start.
 *
 * v1.1.3.5: hardcoded constants → DB-backed settings, with the
 * CPU profile module suggesting sensible defaults that the user
 * can apply via the CPU Tweaks UI page.
 *
 * Settings keys:
 *   vl_max_concurrency  — number, 1 to nproc
 *   vl_max_cpu_temp_c   — number, 50 to 95
 */
function resolveScanLimits() {
  let concurrency = getSetting('vl_max_concurrency', MAX_CONCURRENCY_DEFAULT);
  let tempCeiling = getSetting('vl_max_cpu_temp_c', MAX_CPU_TEMP_C_DEFAULT);
  // Defensive bounds — a corrupt or hand-edited DB shouldn't crash
  // a scan or push us into unsafe territory.
  concurrency = Math.max(1, Math.min(16, parseInt(concurrency, 10) || MAX_CONCURRENCY_DEFAULT));
  tempCeiling = Math.max(40, Math.min(95, parseInt(tempCeiling, 10) || MAX_CPU_TEMP_C_DEFAULT));
  return { concurrency, tempCeiling };
}

// ---- tag reading ------------------------------------------------------------
/**
 * Read ReplayGain / R128 tags from a file and return:
 *   { trackGainDb, trackPeakDb, albumGainDb, albumPeakDb, source }
 * or null if no tags are present.
 *
 * Tag priority (highest to lowest):
 *   1. music-metadata's parsed `replayGain` field (works for most
 *      well-formed files)
 *   2. Raw tags walked from each native namespace
 *   3. R128_TRACK_GAIN / R128_ALBUM_GAIN (Q7.8 fixed-point)
 *
 * Native tag carriers we walk (v1.1.0.75):
 *   - Vorbis comments (FLAC, Ogg, Opus, foobar-style WAV)
 *   - ID3v2.2 / ID3v2.3 / ID3v2.4 TXXX frames (MP3, AIFF, WAV-w-ID3)
 *   - MP4 / iTunes freeform "----" atoms (M4A, AAC)
 *   - APEv2 (MP3 with Foobar2000-style tagging — common in older
 *     Windows libraries, was missing pre-v75 and is the most
 *     likely cause of "my MP3s have RG but musicd ignores it")
 *   - ASF / WMA "WM/replaygain_*" attributes
 *
 * r128gain writes:
 *   FLAC/Ogg  → R128_TRACK_GAIN, R128_ALBUM_GAIN (Q7.8 int)
 *   MP3       → REPLAYGAIN_TRACK_GAIN, REPLAYGAIN_ALBUM_GAIN (dB string)
 * Peak tags (REPLAYGAIN_TRACK_PEAK) are linear ratios; R128 files omit peak.
 */
async function readTagsFromFile(filePath) {
  let meta;
  try {
    meta = await parseFile(filePath, { skipCovers: true, duration: false });
  } catch (e) {
    throw new Error(`music-metadata failed on "${filePath}": ${e.message}`);
  }

  // v1.1.0.76 — restructured.  Walk the raw tag namespaces FIRST,
  // build the flat key/value map, then choose between the parsed
  // priority-1 result and the raw-tag fallback. We do it in this
  // order so REPLAYGAIN_REFERENCE_LOUDNESS is captured regardless
  // of which path supplied the gain values — music-metadata's
  // parsed `replayGain` field doesn't expose the reference.
  const tags = {};

  // Vorbis comments (FLAC, Ogg, Opus, sometimes Wav with foobar)
  for (const t of meta.native?.vorbis ?? []) {
    tags[t.id.toUpperCase()] = t.value;
  }
  // ID3v2 TXXX frames (MP3, AIFF, WAV-with-ID3). Cover all three
  // sub-versions: v2.2 (rare), v2.3 (most common), v2.4.
  for (const frame of [
    ...(meta.native?.['ID3v2.2'] ?? []),
    ...(meta.native?.['ID3v2.3'] ?? []),
    ...(meta.native?.['ID3v2.4'] ?? []),
  ]) {
    if (/^TXXX$/i.test(frame.id) && frame.value?.description) {
      tags[frame.value.description.toUpperCase()] = frame.value.text ?? frame.value.value ?? '';
    }
  }
  // MP4 / iTunes freeform tags. Tools like Foobar2000 and dBpoweramp
  // write the RG values in the "----" namespace (atom + mean +
  // name + data). music-metadata flattens these to ids like
  // "----:com.apple.iTunes:replaygain_track_gain". We match on the
  // "REPLAYGAIN" substring rather than a specific prefix because
  // different tools use different mean strings.
  for (const frame of meta.native?.['iTunes'] ?? []) {
    const fid = frame.id?.toUpperCase() || '';
    if (fid.includes('REPLAYGAIN') || fid.includes('R128')) {
      // Strip everything before the last colon to reduce
      // "----:com.apple.itunes:replaygain_track_gain" →
      // "REPLAYGAIN_TRACK_GAIN"
      tags[fid.replace(/^.*:/, '')] = frame.value;
    }
  }
  // APEv2 tags (Foobar2000-style MP3 ReplayGain on Windows).
  for (const t of meta.native?.['APEv2'] ?? []) {
    tags[t.id.toUpperCase()] = t.value;
  }
  // WMA / ASF — tags use the "WM/" prefix.
  for (const t of meta.native?.['asf'] ?? []) {
    const id = t.id?.toUpperCase() || '';
    if (id.includes('REPLAYGAIN') || id.includes('R128')) {
      tags[id.replace(/^WM\//, '')] = t.value;
    }
  }

  // v1.1.0.75 robust parser, retained.
  const parseLinearDb = key => {
    const raw = tags[key];
    if (raw == null) return null;
    const m = String(raw).trim().match(/^([+-]?\d+\.?\d*)/);
    if (!m) return null;
    const v = parseFloat(m[1]);
    return Number.isFinite(v) ? v : null;
  };

  // Pull the reference loudness once — used by all paths below.
  // Some files write a unitless number ("-18.00 LUFS"), some omit it.
  // Range guard: anything outside -30..-10 is suspicious; we ignore
  // it rather than silently pick up nonsense.
  let referenceLufs = parseLinearDb('REPLAYGAIN_REFERENCE_LOUDNESS');
  if (referenceLufs !== null && (referenceLufs > -10 || referenceLufs < -30)) {
    referenceLufs = null;
  }

  // --- 1. Parsed replayGain field (highest priority for gain
  //         values; always lacks the reference loudness) ---
  const rg = meta.common.replayGain;
  if (rg?.track?.dB !== undefined) {
    const trackGainDb  = rg.track.dB;
    const trackPeakDb  = rg.track.ratio != null  ? 20 * Math.log10(rg.track.ratio)  : null;
    const albumGainDb  = rg.album?.dB  ?? null;
    const albumPeakDb  = rg.album?.ratio != null ? 20 * Math.log10(rg.album.ratio)  : null;
    return { trackGainDb, trackPeakDb, albumGainDb, albumPeakDb, referenceLufs, source: 'replaygain-parsed' };
  }

  // REPLAYGAIN_TRACK_GAIN (dB string, e.g. "-6.54 dB")
  const trackGain = parseLinearDb('REPLAYGAIN_TRACK_GAIN');
  if (trackGain !== null) {
    const rawTrackPeak = parseLinearDb('REPLAYGAIN_TRACK_PEAK');
    const trackPeakDb  = rawTrackPeak != null && rawTrackPeak > 0 ? 20 * Math.log10(rawTrackPeak) : null;
    const albumGain    = parseLinearDb('REPLAYGAIN_ALBUM_GAIN');
    const rawAlbumPeak = parseLinearDb('REPLAYGAIN_ALBUM_PEAK');
    const albumPeakDb  = rawAlbumPeak != null && rawAlbumPeak > 0 ? 20 * Math.log10(rawAlbumPeak) : null;
    return {
      trackGainDb: trackGain,
      trackPeakDb,
      albumGainDb: albumGain,
      albumPeakDb,
      referenceLufs,
      source: 'replaygain-raw',
    };
  }

  // R128_TRACK_GAIN (Q7.8 fixed-point integer)
  const r128TrackRaw  = tags['R128_TRACK_GAIN'];
  const r128AlbumRaw  = tags['R128_ALBUM_GAIN'];
  if (r128TrackRaw != null) {
    const trackGainDb = parseInt(String(r128TrackRaw).trim(), 10) / 256.0;
    const albumGainDb = r128AlbumRaw != null
      ? parseInt(String(r128AlbumRaw).trim(), 10) / 256.0
      : null;
    if (!Number.isNaN(trackGainDb)) {
      // R128 tags imply -23 LUFS reference per spec, unless an
      // explicit REPLAYGAIN_REFERENCE_LOUDNESS overrides it.
      const ref = referenceLufs ?? -23;
      return { trackGainDb, trackPeakDb: null, albumGainDb, albumPeakDb: null, referenceLufs: ref, source: 'r128' };
    }
  }

  return null; // no tags found
}

// ---- per-track scan ---------------------------------------------------------
/**
 * Scan one track: read its tags and upsert into track_loudness.
 * Returns { stored: true, source, trackGainDb, albumGainDb, trackPeakDb }
 *      or { stored: false, reason }
 */
async function scanTrack(track) {
  if (!fs.existsSync(track.path)) {
    return { stored: false, reason: 'file not found' };
  }

  let tags;
  try {
    tags = await readTagsFromFile(track.path);
  } catch (e) {
    return { stored: false, reason: e.message };
  }

  if (!tags) {
    return { stored: false, reason: 'no ReplayGain tags' };
  }

  const { trackGainDb, trackPeakDb, albumGainDb, albumPeakDb, referenceLufs } = tags;

  // v1.1.0.76 — convert gain → integrated LUFS using the file's
  // own reference loudness when present, falling back to the user
  // setting (typically -18). Pre-v76 we always used the setting,
  // which silently produced a 5 dB error if the file was tagged
  // against -23 (some old r128gain workflows) and we expected
  // -18. Storing referenceLufs alongside the gain values lets the
  // UI and computeStreamGain show / use the right LUFS later
  // without re-reading the file.
  //   gain = referenceLufs - measuredLufs
  //   measuredLufs = referenceLufs - gain
  const r128gainTarget    = getSetting('r128gain_target_lufs', TARGET_LUFS_DEFAULT);
  const refForCalc        = referenceLufs ?? r128gainTarget;
  const integratedLufs    = refForCalc - trackGainDb;
  const albumIntegratedLufs = albumGainDb != null ? refForCalc - albumGainDb : null;

  db.get()
    .prepare(`
      INSERT OR REPLACE INTO track_loudness
        (track_id, integrated_lufs, true_peak, album_integrated_lufs, album_peak,
         track_gain_db, album_gain_db, reference_lufs,
         lra, analysed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, unixepoch())
    `)
    .run(
      track.id,
      integratedLufs,
      trackPeakDb ?? null,
      albumIntegratedLufs,
      albumPeakDb ?? null,
      trackGainDb,
      albumGainDb ?? null,
      referenceLufs ?? null,
    );

  return { stored: true, source: tags.source, trackGainDb, albumGainDb, trackPeakDb };
}

// ---- stream-time gain computation ------------------------------------------
/**
 * Returns { gain, measuredLufs, target, mode } or null if not yet scanned.
 *
 * mode is 'track' or 'album' depending on vl_mode setting and tag availability.
 * The true-peak clamp keeps adjusted signal ≤ −1 dBTP.
 */
function computeStreamGain(trackId, targetLufs) {
  const target = targetLufs ?? getSetting('vl_target_lufs', TARGET_LUFS_DEFAULT);
  const mode   = getSetting('vl_mode', 'track'); // 'track' | 'album'

  const row = db.get()
    .prepare('SELECT integrated_lufs, true_peak, album_integrated_lufs, album_peak FROM track_loudness WHERE track_id = ?')
    .get(trackId);

  if (!row) return null;

  // Pick album or track LUFS; fall back to track if album not available
  const useAlbum   = mode === 'album' && row.album_integrated_lufs != null;
  const measured   = useAlbum ? row.album_integrated_lufs : row.integrated_lufs;
  const peak       = useAlbum ? row.album_peak : row.true_peak;
  const actualMode = useAlbum ? 'album' : 'track';

  if (measured == null) return null;

  let gain = target - measured;

  // True-peak clamp: peak must stay ≤ −1 dBTP after gain is applied
  if (peak != null) {
    const headroom = -1.0 - (peak + gain);
    if (headroom < 0) gain += headroom;
  }

  return { gain, measuredLufs: measured, target, mode: actualMode };
}

// ---- parallel scan runner ---------------------------------------------------
let _scanRunning  = false;
let _scanAbort    = false;
let _scanProgress = { processed: 0, skipped: 0, total: 0, running: false, throttled: false };

function getScanProgress() {
  // v1.1.0.77 — also surface "tracks not yet scanned" count, so the
  // UI can show the button as disabled / completed when the library
  // is fully scanned. Cheap query: counts tracks with no row in
  // track_loudness. Excluded tracks aren't counted (they wouldn't be
  // scanned anyway).
  let missingCount = 0;
  try {
    const r = db.get().prepare(`
      SELECT COUNT(*) AS c
        FROM tracks t
        LEFT JOIN track_loudness tl ON tl.track_id = t.id
       WHERE COALESCE(t.excluded, 0) = 0
         AND tl.track_id IS NULL
    `).get();
    missingCount = r?.c || 0;
  } catch {}
  // v1.1.3.5: also surface the live-effective limits so the
  // CPU Tweaks UI can display "Concurrency: 4 / Ceiling: 65°C"
  // matching whatever the next scan would actually use.
  const limits = resolveScanLimits();
  return {
    ..._scanProgress,
    cpuTempC: getCpuTempC(),
    missingCount,
    limits,
  };
}

/**
 * Scan all (or unscanned) tracks for ReplayGain tags and store in DB.
 *
 * opts.force    — re-scan tracks that already have a row
 * opts.trackIds — optional array of specific track IDs
 */
async function runScan(opts = {}) {
  if (_scanRunning) return { error: 'already running' };
  _scanRunning = true;
  _scanAbort   = false;

  const database = db.get();
  let tracks;

  if (opts.trackIds?.length) {
    const placeholders = opts.trackIds.map(() => '?').join(',');
    tracks = database
      .prepare(`SELECT id, path FROM tracks WHERE id IN (${placeholders})`)
      .all(...opts.trackIds);
  } else {
    // Skip excluded tracks (#30.9). User explicitly removed these from
    // scope; analysing them now would burn CPU/disk on files they don't
    // want in their library. If they re-include later, a scan will
    // pick them up and the loudness pass will run then.
    const where = opts.force
      ? 'WHERE excluded = 0'
      : 'WHERE excluded = 0 AND id NOT IN (SELECT track_id FROM track_loudness)';
    tracks = database.prepare(`SELECT id, path FROM tracks ${where}`).all();
  }

  _scanProgress = { processed: 0, skipped: 0, total: tracks.length, running: true, throttled: false };
  // v1.1.3.5: resolve concurrency + temp ceiling from DB settings,
  // captured once per scan so changing settings mid-scan doesn't
  // half-apply (changes take effect on the next scan).
  const limits = resolveScanLimits();
  console.log(`🎚  Loudness scan: ${tracks.length} tracks (concurrency: ${limits.concurrency}, ceiling: ${limits.tempCeiling}°C)`);

  let cursor = 0;

  async function worker() {
    while (!_scanAbort) {
      const t = getCpuTempC();
      if (t !== null && t >= limits.tempCeiling) {
        _scanProgress.throttled = true;
        await waitForCool(limits.tempCeiling);
        _scanProgress.throttled = false;
      }
      if (_scanAbort) return;

      const idx = cursor++;
      if (idx >= tracks.length) return;

      const track  = tracks[idx];
      const result = await scanTrack(track).catch(e => ({ stored: false, reason: e.message }));

      if (result.stored) {
        _scanProgress.processed++;
      } else {
        _scanProgress.skipped++;
        console.warn(`  ⚠  Skipped track ${track.id} (${track.path}): ${result.reason}`);
      }

      const done = _scanProgress.processed + _scanProgress.skipped;
      if (done % 100 === 0) {
        const tNow = getCpuTempC();
        const tStr = tNow !== null ? ` — CPU ${tNow.toFixed(1)}°C` : '';
        console.log(`  ... ${done} / ${tracks.length} (${_scanProgress.skipped} skipped)${tStr}`);
      }
    }
  }

  const workers = Array.from({ length: limits.concurrency }, () => worker());
  await Promise.all(workers);

  _scanProgress.running = false;
  _scanRunning          = false;
  console.log(
    `🎚  Scan complete — ${_scanProgress.processed} stored, ` +
    `${_scanProgress.skipped} skipped${_scanAbort ? ' (aborted)' : ''}`
  );
}

function abortScan() { _scanAbort = true; }

// ---- exports ----------------------------------------------------------------
module.exports = {
  scanTrack,
  runScan,
  abortScan,
  getScanProgress,
  readTagsFromFile,
  computeStreamGain,
  getSetting,
  setSetting,
  getTempSensorInfo,
};
