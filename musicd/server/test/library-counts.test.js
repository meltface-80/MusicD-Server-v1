// The album/track count line on the library screen (v1.1.23.0).
//
// "5233 albums · 68237 tracks" sat under the sort chips on the Albums screen.
// The owner asked for it to go.
//
// It had three footholds, and the interesting one is the third: the line was
// the ONLY consumer of the /library/stats call AlbumGrid made, and that call
// was the second half of a Promise.all wrapped around the first page fetch.
// Deleting the markup and stopping there leaves the request firing on every
// mount and every rescan, for a number nothing renders — a cost with no
// symptom, which is the kind that survives for years.
//
// The other half of this test is what must NOT have gone with it: the
// favourites count on a different screen, the shared style key, and the Home
// screen's own /library/stats call, which feeds the four counter tiles and is
// a completely separate consumer that a careless sweep would have taken too.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', 'client', 'src');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
// The removal is described by name in comments; assert on stripped source so
// the prose cannot satisfy the check.
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the album and track count is gone from the library screen', async (t) => {
  const src = code(read('components', 'AlbumGrid.jsx'));

  await t.test('the line is not rendered', () => {
    assert.doesNotMatch(src, /albums · /, 'the count line is still on the screen');
  });

  await t.test('the state that fed it went too', () => {
    const orphans = ['totalAlbums', 'totalTracks', 'setTotalAlbums', 'setTotalTracks'];
    const left = orphans.filter(o => src.includes(o));
    assert.deepEqual(left, [], 'left behind by the removal: ' + left.join(', '));
  });

  await t.test('and so did the request that was only ever for it', () => {
    // Two sites: the mount/refetch effect and the post-rescan reload. Both
    // wrapped the page fetch in a Promise.all purely to get the totals
    // alongside it.
    assert.doesNotMatch(src, /library\/stats/,
      'AlbumGrid still fetches stats nothing renders');
    assert.doesNotMatch(src, /Promise\.all\(\[\s*fetchPage/,
      'the page fetch is still paired with something');
  });
});

test('the removal did not take its neighbours with it', async (t) => {
  const grid = read('components', 'AlbumGrid.jsx');
  const bare = code(grid);

  await t.test('the favourites count is untouched', () => {
    // A different line, on a different screen, that was not asked about.
    assert.match(bare, /favourite\{albums\.length !== 1 \? 's' : ''\}/,
      'the Favourites screen lost its count too');
  });

  await t.test('the shared style key still has a user', () => {
    // statsRow was used by both lines. Removing one must not orphan it, and
    // must not delete it out from under the other.
    assert.match(bare, /^ {2}statsRow: /m, 'statsRow was deleted');
    assert.ok(/style=\{s\.statsRow\}/.test(bare), 'statsRow is now a dead style key');
  });

  await t.test('the Home screen still counts the library', () => {
    // The four counter tiles are the other /library/stats consumer and the
    // owner explicitly kept them. A grep-and-delete sweep across the client
    // would have taken this one as well.
    const home = code(read('components', 'HomeScreen.jsx'));
    assert.match(home, /api\.get\('\/library\/stats'\)/,
      'the Home screen counters no longer have anything to count');
    for (const label of ['ARTISTS', 'ALBUMS', 'TRACKS', 'GENRES']) {
      assert.match(home, new RegExp(`label="${label}"`), `the ${label} counter is gone`);
    }
  });
});
