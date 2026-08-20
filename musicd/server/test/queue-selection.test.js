// The queue screen's multi-select, and the three things the ⋯ menu does with
// it (v1.1.24.0).
//
// Play now and Play next are one operation and a half: both move the selected
// rows to just after the playing track, and Play now then advances into them.
// That move is where the bugs live, so most of this file is about it.
//
// Three things are worth running rather than reading:
//
//   1. THE INDEX MATHS. Lifting N entries out of an array and re-inserting
//      them after a marker whose own index has just shifted is the kind of
//      arithmetic that looks right and is off by one. It is run here against
//      real arrays, including the cases that actually break it: a selection
//      entirely before the playhead, entirely after, and straddling it.
//
//   2. THE TWO IMPLEMENTATIONS AGREE. The client applies the move optimistically
//      and the server broadcasts its own answer a moment later. If they disagree
//      the queue visibly jumps. Both are lifted from source and run on the same
//      inputs, so a change to one that is not made to the other fails here.
//      reorderQueue carries the same standing rule in a comment; a comment did
//      not stop this project shipping the progress-bar anchor twice.
//
//   3. ORDER, not just membership. The moved block has to keep the queue's own
//      order — not the order rows were tapped — or a selected album arrives
//      shuffled.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVER_SRC = path.join(__dirname, '..', 'src');
const CLIENT_SRC = path.join(__dirname, '..', '..', 'client', 'src');
const readRaw = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ---------------------------------------------------------------------------
// Lift both implementations out of the shipping source.
// ---------------------------------------------------------------------------

// Slice one top-level `async function NAME(...) { ... }` out of a module, from
// its signature to the closing brace in column 0.
function topLevelFn(src, name) {
  const start = src.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `${name} is gone from the server`);
  const end = src.indexOf('\n}\n', start);
  assert.notEqual(end, -1, `could not find the end of ${name}`);
  return src.slice(start, end + 3);
}

// The server's version, with its three collaborators injected.
function serverMove() {
  const calls = { clearNext: 0, broadcasts: 0 };
  let zone = null;
  const src = topLevelFn(readRaw(SERVER_SRC, 'playerState.js'), 'moveSelectionNext');
  const fn = new Function('resolveZone', 'renderers', 'broadcastFullState',
    src + '; return moveSelectionNext;')(
    () => zone,
    { clearNext: async () => { calls.clearNext++; } },
    () => { calls.broadcasts++; },
  );
  return {
    calls,
    run: async (queue, queueIndex, indices) => {
      zone = { queue: queue.slice(), queueIndex, rendererIds: ['r1'], gaplessQueued: true };
      const r = await fn(indices);
      return { result: r, zone };
    },
  };
}

// The client's optimistic version, lifted out of the store object.
function clientMove() {
  const src = readRaw(CLIENT_SRC, 'store', 'index.js');
  const start = src.indexOf('  moveSelectionNext: async (indices) => {');
  assert.notEqual(start, -1, 'moveSelectionNext is gone from the store');
  const end = src.indexOf('\n  },\n', start);
  assert.notEqual(end, -1, 'could not find the end of the store action');
  const body = src.slice(start + '  moveSelectionNext:'.length, end + 4);
  return async (queue, queueIndex, indices) => {
    let state = { queue: queue.slice(), queueIndex };
    const fn = new Function('get', 'set', 'api',
      `return (${body.trim().replace(/,$/, '')})`)(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      { post: async () => ({}) },
    );
    await fn(indices);
    return state;
  };
}

// ids are single letters so an expected queue reads as a word.
const Q = (s) => s.split('');
const ids = (q) => q.join('');

// ---------------------------------------------------------------------------

test('a selection moves to just after the playing track', async (t) => {
  const server = serverMove();

  await t.test('from behind the playhead', async () => {
    // abcDefgh, playing 'd' (3), move a and c.
    const { zone } = await server.run(Q('abcdefgh'), 3, [0, 2]);
    // a and c come out, d slides back to index 1, and they land after it.
    assert.equal(ids(zone.queue), 'bdacefgh');
    assert.equal(zone.queue[zone.queueIndex], 'd', 'the playing track changed');
    assert.equal(zone.queueIndex, 1);
  });

  await t.test('from ahead of the playhead', async () => {
    const { zone } = await server.run(Q('abcdefgh'), 3, [5, 7]);
    assert.equal(ids(zone.queue), 'abcdfheg');
    assert.equal(zone.queueIndex, 3, 'nothing before the playhead moved');
    assert.equal(zone.queue[zone.queueIndex], 'd');
  });

  await t.test('straddling it', async () => {
    // The case that breaks a naive implementation: one entry removed from
    // before the playhead and one from after, so the shift is 1, not 0 or 2.
    const { zone } = await server.run(Q('abcdefgh'), 3, [1, 6]);
    assert.equal(ids(zone.queue), 'acdbgefh');
    assert.equal(zone.queue[zone.queueIndex], 'd');
    assert.equal(zone.queueIndex, 2);
  });

  await t.test('the moved block keeps the QUEUE order, not the tap order', async () => {
    // Ticking g then e must not queue them g,e — the rows were never
    // reordered, only chosen.
    const { zone } = await server.run(Q('abcdefgh'), 3, [6, 4]);
    // e and g lift out and land after d in the order they had — e then g.
    // Honouring the tap order would give 'abcdgefh'.
    assert.equal(ids(zone.queue), 'abcdegfh');
    assert.ok(ids(zone.queue).indexOf('e') < ids(zone.queue).indexOf('g'));
  });

  await t.test('the whole upcoming queue is a no-op it survives', async () => {
    const { zone } = await server.run(Q('abcde'), 2, [3, 4]);
    assert.equal(ids(zone.queue), 'abcde');
    assert.equal(zone.queueIndex, 2);
  });
});

test('the move refuses what it cannot move', async (t) => {
  const server = serverMove();

  await t.test('the playing track is silently dropped from the selection', async () => {
    // The UI already refuses to tick it, so this is the second line of
    // defence — and it is load-bearing: the new index is computed FROM the
    // playing track's position, so moving it would make that self-referential.
    const { result, zone } = await server.run(Q('abcdefgh'), 3, [2, 3]);
    assert.equal(ids(zone.queue), 'abdcefgh');
    assert.equal(zone.queue[zone.queueIndex], 'd');
    assert.equal(result.moved, 1, 'the playing track was counted as moved');
  });

  await t.test('a selection of only the playing track does nothing at all', async () => {
    const { result, zone } = await server.run(Q('abcdefgh'), 3, [3]);
    assert.equal(result, null, 'it reported success for a move it did not make');
    assert.equal(ids(zone.queue), 'abcdefgh');
  });

  await t.test('duplicates are collapsed', async () => {
    // A Set arriving over JSON as [2,2] would otherwise splice the same entry
    // in twice and lose one from the queue.
    const { result, zone } = await server.run(Q('abcdefgh'), 3, [2, 2, 2]);
    assert.equal(zone.queue.length, 8, 'the queue changed length');
    assert.equal(result.moved, 1);
    assert.equal(ids(zone.queue), 'abdcefgh');
  });

  await t.test('out-of-range indices are dropped, not fatal', async () => {
    const { zone } = await server.run(Q('abcdefgh'), 3, [-1, 2, 99]);
    assert.equal(ids(zone.queue), 'abdcefgh');
  });

  await t.test('an empty or junk selection returns null', async () => {
    for (const bad of [[], null, undefined, ['x'], [NaN]]) {
      const { result } = await server.run(Q('abcdefgh'), 3, bad);
      assert.equal(result, null, `${JSON.stringify(bad)} was treated as a move`);
    }
  });
});

test('the renderer is told its pre-queued next track is stale', async (t) => {
  const server = serverMove();

  await t.test('clearNext fires when the next track changed', async () => {
    server.calls.clearNext = 0;
    const { zone } = await server.run(Q('abcdefgh'), 3, [6]);
    assert.equal(zone.queue[4], 'g', 'g is not next');
    assert.equal(server.calls.clearNext, 1,
      'without this the renderer plays the track it was already handed and ' +
      '"play next" appears to do nothing until the track after');
    assert.equal(zone.gaplessQueued, false);
  });

  await t.test('and not when it did not', async () => {
    server.calls.clearNext = 0;
    // Moving the track that is ALREADY next to where it already is.
    await server.run(Q('abcdefgh'), 3, [4]);
    assert.equal(server.calls.clearNext, 0, 'the renderer was disturbed for nothing');
  });

  await t.test('every move broadcasts', async () => {
    const before = server.calls.broadcasts;
    await server.run(Q('abcdefgh'), 3, [6]);
    assert.equal(server.calls.broadcasts, before + 1);
  });
});

test('the client and the server compute the same queue', async (t) => {
  const server = serverMove();
  const client = clientMove();

  // Every shape from the tests above, plus a few more, run through both.
  const cases = [
    [Q('abcdefgh'), 3, [0, 2]],
    [Q('abcdefgh'), 3, [5, 7]],
    [Q('abcdefgh'), 3, [1, 6]],
    [Q('abcdefgh'), 3, [6, 4]],
    [Q('abcdefgh'), 0, [1, 2, 3]],
    [Q('abcdefgh'), 7, [0, 1]],
    [Q('abcdefgh'), 3, [2, 3]],
    [Q('abcde'), 2, [0, 1, 3, 4]],
    [Q('ab'), 0, [1]],
  ];

  for (const [queue, queueIndex, indices] of cases) {
    await t.test(`${ids(queue)} @${queueIndex} move ${indices.join(',')}`, async () => {
      const { zone } = await server.run(queue, queueIndex, indices);
      const c = await client(queue, queueIndex, indices);
      assert.equal(ids(c.queue), ids(zone.queue),
        'the optimistic update and the broadcast disagree — the queue will jump');
      assert.equal(c.queueIndex, zone.queueIndex,
        'the two disagree about which track is playing');
    });
  }
});

// ---------------------------------------------------------------------------
// The menu.
// ---------------------------------------------------------------------------

test('the queue overflow menu is not the now-playing one', async (t) => {
  const src = code(readRaw(path.join(CLIENT_SRC, 'components', 'NowPlayingFullScreen.jsx')));

  await t.test('the variant comes from the tab, not from a duplicated literal', () => {
    // Derived at the one render site so the two menus cannot fall out of step
    // with which tab is showing.
    assert.match(src, /variant=\{activeTab === 'queue' \? 'queue' : 'nowplaying'\}/);
    assert.match(src, /selection=\{activeTab === 'queue' \? queueSelection : null\}/);
    assert.match(src, /const isQueue = variant === 'queue'/);
  });

  await t.test('the album / artist / genre block is Now Playing only', () => {
    // Not deleted — the owner asked for it gone from the QUEUE menu, and it is
    // the whole point of the Now Playing one.
    assert.match(src, /\{!isQueue && \(\s*<>\s*<button style=\{s\.overflowItem\} onClick=\{goAlbum\}/,
      'the navigation block is not gated on the variant');
    for (const fn of ['goAlbum', 'goArtist', 'goGenre']) {
      assert.ok(src.includes(fn), `${fn} was removed rather than gated`);
    }
  });

  await t.test('Suggestions is Now Playing only', () => {
    const at = src.indexOf('<span>Suggestions</span>');
    assert.notEqual(at, -1, 'Suggestions was deleted from both menus');
    assert.match(src.slice(Math.max(0, at - 400), at), /\{!isQueue && \(/,
      'Suggestions still shows on the queue menu');
  });

  await t.test('the three selection actions exist and are queue-only', () => {
    for (const label of ['Play now', 'Play next', 'Clear selected from queue']) {
      const at = src.indexOf(`<span>${label}</span>`);
      assert.notEqual(at, -1, `${label} is missing`);
    }
    // Gated on BOTH the variant and there being something selected: three dead
    // rows at the top of every queue menu would be worse than no rows.
    assert.match(src, /\{isQueue && selectedCount > 0 && \(/,
      'the selection actions are not gated on a selection existing');
  });

  await t.test('each action closes the menu before it runs', () => {
    // The menu sits over the list it is about to rearrange; leaving it open
    // shows the user a stale selection count over a queue that has moved.
    for (const fn of ['playNow', 'playNext', 'clearSelected']) {
      assert.match(src, new RegExp(`onClose\\(\\); selection\\.${fn}\\(\\)`),
        `${fn} does not close the menu`);
    }
  });

  await t.test('the bottom half is shared, not forked', () => {
    // One copy of favourite / rate / playlist / tag / save. Two would drift.
    for (const label of ['Favourite this track', 'Add to Playlist', 'Add to Tag']) {
      assert.equal(src.split(label).length - 1, 1,
        `${label} appears more than once — the menu has been forked`);
    }
  });
});

test('the selection is published upward and torn down with the view', async (t) => {
  const src = code(readRaw(path.join(CLIENT_SRC, 'components', 'NowPlayingFullScreen.jsx')));

  await t.test('QueueView publishes it', () => {
    assert.match(src, /function QueueView\(\{ queue, queueIndex, onSelectTrack, onSelectionChange \}\)/);
    assert.match(src, /onSelectionChange=\{setQueueSelection\}/,
      'the publisher must be the stable state setter, not an inline arrow — ' +
      'an inline arrow re-runs the effect every render and spins forever');
  });

  await t.test('and clears it on unmount', () => {
    // A stale handle left in the parent would let the menu act on indices from
    // a queue the user has navigated away from.
    assert.match(src, /useEffect\(\(\) => \(\) => \{ if \(onSelectionChange\) onSelectionChange\(null\) \}/);
  });

  await t.test('Play now is Play next followed by an advance', () => {
    // The order is the whole trick: after the move the first selected track IS
    // queueIndex + 1, so one skip lands on it. Reversed, the skip happens
    // first and the user hears whatever was already next.
    const at = src.indexOf('playNow: async () => {');
    assert.notEqual(at, -1, 'playNow is gone');
    const body = src.slice(at, src.indexOf('playNext: async () => {', at));
    const move = body.indexOf('moveSelectionNext(picked)');
    const skip = body.indexOf('skipToNextTrack()');
    assert.ok(move !== -1 && skip !== -1, 'playNow no longer does both halves');
    assert.ok(move < skip, 'playNow advances before it moves — it will play the wrong track');
  });

  await t.test('all three exit selection mode when they are done', () => {
    for (const fn of ['playNow', 'playNext', 'clearSelected']) {
      const at = src.indexOf(`${fn}: async () => {`);
      const end = src.indexOf('},', at);
      assert.match(src.slice(at, end), /exitSelectMode\(\)/,
        `${fn} leaves the queue in selection mode with a selection that has moved`);
    }
  });
});

test('the server route is mounted and validates', async (t) => {
  const player = readRaw(SERVER_SRC, 'routes', 'player.js');

  // The route's own body, not the whole file: /queue/remove-batch a few lines
  // up validates with the SAME message, so a file-wide grep for it passes
  // even with this route's check deleted. That is exactly how the first
  // version of this test failed to bite.
  const moveNextRoute = (() => {
    const at = code(player).indexOf("router.post('/queue/move-next'");
    assert.notEqual(at, -1, '/queue/move-next is gone');
    const end = code(player).indexOf('\n});', at);
    return code(player).slice(at, end);
  })();

  await t.test('the route exists', () => {
    assert.match(moveNextRoute, /playerState\.moveSelectionNext\(indices, rendererId\)/);
  });

  await t.test('an empty body is a 400, not a silent success', () => {
    assert.match(moveNextRoute, /indices \|\| indices\.length === 0/,
      'the route no longer checks its input');
    assert.match(moveNextRoute, /status\(400\)/);
    assert.match(moveNextRoute, /indices array required/);
  });

  await t.test('moveSelectionNext is exported', () => {
    assert.match(readRaw(SERVER_SRC, 'playerState.js'), /^\s*reorderQueue, moveSelectionNext,/m);
  });
});
