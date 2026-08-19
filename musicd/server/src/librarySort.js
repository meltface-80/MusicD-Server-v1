// The album library's sort suite.
//
// One source of truth for which sorts exist, what each one means, and the SQL
// that implements it. The client builds its sort sheet from the same list
// (client/src/librarySort.js mirrors this; test/library-sort.test.js pins the
// two together), so a sort added here cannot go missing at the other end.
//
// Modelled on MusicD-Remote's library wall, which is where these seven and
// their direction semantics come from. Two of its rules are load-bearing and
// easy to lose:
//
//   - Alphabetical sorts open A→Z; everything quantitative opens with the
//     biggest or newest first, because that is what people mean by "sort by
//     year" or "most played". Hence a per-sort default direction rather than
//     one global one.
//   - An album with no year, or no added date, is UNKNOWN — not year zero.
//     It sorts last in BOTH directions. Without that, reversing Release year
//     to oldest-first floats every undated album to the top of the wall, and
//     on a library where the scan could not read many dates that is most of
//     the screen.

// `defaultDir` is the direction you get when you first pick the sort.
// `asc`/`desc` are the human meanings of the two directions, used as the
// sheet's reversal hint. `note` explains where the data comes from when it is
// not obvious. Random has no direction — re-picking it reshuffles instead.
const SORTS = [
  { id: 'album', label: 'Album name', defaultDir: 'asc',
    asc: 'A → Z', desc: 'Z → A' },
  { id: 'artist', label: 'Artist', defaultDir: 'asc',
    asc: 'A → Z', desc: 'Z → A' },
  { id: 'year', label: 'Release year', defaultDir: 'desc',
    asc: 'Oldest first', desc: 'Newest first',
    note: 'from years read during scanning' },
  { id: 'added', label: 'Recently added', defaultDir: 'desc',
    asc: 'Oldest first', desc: 'Newest first',
    note: 'from when the scanner first saw the album' },
  { id: 'plays', label: 'Most played', defaultDir: 'desc',
    asc: 'Least played first', desc: 'Most played first',
    note: 'from plays this server has recorded' },
  { id: 'lastplayed', label: 'Last played', defaultDir: 'desc',
    asc: 'Longest ago first', desc: 'Most recent first',
    note: 'from plays this server has recorded' },
  { id: 'random', label: 'Random', defaultDir: 'asc', hasDir: false },
];

const SORT_IDS = SORTS.map(s => s.id);

// Ids the API answered to before the suite grew, kept working because
// /api/library/albums is a public route and an older client may still be
// holding one. 'title' was the album-name sort; 'artist' and 'year' already
// mean what they mean.
const LEGACY_SORT_ALIASES = { title: 'album' };

const DEFAULT_SORT = 'album';

function sortById(id) {
  return SORTS.find(s => s.id === id) || null;
}

// Does this sort have a direction the user can reverse? Random does not.
function sortHasDir(id) {
  const s = sortById(normaliseSort(id));
  return s ? s.hasDir !== false : true;
}

function normaliseSort(id) {
  const key = String(id == null ? '' : id);
  if (sortById(key)) return key;
  const alias = LEGACY_SORT_ALIASES[key];
  return alias && sortById(alias) ? alias : DEFAULT_SORT;
}

function defaultDirFor(id) {
  const s = sortById(normaliseSort(id));
  return s ? s.defaultDir : 'asc';
}

// An absent or unrecognised direction means "this sort's own default", not a
// blanket ASC — picking Release year has to open newest-first.
function normaliseDir(sortId, dir) {
  const d = String(dir == null ? '' : dir).toLowerCase();
  if (d === 'asc' || d === 'desc') return d;
  return defaultDirFor(sortId);
}

// The shuffle seed. Changing it reshuffles; keeping it holds the order steady
// across the pages of one infinite scroll, which is the whole reason the
// random sort is seeded rather than ORDER BY RANDOM().
function normaliseSeed(seed) {
  const n = parseInt(seed, 10);
  return Number.isFinite(n) && n > 0 ? n % 100000 || 1 : 1;
}

// Tie-break every sort down to a unique key.
//
// Not cosmetic: this list is paged with LIMIT/OFFSET, and SQLite is free to
// return rows with equal sort keys in any order it likes. Two pages of a
// thousand albums that all have the same year would then overlap and skip —
// the grid shows duplicates and silently loses albums. Title then id makes
// the order total, so page N+1 begins exactly where page N stopped.
const TIEBREAK = 'albums.title COLLATE NOCASE ASC, albums.id ASC';

// Album-to-play_history correlation. play_history records the album by title
// and artist rather than by id, so this is what it has to match on;
// idx_play_history_album covers exactly that pair.
const PLAY_MATCH =
  'ph.album_title = albums.title AND ph.album_artist = albums.album_artist';

// SQLite has no hash builtin, so the random sort's ordering function is
// registered on the connection by db.init(). Named here so the registration
// and the SQL that calls it cannot drift apart.
const SHUFFLE_FN = 'musicd_shuffle';

// A seeded 32-bit avalanche hash of (id, seed). Deterministic, so the shuffle
// holds still while the grid pages through it, and well mixed, so neighbouring
// ids do not stay neighbours — which is what the arithmetic-in-SQL version got
// wrong. Returns a signed 32-bit integer; only the ORDER matters.
function shuffleRank(id, seed) {
  let h = (seed >>> 0) ^ 0x9e3779b9;
  const str = String(id == null ? '' : id);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;    // FNV-1a round
  }
  // Final avalanche (murmur3 finaliser) so the low bits are as mixed as the
  // high ones — an FNV hash alone leaves short, similar strings clustered.
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h | 0;
}

// Call once per connection, from db.init().
function registerSqlFunctions(database) {
  database.function(SHUFFLE_FN, { deterministic: true }, shuffleRank);
}

// The ORDER BY body for a validated (sort, dir, seed). Callers interpolate it
// straight into the statement, so everything here is either a literal or an
// integer this module produced — never caller text.
function orderByFor(sortId, dir, seed) {
  const sort = normaliseSort(sortId);
  const d = normaliseDir(sort, dir) === 'desc' ? 'DESC' : 'ASC';

  switch (sort) {
    case 'artist':
      // Fall back to the track artist when an album has no album artist,
      // otherwise those albums collect under a blank heading at one end.
      return `COALESCE(NULLIF(albums.album_artist, ''), albums.artist) ` +
             `COLLATE NOCASE ${d}, ${TIEBREAK}`;

    case 'year':
      // The leading term is 0 for known and 1 for unknown and is ALWAYS ASC,
      // so undated albums stay at the bottom whichever way `d` points.
      //
      // NULLIF collapses the two spellings of "no year" — NULL and 0 — to one
      // value, so the unknown block falls through to the tiebreaker and reads
      // the same in both directions. Without it, reversing the sort visibly
      // reorders the undated albums among themselves for no reason the user
      // can see.
      return `(albums.year IS NULL OR albums.year = 0) ASC, ` +
             `NULLIF(albums.year, 0) ${d}, ${TIEBREAK}`;

    case 'added':
      return `(albums.added_at IS NULL OR albums.added_at = 0) ASC, ` +
             `NULLIF(albums.added_at, 0) ${d}, ${TIEBREAK}`;

    case 'plays':
      // Never played is a genuine zero here — least played — so no unknown
      // handling, unlike year and added.
      return `(SELECT COUNT(*) FROM play_history ph WHERE ${PLAY_MATCH}) ${d}, ` +
             `${TIEBREAK}`;

    case 'lastplayed':
      // Never played coalesces to 0, i.e. the far end of "longest ago",
      // which is where it belongs in both directions.
      return `COALESCE((SELECT MAX(ph.played_at) FROM play_history ph ` +
             `WHERE ${PLAY_MATCH}), 0) ${d}, ${TIEBREAK}`;

    case 'random': {
      // Not ORDER BY RANDOM(): the order has to be a pure function of
      // (album, seed), or paging through it re-rolls the shuffle and the grid
      // serves the same album twice while missing others. Reshuffling is a
      // new seed, not a new query.
      //
      // The first attempt at this multiplied the rowid by a large constant and
      // reduced mod a prime, inline in SQL. It did not shuffle: for the small
      // consecutive rowids a library actually has, the products land in
      // increasing order and the result is barely distinguishable from sorting
      // by rowid, with every seed producing the same cyclic order. Running it
      // against a real SQLite is what showed that, which is why the test does.
      //
      // shuffleRank below is a proper avalanche hash, registered on the
      // connection by db.init(). Keyed on the album id rather than the rowid
      // so a rescan that renumbers rows does not silently reshuffle the wall.
      const n = normaliseSeed(seed);
      return `${SHUFFLE_FN}(albums.id, ${n}) ASC, ${TIEBREAK}`;
    }

    case 'album':
    default:
      return `albums.title COLLATE NOCASE ${d}, albums.id ASC`;
  }
}

module.exports = {
  SORTS, SORT_IDS, LEGACY_SORT_ALIASES, DEFAULT_SORT, SHUFFLE_FN,
  sortById, sortHasDir, normaliseSort, normaliseDir, normaliseSeed,
  defaultDirFor, orderByFor, shuffleRank, registerSqlFunctions,
};
