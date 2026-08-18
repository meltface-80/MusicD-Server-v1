// USB DAC detection (#v1.1.0.0)
// =============================
//
// Discovers USB audio devices via /proc/asound and parses their
// capabilities (PCM rates, bit depths, DSD format support). Polled
// every 10 seconds to catch hot-plug.
//
// Outputs a list of { id, name, vendor, product, card, pcmFormats,
// pcmRates, dsdFormats, dsdRates, hasNativeDsd } for each detected
// device.
//
// Limitations honestly noted:
//   - We rely on /proc/asound parsing which is reasonably stable but
//     not officially a contract. Format may change across kernels.
//   - DSD format strings vary by DAC. We detect them but actual
//     playback depends on aplay supporting that format.
//   - Some DACs report capabilities they don't fully support. The
//     "Test" button in Audio settings is the only real check.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ASOUND_DIR = '/proc/asound';

// ── Card discovery ───────────────────────────────────────────────────

/**
 * Returns a list of card numbers that are USB audio devices.
 * /proc/asound/cards has lines like:
 *   0 [Headphones     ]: bcm2835_headpho - bcm2835 Headphones
 *   1 [E30            ]: USB-Audio - Topping E30
 * We detect "USB-Audio" as the driver string.
 */
// v1.1.0.93 — diagnostic logging on first detection. The most
// common cause of "USB DAC not showing" is the container missing
// /dev/snd or /proc/asound. The earlier code silently returned an
// empty list, leaving the user no signal as to why. We now log
// the state of /proc/asound/cards on the first call so the bug
// report (and docker logs) surfaces it immediately.
let _firstDetectionLogged = false;
function _logFirstDetectionState(cardsText, fallbackUsed, finalCount) {
  if (_firstDetectionLogged) return;
  _firstDetectionLogged = true;
  try {
    const procExists = fs.existsSync('/proc/asound');
    const cardsExists = fs.existsSync('/proc/asound/cards');
    const devSndExists = fs.existsSync('/dev/snd');
    let devSndContents = '';
    try {
      const entries = fs.readdirSync('/dev/snd');
      devSndContents = entries.filter(e => e.startsWith('controlC') || e.startsWith('pcmC')).join(', ') || '(empty)';
    } catch { devSndContents = '(not readable)'; }
    console.log('🔊 USB DAC detection — first scan:');
    console.log(`   /proc/asound exists:        ${procExists}`);
    console.log(`   /proc/asound/cards exists:  ${cardsExists}`);
    console.log(`   /dev/snd exists:            ${devSndExists}`);
    console.log(`   /dev/snd contents:          ${devSndContents}`);
    console.log(`   /proc/asound/cards bytes:   ${cardsText.length}`);
    if (cardsText.length > 0) {
      console.log(`   /proc/asound/cards content: ${cardsText.replace(/\n/g, ' | ').slice(0, 200)}`);
    }
    console.log(`   aplay -l fallback used:     ${fallbackUsed}`);
    console.log(`   USB cards detected:         ${finalCount}`);
    if (finalCount === 0) {
      console.log(`   ⚠️  No USB DACs visible. If you have one plugged in, check:`);
      console.log(`      1. docker-compose.yml has 'devices: - /dev/snd' AND 'volumes: - /proc/asound:/proc/asound:ro'`);
      console.log(`      2. The container has been recreated since adding those (docker compose up --force-recreate)`);
      console.log(`      3. The host shows the DAC: run 'aplay -l' on the host directly`);
      console.log(`      4. The audio group GID matches: 'getent group audio' should be 29 on Debian/DietPi`);
    }
  } catch (e) {
    console.warn('🔊 USB DAC detection diagnostic failed:', e.message);
  }
}

function listUsbCards() {
  let cardsText;
  try {
    cardsText = fs.readFileSync(path.join(ASOUND_DIR, 'cards'), 'utf-8');
  } catch (e) {
    cardsText = '';
  }
  const out = [];
  // Each card occupies 2 lines: header + sub-detail. Parse pairs.
  const lines = cardsText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^\s*(\d+)\s+\[(\S+)\s*\]:\s*(.+?)\s*-\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const [, cardNum, shortName, driver, longName] = m;
    if (driver !== 'USB-Audio') continue;
    out.push({
      card: parseInt(cardNum, 10),
      shortName,
      longName: longName.trim(),
    });
  }

  // Fallback to `aplay -l` (#v1.1.0.8). In containerised deployments,
  // /proc/asound/ is the container's own /proc namespace and is empty
  // even when /dev/snd is mounted. The aplay tool reads ALSA state via
  // device nodes (which ARE available through --device /dev/snd) so it
  // works inside the container. The bind-mount of /proc/asound from
  // host is the cleaner long-term fix (added to the v1.1.0.8 installer)
  // but this fallback ensures USB DAC detection works on existing
  // containers that auto-update without re-running the installer.
  let fallbackUsed = false;
  if (out.length === 0) {
    fallbackUsed = true;
    try {
      const result = spawnSync('aplay', ['-l'], { encoding: 'utf-8', timeout: 4000 });
      if (result.status === 0 && result.stdout) {
        // Output looks like:
        //   card 1: v1 [AudioQuest DragonFly Cobalt v1.], device 0: USB Audio [USB Audio]
        // We pick lines mentioning "USB" in the device description as
        // the heuristic for USB DAC. A built-in audio chip on the host
        // will be e.g. "card 0: PCH [HDA Intel PCH]" with no USB token.
        const aplayLines = result.stdout.split('\n');
        const seen = new Set();
        for (const ln of aplayLines) {
          // Match: card 1: v1 [AudioQuest DragonFly Cobalt v1.], device 0: USB Audio [...]
          const m2 = /^card\s+(\d+):\s+(\S+)\s+\[([^\]]+)\],\s+device\s+\d+:\s+(.+?)\s+\[/.exec(ln);
          if (!m2) continue;
          const [, cardNum, shortName, longName, deviceDesc] = m2;
          const card = parseInt(cardNum, 10);
          if (seen.has(card)) continue;
          // Heuristic: only treat it as USB if the device descriptor
          // mentions "USB". A laptop's HDMI output gets a USB-like
          // card index but its descriptor is "HDMI", not "USB Audio".
          if (!/USB/i.test(deviceDesc)) continue;
          seen.add(card);
          out.push({
            card,
            shortName,
            longName: longName.trim(),
          });
        }
      }
    } catch (e) {
      // aplay not found, exec failed, etc. We've done our best.
    }
  }

  _logFirstDetectionState(cardsText, fallbackUsed, out.length);
  return out;
}

// ── /proc/asound stream parsing ──────────────────────────────────────

/**
 * Parse /proc/asound/cardN/streamN to extract playback capabilities.
 * Returns { pcmRates, pcmFormats, dsdRates, dsdFormats } -- arrays
 * of values seen across all playback altsettings.
 *
 * Example file content:
 *   Topping E30 at usb-0000:00:14.0-2, high speed : USB Audio
 *
 *   Playback:
 *     Status: Stop
 *     Interface 1
 *       Altset 1
 *       Format: S32_LE
 *       Channels: 2
 *       Endpoint: 1 OUT (ASYNC)
 *       Rates: 44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000
 *     Interface 1
 *       Altset 2
 *       Format: DSD_U32_BE
 *       Channels: 2
 *       Rates: 88200, 176400, 352800
 */
function parseStreamFile(card) {
  // Some cards have stream0 only, some have multiple. Try common names.
  const tryPaths = [
    path.join(ASOUND_DIR, `card${card}`, 'stream0'),
    path.join(ASOUND_DIR, `card${card}`, 'pcm0p', 'sub0', 'hw_params'),
  ];
  let text = null;
  for (const p of tryPaths) {
    try {
      text = fs.readFileSync(p, 'utf-8');
      break;
    } catch {}
  }
  if (!text) return { pcmRates: [], pcmFormats: [], dsdRates: [], dsdFormats: [], maxChannels: 0 };

  // Split into Playback section, then walk altsettings.
  const lines = text.split('\n');
  let inPlayback = false;
  const altsets = [];
  let current = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^Playback\s*:/.test(trimmed)) { inPlayback = true; continue; }
    if (/^Capture\s*:/.test(trimmed)) { inPlayback = false; continue; }
    if (!inPlayback) continue;
    const altMatch = /^Altset\s+(\d+)/.exec(trimmed);
    if (altMatch) {
      if (current) altsets.push(current);
      current = { altset: parseInt(altMatch[1], 10), format: null, channels: 0, rates: [] };
      continue;
    }
    if (!current) continue;
    const fMatch = /^Format:\s*(.+)$/.exec(trimmed);
    if (fMatch) {
      current.format = fMatch[1].trim();
      continue;
    }
    const cMatch = /^Channels:\s*(\d+)/.exec(trimmed);
    if (cMatch) {
      current.channels = parseInt(cMatch[1], 10);
      continue;
    }
    const rMatch = /^Rates:\s*(.+)$/.exec(trimmed);
    if (rMatch) {
      // Rates line lists comma-separated frequencies. Sometimes a
      // range "32000 - 384000" appears for adaptive endpoints; we
      // split on commas and parse what we can.
      const parts = rMatch[1].split(',').map(s => s.trim()).filter(Boolean);
      for (const p of parts) {
        const n = parseInt(p, 10);
        if (Number.isFinite(n) && n > 0) current.rates.push(n);
      }
      continue;
    }
  }
  if (current) altsets.push(current);

  // Aggregate.
  const pcmRates = new Set();
  const pcmFormats = new Set();
  const dsdRates = new Set();
  const dsdFormats = new Set();
  let maxChannels = 0;
  for (const a of altsets) {
    if (!a.format) continue;
    if (a.channels > maxChannels) maxChannels = a.channels;
    if (/^DSD_/.test(a.format)) {
      dsdFormats.add(a.format);
      a.rates.forEach(r => dsdRates.add(r));
    } else {
      pcmFormats.add(a.format);
      a.rates.forEach(r => pcmRates.add(r));
    }
  }
  return {
    pcmRates: Array.from(pcmRates).sort((a, b) => a - b),
    pcmFormats: Array.from(pcmFormats).sort(),
    dsdRates: Array.from(dsdRates).sort((a, b) => a - b),
    dsdFormats: Array.from(dsdFormats).sort(),
    maxChannels,
  };
}

// ── Capability probing via aplay (#v1.1.0.16) ─────────────────────────
//
// When /proc/asound/cardN/stream0 isn't available (always the case
// inside our container, since runc on DietPi rejects the bind-mount
// of /proc/asound that v1.1.0.8 attempted), parseStreamFile() returns
// empty arrays. Without those, the UI shows "DSP / Bit Depth" as
// "unknown" and the DSP / DSD-mode pickers can't make smart decisions.
//
// The fallback strategy here: open the ALSA device directly via
// `aplay --dump-hw-params` and probe specific format/rate combinations
// to discover what it accepts. Each probe opens the device with a
// 0-second duration so it's silent (no click on most DACs, though
// some may briefly mute/unmute as the kernel negotiates the format).
//
// We probe a curated list of common rates/formats rather than
// brute-forcing every combination -- that'd take too long and most
// DACs don't accept arbitrary rates anyway. The list covers what
// real-world DACs actually support: Redbook (44.1k), 48k family, hi-res
// (88.2/96/176.4/192/352.8/384/705.6/768 kHz), and the standard DSD
// formats (DSD64/128/256/512 in U8/U16/U32 layouts).
//
// First detection of a fresh DAC takes 2-3 seconds. Cached after that
// keyed by vendor:product so a card-number change (hot-plug shuffle)
// reuses the result. Probing is skipped while playback is active on
// the same card -- aplay would fail with EBUSY anyway, and the user
// is mid-music.

const PCM_PROBE_RATES = [
  44100, 48000, 88200, 96000, 176400, 192000,
  352800, 384000, 705600, 768000,
];

// DSD formats we test. The kernel exposes these as
// distinct format strings via the ALSA hw layer. Not every DAC
// supports all of them -- DSD64 -> DSD512 capability varies, and
// some DACs accept U16 but not U32 or vice versa.
const DSD_PROBES = [
  // DSD64
  { format: 'DSD_U8',     rate: 352800 / 4 },   // = 88200 (DSD64 in U8)
  { format: 'DSD_U16_LE', rate: 88200 },
  { format: 'DSD_U16_BE', rate: 88200 },
  { format: 'DSD_U32_LE', rate: 88200 },
  { format: 'DSD_U32_BE', rate: 88200 },
  // DSD128
  { format: 'DSD_U16_LE', rate: 176400 },
  { format: 'DSD_U16_BE', rate: 176400 },
  { format: 'DSD_U32_LE', rate: 176400 },
  { format: 'DSD_U32_BE', rate: 176400 },
  // DSD256
  { format: 'DSD_U32_LE', rate: 352800 },
  { format: 'DSD_U32_BE', rate: 352800 },
  // DSD512
  { format: 'DSD_U32_LE', rate: 705600 },
  { format: 'DSD_U32_BE', rate: 705600 },
];

// Per-DAC capability cache. Key = `${vendorId}:${productId}` (or
// `card:${cardNum}` when vendor/product unknown). Value = the
// capabilities object as returned by parseStreamFile.
const _capabilityCache = new Map();

// Deferred to alsa.js -- we ask it whether a given card is currently
// in active playback. Avoids a require cycle by lazy-loading.
let _isCardBusy = () => false;
function setBusyChecker(fn) { _isCardBusy = fn; }

function probeCapabilitiesViaAplay(card, vendorId, productId) {
  const cacheKey = (vendorId && productId)
    ? `vp:${vendorId}:${productId}`
    : `card:${card}`;
  const cached = _capabilityCache.get(cacheKey);
  if (cached) return cached;

  // Skip probing while the card is actively playing -- aplay would
  // get EBUSY and the open might cause an audible glitch. Caller
  // gets blank capabilities; we'll probe again next idle poll.
  if (_isCardBusy(card)) {
    return null;
  }

  const device = `hw:${card},0`;
  const pcmFormats = new Set();
  const pcmRates = new Set();
  const dsdFormats = new Set();
  const dsdRates = new Set();
  let maxChannels = 0;

  // First pass: aplay --dump-hw-params reports the device's full
  // PCM capability set on stderr in a fixed format we can parse.
  // (#v1.1.0.16) Earlier code probed each format/rate pair via
  // separate aplay invocations -- but every probe was missing
  // `-c 2` (channels) so it tried mono on a stereo-only DAC and
  // every probe failed with "Sample format non available". The
  // dump-hw-params output already lists every supported PCM
  // FORMAT and the RATE range directly, so we don't need format
  // probes at all for PCM. Just parse the dump.
  //
  // Example output for an AudioQuest DragonFly Cobalt:
  //   FORMAT:  S24_3LE
  //   RATE: [44100 96000]
  //   CHANNELS: 2
  //
  // Example for a high-end DAC supporting multiple formats:
  //   FORMAT: S16_LE S24_3LE S32_LE
  //   RATE: [44100 768000]
  //   CHANNELS: 2
  //
  // Where the kernel reports a RATE range, we intersect it with
  // our list of standard sample rates rather than treating every
  // rate in between as supported -- USB DACs typically accept
  // discrete frequencies only, even when ALSA reports a range.
  try {
    const r = spawnSync('aplay', ['--dump-hw-params', '-D', device, '/dev/zero'], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    if (r.stderr) {
      const cm = /CHANNELS:\s*(?:\[)?\s*(\d+)/.exec(r.stderr);
      if (cm) maxChannels = parseInt(cm[1], 10);

      // FORMAT line may have one or many space-separated entries.
      const fm = /^\s*FORMAT:\s*(.+)$/m.exec(r.stderr);
      if (fm) {
        for (const f of fm[1].trim().split(/\s+/)) {
          if (f && /^[A-Z][A-Z0-9_]+$/.test(f)) pcmFormats.add(f);
        }
      }

      // RATE line is either "[min max]" or a single value.
      const rm = /^\s*RATE:\s*(?:\[\s*(\d+)\s+(\d+)\s*\]|(\d+))/m.exec(r.stderr);
      if (rm) {
        const rmin = rm[1] ? parseInt(rm[1], 10) : parseInt(rm[3], 10);
        const rmax = rm[2] ? parseInt(rm[2], 10) : parseInt(rm[3], 10);
        for (const rate of PCM_PROBE_RATES) {
          if (rate >= rmin && rate <= rmax) pcmRates.add(rate);
        }
      }
    }
  } catch { /* non-fatal */ }

  // Second pass: DSD probes. DSD support is exposed on separate
  // ALSA altsettings; the default subdevice we just dumped reports
  // PCM only. To detect DSD we must explicitly request a DSD format
  // and check whether the kernel accepts it.
  //
  // CRITICAL: -c 2 is essential -- USB DACs are stereo-only, and
  // aplay defaults to mono with /dev/zero source. Without -c 2 the
  // kernel rejects every probe regardless of format.
  function tryFormat(format, rate) {
    try {
      const r = spawnSync('aplay',
        ['-D', device, '-f', format, '-r', String(rate), '-c', '2', '-d', '0', '/dev/zero'],
        { timeout: 2000, stdio: 'pipe' });
      return r.status === 0;
    } catch {
      return false;
    }
  }

  for (const probe of DSD_PROBES) {
    if (tryFormat(probe.format, probe.rate)) {
      dsdFormats.add(probe.format);
      dsdRates.add(probe.rate);
    }
  }

  const result = {
    pcmRates: Array.from(pcmRates).sort((a, b) => a - b),
    pcmFormats: Array.from(pcmFormats).sort(),
    dsdRates: Array.from(dsdRates).sort((a, b) => a - b),
    dsdFormats: Array.from(dsdFormats).sort(),
    maxChannels: maxChannels || 2,  // assume stereo if probe didn't return
  };

  // Only cache successful probes -- if we got nothing back, leave
  // it uncached so the next poll can retry (DAC may have been busy
  // or in an odd state).
  if (result.pcmFormats.length > 0 || result.dsdFormats.length > 0) {
    _capabilityCache.set(cacheKey, result);
  }
  return result;
}

// Clear the capability cache. Called when the user hits "Refresh" in
// the Audio settings page so a stuck-cache scenario can be resolved.
function clearCapabilityCache() {
  _capabilityCache.clear();
}

// ── USB vendor:product via lsusb (best-effort) ───────────────────────
// We'd like to show vendor:product IDs in the UI but there's no
// uniform proc-fs path that maps card → USB device. lsusb is the
// pragmatic choice. If lsusb isn't available we fall back to the
// /proc/asound longName.

let _lsusbCache = null;
let _lsusbCacheAt = 0;
function lsusbList() {
  // Cache for 30s -- lsusb runs every detection cycle if uncached.
  if (_lsusbCache && (Date.now() - _lsusbCacheAt) < 30_000) return _lsusbCache;
  try {
    const r = spawnSync('lsusb', [], { timeout: 3000 });
    if (r.status !== 0) return _lsusbCache || [];
    const out = [];
    for (const line of r.stdout.toString().split('\n')) {
      const m = /^Bus\s+(\d+)\s+Device\s+(\d+):\s+ID\s+([0-9a-f]{4}):([0-9a-f]{4})\s+(.*)$/i.exec(line);
      if (!m) continue;
      out.push({ bus: m[1], device: m[2], vendorId: m[3], productId: m[4], description: m[5].trim() });
    }
    _lsusbCache = out;
    _lsusbCacheAt = Date.now();
    return out;
  } catch {
    return _lsusbCache || [];
  }
}

// ── Public: detect ───────────────────────────────────────────────────

/**
 * Returns a list of detected USB DACs with capabilities.
 * Each entry:
 *   {
 *     id:           'alsa-card-1',         // stable across runs as long as card index is stable
 *     name:         'Topping E30',          // friendly name (longName from /proc/asound/cards)
 *     card:         1,                      // ALSA card number for plughw:N,0
 *     vendorId:     '152a',                 // hex string from lsusb (may be null)
 *     productId:    '8750',                 // hex string from lsusb (may be null)
 *     pcmRates:     [44100, 48000, ...],
 *     pcmFormats:   ['S32_LE'],
 *     dsdRates:     [88200, 176400, 352800],
 *     dsdFormats:   ['DSD_U32_BE'],
 *     hasNativeDsd: true,
 *     maxChannels:  2,
 *     // Heuristic: DAC supports DoP if it supports ≥176.4 kHz PCM
 *     // at 24-bit. DSD64 needs 176.4 kHz, DSD128 needs 352.8 kHz.
 *     dopMaxRate:   176400,                  // or 352800 for DSD128, 0 if no DoP
 *   }
 */
function detect() {
  const cards = listUsbCards();
  if (cards.length === 0) return [];
  const lsusb = lsusbList();
  const out = [];
  for (const c of cards) {
    let caps = parseStreamFile(c.card);
    // Try to match lsusb description against the card name (loose
    // match -- "Topping" in either side wins). Only used to surface
    // vendor:product IDs in the UI; not required.
    let matched = null;
    for (const u of lsusb) {
      const desc = u.description.toLowerCase();
      const longName = c.longName.toLowerCase();
      if (longName.includes(desc.split(' ').slice(-1)[0]) ||
          desc.includes(c.shortName.toLowerCase())) {
        matched = u;
        break;
      }
    }

    // Fallback to aplay-based probing when /proc/asound capability
    // info is missing (#v1.1.0.16). Inside our container, this is
    // always the case -- runc on DietPi rejected the /proc/asound
    // bind-mount, and the host's /proc/asound isn't otherwise visible.
    // The aplay probe takes 2-3 seconds first time per DAC, then is
    // cached by vendor:product ID for subsequent polls.
    if (caps.pcmFormats.length === 0 && caps.dsdFormats.length === 0) {
      const probed = probeCapabilitiesViaAplay(
        c.card,
        matched?.vendorId || null,
        matched?.productId || null
      );
      if (probed) caps = probed;
    }

    // DoP capability heuristic. DSD64 (DoP) needs 176.4 kHz PCM at
    // 24-bit. DSD128 (DoP) needs 352.8 kHz. We assume any DAC that
    // accepts those PCM rates supports DoP -- this is true for the
    // overwhelming majority of consumer DACs.
    let dopMaxRate = 0;
    if (caps.pcmRates.includes(352800)) dopMaxRate = 352800;
    else if (caps.pcmRates.includes(176400)) dopMaxRate = 176400;

    out.push({
      id: `alsa-card-${c.card}`,
      name: c.longName,
      card: c.card,
      vendorId: matched?.vendorId || null,
      productId: matched?.productId || null,
      pcmRates: caps.pcmRates,
      pcmFormats: caps.pcmFormats,
      dsdRates: caps.dsdRates,
      dsdFormats: caps.dsdFormats,
      hasNativeDsd: caps.dsdFormats.length > 0,
      maxChannels: caps.maxChannels,
      dopMaxRate,
    });
  }
  return out;
}

// ── Cached detection with hot-plug polling ───────────────────────────

let _cachedDevices = [];
let _pollTimer = null;
const _listeners = new Set();

function getDevices() {
  return _cachedDevices.slice();
}

function getDevice(id) {
  return _cachedDevices.find(d => d.id === id) || null;
}

function _refresh() {
  const next = detect();
  // Detect changes for hot-plug events.
  const prevIds = new Set(_cachedDevices.map(d => d.id));
  const nextIds = new Set(next.map(d => d.id));
  const added = next.filter(d => !prevIds.has(d.id));
  const removed = _cachedDevices.filter(d => !nextIds.has(d.id));
  _cachedDevices = next;
  if (added.length || removed.length) {
    for (const fn of _listeners) {
      try { fn({ added, removed, all: next }); } catch (e) { /* non-fatal */ }
    }
  }
}

function startPolling(intervalMs = 10_000) {
  if (_pollTimer) return;
  _refresh();
  _pollTimer = setInterval(_refresh, intervalMs);
  if (_pollTimer.unref) _pollTimer.unref();
}

function stopPolling() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

function onChange(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

module.exports = {
  detect,            // synchronous one-shot detection
  getDevices,        // cached list (after polling has run)
  getDevice,
  startPolling,
  stopPolling,
  onChange,
  refresh: _refresh,        // manual refresh trigger (e.g. UI button)
  setBusyChecker,           // wired up by alsa.js, used to skip
                            // capability probes during active playback
  clearCapabilityCache,     // forced re-probe (Refresh button)
};
