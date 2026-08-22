import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import {
  SORTS as SORT_OPTIONS, sortById, sortHasDir, defaultDirFor, normaliseDir,
  nextSeed, dirLabel, loadSortView, saveSortView, sortQuery,
} from '../librarySort'
import { useStore } from '../store'
import { api } from '../api'
import { Shuffle, Play, Plus, SlidersHorizontal, ArrowUp, ArrowDown } from 'lucide-react'
import { FocusBar, FocusPills, FocusModal, useFocusState, FOCUS_SECTIONS, applySectionOrder } from './Focus'
import {
  useAlbumSelection, runSelectionAction,
  SelectChip, SelectionBar, SelectionSheet, SelectionTick,
} from './AlbumSelection'
import ServiceBadge from './ServiceBadge'
import VersionBadge from './VersionBadge'
import AlbumTile from './AlbumTile'

const PAGE_SIZE = 200

// v1.1.0.94 — module-level focus options cache.
//
// Previously focusOptions was held only in React state on AlbumGrid.
// When the user navigated away from the albums screen and back, the
// component unmounted/remounted and focusOptions reset to null,
// forcing a re-fetch. With the server's 1-hour TTL the response is
// fast but the bar still shows "Loading focus options…" during the
// network round-trip, which the user found jarring after v91 made
// most operations instant.
//
// This cache persists across mount/unmount cycles within the same
// page session. It expires after 1 hour to match the server TTL,
// or sooner if the library is rescanned (the server's cache
// invalidation already handles that — the next fetch will refresh
// this cache too).
//
// Persisted in memory only, not localStorage — the data can be large
// (tens of KB for a 50k-track library) and a fresh page load should
// always re-fetch to pick up library changes since last session.
const _focusOptionsCache = { value: null, fetchedAt: 0 };
const FOCUS_OPTIONS_CLIENT_TTL_MS = 60 * 60 * 1000;

// Module-level album-page cache — the same idea as _focusOptionsCache
// above, for the loaded album list itself.
//
// This grid is infinite-scrolling: page 1 comes from the mount effect and
// every page after it from the sentinel's IntersectionObserver, all held in
// component state. Opening an album UNMOUNTS the grid (App.jsx swaps in
// AlbumDetail), so on the way back the list restarts at page 1 — a couple
// of hundred albums where there had been a couple of thousand. The scroll
// container is then far shorter than the offset App.jsx is trying to put
// back, the assignment clamps to the bottom, and the position is lost.
//
// So the cache holds the whole loaded range plus the view state that
// produced it, letting a remount render the same list at the same height in
// its very first commit.
//
// Two things keep it from going stale:
//   - a mount that hydrates from it immediately re-fetches the WHOLE
//     restored range in one request (limit = restored length) instead of
//     replacing N pages with page 1, so the data is refreshed without the
//     list shrinking under the restored scroll position;
//   - a completed library scan drops the entry outright.
// An entry older than the TTL is discarded rather than hydrated, and a
// focus-filtered list is never written at all (see the mirror effect).
//
// In memory only, like the focus options: a fresh page load re-fetches.
const _albumPagesCache = new Map();
const ALBUM_PAGES_CACHE_TTL_MS = 30 * 60 * 1000;

// The view key as it will be at first render: the stored sort, and the
// filters the cached entry itself restores. Tag picks come back from the
// entry, and so does the FAVOURITES focus pick (v1.1.31.0) — every other focus
// pick never does, and an entry carrying one is never written. Computed before
// the component's state exists, which is why it reads the entry rather than
// the state.
function mountViewKey(key, sortView) {
  const hit = _albumPagesCache.get(key);
  if (!hit) return null;
  return albumsViewKey({
    sort: sortView.sort,
    dir: sortView.dir,
    seed: sortView.seed,
    showOnlyFavorites: key === 'favorites',
    savedOnly: key === 'saved',
    tagFilter: new Set(hit.tagIds || []),
    // The fragment the seeded favourites pick will produce once the component
    // is up. It has to match, or the entry is discarded as stale the moment
    // its own filter is restored.
    focusQuery: hit.favQuery || '',
  });
}

function readAlbumPagesCache(key, viewKey) {
  const hit = _albumPagesCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.savedAt > ALBUM_PAGES_CACHE_TTL_MS) {
    _albumPagesCache.delete(key);
    return null;
  }
  // An empty list has no height to restore and hydrating it would only
  // suppress the spinner on a genuinely empty library.
  if (!hit.albums.length) return null;
  // The stored sort preference is read fresh at mount and may have been
  // changed on another screen since this entry was written. Rendering the old
  // order while the correctly-sorted fetch is in flight would show the user
  // the sort they just left. Refetch from scratch instead.
  if (viewKey && hit.viewKey && hit.viewKey !== viewKey) return null;
  return hit;
}

// A stable description of WHICH list a given set of albums is: every input
// the server's answer depends on, in a fixed order.
//
// The mirror effect below needs this because it cannot trust `sort` and
// `albums` to describe the same thing. Changing the sort re-renders with the
// new `sort` while `albums` still holds the previous order, and the load
// effect and the mirror effect both read THAT render — so the load effect
// scheduling setReloading(true) cannot stop the mirror running in the very
// same commit. The entry would then claim the old list was sorted the new
// way, and the next mount would restore it under that label.
//
// So the loaded list carries the key of the view it actually came from, and
// the mirror writes only while that key still matches what is on screen.
function albumsViewKey({ sort, dir, seed, showOnlyFavorites, savedOnly, tagFilter, focusQuery }) {
  return JSON.stringify([
    sort,
    // Direction and seed change the ORDER the server answers with, so they
    // are as much a part of "which list is this" as the sort itself. Leaving
    // the seed out would let a reshuffle mirror the previous shuffle's albums
    // under the new seed and then restore them as if they were it.
    normaliseDir(sort, dir),
    sort === 'random' ? seed : 0,
    !!showOnlyFavorites,
    !!savedOnly,
    [...tagFilter].sort((a, b) => a - b),
    focusQuery || '',
  ]);
}

// v1.1.0.70 — `savedOnly` mirrors the v1.1.0.27-era favoritesOnly flag.
// When true (set by App.jsx when rendering this grid as the dedicated
// Saved-for-later screen) we add ?saved=1 to the album-list query and
// switch the heading to "Saved for later." Because the server's
// favourites and saved filters are composable, the user could in
// future combine both — but for now this prop is exposed only on
// the Saved-for-later screen, where favoritesOnly will be false.
export default function AlbumGrid({ onAlbumSelect, favoritesOnly = false, savedOnly = false, headingOverride = null }) {
  const { setSelectedAlbum, libraryStatus, rendererId, playQueue, appendToQueue } = useStore()
  const selectAlbum = onAlbumSelect || setSelectedAlbum
  // Which of the three grids this is. Albums, Favourites and Saved-for-later
  // are separate lists browsed to separate depths, so each keeps its own
  // cache entry.
  const cacheKey = savedOnly ? 'saved'
    : favoritesOnly ? 'favorites'
    : (headingOverride || 'albums')
  // The sort preference, restored from localStorage so it survives the app
  // being closed and relaunched from the home screen — see ../librarySort.
  // Read once at mount; from then on this state is the source of truth and
  // every change is written straight back.
  const [sortView, setSortView] = useState(() => loadSortView(cacheKey))
  const { sort, dir: sortDir, seed: sortSeed } = sortView

  // Read once, at mount. Later renders must not re-read: the entry is
  // rewritten as the user loads more pages, and re-reading would fight it.
  // The mount view key is passed in so a cached list from a different sort is
  // refetched rather than shown.
  const [restoredView] = useState(() => readAlbumPagesCache(cacheKey, mountViewKey(cacheKey, sortView)))
  const [albums, setAlbums] = useState(() => restoredView ? restoredView.albums : [])
  // A spinner has no height. Hydrating straight into the restored list is
  // what lets the container be tall enough for the scroll restore to land.
  const [loading, setLoading] = useState(!restoredView)
  const [loadingMore, setLoadingMore] = useState(false)
  // True while a first-page or refresh fetch is in flight. `loading` only
  // covers the very first load (v1.1.1.0 keeps the grid on screen for every
  // later one), and the cache mirror has to skip these moments: `sort` and
  // `offset` have already moved to their new values while `albums` still
  // holds the previous list, so a snapshot taken here would describe a view
  // the server has not answered for.
  const [reloading, setReloading] = useState(false)
  const [offset, setOffset] = useState(restoredView ? restoredView.offset : 0)
  const [hasMore, setHasMore] = useState(restoredView ? restoredView.hasMore : true)
  // v1.1.31.0 — the heart chip is gone; favourites is a Focus section now.
  // What is left here is the favoritesOnly *prop*, set when this grid is
  // rendered as the dedicated Favourites SCREEN — a different thing from a
  // filter on this one, and still driven by ?favorites=1.
  const [randomBusy, setRandomBusy] = useState(false)
  // Busy flag shared by Play All / Queue All on the Favourites screen so we
  // can disable both while the bulk track fetch is in flight.
  const [bulkBusy, setBulkBusy] = useState(false)
  // v1.1.0.71 — chip-strip tag filter. tagFilter is the id of the
  // currently-selected user tag, or null for "show everything." All
  // tags is loaded once on mount and refreshed when the chip strip
  // is interacted with — there's no live websocket push for tag
  // changes, but the chip strip is small enough that a refetch on
  // each filter change is fine (a few ms even with hundreds of tags).
  // The chip strip is suppressed entirely when there are zero tags
  // and on the dedicated Favourites/Saved-for-later screens — those
  // screens are themselves "filtered" views, and stacking another
  // tag filter on top would be confusing without a clear UX for
  // multi-filter combination.
  const [allTags, setAllTags] = useState([])
  // v1.1.0.73 — tagFilter is now a Set<id> (was single id in v71).
  // Tap a chip toggles its membership in the set; the server
  // intersects (AND) the active set. The "All albums" chip clears
  // the set entirely. State is held as a Set instance and replaced
  // wholesale on each toggle so React's identity-based change
  // detection fires.
  const [tagFilter, setTagFilter] = useState(
    () => new Set(restoredView ? restoredView.tagIds : []))
  const sentinelRef = useRef(null)

  // v1.1.0.80 — Focus state. Only used when this AlbumGrid is the
  // main Albums view (not Favourites or Saved For Later, which have
  // their own intrinsic filter and don't need Focus on top).
  // The funnel pill toggles `focusOpen`; the bar renders only when
  // open. Pills render whenever any picks exist, regardless of bar
  // state — closing the bar preserves selections per spec.
  const focusEnabled = !favoritesOnly && !savedOnly
  // Seeded from the cache entry, so a favourites focus survives opening an
  // album and coming back — which is what the heart chip used to do, and what
  // this must not lose. Only favourites: every other focus pick is still
  // dropped on unmount, and the entry is dropped with it (see the mirror).
  const focus = useFocusState(restoredView && restoredView.favourite
    ? { favourite: restoredView.favourite } : null)
  const [focusOpen, setFocusOpen] = useState(false)
  // v1.1.0.94 — initialise from module-level cache so navigating
  // back to this screen doesn't show "Loading focus options…".
  // The cache is bounded by FOCUS_OPTIONS_CLIENT_TTL_MS.
  const [focusOptions, setFocusOptions] = useState(() => {
    if (_focusOptionsCache.value &&
        Date.now() - _focusOptionsCache.fetchedAt < FOCUS_OPTIONS_CLIENT_TTL_MS) {
      return _focusOptionsCache.value;
    }
    return null;
  })

  // v1.1.0.83 — Focus sub-section order. Server stores user's
  // preferred column order in the settings table; client applies
  // it on render. null means "use the default" (FOCUS_SECTIONS as
  // shipped). Computed `orderedSections` is what FocusBar consumes.
  const [sectionOrder, setSectionOrder] = useState(null)
  const orderedSections = useMemo(
    () => applySectionOrder(sectionOrder),
    [sectionOrder]
  )
  const isOrderCustomised = sectionOrder !== null && sectionOrder.length > 0

  // Fetch persisted section order on mount (only when focus is
  // enabled — i.e. on the main Albums view, not Favourites/Saved).
  useEffect(() => {
    if (!focusEnabled) return
    let cancelled = false
    api.get('/library/focus/section-order').then(r => {
      if (cancelled) return
      // r.order is an array of section keys, or null. Either is fine.
      setSectionOrder(r?.order || null)
    }).catch(e => {
      // v1.1.0.96 — was silent. The section-order load is non-critical
      // (the bar still works with default order) but a persistent
      // error is worth surfacing for diagnosis. Logged to console
      // since there's no user-actionable recovery — this is
      // dev-facing.
      console.warn('[focus] section-order load failed:', e?.message || e)
    })
    return () => { cancelled = true }
  }, [focusEnabled])

  // Reorder handler — called when the user drops a column in a new
  // slot. Optimistically updates local state, then persists. If the
  // PUT fails we roll back.
  const handleReorder = useCallback(async (newOrder) => {
    const previous = sectionOrder
    setSectionOrder(newOrder)
    try {
      await api.put('/library/focus/section-order', { order: newOrder })
    } catch (e) {
      // Rollback on failure. The UI snaps back to the previous order.
      console.warn('[focus] section reorder persistence failed:', e?.message)
      setSectionOrder(previous)
    }
  }, [sectionOrder])

  const handleResetOrder = useCallback(async () => {
    const previous = sectionOrder
    setSectionOrder(null)
    try {
      // v1.1.0.92 — was `api.delete(...)` which doesn't exist on
      // the api object (it exports `del`, not `delete`). The result
      // was `undefined.then is not a function`, swallowed by the
      // catch, so the button silently did nothing. Now uses `del`.
      await api.del('/library/focus/section-order')
    } catch (e) {
      console.warn('[focus] section reset failed:', e?.message)
      setSectionOrder(previous)
    }
  }, [sectionOrder])

  // v1.1.29.0 — multi-select. The state and the actions are shared with the
  // Random-albums wall (AlbumSelection.jsx); what lives here is only where the
  // chip and the bar sit in this screen's header.
  const selection = useAlbumSelection()
  const [selectionSheet, setSelectionSheet] = useState(false)
  const [selectionBusy, setSelectionBusy] = useState(false)
  const [selectionError, setSelectionError] = useState(null)

  const runSelection = async (action) => {
    setSelectionBusy(true)
    setSelectionError(null)
    // v1.1.43.0 — the ORDER matters to merge: the first album ticked
    // becomes disc 1. Every other action ignores it.
    const r = await runSelectionAction(action, selection.selected, selection.order)
    setSelectionBusy(false)
    if (!r.ok) {
      setSelectionError(
        r.reason === 'no-renderer' ? 'Choose an output first (☰ → Output).'
        : r.reason === 'no-tracks' ? 'Those albums have no playable tracks.'
        : r.error || "That didn't work.")
      return
    }
    // Only a success closes up: leaving the sheet open on a failure is what
    // lets the user read why and pick something else.
    setSelectionSheet(false)
    selection.exit()
    // A merge turns several tiles into one, so this grid is now
    // showing albums that no longer exist. Re-read it.
    if (r.reload) fetchPage(sortView, 0, false).catch(() => {})
  }

  // The sort sheet. Open/closed only — the choice itself lives in sortView.
  //
  // v1.1.26.1 — this line was collateral damage in v1.1.25.0. The saved-focus
  // removal spliced from the save-modal comment to the end of the last save
  // handler, and this declaration was sitting between two of them. Nothing
  // caught it: an undeclared identifier is not a build error, it is a
  // ReferenceError on first render, and AlbumGrid is BOTH the Albums screen
  // and Saved for later — so both came up blank.
  const [sortSheetOpen, setSortSheetOpen] = useState(false)

  // Fetch focus options on first mount when needed. The endpoint
  // computes from the live library, so we re-fetch when the bar
  // opens — that way picks reflect any albums added since the
  // initial load. Cached server-side for 60s so reopen is cheap.
  // v1.1.0.94 — also writes to the module-level cache so a later
  // mount picks up the same value without the network round-trip.
  useEffect(() => {
    if (!focusEnabled) return
    if (!focusOpen && focusOptions) return  // already loaded; only refresh on open
    if (!focusOpen) return
    let cancelled = false
    api.get('/library/focus/options').then(opts => {
      if (!cancelled) {
        setFocusOptions(opts)
        _focusOptionsCache.value = opts
        _focusOptionsCache.fetchedAt = Date.now()
      }
    }).catch(e => {
      // v1.1.0.96 — was silent.
      console.warn('[focus] options load failed:', e?.message || e)
    })
    return () => { cancelled = true }
  }, [focusEnabled, focusOpen])

  // The dedicated Favourites screen only. A favourites FOCUS goes through the
  // focus query like every other pick, so it must not also set ?favorites=1 —
  // that would silently turn "not favourites" into "favourites".
  const showOnlyFavorites = favoritesOnly

  // The view the albums currently in state were actually fetched under.
  // Stamped by fetchPage when a response lands, compared by the mirror
  // effect. Seeded from the restored entry so a rehydrated mount — which
  // restores the sort, the favourites chip and the tag picks with it — can
  // refresh the entry without waiting for its first re-fetch.
  // Declared above fetchPage deliberately: const is not hoisted.
  const loadedViewKey = useRef(restoredView ? restoredView.viewKey || null : null)

  // `limit` defaults to one page. The cache-rehydrate path passes the whole
  // restored length so a remount refreshes everything it restored in one
  // request rather than collapsing back to page 1.
  // `s` is the whole sort view {sort, dir, seed}, not just the sort id: the
  // direction and the shuffle seed are as much a part of the request as the
  // column, and passing them separately is how one of them gets forgotten at
  // a call site.
  const fetchPage = useCallback(async (s, off, append, limit = PAGE_SIZE) => {
    const favParam = showOnlyFavorites ? '&favorites=1' : ''
    // v1.1.0.70 — composable savedOnly param. The prop is only set when
    // App.jsx renders this grid as the Saved-for-later screen; the
    // chip-strip filter introduced for tags in a future release will
    // also be free to set this flag.
    const savedParam = savedOnly ? '&saved=1' : ''
    // v1.1.0.71 / v1.1.0.73 — tag filter param. v71 sent &tag_id=N
    // (single); v73 sends &tag_ids=N,M,P (comma-separated, AND-
    // semantics on the server). Sorting before joining keeps the
    // URL stable for the same filter set, which keeps server cache
    // hits high.
    const tagParam = tagFilter.size > 0
      ? `&tag_ids=${[...tagFilter].sort((a,b)=>a-b).join(',')}`
      : ''
    // v1.1.0.80 — focus filter params. The hook returns a complete
    // pre-encoded fragment beginning with '&' (or empty string if
    // no picks). Suppressed on Favourites/Saved For Later because
    // the funnel UI isn't shown there.
    const focusParam = focusEnabled ? focus.queryString : ''
    // v1.1.34.0 — ask the server to collapse album versions, but only on
    // the Albums wall. Favourites and Saved-for-later deliberately do
    // NOT: there you picked a specific version, and hiding it behind
    // another copy of the same record would hide the exact row you saved.
    // The server ignores this unless the user has the setting on, so the
    // parameter says "this surface may collapse", not "collapse".
    const versionsParam = (!favoritesOnly && !savedOnly) ? '&versions=collapse' : ''
    const data = await api.get(`/library/albums?${sortQuery(s)}&limit=${limit}&offset=${off}${favParam}${savedParam}${tagParam}${focusParam}${versionsParam}`)
    if (append) setAlbums(prev => [...prev, ...data])
    else setAlbums(data)
    setHasMore(data.length === limit)
    // These albums are the answer to THIS view. Recorded in the same commit
    // as setAlbums, so the mirror effect that runs off `albums` sees it.
    loadedViewKey.current = albumsViewKey({
      sort: s.sort, dir: s.dir, seed: s.seed,
      showOnlyFavorites, savedOnly, tagFilter, focusQuery: focusParam,
    })
    return data.length
  }, [showOnlyFavorites, savedOnly, tagFilter, focusEnabled, focus.queryString])

  // v1.1.1.0 — track whether we've ever loaded successfully. The
  // initial mount shows a spinner; subsequent fetches (sort change,
  // filter change, etc.) keep the existing grid on screen and just
  // replace the data when it arrives. This avoids the jolt of the
  // grid disappearing for ~50-300ms on every interaction.
  const hasLoadedOnce = useRef(!!restoredView)

  // Consumed by the FIRST run of the load effect below and then cleared, so
  // every later run (sort change, filter change) is an ordinary page-1
  // fetch. See the cache block at the top of the file.
  const rehydrateLimit = useRef(restoredView ? restoredView.albums.length : 0)

  // Load first page + stats
  useEffect(() => {
    const rehydrate = rehydrateLimit.current
    rehydrateLimit.current = 0
    if (!hasLoadedOnce.current) setLoading(true)
    setReloading(true)
    if (!rehydrate) {
      setOffset(0)
      setHasMore(true)
    }
    fetchPage(sortView, 0, false, rehydrate || PAGE_SIZE).then((count) => {
      setOffset(count)
      if (rehydrate) {
        // fetchPage set hasMore from `count === limit`, which is not the
        // question here — the restored range came back whole, so whether
        // there is more beyond it is exactly what it was before. A short
        // result means albums were removed while we were away.
        setHasMore(count === rehydrate ? restoredView.hasMore : false)
      }
      hasLoadedOnce.current = true
    }).finally(() => { setLoading(false); setReloading(false) })
  }, [sortView, showOnlyFavorites, savedOnly, tagFilter, fetchPage])

  // Picking a sort. Re-picking the one already active REVERSES it, which is
  // the whole direction affordance — there is no separate control. Random is
  // the one option with nothing to reverse, so re-picking it reshuffles.
  //
  // Written to localStorage on every change rather than on unmount: the app
  // can be discarded by iOS at any moment while backgrounded, and an unmount
  // handler is exactly what does not run when that happens.
  const applySort = useCallback((id) => {
    let next
    if (sortView.sort !== id) {
      // A fresh pick opens at that sort's own default direction — A→Z for the
      // alphabetical ones, newest/most first for the rest.
      next = { sort: id, dir: defaultDirFor(id), seed: sortView.seed }
    } else if (sortHasDir(id)) {
      next = { ...sortView, dir: sortView.dir === 'desc' ? 'asc' : 'desc' }
    } else {
      next = { ...sortView, seed: nextSeed(sortView.seed) }
    }
    setSortView(next)
    saveSortView(cacheKey, next)
  }, [sortView, cacheKey])

  // Declared here, above the JSX: const is not hoisted, and the chip reads
  // all three during render.
  const activeSort = sortById(sort) || SORT_OPTIONS[0]
  const activeSortHasDir = sortHasDir(sort)
  const sortChipTitle = activeSortHasDir
    ? `Sorted by ${activeSort.label} — ${dirLabel(sort, sortDir)}. Tap to change.`
    : `Sorted at random. Tap to change or reshuffle.`

  // v1.1.0.71 — load the tag catalog for the chip strip. Only on the
  // main Albums screen (not Favourites or Saved-for-later — those are
  // already filtered views and we don't render the chip strip there).
  // Re-fetches when the user navigates back to Albums after potentially
  // creating new tags via the TagPicker — the App-level focus event
  // would be cleaner but a simple mount-effect plus a manual refresh on
  // every grid load (next effect, sort/filter dep) covers the common
  // case. If users frequently add tags during a session and want to
  // see them appear without leaving the screen, we can add a refetch
  // tied to a window focus listener in v72.
  useEffect(() => {
    if (favoritesOnly || savedOnly) return
    let cancelled = false
    api.get('/tags').then(tags => {
      if (cancelled) return
      // Filter to tags with at least one album — a tag that's only
      // attached to tracks shouldn't appear on the *album* grid's
      // filter strip. (Track-tag filtering is a separate UI surface.)
      const albumTags = (tags || []).filter(t => (t.album_count || 0) > 0)
      setAllTags(albumTags)
    }).catch(() => {
      // Network hiccup: leave the previous list in place rather than
      // clearing it.
    })
    return () => { cancelled = true }
  }, [favoritesOnly, savedOnly, sortView])

  // When the scanner moves out of 'scanning' (or 'rebuilding_stats'), refresh the
  // visible album list so newly-added albums appear without a manual reload.
  const lastScanPhase = useRef(libraryStatus?.phase)
  useEffect(() => {
    const prev = lastScanPhase.current
    const cur = libraryStatus?.phase
    lastScanPhase.current = cur
    const wasScanning = prev === 'scanning' || prev === 'rebuilding_stats'
    if (!wasScanning) return
    if (cur === prev) return
    // The library just changed underneath us: anything cached describes the
    // old one. Drop it now — the mirror effect below rewrites the entry once
    // the refreshed list lands.
    _albumPagesCache.delete(cacheKey)
    setReloading(true)
    setOffset(0)
    setHasMore(true)
    fetchPage(sortView, 0, false).then((count) => {
      setOffset(count)
    }).finally(() => setReloading(false))
  }, [libraryStatus?.phase, sortView, fetchPage, cacheKey])

  // Mirror the loaded range into the module cache so the next mount can put
  // the same list back at the same height. See the cache block at the top.
  const currentViewKey = useMemo(() => albumsViewKey({
    sort, dir: sortDir, seed: sortSeed, showOnlyFavorites, savedOnly, tagFilter,
    focusQuery: focusEnabled ? focus.queryString : '',
  }), [sort, sortDir, sortSeed, showOnlyFavorites, savedOnly, tagFilter,
       focusEnabled, focus.queryString])

  useEffect(() => {
    if (loading || reloading) return
    // `albums` is still the answer to a different view — a sort or filter
    // has moved and the fetch for it has not landed. Writing now would
    // label this list with a view it was never fetched under.
    if (loadedViewKey.current !== currentViewKey) return
    // Focus picks live in component state and do NOT survive the remount, so
    // a focus-filtered list must never be restored into a grid whose focus bar
    // has come back empty: the user would be looking at a filtered list with
    // nothing on screen explaining the filter. A stale grid is worse than a
    // lost scroll position — drop the entry.
    //
    // v1.1.31.0 — favourites is the exception, and only because it is seeded
    // back (see useFocusState). It carried the page cache when it was a chip
    // and it still does; anything ticked ALONGSIDE it drops the entry as
    // before.
    if (focusEnabled && focus.sectionsWithPicks.some(k => k !== 'favourite')) {
      _albumPagesCache.delete(cacheKey)
      return
    }
    _albumPagesCache.set(cacheKey, {
      albums,
      offset,
      hasMore,
      sort,
      dir: sortDir,
      seed: sortSeed,
      favourite: {
        include: [...focus.picks.favourite.include],
        exclude: [...focus.picks.favourite.exclude],
      },
      favQuery: focusEnabled ? focus.queryString : '',
      tagIds: [...tagFilter],
      viewKey: currentViewKey,
      savedAt: Date.now(),
    })
  }, [cacheKey, loading, reloading, albums, offset, hasMore, sort, sortDir,
      sortSeed, tagFilter, focusEnabled, focus.queryString, focus.picks, focus.sectionsWithPicks,
      currentViewKey])

  // Infinite scroll
  useEffect(() => {
    if (!sentinelRef.current) return
    const observer = new IntersectionObserver(async ([entry]) => {
      if (entry.isIntersecting && !loadingMore && hasMore) {
        setLoadingMore(true)
        const count = await fetchPage(sortView, offset, true)
        setOffset(prev => prev + count)
        setLoadingMore(false)
      }
    }, { rootMargin: '300px' })
    observer.observe(sentinelRef.current)
    return () => observer.disconnect()
  }, [offset, sortView, loadingMore, hasMore, fetchPage])

  // #13 — Play a randomly-chosen album end-to-end. Asks the server for a
  // random album id, fetches its full track list, and starts the queue.
  // When we're in a favourites-scoped view the server is told to pick from
  // favourites only — so the Random button on the Favourites page returns
  // a random favourite, not a random album from the whole library.
  const playRandomAlbum = async () => {
    if (!rendererId) { alert('Tap ☰ → Output to select a renderer first'); return }
    setRandomBusy(true)
    try {
      // v1.1.31.0 — Random still respects a favourites filter. It used to
      // read the heart chip through showOnlyFavorites; now it reads the focus
      // pick, so "Random" from a favourites-filtered wall still gives a
      // favourite. Only the plain include: with 'no' ticked, or both, the
      // right answer is not "a random favourite", and Random has never
      // followed the other focus sections either.
      const favouriteOnly = showOnlyFavorites || (
        focusEnabled
        && focus.picks.favourite.include.has('yes')
        && focus.picks.favourite.include.size === 1
        && focus.picks.favourite.exclude.size === 0)
      const favParam = favouriteOnly ? '?favorites=1' : ''
      const { id } = await api.get(`/library/albums/random${favParam}`)
      if (!id) return
      const album = await api.get(`/library/albums/${id}`)
      if (album?.tracks?.length) {
        playQueue(album.tracks, 0)
        // Open the album so the user sees what's playing
        selectAlbum(id)
      }
    } catch (e) { console.warn('Random album failed:', e) }
    finally { setRandomBusy(false) }
  }

  // #4 (28.4) — Play All / Queue All for the Favourites screen. Hits the
  // dedicated /favorites/tracks endpoint so we get every favourited album's
  // tracks in one round-trip rather than N. Ordered the way the screen
  // displays them (artist → album title).
  const playAllFavorites = async () => {
    if (!rendererId) { alert('Tap ☰ → Output to select a renderer first'); return }
    setBulkBusy(true)
    try {
      const r = await api.get('/library/favorites/tracks')
      if (r?.tracks?.length) playQueue(r.tracks, 0)
    } catch (e) { console.warn('Play all favourites failed:', e) }
    finally { setBulkBusy(false) }
  }

  const queueAllFavorites = async () => {
    setBulkBusy(true)
    try {
      const r = await api.get('/library/favorites/tracks')
      if (r?.tracks?.length) appendToQueue(r.tracks)
    } catch (e) { console.warn('Queue all favourites failed:', e) }
    finally { setBulkBusy(false) }
  }

  // v1.1.0.70 — heading reflects the active filter prop. Saved
  // takes precedence over Favourites if both were ever set
  // simultaneously (currently impossible — App.jsx routes them as
  // separate sections — but defensive in case a future caller
  // composes them).
  const heading = headingOverride || (savedOnly ? 'Saved for later' : (favoritesOnly ? 'Favourites' : 'Albums'))

  return (
    <div style={s.page}>
      <div style={s.header}>
        <div style={s.titleRow}>
          <h1 style={s.heading}>{heading}</h1>
        </div>
        {/* v1.1.29.0 — while selecting, the bar takes the chip row's place.
            Leaving the chips there would let the user re-sort or re-filter the
            wall out from under a selection made against the old one. */}
        {selection.selecting && (
          <SelectionBar
            count={selection.count}
            busy={selectionBusy}
            onCancel={() => { selection.exit(); setSelectionError(null) }}
            onAct={() => { setSelectionError(null); setSelectionSheet(true) }}
          />
        )}

        {/* Action row — different content for the dedicated Favourites screen
            vs the main Albums grid. Both share the chip styling. */}
        {!selection.selecting && (favoritesOnly ? (
          // Favourites screen: Play All, Queue All, and a Random favourite.
          // No "show favourites only" chip here — the page is already that.
          <div className="jp-chip-row" style={s.actionRow}>
            {/* v1.1.11.0 — the sort chip belongs here too. Every grid stores
                its own sort (see loadSortView), so leaving this row out gave
                Favourites a persisted sort and no way to change it. */}
            <button
              style={{ ...s.iconChip, ...s.sortChip }}
              onClick={() => setSortSheetOpen(true)}
              title={sortChipTitle}
              aria-haspopup="dialog"
            >
              {activeSortHasDir && (sortDir === 'desc'
                ? <ArrowDown size={13} aria-hidden="true" />
                : <ArrowUp size={13} aria-hidden="true" />)}
              <span>{activeSort.label}</span>
            </button>
            <button
              style={{ ...s.iconChip, ...s.iconChipPrimary, ...(bulkBusy ? { opacity: 0.5 } : {}) }}
              onClick={playAllFavorites}
              disabled={bulkBusy || albums.length === 0}
              title="Play all favourite albums"
            >
              <Play size={12} fill="currentColor" strokeWidth={0} />
              <span>Play all</span>
            </button>
            <button
              style={{ ...s.iconChip, ...(bulkBusy ? { opacity: 0.5 } : {}) }}
              onClick={queueAllFavorites}
              disabled={bulkBusy || albums.length === 0}
              title="Queue all favourite albums"
            >
              <Plus size={13} />
              <span>Queue all</span>
            </button>
            <button
              style={{ ...s.iconChip, ...(randomBusy ? { opacity: 0.5 } : {}) }}
              onClick={playRandomAlbum}
              disabled={randomBusy || albums.length === 0}
              title="Play a random favourite album"
            >
              <Shuffle size={13} />
              <span>Random</span>
            </button>
            <SelectChip
              selecting={selection.selecting}
              onToggle={() => selection.enter()}
              chipStyle={s.iconChip}
              activeStyle={s.iconChipActive}
            />
          </div>
        ) : (
          // Main Albums screen: pill row (#v1.1.0.30) -- the sort chip,
          // Random and Favourites (heart only), all in one row.
          //
          // v1.1.11.0 -- the three Title/Artist/Year pills became one chip
          // opening a sheet. Seven sorts do not fit a pill row on a phone,
          // and each of them needs a direction and, for two of them, a note
          // saying where the data comes from.
          <div className="jp-chip-row" style={s.pillRow}>
            <button
              style={{ ...s.iconChip, ...s.sortChip }}
              onClick={() => setSortSheetOpen(true)}
              title={sortChipTitle}
              aria-haspopup="dialog"
            >
              {activeSortHasDir && (sortDir === 'desc'
                ? <ArrowDown size={13} aria-hidden="true" />
                : <ArrowUp size={13} aria-hidden="true" />)}
              <span>{activeSort.label}</span>
            </button>
            <button
              style={{ ...s.iconChip, ...(randomBusy ? { opacity: 0.5 } : {}) }}
              onClick={playRandomAlbum}
              disabled={randomBusy}
              title="Play a random album"
            >
              <Shuffle size={15} />
              <span>Random</span>
            </button>
            {/* v1.1.0.80 — Focus funnel. Tapping toggles the Focus bar
                visibility. The pill highlights when the bar is open
                AND when there are active picks (so the user can see at
                a glance whether the visible album list is filtered by
                anything). */}
            <button
              style={{
                ...s.iconChip,
                ...((focusOpen || focus.anyPicks) ? s.iconChipActive : {}),
              }}
              onClick={() => setFocusOpen(v => !v)}
              title={focusOpen ? 'Close focus' : (focus.anyPicks ? 'Focus filters active' : 'Focus')}
              aria-pressed={focusOpen}
              aria-label="Focus"
            >
              <SlidersHorizontal size={15} />
            </button>
            <SelectChip
              selecting={selection.selecting}
              onToggle={() => selection.enter()}
              chipStyle={s.iconChip}
              activeStyle={s.iconChipActive}
            />
          </div>
        ))}
        {/* v1.1.0.71 — tag chip strip. Only rendered on the main
            Albums screen (not Favourites or Saved-for-later) when
            there's at least one user tag with album-side usage.
            v1.1.0.73: multi-select. Tap a chip to add/remove it
            from the active filter Set; the server intersects
            (AND) all selected tags. The "All albums" leading
            chip clears the entire set in one tap. Per-tag album
            counts are hidden when 2+ tags are active because the
            single-tag count would mislead in that context (it's
            the count for that tag in isolation, not the size of
            the current intersection). */}
        {!favoritesOnly && !savedOnly && allTags.length > 0 && (
          <div className="jp-chip-row" style={s.tagChipRow}>
            <button
              style={{ ...s.tagChip, ...(tagFilter.size === 0 ? s.tagChipActive : {}) }}
              onClick={() => setTagFilter(new Set())}
              aria-pressed={tagFilter.size === 0}
              title="Show all albums"
            >
              All albums
            </button>
            {allTags.map(tag => {
              const on = tagFilter.has(tag.id)
              const chipStyle = {
                ...s.tagChip,
                ...(on ? s.tagChipActive : {}),
                ...(tag.color && on ? {
                  borderColor: tag.color,
                  background: hexToRgba(tag.color, 0.18),
                } : {}),
              }
              return (
                <button
                  key={tag.id}
                  style={chipStyle}
                  onClick={() => {
                    // v1.1.0.73 — toggle membership in the active
                    // filter set. Always replace the Set wholesale
                    // so React's identity-based change detection
                    // fires.
                    const next = new Set(tagFilter)
                    if (next.has(tag.id)) next.delete(tag.id)
                    else next.add(tag.id)
                    setTagFilter(next)
                  }}
                  aria-pressed={on}
                  title={`${tag.album_count} album${tag.album_count !== 1 ? 's' : ''}`}
                >
                  {tag.name}
                  {tagFilter.size < 2 && (
                    <span style={s.tagChipCount}>{tag.album_count}</span>
                  )}
                </button>
              )
            })}
          </div>
        )}
        {showOnlyFavorites && (
          <div style={s.statsRow}>{albums.length} favourite{albums.length !== 1 ? 's' : ''}</div>
        )}

        {/* v1.1.0.80 — Focus pills row. Inside the sticky header so
            the pills move with the rest of the top UI rather than
            getting their own sticky stacking position (multi-sticky
            stacking with dynamic heights is fiddly; one container
            sidesteps the problem). Renders only when picks exist
            and only on the main Albums view. Closing the bar with
            X preserves picks via these pills per spec. */}
        {focusEnabled && focus.anyPicks && (
          <FocusPills
            picks={focus.picks}
            onTogglePillSign={focus.togglePillSign}
            onRemovePill={focus.removePill}
            onClearAll={focus.clearAll}
          />
        )}
        {/* v1.1.0.80 — Focus bar. Renders only when funnel is open.
            v1.1.25.0: the save/update buttons v82 put inside it are gone with
            the rest of saved focuses; only the column-order reset remains. */}
        {focusEnabled && focusOpen && (
          <FocusBar
            picks={focus.picks}
            options={focusOptions}
            onTogglePick={focus.togglePick}
            onClose={() => setFocusOpen(false)}
            sections={orderedSections}
            onReorder={handleReorder}
            onResetOrder={handleResetOrder}
            isOrderCustomised={isOrderCustomised}
          />
        )}
      </div>

      {/* v1.1.29.0 — the multi-select action sheet. The same five actions
          here, on Favourites, on Saved for later and on the Random wall; see
          AlbumSelection.jsx. */}
      {selectionSheet && (
        <SelectionSheet
          count={selection.count}
          error={selectionError}
          onClose={() => { setSelectionSheet(false); setSelectionError(null) }}
          onPick={runSelection}
          orderedIds={selection.order}
          albumsById={Object.fromEntries(albums.map(a => [a.id, a]))}
        />
      )}

      {/* v1.1.11.0 — the sort sheet. One row per sort; the active row carries
          the direction arrow and re-picking it reverses. Reuses FocusModal so
          it is not clipped by the sticky header, same as the save modal. */}
      <FocusModal
        open={sortSheetOpen}
        onCancel={() => setSortSheetOpen(false)}
        title="Sort by"
      >
        <div style={s.sortSheet}>
          {SORT_OPTIONS.map(opt => {
            const on = sort === opt.id
            const hasDir = opt.hasDir !== false
            return (
              <button
                key={opt.id}
                type="button"
                style={{ ...s.sortRow, ...(on ? s.sortRowOn : {}) }}
                onClick={() => applySort(opt.id)}
                aria-pressed={on}
                aria-label={on && hasDir
                  ? `${opt.label} — ${dirLabel(opt.id, sortDir)}, activate to reverse`
                  : opt.label}
              >
                {/* The arrow keeps a fixed column on every row, filled only on
                    the active one, so the labels share a single left edge. */}
                <span style={s.sortArrow} aria-hidden="true">
                  {on && hasDir && (sortDir === 'desc'
                    ? <ArrowDown size={15} /> : <ArrowUp size={15} />)}
                  {on && !hasDir && <Shuffle size={14} />}
                </span>
                <span style={s.sortText}>
                  <span style={s.sortLabel}>{opt.label}</span>
                  {on && hasDir && (
                    <span style={s.sortNote}>{dirLabel(opt.id, sortDir)} · tap to reverse</span>
                  )}
                  {on && !hasDir && (
                    <span style={s.sortNote}>tap to reshuffle</span>
                  )}
                  {!on && opt.note && <span style={s.sortNote}>{opt.note}</span>}
                </span>
              </button>
            )
          })}
        </div>
      </FocusModal>



      {loading ? (
        <div style={s.loadWrap}><div style={s.spinner} /></div>
      ) : albums.length === 0 && libraryStatus?.phase !== 'idle' && !showOnlyFavorites && !savedOnly && tagFilter.size === 0 ? (
        <FirstScanProgress status={libraryStatus} />
      ) : albums.length === 0 ? (
        <div style={s.emptyMsg}>
          {tagFilter.size > 0 ? (
            <>
              {tagFilter.size === 1
                ? 'No albums match this tag.'
                : `No albums match all ${tagFilter.size} selected tags.`}
              <br /><br />
              <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                <button
                  onClick={() => setTagFilter(new Set())}
                  style={{ background: 'none', border: 'none', color: 'var(--jp-text-2)', textDecoration: 'underline', cursor: 'pointer', padding: 0 }}
                >Clear filter</button>
                {tagFilter.size > 1 ? ' or remove some chips above to widen the result.' : ' or tag more albums via the ⋯ menu.'}
              </span>
            </>
          ) : (focusEnabled && focus.anyPicks) ? (
            // v1.1.1.0 — Focus-driven empty state. Previously fell
            // through to "No albums in library yet" which is wrong
            // when the user has filtered themselves into nothing.
            <>
              No albums match the current Focus filters.
              <br /><br />
              <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                Open the Focus bar to remove pills, or
                {' '}<button
                  onClick={() => focus.clearAll && focus.clearAll()}
                  style={{ background: 'none', border: 'none', color: 'var(--jp-text-2)', textDecoration: 'underline', cursor: 'pointer', padding: 0 }}
                >clear all picks</button>.
              </span>
            </>
          ) : savedOnly ? (
            <>
              Nothing saved for later yet.
              <br /><br />
              <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                Tap an album's <strong>⋯</strong> menu and choose <strong>Save for later</strong> to add it here.
              </span>
            </>
          ) : showOnlyFavorites ? (
            <>
              No favourites yet.
              <br /><br />
              <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                Tap the heart on any album page to add it here.
              </span>
            </>
          ) : (
            <>
              No albums in library yet.
              <br /><br />
              <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                Add music to <code>/mnt/dietpi_userdata/4tb</code> and tap Rescan in the side menu.
              </span>
            </>
          )}
        </div>
      ) : (
        <div style={s.gridArea}>
          <div className="album-grid">
            {albums.map(album => (
              <AlbumCard
                key={album.id}
                album={album}
                selecting={selection.selecting}
                selected={selection.selected.has(album.id)}
                selectionIndex={selection.indexOf(album.id)}
                onClick={() => {
                  // While selecting, a tap picks rather than opens. Same tap
                  // target, so there is nothing new to learn and nothing to
                  // aim at.
                  if (selection.selecting) { selection.toggle(album.id); return }
                  // v1.1.1.2 diagnostic — logs every album tap so we
                  // can see in the browser console whether the
                  // handler fires.
                  console.log('[album-tap]', album.id, album.title)
                  // v1.1.1.4 — also relay to the SERVER log so we
                  // can diagnose remotely on phones/tablets where
                  // the browser console isn't accessible. This is
                  // fire-and-forget — never blocks the tap action.
                  try {
                    fetch('/api/debug/client-log', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        tag: 'album-tap',
                        message: `tapped album id=${album.id}`,
                        data: {
                          title: album.title,
                          selectedBefore: useStore.getState().selectedAlbumId,
                        }
                      })
                    }).catch(() => {})
                  } catch {}
                  // Defensive: call selectAlbum (which is either the
                  // parent-provided callback or the store setter
                  // fallback) AND directly call setSelectedAlbum
                  // from the store. Belt-and-braces — covers the
                  // case where onAlbumSelect was somehow stale.
                  // A double-set with the same value is a no-op
                  // in zustand.
                  try { selectAlbum(album.id) } catch (e) {
                    console.warn('[album-tap] selectAlbum threw:', e)
                    fetch('/api/debug/client-log', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ tag: 'album-tap', message: 'selectAlbum threw', data: { error: String(e) }})
                    }).catch(() => {})
                  }
                  try { setSelectedAlbum(album.id) } catch (e) {
                    console.warn('[album-tap] setSelectedAlbum threw:', e)
                    fetch('/api/debug/client-log', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ tag: 'album-tap', message: 'setSelectedAlbum threw', data: { error: String(e) }})
                    }).catch(() => {})
                  }
                  // v1.1.1.4 — log the resulting state so we can see
                  // whether the store actually updated. Tiny delay
                  // because zustand state updates are scheduled, not
                  // synchronous from the action's POV.
                  setTimeout(() => {
                    fetch('/api/debug/client-log', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        tag: 'album-tap',
                        message: 'post-set state',
                        data: { selectedAlbumId: useStore.getState().selectedAlbumId }
                      })
                    }).catch(() => {})
                  }, 100)
                }}
              />
            ))}
          </div>
          <div ref={sentinelRef} style={{ height: 20 }} />
          {loadingMore && (
            <div style={s.loadMore}><div style={s.spinnerSm} /></div>
          )}
        </div>
      )}
    </div>
  )
}

function FirstScanProgress({ status }) {
  const { phase, processedFiles, totalFiles, artProcessed, artTotal, isFirstScan } = status
  const phases = [
    { id: 'walking', label: 'Looking for files' },
    { id: 'loading_existing', label: 'Reading database' },
    { id: 'scanning', label: 'Reading metadata' },
    { id: 'rebuilding_stats', label: 'Building album stats' },
    { id: 'enriching_art', label: 'Fetching cover art' },
  ]
  const idx = phases.findIndex(p => p.id === phase)

  let detail = ''
  let pct = null
  if (phase === 'scanning' && totalFiles > 0) {
    pct = (processedFiles / totalFiles) * 100
    detail = `${processedFiles.toLocaleString()} of ${totalFiles.toLocaleString()} files`
  } else if (phase === 'enriching_art' && artTotal > 0) {
    pct = (artProcessed / artTotal) * 100
    detail = `${artProcessed} of ${artTotal} albums`
  }

  return (
    <div style={fs.wrap}>
      <div style={fs.card}>
        <div style={fs.title}>{isFirstScan ? 'Building your library' : 'Updating your library'}</div>
        <div style={fs.subtitle}>
          {isFirstScan
            ? "This is a one-time setup. Albums will appear here as they're scanned."
            : "Albums will refresh as new files are read."}
        </div>

        <div style={fs.steps}>
          {phases.map((p, i) => {
            const done = i < idx
            const active = i === idx
            return (
              <div key={p.id} style={fs.step}>
                <div style={{ ...fs.stepDot, ...(done ? fs.stepDone : active ? fs.stepActive : {}) }}>
                  {done ? '✓' : active ? '•' : ''}
                </div>
                <div style={{ ...fs.stepLabel, ...(active ? fs.stepLabelActive : {}) }}>
                  {p.label}
                </div>
              </div>
            )
          })}
        </div>

        {detail && (
          <div style={fs.detailBlock}>
            <div style={fs.detailText}>{detail}</div>
            {pct !== null && (
              <div style={fs.progressTrack}>
                <div style={{ ...fs.progressFill, width: `${pct}%` }} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// v1.1.34.0 — the wall's tile is now the shared one in AlbumTile.jsx,
// used by the artist page and the Qobuz / Tidal screens too. There were
// three copies of this component and they drifted: the streaming glyph
// added in v1.1.33.0 never reached the artist page, and the service
// screens grew an optional quality line that made their tiles taller
// than everyone else's. One component, one height, everywhere.
function AlbumCard({ album, onClick, selecting = false, selected = false, selectionIndex }) {
  return (
    <AlbumTile
      album={album}
      onClick={onClick}
      selecting={selecting}
      selected={selected}
      // Forwarded, not swallowed: this wrapper drops anything it does not
      // name, and a numbered tick that silently became a plain one on the
      // main Albums wall — the one grid people actually merge from — would
      // have been a quiet nothing rather than an error.
      selectionIndex={selectionIndex}
    />
  )
}

const s = {
  // v1.1.0.62 — JPLAY-style page layout. Was 14px 10px with 120px
  // bottom for the now-playing strip; JPLAY uses generous side
  // padding (16px+) so the grid doesn't crowd the edges. Bottom
  // padding kept the same so the now-playing bar overlap behaviour
  // is unchanged.
  // v1.1.0.79 — page no longer has top/bottom padding. Vertical
  // padding moves to .header (top) and .gridArea (bottom) so the
  // sticky header can pin at the top of the scroll container
  // without a 20-pixel gap above it.
  page: { padding: '0 16px', background: 'var(--jp-bg)', minHeight: '100%' },
  // Heading: 24/600 with tight tracking. Was 22/700 with -0.4
  // letterSpacing — fine but reading too "headline-y". The 600
  // weight + slight tightening reads more "shelf label", less
  // "magazine title", which is the JPLAY tone.
  //
  // v1.1.0.79 — header is now sticky-positioned at the top of the
  // scroll container so the heading + sort pills + tag chips
  // remain visible while the album grid scrolls underneath.
  // Solid bg with a subtle bottom border to mask album art that
  // would otherwise scroll through. zIndex above the grid so
  // tag-chip popovers and pill text stay legible. The 16px-side
  // negative margins extend the bg to the page edges (page's own
  // padding only applies horizontally) so we don't show a strip
  // of bg-page around the header when sticky.
  header: {
    position: 'sticky',
    top: 0,
    zIndex: 10,
    marginBottom: 8,
    paddingTop: 12,
    paddingBottom: 8,
    marginLeft: -16,
    marginRight: -16,
    paddingLeft: 16,
    paddingRight: 16,
    background: 'var(--jp-bg)',
    borderBottom: '1px solid var(--jp-border)',
  },
  // v1.1.0.79 — wrapper around the album grid so the bottom
  // padding (was on .page) follows the grid rather than the
  // sticky header.
  gridArea: { paddingTop: 8, paddingBottom: 120 },
  titleRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  heading: { fontSize: 24, fontWeight: 600, letterSpacing: '-0.3px', color: 'var(--jp-text)' },
  statsRow: { fontSize: 12, color: 'var(--jp-text-3)', fontFamily: 'var(--font-mono)' },
  // v1.1.11.0 — the sort sheet. Replaces the old sortRow/sortBtn/sortActive
  // trio (dead since the v1.1.0.62 chip row) and sortChipActive (which styled
  // the three Title/Artist/Year pills this sheet replaced).
  //
  // The chip in the header, carrying the active sort's name and its direction
  // arrow. Always reads as "on" — there is always a sort — so it takes the
  // quiet fill rather than the white active fill the toggle chips use.
  sortChip: {
    color: 'var(--jp-text)',
    borderColor: 'var(--jp-border-hot)',
    fontWeight: 600,
  },
  sortSheet: { display: 'flex', flexDirection: 'column', gap: 2 },
  sortRow: {
    display: 'flex', alignItems: 'center', gap: 10,
    width: '100%', boxSizing: 'border-box',
    padding: '10px 12px',
    borderRadius: 8,
    background: 'transparent',
    border: '1px solid transparent',
    color: 'var(--jp-text-2)',
    textAlign: 'left',
    // Rows are the full width of the sheet and stacked, so a tap anywhere on
    // one is unambiguous; 44px is the minimum comfortable touch target.
    minHeight: 44,
  },
  sortRowOn: {
    background: 'var(--jp-bg-surface)',
    borderColor: 'var(--jp-border-hot)',
    color: 'var(--jp-text)',
  },
  // Fixed-width column so every label starts on the same left edge whether or
  // not its row is the active one.
  sortArrow: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: 16, flexShrink: 0,
  },
  sortText: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
  sortLabel: { fontSize: 14, fontWeight: 600 },
  sortNote: { fontSize: 12, color: 'var(--jp-text-3)' },
  // v1.1.0.62 — JPLAY-style chip row. Was a wrap-flex centred
  // pill row with bordered chips on var(--bg-elevated). JPLAY
  // uses a horizontal scroller pinned to the start, no-border
  // chips with a quiet fill, and white-fill / black-text for the
  // active state. The favourites chip stays heart-red as its
  // dedicated identity colour.
  actionRow: {
    display: 'flex', gap: 8,
    marginTop: 4, marginBottom: 8,
    overflowX: 'auto', overflowY: 'hidden',
    WebkitOverflowScrolling: 'touch',
    scrollbarWidth: 'none',
    paddingBottom: 2,  // room for any focus ring when tab-navigating
  },
  pillRow: {
    display: 'flex', gap: 8,
    marginTop: 4, marginBottom: 8,
    overflowX: 'auto', overflowY: 'hidden',
    WebkitOverflowScrolling: 'touch',
    scrollbarWidth: 'none',
    paddingBottom: 2,
  },
  iconChip: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '7px 13px', borderRadius: 999,
    fontSize: 13, fontWeight: 500,
    color: 'var(--jp-text-2)',
    background: 'rgba(var(--tint-rgb), 0.05)',
    border: '1px solid transparent',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  iconChipActive: {
    color: 'var(--jp-hot)',
    background: 'rgba(255,59,92,0.10)',
    borderColor: 'rgba(255,59,92,0.32)',
  },
  // Active sort chip: white fill, black text. JPLAY's "this filter
  // is on" pattern. Reads as a positive selection state without
  // resorting to chromatic accent.
  iconChipPrimary: {
    color: 'var(--jp-bg)',
    background: 'var(--jp-accent)',
    borderColor: 'var(--jp-accent)',
    fontWeight: 600,
  },
  loadWrap: { display: 'flex', justifyContent: 'center', paddingTop: 60 },
  spinner: { width: 24, height: 24, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' },
  spinnerSm: { width: 18, height: 18, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' },
  loadMore: { display: 'flex', justifyContent: 'center', padding: '16px 0' },
  grid: { /* unused since #30.17 -- replaced by .album-grid CSS class
             which uses media queries to vary column count by viewport.
             Left here as a no-op so any code path that still reads it
             doesn't blow up; safe to delete in a future cleanup. */ },
  card: { display: 'block', background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left', minWidth: 0 },
  tagChip: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '5px 10px',
    fontSize: 13, fontWeight: 500,
    background: 'transparent',
    color: 'var(--jp-text-2)',
    border: '1px solid var(--jp-border)',
    borderRadius: 999,
    cursor: 'pointer',
    flexShrink: 0,
  },
  tagChipActive: {
    background: 'rgba(var(--tint-rgb), 0.10)',
    borderColor: 'var(--jp-border-hot)',
    color: 'var(--jp-text)',
  },
  tagChipCount: {
    fontSize: 12,
    fontFamily: 'var(--font-mono)',
    color: 'var(--jp-text-3)',
    fontWeight: 400,
  },
}

// v1.1.0.71 — same helper as TagPicker. Could live in a shared util
// file but it's three lines and only two callers; not worth the import
// churn yet.
function hexToRgba(hex, alpha) {
  if (!hex || hex.length !== 7) return `rgba(var(--tint-rgb), ${alpha})`
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

const fs = {
  wrap: { padding: '24px 16px', display: 'flex', justifyContent: 'center' },
  card: { width: '100%', maxWidth: 360, padding: '22px 22px 24px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)' },
  title: { fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 },
  subtitle: { fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.45, marginBottom: 18 },
  steps: { display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 14 },
  step: { display: 'flex', alignItems: 'center', gap: 10 },
  stepDot: { width: 18, height: 18, borderRadius: '50%', background: 'var(--bg-overlay)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: 'var(--text-tertiary)', flexShrink: 0 },
  stepActive: { background: 'var(--accent)', borderColor: 'var(--accent)', color: 'var(--on-accent)', animation: 'pulse 1.4s ease-in-out infinite' },
  stepDone: { background: 'rgba(63,208,122,0.15)', borderColor: 'rgba(63,208,122,0.4)', color: '#3fd07a' },
  stepLabel: { fontSize: 13, color: 'var(--text-tertiary)' },
  stepLabelActive: { color: 'var(--text-primary)', fontWeight: 600 },
  detailBlock: { paddingTop: 12, borderTop: '1px solid var(--border)' },
  detailText: { fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', marginBottom: 6 },
  progressTrack: { height: 3, background: 'var(--bg-overlay)', borderRadius: 1.5, overflow: 'hidden' },
  progressFill: { height: '100%', background: 'var(--accent)', transition: 'width 0.4s ease' },
}
