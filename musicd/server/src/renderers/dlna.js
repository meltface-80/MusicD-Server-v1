const { Client: SsdpClient, Server: SsdpServer } = require('node-ssdp');
const axios = require('axios');
const xml2js = require('xml2js');
const { v4: uuidv4 } = require('uuid');
const { predictStreamFormat } = require('../streamFormat');

const renderers = new Map();
let ssdpClient;
let ssdpServer;
let searchTimer;
let cleanupTimer;

const SEARCH_TYPES = [
  'urn:schemas-upnp-org:device:MediaRenderer:1',
  'urn:schemas-upnp-org:service:AVTransport:1',
];
const STALE_TIMEOUT_MS = 90 * 1000; // remove renderers not seen for 90s (#v1.1.0.7, was 5 min)

async function startDiscovery() {
  // Idempotent — only initialise once
  if (ssdpClient) {
    triggerSearch();
    return;
  }

  ssdpClient = new SsdpClient();
  ssdpClient.on('response', async (headers, statusCode, rinfo) => {
    if (headers.LOCATION) await handleRendererFound(headers, rinfo);
  });

  try {
    ssdpServer = new SsdpServer();
    ssdpServer.on('advertise-alive', async (headers, rinfo) => {
      if (headers.LOCATION) await handleRendererFound(headers, rinfo);
    });
    ssdpServer.on('advertise-bye', (headers) => {
      // Remove renderer that announces it's leaving
      const udn = (headers.USN || '').split('::')[0].replace('uuid:', '').trim();
      if (udn && renderers.has(udn)) {
        renderers.delete(udn);
        if (global.broadcastState) global.broadcastState('renderers_updated', getRenderers());
      }
    });
    await ssdpServer.start();
  } catch (e) {
    console.warn('SSDP passive listener failed (non-fatal):', e.message);
  }

  triggerSearch();
  searchTimer = setInterval(triggerSearch, 30000);

  // Stale-renderer sweep (#8, tightened to 30s in v1.1.0.7). With a
  // 90s TTL and 30s sweep, a disappeared device drops within ~2 min.
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    let removed = 0;
    for (const [id, r] of renderers) {
      if (r.type === 'squeezelite') continue; // squeeze module manages its own lifecycle
      if (now - r.lastSeen > STALE_TIMEOUT_MS) {
        renderers.delete(id);
        removed++;
      }
    }
    if (removed > 0 && global.broadcastState) {
      global.broadcastState('renderers_updated', getRenderers());
    }
  }, 30000);

  console.log('🔊 DLNA discovery started');
}

function triggerSearch() {
  if (!ssdpClient) return;
  // Manual triggerSearch fires when the user taps the refresh button.
  // We immediately mark anything stale-but-not-yet-pruned for removal
  // BEFORE the SSDP burst goes out, so the user sees disconnected
  // devices disappear right after the spinner stops -- not 30s later
  // when the next sweep runs (#v1.1.0.7).
  const now = Date.now();
  let removed = 0;
  for (const [id, r] of renderers) {
    if (r.type === 'squeezelite') continue;
    if (now - r.lastSeen > STALE_TIMEOUT_MS) {
      renderers.delete(id);
      removed++;
    }
  }
  if (removed > 0 && global.broadcastState) {
    global.broadcastState('renderers_updated', getRenderers());
  }
  for (const st of SEARCH_TYPES) {
    try { ssdpClient.search(st); } catch (e) {}
  }
}

function stopDiscovery() {
  if (searchTimer) clearInterval(searchTimer);
  if (cleanupTimer) clearInterval(cleanupTimer);
  if (ssdpServer) try { ssdpServer.stop(); } catch (e) {}
  if (ssdpClient) try { ssdpClient.stop(); } catch (e) {}
}

async function handleRendererFound(headers, rinfo) {
  const location = headers.LOCATION || headers.Location;
  if (!location) return;
  try {
    const res = await axios.get(location, { timeout: 3000 });
    const parsed = await xml2js.parseStringPromise(res.data, { explicitArray: false });
    const device = parsed?.root?.device;
    if (!device) return;
    const deviceType = device.deviceType || '';
    if (!deviceType.includes('MediaRenderer')) return;

    const udn = device.UDN || uuidv4();
    const id = udn.replace('uuid:', '').trim();
    if (renderers.has(id)) {
      renderers.get(id).lastSeen = Date.now();
      return;
    }

    const services = [].concat(device.serviceList?.service || []);
    let avtransportUrl = null;
    let renderingControlUrl = null;
    const baseUrl = new URL(location);
    const base = `${baseUrl.protocol}//${baseUrl.host}`;

    for (const svc of services) {
      const type = svc.serviceType || '';
      if (type.includes('AVTransport')) avtransportUrl = base + svc.controlURL;
      if (type.includes('RenderingControl')) renderingControlUrl = base + svc.controlURL;
    }
    if (!avtransportUrl) return;

    renderers.set(id, {
      id, name: device.friendlyName || 'Unknown Renderer',
      manufacturer: device.manufacturer || '',
      model: device.modelName || '',
      udn, location, ip: rinfo.address,
      avtransportUrl, renderingControlUrl,
      capabilities: detectCapabilities(device),
      lastSeen: Date.now(),
    });
    console.log(`🔊 Found renderer: ${device.friendlyName} (${rinfo.address})`);
    if (global.broadcastState) global.broadcastState('renderers_updated', getRenderers());
  } catch (e) {}
}

function detectCapabilities(device) {
  const caps = { protocols: ['audio/mpeg', 'audio/flac', 'audio/wav', 'audio/x-wav'] };
  const mfr = (device.manufacturer || '').toLowerCase();
  const model = (device.modelName || '').toLowerCase();
  if (mfr.includes('linn') || mfr.includes('naim') || model.includes('ds')) {
    caps.protocols.push('audio/x-dsd');
    caps.isDSD = true;
  }
  return caps;
}

async function sendSoapAction(url, serviceType, action, args = {}) {
  const argsXml = Object.entries(args).map(([k, v]) => `<${k}>${escapeXml(String(v))}</${k}>`).join('');
  const body = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body><u:${action} xmlns:u="${serviceType}">${argsXml}</u:${action}></s:Body>
</s:Envelope>`;
  const response = await axios.post(url, body, {
    headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': `"${serviceType}#${action}"` },
    timeout: 5000,
  });
  return xml2js.parseStringPromise(response.data, { explicitArray: false });
}

async function setAVTransportURI(rendererId, streamUrl, metadata) {
  const renderer = renderers.get(rendererId);
  if (!renderer) throw new Error('Renderer not found');
  await sendSoapAction(renderer.avtransportUrl, 'urn:schemas-upnp-org:service:AVTransport:1', 'SetAVTransportURI', {
    InstanceID: 0, CurrentURI: streamUrl, CurrentURIMetaData: buildDIDL(metadata, streamUrl, rendererId)
  });
}

// Pre-queue the *next* track's stream URI on the renderer while the current
// one is still playing. This is the UPnP-standard gapless mechanism — the
// device transitions from CurrentURI to NextURI without an inter-track gap
// because it can pre-buffer. Not all renderers implement it; ones that don't
// will reject the SOAP call with 401/501 and we silently fall back to the
// stop-then-play behaviour driven by playerState's polling loop.
async function setNextAVTransportURI(rendererId, streamUrl, metadata) {
  const renderer = renderers.get(rendererId);
  if (!renderer) throw new Error('Renderer not found');
  await sendSoapAction(renderer.avtransportUrl, 'urn:schemas-upnp-org:service:AVTransport:1', 'SetNextAVTransportURI', {
    InstanceID: 0, NextURI: streamUrl, NextURIMetaData: buildDIDL(metadata, streamUrl, rendererId)
  });
}

// Clear any pre-queued NextURI on the renderer. Called before user-initiated
// skips so the previously-queued gapless target doesn't leak into the new
// playback. UPnP convention is to send an empty NextURI; renderers that don't
// support this just throw and we ignore it (the new SetAVTransportURI on the
// skip will overwrite the current track anyway).
async function clearNextAVTransportURI(rendererId) {
  const renderer = renderers.get(rendererId);
  if (!renderer) return;
  try {
    await sendSoapAction(renderer.avtransportUrl, 'urn:schemas-upnp-org:service:AVTransport:1', 'SetNextAVTransportURI', {
      InstanceID: 0, NextURI: '', NextURIMetaData: ''
    });
  } catch (e) { /* non-fatal */ }
}

async function play(rendererId) {
  const renderer = renderers.get(rendererId);
  if (!renderer) throw new Error('Renderer not found');
  await sendSoapAction(renderer.avtransportUrl, 'urn:schemas-upnp-org:service:AVTransport:1', 'Play', { InstanceID: 0, Speed: '1' });
}

async function pause(rendererId) {
  const renderer = renderers.get(rendererId);
  if (!renderer) throw new Error('Renderer not found');
  await sendSoapAction(renderer.avtransportUrl, 'urn:schemas-upnp-org:service:AVTransport:1', 'Pause', { InstanceID: 0 });
}

async function stop(rendererId) {
  const renderer = renderers.get(rendererId);
  if (!renderer) throw new Error('Renderer not found');
  await sendSoapAction(renderer.avtransportUrl, 'urn:schemas-upnp-org:service:AVTransport:1', 'Stop', { InstanceID: 0 });
}

async function getTransportInfo(rendererId) {
  const renderer = renderers.get(rendererId);
  if (!renderer) return null;
  try {
    const result = await sendSoapAction(renderer.avtransportUrl, 'urn:schemas-upnp-org:service:AVTransport:1', 'GetTransportInfo', { InstanceID: 0 });
    const resp = result?.['s:Envelope']?.['s:Body']?.['u:GetTransportInfoResponse'];
    return { state: resp?.CurrentTransportState, status: resp?.CurrentTransportStatus };
  } catch (e) { return null; }
}

async function getPositionInfo(rendererId) {
  const renderer = renderers.get(rendererId);
  if (!renderer) return null;
  try {
    const result = await sendSoapAction(renderer.avtransportUrl, 'urn:schemas-upnp-org:service:AVTransport:1', 'GetPositionInfo', { InstanceID: 0 });
    const resp = result?.['s:Envelope']?.['s:Body']?.['u:GetPositionInfoResponse'];
    const relTime = resp?.RelTime;
    if (!relTime || relTime === 'NOT_IMPLEMENTED') return null;
    const parts = relTime.split(':').map(Number);
    return { position: (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0) };
  } catch (e) { return null; }
}

async function setVolume(rendererId, volume) {
  const renderer = renderers.get(rendererId);
  if (!renderer || !renderer.renderingControlUrl) return;
  await sendSoapAction(renderer.renderingControlUrl, 'urn:schemas-upnp-org:service:RenderingControl:1', 'SetVolume', {
    InstanceID: 0, Channel: 'Master', DesiredVolume: Math.round(volume)
  });
}

// Build the DIDL-Lite metadata blob. Returns RAW XML (with literal `<` and
// `>` characters); the SOAP builder in sendSoapAction will run escapeXml()
// on it when embedding into the SOAP envelope, producing a single round of
// entity encoding — which is what UPnP renderers expect.
//
// Earlier versions of this function returned pre-escaped (`&lt;`) DIDL,
// which then got double-escaped by the SOAP builder, sending nonsense
// metadata. Most renderers tolerated it (they fall back to extracting
// metadata from the stream URL), so audio still played — but the on-screen
// track/artist/album labels were wrong.
function buildDIDL(track, streamUrl, rendererId) {
  // Use the predictor so the DIDL `protocolInfo` matches what the
  // stream endpoint will actually serve. Critical for DLNA renderers
  // that strictly validate the claim against the response Content-Type
  // (a re-encode produces audio/flac regardless of source format).
  const fmt = predictStreamFormat(track, rendererId, track?.sample_rate);
  const safeTitle = stripCtrl(track.title || '');
  const safeArtist = stripCtrl(track.artist || '');
  const safeAlbum = stripCtrl(track.album || '');
  return `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="1" parentID="0" restricted="1"><dc:title>${escapeXml(safeTitle)}</dc:title><dc:creator>${escapeXml(safeArtist)}</dc:creator><upnp:album>${escapeXml(safeAlbum)}</upnp:album><upnp:class>object.item.audioItem.musicTrack</upnp:class><res protocolInfo="http-get:*:${fmt.mime}:*">${escapeXml(streamUrl)}</res></item></DIDL-Lite>`;
}

// Legacy: source-format mime lookup. Kept for callers that don't have
// renderer context available (e.g. logging, capability negotiation).
// New code should use predictStreamFormat() instead.
function getMimeType(format) {
  const map = { flac:'audio/flac', mp3:'audio/mpeg', dsf:'audio/x-dsd', dff:'audio/x-dsd', wav:'audio/wav', aiff:'audio/aiff', aif:'audio/aiff', ogg:'audio/ogg', opus:'audio/opus', m4a:'audio/mp4', wv:'audio/x-wavpack' };
  return map[(format || '').toLowerCase()] || 'audio/flac';
}

function stripCtrl(s) { return String(s).replace(/[\x00-\x1F\x7F]/g, ''); }

function escapeXml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function getRenderers() { return Array.from(renderers.values()); }
function getRenderer(id) { return renderers.get(id); }


// ---- New unified-renderer-interface adapters ----
function list() {
  return Array.from(renderers.values()).map(r => ({
    id: r.id,
    name: r.name,
    ip: r.ip,
    capabilities: r.capabilities || {},
  }));
}

async function playTrack(id, streamUrl, track) {
  await setAVTransportURI(id, streamUrl, track);
  await play(id);
}

async function playNext(id, streamUrl, track) {
  await setNextAVTransportURI(id, streamUrl, track);
}

async function clearNext(id) {
  return clearNextAVTransportURI(id);
}

module.exports = {
  startDiscovery, stopDiscovery, triggerSearch,
  rendererMap: renderers,
  setAVTransportURI, setNextAVTransportURI,
  play: playTrack,
  // Pre-queue the next track for gapless transition (UPnP SetNextAVTransportURI)
  playNext, clearNext,
  pause, stop, getTransportInfo, getPositionInfo,
  setVolume, getRenderers, getRenderer, getMimeType,
  list,
  // Resume from a paused state — sends only the Play SOAP action without re-setting the URI
  resume: play,
  // Legacy alias
  rawPlay: play,
};
