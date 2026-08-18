// v1.1.0.80 — Roon-style Focus filter system.
//
// Components:
//   - FocusPills    : the active-filter pills row above the album grid
//   - FocusBar      : the collapsible columns bar with sub-section pickers
//   - FocusColumn   : a single sub-section column (title + tickable list)
//   - useFocusState : hook centralising the focus picks state
//
// Per-spec layout (top to bottom on the album page):
//   [ existing top pill bar (sort/heart/funnel/tags) ]   ← v79 sticky
//   [ active-focus pills row when picks > 0 ]            ← always sticky when present
//   [ focus bar when open ]                              ← sticky, height ≈ album cover
//   [ album grid scrolls ]
//
// Pill semantics: each pick is a pill `+ Label X`. Tap `+` toggles to
// `-` (red, exclude). Tap `X` removes the pill. Closing the bar
// preserves pills.
//
// Filter logic: AND across sub-sections, OR within a sub-section
// (multi-tick). Excludes are AND NOT.

import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { Plus, Minus, X, Search } from 'lucide-react'
// v1.1.1.4 — was `import api from '../api'` (default import). api.js
// has only named exports, so api would be undefined at runtime and any
// api.get() call would throw silently in this component.
import { api } from '../api'

// All sub-section keys plus their human label and ordering. The
// order here is the default presentation order:
// Genre → Audio format → Bit depth → Sample rate → Decade → Last
// played → Added on → Channel layout → Artist.
//
// v1.1.0.80 shipped without bitDepth/sampleRate/channelLayout because
// those columns didn't yet exist on the albums table. v1.1.0.81 adds
// them and the schema migration is in place — so they're now part of
// the normal section list.
export const FOCUS_SECTIONS = [
  { key: 'genre',          label: 'Genre' },
  { key: 'albumType',      label: 'Type' },
  { key: 'format',         label: 'Audio format' },
  { key: 'bitDepth',       label: 'Bit depth' },
  { key: 'sampleRate',     label: 'Sample rate' },
  { key: 'decade',         label: 'Decade' },
  { key: 'lastPlayed',     label: 'Last played' },
  { key: 'addedOn',        label: 'Added on' },
  { key: 'channelLayout',  label: 'Channel layout' },
  { key: 'artist',         label: 'Artist' },
]

// v1.1.0.83 — apply a user-saved custom order to FOCUS_SECTIONS.
// Forwards-compat: keys in the saved order that we don't recognise
// are dropped (a future client added a section we don't know
// about). Backwards-compat: keys we know about that aren't in the
// saved order are appended at the end (a future release added a
// section after the user customised theirs). Returns FOCUS_SECTIONS
// unchanged if `customOrder` is null/empty.
export function applySectionOrder(customOrder) {
  if (!customOrder || customOrder.length === 0) return FOCUS_SECTIONS
  const byKey = new Map(FOCUS_SECTIONS.map(s => [s.key, s]))
  const seen = new Set()
  const ordered = []
  // First, place known keys in the user's order
  for (const k of customOrder) {
    if (byKey.has(k) && !seen.has(k)) {
      ordered.push(byKey.get(k))
      seen.add(k)
    }
  }
  // Then append any sections the user hasn't customised yet (new
  // additions since their save), preserving their default order
  for (const s of FOCUS_SECTIONS) {
    if (!seen.has(s.key)) ordered.push(s)
  }
  return ordered
}

// useFocusState — central hook. Stores include/exclude picks per
// sub-section. Returns a stable picks structure plus mutators and
// a query-string builder for /library/albums.
//
// Picks shape:
//   { genre: { include: Set<string>, exclude: Set<string> }, ... }
//
// v1.1.0.82 — also tracks the currently-loaded saved focus (id +
// the picks-snapshot at load time). Exposed via `loadedFocus` and
// `isDirty`. Used by the Focus bar to surface "Update X" / "Save
// as new" buttons when the user has loaded a saved focus and
// then modified its picks.
export function useFocusState() {
  const [picks, setPicks] = useState(() => {
    const init = {}
    for (const s of FOCUS_SECTIONS) init[s.key] = { include: new Set(), exclude: new Set() }
    return init
  })
  // The currently-loaded saved focus, if any. Shape:
  //   { id, name, picksSnapshot: serialised plain-JSON picks }
  // The snapshot is what we compare against `picks` for the dirty
  // check — comparing against a fresh fetch would be a network
  // call we don't need.
  const [loadedFocus, setLoadedFocus] = useState(null)

  // togglePick — primary action: tickbox in a column.
  // Adds the value to `include` if not present, removes any include/exclude
  // entry if present (so a second tap on the same row clears it).
  const togglePick = useCallback((sectionKey, value) => {
    setPicks(prev => {
      const next = { ...prev, [sectionKey]: {
        include: new Set(prev[sectionKey].include),
        exclude: new Set(prev[sectionKey].exclude),
      }}
      const inInclude = next[sectionKey].include.has(value)
      const inExclude = next[sectionKey].exclude.has(value)
      if (inInclude || inExclude) {
        next[sectionKey].include.delete(value)
        next[sectionKey].exclude.delete(value)
      } else {
        next[sectionKey].include.add(value)
      }
      return next
    })
  }, [])

  // togglePillSign — flips a pill's +/- when the pill itself is tapped.
  const togglePillSign = useCallback((sectionKey, value) => {
    setPicks(prev => {
      const next = { ...prev, [sectionKey]: {
        include: new Set(prev[sectionKey].include),
        exclude: new Set(prev[sectionKey].exclude),
      }}
      if (next[sectionKey].include.has(value)) {
        next[sectionKey].include.delete(value)
        next[sectionKey].exclude.add(value)
      } else if (next[sectionKey].exclude.has(value)) {
        next[sectionKey].exclude.delete(value)
        next[sectionKey].include.add(value)
      }
      return next
    })
  }, [])

  // removePill — X on the pill. Clears both include/exclude for that
  // value (since a value is in exactly one of them at any time).
  const removePill = useCallback((sectionKey, value) => {
    setPicks(prev => {
      const next = { ...prev, [sectionKey]: {
        include: new Set(prev[sectionKey].include),
        exclude: new Set(prev[sectionKey].exclude),
      }}
      next[sectionKey].include.delete(value)
      next[sectionKey].exclude.delete(value)
      return next
    })
  }, [])

  const clearAll = useCallback(() => {
    setPicks(() => {
      const init = {}
      for (const s of FOCUS_SECTIONS) init[s.key] = { include: new Set(), exclude: new Set() }
      return init
    })
    // Clearing all picks also clears any loaded saved-focus association.
    // From the user's perspective: "I'm starting fresh, this isn't
    // 'Late Night Jazz' anymore."
    setLoadedFocus(null)
  }, [])

  // v1.1.0.82 — serialise picks to plain JSON (Sets → arrays).
  // The server stores this verbatim; the queryString builder is
  // separate (URL-encodable form), this one is for persistence.
  const serialisePicks = useCallback((picksToSerialise = picks) => {
    const out = {}
    for (const k of Object.keys(picksToSerialise)) {
      out[k] = {
        include: [...picksToSerialise[k].include],
        exclude: [...picksToSerialise[k].exclude],
      }
    }
    return out
  }, [picks])

  // v1.1.0.82 — hydrate picks from a saved focus row. Server
  // returned arrays; we convert back to Sets so the rest of the
  // component code (which expects Set methods) doesn't change.
  // Unknown sub-section keys are silently dropped — that lets a
  // saved focus from an older client survive after a future
  // release renames a section.
  const loadSaved = useCallback((savedRow) => {
    if (!savedRow || !savedRow.picks) return
    const next = {}
    for (const s of FOCUS_SECTIONS) {
      const sec = savedRow.picks[s.key] || { include: [], exclude: [] }
      next[s.key] = {
        include: new Set(sec.include || []),
        exclude: new Set(sec.exclude || []),
      }
    }
    setPicks(next)
    setLoadedFocus({
      id: savedRow.id,
      name: savedRow.name,
      // Snapshot the serialised form for dirty-check. Using JSON
      // text keeps the comparison cheap (one stringify on read,
      // one stringify on dirty check, one string compare).
      picksSnapshotJson: JSON.stringify(savedRow.picks),
    })
  }, [])

  // Mark the loaded focus as the new clean baseline (used after
  // POST/PUT succeeds).
  const markSaved = useCallback((savedRow) => {
    if (!savedRow) return
    setLoadedFocus({
      id: savedRow.id,
      name: savedRow.name,
      picksSnapshotJson: JSON.stringify(savedRow.picks),
    })
  }, [])

  // Dirty: compare current serialised picks against the snapshot
  // taken at load time. False when no focus is loaded.
  const isDirty = useMemo(() => {
    if (!loadedFocus) return false
    return JSON.stringify(serialisePicks()) !== loadedFocus.picksSnapshotJson
  }, [loadedFocus, serialisePicks])

  // Query-string fragment for /api/library/albums. Keys mirror the
  // server-side parser in server/src/routes/library.js.
  // Returns '' (empty) when no picks — callers can concat unconditionally.
  const queryString = useMemo(() => {
    const parts = []
    const addList = (paramName, set) => {
      if (set.size === 0) return
      parts.push(`${paramName}=${[...set].map(encodeURIComponent).join(',')}`)
    }
    addList('focus_format',           picks.format.include)
    addList('focus_format_excl',      picks.format.exclude)
    // v1.1.0.81 — audio quality params. Same shape as everything
    // else; integer values instead of strings, but encodeURIComponent
    // handles both.
    addList('focus_bit_depth',        picks.bitDepth.include)
    addList('focus_bit_depth_excl',   picks.bitDepth.exclude)
    addList('focus_sample_rate',      picks.sampleRate.include)
    addList('focus_sample_rate_excl', picks.sampleRate.exclude)
    addList('focus_channels',         picks.channelLayout.include)
    addList('focus_channels_excl',    picks.channelLayout.exclude)
    addList('focus_genre',            picks.genre.include)
    addList('focus_genre_excl',       picks.genre.exclude)
    addList('focus_decade',           picks.decade.include)
    addList('focus_decade_excl',      picks.decade.exclude)
    addList('focus_artist',           picks.artist.include)
    addList('focus_artist_excl',      picks.artist.exclude)
    // v1.1.0.97 — album type
    addList('focus_album_type',       picks.albumType.include)
    addList('focus_album_type_excl',  picks.albumType.exclude)
    // Last played / added on are single-value but the server takes a
    // comma list and uses the first; sending the most-recent-bucket
    // is the right behaviour because that's the one the user most
    // recently ticked.
    addList('focus_last_played',      picks.lastPlayed.include)
    addList('focus_last_played_excl', picks.lastPlayed.exclude)
    addList('focus_added_on',         picks.addedOn.include)
    addList('focus_added_on_excl',    picks.addedOn.exclude)
    return parts.length > 0 ? '&' + parts.join('&') : ''
  }, [picks])

  // anyPicks — true if any pill exists across any sub-section. Used
  // by the parent to decide whether to render the pills row.
  const anyPicks = useMemo(() => {
    for (const k of Object.keys(picks)) {
      if (picks[k].include.size > 0 || picks[k].exclude.size > 0) return true
    }
    return false
  }, [picks])

  return {
    picks,
    togglePick,
    togglePillSign,
    removePill,
    clearAll,
    queryString,
    anyPicks,
    // v1.1.0.82 — saved-focus integration
    loadedFocus,
    isDirty,
    serialisePicks,
    loadSaved,
    markSaved,
  }
}


// ── FocusPills ───────────────────────────────────────────────────────
//
// The active-filter pills row that appears above the album grid when
// any picks exist. Each pill:
//   [ + Label X ]    (include — neutral background)
//   [ - Label X ]    (exclude — red background)
//
// Tap the +/- icon to flip the sign. Tap the X to remove.
// Whole row scrolls horizontally if pills overflow.
export function FocusPills({ picks, onTogglePillSign, onRemovePill, onClearAll }) {
  // Flatten picks across all sub-sections into a single list with
  // section info attached. Order: by section order, then by value.
  const flat = useMemo(() => {
    const out = []
    for (const section of FOCUS_SECTIONS) {
      const sec = picks[section.key]
      if (!sec) continue
      const includeArr = [...sec.include].sort()
      const excludeArr = [...sec.exclude].sort()
      for (const v of includeArr) out.push({ sectionKey: section.key, sectionLabel: section.label, value: v, sign: '+' })
      for (const v of excludeArr) out.push({ sectionKey: section.key, sectionLabel: section.label, value: v, sign: '-' })
    }
    return out
  }, [picks])

  if (flat.length === 0) return null

  return (
    <div style={S.pillsRow}>
      {flat.map(p => (
        <div
          key={`${p.sectionKey}:${p.value}`}
          style={{
            ...S.pill,
            ...(p.sign === '-' ? S.pillExclude : {}),
          }}
        >
          <button
            style={S.pillSignBtn}
            onClick={() => onTogglePillSign(p.sectionKey, p.value)}
            title={p.sign === '+' ? 'Including — tap to exclude' : 'Excluding — tap to include'}
            aria-label={p.sign === '+' ? 'Toggle to exclude' : 'Toggle to include'}
          >
            {p.sign === '+' ? <Plus size={12} /> : <Minus size={12} />}
          </button>
          <span style={S.pillLabel}>{formatPillValue(p.sectionKey, p.value)}</span>
          <button
            style={S.pillCloseBtn}
            onClick={() => onRemovePill(p.sectionKey, p.value)}
            title="Remove from focus"
            aria-label="Remove"
          >
            <X size={11} />
          </button>
        </div>
      ))}
      {flat.length > 1 && (
        <button style={S.clearAllBtn} onClick={onClearAll} title="Clear all focus pills">
          Clear all
        </button>
      )}
    </div>
  )
}

// formatPillValue — pretty the value depending on which sub-section
// it came from. Decades show "1970s", date buckets show "Last week"
// rather than the bare 'week' value.
function formatPillValue(sectionKey, value) {
  if (sectionKey === 'decade') return `${value}s`
  if (sectionKey === 'format') return String(value).toUpperCase()
  if (sectionKey === 'lastPlayed' || sectionKey === 'addedOn') {
    const map = { day: 'Last 24h', week: 'Last 7 days', month: 'Last 30 days', longer: 'Longer ago' }
    return map[value] || value
  }
  // v1.1.0.81 — audio quality pretty-printing.
  if (sectionKey === 'bitDepth')   return `${value}-bit`
  if (sectionKey === 'sampleRate') {
    // Mirror server-side formatting: 44100 → "44.1 kHz", 48000 → "48 kHz"
    const k = value / 1000
    const isInteger = Math.abs(k - Math.round(k)) < 0.05
    return isInteger ? `${Math.round(k)} kHz` : `${k.toFixed(1)} kHz`
  }
  if (sectionKey === 'channelLayout') {
    const n = Number(value)
    if (n === 1) return 'Mono'
    if (n === 2) return 'Stereo'
    if (n === 6) return '5.1'
    if (n === 8) return '7.1'
    return `${n}ch`
  }
  return value
}


// ── FocusBar ─────────────────────────────────────────────────────────
//
// The collapsible columns bar. Renders one column per sub-section.
// Whole bar scrolls horizontally so additional columns are reachable
// past the visible width. Each column scrolls vertically internally
// for sub-sections with many options (e.g. Genre, Artist).
//
// Height is fixed at ~the height of one album cover row so the bar
// occupies a predictable amount of vertical space.
// v1.1.0.83 — useColumnReorder.
//
// State machine for the long-press-to-drag column reorder gesture.
// Designed for pointer events (unified mouse + touch + pen) since
// HTML5 native d&d doesn't work on iOS.
//
// States:
//   idle       — no gesture in flight
//   pressing   — pointerdown fired, long-press timer running
//   dragging   — long-press fired, pointer captured, column lifted
//
// Transitions:
//   idle → pressing      : pointerdown on a column title
//   pressing → idle      : pointerup before timer, OR pointermove
//                          beyond threshold (treated as scroll, not drag)
//   pressing → dragging  : long-press timer fires
//   dragging → idle      : pointerup (commit) or pointercancel (revert)
//
// onReorder is called with the new array of section keys when the
// drop commits to a different position from where the column
// started. If the user drops the column where it started, no callback.
//
// The hook returns:
//   getTitleHandlers(sectionKey, index) — spread onto the title
//     element to wire up the gesture. Includes pointer event
//     handlers and visual style overrides.
//   getColumnStyle(sectionKey, index) — returns CSS that applies
//     to the column wrapper (transform shift while another column
//     is being dragged over).
//   isDragging — true while in the dragging state. Useful to e.g.
//     suppress horizontal bar scroll while dragging.
//   draggingKey — which section is being dragged (null if none).
function useColumnReorder({ sections, onReorder, columnWidth, columnGap }) {
  // Long-press threshold (ms) before a press becomes a drag
  const LONG_PRESS_MS = 450
  // Pointer movement (px) within press window that cancels the long
  // press (interpreted as a scroll gesture instead)
  const SCROLL_CANCEL_PX = 8

  const [draggingKey, setDraggingKey] = useState(null)
  const [dragX, setDragX] = useState(0)
  const [hoverIndex, setHoverIndex] = useState(null)

  // Refs for state that doesn't drive render but does drive gesture
  // logic. Stored in refs so the pointer handlers can read fresh
  // values without re-creating handlers on every render.
  const stateRef = useRef('idle')             // 'idle' | 'pressing' | 'dragging'
  const pressTimerRef = useRef(null)
  const startXRef = useRef(0)
  const startYRef = useRef(0)
  const startIndexRef = useRef(-1)
  const startKeyRef = useRef(null)
  const pointerIdRef = useRef(null)
  const targetElRef = useRef(null)            // the title element

  const cleanup = useCallback(() => {
    if (pressTimerRef.current) {
      clearTimeout(pressTimerRef.current)
      pressTimerRef.current = null
    }
    if (targetElRef.current && pointerIdRef.current !== null) {
      try { targetElRef.current.releasePointerCapture(pointerIdRef.current) } catch {}
    }
    stateRef.current = 'idle'
    pointerIdRef.current = null
    targetElRef.current = null
    startIndexRef.current = -1
    startKeyRef.current = null
    setDraggingKey(null)
    setDragX(0)
    setHoverIndex(null)
  }, [])

  // Compute which slot the dragged column is currently centred on
  const computeHoverIndex = useCallback((startIdx, deltaX) => {
    // Slot width = columnWidth + columnGap. The dragged column
    // shifts visually by deltaX from its start position; the slot
    // it's "over" is whichever index that puts its centre in.
    const slotPitch = columnWidth + columnGap
    if (slotPitch <= 0) return startIdx
    const offset = Math.round(deltaX / slotPitch)
    const target = startIdx + offset
    return Math.max(0, Math.min(sections.length - 1, target))
  }, [sections.length, columnWidth, columnGap])

  const handlePointerDown = useCallback((e, sectionKey, index) => {
    // Only respond to primary buttons / single touches
    if (e.button !== undefined && e.button !== 0) return
    if (stateRef.current !== 'idle') return

    targetElRef.current = e.currentTarget
    pointerIdRef.current = e.pointerId
    startXRef.current = e.clientX
    startYRef.current = e.clientY
    startIndexRef.current = index
    startKeyRef.current = sectionKey
    stateRef.current = 'pressing'

    // Long-press timer — if it fires before we cancel, we enter
    // dragging mode.
    pressTimerRef.current = setTimeout(() => {
      pressTimerRef.current = null
      // Only enter drag if we're still in pressing state
      if (stateRef.current !== 'pressing') return
      stateRef.current = 'dragging'
      try {
        targetElRef.current.setPointerCapture(pointerIdRef.current)
      } catch {}
      setDraggingKey(startKeyRef.current)
      setHoverIndex(startIndexRef.current)
      setDragX(0)
      // Light haptic feedback if available — confirms long-press
      // landed without forcing the user to look up
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        try { navigator.vibrate(8) } catch {}
      }
    }, LONG_PRESS_MS)
  }, [])

  const handlePointerMove = useCallback((e) => {
    if (stateRef.current === 'idle') return

    if (stateRef.current === 'pressing') {
      // Movement above threshold cancels the long-press — user is
      // scrolling, not preparing to reorder.
      const dx = Math.abs(e.clientX - startXRef.current)
      const dy = Math.abs(e.clientY - startYRef.current)
      if (dx > SCROLL_CANCEL_PX || dy > SCROLL_CANCEL_PX) {
        cleanup()
      }
      return
    }

    if (stateRef.current === 'dragging') {
      const deltaX = e.clientX - startXRef.current
      setDragX(deltaX)
      const newHover = computeHoverIndex(startIndexRef.current, deltaX)
      setHoverIndex(newHover)
    }
  }, [cleanup, computeHoverIndex])

  const handlePointerUp = useCallback((e) => {
    const wasState = stateRef.current
    const startIdx = startIndexRef.current
    const dropIdx = hoverIndex
    cleanup()
    if (wasState !== 'dragging') return
    if (dropIdx == null || dropIdx === startIdx) return

    // Build new order
    const newSections = [...sections]
    const [moved] = newSections.splice(startIdx, 1)
    newSections.splice(dropIdx, 0, moved)
    const newOrder = newSections.map(s => s.key)
    if (onReorder) onReorder(newOrder)
  }, [hoverIndex, sections, onReorder, cleanup])

  const getTitleHandlers = useCallback((sectionKey, index) => ({
    onPointerDown: (e) => handlePointerDown(e, sectionKey, index),
    onPointerMove: handlePointerMove,
    onPointerUp: handlePointerUp,
    onPointerCancel: cleanup,
    style: { touchAction: 'none', cursor: draggingKey === sectionKey ? 'grabbing' : 'grab' },
  }), [handlePointerDown, handlePointerMove, handlePointerUp, cleanup, draggingKey])

  const getColumnStyle = useCallback((sectionKey, index) => {
    if (draggingKey === sectionKey) {
      // The lifted column follows the pointer
      return {
        transform: `translateX(${dragX}px)`,
        opacity: 0.85,
        zIndex: 5,
        transition: 'none',
        boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
        pointerEvents: 'none',
      }
    }
    if (draggingKey != null && hoverIndex != null) {
      // Other columns shift to make room. The exact amount depends on
      // the original index of the dragged column and the hover target:
      //   * If dragging right (start < hover) — columns at indices
      //     (start, hover] shift LEFT by one slot
      //   * If dragging left (start > hover) — columns at indices
      //     [hover, start) shift RIGHT by one slot
      const start = startIndexRef.current
      const slotPitch = columnWidth + columnGap
      if (start < hoverIndex && index > start && index <= hoverIndex) {
        return { transform: `translateX(-${slotPitch}px)`, transition: 'transform 140ms' }
      }
      if (start > hoverIndex && index >= hoverIndex && index < start) {
        return { transform: `translateX(${slotPitch}px)`, transition: 'transform 140ms' }
      }
    }
    return { transition: 'transform 140ms' }
  }, [draggingKey, dragX, hoverIndex, columnWidth, columnGap])

  return {
    isDragging: draggingKey !== null,
    draggingKey,
    getTitleHandlers,
    getColumnStyle,
  }
}


// FocusBar
//
// Renders the columns bar. Per spec the whole bar scrolls horizontally
// to reveal more columns; each column scrolls vertically internally
// for sub-sections with many options (e.g. Genre, Artist).
//
// Height is fixed at ~the height of one album cover row so the bar
// occupies a predictable amount of vertical space.
//
// v1.1.0.83 — accepts an optional `sections` prop allowing the caller
// to inject a user-customised order. Defaults to FOCUS_SECTIONS.
// Also supports drag-reorder of column titles via long-press, with
// onReorder firing when the user drops a column in a new slot.
export function FocusBar({
  picks,
  options,
  onTogglePick,
  onClose,
  // v1.1.0.82 — saved-focus integration
  loadedFocus = null,
  isDirty = false,
  anyPicks = false,
  onSaveAsNew = null,
  onUpdateLoaded = null,
  // v1.1.0.83 — column reorder
  sections = FOCUS_SECTIONS,
  onReorder = null,
  onResetOrder = null,
  isOrderCustomised = false,
}) {
  // Hook is unconditional even when reorder isn't enabled — keeps
  // hook order stable across renders. The handlers are no-ops when
  // onReorder is null.
  const reorder = useColumnReorder({
    sections,
    onReorder: onReorder || (() => {}),
    columnWidth: COLUMN_WIDTH,
    columnGap: COLUMN_GAP,
  })

  if (!options) {
    return (
      <div style={S.bar}>
        <div style={S.barLoading}>Loading focus options…</div>
      </div>
    )
  }

  const showUpdate = !!(loadedFocus && isDirty && onUpdateLoaded)
  const showSaveAsNew = !!(anyPicks && onSaveAsNew)
  const showResetOrder = !!(isOrderCustomised && onResetOrder)

  return (
    <div style={S.bar}>
      <button
        style={S.barCloseBtn}
        onClick={onClose}
        title="Close focus bar"
        aria-label="Close focus bar"
      >
        <X size={16} />
      </button>

      {(showUpdate || showSaveAsNew || showResetOrder) && (
        <div style={S.barSaveActions}>
          {showResetOrder && (
            <button
              style={S.barSaveBtn}
              onClick={onResetOrder}
              title="Reset column order to default"
            >
              Reset order
            </button>
          )}
          {showUpdate && (
            <button
              style={{ ...S.barSaveBtn, ...S.barSaveBtnPrimary }}
              onClick={onUpdateLoaded}
              title={`Save your changes to "${loadedFocus.name}"`}
            >
              Update “{loadedFocus.name}”
            </button>
          )}
          {showSaveAsNew && (
            <button
              style={S.barSaveBtn}
              onClick={onSaveAsNew}
              title="Save current picks as a new focus"
            >
              Save as new…
            </button>
          )}
        </div>
      )}

      <div
        style={{
          ...S.barColumns,
          // Suppress horizontal scroll while a drag is in progress —
          // otherwise the bar tries to scroll along with the lifted
          // column's pointer movement, fighting the drag gesture.
          overflowX: reorder.isDragging ? 'hidden' : 'auto',
        }}
      >
        {sections.map((section, index) => {
          const items = optionsForSection(section.key, options)
          const colStyle = onReorder ? reorder.getColumnStyle(section.key, index) : null
          return (
            <div
              key={section.key}
              style={{
                ...S.columnWrap,
                ...(colStyle || {}),
              }}
            >
              <FocusColumn
                section={section}
                items={items}
                picks={picks[section.key]}
                onTogglePick={(value) => onTogglePick(section.key, value)}
                titleHandlers={onReorder ? reorder.getTitleHandlers(section.key, index) : null}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

function optionsForSection(sectionKey, options) {
  if (sectionKey === 'genre')         return options.genres      || []
  if (sectionKey === 'format')        return options.formats     || []
  // v1.1.0.81 — audio quality routes. Server returns these as
  // bitDepths / sampleRates / channels arrays.
  if (sectionKey === 'bitDepth')      return options.bitDepths   || []
  if (sectionKey === 'sampleRate')    return options.sampleRates || []
  if (sectionKey === 'channelLayout') return options.channels    || []
  if (sectionKey === 'decade')        return options.decades     || []
  if (sectionKey === 'lastPlayed')    return options.lastPlayed  || []
  if (sectionKey === 'addedOn')       return options.addedOn     || []
  if (sectionKey === 'artist')        return options.artists     || []
  if (sectionKey === 'albumType')     return options.albumTypes  || []
  return []
}


// ── FocusColumn ──────────────────────────────────────────────────────
//
// One sub-section column: title at top, vertically scrollable list
// of options below. Each item has a tickbox plus the option label.
// Ticked rows already-included get a + style; ticked rows
// already-excluded get a - style. Plain checked rows reflect the
// "include" state by default (tap on a row toggles via onTogglePick,
// which adds to include if not present, removes if present).
//
// For the Artist column we also show a search box. When the column
// has more than ~12 items, type-to-filter narrows the visible list.
function FocusColumn({ section, items, picks, onTogglePick, titleHandlers = null }) {
  const [search, setSearch] = useState('')
  const showSearch = section.key === 'artist' || items.length > 12

  const filtered = useMemo(() => {
    if (!search) return items
    const q = search.toLowerCase()
    return items.filter(it => {
      const label = (it.label || it.value || '').toString().toLowerCase()
      return label.includes(q)
    })
  }, [items, search])

  const includeSet = picks?.include || new Set()
  const excludeSet = picks?.exclude || new Set()

  // v1.1.0.83 — the title row carries the long-press-to-drag
  // handlers for column reorder. Spread `titleHandlers` onto the
  // title element. If no handlers are passed (caller didn't enable
  // reorder), the row renders as a plain non-interactive label.
  const titleStyle = {
    ...S.columnTitle,
    ...(titleHandlers?.style || {}),
    // Make it visually obvious that the title is grabbable when
    // reorder is enabled.
    userSelect: titleHandlers ? 'none' : 'auto',
    WebkitUserSelect: titleHandlers ? 'none' : 'auto',
  }

  return (
    <div style={S.column}>
      <div
        style={titleStyle}
        onPointerDown={titleHandlers?.onPointerDown}
        onPointerMove={titleHandlers?.onPointerMove}
        onPointerUp={titleHandlers?.onPointerUp}
        onPointerCancel={titleHandlers?.onPointerCancel}
      >
        {section.label}
      </div>
      {showSearch && (
        <div style={S.columnSearchWrap}>
          <Search size={11} style={{ color: 'var(--jp-text-3)' }} />
          <input
            type="search"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search…"
            style={S.columnSearchInput}
          />
        </div>
      )}
      <div style={S.columnList}>
        {filtered.length === 0 ? (
          <div style={S.columnEmpty}>
            {search ? 'No matches' : 'No options'}
          </div>
        ) : (
          filtered.map(item => {
            const value = item.value
            const label = item.label || String(value)
            const inIncl = includeSet.has(value)
            const inExcl = excludeSet.has(value)
            return (
              <button
                key={String(value)}
                onClick={() => onTogglePick(value)}
                style={{
                  ...S.columnItem,
                  ...(inIncl ? S.columnItemInclude : {}),
                  ...(inExcl ? S.columnItemExclude : {}),
                }}
                aria-pressed={inIncl || inExcl}
              >
                <span style={S.columnItemTick}>
                  {inIncl ? '+' : (inExcl ? '−' : '')}
                </span>
                <span style={S.columnItemLabel}>{label}</span>
                {item.count !== undefined && (
                  <span style={S.columnItemCount}>{item.count}</span>
                )}
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}


// ── styles ───────────────────────────────────────────────────────────
//
// Shared with AlbumGrid.jsx via inline objects so we don't have to
// add another stylesheet. Most colours pull from the JPLAY tokens.
//
// One quirk worth noting: the bar height is computed to roughly
// match an album cover's height in the grid. That's ~180px on
// desktop, ~140px on phone. We use 220px as a comfortable upper
// bound that gives the column lists room to breathe; if it feels
// too tall in real usage we can tune.
const COLUMN_WIDTH   = 180
const COLUMN_GAP     = 8
const BAR_HEIGHT     = 220

const S = {
  // ── pills row ────────────────────────────────────────────
  pillsRow: {
    display: 'flex', gap: 6,
    overflowX: 'auto', overflowY: 'hidden',
    WebkitOverflowScrolling: 'touch',
    scrollbarWidth: 'none',
    paddingTop: 6, paddingBottom: 8,
    background: 'var(--jp-bg)',
    borderBottom: '1px solid var(--jp-border)',
    marginLeft: -16, marginRight: -16,
    paddingLeft: 16, paddingRight: 16,
  },
  pill: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    paddingLeft: 4, paddingRight: 4,
    height: 26,
    borderRadius: 13,
    background: 'rgba(255,255,255,0.07)',
    border: '1px solid var(--jp-border)',
    fontSize: 12,
    color: 'var(--jp-text)',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  pillExclude: {
    background: 'rgba(255,59,92,0.18)',
    borderColor: 'rgba(255,59,92,0.36)',
    color: '#ff8a9a',
  },
  pillSignBtn: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 18, height: 18, padding: 0,
    background: 'rgba(255,255,255,0.08)',
    border: 'none', borderRadius: 9,
    color: 'inherit',
    cursor: 'pointer',
  },
  pillLabel: {
    paddingLeft: 2, paddingRight: 2,
    fontWeight: 500,
  },
  pillCloseBtn: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 18, height: 18, padding: 0,
    background: 'transparent',
    border: 'none', borderRadius: 9,
    color: 'inherit',
    cursor: 'pointer',
    opacity: 0.7,
  },
  clearAllBtn: {
    display: 'inline-flex', alignItems: 'center',
    height: 26, padding: '0 10px',
    background: 'transparent',
    border: '1px dashed var(--jp-border)',
    borderRadius: 13,
    color: 'var(--jp-text-3)',
    fontSize: 11,
    cursor: 'pointer',
    flexShrink: 0,
    marginLeft: 4,
  },

  // ── focus bar ────────────────────────────────────────────
  bar: {
    position: 'relative',
    height: BAR_HEIGHT,
    background: 'var(--jp-bg-elevated)',
    borderBottom: '1px solid var(--jp-border)',
    marginLeft: -16, marginRight: -16,
    paddingLeft: 16, paddingRight: 16,
    paddingTop: 8, paddingBottom: 8,
    boxSizing: 'border-box',
    overflow: 'hidden',
  },
  barLoading: {
    fontSize: 11,
    color: 'var(--jp-text-3)',
    paddingTop: 80,
    textAlign: 'center',
  },
  barCloseBtn: {
    position: 'absolute',
    top: 6, left: 6,
    width: 24, height: 24,
    padding: 0,
    background: 'rgba(0,0,0,0.4)',
    border: '1px solid var(--jp-border)',
    borderRadius: 12,
    color: 'var(--jp-text-2)',
    cursor: 'pointer',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 2,
  },
  // v1.1.0.82 — Save / Update buttons sit top-right opposite the X.
  // They float above the columns the same way the close button does,
  // so the columns scroll behind them.
  barSaveActions: {
    position: 'absolute',
    top: 6, right: 6,
    display: 'flex', gap: 6,
    zIndex: 2,
  },
  barSaveBtn: {
    height: 24, padding: '0 10px',
    background: 'rgba(0,0,0,0.4)',
    border: '1px solid var(--jp-border)',
    borderRadius: 12,
    color: 'var(--jp-text-2)',
    fontSize: 11, fontWeight: 500,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    maxWidth: 180,
    overflow: 'hidden', textOverflow: 'ellipsis',
  },
  barSaveBtnPrimary: {
    background: 'var(--jp-accent)',
    color: '#0a0a0c',
    borderColor: 'var(--jp-accent)',
    fontWeight: 600,
  },
  barColumns: {
    display: 'flex',
    gap: COLUMN_GAP,
    height: '100%',
    paddingLeft: 32,  // room for the X close button
    overflowX: 'auto', overflowY: 'hidden',
    WebkitOverflowScrolling: 'touch',
    scrollbarWidth: 'none',
  },

  // ── column ───────────────────────────────────────────────
  // v1.1.0.83 — columnWrap is a positioning shim around the column
  // proper. Reorder transforms apply here, leaving the inner column's
  // own layout untouched. Without the shim, applying transform to
  // the column itself can interfere with its internal flex layout.
  columnWrap: {
    flexShrink: 0,
    height: '100%',
    willChange: 'transform',
  },
  column: {
    width: COLUMN_WIDTH,
    flexShrink: 0,
    display: 'flex', flexDirection: 'column',
    height: '100%',
    background: 'var(--jp-bg-surface)',
    borderRadius: 6,
    overflow: 'hidden',
  },
  columnTitle: {
    flexShrink: 0,
    padding: '6px 10px',
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--jp-text-2)',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    borderBottom: '1px solid var(--jp-border)',
  },
  columnSearchWrap: {
    flexShrink: 0,
    display: 'flex', alignItems: 'center', gap: 4,
    padding: '4px 8px',
    borderBottom: '1px solid var(--jp-border)',
    background: 'var(--jp-bg-elevated)',
  },
  columnSearchInput: {
    flex: 1, minWidth: 0,
    background: 'transparent', border: 'none', outline: 'none',
    color: 'var(--jp-text)',
    fontSize: 12,
    padding: 2,
  },
  columnList: {
    flex: 1, minHeight: 0,
    overflowY: 'auto',
    WebkitOverflowScrolling: 'touch',
  },
  columnItem: {
    display: 'flex', alignItems: 'center', gap: 6,
    width: '100%',
    padding: '6px 10px',
    background: 'transparent',
    border: 'none',
    color: 'var(--jp-text-2)',
    fontSize: 12,
    textAlign: 'left',
    cursor: 'pointer',
  },
  columnItemInclude: {
    background: 'rgba(255,255,255,0.06)',
    color: 'var(--jp-text)',
  },
  columnItemExclude: {
    background: 'rgba(255,59,92,0.10)',
    color: '#ff8a9a',
  },
  columnItemTick: {
    width: 12, height: 12,
    flexShrink: 0,
    fontSize: 13, fontWeight: 700,
    textAlign: 'center', lineHeight: '12px',
  },
  columnItemLabel: {
    // v1.1.0.91 — was flex: 1 which pushed the count to the far right
    // and left a wide gap on short labels. Now the label takes its
    // natural width (with ellipsis when too long) and the count sits
    // immediately after with a small gap. Reads as "Pop · 1234"
    // rather than "Pop ............... 1234".
    flex: '0 1 auto', minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  columnItemCount: {
    fontSize: 10,
    color: 'var(--jp-text-3)',
    fontFamily: 'var(--font-mono)',
    // v1.1.0.91 — small left margin replaces the implicit gap from
    // flex: 1 above. Count sits close to the label.
    marginLeft: 6,
  },
  columnEmpty: {
    padding: '8px 10px',
    fontSize: 11,
    color: 'var(--jp-text-3)',
  },
}


// ── Modal ────────────────────────────────────────────────────────────
//
// v1.1.0.82 — minimal centred modal used by the saved-focus save/
// delete flows. Displays in the middle of the screen with a dim
// backdrop. Tap outside to dismiss (calls onCancel). Body content
// is whatever the caller passes as children.
//
// Used in two places:
//   * "Save as new" → name input + Save / Cancel
//   * "Delete saved focuses" → confirmation message + Yes / No
//
// Kept generic so a third use case can wire up without another
// component. Renders into document.body via fixed positioning, so
// it doesn't clip against the sticky header / focus bar.
export function FocusModal({ open, onCancel, title, children }) {
  if (!open) return null
  return (
    <div
      style={M.backdrop}
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
    >
      <div
        style={M.dialog}
        onClick={e => e.stopPropagation()}
      >
        {title && <div style={M.title}>{title}</div>}
        <div style={M.body}>{children}</div>
      </div>
    </div>
  )
}

const M = {
  backdrop: {
    position: 'fixed', inset: 0,
    background: 'rgba(0,0,0,0.55)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 1000,
    padding: 20,
  },
  dialog: {
    width: 'min(92vw, 360px)',
    background: 'var(--jp-bg-elevated)',
    border: '1px solid var(--jp-border)',
    borderRadius: 12,
    boxShadow: '0 20px 60px rgba(0,0,0,0.55)',
    overflow: 'hidden',
  },
  title: {
    padding: '14px 16px 8px',
    fontSize: 14, fontWeight: 600,
    color: 'var(--jp-text)',
  },
  body: {
    padding: '4px 16px 16px',
    color: 'var(--jp-text)',
    fontSize: 13,
    lineHeight: 1.5,
  },
}
