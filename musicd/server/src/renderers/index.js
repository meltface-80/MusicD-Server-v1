/**
 * Unified renderer registry — coordinates DLNA, Sonos and Squeezelite.
 *
 * Each protocol module exposes:
 *   - startDiscovery() / stopDiscovery()
 *   - list() returning [{ id, name, ip, protocol, capabilities }]
 *   - play(rendererId, streamUrl, track)
 *   - pause(rendererId)
 *   - stop(rendererId)
 *   - setVolume(rendererId, vol0to100)
 *   - getPositionInfo(rendererId) returning { position, duration } | null
 *   - getTransportInfo(rendererId) returning { state: 'PLAYING'|'PAUSED_PLAYBACK'|'STOPPED' }
 *
 * The registry merges all renderers into a single list with stable IDs prefixed by protocol.
 *
 * (#29.4) AirPlay and Chromecast support were removed — the underlying
 * libraries had reliability problems on a Pi-class device and the maintained
 * UPnP/Sonos/LMS paths cover the same use cases more robustly.
 */

// Optional require — protocol modules pull in native deps that may not build
// on every host. If require fails, we log a warning and skip that protocol
// instead of crashing the whole server.
function safeRequire(name) {
  try {
    return require(name);
  } catch (e) {
    console.warn(`⚠️  ${name} disabled: ${e.message.split('\n')[0]}`);
    return null;
  }
}

const dlna = safeRequire('./dlna');
const sonos = safeRequire('./sonos');
const squeezelite = safeRequire('./squeezelite');
// USB DAC output (#v1.1.0.0). Loaded as a "protocol" alongside the
// network-renderer modules. The actual ALSA module lives in
// ../audio/alsa.js -- this is just a thin require with a friendly
// name so list() returns 'alsa' as the protocol tag.
const alsa = safeRequire('../audio/alsa');

// Only register protocols that loaded successfully
const protocols = Object.fromEntries(
  Object.entries({ dlna, sonos, squeezelite, alsa })
    .filter(([, m]) => m !== null)
);

async function startDiscovery() {
  const entries = Object.entries(protocols);
  const results = await Promise.allSettled(
    entries.map(([, p]) => p.startDiscovery && p.startDiscovery())
  );
  for (const [i, r] of results.entries()) {
    if (r.status === 'rejected') {
      console.warn(`⚠️  ${entries[i][0]} discovery failed: ${r.reason?.message || r.reason}`);
    }
  }
}

function stopDiscovery() {
  for (const p of Object.values(protocols)) {
    try { p.stopDiscovery && p.stopDiscovery(); } catch {}
  }
}

function triggerSearch() {
  for (const p of Object.values(protocols)) {
    try { p.triggerSearch && p.triggerSearch(); } catch {}
  }
}

// v1.1.0.68 — apply user customisations (custom_name + icon_id)
// from renderer_settings to a renderer object as it's listed. We
// do this in one helper so list(), getRenderer() and any future
// caller all get the same result. Without this, the user's rename
// shows up on the Audio Devices page (which queries renderer_settings
// directly via /audio/all) but not on the Output sheet, mini-bar or
// sidebar — those all hit list()/getRenderer() and would still show
// the discovered name.
function applyOverrides(r) {
  if (!r || !r.id) return r;
  try {
    const db = require('../db').get();
    const row = db.prepare('SELECT custom_name, icon_id FROM renderer_settings WHERE renderer_id = ?').get(r.id);
    if (!row) return r;
    const customName = row.custom_name && row.custom_name.trim() ? row.custom_name.trim() : null;
    return {
      ...r,
      name: customName || r.name,
      discovered_name: r.name,
      custom_name: customName,
      icon_id: row.icon_id || null,
    };
  } catch (e) {
    // db not ready or some other transient — return unmodified.
    return r;
  }
}

function list() {
  const all = [];
  for (const [name, p] of Object.entries(protocols)) {
    try {
      const items = p.list ? p.list() : [];
      for (const r of items) all.push(applyOverrides({ ...r, protocol: name }));
    } catch (e) {
      console.warn(`list() failed for ${name}:`, e.message);
    }
  }
  return all;
}

function getRenderer(id) {
  if (!id) return null;
  for (const [name, p] of Object.entries(protocols)) {
    try {
      const items = p.list ? p.list() : [];
      const found = items.find(r => r.id === id);
      if (found) return applyOverrides({ ...found, protocol: name });
    } catch {}
  }
  return null;
}

function getProtocol(id) {
  const r = getRenderer(id);
  if (!r) return null;
  return protocols[r.protocol];
}

async function play(id, streamUrl, track) {
  const p = getProtocol(id);
  if (!p) throw new Error('Renderer not found');
  return p.play(id, streamUrl, track);
}

// Pre-queue the next track on a renderer that supports gapless transition.
// Returns true on success, false on unsupported / failure (caller can fall
// back to stop-then-play).
async function playNext(id, streamUrl, track) {
  const p = getProtocol(id);
  if (!p || !p.playNext) return false;
  try {
    await p.playNext(id, streamUrl, track);
    return true;
  } catch (e) {
    return false;
  }
}

// Cancel a previously-pre-queued NextURI. Best-effort — if the protocol module
// doesn't implement it, returns silently.
async function clearNext(id) {
  const p = getProtocol(id);
  if (!p || !p.clearNext) return;
  try { await p.clearNext(id); } catch (e) { /* non-fatal */ }
}
async function pause(id) {
  const p = getProtocol(id);
  if (!p) throw new Error('Renderer not found');
  return p.pause(id);
}
async function resume(id) {
  const p = getProtocol(id);
  if (!p) throw new Error('Renderer not found');
  // Each protocol implements its own resume. Sonos's resume issues
  // a bare UPnP Play action; squeezelite's resume issues `pause 0`;
  // ALSA's resume restarts from the held position.
  if (p.resume) return p.resume(id);
  // Last-ditch: re-issue play with no URL (some protocols treat this
  // as resume). Note this is unsafe for protocols whose play()
  // requires a streamUrl -- if you see broken resume behaviour,
  // implement a proper resume() on the protocol module rather than
  // relying on this fallback.
  if (p.play) return p.play(id);
  throw new Error('Resume not supported');
}
async function stop(id) {
  const p = getProtocol(id);
  if (!p) throw new Error('Renderer not found');
  return p.stop(id);
}
async function setVolume(id, vol) {
  const p = getProtocol(id);
  if (!p) throw new Error('Renderer not found');
  return p.setVolume ? p.setVolume(id, vol) : null;
}
async function seek(id, seconds) {
  const p = getProtocol(id);
  if (!p) return null;
  return p.seek ? p.seek(id, seconds) : null;
}
async function getPositionInfo(id) {
  const p = getProtocol(id);
  if (!p) return null;
  return p.getPositionInfo ? p.getPositionInfo(id) : null;
}
async function getTransportInfo(id) {
  const p = getProtocol(id);
  if (!p) return null;
  return p.getTransportInfo ? p.getTransportInfo(id) : null;
}

module.exports = {
  startDiscovery, stopDiscovery, triggerSearch,
  list, getRenderer, getProtocol,
  play, playNext, clearNext, pause, resume, seek, stop, setVolume,
  getPositionInfo, getTransportInfo,
};
