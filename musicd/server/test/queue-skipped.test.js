// The queue screen's skipped-track fold, and the state it runs on.
//
// Three separate things have to line up for this to work, and two of them are
// the shapes that have already gone wrong once in this project:
//
//   1. The server has to record skips somewhere that survives the queue being
//      spliced. It keys them by TRACK ID, not by index, precisely so that the
//      eight sites that mutate zone.queue — reorder, remove, remove-batch,
//      append, replace, clear, boot-restore — need no changes. An index-keyed
//      parallel array would have to be kept in step at every one of them,
//      which is the partial migration CLAUDE.md warns about.
//
//   2. The client has to read `skipped` on EVERY path that carries zone state:
//      the zones snapshot, the REST hydration, and the `state` message. Miss
//      one and the fold silently stops working on whichever route that was —
//      exactly how the progress-bar anchor shipped broken twice.
//
//   3. The fold itself has to group the right rows and leave the rest alone.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const CLIENT_SRC = path.join(__dirname, '..', '..', 'client', 'src');
const SERVER_SRC = path.join(__dirname, '..', 'src');

// Strip comments so prose about the rule can neither satisfy nor trip a check.
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const read = (...p) => code(fs.readFileSync(path.join(...p), 'utf8'));

test('the fold groups exactly the skipped tracks behind the playhead', async (t) => {
  const { foldSkippedRuns } = await import(
    pathToFileURL(path.join(CLIENT_SRC, 'queueFold.js')).href);

  // ids a..h; the playhead sits on 'e' (index 4).
  const queue = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(id => ({ id }));
  const fold = (skips, queueIndex = 4, selecting = false) =>
    foldSkippedRuns(queue, queueIndex, new Set(skips), selecting);
  const shape = (rows) => rows.map(r =>
    r.kind === 'skips' ? `skips(${r.items.join(',')})` : `t${r.index}`);

  await t.test('nothing skipped leaves every row alone', () => {
    assert.deepEqual(shape(fold([])),
      ['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7']);
  });

  await t.test('a run collapses into one row', () => {
    assert.deepEqual(shape(fold(['b', 'c', 'd'])),
      ['t0', 'skips(1,2,3)', 't4', 't5', 't6', 't7']);
  });

  await t.test('separate runs stay separate and keep queue order', () => {
    // One row for the whole queue would put the fold in the wrong place
    // relative to the tracks that were played.
    assert.deepEqual(shape(fold(['a', 'b', 'd'])),
      ['skips(0,1)', 't2', 'skips(3)', 't4', 't5', 't6', 't7']);
  });

  await t.test('a lone skip folds too', () => {
    // Left unfolded it would render exactly like a played track, which is the
    // distinction the whole feature exists to draw.
    assert.deepEqual(shape(fold(['c'])),
      ['t0', 't1', 'skips(2)', 't3', 't4', 't5', 't6', 't7']);
  });

  await t.test('the playing track never folds, even if marked', () => {
    // It can carry a stale mark from an earlier pass through the queue.
    assert.deepEqual(shape(fold(['e'])),
      ['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7']);
  });

  await t.test('upcoming tracks never fold', () => {
    // "Play next" moves a skipped track ahead of the playhead; it must then
    // read as an ordinary upcoming row, not as a fold.
    assert.deepEqual(shape(fold(['f', 'g'])),
      ['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7']);
  });

  await t.test('a run stops at the playhead', () => {
    assert.deepEqual(shape(fold(['c', 'd', 'e', 'f'])),
      ['t0', 't1', 'skips(2,3)', 't4', 't5', 't6', 't7']);
  });

  await t.test('selection mode folds nothing', () => {
    assert.deepEqual(shape(fold(['a', 'b', 'c'], 4, true)),
      ['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7']);
  });

  await t.test('every track appears exactly once, whatever the marks', () => {
    // A fold that loses or repeats a row is worse than no fold.
    for (const marks of [[], ['a'], ['a', 'b'], ['a', 'c'], ['a', 'b', 'c', 'd'],
                         ['b', 'd'], ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']]) {
      for (const qi of [0, 1, 4, 7]) {
        const seen = [];
        for (const r of fold(marks, qi)) {
          if (r.kind === 'skips') seen.push(...r.items); else seen.push(r.index);
        }
        assert.deepEqual(seen, [...queue.keys()],
          `marks=${marks} queueIndex=${qi} lost or reordered rows`);
      }
    }
  });

  await t.test('an empty queue folds to nothing', () => {
    assert.deepEqual(foldSkippedRuns([], 0, new Set()), []);
  });
});

test('"Play next" lands the track after the current one, not before', async () => {
  // reorderQueue splices the track out and back in, so the current track
  // slides down one as the moved track passes it. Inserting AT queueIndex is
  // therefore correct and queueIndex + 1 would be one too far. Getting this
  // wrong either interrupts the current track or drops the chosen one a place
  // further down than asked.
  const { playNextTarget } = await import(
    pathToFileURL(path.join(CLIENT_SRC, 'queueFold.js')).href);

  // Model the server's splice so the assertion is about behaviour, not a
  // remembered number.
  const move = (queue, from, to) => {
    const next = queue.slice();
    const [m] = next.splice(from, 1);
    next.splice(to, 0, m);
    return next;
  };
  for (const [queue, from, queueIndex] of [
    [['a', 'b', 'c', 'd', 'e'], 0, 3],
    [['a', 'b', 'c', 'd', 'e'], 2, 3],
    [['a', 'b', 'c', 'd', 'e'], 1, 4],
    [['a', 'b'], 0, 1],
  ]) {
    const current = queue[queueIndex];
    const after = move(queue, from, playNextTarget(queueIndex));
    const currentAt = after.indexOf(current);
    assert.equal(after[currentAt + 1], queue[from],
      `moving ${queue[from]} with the playhead on ${current} gave ${after.join(',')}`);
  }
});

test('the client reads skipped state on every path that carries it', async (t) => {
  const store = read(CLIENT_SRC, 'store', 'index.js');

  // `radio` is the closest existing analogue: same origin, same lifetime, set
  // on the same paths. Anywhere radio is read off received state, skipped has
  // to be read too — that comparison is what makes this survive a new path
  // being added later, rather than pinning a count that goes stale.
  const radioSites = store.match(/radio:\s*!!(?:z|s|payload)\.radio/g) || [];
  const skipSites = store.match(/skipped:\s*Array\.isArray\((?:z|s|payload)\.skipped\)/g) || [];

  await t.test('there is more than one path to get this wrong', () => {
    assert.ok(radioSites.length >= 3,
      `expected the known hydration paths, found ${radioSites.length}`);
  });

  await t.test('skipped is read wherever radio is', () => {
    assert.equal(skipSites.length, radioSites.length,
      `radio is read from ${radioSites.length} received-state paths but skipped ` +
      `from only ${skipSites.length} — the fold will silently stop working on ` +
      'whichever path was missed');
  });

  await t.test('it has an initial value, so the first render is not undefined', () => {
    assert.match(store, /^\s*skipped:\s*\[\],\s*$/m,
      'skipped is not initialised in the store');
  });
});

test('the server keys skips by track id, not by queue position', async (t) => {
  const player = read(SERVER_SRC, 'playerState.js');

  await t.test('the zone holds a Set', () => {
    assert.match(player, /skipped:\s*new Set\(\)/, 'zone.skipped is not a Set');
  });

  await t.test('marks go in and out by id', () => {
    assert.match(player, /zone\.skipped\.add\(trackId\)/);
    assert.match(player, /zone\.skipped\.delete\(trackId\)/);
  });

  await t.test('no queue-mutating site has to know about it', () => {
    // The whole point of id-keying. If a splice site starts adjusting the skip
    // state, the design has drifted back to the index-keyed one that would
    // need all eight kept in step.
    const mutations = player.split('\n').filter(l =>
      /zone\.queue\.splice|zone\.queue = /.test(l));
    assert.ok(mutations.length >= 5,
      `expected the known queue mutation sites, found ${mutations.length}`);
    for (const line of mutations) {
      assert.ok(!/skipped/.test(line), `a splice site is adjusting skip state: ${line.trim()}`);
    }
  });

  await t.test('a manual skip marks and an auto-end clears', () => {
    // `via` already distinguished the two before this feature existed; the
    // whole change is recording what it says.
    assert.match(player, /if \(via === 'manual'\) markSkipped\(zone, leaving\)/);
    assert.match(player, /else markNotSkipped\(zone, leaving\)/);
  });

  await t.test('a jump marks everything it passes over', () => {
    // Tapping a track further down plays none of the tracks in between.
    assert.match(player, /for \(let i = prevIndex; i < nextIndex; i\+\+\) markSkipped/);
  });

  await t.test('the state broadcast carries it', () => {
    assert.match(player, /skipped:\s*\[\.\.\.zone\.skipped\]/,
      'publicState does not send skipped, so the client can never fold');
    assert.match(player, /skipped:\s*\[\],\s*outputMode/,
      'the empty-zone branch omits skipped, so a zoneless client reads undefined');
  });

  await t.test('a restart cannot restore a mark for a track that has gone', () => {
    // An id no longer in the queue could never be cleared by playing it, so
    // the mark would be immortal.
    assert.match(player, /\(snap\.skipped \|\| \[\]\)\.filter\(id => cleanQueue\.includes\(id\)\)/,
      'restored skip marks are not filtered to the restored queue');
  });
});

test('the queue screen pins the playing track and covers what scrolls past', async (t) => {
  const view = read(CLIENT_SRC, 'components', 'NowPlayingFullScreen.jsx');

  await t.test('the playing row is scrolled to the top when it changes', () => {
    assert.match(view, /useLayoutEffect\(\(\) => \{[\s\S]*?nowRef\.current[\s\S]*?\}, \[queueIndex/,
      'nothing re-pins the playing track when the queue moves on');
  });

  await t.test('the pin allows for the sticky header', () => {
    // scrollIntoView knows nothing about a sticky header inside the scroller,
    // so the row would land underneath it. The offset has to be measured.
    assert.match(view, /stickyRef\.current \? stickyRef\.current\.offsetHeight : 0/,
      'the pin does not measure the sticky header');
    assert.ok(!/nowRef\.current\.scrollIntoView/.test(view),
      'scrollIntoView cannot account for the sticky header');
  });

  await t.test('the header is sticky and opaque, not translucent', () => {
    // This screen paints a blurred wash of the album art behind everything; a
    // translucent bar let track rows show through as they scrolled past.
    const sticky = view.slice(view.indexOf('queueSticky: {'),
                              view.indexOf('}', view.indexOf('queueSticky: {')));
    assert.match(sticky, /position: 'sticky'/);
    assert.match(sticky, /background: 'var\(--jp-bg\)'/,
      'the sticky header has no opaque background');
  });

  await t.test('the top bar is opaque too', () => {
    const bar = view.slice(view.indexOf('topBar: {'),
                           view.indexOf('},', view.indexOf('topBar: {')));
    assert.match(bar, /background: 'var\(--jp-bg\)'/,
      'rows are visible against the top bar as they scroll past it');
  });

  await t.test('tapping a reached track asks instead of jumping', () => {
    assert.match(view, /if \(isPast\) \{ setReachedTap\(i\); return \}/,
      'a tap on an already-played track still jumps the queue without asking');
  });

  await t.test('tapping an upcoming track still just plays it', () => {
    // Unambiguous, and the behaviour that already existed.
    assert.match(view, /if \(isPast\) \{ setReachedTap\(i\); return \}\s*\n\s*playQueue\(queue, i\)/,
      'the upcoming-track tap no longer plays directly');
  });
});
