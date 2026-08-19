// The progress-bar anchor. This bug shipped twice.
//
// The server samples a renderer's position ~1/s and broadcasts it with
// `positionAt`, a timestamp from the SERVER's wall clock. The client draws
// the playhead as `position + (Date.now() - anchor)`. If the anchor is the
// server's stamp, that subtraction spans two machines and any clock skew
// between them becomes a fixed offset on the bar: a host 40s behind the
// phone draws a track that has just started at 0:40, while the audio plays
// correctly from zero. Hosts without an RTC (Pi, DietPi) drift like this.
//
// The first fix corrected ONE of four sites — the zones snapshot — and left
// the 'position' message, which fires every second, still re-anchoring on
// the server's stamp. It clobbered the fix on the next tick, so nothing
// changed on the device and the bug looked unfixed.
//
// Hence a static test as well as an arithmetic one: the arithmetic proves
// the model, the grep proves no site was missed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const STORE = path.join(__dirname, '..', '..', 'client', 'src', 'store', 'index.js');
const src = fs.readFileSync(STORE, 'utf8');

// Strip comments so prose about the rule can't satisfy or trip the checks.
function code(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
const body = code(src);

test('the client never anchors interpolation on a server timestamp', async (t) => {
  await t.test('no assignment sources positionAt from the payload', () => {
    const hits = body.match(/positionAt\s*[:=]\s*[^\n]*payload\.positionAt/g) || [];
    assert.deepEqual(hits, [],
      'a positionAt anchor is being read from the server payload: ' + hits.join(' | '));
  });

  await t.test('no assignment sources positionAt from ANY received object', () => {
    // Deliberately broad: the sites that were missed twice used three
    // different receiver names (payload, z, s). Match any `<ident>.positionAt`
    // on the right-hand side of an anchor assignment.
    const hits = body.match(/positionAt\s*[:=]\s*[^\n]*[A-Za-z_$][\w$]*\.positionAt/g) || [];
    assert.deepEqual(hits, [],
      'a positionAt anchor is being read from received state: ' + hits.join(' | '));
  });

  await t.test('every anchor is taken from the local clock', () => {
    // The invariant is not "must call the helper" — a local reset setting
    // its own Date.now() is equally correct, and several do. The invariant
    // is that the value never originates on the other machine. Anything
    // that is not plainly our own clock has to be justified here.
    const assigns = body.match(/positionAt\s*[:=]\s*[^,\n}]+/g) || [];
    assert.ok(assigns.length >= 6,
      `expected the known anchor sites to still exist, found ${assigns.length}`);
    for (const a of assigns) {
      const rhs = a.split(/[:=]/).slice(1).join(':').trim();
      assert.ok(
        /^receiveAnchor\(\)$/.test(rhs) ||
        /^Date\.now\(\)$/.test(rhs) ||
        /^\(\)\s*=>\s*Date\.now\(\)$/.test(rhs),
        `anchor is not plainly the local clock: ${a.trim()}`);
    }
  });

  await t.test('the helper is declared before its first use', () => {
    // const is not hoisted; a use above the declaration is a latent
    // ReferenceError the moment anything calls it during module init.
    const decl = body.indexOf('const receiveAnchor');
    const firstUse = body.indexOf('receiveAnchor()');
    assert.ok(decl !== -1, 'receiveAnchor is not declared');
    assert.ok(decl < firstUse || firstUse === -1,
      'receiveAnchor is used before it is declared');
  });
});

test('playhead arithmetic is immune to host/client clock skew', async (t) => {
  // The shipped model, restated: displayed = position + (now - anchor).
  const draw = (sample, anchor, now) =>
    sample.position + Math.max(0, (now - anchor) / 1000);

  const PHONE_NOW = 1_700_000_000_000;
  const RENDER_LAG = 50;               // ms between receive and paint
  const TRUE_POS = 2.0;                // renderer really 2s into the track

  for (const skewSec of [0, 40, -40, 600, -600]) {
    await t.test(`host ${skewSec >= 0 ? '+' : ''}${skewSec}s vs phone`, () => {
      const sample = { position: TRUE_POS, positionAt: PHONE_NOW + skewSec * 1000 };

      // What the shipped client does: anchor at receive time, our clock.
      const anchored = draw(sample, PHONE_NOW, PHONE_NOW + RENDER_LAG);
      assert.ok(Math.abs(anchored - TRUE_POS) < 0.1,
        `drew ${anchored.toFixed(2)}s for a track ${TRUE_POS}s in`);

      // What the bug did: anchor on the server's stamp.
      const buggy = draw(sample, sample.positionAt, PHONE_NOW + RENDER_LAG);
      if (skewSec < 0) {
        // Host behind the phone => the bar reads high. This is the
        // reported symptom: "starts at 40 seconds, song starts at zero".
        assert.ok(buggy > TRUE_POS + Math.abs(skewSec) - 1,
          'the old model should have over-read by the skew');
      }
    });
  }
});

test('the ticker only advances while playing', () => {
  // Guards the other half of the model: a paused zone must not creep.
  const tick = (status, position, anchor, now) =>
    status === 'playing' ? position + Math.max(0, (now - anchor) / 1000) : position;

  const t0 = 1_700_000_000_000;
  assert.equal(tick('paused', 12, t0, t0 + 5000), 12);
  assert.equal(tick('stopped', 12, t0, t0 + 5000), 12);
  assert.equal(tick('playing', 12, t0, t0 + 5000), 17);
});
