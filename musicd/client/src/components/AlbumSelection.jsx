import React, { useCallback, useState } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import { Play, ListMusic, Plus, Shuffle, Bookmark, X, CheckSquare } from 'lucide-react'

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
]

// Selection state. A Set of album ids plus the mode flag — kept here rather
// than in each grid so both grids cannot drift on what "selected" means.
export function useAlbumSelection() {
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState(() => new Set())

  const toggle = useCallback((id) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }, [])

  const enter = useCallback((id = null) => {
    setSelecting(true)
    setSelected(id == null ? new Set() : new Set([id]))
  }, [])

  const exit = useCallback(() => {
    setSelecting(false)
    setSelected(new Set())
  }, [])

  return { selecting, selected, count: selected.size, toggle, enter, exit }
}

// Run one action against a set of album ids.
//
// Async and awaited by the caller, because the tracks have to be fetched
// first: the grid rows carry no track list, only counts.
export async function runSelectionAction(action, ids) {
  const list = [...ids]
  if (list.length === 0) return { ok: false, reason: 'empty' }

  const store = useStore.getState()
  const spec = SELECTION_ACTIONS.find(a => a.id === action)
  if (!spec) return { ok: false, reason: 'unknown-action' }
  if (spec.needsRenderer && !store.rendererId) {
    return { ok: false, reason: 'no-renderer' }
  }

  // Save for later never needs the tracks — it is an album-level flag, and
  // fetching a thousand track rows to set it would be wasted work.
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
export function SelectionSheet({ count, onClose, onPick, error }) {
  const rendererId = useStore(st => st.rendererId)
  return (
    <div style={s.backdrop} onClick={onClose}>
      <div style={s.sheet} onClick={e => e.stopPropagation()}>
        <div style={s.grabber} />
        <div style={s.sheetTitle}>
          {count} album{count === 1 ? '' : 's'} selected
        </div>
        {error && <div style={s.error}>{error}</div>}
        {SELECTION_ACTIONS.map(({ id, label, icon: Icon, needsRenderer }) => {
          // The three that start playback are disabled with no output chosen,
          // rather than failing after the tap with an alert.
          const off = needsRenderer && !rendererId
          return (
            <button
              key={id}
              style={{ ...s.item, ...(off ? s.itemOff : {}) }}
              onClick={() => !off && onPick(id)}
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
export function SelectionTick({ on }) {
  return (
    <span style={{ ...s.tick, ...(on ? s.tickOn : {}) }} aria-hidden="true">
      {on && (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" strokeWidth="3.5"
             strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
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
    fontSize: 13, fontWeight: 600, color: 'var(--jp-accent)',
    fontFamily: 'var(--font-mono)',
  },
  barBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0,
    padding: '6px 12px', borderRadius: 999,
    background: 'transparent',
    border: '1px solid var(--jp-border-hot)',
    color: 'var(--jp-text-2)',
    fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
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
  sheetTitle: {
    padding: '0 18px 10px',
    fontSize: 11, fontWeight: 700, letterSpacing: '0.08em',
    textTransform: 'uppercase', color: 'var(--jp-text-3)',
  },
  error: {
    margin: '0 18px 8px', padding: '8px 10px', borderRadius: 6,
    fontSize: 12, lineHeight: 1.45,
    background: 'rgba(255,59,92,0.10)',
    border: '1px solid rgba(255,59,92,0.32)',
    color: 'var(--jp-text-2)',
  },
  item: {
    display: 'flex', alignItems: 'center', gap: 12,
    width: '100%', padding: '13px 18px',
    background: 'transparent', border: 'none',
    textAlign: 'left', color: 'var(--jp-text)',
    fontSize: 14, fontFamily: 'inherit', cursor: 'pointer',
  },
  itemOff: { opacity: 0.4, cursor: 'default' },
  itemIcon: { color: 'var(--jp-text-2)', flexShrink: 0 },
  itemNote: {
    marginLeft: 'auto', fontSize: 11,
    color: 'var(--jp-text-3)', fontFamily: 'var(--font-mono)',
  },
  close: {
    display: 'block', width: 'calc(100% - 36px)',
    margin: '10px 18px 0', padding: '11px 0',
    background: 'transparent',
    border: '1px solid var(--jp-border-hot)',
    borderRadius: 999,
    color: 'var(--jp-text-2)', fontSize: 13, fontWeight: 600,
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
