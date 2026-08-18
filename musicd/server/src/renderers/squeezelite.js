const axios = require('axios');

const LMS_HOST = process.env.LMS_HOST || '127.0.0.1';
const LMS_PORT = process.env.LMS_PORT || '9000';
const LMS_BASE = `http://${LMS_HOST}:${LMS_PORT}`;

// Tighter than the previous 5min default (#v1.1.0.7). Discovery polls
// every 60s, so 90s means a player that misses one poll is dropped
// within a minute. The explicit "connected" check in discoverPlayers
// catches most disconnections instantly anyway -- this is a backstop.
const STALE_TIMEOUT_MS = 90 * 1000;

let lmsAvailable = false;
let discoveryTimer = null;
const renderers = new Map(); // id -> { id, name, ip, playerId }

async function lmsRpc(player, method, params = []) {
  const body = { id: 1, method: 'slim.request', params: [player, [method, ...params]] };
  const res = await axios.post(`${LMS_BASE}/jsonrpc.js`, body, { timeout: 4000 });
  return res.data?.result;
}

async function checkLMS() {
  try {
    const result = await lmsRpc('', 'serverstatus', [0, 100]);
    lmsAvailable = true;
    return result;
  } catch (e) {
    lmsAvailable = false;
    return null;
  }
}

async function discoverPlayers() {
  const status = await checkLMS();
  if (!status) return false;
  const players = status.players_loop || [];

  // Track which player IDs LMS reports as connected on this poll. Used
  // below to immediately drop any in-memory entries LMS now considers
  // disconnected -- waiting for the TTL would leave ghost players in
  // the Output sheet for minutes after unplug.
  const connectedNow = new Set();

  for (const p of players) {
    // LMS's players_loop is its full roster -- it lists Squeezelite
    // clients that have EVER registered with this LMS, not just the
    // currently-connected ones. p.connected is 1 if the player is
    // online RIGHT NOW. Skipping disconnected entries avoids the
    // ghost-player bug where an iPhone or laptop that registered once
    // shows up forever in musicd's Output sheet (#v1.1.0.7).
    if (p.connected !== 1) continue;
    connectedNow.add(`squeeze:${p.playerid}`);

    const id = `squeeze:${p.playerid}`;
    if (renderers.has(id)) {
      renderers.get(id).lastSeen = Date.now();
      continue;
    }
    renderers.set(id, {
      id, name: p.name || p.playerid,
      ip: p.ip?.split(':')[0] || LMS_HOST,
      playerId: p.playerid,
      capabilities: {
        protocols: ['audio/flac', 'audio/mpeg', 'audio/wav'],
        maxBitDepth: 24,
        // Squeezelite itself accepts arbitrary rates and lets the
        // downstream output stage decide. We declare 192000 here as a
        // safe practical ceiling -- DragonFly Cobalt and most modern
        // USB DACs support up to 24/192. Tracks above that get
        // downsampled by the server. Override by editing the capability
        // for a specific renderer if you have a 44.1-only DAC.
        maxSampleRate: 192000,
      },
      lastSeen: Date.now(),
    });
    console.log(`🎵 Squeezelite player: ${p.name} (${p.playerid})`);
  }

  // Drop entries LMS no longer reports as connected (#v1.1.0.7). This
  // gives a fast-path removal: if LMS knows a player went offline,
  // we don't wait for the TTL to expire. The TTL still exists below
  // as a backstop for cases where LMS itself goes away.
  for (const [id, r] of renderers.entries()) {
    if (!connectedNow.has(id)) {
      renderers.delete(id);
      console.log(`🧹 Removed disconnected Squeezelite player: ${r.name}`);
    }
  }

  // TTL backstop: if discoverPlayers stops getting called (LMS down,
  // network blip), prune anything whose lastSeen is too old. With the
  // explicit drop above this is mostly redundant, but it's cheap.
  const now = Date.now();
  for (const [id, r] of renderers.entries()) {
    if (now - r.lastSeen > STALE_TIMEOUT_MS) {
      renderers.delete(id);
      console.log(`🧹 Removed stale Squeezelite player: ${r.name}`);
    }
  }
  return true;
}

function startDiscovery() {
  const tryDiscover = async (attempt = 0) => {
    const ok = await discoverPlayers();
    if (ok) {
      console.log('🎵 LMS connected');
      discoveryTimer = setInterval(() => discoverPlayers(), 60000);
    } else if (attempt < 3) {
      setTimeout(() => tryDiscover(attempt + 1), [3000, 8000, 30000][attempt]);
    } else {
      console.log('ℹ️  LMS not found — polling every 60s');
      discoveryTimer = setInterval(() => discoverPlayers(), 60000);
    }
  };
  tryDiscover();
}

function stopDiscovery() {
  if (discoveryTimer) clearInterval(discoveryTimer);
}

// Manual re-discovery (#v1.1.0.6). Called when the user taps the
// refresh button in the Output sheet. Just runs discoverPlayers()
// once outside the normal interval.
function triggerSearch() {
  discoverPlayers().catch(() => {});
}

function list() {
  return Array.from(renderers.values()).map(r => ({
    id: r.id, name: r.name, ip: r.ip, capabilities: r.capabilities,
  }));
}

function _player(id) {
  const r = renderers.get(id);
  return r?.playerId;
}

async function play(id, streamUrl) {
  const player = _player(id); if (!player) throw new Error('Player not found');
  await lmsRpc(player, 'playlist', ['clear']);
  await lmsRpc(player, 'playlist', ['add', streamUrl]);
  await lmsRpc(player, 'play');
}

// Gapless pre-queue for Squeezelite: append to the LMS playlist while the
// current track is still playing. LMS handles the seamless transition itself
// (it has its own gapless engine downstream of the playlist). The current
// playlist already contains the now-playing URL; we just add the next one.
async function playNext(id, streamUrl) {
  const player = _player(id); if (!player) throw new Error('Player not found');
  await lmsRpc(player, 'playlist', ['add', streamUrl]);
}

// Drop everything past the currently-playing playlist entry so a user-driven
// skip doesn't get followed by the previously-queued gapless target. We
// repeatedly delete index 1 (the slot just past current) until the playlist is
// trimmed to a single entry.
async function clearNext(id) {
  const player = _player(id); if (!player) return;
  try {
    // status returns playlist_tracks; bound the loop just in case.
    for (let i = 0; i < 32; i++) {
      const status = await lmsRpc(player, 'status', ['-', 1, 'tags:']);
      const total = parseInt(status?.playlist_tracks || status?.playlist_loop?.length || 0, 10);
      if (total <= 1) break;
      // Delete the slot immediately after the current one
      const curIdx = parseInt(status?.playlist_cur_index || 0, 10);
      const targetIdx = curIdx + 1;
      if (targetIdx >= total) break;
      await lmsRpc(player, 'playlist', ['delete', String(targetIdx)]);
    }
  } catch (e) { /* non-fatal */ }
}
async function pause(id) {
  const player = _player(id); if (!player) throw new Error('Player not found');
  // Force pause (do not toggle — playerState handles toggling)
  await lmsRpc(player, 'pause', ['1']);
}
async function resume(id) {
  const player = _player(id); if (!player) throw new Error('Player not found');
  // 'pause 0' explicitly resumes a paused player without restarting from track 0
  await lmsRpc(player, 'pause', ['0']);
}
async function stop(id) {
  const player = _player(id); if (!player) throw new Error('Player not found');
  await lmsRpc(player, 'stop');
}
async function setVolume(id, vol) {
  const player = _player(id); if (!player) throw new Error('Player not found');
  await lmsRpc(player, 'mixer', ['volume', String(Math.max(0, Math.min(100, vol)))]);
}

async function getPositionInfo(id) {
  const player = _player(id); if (!player) return null;
  try {
    const status = await lmsRpc(player, 'status');
    return {
      position: parseFloat(status?.time) || 0,
      duration: parseFloat(status?.duration) || 0,
    };
  } catch { return null; }
}
async function getTransportInfo(id) {
  const player = _player(id); if (!player) return null;
  try {
    const status = await lmsRpc(player, 'status');
    const mode = status?.mode;
    if (mode === 'play') return { state: 'PLAYING' };
    if (mode === 'pause') return { state: 'PAUSED_PLAYBACK' };
    return { state: 'STOPPED' };
  } catch { return null; }
}

module.exports = {
  startDiscovery, stopDiscovery, triggerSearch,
  list, play, playNext, clearNext, pause, resume, stop, setVolume, getPositionInfo, getTransportInfo,
  lmsAvailable: () => lmsAvailable,
};
