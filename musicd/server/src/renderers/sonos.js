/**
 * Sonos discovery + control. Sonos uses DLNA-compatible UPnP on port 1400.
 * We rely on SSDP discovery for `urn:schemas-upnp-org:device:ZonePlayer:1`.
 *
 * For simplicity and bit-perfect-friendliness we use AVTransport SOAP same as DLNA.
 * This works for native FLAC/MP3/WAV/AIFF formats up to Sonos's spec (16/44.1 typically;
 * Sonos S2 supports 24/48 on newer hardware).
 */
const { Client: SsdpClient } = require('node-ssdp');
const axios = require('axios');
const xml2js = require('xml2js');

const renderers = new Map();
let ssdp = null;
let stableTimer = null;
let pruneTimer = null;

const SONOS_TARGET = 'urn:schemas-upnp-org:device:ZonePlayer:1';

// v1.1.3.8 — ZoneGroupTopology. Ported from MusicD-Server-Bridge's
// dev.5 satellite filter, reimplemented on raw SOAP so we don't pull
// in the `sonos` npm library for one query (this module is already
// pure SOAP + xml2js).
//
// The problem it solves: every ZonePlayer answers SSDP for itself, so
// a bonded stereo pair of Fives shows up as TWO renderers with the
// same extracted name. Only the group coordinator accepts transport
// commands — the satellite returns a UPnP 500 and plays nothing. From
// the UI both entries look identical, so "one of my two Fives works
// and the other doesn't" is the expected symptom.
//
// ZoneGroupTopology is household-wide: any one speaker returns the
// state of every group, so a single query covers all of them.
const ZGT_SERVICE = 'urn:schemas-upnp-org:service:ZoneGroupTopology:1';

// Cached household topology.
//   hidden — UUIDs that must not be registered (satellites, bonded
//            surrounds/subs, and members of a group they don't
//            coordinate).
//   rooms  — UUID -> user-set room name ("Living Room"), used for
//            display names.
//   ok     — false when the last query failed; we then fail OPEN and
//            register everything, exactly as we did before this
//            change. Better a renderer that 500s than a speaker the
//            user can no longer see.
const TOPO_TTL_MS = 30000;
let topo = { hidden: new Set(), rooms: new Map(), at: 0, ok: false };
let topoInFlight = null;
const loggedHidden = new Set();

function escapeXml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

async function describe(location) {
  try {
    const res = await axios.get(location, { timeout: 4000 });
    const parsed = await xml2js.parseStringPromise(res.data, { explicitArray: false });
    const dev = parsed?.root?.device;
    if (!dev) return null;
    return {
      friendlyName: dev.friendlyName,
      uuid: dev.UDN?.replace(/^uuid:/, ''),
      modelName: dev.modelName,
      manufacturer: dev.manufacturer,
    };
  } catch { return null; }
}

async function onSsdpResponse(headers) {
  const loc = headers.LOCATION;
  if (!loc) return;
  if (!/sonos|zoneplayer/i.test(headers.ST || '')) return;

  const u = new URL(loc);
  const ip = u.hostname;
  const port = u.port || '1400';
  const id = `sonos:${ip}`;
  if (renderers.has(id)) {
    renderers.get(id).lastSeen = Date.now();
    return;
  }

  const info = await describe(loc);
  if (!info) return;

  // v1.1.3.8 — Sonos's UDN is the RINCON id that ZoneGroupTopology
  // keys on, so we can match a speaker to its group without a second
  // per-device query.
  const uuid = info.uuid || null;
  await ensureTopology(ip, port);
  if (uuid && topo.ok && topo.hidden.has(uuid)) {
    // Bonded satellite (or a room grouped under another). Its
    // coordinator is registered separately and drives both speakers;
    // registering this one would offer the user a device that answers
    // discovery but 500s on play.
    if (!loggedHidden.has(uuid)) {
      loggedHidden.add(uuid);
      console.log(`🔗 Sonos: skipping ${info.friendlyName || ip} — bonded satellite, its coordinator handles playback`);
    }
    renderers.delete(id);
    return;
  }
  loggedHidden.delete(uuid);

  // Sonos's UPnP friendlyName is unhelpfully verbose, e.g.
  //   "192.168.0.238 - Sonos Beam - RINCON_542A1BDE75FC01400"
  // Extract just "Sonos <Model>" when we can. The actual room/zone
  // name (e.g. "Living Room") would require a separate query to
  // DeviceProperties.GetZoneAttributes -- not done here to keep
  // discovery cheap and synchronous (#v1.1.0.6).
  const cleanName = (() => {
    const fn = info.friendlyName || '';
    // Try to extract the "Sonos <Model>" middle segment from the dash-
    // separated Sonos friendlyName format.
    const match = fn.match(/Sonos\s+([A-Za-z][A-Za-z0-9+ ]*?)(\s*[-–]|$)/);
    if (match) return `Sonos ${match[1].trim()}`;
    // Fallback: use modelName if Sonos provided one
    if (info.modelName && /^Sonos/i.test(info.modelName)) return info.modelName;
    if (info.modelName) return `Sonos ${info.modelName}`;
    // Last resort: keep the raw friendlyName, or synthesise from IP
    return fn || `Sonos ${ip}`;
  })();

  // Prefer "Living Room - Sonos Five" from topology; fall back to the
  // friendlyName-derived name when topology is unavailable.
  const displayName = topologyName(uuid, info.modelName) || cleanName;

  renderers.set(id, {
    id,
    name: displayName,
    uuid,
    ip,
    port,
    location: loc,
    controlUrl: `http://${ip}:${port}/MediaRenderer/AVTransport/Control`,
    renderingControlUrl: `http://${ip}:${port}/MediaRenderer/RenderingControl/Control`,
    model: info.modelName,
    // Sonos S2 / modern hardware tops out at 24-bit / 48 kHz on the FLAC path.
    // Anything above that must be downsampled by the server (within sample-rate
    // family — see stream.js for the integer-division rule). We declare both
    // limits here so the stream pipeline and signal-path UI know the ceiling.
    capabilities: {
      protocols: ['audio/flac', 'audio/mpeg', 'audio/wav'],
      maxBitDepth: 24,
      maxSampleRate: 48000,
    },
    lastSeen: Date.now(),
  });
  console.log(`🔊 Sonos: ${displayName} (${ip})`);
}

// xml2js with explicitArray:false still returns arrays when a node
// repeats, so every topology accessor goes through this.
function asArray(x) {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

// ChannelMapSet / HTSatChanMapSet look like:
//   "RINCON_AAA01400:LF,LF;RINCON_BBB01400:RF,RF"
// The member's own UUID is the primary; every other UUID in the set is
// a bonded speaker that must not be addressed directly.
function channelMapUuids(mapSet) {
  if (!mapSet || typeof mapSet !== 'string') return [];
  return mapSet.split(';')
    .map(part => part.split(':')[0].trim())
    .filter(Boolean);
}

/**
 * Parse a <ZoneGroupState> document into { hidden, rooms }.
 *
 * Exported for tests. Firmware varies in how it represents a bonded
 * pair — some builds list the satellite as its own ZoneGroupMember
 * with Invisible="1", others omit it entirely and only name it in the
 * coordinator's ChannelMapSet, and home-theatre sets nest <Satellite>
 * elements. All three are handled, so a speaker is hidden if ANY of
 * these say it isn't independently addressable.
 */
async function parseZoneGroupState(innerXml) {
  const hidden = new Set();
  const rooms = new Map();
  const doc = await xml2js.parseStringPromise(innerXml, {
    explicitArray: false, mergeAttrs: true,
  });
  const groups = asArray(doc?.ZoneGroupState?.ZoneGroups?.ZoneGroup
                      ?? doc?.ZoneGroups?.ZoneGroup);

  for (const g of groups) {
    const coordinator = g?.Coordinator;
    for (const m of asArray(g?.ZoneGroupMember)) {
      const uuid = m?.UUID;
      if (!uuid) continue;
      if (m.ZoneName) rooms.set(uuid, String(m.ZoneName).trim());

      // (a) Explicitly invisible — bonded satellite or hidden bridge.
      if (String(m.Invisible) === '1') hidden.add(uuid);

      // (b) Not the coordinator of its own group. Covers both a bonded
      //     pair's second speaker and a room the user has grouped into
      //     another room in the Sonos app — in both cases playback is
      //     driven by the coordinator, and the Sonos app itself shows
      //     the set as one entry.
      if (coordinator && uuid !== coordinator) hidden.add(uuid);

      // (c) Bonded channels named in this member's channel maps.
      for (const bonded of [
        ...channelMapUuids(m.ChannelMapSet),
        ...channelMapUuids(m.HTSatChanMapSet),
      ]) {
        if (bonded !== uuid) hidden.add(bonded);
      }

      // (d) Nested <Satellite> elements (home-theatre surrounds/sub).
      for (const sat of asArray(m.Satellite)) {
        if (sat?.UUID) hidden.add(sat.UUID);
      }
    }
  }
  // A coordinator must never be hidden by another member's stale map.
  for (const g of groups) {
    if (g?.Coordinator) hidden.delete(g.Coordinator);
  }
  return { hidden, rooms };
}

// Query ZoneGroupTopology on `ip`. Household-wide, so one reachable
// speaker describes them all.
async function fetchTopology(ip, port) {
  const url = `http://${ip}:${port || 1400}/ZoneGroupTopology/Control`;
  const data = await soap(url, ZGT_SERVICE, 'GetZoneGroupState', '');
  const parsed = await xml2js.parseStringPromise(data, { explicitArray: false });
  // The response carries the real document as an escaped XML string,
  // so it needs a second parse.
  const inner = parsed?.['s:Envelope']?.['s:Body']
    ?.['u:GetZoneGroupStateResponse']?.ZoneGroupState;
  if (!inner) throw new Error('no ZoneGroupState in response');
  return parseZoneGroupState(inner);
}

// Refresh the cache if stale. Concurrent callers share one request —
// SSDP delivers a burst of responses at once and we don't want a
// topology query per speaker.
async function ensureTopology(ip, port) {
  if (Date.now() - topo.at < TOPO_TTL_MS) return topo;
  if (topoInFlight) return topoInFlight;
  topoInFlight = (async () => {
    // Prefer a speaker we already know; fall back to the caller's.
    const seeds = [];
    for (const r of renderers.values()) seeds.push([r.ip, r.port]);
    if (ip) seeds.push([ip, port]);
    if (seeds.length === 0) {
      // No Sonos known yet — the sweep timer runs before the first
      // SSDP reply arrives. Nothing to query and nothing to warn
      // about; leave the cache expired so the next call retries.
      return topo;
    }
    for (const [sIp, sPort] of seeds) {
      try {
        const next = await fetchTopology(sIp, sPort);
        topo = { ...next, at: Date.now(), ok: true };
        return topo;
      } catch { /* try the next speaker */ }
    }
    // Every speaker refused. Fail open: keep the previous hidden set
    // if we had one, but mark the cache stale-but-attempted so we
    // retry on the next sweep rather than every SSDP packet.
    console.warn('⚠️  Sonos: ZoneGroupTopology query failed — registering all speakers');
    topo = { hidden: topo.hidden, rooms: topo.rooms, at: Date.now(), ok: false };
    return topo;
  })().finally(() => { topoInFlight = null; });
  return topoInFlight;
}

// Display name for a coordinator: "Living Room - Sonos Five". The room
// name is what the user set in the Sonos app and is shared by both
// halves of a pair, so it beats the raw UPnP friendlyName (which Sonos
// sets to things like "192.168.0.93 - Sonos Five" or "Living Room (LF)
// - Sonos Five" — the "(LF)" being the bonded-side designator that
// made both halves collapse to the same extracted name).
function topologyName(uuid, modelName) {
  const room = uuid && topo.rooms.get(uuid);
  if (!room) return null;
  const model = modelName && /^sonos/i.test(modelName)
    ? modelName
    : (modelName ? `Sonos ${modelName}` : null);
  return model ? `${room} - ${model}` : room;
}

// Drop any registered renderer the current topology says is a
// satellite, and refresh names/rooms on the survivors. Runs after each
// topology refresh so a pair created or broken in the Sonos app is
// reflected on the next sweep without a restart.
function reconcileTopology() {
  if (!topo.ok) return;
  for (const [id, r] of renderers.entries()) {
    if (r.uuid && topo.hidden.has(r.uuid)) {
      renderers.delete(id);
      console.log(`🔗 Sonos: ${r.name} (${r.ip}) is a bonded satellite — hidden, its coordinator handles playback`);
      continue;
    }
    const better = topologyName(r.uuid, r.model);
    if (better && better !== r.name) {
      console.log(`🔊 Sonos: renamed ${r.name} → ${better}`);
      r.name = better;
    }
  }
}

function startDiscovery() {
  ssdp = new SsdpClient();
  ssdp.on('response', onSsdpResponse);
  ssdp.start();
  triggerSearch();
  // Re-search every 60s
  stableTimer = setInterval(() => triggerSearch(), 60000);
  // Prune entries we haven't seen recently (#v1.1.0.6, tightened in
  // v1.1.0.7). 90s TTL matches DLNA + Squeezelite -- fast enough that
  // a powered-off Sonos drops within ~2 min, slow enough to ride out
  // a single missed SSDP burst (re-search interval is 60s).
  pruneTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, r] of renderers.entries()) {
      if (now - r.lastSeen > 90 * 1000) {
        renderers.delete(id);
        console.log(`🧹 Removed stale Sonos: ${r.name}`);
      }
    }
  }, 30000);
}
function triggerSearch() {
  if (!ssdp) return;
  // Same as DLNA: manual refresh force-prunes stale entries before
  // the SSDP burst, so the user sees disconnected Sonos devices
  // disappear immediately rather than waiting for the next sweep
  // (#v1.1.0.7).
  const now = Date.now();
  let removed = 0;
  for (const [id, r] of renderers.entries()) {
    if (now - r.lastSeen > 90 * 1000) {
      renderers.delete(id);
      removed++;
      console.log(`🧹 Removed stale Sonos on manual refresh: ${r.name}`);
    }
  }
  if (removed > 0 && global.broadcastState) {
    // Trigger a renderer-list rebroadcast via the manager. We don't
    // have direct access to the cross-protocol getRenderers() here,
    // but DLNA's prune does its own broadcast and sonos.list() will
    // be called next time the UI polls -- that's good enough.
  }
  // v1.1.3.8 — re-read the topology each sweep so a pair created or
  // broken in the Sonos app is reflected without a server restart.
  // Force-expire the cache first: this runs on the 60s timer and on
  // manual refresh, both of which should see current state.
  topo.at = 0;
  ensureTopology()
    .then(reconcileTopology)
    .catch(e => console.warn(`⚠️  Sonos topology refresh failed: ${e.message}`));

  try { ssdp.search(SONOS_TARGET); } catch {}
}
function stopDiscovery() {
  if (ssdp) { try { ssdp.stop(); } catch {} ssdp = null; }
  if (stableTimer) clearInterval(stableTimer);
  if (pruneTimer) clearInterval(pruneTimer);
}

function list() {
  return Array.from(renderers.values()).map(r => ({
    id: r.id, name: r.name, ip: r.ip, capabilities: r.capabilities, model: r.model,
  }));
}

async function soap(url, service, action, body) {
  const envelope = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${service}">${body}</u:${action}></s:Body></s:Envelope>`;
  const res = await axios.post(url, envelope, {
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      'SOAPAction': `"${service}#${action}"`,
    }, timeout: 5000,
  });
  return res.data;
}

const { predictStreamFormat } = require('../streamFormat');

// Build DIDL-Lite metadata for a track. Honest: includes title,
// artist, album, and an accurate `protocolInfo` mime that mirrors
// what the stream endpoint will actually serve. Earlier versions
// hardcoded `audio/flac`, which was a lie for non-FLAC pass-through
// streams; some Sonos firmware notices and refuses to play.
// v1.1.6.0 — DIDL wants H:MM:SS(.mmm) for a res duration. Sonos uses it to
// know how long the item is; without it the item looks like a stream of
// unknown length, which is the shape of thing Sonos reports odd transport
// positions for.
function didlDuration(seconds) {
  const total = Number(seconds);
  if (!isFinite(total) || total <= 0) return null;
  const whole = Math.floor(total);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const sec = whole % 60;
  const ms = Math.round((total - whole) * 1000);
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` +
         `.${String(ms).padStart(3, '0')}`;
}

function buildDidl(track, streamUrl, rendererId, sourceRate) {
  const fmt = predictStreamFormat(track, rendererId, sourceRate);
  const title  = escapeXml(track?.title  || 'Track');
  const artist = escapeXml(track?.artist || '');
  const album  = escapeXml(track?.album  || '');
  // Omitted entirely when the duration is unknown — an empty or zero
  // duration attribute is worse than none, as Sonos parses it as 0:00:00.
  const dur = didlDuration(track?.duration);
  const durationAttr = dur ? ` duration="${dur}"` : '';
  return (
    '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ' +
      'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
      'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">' +
    '<item id="0" parentID="-1" restricted="1">' +
      `<dc:title>${title}</dc:title>` +
      (artist ? `<dc:creator>${artist}</dc:creator>` : '') +
      (album  ? `<upnp:album>${album}</upnp:album>`  : '') +
      '<upnp:class>object.item.audioItem.musicTrack</upnp:class>' +
      `<res protocolInfo="http-get:*:${fmt.mime}:*"${durationAttr}>${escapeXml(streamUrl)}</res>` +
    '</item>' +
    '</DIDL-Lite>'
  );
}

async function play(id, streamUrl, track) {
  const r = renderers.get(id); if (!r) throw new Error('Sonos not found');
  const meta = buildDidl(track, streamUrl, id, track?.sample_rate);
  await soap(r.controlUrl, 'urn:schemas-upnp-org:service:AVTransport:1', 'SetAVTransportURI',
    `<InstanceID>0</InstanceID><CurrentURI>${escapeXml(streamUrl)}</CurrentURI><CurrentURIMetaData>${escapeXml(meta)}</CurrentURIMetaData>`);
  await soap(r.controlUrl, 'urn:schemas-upnp-org:service:AVTransport:1', 'Play',
    `<InstanceID>0</InstanceID><Speed>1</Speed>`);
}

// Gapless pre-queue: load the next track's URI on the device while the current
// one is still playing. Sonos honours this and crossfades-or-cuts cleanly
// depending on the device's gapless settings. Failure here is non-fatal — the
// player loop will fall back to a stop-then-play transition.
async function playNext(id, streamUrl, track) {
  const r = renderers.get(id); if (!r) throw new Error('Sonos not found');
  const meta = buildDidl(track, streamUrl, id, track?.sample_rate);
  await soap(r.controlUrl, 'urn:schemas-upnp-org:service:AVTransport:1', 'SetNextAVTransportURI',
    `<InstanceID>0</InstanceID><NextURI>${escapeXml(streamUrl)}</NextURI><NextURIMetaData>${escapeXml(meta)}</NextURIMetaData>`);
}

// Clear a pre-queued NextURI before issuing a manual skip so the gapless
// target doesn't follow the user-skipped track. Best-effort.
async function clearNext(id) {
  const r = renderers.get(id); if (!r) return;
  try {
    await soap(r.controlUrl, 'urn:schemas-upnp-org:service:AVTransport:1', 'SetNextAVTransportURI',
      `<InstanceID>0</InstanceID><NextURI></NextURI><NextURIMetaData></NextURIMetaData>`);
  } catch (e) { /* non-fatal */ }
}
async function pause(id) {
  const r = renderers.get(id); if (!r) throw new Error('Sonos not found');
  await soap(r.controlUrl, 'urn:schemas-upnp-org:service:AVTransport:1', 'Pause', '<InstanceID>0</InstanceID>');
}
// Resume from paused (#v1.1.0.40). Sonos's UPnP transport doesn't have
// a separate "resume" verb -- a bare Play action while the transport
// holds a URI continues from the paused position. Previously the
// renderer dispatcher fell back to play(id) with no streamUrl, which
// caused sonos.play() to issue SetAVTransportURI with `undefined` as
// the URI before calling Play -- that wiped the loaded URI and the
// speaker briefly went to STOPPED, which the UI saw as a play→pause
// flicker with no audio. The fix: implement resume() so the
// dispatcher takes the early-return path at index.js:141 instead of
// falling through to the broken last-ditch.
async function resume(id) {
  const r = renderers.get(id); if (!r) throw new Error('Sonos not found');
  await soap(r.controlUrl, 'urn:schemas-upnp-org:service:AVTransport:1', 'Play',
    '<InstanceID>0</InstanceID><Speed>1</Speed>');
}

// Seek to a position within the current track. Used by the resume path
// in playerState (#v1.1.0.43) to recover when a long pause has caused
// Sonos to drop the loaded URI -- we re-load via play() and then Seek
// to the saved position.
async function seek(id, seconds) {
  const r = renderers.get(id); if (!r) throw new Error('Sonos not found');
  const sec = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const target = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  await soap(r.controlUrl, 'urn:schemas-upnp-org:service:AVTransport:1', 'Seek',
    `<InstanceID>0</InstanceID><Unit>REL_TIME</Unit><Target>${target}</Target>`);
}
async function stop(id) {
  const r = renderers.get(id); if (!r) throw new Error('Sonos not found');
  await soap(r.controlUrl, 'urn:schemas-upnp-org:service:AVTransport:1', 'Stop', '<InstanceID>0</InstanceID>');
}
async function setVolume(id, vol) {
  const r = renderers.get(id); if (!r) throw new Error('Sonos not found');
  await soap(r.renderingControlUrl, 'urn:schemas-upnp-org:service:RenderingControl:1', 'SetVolume',
    `<InstanceID>0</InstanceID><Channel>Master</Channel><DesiredVolume>${Math.max(0, Math.min(100, vol))}</DesiredVolume>`);
}
async function getPositionInfo(id) {
  const r = renderers.get(id); if (!r) return null;
  try {
    const data = await soap(r.controlUrl, 'urn:schemas-upnp-org:service:AVTransport:1', 'GetPositionInfo', '<InstanceID>0</InstanceID>');
    const parsed = await xml2js.parseStringPromise(data, { explicitArray: false });
    const info = parsed?.['s:Envelope']?.['s:Body']?.['u:GetPositionInfoResponse'];
    return {
      position: parseDuration(info?.RelTime),
      duration: parseDuration(info?.TrackDuration),
    };
  } catch { return null; }
}
async function getTransportInfo(id) {
  const r = renderers.get(id); if (!r) return null;
  try {
    const data = await soap(r.controlUrl, 'urn:schemas-upnp-org:service:AVTransport:1', 'GetTransportInfo', '<InstanceID>0</InstanceID>');
    const parsed = await xml2js.parseStringPromise(data, { explicitArray: false });
    const info = parsed?.['s:Envelope']?.['s:Body']?.['u:GetTransportInfoResponse'];
    return { state: info?.CurrentTransportState || 'STOPPED' };
  } catch { return null; }
}

function parseDuration(s) {
  if (!s) return 0;
  const m = String(s).match(/^(\d+):(\d+):(\d+)/);
  if (!m) return 0;
  return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]);
}

module.exports = {
  startDiscovery, stopDiscovery, triggerSearch,
  list, play, playNext, clearNext, pause, resume, seek, stop, setVolume, getPositionInfo, getTransportInfo,
  // Exposed for tests.
  parseZoneGroupState, fetchTopology, buildDidl, didlDuration,
};
