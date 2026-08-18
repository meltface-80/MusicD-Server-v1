// Audio routes (#v1.1.0.0, expanded #v1.1.0.8)
// ============================================
//
// Endpoints for the Audio settings tab. Handles USB DAC discovery,
// per-renderer settings, and the "Test" button. v1.1.0.8 adds the
// /audio/all endpoint which lists ALL output devices (USB DACs +
// DLNA + Sonos + Squeezelite) with their per-renderer settings
// merged in -- the consolidated Audio settings tab consumes this.

const express = require('express');
const router = express.Router();
const detect = require('../audio/detect');
const alsa = require('../audio/alsa');
const renderers = require('../renderers');
const db = require('../db');

// GET /api/audio/devices — list detected USB DACs with capabilities
//   and current settings. Used by the Audio settings tab.
router.get('/devices', (req, res) => {
  res.json({ devices: alsa.list() });
});

// GET /api/audio/all (#v1.1.0.8) -- list every output device
// (USB DACs + network renderers) with per-renderer settings merged
// in. The consolidated Audio settings tab consumes this. Settings
// for disconnected devices are also returned with `connected: false`
// so users can preview/tweak them before reconnecting hardware.
router.get('/all', (req, res) => {
  // Live USB DACs from detect.js (already merged with their renderer
  // settings by alsa.list()).
  const usb = alsa.list().map(d => ({ ...d, type: 'usb_dac', connected: true }));

  // Live network renderers. Their per-device settings need merging
  // from renderer_settings table.
  //
  // (#v1.1.0.14) The renderer registry includes alsa as one of its
  // protocols, so renderers.list() ALSO returns USB DACs. We filter
  // those out here -- they're already in the `usb` array above with
  // richer per-device data (capabilities, dsd_mode etc). Without this
  // filter every USB DAC appeared twice in the Audio Devices page.
  const usbIds = new Set(usb.map(d => d.id));
  const network = renderers.list()
    .filter(r => !usbIds.has(r.id) && r.protocol !== 'alsa')
    .map(r => {
    const row = db.get().prepare(
      'SELECT bypass_dsp, output_mode, sonos_force_16bit, icon_id, custom_name FROM renderer_settings WHERE renderer_id = ?'
    ).get(r.id) || {};
    // v1.1.0.68 — custom_name takes precedence over the discovered
    // name. The discovered name is preserved on the device as
    // `discovered_name` so the UI can show "rename: Kitchen
    // (was: WiiM Pro Plus)" if it wants to.
    const customName = row.custom_name && row.custom_name.trim() ? row.custom_name.trim() : null;
    return {
      id: r.id,
      name: customName || r.name,
      discovered_name: r.name,
      custom_name: customName,
      ip: r.ip,
      type: protocolFromId(r.id),
      connected: true,
      capabilities: r.capabilities,
      bypass_dsp: row.bypass_dsp ? true : false,
      output_mode: row.output_mode || 'variable',
      sonos_force_16bit: row.sonos_force_16bit ? true : false,
      icon_id: row.icon_id || null,
    };
  });

  // Disconnected devices we've seen before (#v1.1.0.8): renderer_settings
  // has rows for renderers that aren't currently online. Show them
  // greyed out so users can edit settings before plugging hardware
  // back in. We exclude any IDs that are in the live lists above.
  const liveIds = new Set([...usb, ...network].map(d => d.id));
  const persistedRows = db.get().prepare(`
    SELECT renderer_id, bypass_dsp, output_mode, sonos_force_16bit, icon_id, dsd_mode, custom_name
    FROM renderer_settings
    WHERE renderer_id IS NOT NULL
  `).all();
  const disconnected = persistedRows
    .filter(r => !liveIds.has(r.renderer_id))
    .map(r => {
      const customName = r.custom_name && r.custom_name.trim() ? r.custom_name.trim() : null;
      const derived = deriveNameFromId(r.renderer_id);
      return {
        id: r.renderer_id,
        name: customName || derived,
        discovered_name: derived,
        custom_name: customName,
        type: protocolFromId(r.renderer_id),
        connected: false,
        bypass_dsp: r.bypass_dsp ? true : false,
        output_mode: r.output_mode || 'variable',
        sonos_force_16bit: r.sonos_force_16bit ? true : false,
        icon_id: r.icon_id || null,
        dsd_mode: r.dsd_mode || 'auto',
      };
    });

  res.json({ devices: [...usb, ...network, ...disconnected] });
});

function protocolFromId(id) {
  if (!id) return 'unknown';
  if (id.startsWith('alsa-card-')) return 'usb_dac';
  if (id.startsWith('sonos:'))     return 'sonos';
  if (id.startsWith('squeeze:'))   return 'squeezelite';
  if (id.startsWith('dlna:'))      return 'dlna';
  return 'unknown';
}

function deriveNameFromId(id) {
  // Best-effort name reconstruction for disconnected devices. The
  // renderer modules don't persist friendly names, so we fall back
  // to whatever the ID tells us.
  //
  // v1.1.0.96 — readable formats. Was producing things like:
  //   "USB DAC alsa-card-2"   ← redundant, shows the full ID twice
  //   "Squeezelite (3a2b8f9d…)"  ← serves as a placeholder but the
  //                                truncation point was arbitrary
  // Now produces:
  //   "USB DAC (card 2)"        ← clean, just the card number
  //   "Squeezelite player"      ← honest "we don't know the name"
  //   "DLNA renderer"            ← same
  //   "Sonos zone"              ← same; the bare uuid is meaningless
  //                               to users without the friendly name
  // The user's set custom_name (if any) takes precedence over this
  // value upstream in /audio/all, so a renamed disconnected device
  // keeps its label.
  if (id.startsWith('sonos:'))     return 'Sonos zone';
  if (id.startsWith('squeeze:'))   return 'Squeezelite player';
  if (id.startsWith('dlna:'))      return 'DLNA renderer';
  if (id.startsWith('alsa-card-')) {
    const card = id.slice('alsa-card-'.length);
    return `USB DAC (card ${card})`;
  }
  return id;
}

// POST /api/audio/refresh — force a re-scan of /proc/asound. Useful
// after the user plugs in a DAC and wants to see it without waiting
// for the 10-second poll cycle. Also clears the capability probe
// cache (#v1.1.0.16) so capabilities are re-probed on the next
// detect cycle -- handy if a previous probe came back partial
// because the DAC was busy or in an odd state.
router.post('/refresh', (req, res) => {
  detect.clearCapabilityCache();
  detect.refresh();
  res.json({ devices: alsa.list() });
});

// GET /api/audio/usb-diagnostics — report on the USB DAC detection
// pipeline (#v1.1.0.93). When a user expects to see their DAC but
// doesn't, this endpoint tells them WHY: is /proc/asound visible
// inside the container? does aplay run? does the host have any
// USB-Audio cards attached? is there an `audio` group permission
// problem? Each step is a separate field so the UI can render a
// checklist.
//
// All checks are read-only and side-effect-free. Probing the host
// for hardware uses the same paths detect.js does — no NEW spawns
// of audio devices, just reading /proc/asound and running the same
// `aplay -l` we already run.
router.get('/usb-diagnostics', (req, res) => {
  const fs = require('fs');
  const { spawnSync } = require('child_process');
  const out = {
    proc_asound_visible: false,
    proc_asound_cards_text: null,
    aplay_works: false,
    aplay_l_text: null,
    aplay_error: null,
    dev_snd_visible: false,
    dev_snd_entries: null,
    detect_returned: 0,
    detected_devices: [],
    advice: [],
  };

  // 1. /proc/asound visibility
  try {
    out.proc_asound_cards_text = fs.readFileSync('/proc/asound/cards', 'utf-8');
    out.proc_asound_visible = true;
  } catch (e) {
    out.proc_asound_visible = false;
    if (e.code !== 'ENOENT') {
      out.advice.push(`/proc/asound read failed: ${e.code}`);
    } else {
      out.advice.push('/proc/asound is not mounted into the container. Add `- /proc/asound:/proc/asound:ro` to the volumes section of docker-compose.yml.');
    }
  }

  // 2. /dev/snd visibility
  try {
    out.dev_snd_entries = fs.readdirSync('/dev/snd');
    out.dev_snd_visible = out.dev_snd_entries.length > 0;
    if (!out.dev_snd_visible) {
      out.advice.push('/dev/snd exists but is empty. Check that USB audio devices are plugged in on the host.');
    }
  } catch (e) {
    out.dev_snd_visible = false;
    out.advice.push('/dev/snd is not accessible. Add `devices: [- /dev/snd]` to docker-compose.yml.');
  }

  // 3. aplay sanity check
  try {
    const r = spawnSync('aplay', ['-l'], { encoding: 'utf-8', timeout: 4000 });
    out.aplay_works = r.status === 0;
    out.aplay_l_text = (r.stdout || '') + (r.stderr ? '\n[stderr]\n' + r.stderr : '');
    if (r.status !== 0) {
      out.aplay_error = `aplay exited with status ${r.status}`;
      if (r.stderr && /permission denied/i.test(r.stderr)) {
        out.advice.push('aplay reports "Permission denied" — the container user is not in the `audio` group on the host. Add `group_add: ["29"]` (or whatever your host audio GID is) to docker-compose.yml.');
      }
    }
  } catch (e) {
    out.aplay_error = e.message;
    out.advice.push(`aplay not runnable inside the container: ${e.message}`);
  }

  // 4. What detect.js currently sees
  try {
    const devices = detect.detect();
    out.detect_returned = devices.length;
    out.detected_devices = devices.map(d => ({
      id: d.id,
      name: d.name,
      card: d.card,
      pcmFormatCount: d.pcmFormats?.length || 0,
      pcmRateCount: d.pcmRates?.length || 0,
      hasNativeDsd: d.hasNativeDsd || false,
    }));
  } catch (e) {
    out.advice.push(`detect.js threw: ${e.message}`);
  }

  // 5. If everything looks good but no devices, advise on hardware
  if (out.dev_snd_visible && out.aplay_works && out.detect_returned === 0) {
    out.advice.push('All detection paths are working but no USB DACs are reported. Either no USB DAC is plugged in on the host, or the DAC is not enumerated as USB-Audio. Try `lsusb` and `aplay -l` on the HOST to confirm the device is visible to the kernel.');
  }

  res.json(out);
});

// POST /api/audio/renderers/:id/settings (#v1.1.0.8) -- generalised
// per-device settings writer. Accepts any combination of:
//   { bypass_dsp: bool, output_mode: 'fixed'|'variable',
//     sonos_force_16bit: bool, dsd_mode: 'auto'|'pcm'|'dop'|'native',
//     icon_id: string }
// Writes to renderer_settings table. Works for both USB DACs and
// network renderers since both store under that table.
router.post('/renderers/:id/settings', (req, res) => {
  const id = req.params.id;
  const body = req.body || {};
  const updates = {};

  if ('bypass_dsp' in body) {
    if (typeof body.bypass_dsp !== 'boolean') {
      return res.status(400).json({ error: 'bypass_dsp must be boolean' });
    }
    updates.bypass_dsp = body.bypass_dsp ? 1 : 0;
  }
  if ('output_mode' in body) {
    if (!['fixed', 'variable'].includes(body.output_mode)) {
      return res.status(400).json({ error: "output_mode must be 'fixed' or 'variable'" });
    }
    updates.output_mode = body.output_mode;
  }
  if ('sonos_force_16bit' in body) {
    if (typeof body.sonos_force_16bit !== 'boolean') {
      return res.status(400).json({ error: 'sonos_force_16bit must be boolean' });
    }
    updates.sonos_force_16bit = body.sonos_force_16bit ? 1 : 0;
  }
  if ('dsd_mode' in body) {
    if (!['auto', 'pcm', 'dop', 'native'].includes(body.dsd_mode)) {
      return res.status(400).json({ error: 'dsd_mode must be auto/pcm/dop/native' });
    }
    updates.dsd_mode = body.dsd_mode;
  }
  if ('icon_id' in body) {
    if (body.icon_id !== null && typeof body.icon_id !== 'string') {
      return res.status(400).json({ error: 'icon_id must be string or null' });
    }
    updates.icon_id = body.icon_id;
  }
  // v1.1.0.68 — user-defined display name for the renderer / zone.
  // Empty string or whitespace-only means "clear the override and
  // fall back to the discovered name." Capped at 60 chars so the
  // sidebar / mini-bar / Output sheet don't break their layouts on
  // very long names.
  if ('custom_name' in body) {
    if (body.custom_name !== null && typeof body.custom_name !== 'string') {
      return res.status(400).json({ error: 'custom_name must be string or null' });
    }
    let cn = body.custom_name == null ? null : String(body.custom_name).trim();
    if (cn === '') cn = null;
    if (cn && cn.length > 60) {
      return res.status(400).json({ error: 'custom_name too long (max 60 chars)' });
    }
    updates.custom_name = cn;
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'no recognised settings in body' });
  }

  // Build dynamic INSERT...ON CONFLICT...DO UPDATE. Column names are
  // whitelisted above so no SQL injection risk from req.body.
  const cols = Object.keys(updates);
  const vals = cols.map(c => updates[c]);
  const placeholders = cols.map(() => '?').join(', ');
  const setClause = cols.map(c => `${c} = excluded.${c}`).join(', ');

  db.get().prepare(`
    INSERT INTO renderer_settings (renderer_id, ${cols.join(', ')}, last_used_at)
    VALUES (?, ${placeholders}, COALESCE((SELECT last_used_at FROM renderer_settings WHERE renderer_id = ?), unixepoch()))
    ON CONFLICT(renderer_id) DO UPDATE SET ${setClause}
  `).run(id, ...vals, id);

  res.json({ ok: true, id, applied: updates });
});

// POST /api/audio/devices/:id/settings — update bypass_dsp and/or
// dsd_mode for a specific ALSA renderer.
router.post('/devices/:id/settings', (req, res) => {
  const id = req.params.id;
  const dev = detect.getDevice(id);
  if (!dev) return res.status(404).json({ error: 'Device not found' });
  const { bypass_dsp, dsd_mode } = req.body || {};
  if (typeof bypass_dsp === 'boolean') {
    alsa.setSetting(id, 'bypass_dsp', bypass_dsp);
  }
  if (typeof dsd_mode === 'string') {
    if (!['auto', 'pcm', 'dop', 'native'].includes(dsd_mode)) {
      return res.status(400).json({ error: 'dsd_mode must be auto/pcm/dop/native' });
    }
    alsa.setSetting(id, 'dsd_mode', dsd_mode);
  }
  // Return the updated row so the UI refreshes without a second call.
  const all = alsa.list();
  const updated = all.find(r => r.id === id);
  res.json({ device: updated });
});

// POST /api/audio/devices/:id/test — play a 2-second 1 kHz sine
// wave through the specified DAC. Used by the "Test" button to
// verify the audio path is working.
router.post('/devices/:id/test', async (req, res) => {
  const id = req.params.id;
  const dev = detect.getDevice(id);
  if (!dev) return res.status(404).json({ error: 'Device not found' });
  try {
    await alsa.playTestTone(id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Test playback failed' });
  }
});

module.exports = router;
