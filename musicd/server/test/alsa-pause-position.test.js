// The USB-DAC playhead across a pause.
//
// The ALSA output has no way to ask aplay where it is, so it estimates the
// position from wall clock: now minus the moment the track started. Pause
// SIGSTOPs the ffmpeg|aplay pair, which stops the audio dead — but nothing
// stopped the clock, so every second spent paused was counted as a second
// played. The error is exactly the length of the pause, which is why a
// two-second pause looked fine and a five-minute one did not.
//
// What it cost, in the order the user meets it: the progress bar walks
// forward while the transport is paused (playerState keeps polling a paused
// non-Sonos zone), the audio comes back at the right place but the bar
// stays ahead of it for the rest of the track, and once the estimate runs
// past the track duration the polling loop's playedToEnd guard — the
// v1.1.0.89 fix that stops an abandoned stream from advancing the queue —
// reads the track as finished. From there the next STOPPED tick skips to
// the next track instead of holding.
//
// pause / resume / getPositionInfo are not exported (they are reached
// through the renderer registry), and driving them for real would need a
// sound card, so they are lifted out of the source and evaluated against a
// controlled clock — the same approach test/container-id.test.js takes with
// _selfContainerId. It is the real source text, not a copy of it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'audio', 'alsa.js'), 'utf8');

function lift() {
  const cut = (from, to) => {
    const a = SRC.indexOf(from);
    const b = SRC.indexOf(to, a + 1);
    assert.ok(a !== -1 && b > a, `could not lift ${from} out of alsa.js`);
    return SRC.slice(a, b);
  };
  const src =
    cut('async function pause(id)', 'async function stop(id)') +
    cut('async function getPositionInfo(id)', '// Test-tone playback');
  // If the lift ever silently grabs the wrong span these tests would pass
  // against nothing, so pin the two lines the behaviour actually lives on.
  assert.match(src, /SIGSTOP/, 'lifted span is missing pause()');
  assert.match(src, /player\.startedAt/, 'lifted span is missing the estimate');
  return new Function('_players', 'Date',
    src + '; return { pause, resume, getPositionInfo, getTransportInfo };');
}

const ID = 'alsa:hw0';

// A clock we drive by hand, standing in for the global Date inside the
// lifted functions.
function bench({ duration = 240 } = {}) {
  const clock = {
    t: 1_700_000_000_000,
    now() { return this.t; },
    advance(seconds) { this.t += seconds * 1000; },
  };
  const signals = [];
  const proc = () => ({ killed: false, kill(sig) { signals.push(sig); } });
  const player = {
    rendererId: ID,
    state: 'playing',
    duration,
    position: 0,
    startedAt: clock.now(),
    pausedAt: 0,
    ffmpeg: proc(),
    aplay: proc(),
  };
  const players = new Map([[ID, player]]);
  const api = lift()(players, clock);
  const at = async () => (await api.getPositionInfo(ID)).position;
  return { clock, api, player, signals, at };
}

test('the playhead stops while the pipeline is stopped', async () => {
  const { clock, api, at } = bench();
  clock.advance(30);
  assert.equal(await at(), 30);

  await api.pause(ID);
  clock.advance(300);              // five minutes paused
  assert.equal(await at(), 30, 'the estimate ran on through the pause');
});

test('resuming does not charge the pause to the track', async () => {
  const { clock, api, at } = bench();
  clock.advance(30);
  await api.pause(ID);
  clock.advance(300);
  await api.resume(ID);

  assert.equal(await at(), 30, 'resume did not give back the paused time');
  clock.advance(10);
  assert.equal(await at(), 40, 'the estimate should run again once resumed');
});

test('a pause longer than the track leaves the playedToEnd guard armed', async () => {
  // This is the one that turned resume into a skip. playerState's polling
  // loop treats position >= duration - 5 as "the renderer played the track
  // out", and advances the queue on the next STOPPED tick instead of
  // holding. Paused 30 seconds into a four-minute track, ten minutes of
  // pause used to be enough to satisfy that on its own.
  const { clock, api, at, player } = bench({ duration: 240 });
  clock.advance(30);
  await api.pause(ID);
  clock.advance(600);
  await api.resume(ID);

  const pos = await at();
  assert.equal(pos, 30);
  assert.ok(pos < player.duration - 5,
    `position ${pos} of ${player.duration} reads as played-to-end`);
});

test('the transport still reports the pause, and still signals the pipeline', async () => {
  // The freeze must not have cost us the actual pause.
  const { api, signals } = bench();
  assert.equal((await api.getTransportInfo(ID)).state, 'PLAYING');

  await api.pause(ID);
  assert.deepEqual(signals, ['SIGSTOP', 'SIGSTOP']);
  assert.equal((await api.getTransportInfo(ID)).state, 'PAUSED_PLAYBACK');

  await api.resume(ID);
  assert.deepEqual(signals, ['SIGSTOP', 'SIGSTOP', 'SIGCONT', 'SIGCONT']);
  assert.equal((await api.getTransportInfo(ID)).state, 'PLAYING');
});

test('a second pause does not move the mark', async () => {
  // A repeated pause must not re-stamp the freeze, or the position would
  // jump forward by the gap between the two calls.
  const { clock, api, at } = bench();
  clock.advance(30);
  await api.pause(ID);
  clock.advance(120);
  await api.pause(ID);
  clock.advance(120);
  await api.resume(ID);
  assert.equal(await at(), 30);
});

test('the estimate is still clamped to the track duration', async () => {
  // Unchanged behaviour, pinned so the freeze can't be "fixed" into
  // reporting a position past the end of the track.
  const { clock, at } = bench({ duration: 240 });
  clock.advance(9999);
  assert.equal(await at(), 240);
});
