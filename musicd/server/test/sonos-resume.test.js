// Resuming a Sonos zone that has been paused for a while.
//
// v1.1.0.46 stopped treating Sonos pause as a UPnP pause: the pause button
// sends Stop and saves the position, and the play button re-loads the same
// track's URI and Seeks back to the bookmark. The Seek is therefore not a
// nicety — it is the entire difference between a resume and starting the
// track over.
//
// It can be refused. playTrackOnZone has only just issued
// SetAVTransportURI + Play, and a renderer still loading that URI answers
// Seek with a transition fault; the colder the load, the wider that window,
// so it is likeliest after exactly the long pause this path exists for.
// The refusal was caught and dropped on the floor and the bookmark asserted
// anyway, so the server told every client the playhead was at 1:27 while
// the speaker played the track from the top — until the next poll a second
// later contradicted it and the bar jumped back.
//
// These drive the real playerState against a stubbed renderer registry:
// no device, no database, no SOAP.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const RID = 'sonos:RINCON_TESTUNIT01400';
const TRACK = {
  id: 'trk-0001',
  path: '/music/Album/01 Track.flac',
  title: 'Track', artist: 'Artist', album: 'Album',
  duration: 300, format: 'flac', sample_rate: 44100, bits_per_sample: 16,
  file_size: 30_000_000, channels: 2,
};
const SAVED_POSITION = 87;

// playTrackOnZone refuses to build a stream URL unless one of this host's
// own addresses shares a subnet with the renderer — a 127.0.0.1 fallback
// would send the speaker to its own loopback. Put the imaginary Sonos on
// whatever LAN this machine is actually on so that check passes here and
// on the owner's box alike.
function lanNeighbour() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ifc of list || []) {
      if (ifc.family === 'IPv4' && !ifc.internal) {
        return ifc.address.split('.').slice(0, 3).join('.') + '.254';
      }
    }
  }
  return null;
}

function stubModule(rel, exports) {
  const id = require.resolve(rel);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

// Fresh playerState per test — its zone map is module state. `t` is taken so
// the poll interval playTrackOnZone starts is always cleared, including when
// an assertion throws: a leaked 1 Hz timer keeps the runner alive for ever,
// so the failure would show up as a hang instead of as a failure.
function loadPlayerState(t, { seekError = null } = {}) {
  const calls = [];
  const renderers = {
    calls,
    getRenderer: (id) => ({ id, ip: lanNeighbour(), protocol: 'sonos', capabilities: {} }),
    getProtocol: () => ({}),
    list: () => [],
    play: async (id, url) => { calls.push(['play', id, url]); },
    playNext: async () => false,
    clearNext: async (id) => { calls.push(['clearNext', id]); },
    pause: async (id) => { calls.push(['pause', id]); },
    resume: async (id) => { calls.push(['resume', id]); },
    stop: async (id) => { calls.push(['stop', id]); },
    seek: async (id, seconds) => {
      calls.push(['seek', id, seconds]);
      if (seekError) throw new Error(seekError);
    },
    setVolume: async () => {},
    // Never resolving: the poll timer playTrackOnZone starts must not get
    // to rewrite the zone underneath the assertions. The timer itself is
    // cleared by stopAll() at the end of each test.
    getPositionInfo: () => new Promise(() => {}),
    getTransportInfo: () => new Promise(() => {}),
    startDiscovery: async () => {}, stopDiscovery: () => {}, triggerSearch: () => {},
  };

  const statement = (sql) => ({
    get: () => (/FROM tracks WHERE id/.test(sql) ? TRACK : undefined),
    all: () => [],
    run: () => ({ changes: 0 }),
  });

  stubModule('../src/renderers', renderers);
  stubModule('../src/db', { get: () => ({ prepare: statement }) });
  stubModule('../src/probe', { probe: async () => ({ ok: false }) });
  stubModule('../src/scrobbler', {
    onTrackStart: async () => {}, onPlaybackTick: () => {}, onTrackEnd: () => {},
  });
  stubModule('../src/loudness', {
    getSetting: (_k, fallback) => fallback, computeStreamGain: () => null,
  });
  stubModule('../src/dsp', {
    getProfile: () => ({ updated_at: 0 }),
    compileChain: () => ({ filters: [], summary: [], headroomDb: 0 }),
    isDspEligible: () => false,
  });
  stubModule('../src/dsp/fir', { selectIrForRate: () => null });

  delete require.cache[require.resolve('../src/playerState')];
  const ps = require('../src/playerState');

  // A zone the user paused partway through a track, which on a Sonos means
  // the speaker was Stopped and the position bookmarked.
  const zone = ps.ensureZone(RID);
  zone.status = 'paused';
  zone.currentTrack = TRACK;
  zone.queue = [TRACK.id];
  zone.queueIndex = 0;
  zone.position = SAVED_POSITION;
  zone.positionAt = Date.now();

  t.after(() => ps.stopAll(RID));

  return { ps, zone, calls };
}

// Collect anything the code decides to say, and hand it back so a test can
// assert the failure was actually reported rather than swallowed.
async function capturingWarnings(fn) {
  const said = [];
  const real = console.warn;
  console.warn = (...a) => said.push(a.map(String).join(' '));
  try { return { result: await fn(), said }; }
  finally { console.warn = real; }
}

test('the host must have a LAN address for these to mean anything', () => {
  assert.ok(lanNeighbour(), 'no non-internal IPv4 on this host');
});

test('resume re-loads the track and then seeks to the bookmark', async (t) => {
  const { ps, zone, calls } = loadPlayerState(t);
  await ps.pause(RID);

  const order = calls.map(c => c[0]);
  assert.deepEqual(order, ['play', 'seek'],
    `expected a fresh play then a seek, got ${JSON.stringify(order)}`);
  assert.equal(calls[1][2], SAVED_POSITION, 'seek went to the wrong position');
  assert.equal(zone.status, 'playing');
  assert.equal(zone.position, SAVED_POSITION,
    'a successful seek should leave the bookmark showing');
});

test('a refused seek is reported, not swallowed', async (t) => {
  const { ps, calls } = loadPlayerState(t, {
    seekError: 'Request failed with status code 500 (UPnP 701 Transition not available)',
  });
  const { said } = await capturingWarnings(() => ps.pause(RID));

  assert.ok(calls.some(c => c[0] === 'seek'), 'the seek should still be attempted');
  const reported = said.filter(l => /seek/i.test(l) && /fail/i.test(l));
  assert.equal(reported.length, 1,
    `the refused seek was not reported; console.warn said ${JSON.stringify(said)}`);
  assert.match(reported[0], /701|Transition not available/,
    'the report should carry the renderer\'s own reason');
});

test('a refused seek does not leave the bookmark asserted', async (t) => {
  // The renderer is playing the track from 0:00. Claiming 1:27 puts the bar
  // somewhere the audio is not, and the next poll drags it back — the fix is
  // to not say it in the first place.
  const { ps, zone } = loadPlayerState(t, { seekError: 'UPnP 701 Transition not available' });
  await capturingWarnings(() => ps.pause(RID));

  assert.equal(zone.status, 'playing', 'playback should still have been started');
  assert.notEqual(zone.position, SAVED_POSITION,
    'the saved position was asserted even though every seek was refused');
  assert.equal(zone.position, 0,
    'position should be where playTrackOnZone left it — the start of the track');
});

test('pausing a playing Sonos zone stops it and keeps the position', async (t) => {
  // The other half of the bookmark: the position the resume above depends on
  // has to survive the pause.
  const { ps, zone, calls } = loadPlayerState(t);
  zone.status = 'playing';
  await ps.pause(RID);

  assert.deepEqual(calls.map(c => c[0]), ['stop'],
    'a Sonos pause is a Stop, not a UPnP Pause');
  assert.equal(zone.status, 'paused');
  assert.equal(zone.position, SAVED_POSITION, 'the bookmark was lost on pause');
});
