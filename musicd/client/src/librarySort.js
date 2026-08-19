// The album grid's sort suite, client half.
//
// This mirrors server/src/librarySort.js: same ids, same labels, same default
// directions. The server owns the SQL, this owns the sheet and the stored
// preference. `test/library-sort.test.js` compares the two lists field by
// field, so adding a sort to one and forgetting the other fails the suite
// rather than shipping a pill that returns albums in the wrong order.
//
// Two rules carried over from MusicD-Remote's library wall, both easy to lose:
//
//   - Alphabetical sorts open A→Z; quantitative ones open with the biggest or
//     newest first, because that is what "sort by year" or "most played"
//     means. Hence a per-sort default direction.
//   - Re-picking the sort you are already on REVERSES it. There is no separate
//     direction control: the arrow on the active row is the whole affordance.
//     Random is the one row with nothing to reverse, so re-picking it
//     reshuffles instead.

export const SORTS = [
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
]

export const DEFAULT_SORT = 'album'

export const sortById = (id) => SORTS.find(s => s.id === id) || null

export const sortHasDir = (id) => {
  const s = sortById(normaliseSort(id))
  return s ? s.hasDir !== false : true
}

export function normaliseSort(id) {
  const key = String(id == null ? '' : id)
  if (sortById(key)) return key
  // 'title' was the album-name sort before the suite grew. A stored
  // preference from an older build still resolves.
  if (key === 'title') return 'album'
  return DEFAULT_SORT
}

export function defaultDirFor(id) {
  const s = sortById(normaliseSort(id))
  return s ? s.defaultDir : 'asc'
}

export function normaliseDir(sortId, dir) {
  const d = String(dir == null ? '' : dir).toLowerCase()
  if (d === 'asc' || d === 'desc') return d
  return defaultDirFor(sortId)
}

export function normaliseSeed(seed) {
  const n = parseInt(seed, 10)
  return Number.isFinite(n) && n > 0 ? n % 100000 || 1 : 1
}

// A seed the server has not just served, so a reshuffle visibly reorders
// instead of repainting the same shuffle.
export function nextSeed(current) {
  let next = current
  while (next === current) next = Math.floor(Math.random() * 100000) + 1
  return next
}

// The label under the sheet's active row, and the sort chip's tooltip.
export function dirLabel(sortId, dir) {
  const s = sortById(normaliseSort(sortId))
  if (!s || s.hasDir === false) return ''
  return normaliseDir(sortId, dir) === 'desc' ? s.desc : s.asc
}

// ---------------------------------------------------------------------------
// Persistence.
//
// The preference has to survive leaving the PWA entirely — iOS discards the
// page when the app is backgrounded for long enough, and the home-screen
// shortcut re-launches it cold — so this is localStorage, not component state
// and not the in-memory page cache. sessionStorage would be lost on exactly
// the trip the user notices.
//
// Stored per grid variant: Albums, Favourites and Saved-for-later are three
// screens browsed for different reasons, and one shared setting would mean
// sorting Favourites by Most played silently re-sorted the main wall too.

const STORE_KEY = 'musicd_library_sort'
const STORE_VERSION = 1

const emptyStore = () => ({ v: STORE_VERSION, views: {} })

// A stored blob is JSON, so it can parse cleanly and still be the wrong SHAPE:
// a partial write, a hand-edited value, or a blob from a future build. Every
// field is coerced through the normalisers rather than trusted, because an
// unvalidated `sort: null` would otherwise reach the query string and come
// back as an empty grid with no way out short of clearing site data.
function readStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return emptyStore()
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || typeof parsed.views !== 'object' || !parsed.views) {
      return emptyStore()
    }
    return { v: STORE_VERSION, views: parsed.views }
  } catch (e) {
    // Corrupt, or localStorage unavailable (private browsing, storage
    // disabled). The defaults stand; the app must not fail to render over a
    // sort preference.
    return emptyStore()
  }
}

export function loadSortView(key) {
  const stored = readStore().views[key]
  const sort = normaliseSort(stored && stored.sort)
  return {
    sort,
    dir: normaliseDir(sort, stored && stored.dir),
    seed: normaliseSeed(stored && stored.seed),
  }
}

export function saveSortView(key, view) {
  try {
    const store = readStore()
    store.views[key] = {
      sort: normaliseSort(view.sort),
      dir: normaliseDir(view.sort, view.dir),
      seed: normaliseSeed(view.seed),
    }
    localStorage.setItem(STORE_KEY, JSON.stringify(store))
  } catch (e) {
    // Storage full or unavailable. The sort still applies for this session;
    // only its persistence is lost, which is not worth interrupting the user.
  }
}

// The query fragment for a view. `seed` is sent only for the random sort —
// carrying it otherwise would put a meaningless value in the server's cache
// key and split the cache per reshuffle for every other sort.
export function sortQuery(view) {
  const sort = normaliseSort(view.sort)
  const dir = normaliseDir(sort, view.dir)
  const seedPart = sort === 'random' ? `&seed=${normaliseSeed(view.seed)}` : ''
  return `sort=${encodeURIComponent(sort)}&dir=${dir}${seedPart}`
}

export const STORAGE_KEY = STORE_KEY
