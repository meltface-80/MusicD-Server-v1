// Favourites as a Focus section (v1.1.31.0).
//
// It was a heart chip of its own in the album wall's top pill row. With the
// sort chip, Random, the funnel and Select up there it no longer fitted
// without scrolling — and of everything in that row it was the one thing that
// was really a filter like the ones inside the funnel. So it moved.
//
// Two things have to hold, and neither is obvious from reading:
//
//   THE FILTER STILL FILTERS. The section carries 'yes' / 'no' rather than a
//   boolean, so it behaves like every other section: OR within it, AND across
//   sections, and the pill's +/- turns include into exclude with no special
//   case. Ticking BOTH means "favourite or not", i.e. everything — which is a
//   real query the SQL has to get right, not a case to reject. Run against
//   real SQLite below.
//
//   THE PAGE CACHE STILL WORKS. This is the part that could quietly regress.
//   The album grid refuses to cache a focus-filtered list, because focus picks
//   do not survive opening an album — so the list would come back filtered
//   with an empty focus bar. The heart chip was NOT a focus pick and the cache
//   did carry it. Moving favourites into focus therefore had to carry the
//   restore too, or returning from an album with favourites on would lose the
//   scroll position it used to keep. library-scroll.test.js pins the cache
//   rule; what is pinned here is that the two halves agree about the section's
//   name, which is the seam they meet at.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const SERVER_SRC = path.join(__dirname, '..', 'src');
const CLIENT_SRC = path.join(__dirname, '..', '..', 'client', 'src');
const readRaw = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const client = (...p) => code(readRaw(CLIENT_SRC, ...p));

// ---------------------------------------------------------------------------
// The SQL, run for real.
// ---------------------------------------------------------------------------

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE albums (
    id TEXT PRIMARY KEY, title TEXT, is_favorite INT, excluded INT DEFAULT 0)`);
  const ins = db.prepare('INSERT INTO albums (id,title,is_favorite,excluded) VALUES (?,?,?,?)');
  ins.run('a', 'Aye',   1, 0);
  ins.run('b', 'Bee',   0, 0);
  ins.run('c', 'Cee',   null, 0);   // predates the column — must count as "no"
  ins.run('d', 'Dee',   1, 1);      // excluded, never returned
  return db;
}

// The route's OWN clause-building, lifted and run — not a reimplementation of
// it here. The first version of this test lifted only FAVOURITE_EXPR and then
// rebuilt the IN / NOT IN itself, which meant a bug in how the route assembles
// the clause (an `IN` turned into a `=`, say) passed cleanly. Lifting the
// whole thing is the difference between testing the shipping code and testing
// a copy of it that happens to agree.
function buildFavouriteClause({ include = [], exclude = [] }) {
  const src = readRaw(SERVER_SRC, 'routes', 'library.js');
  const at = src.indexOf('const FAVOURITE_EXPR =');
  assert.notEqual(at, -1, 'FAVOURITE_EXPR is gone from library.js');
  const end = src.indexOf('// Genre: alias-aware match', at);
  assert.notEqual(end, -1, 'the favourite clause block has moved');
  const body = src.slice(at, end);
  assert.match(body, /focusFavouriteIn/, 'the include clause is gone');
  assert.match(body, /focusFavouriteEx/, 'the exclude clause is gone');

  const focusParts = [];
  const focusParams = [];
  new Function('focusParts', 'focusParams', 'focusFavouriteIn', 'focusFavouriteEx', body)(
    focusParts, focusParams, include, exclude);
  return { focusParts, focusParams };
}

function query(db, picks) {
  const { focusParts, focusParams } = buildFavouriteClause(picks);
  const where = ['excluded = 0', ...focusParts].join(' AND ');
  return db.prepare(`SELECT id FROM albums WHERE ${where} ORDER BY id`)
    .all(...focusParams).map(r => r.id).join(',');
}

test('the favourite filter selects what it says', async (t) => {
  const db = makeDb();

  await t.test('nothing ticked is no filter', () => {
    assert.equal(query(db, {}), 'a,b,c');
  });

  await t.test('Favourites', () => {
    assert.equal(query(db, { include: ['yes'] }), 'a');
  });

  await t.test('Not favourites — and a NULL flag counts as not', () => {
    // is_favorite is NULL on rows that predate the column. Without the
    // COALESCE those albums would fall out of BOTH answers.
    assert.equal(query(db, { include: ['no'] }), 'b,c');
  });

  await t.test('both ticked is everything, not nothing', () => {
    // OR within a section. A boolean implementation would have had to
    // special-case this; the CASE expression gets it for free.
    assert.equal(query(db, { include: ['yes', 'no'] }), 'a,b,c');
  });

  await t.test('excluding is the other side of including', () => {
    assert.equal(query(db, { exclude: ['yes'] }), 'b,c');
    assert.equal(query(db, { exclude: ['no'] }), 'a');
  });

  await t.test('excluded albums never appear either way', () => {
    for (const q of [{}, { include: ['yes'] }, { include: ['no'] }]) {
      assert.ok(!query(db, q).includes('d'), 'an excluded album came back');
    }
  });
});

test('the route parses and validates the section', async (t) => {
  const src = code(readRaw(SERVER_SRC, 'routes', 'library.js'));

  await t.test('both params are read', () => {
    assert.match(src, /parseList\(req\.query\.focus_favourite\)/);
    assert.match(src, /parseList\(req\.query\.focus_favourite_excl\)/);
  });

  await t.test('only yes and no are accepted', () => {
    // Same forgiving-URL handling as album type: anything else is dropped
    // rather than reaching the SQL.
    assert.match(src, /VALID_FAVOURITE = new Set\(\['yes', 'no'\]\)/);
    assert.match(src, /focus_favourite\)\.filter\(v => VALID_FAVOURITE\.has\(v\)\)/);
    assert.match(src, /focus_favourite_excl\)\.filter\(v => VALID_FAVOURITE\.has\(v\)\)/);
  });

  await t.test('the options endpoint offers both, with counts', () => {
    assert.match(src, /value: 'yes', *label: 'Favourites'/);
    assert.match(src, /value: 'no', *label: 'Not favourites'/);
    // Listed even at zero: "no favourites yet" is a state the user can change,
    // and a column that empties itself looks broken.
    // Aimed at the edit that would actually hide a row: a count filter like
    // the one albumTypes uses. Unlike a genre nobody has, "no favourites yet"
    // is a state the user can change from that very column.
    const block = /const favourites = \[([\s\S]*?)\];/.exec(src);
    assert.ok(block, 'the favourite options block is gone');
    assert.doesNotMatch(block[1], /\.filter\(/,
      'the favourite options are filtered by count — the column can empty');
    assert.doesNotMatch(src, /favourites *= *favourites\.filter/,
      'the favourite options are filtered after the fact');
    assert.match(src, /return \{\s*favourites,/, 'the options response omits them');
  });
});

test('the heart chip is gone and the section replaced it', async (t) => {
  const grid = client('components', 'AlbumGrid.jsx');
  const focus = client('components', 'Focus.jsx');

  await t.test('no heart chip, and no state behind one', () => {
    assert.doesNotMatch(grid, /filterFavorites/,
      'the heart chip\'s state survived the move');
    assert.doesNotMatch(grid, /<Heart/, 'the heart chip is still in the pill row');
  });

  await t.test('the top row is short enough to fit', () => {
    // The point of the exercise. Four chips on the main wall: sort, Random,
    // the focus funnel, Select. A fifth is what made it scroll.
    const rowStart = grid.indexOf('style={s.pillRow}');
    assert.notEqual(rowStart, -1, 'the main pill row is gone');
    // Anchored on code, not on a comment: `grid` here has had its comments
    // stripped, and a comment anchor would return -1 and slice to the end of
    // the file — which is how the first version of this counted ten chips.
    const rowEnd = grid.indexOf('s.tagChipRow', rowStart);
    assert.ok(rowEnd > rowStart, 'the tag chip row that follows the pill row is gone');
    const row = grid.slice(rowStart, rowEnd);
    // Count the CONTROLS, not the style references: the Select chip is handed
    // s.iconChip as a prop, so counting the style double-counts it.
    const chips = (row.match(/<button/g) || []).length
                + (row.match(/<SelectChip/g) || []).length;
    assert.equal(chips, 4,
      `the main pill row has ${chips} chips — it was five, which is what made ` +
      'it scroll; sort, Random, Focus and Select are the four that fit');
  });

  await t.test('favourite is a section, first in the default order', () => {
    assert.match(focus, /FOCUS_SECTIONS = \[\s*\{ key: 'favourite', *label: 'Favourites' \}/);
  });

  await t.test('it reaches the server as its own params', () => {
    assert.match(focus, /addList\('focus_favourite', *picks\.favourite\.include\)/);
    assert.match(focus, /addList\('focus_favourite_excl', *picks\.favourite\.exclude\)/);
    assert.match(focus, /sectionKey === 'favourite'\) *return options\.favourites/);
  });

  await t.test('a favourites focus does NOT also send ?favorites=1', () => {
    // That param is the dedicated Favourites SCREEN. Sending both would turn
    // "not favourites" into "favourites" — the two would AND together.
    assert.match(grid, /const showOnlyFavorites = favoritesOnly\b/);
    assert.doesNotMatch(grid, /showOnlyFavorites = favoritesOnly \|\|/);
  });

  await t.test('the dedicated Favourites screen is untouched', () => {
    assert.match(grid, /favoritesOnly = false/, 'the prop is gone');
    assert.match(grid, /favParam = showOnlyFavorites \? '&favorites=1' : ''/);
    assert.match(grid, /No favourites yet\./, 'its empty state went with the chip');
  });

  await t.test('Random still gives a favourite when favourites are focused', () => {
    // The heart chip used to feed Random through showOnlyFavorites. Losing it
    // quietly is the kind of regression nobody reports for weeks — so the
    // condition is LIFTED AND RUN, not read. Asserting the source text passed
    // happily when the expression was short-circuited to false.
    const m = /const favouriteOnly = ([\s\S]*?)\n *const favParam = favouriteOnly/.exec(grid);
    assert.ok(m, 'the favouriteOnly condition is gone');
    const decide = new Function('showOnlyFavorites', 'focusEnabled', 'focus',
      `return (${m[1].trim()})`);
    const picks = (inc, exc = []) => ({
      picks: { favourite: { include: new Set(inc), exclude: new Set(exc) } },
    });
    assert.equal(!!decide(false, true, picks(['yes'])), true,
      'Random ignores a favourites focus');
    assert.equal(!!decide(true, true, picks([])), true,
      'Random ignores the dedicated Favourites screen');
    // Not when "no" is ticked, or both, or when it is an exclude: "a random
    // favourite" is not the answer to any of those.
    assert.equal(!!decide(false, true, picks(['no'])), false);
    assert.equal(!!decide(false, true, picks(['yes', 'no'])), false);
    assert.equal(!!decide(false, true, picks([], ['no'])), false);
    assert.equal(!!decide(false, true, picks([])), false);
    assert.match(grid, /favParam = favouriteOnly \? '\?favorites=1' : ''/);
  });
});

test('the two halves agree on the section key', () => {
  // The seam. The album grid exempts exactly one section from its
  // cache-dropping rule, by name; the hook defines the sections, by name; the
  // server reads a param built from that name. A rename in one place and not
  // the others is silent — the exemption would stop matching and the page
  // cache would quietly stop working with favourites on.
  const focus = client('components', 'Focus.jsx');
  const grid = client('components', 'AlbumGrid.jsx');
  const server = code(readRaw(SERVER_SRC, 'routes', 'library.js'));

  const keys = [...focus.matchAll(/\{ key: '(\w+)', *label:/g)].map(m => m[1]);
  assert.ok(keys.includes('favourite'), 'the section key is not "favourite"');
  assert.match(grid, /k !== 'favourite'/, 'the cache exemption names a different key');
  assert.match(grid, /restoredView\.favourite/, 'the seed names a different key');
  assert.match(grid, /focus\.picks\.favourite\./, 'the grid reads a different key');
  assert.ok(server.includes('focus_favourite'), 'the server reads a different param');
});
