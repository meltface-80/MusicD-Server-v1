/**
 * cpuProfile.js — auto-detect the host CPU and suggest scan settings.
 *
 * v1.1.3.5 — first cut.
 *
 * Reads /proc/cpuinfo (mounted into the container by install.sh)
 * once on first call, classifies the hardware into one of a small
 * set of buckets, and returns a SUGGESTED profile { tempCeiling,
 * concurrency }. Suggestions are NOT auto-applied — the UI shows
 * them and the user explicitly chooses to apply them or stick
 * with safe defaults.
 *
 * The buckets are intentionally coarse:
 *
 *   pi4-or-similar   — ARM SoC, fanless or weakly cooled, 4 cores
 *   raspberry-pi-5   — newer Pi, similar thermals to pi4 but more cores
 *   x86-low-power    — Atom / Celeron / Pentium / N-series, mobile or NUC
 *   x86-desktop      — Core i3/i5/i7/i9, Ryzen, well-cooled
 *   apple-silicon    — M1/M2/M3 (rare in Linux installs but possible)
 *   generic          — anything we don't recognise (safe defaults)
 *
 * If we can't read /proc/cpuinfo at all, we return generic. This is
 * the safe default for anyone running on weird hardware where we
 * can't be sure what we're dealing with.
 *
 * Detection is cached per-process — once we've classified a machine
 * the result doesn't change at runtime.
 */

const fs = require('fs');
const os = require('os');

let _cached = null;

/**
 * Read /proc/cpuinfo and extract a model-name and core count. Returns
 * null on failure (which forces the safe-default path in caller).
 */
function readCpuInfo() {
  try {
    const raw = fs.readFileSync('/proc/cpuinfo', 'utf8');
    // Parse: looking for the model name line (Intel/AMD report this).
    const lines = raw.split('\n');
    let modelName = null;
    let hardware = null;  // ARM-style identifier, sometimes more useful than model name
    for (const line of lines) {
      if (modelName === null && line.startsWith('model name')) {
        modelName = line.split(':').slice(1).join(':').trim();
      }
      if (hardware === null && line.startsWith('Hardware')) {
        hardware = line.split(':').slice(1).join(':').trim();
      }
      if (modelName && hardware) break;
    }
    return {
      modelName: modelName || null,
      hardware: hardware || null,
      cores: os.cpus().length,
    };
  } catch (e) {
    return null;
  }
}

/**
 * Classify the hardware into a bucket. Returns the bucket name and
 * suggested defaults for that bucket.
 */
function classify(info) {
  if (!info) {
    return {
      bucket: 'generic',
      label: 'Unknown CPU (defaults applied)',
      modelName: null,
      cores: os.cpus().length,
      // Safe-everywhere defaults. Conservative on temp, modest on
      // workers. A user with better hardware can crank these up
      // via the CPU Tweaks page once they've seen the numbers.
      tempCeiling: 65,
      concurrency: 3,
    };
  }

  const m = (info.modelName || '').toLowerCase();
  const hw = (info.hardware || '').toLowerCase();
  const cores = info.cores;

  // Apple Silicon — rare in Linux, but possible via Asahi.
  if (m.includes('apple') || hw.includes('apple')) {
    return {
      bucket: 'apple-silicon',
      label: info.modelName || 'Apple Silicon',
      modelName: info.modelName,
      cores,
      tempCeiling: 80,
      concurrency: Math.min(cores, 6),
    };
  }

  // Raspberry Pi 5 — Cortex-A76 cores, runs warmer than Pi 4 but
  // has actual cooling in most setups (heatsink minimum, often a fan).
  if (hw.includes('raspberry pi 5') || m.includes('cortex-a76')) {
    return {
      bucket: 'raspberry-pi-5',
      label: 'Raspberry Pi 5',
      modelName: info.modelName,
      cores,
      tempCeiling: 70,
      concurrency: Math.min(cores, 4),
    };
  }

  // Raspberry Pi 4 — Cortex-A72, fanless is common, runs hot fast.
  if (hw.includes('raspberry pi 4') || m.includes('cortex-a72')) {
    return {
      bucket: 'pi4-or-similar',
      label: 'Raspberry Pi 4 (or similar ARM SoC)',
      modelName: info.modelName,
      cores,
      tempCeiling: 65,
      concurrency: 3,
    };
  }

  // Older / lower-end Pi. Anything ARMv7-class.
  if (m.includes('arm') || m.includes('cortex-a5') || m.includes('cortex-a7')) {
    return {
      bucket: 'pi4-or-similar',
      label: 'ARM SoC',
      modelName: info.modelName,
      cores,
      tempCeiling: 65,
      concurrency: Math.min(cores, 2),
    };
  }

  // Intel Atom / Celeron / Pentium / N-series — low-power x86.
  // These are common in NUCs, mini PCs, fanless industrial boxes.
  // Run cool but throttle hard if pushed; conservative concurrency.
  if (
    m.includes('atom') ||
    m.includes('celeron') ||
    m.includes('pentium') ||
    m.match(/n\d{4}/) ||  // N100, N200, N5095, etc.
    m.includes('j-series') ||
    m.includes('jasper lake')
  ) {
    return {
      bucket: 'x86-low-power',
      label: info.modelName,
      modelName: info.modelName,
      cores,
      tempCeiling: 70,
      concurrency: Math.min(cores, 3),
    };
  }

  // Intel Core i3/i5/i7/i9 — the big tent. Includes the user's
  // i5-8500T. These are well-cooled in nearly any chassis (laptop,
  // tower, NUC); 75°C is well within safe sustained operation.
  // Concurrency is capped at "leave 2 cores free" so the system
  // stays responsive during scans.
  if (
    m.match(/core\(tm\) i[3579]/) ||
    m.match(/intel.*i[3579]-/) ||
    m.includes('xeon')
  ) {
    return {
      bucket: 'x86-desktop',
      label: info.modelName,
      modelName: info.modelName,
      cores,
      tempCeiling: 75,
      concurrency: Math.max(2, cores - 2),
    };
  }

  // AMD Ryzen — runs hotter than Intel by design (the silicon is
  // happy in 80-90°C territory). Same "leave 2 cores" rule.
  if (m.includes('ryzen') || m.includes('amd')) {
    return {
      bucket: 'x86-desktop',
      label: info.modelName,
      modelName: info.modelName,
      cores,
      tempCeiling: 80,
      concurrency: Math.max(2, cores - 2),
    };
  }

  // Fallback: we have a model name but didn't match any rule.
  // Use the safe-everywhere defaults but include the model in
  // the label so the user can see what we're guessing at.
  return {
    bucket: 'generic',
    label: info.modelName || 'Unknown CPU',
    modelName: info.modelName,
    cores,
    tempCeiling: 65,
    concurrency: 3,
  };
}

/**
 * Public entry point. Returns the cached profile, or detects on
 * first call. Always returns a profile object — never throws.
 */
function detectProfile() {
  if (_cached) return _cached;
  const info = readCpuInfo();
  _cached = classify(info);
  return _cached;
}

module.exports = { detectProfile };
