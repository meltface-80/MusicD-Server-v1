import React, { useCallback, useMemo, useState } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import { Play, ListMusic, Plus, Shuffle, Bookmark, X, CheckSquare, Combine, AlertTriangle } from 'lucide-react'

// Multi-select for the album grids (v1.1.29.0).
//
// ONE implementation, used by the main Albums wall, Favourites, Saved for
// later and the Random-albums wall. They are four screens drawing the same
// tiles, and this project has already paid twice for the alternative — the
// volume sheet and the queue view both existed in two copies, and both times
// every improvement landed on one of them.
//
// The actions are the album page's own, in its order: Play now, Play next,
// Add to queue, Shuffle play — plus Save for later, which the owner asked to
// reach from everything that can hold a selection. They act on every track of
// every ticked album, in the order the albums were ticked.
//
// Entry is a Select chip, NOT a long press. The long-press menu on album
// thumbnails was removed at the owner's request and artwork-longpress.test.js
// keeps it removed; putting selection back on that gesture would reintroduce
// exactly the thing that was taken away.

// The actions, declared once. `needsRenderer` marks the three that start or
// change playback — Add to queue and Save for later work with nothing playing.
export const SELECTION_ACTIONS = [
  { id: 'playNow',   label: 'Play now',      icon: Play,      needsRenderer: true },
  { id: 'playNext',  label: 'Play next',     icon: ListMusic, needsRenderer: true },
  { id: 'queue',     label: 'Add to queue',  icon: Plus,      needsRenderer: false },
  { id: 'shuffle',   label: 'Shuffle play',  icon: Shuffle,   needsRenderer: true },
  { id: 'saveLater', label: 'Save for later', icon: Bookmark, needsRenderer: false },
  // v1.1.43.0 — merge. Ordered, destructive-ish and confirmed, so it is set
  // apart from the five playback actions above it: `ordered` puts the disc
  // numbering in front of the user before they commit, `confirm` makes the
  // sheet ask, and `minCount` keeps it out of the way of a single tick.
  {
    id: 'merge', label: 'Merge albums', icon: Combine, needsRenderer: false,
    ordered: true, confirm: true, minCount: 2,
  },
]

// Selection state. A Set of album ids plus the mode flag — kept here rather
// than in each grid so both grids cannot drift on what "selected" means.
export function useAlbumSelection() {
  const [selecting, setSelecting] = useState(false)
  // v1.1.43.0 — the ORDER of the ticks is now part of the state.
  //
  // Every action before merge treated the selection as a set, and a Set in
  // JavaScript does happen to iterate in insertion order — but relying on
  // that would make the disc numbering of a merge depend on an incidental
  // property of the container, which is the sort of thing that survives
  // until someone swaps it for an array or a filter and cannot work out
  // why disc 2 is now disc 3. So the order is kept explicitly, and the Set
  // is derived from it for the membership tests every grid does per tile.
  const [order, setOrder] = useState(() => [])
  const selected = useMemo(() => new Set(order), [order])

  const toggle = useCallback((id) => {
    setOrder(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]))
  }, [])

  const enter = useCallback((id = null) => {
    setSelecting(true)
    setOrder(id == null ? [] : [id])
  }, [])

  const exit = useCallback(() => {
    setSelecting(false)
    setOrder([])
  }, [])

  // 1-based position, or 0 when not selected. Shown on the tile so the
  // numbering a merge is about to apply is visible before it is applied.
  const indexOf = useCallback((id) => order.indexOf(id) + 1, [order])

  return { selecting, selected, order, count: order.length, toggle, enter, exit, indexOf }
}

// Run one action against a set of album ids.
//
// Async and awaited by the caller, because the tracks have to be fetched
// first: the grid rows carry no track list, only counts.
export async function runSelectionAction(action, ids, order) {
  // `order` is authoritative when given: merge numbers the discs by it.
  // Falling back to the Set keeps every existing caller working unchanged.
  const list = Array.isArray(order) && order.length ? [...order] : [...ids]
  if (list.length === 0) return { ok: false, reason: 'empty' }

  const store = useStore.getState()
  const spec = SELECTION_ACTIONS.find(a => a.id === action)
  if (!spec) return { ok: false, reason: 'unknown-action' }
  if (spec.needsRenderer && !store.rendererId) {
    return { ok: false, reason: 'no-renderer' }
  }

  // Save for later never needs the tracks — it is an album-level flag, and
  // fetching a thousand track rows to set it would be wasted work.
  // Merge is album-level and needs no tracks, like saveLater. It also
  // returns `reload`, because it changes what the grid behind it contains:
  // two tiles become one, and a stale grid still showing both is a grid
  // where tapping the second one 404s.
  if (action === 'merge') {
    if (list.length < 2) return { ok: false, reason: 'need-two' }
    try {
      const r = await api.post('/library/albums/merge', { ids: list })
      return { ok: true, reload: true, ...r }
    } catch (e) {
      return { ok: false, reason: 'merge-failed', error: e?.message || String(e) }
    }
  }

  if (action === 'saveLater') {
    let saved = 0
    for (const id of list) {
      try {
        await api.post(`/library/albums/${id}/save-for-later`, { value: true })
        saved++
      } catch (e) {
        // Keep going: one album failing should not cost the user the rest of
        // the selection. The count returned is what actually landed.
        console.warn('save-for-later failed for', id, e?.message || e)
      }
    }
    return { ok: saved > 0, saved, count: list.length }
  }

  let tracks = []
  try {
    const r = await api.post('/library/albums/tracks', { ids: list })
    tracks = r?.tracks || []
  } catch (e) {
    return { ok: false, reason: 'fetch-failed', error: e?.message || String(e) }
  }
  if (tracks.length === 0) return { ok: false, reason: 'no-tracks' }

  switch (action) {
    case 'playNow':  await store.playQueue(tracks, 0); break
    case 'playNext': await store.insertNextInQueue(tracks); break
    case 'queue':    await store.appendIdsToQueue(tracks.map(t => t.id)); break
    case 'shuffle':  await store.shufflePlay(tracks); break
    default: return { ok: false, reason: 'unknown-action' }
  }
  return { ok: true, tracks: tracks.length, count: list.length }
}

// The chip that turns selection on. Sits in each grid's existing chip row, so
// it inherits that row's styling and needs none of its own.
export function SelectChip({ selecting, onToggle, chipStyle, activeStyle }) {
  return (
    <button
      style={{ ...chipStyle, ...(selecting ? activeStyle : {}) }}
      onClick={onToggle}
      aria-pressed={selecting}
      title={selecting ? 'Stop selecting' : 'Select albums'}
      aria-label="Select albums"
    >
      <CheckSquare size={15} />
      <span>Select</span>
    </button>
  )
}

// The bar that replaces the chip row while selecting: what is picked, a way
// out, and the way to act on it.
export function SelectionBar({ count, onCancel, onAct, busy }) {
  return (
    <div style={s.bar}>
      <span style={s.count}>
        {count} selected
      </span>
      <button style={s.barBtn} onClick={onCancel} disabled={busy}>
        <X size={14} /><span>Cancel</span>
      </button>
      <button
        style={{ ...s.barBtn, ...s.barBtnPrimary, ...(count === 0 || busy ? s.barBtnOff : {}) }}
        onClick={onAct}
        disabled={count === 0 || busy}
      >
        <Play size={13} fill="currentColor" strokeWidth={0} />
        <span>{busy ? 'Working…' : 'Actions'}</span>
      </button>
    </div>
  )
}

// The action sheet. Same five rows wherever a selection can be made.
export function SelectionSheet({ count, onClose, onPick, error, orderedIds, albumsById }) {
  const rendererId = useStore(st => st.rendererId)
  // Which action is waiting for a yes. Null the rest of the time, so the
  // sheet is exactly what it always was until something asks to confirm.
  const [confirming, setConfirming] = useState(null)

  const spec = confirming ? SELECTION_ACTIONS.find(a => a.id === confirming) : null

  if (spec && spec.confirm) {
    // The merge confirmation names the discs in the order they will be
    // applied. "Merge 3 albums?" is not a question anyone can answer
    // safely — which one becomes disc 1 is the entire decision, and it is
    // invisible from a count.
    const ordered = Array.isArray(orderedIds) ? orderedIds : []
    return (
      <div style={s.backdrop} onClick={onClose}>
        <div style={s.sheet} onClick={e => e.stopPropagation()}>
          <div style={s.grabber} />
          <div style={s.confirmHead}>
            <AlertTriangle size={18} style={s.confirmIcon} />
            <span>Merge {count} album{count === 1 ? '' : 's'} into one?</span>
          </div>
          <div style={s.confirmBody}>
            They become one album with one tile, numbered in the order you
            picked them:
          </div>
          <ol style={s.discList}>
            {ordered.map((id, i) => {
              const a = albumsById && albumsById[id]
              return (
                <li key={id} style={s.discRow}>
                  <span style={s.discNum}>Disc {i + 1}</span>
                  <span style={s.discName}>
                    {a ? (a.title || '(untitled)') : id}
                  </span>
                </li>
              )
            })}
          </ol>
          <div style={s.confirmNote}>
            {/* Written as escapes, not HTML entities. JSX decodes only the
                entities React knows, and &ctdot; is not one of them — it
                rendered as the literal seven characters in the sheet. Caught
                by screenshotting it; reading the source would not have shown
                it, which is the whole reason CLAUDE.md insists on the
                screenshot pass. */}
            The first one keeps its artwork and details. You can undo this
            later from the merged album{'\u2019'}s <b>{'\u22EF'}</b> menu.
          </div>
          {error && <div style={s.error}>{error}</div>}
          <button style={s.confirmGo} onClick={() => onPick(confirming)}>
            Merge
          </button>
          <button style={s.close} onClick={() => setConfirming(null)}>Cancel</button>
        </div>
      </div>
    )
  }

  return (
    <div style={s.backdrop} onClick={onClose}>
      <div style={s.sheet} onClick={e => e.stopPropagation()}>
        <div style={s.grabber} />
        <div style={s.sheetTitle}>
          {count} album{count === 1 ? '' : 's'} selected
        </div>
        {error && <div style={s.error}>{error}</div>}
        {SELECTION_ACTIONS.map(({ id, label, icon: Icon, needsRenderer, minCount, confirm }) => {
          // An action with a minimum is not shown below it at all, rather
          // than shown disabled: "Merge albums" greyed out on a single tick
          // invites a tap and explains nothing.
          if (minCount && count < minCount) return null
          // The three that start playback are disabled with no output chosen,
          // rather than failing after the tap with an alert.
          const off = needsRenderer && !rendererId
          return (
            <button
              key={id}
              style={{ ...s.item, ...(off ? s.itemOff : {}) }}
              onClick={() => {
                if (off) return
                if (confirm) { setConfirming(id); return }
                onPick(id)
              }}
              disabled={off}
            >
              <Icon size={18} style={s.itemIcon} />
              <span>{label}</span>
              {off && <span style={s.itemNote}>needs an output</span>}
            </button>
          )
        })}
        <button style={s.close} onClick={onClose}>Close</button>
      </div>
    </div>
  )
}

// The tick drawn over a tile while selecting. Absolutely positioned, so the
// tile it sits in needs position: relative.
// v1.1.43.0 — `index` (1-based, 0 when unselected) shows the POSITION
// rather than a plain tick.
//
// Merge numbers the discs by the order the albums were picked, and a tick
// that looks identical on the first and the third hides the only decision
// the user is actually making. With a number on it, the disc layout is
// visible on the wall before the sheet is even opened.
export function SelectionTick({ on, index }) {
  const showNumber = on && Number(index) > 0
  return (
    <span style={{ ...s.tick, ...(on ? s.tickOn : {}) }} aria-hidden="true">
      {showNumber ? (
        <span style={s.tickNum}>{index}</span>
      ) : on ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" strokeWidth="3.5"
             strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : null}
    </span>
  )
}

const s = {
  bar: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '4px 0 2px',
  },
  count: {
    flex: 1, minWidth: 0,
    fontSize: 14, fontWeight: 600, color: 'var(--jp-accent)',
    fontFamily: 'var(--font-mono)',
  },
  barBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0,
    padding: '6px 12px', borderRadius: 999,
    background: 'transparent',
    border: '1px solid var(--jp-border-hot)',
    color: 'var(--jp-text-2)',
    fontSize: 13, fontWeight: 600, fontFamily: 'inherit',
    cursor: 'pointer', whiteSpace: 'nowrap',
  },
  barBtnPrimary: {
    background: 'var(--jp-accent)', borderColor: 'var(--jp-accent)',
    color: 'var(--jp-bg)',
  },
  barBtnOff: { opacity: 0.4, cursor: 'default' },

  backdrop: {
    position: 'fixed', inset: 0, zIndex: 900,
    background: 'rgba(0,0,0,0.55)',
    display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
  },
  sheet: {
    width: '100%', maxWidth: 480,
    background: 'var(--jp-bg-surface)',
    border: '1px solid rgba(var(--tint-rgb), 0.10)',
    borderRadius: '20px 20px 0 0',
    padding: '8px 0 32px',
    // After the shorthand, never before it — see the note in CLAUDE.md about
    // the six insets a `padding` written later silently threw away.
    paddingBottom: 'calc(32px + var(--safe-bot))',
  },
  grabber: {
    width: 36, height: 4, borderRadius: 2,
    background: 'rgba(var(--tint-rgb), 0.18)',
    margin: '4px auto 10px',
  },
  // v1.1.43.0 — the merge confirmation. Names grepped against this map
  // before insertion: a duplicate key is an esbuild WARNING and the later
  // value silently wins (CLAUDE.md, and two DspTab rules that had never
  // applied).
  confirmHead: {
    display: 'flex', alignItems: 'center', gap: 9,
    padding: '4px 4px 10px', fontSize: 16, fontWeight: 700,
    color: 'var(--text-primary)',
  },
  confirmIcon: { color: 'var(--amber)', flexShrink: 0 },
  confirmBody: {
    padding: '0 4px 8px', fontSize: 14, lineHeight: 1.5,
    color: 'var(--text-secondary)',
  },
  discList: {
    listStyle: 'none', margin: '0 0 10px', padding: 0,
    display: 'flex', flexDirection: 'column', gap: 2,
  },
  discRow: {
    display: 'flex', alignItems: 'baseline', gap: 10,
    padding: '7px 10px', borderRadius: 6,
    background: 'rgba(var(--tint-rgb), 0.05)',
  },
  discNum: {
    fontSize: 12, fontWeight: 700, color: 'var(--accent)',
    fontFamily: 'var(--font-mono)', flexShrink: 0, minWidth: '4.2em',
  },
  discName: {
    fontSize: 14, color: 'var(--text-primary)',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  confirmNote: {
    padding: '0 4px 12px', fontSize: 13, lineHeight: 1.5,
    color: 'var(--text-tertiary)',
  },
  confirmGo: {
    width: '100%', minHeight: 'var(--tap-min)',
    padding: '11px 14px', borderRadius: 'var(--radius-sm)',
    background: 'var(--accent)', color: 'var(--on-accent)',
    border: 'none', fontSize: 15, fontWeight: 700, fontFamily: 'inherit',
    cursor: 'pointer', marginBottom: 8,
  },
  tickNum: {
    fontSize: 12, fontWeight: 800, lineHeight: 1,
    fontFamily: 'var(--font-mono)', color: 'inherit',
  },
  sheetTitle: {
    padding: '0 18px 10px',
    fontSize: 12, fontWeight: 700, letterSpacing: '0.08em',
    textTransform: 'uppercase', color: 'var(--jp-text-3)',
  },
  error: {
    margin: '0 18px 8px', padding: '8px 10px', borderRadius: 6,
    fontSize: 13, lineHeight: 1.45,
    background: 'rgba(255,59,92,0.10)',
    border: '1px solid rgba(255,59,92,0.32)',
    color: 'var(--jp-text-2)',
  },
  item: {
    display: 'flex', alignItems: 'center', gap: 12,
    width: '100%', padding: '13px 18px',
    background: 'transparent', border: 'none',
    textAlign: 'left', color: 'var(--jp-text)',
    fontSize: 15, fontFamily: 'inherit', cursor: 'pointer',
  },
  itemOff: { opacity: 0.4, cursor: 'default' },
  itemIcon: { color: 'var(--jp-text-2)', flexShrink: 0 },
  itemNote: {
    marginLeft: 'auto', fontSize: 12,
    color: 'var(--jp-text-3)', fontFamily: 'var(--font-mono)',
  },
  close: {
    display: 'block', width: 'calc(100% - 36px)',
    margin: '10px 18px 0', padding: '11px 0',
    background: 'transparent',
    border: '1px solid var(--jp-border-hot)',
    borderRadius: 999,
    color: 'var(--jp-text-2)', fontSize: 14, fontWeight: 600,
    fontFamily: 'inherit', cursor: 'pointer',
  },

  tick: {
    position: 'absolute', top: 6, left: 6, zIndex: 2,
    width: 22, height: 22, borderRadius: '50%',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    // The empty circle sits over ARTWORK, so it cannot take its colours from
    // the palette: a light-theme tick drawn in the light-theme tint would
    // vanish on a pale sleeve, and a dark one on a dark sleeve. A white ring
    // on a dark scrim reads on both — the same reasoning as the share chip
    // over album art. Fixed on purpose, and listed as such in themes.test.js.
    background: 'rgba(0,0,0,0.45)',
    border: '2px solid #fff',
    color: 'transparent',
    boxShadow: '0 1px 4px rgba(0,0,0,0.5)',
  },
  // Ticked, it is an accent fill like any other, so the mark on it is the
  // palette's own on-accent rather than a second hard-coded white.
  tickOn: {
    background: 'var(--accent)',
    borderColor: 'var(--accent)',
    color: 'var(--on-accent)',
  },
}
