import { create } from 'zustand'
import { api } from '../api'

let positionTimer = null
let wsBackoff = 1000

// v1.1.9.0 — the anchor for playhead interpolation is ALWAYS our own clock.
//
// The server stamps each sample with `positionAt` from ITS wall clock. The
// ticker below computes the playhead as `Date.now() - anchor`, so using the
// server's stamp subtracts one machine's clock from another's and turns any
// skew between them into a permanent offset on the progress bar — a host 40
// seconds off draws a track that has just started at 0:40, while the audio
// plays correctly from zero. Hosts without an RTC drift exactly like this.
//
// Receive time is the correct anchor: the sample describes the renderer's
// position ~now, so the error is one network hop (tens of ms) against a skew
// that is unbounded. `payload.positionAt` must never reach this value —
// there is a test that greps for it, because fixing three of the four sites
// last time left the every-second one clobbering the other three.
const receiveAnchor = () => Date.now()


// applyZonesSnapshot (#v1.1.0.9)
// ------------------------------
// Takes a {focusedZoneId, zones} payload from the server (either from
// /player/state/all or a 'zones' WS message) and updates the store.
//
// Updates two surfaces:
//   1. `zones` map + `focusedZoneId` -- the multi-zone surface read by
//      multi-zone-aware components (mini-player indicators, output sheet
//      with per-zone status).
//   2. The legacy mirror fields (playerStatus, currentTrack, rendererId,
//      volume, queue, queueIndex, position, positionAt, signalPath,
//      radio, outputMode) -- read by single-zone-aware components which
//      will continue to work unchanged.
//
// The mirror is derived from whichever zone is currently focused. When
// focus moves to a different zone (user swipes, or taps a renderer in
// the output sheet), the mirror flips immediately to that zone's state
// without needing components to re-subscribe.
function applyZonesSnapshot(set, get, payload) {
  if (!payload || !payload.zones) return
  const zones = payload.zones
  const focusedId = payload.focusedZoneId || null
  const prev = get()
  const focused = focusedId && zones[focusedId] ? zones[focusedId] : null

  // Drive ticker based on focused zone's status. If no zone is focused
  // (no zones at all yet), nothing is playing as far as the UI is
  // concerned -- stop the ticker.
  if (focused?.status === 'playing') get().startTicker()
  else get().stopTicker()

  const trackChanged = focused?.currentTrack?.id !== prev.currentTrack?.id
  const focusedChanged = focusedId !== prev.focusedZoneId

  // Position handling: when focus changes (zone swap), snap displayPosition
  // to the new zone's anchor immediately so the playhead doesn't visibly
  // jump from old zone's time to new zone's. When the track within the
  // focused zone changes, do the same. Otherwise let the ticker keep
  // smoothing.
  const newPosition = focused ? (focused.position || 0) : 0
  // v1.1.6.0 — anchor on OUR clock at the moment the sample arrives, not on
  // the server's `positionAt`. The ticker below computes the playhead as
  // Date.now() - anchor, so mixing the server's wall clock into that
  // subtraction turns any skew between the two machines into a permanent
  // offset on the progress bar: a host running 40s ahead of the phone shows
  // the track starting at 0:40 while the audio plays from the beginning.
  // Hosts without an RTC (Pi, DietPi) drift exactly like this.
  //
  // Receive time is the right anchor because the sample describes the
  // renderer's position ~now; the error is one network hop (tens of ms),
  // against a skew that is unbounded. The server still sends positionAt and
  // it is still meaningful on the server — we simply do not subtract our
  // clock from it.


  const patch = {
    zones,
    focusedZoneId: focusedId,
  }

  if (focused) {
    patch.playerStatus  = focused.status
    patch.currentTrack  = focused.currentTrack
    patch.rendererId    = focused.rendererId
    patch.volume        = focused.volume
    patch.outputMode    = focused.outputMode || 'variable'
    patch.signalPath    = focused.signalPath || []
    patch.queue         = Array.isArray(focused.queue) ? focused.queue : []
    patch.queueIndex    = focused.queueIndex || 0
    patch.radio         = !!focused.radio
    patch.position      = newPosition
    patch.positionAt    = receiveAnchor()
    if (trackChanged || focusedChanged) {
      patch.displayPosition = newPosition
    }
  } else {
    // No focused zone yet (typical on first boot before any user action,
    // or after server restart with no persisted zones). Don't clobber
    // the legacy mirror fields -- the user may have a localStorage-
    // hydrated rendererId or a previously focused renderer still
    // visible in the UI; nuking those to null would misleadingly tell
    // downstream actions "no renderer is selected" and break
    // playRandomAlbum / playQueue / etc. (#v1.1.0.12)
    //
    // Mark the player as stopped (status / queue / track empty) but
    // leave rendererId / volume / outputMode alone for the existing
    // selection. When the user actually plays something, the server
    // will create the zone and broadcast back, populating these
    // fields properly.
    patch.playerStatus    = 'stopped'
    patch.currentTrack    = null
    patch.queue           = []
    patch.queueIndex      = 0
    patch.signalPath      = []
    patch.position        = 0
    patch.positionAt      = Date.now()
    patch.displayPosition = 0
  }

  set(patch)
}

// Position model
// --------------
// The server polls renderers ~once per second and broadcasts `position`
// (seconds into the track, as reported by the device). We re-anchor on the
// CLIENT's clock as each sample arrives — see applyZones — because the two
// machines' wall clocks are not synchronised and the difference would show
// up as a fixed offset on the playhead. We treat (position,
// positionAt) as an anchor and compute the displayed playhead while playing as
//
//   displayed = anchorPosition + (Date.now() - anchorAt) / 1000
//
// — clamped to the track duration. This keeps the bar following the renderer's
// real position regardless of network jitter, instead of letting a local +1/s
// ticker drift ahead and then snap back when a poll arrives.
//
// The `position` field exposed to components is the most recent anchor; the
// ticker re-derives the visible playhead from that anchor every 250 ms.

export const useStore = create((set, get) => ({
  playerStatus: 'stopped',
  currentTrack: null,
  queue: [],
  queueIndex: 0,
  rendererId: null,
  volume: 80,
  // Output mode for the active renderer (#v1.1.0.8). Server-derived;
  // 'fixed' means the volume slider should be hidden because the
  // downstream amp owns the volume.
  outputMode: 'variable',
  signalPath: [],
  position: 0,
  // Wall-clock ms (Date.now()) when `position` was sampled from the renderer.
  // Defaults to a recent value so the very first frame doesn't run away.
  positionAt: Date.now(),
  // Visually-displayed playhead, recomputed from (position, positionAt) by the
  // ticker. Components that just want to show progress should read this.
  displayPosition: 0,
  // MusicD Radio mode (#14) — when on, the server keeps the queue topped up.
  radio: false,
  // v1.1.14.0 — track ids the zone moved past without finishing, so the queue
  // view can fold them into one "N skipped" row. Ids, not indices: the server
  // keys them that way so they survive every reorder and removal.
  //
  // This arrives on the SAME four paths `radio` does — the zones snapshot, the
  // REST hydration, the single-zone REST fallback and the `state` message. Miss
  // one and the fold silently stops working on whichever route that was, which
  // is precisely how the progress-bar anchor shipped broken twice.
  // test/queue-skipped.test.js greps for every site.
  skipped: [],

  // Multi-zone state (#v1.1.0.9).
  // ----------------------------
  // `zones` is a map of zoneId -> public state (queue, position, status,
  // volume, outputMode, etc) for EVERY zone the server knows about.
  // `focusedZoneId` is the zone the UI is currently showing in the
  // mini-player and now-playing screens.
  //
  // The legacy fields above (playerStatus, currentTrack, rendererId, ...)
  // remain populated as a *mirror* of the focused zone. Existing
  // components keep working without modification; multi-zone-aware
  // components can read `zones` directly to render indicator pips,
  // multi-zone sheets, etc.
  zones: {},
  focusedZoneId: null,

  // UI
  selectedAlbumId: null,
  showSignalPath: false,
  showRenderers: false,
  renderers: [],
  searchQuery: '',
  sidebarSection: 'home',
  // Settings sub-section navigation (#30.26). When non-null, the
  // Settings screen shows that section as a full-screen sub-page;
  // tapping the topbar chevron clears it back to the section list.
  // Stored in the global store rather than locally so App.jsx's
  // goBack/canGoBack handlers can react to it -- the back chevron
  // on a Settings sub-page semantically means "back to Settings",
  // and it has to live in App because that's where the topbar is.
  settingsSubSection: null,
  serverVersion: null,

  // v1.1.33.0 — Qobuz / Tidal sign-in state.
  //
  // Three unrelated bits of UI read this and none of them should be
  // making their own request for it: the side menu (whether to show the
  // Qobuz and Tidal rows below Genres), the album page (whether to draw
  // the circled plus), and Settings → Services. Kept in the store so one
  // fetch serves all three and a sign-in updates them together.
  //
  // Shape is the /api/streaming/status response:
  //   { qobuz: { logged_in, user, sync, ... }, tidal: { ... } }
  // Starts empty rather than with a guessed default: "not signed in" and
  // "not asked yet" look the same to a component that only reads
  // logged_in, and the side menu drawing a Qobuz row for a moment before
  // removing it is worse than drawing it a moment late.
  streamingServices: {},
  streamingChecked: false,

  setPlayerState: (s) => set(s),
  setSelectedAlbum: (id) => set({ selectedAlbumId: id }),
  setShowSignalPath: (v) => set({ showSignalPath: v }),
  setShowRenderers: (v) => set({ showRenderers: v }),
  setRenderers: (r) => set({ renderers: r }),
  setSearchQuery: (q) => set({ searchQuery: q }),
  setSidebarSection: (s) => set({ sidebarSection: s }),
  setSettingsSubSection: (s) => set({ settingsSubSection: s }),
  setStreamingServices: (s) => set({ streamingServices: s || {}, streamingChecked: true }),

  // Re-read sign-in state. Called on boot, after a sign-in or sign-out,
  // and when a favourites sync finishes.
  refreshStreamingServices: async () => {
    try {
      const r = await api.get('/streaming/status')
      set({ streamingServices: r || {}, streamingChecked: true })
    } catch (e) {
      // A demo-tier install gets 403 here and an offline one gets a
      // network error. Both mean "no streaming services", which is the
      // same thing the empty default says — so mark it checked and keep
      // whatever we last knew rather than blanking a working side menu
      // on one failed poll.
      set({ streamingChecked: true })
    }
  },

  // True when either service is signed in. The side menu and the album
  // page both branch on this.
  hasStreamingService: () => {
    const svc = get().streamingServices || {}
    return Object.values(svc).some(s => s && s.logged_in)
  },
  setRendererId: (id) => set({ rendererId: id }),

  // Focus a zone (#v1.1.0.9). Brings that zone's state into the legacy
  // mirror fields (mini-player, now-playing) without touching any other
  // zone -- they keep playing/paused as they were. Server-side this
  // calls /player/switch-renderer which is now non-destructive (in
  // earlier versions it moved the queue, in v1.1.0.9 it just shifts
  // focus). Optimistic: we flip focus locally first so the UI is snappy,
  // then sync with the server which broadcasts back the canonical
  // state via 'zones'.
  focusZone: async (rendererId) => {
    const prev = get()
    const z = prev.zones[rendererId]
    // Local optimistic mirror update so the UI doesn't lag behind the
    // network round-trip. The follow-up 'zones' broadcast confirms.
    //
    // We ALWAYS set the legacy `rendererId` field, even when the zone
    // doesn't exist in our map yet (#v1.1.0.12). Without this, tapping
    // a never-used renderer in the Output sheet would correctly set
    // focusedZoneId but leave the legacy `rendererId` field at null --
    // and downstream actions like Play / Random Album / playQueue read
    // the legacy field, so they'd think "no renderer selected" and
    // refuse to act.
    if (z) {
      set({
        focusedZoneId: rendererId,
        playerStatus:  z.status,
        currentTrack:  z.currentTrack,
        rendererId:    z.rendererId || rendererId,
        volume:        z.volume,
        outputMode:    z.outputMode || 'variable',
        signalPath:    z.signalPath || [],
        queue:         Array.isArray(z.queue) ? z.queue : [],
        queueIndex:    z.queueIndex || 0,
        radio:         !!z.radio,
        skipped:       Array.isArray(z.skipped) ? z.skipped : [],
        position:      z.position || 0,
        positionAt:    receiveAnchor(),
        displayPosition: z.position || 0,
      })
      if (z.status === 'playing') get().startTicker()
      else get().stopTicker()
    } else {
      // Zone didn't exist in our map yet -- the server will create it
      // and broadcast back. Set rendererId so downstream actions (Play,
      // Random Album, etc) work immediately rather than waiting for
      // the zone broadcast to round-trip back.
      set({ focusedZoneId: rendererId, rendererId: rendererId })
    }
    try {
      await api.post('/player/switch-renderer', { rendererId })
    } catch (e) {
      console.warn('focusZone server call failed:', e)
    }
  },

  // Move the queue from one zone to another (#v1.1.0.9). Server-side
  // the source zone stops and clears, the destination zone picks up at
  // the same queue position and starts playing. Used by the "Move
  // queue to..." button in the queue screen.
  moveQueueToZone: async (fromRendererId, toRendererId) => {
    try {
      await api.post('/player/queue/move', { fromRendererId, toRendererId })
    } catch (e) {
      console.warn('moveQueueToZone failed:', e)
    }
  },

  // Library scan / enrichment status
  libraryStatus: { phase: 'idle', totalFiles: 0, processedFiles: 0, added: 0, updated: 0, skipped: 0, artTotal: 0, artProcessed: 0, isFirstScan: false, message: '' },

  startTicker: () => {
    if (positionTimer) return
    // 250 ms cadence is smooth on a progress bar without burning battery; the
    // computation is just a delta from the anchor so it's cheap.
    positionTimer = setInterval(() => {
      const { playerStatus, position, positionAt, currentTrack, displayPosition } = get()
      const dur = currentTrack?.duration || 0
      let next
      if (playerStatus === 'playing') {
        const elapsedSec = Math.max(0, (Date.now() - positionAt) / 1000)
        next = position + elapsedSec
        if (dur > 0) next = Math.min(next, dur)
      } else {
        // While paused/stopped, the displayed position shouldn't advance. Keep
        // it at the most recent anchor exactly — no inter-poll math.
        next = position
      }
      // Avoid pointless re-renders: only set if we've moved by more than
      // ~50 ms. React's bail-out on equal primitive values handles the rest.
      if (Math.abs(next - displayPosition) > 0.05) {
        set({ displayPosition: next })
      }
    }, 250)
  },

  stopTicker: () => {
    if (positionTimer) { clearInterval(positionTimer); positionTimer = null }
  },

  // Append to local view AND tell server (server owns the canonical queue now)
  appendToQueue: async (tracks) => {
    const { queue } = get()
    set({ queue: [...queue, ...tracks] })
    try { await api.post('/player/queue', { trackIds: tracks.map(t => t.id) }) } catch {}
  },

  // v1.1.0.56 — insert tracks immediately after the currently-playing
  // one. Used by the Album page Play [▾] dropdown's "Play Next". The
  // server endpoint /player/queue/insert-next handles the index math
  // and clears any pre-queued gapless next-stream so the new track
  // wins.
  insertNextInQueue: async (tracks) => {
    if (!Array.isArray(tracks) || tracks.length === 0) return
    const { queue, queueIndex } = get()
    // Local optimistic insert at queueIndex+1
    const insertAt = queueIndex + 1
    const next = queue.slice()
    next.splice(insertAt, 0, ...tracks)
    set({ queue: next })
    try {
      await api.post('/player/queue/insert-next', {
        trackIds: tracks.map(t => t.id),
      })
    } catch {}
  },

  // v1.1.0.56 — shuffle the supplied tracks (Fisher-Yates) and play.
  // Used by Album page Play [▾] dropdown's "Shuffle". Doesn't touch
  // the server-side shuffle flag — this is a one-shot "play these in
  // a random order" rather than the global shuffle toggle.
  shufflePlay: async (tracks) => {
    if (!Array.isArray(tracks) || tracks.length === 0) return
    const shuffled = tracks.slice()
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
    }
    await get().playQueue(shuffled, 0)
  },

  // Sends the FULL queue to the server so server can auto-advance
  playQueue: async (tracks, index = 0) => {
    const { rendererId } = get()
    if (!rendererId || !tracks.length) return
    const track = tracks[index]
    set({
      queue: tracks, queueIndex: index,
      playerStatus: 'loading',
      position: 0, positionAt: Date.now(), displayPosition: 0,
      currentTrack: track,
    })
    try {
      await api.post('/player/play', {
        trackId: track.id,
        rendererId,
        queue: tracks.map(t => t.id),
        queueIndex: index,
      })
    } catch (e) {
      set({ playerStatus: 'stopped' })
    }
  },

  // Server-side skip — survives client sleep
  playNext: async () => {
    set({ playerStatus: 'loading', position: 0, positionAt: Date.now(), displayPosition: 0 })
    try { await api.post('/player/next') } catch {}
  },

  playPrev: async () => {
    set({ playerStatus: 'loading', position: 0, positionAt: Date.now(), displayPosition: 0 })
    try { await api.post('/player/prev') } catch {}
  },

  // Reorder the active queue without restarting playback (#21/#22).
  // Optimistic: we mutate local state immediately so the drag feels snappy,
  // then send to the server. Server broadcast will reconcile any drift.
  //
  // The index math below MUST match server/src/playerState.js's
  // reorderQueue() — the server's broadcast lands a moment later and any
  // mismatch shows as a visible jump in the queue UI. If you change one
  // side, change the other.
  reorderQueue: async (from, to) => {
    const { queue, queueIndex } = get()
    if (from === to || from < 0 || from >= queue.length || to < 0 || to >= queue.length) return
    // Mirror the server's index math so the visible state matches what the
    // server will compute. See playerState.reorderQueue() for the rules.
    let newIdx = queueIndex
    if (from === queueIndex) newIdx = to
    else if (from < queueIndex && to >= queueIndex) newIdx -= 1
    else if (from > queueIndex && to <= queueIndex) newIdx += 1
    const next = queue.slice()
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    set({ queue: next, queueIndex: newIdx })
    try { await api.post('/player/queue/reorder', { from, to }) } catch {}
  },

  // v1.1.24.0 — move a whole selection to just after the currently-playing
  // track. Backs "Play next" on the queue screen's multi-select, and "Play
  // now" via moveSelectionNext() followed by playNext().
  //
  // The index math below MUST match server/src/playerState.js's
  // moveSelectionNext() — the server's broadcast lands a moment later and any
  // mismatch shows as a visible jump in the queue UI. If you change one side,
  // change the other. Same standing rule as reorderQueue above, and the same
  // three sanitising steps in the same order: dedupe, drop the playing track,
  // sort ascending so the moved block keeps the queue's own order.
  moveSelectionNext: async (indices) => {
    const { queue, queueIndex } = get()
    if (!Array.isArray(indices) || indices.length === 0) return
    const picked = [...new Set(indices.map(i => parseInt(i, 10)))]
      .filter(i => Number.isFinite(i) && i >= 0 && i < queue.length && i !== queueIndex)
      .sort((a, b) => a - b)
    if (picked.length === 0) return
    const pickedSet = new Set(picked)
    const moved = picked.map(i => queue[i])
    const rest = queue.filter((_, i) => !pickedSet.has(i))
    // Only the entries BEFORE the playing track shift it. The playing track is
    // never in `picked`, so it is always still in `rest`.
    const removedBefore = picked.filter(i => i < queueIndex).length
    const newIdx = queueIndex - removedBefore
    rest.splice(newIdx + 1, 0, ...moved)
    set({ queue: rest, queueIndex: newIdx })
    try { await api.post('/player/queue/move-next', { indices: picked }) } catch {}
  },

  // Remove a single track from the queue (cannot remove the currently-playing one).
  removeFromQueue: async (index) => {
    const { queue, queueIndex } = get()
    if (index < 0 || index >= queue.length || index === queueIndex) return
    const next = queue.slice()
    next.splice(index, 1)
    const newIdx = index < queueIndex ? queueIndex - 1 : queueIndex
    set({ queue: next, queueIndex: newIdx })
    try { await api.post('/player/queue/remove', { index }) } catch {}
  },

  // v1.1.0.55 — batch-remove. Optimistic update mirrors the server
  // logic: drop everything except the current track. Falls back to a
  // server-side confirm via the response so a partial failure
  // (network blip) doesn't leave us in a divergent state.
  removeFromQueueBatch: async (indices) => {
    const { queue, queueIndex } = get()
    if (!Array.isArray(indices) || indices.length === 0) return
    // Filter out current and dedupe; sort descending to avoid shift.
    const valid = [...new Set(
      indices
        .map(i => parseInt(i, 10))
        .filter(i => Number.isFinite(i) && i >= 0 && i < queue.length && i !== queueIndex)
    )].sort((a, b) => b - a)
    if (valid.length === 0) return
    const nextQueue = queue.slice()
    let shift = 0
    for (const i of valid) {
      nextQueue.splice(i, 1)
      if (i < queueIndex) shift += 1
    }
    set({ queue: nextQueue, queueIndex: queueIndex - shift })
    try {
      await api.post('/player/queue/remove-batch', { indices: valid })
    } catch {}
  },

  // v1.1.0.55 — append track IDs to the end of the queue. Used by
  // bulk queue-add operations (Add all / Add played / etc) where we
  // already know the track IDs but not full metadata client-side.
  // v1.1.0.56: renamed from appendToQueue → appendIdsToQueue to avoid
  // colliding with the older album-page appendToQueue (which takes
  // full track objects). The collision silently broke Album → Add
  // Queue between v55 and v56.
  appendIdsToQueue: async (trackIds) => {
    if (!Array.isArray(trackIds) || trackIds.length === 0) return
    const { queue } = get()
    // Local optimistic append — track objects with just id, since we
    // don't have full metadata client-side. The websocket broadcast
    // will replace these with hydrated copies in a moment.
    const stubs = trackIds.map(id => ({ id }))
    set({ queue: [...queue, ...stubs] })
    try {
      await api.post('/player/queue/append', { trackIds })
    } catch {}
  },

  // v1.1.0.58 — track-level favourite. Pure server call; the album
  // detail screen tracks its own copy of `is_favorite` per row, so
  // we don't mirror state here. Returns the new value via the server
  // response so the caller can confirm.
  setTrackFavorite: async (trackId, value) => {
    if (!trackId) return null
    try {
      const r = await api.post(
        `/library/tracks/${encodeURIComponent(trackId)}/favorite`,
        { value: !!value }
      )
      return r?.is_favorite
    } catch (e) {
      console.warn('setTrackFavorite failed:', e)
      return null
    }
  },

  // v1.1.0.58 — track-level user rating, 0-5 stars (0 = unrated).
  // Server clamps the value; we still clamp here so the optimistic
  // UI doesn't show 7 stars for a tick.
  setTrackRating: async (trackId, rating) => {
    if (!trackId) return null
    let r = parseInt(rating, 10)
    if (!Number.isFinite(r)) return null
    if (r < 0) r = 0
    if (r > 5) r = 5
    try {
      const resp = await api.post(
        `/library/tracks/${encodeURIComponent(trackId)}/rating`,
        { rating: r }
      )
      return resp?.user_rating
    } catch (e) {
      console.warn('setTrackRating failed:', e)
      return null
    }
  },

  // v1.1.0.67 — Save for later. Mirrors the favourite toggles. Server
  // clamps to 0/1 booleans; returns the new value so the caller can
  // confirm. Each entity has its own column on its own table — they
  // are not linked.
  setAlbumSavedForLater: async (albumId, value) => {
    if (!albumId) return null
    try {
      const r = await api.post(
        `/library/albums/${encodeURIComponent(albumId)}/save-for-later`,
        { value: !!value }
      )
      return r?.is_saved_for_later
    } catch (e) {
      console.warn('setAlbumSavedForLater failed:', e)
      return null
    }
  },
  setTrackSavedForLater: async (trackId, value) => {
    if (!trackId) return null
    try {
      const r = await api.post(
        `/library/tracks/${encodeURIComponent(trackId)}/save-for-later`,
        { value: !!value }
      )
      return r?.is_saved_for_later
    } catch (e) {
      console.warn('setTrackSavedForLater failed:', e)
      return null
    }
  },

  // v1.1.0.67 — Tags. Three groups of API:
  //   - Tag CRUD (list / create / rename / delete)
  //   - Per-entity assignment (get / set the full tag list)
  //   - Per-entity convenience helpers (toggle a single tag on/off)
  // All return null on failure so the UI can fall back without a
  // throw. Errors are logged for debugging.
  loadTags: async () => {
    try {
      return await api.get('/tags')
    } catch (e) {
      console.warn('loadTags failed:', e)
      return []
    }
  },
  createTag: async (name, color = null) => {
    if (!name?.trim()) return null
    try {
      return await api.post('/tags', { name: name.trim(), color })
    } catch (e) {
      // 409 is "tag already exists" — surface to the caller so they
      // can decide whether to use the existing one. We unwrap the
      // server's body { error, id } if available.
      console.warn('createTag failed:', e)
      return { _error: e?.message || 'Failed to create tag', _status: e?.status || null }
    }
  },
  deleteTag: async (id) => {
    try {
      await api.del(`/tags/${id}`)
      return true
    } catch (e) {
      console.warn('deleteTag failed:', e)
      return false
    }
  },
  // Get the current tag list for a given album/track. Returns array
  // of {id, name, color} or [] if anything goes wrong.
  getAlbumTags: async (albumId) => {
    if (!albumId) return []
    try { return await api.get(`/library/albums/${encodeURIComponent(albumId)}/tags`) }
    catch (e) { console.warn('getAlbumTags failed:', e); return [] }
  },
  getTrackTags: async (trackId) => {
    if (!trackId) return []
    try { return await api.get(`/library/tracks/${encodeURIComponent(trackId)}/tags`) }
    catch (e) { console.warn('getTrackTags failed:', e); return [] }
  },
  // Set the full tag list for an album/track. The server diffs
  // against current state and adds/removes as needed. Returns the
  // new full list on success (so the UI can sync) or null on failure.
  setAlbumTags: async (albumId, tagIds) => {
    if (!albumId) return null
    try {
      return await api.put(`/library/albums/${encodeURIComponent(albumId)}/tags`, { tag_ids: tagIds })
    } catch (e) {
      console.warn('setAlbumTags failed:', e)
      return null
    }
  },
  setTrackTags: async (trackId, tagIds) => {
    if (!trackId) return null
    try {
      return await api.put(`/library/tracks/${encodeURIComponent(trackId)}/tags`, { tag_ids: tagIds })
    } catch (e) {
      console.warn('setTrackTags failed:', e)
      return null
    }
  },

  // ── Playlists (v1.1.19.0) ─────────────────────────────────────────
  //
  // Same shape as the tag actions above: every one swallows its error, logs
  // it, and returns a value the caller can branch on without a try/catch at
  // every call site. A failed "add to playlist" must not take a menu down.
  loadPlaylists: async () => {
    try {
      const r = await api.get('/playlists')
      return Array.isArray(r?.playlists) ? r.playlists : []
    } catch (e) { console.warn('loadPlaylists failed:', e); return [] }
  },
  getPlaylist: async (id) => {
    if (!id) return null
    try { return await api.get(`/playlists/${encodeURIComponent(id)}`) }
    catch (e) { console.warn('getPlaylist failed:', e); return null }
  },
  // `trackIds` is optional — passing it creates and fills in one round trip,
  // which is what "New playlist" from the add sheet needs.
  createPlaylist: async (name, trackIds = []) => {
    if (!name?.trim()) return null
    try {
      const r = await api.post('/playlists', { name: name.trim(), trackIds })
      return r?.playlist || null
    } catch (e) { console.warn('createPlaylist failed:', e); return null }
  },
  renamePlaylist: async (id, name) => {
    if (!id || !name?.trim()) return false
    try { await api.patch(`/playlists/${encodeURIComponent(id)}`, { name: name.trim() }); return true }
    catch (e) { console.warn('renamePlaylist failed:', e); return false }
  },
  deletePlaylist: async (id) => {
    if (!id) return false
    try { await api.del(`/playlists/${encodeURIComponent(id)}`); return true }
    catch (e) { console.warn('deletePlaylist failed:', e); return false }
  },
  // Returns { added, requested } so the caller can tell "added 3" from
  // "all 3 were already in it" — both are successes, and saying which is the
  // difference between useful feedback and a shrug.
  addToPlaylist: async (id, trackIds) => {
    const ids = Array.isArray(trackIds) ? trackIds : [trackIds]
    if (!id || ids.length === 0) return null
    try { return await api.post(`/playlists/${encodeURIComponent(id)}/tracks`, { trackIds: ids }) }
    catch (e) { console.warn('addToPlaylist failed:', e); return null }
  },
  removeFromPlaylist: async (id, trackId) => {
    if (!id || !trackId) return false
    try {
      await api.del(`/playlists/${encodeURIComponent(id)}/tracks/${encodeURIComponent(trackId)}`)
      return true
    } catch (e) { console.warn('removeFromPlaylist failed:', e); return false }
  },
  // Which playlists already hold this track, so the add sheet can tick them
  // rather than offering an action that would do nothing.
  playlistsForTrack: async (trackId) => {
    if (!trackId) return []
    try {
      const r = await api.get(`/playlists/for-track/${encodeURIComponent(trackId)}`)
      return Array.isArray(r?.playlistIds) ? r.playlistIds : []
    } catch (e) { console.warn('playlistsForTrack failed:', e); return [] }
  },

  // Save-for-later on a single track (v1.1.19.0). The album equivalent has
  // been wired since v1.1.0.67; the track menu's row was left disabled even
  // though the route it needed already existed.
  toggleTrackSaved: async (trackId, value) => {
    if (!trackId) return null
    try {
      const body = (typeof value === 'boolean') ? { value } : {}
      const r = await api.post(`/library/tracks/${encodeURIComponent(trackId)}/save-for-later`, body)
      return !!r?.is_saved_for_later
    } catch (e) { console.warn('toggleTrackSaved failed:', e); return null }
  },

  // MusicD Radio toggle (#14). Persisted server-side; we mirror the value here
  // for the UI but the canonical state comes back via WebSocket on the next
  // full-state broadcast.
  setRadio: async (enabled) => {
    set({ radio: !!enabled })
    try { await api.post('/player/radio', { enabled: !!enabled }) } catch {
      // Roll back on failure
      set({ radio: !enabled })
    }
  },

  initWebSocket: () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    let ws
    try { ws = new WebSocket(`${proto}://${location.host}`) }
    catch { setTimeout(() => get().initWebSocket(), wsBackoff); return }

    ws.onopen = () => {
      wsBackoff = 1000
      // On (re)connect, request fresh multi-zone state. Older servers
      // (pre-v1.1.0.9) don't have /state/all so we fall back to the
      // single-zone /state. Either way the legacy mirror fields end up
      // populated. (#v1.1.0.9)
      api.get('/player/state/all').then(snap => {
        applyZonesSnapshot(set, get, snap)
      }).catch(() => {
        // Pre-v1.1.0.9 server, fall back to single-zone state.
        api.get('/player/state').then(s => {
          set({
            playerStatus: s.status,
            currentTrack: s.currentTrack,
            rendererId: s.rendererId,
            volume: s.volume,
            outputMode: s.outputMode || 'variable',
            signalPath: s.signalPath || [],
            position: s.position || 0,
            positionAt: receiveAnchor(),
            displayPosition: s.position || 0,
            radio: !!s.radio,
            skipped: Array.isArray(s.skipped) ? s.skipped : [],
            queue: Array.isArray(s.queue) ? s.queue : [],
            queueIndex: s.queueIndex || 0,
          })
          if (s.status === 'playing') get().startTicker()
          else get().stopTicker()
        }).catch(() => {})
      })
      // Also fetch current library scan/enrichment status
      api.get('/library/status').then(st => set({ libraryStatus: st })).catch(() => {})
    }

    ws.onmessage = (evt) => {
      try {
        const { type, payload } = JSON.parse(evt.data)
        // Multi-zone broadcast (#v1.1.0.9). Servers that emit this also
        // emit the legacy 'state' message; we prefer 'zones' but accept
        // either gracefully.
        if (type === 'zones') {
          applyZonesSnapshot(set, get, payload)
        }
        if (type === 'state') {
          // Only used as a fallback when 'zones' isn't being emitted
          // (pre-v1.1.0.9 server). If the focused zone is already set
          // by a recent 'zones' message we ignore this, because the
          // 'zones' message is the canonical source.
          const prev = get()
          if (prev.zones && Object.keys(prev.zones).length > 0) {
            // Already on a multi-zone server. The 'state' message is
            // redundant -- skip to avoid double-application.
            return
          }
          if (payload.status === 'playing') get().startTicker()
          else get().stopTicker()
          const trackChanged = payload.currentTrack?.id !== prev.currentTrack?.id
          const incomingPos = (payload.position != null) ? payload.position : (trackChanged ? 0 : prev.position)
          set({
            playerStatus: payload.status,
            currentTrack: payload.currentTrack,
            rendererId: payload.rendererId,
            volume: payload.volume,
            outputMode: payload.outputMode || 'variable',
            signalPath: payload.signalPath || [],
            position: incomingPos,
            positionAt: receiveAnchor(),
            radio: !!payload.radio,
            skipped: Array.isArray(payload.skipped) ? payload.skipped : [],
            ...(Array.isArray(payload.queue) ? { queue: payload.queue, queueIndex: payload.queueIndex || 0 } : {}),
            ...(trackChanged ? { displayPosition: incomingPos } : {}),
          })
        }
        if (type === 'position') {
          // Re-anchor on every server poll; the ticker handles smooth interp.
          // For multi-zone, only update the legacy mirror fields if this
          // position is for the focused zone -- but also patch the per-zone
          // state so a switched zone shows the right position immediately.
          const prev = get()
          if (payload.zoneId && prev.zones[payload.zoneId]) {
            const updatedZones = {
              ...prev.zones,
              [payload.zoneId]: {
                ...prev.zones[payload.zoneId],
                position: payload.position,
                positionAt: receiveAnchor(),
              },
            }
            const patch = { zones: updatedZones }
            if (payload.zoneId === prev.focusedZoneId) {
              patch.position = payload.position
              patch.positionAt = receiveAnchor()
            }
            set(patch)
          } else {
            // Legacy: pre-multi-zone server, just update the mirror.
            set({
              position: payload.position,
              positionAt: receiveAnchor(),
            })
          }
        }
        if (type === 'renderers_updated') set({ renderers: payload })
        if (type === 'library_status') set({ libraryStatus: payload })
      } catch {}
    }

    ws.onclose = () => {
      const next = Math.min(wsBackoff * 2, 30000)
      setTimeout(() => get().initWebSocket(), wsBackoff)
      wsBackoff = next
    }
    ws.onerror = () => { try { ws.close() } catch {} }
  },
}))
