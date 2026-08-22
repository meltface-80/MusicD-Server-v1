import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import AlbumTile from './AlbumTile'
import {
  useAlbumSelection, runSelectionAction,
  SelectChip, SelectionBar, SelectionSheet,
} from './AlbumSelection'

// The full Recently-added and Recently-played walls (v1.1.43.0).
//
// Reached by tapping either heading on the Home screen. Those two carousels
// used to be the only ones with no way through to a full list — Random
// albums had its wall and a chevron on its heading, and the other two just
// stopped at whatever fitted in a horizontal scroller.
//
// ONE component for both, parameterised by `type`, because they differ in
// exactly three things: the query string, the heading, and the second line
// under each tile. Two files would have been two copies of the multi-select
// plumbing, and this app already has the four-duplicate-album-tile story in
// its history to show where that ends up.
//
// The grid is the shared `.album-grid` class, not a fixed column count. That
// is the deliberate difference from the Random wall, which pins 3x5 because
// it is meant to be exactly one screenful with a Refresh; these two are
// ordinary lists that should look like the main library and get its
// responsive density (3 on a phone, up to 9 on a desktop).
//
// Back navigation is the app shell's: these are sidebar sections, so the top
// bar's chevron already returns to Home.

const LIMIT = 120

const TYPES = {
  added: {
    heading: 'Recently added',
    empty: 'No recently-added albums.',
    verb: 'Added',
  },
  played: {
    heading: 'Recently played',
    empty: 'No recent plays yet — anything you play here will show up.',
    verb: 'Played',
  },
}

// Same wording as the Home carousels'. Duplicated deliberately rather than
// imported: HomeScreen's copy is local to that module, and reaching across
// for a six-line date formatter would couple two screens for no gain.
function relTime(ts) {
  if (!ts) return ''
  const secs = Math.max(0, Math.floor(Date.now() / 1000) - Number(ts))
  if (secs < 60) return 'just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 31) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}

export default function RecentAlbumsScreen({ type, onAlbumSelect }) {
  const spec = TYPES[type] || TYPES.added
  const [albums, setAlbums] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const selection = useAlbumSelection()
  const [selectionSheet, setSelectionSheet] = useState(false)
  const [selectionBusy, setSelectionBusy] = useState(false)
  const [selectionError, setSelectionError] = useState(null)

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    api.get(`/library/albums/recent?type=${type}&limit=${LIMIT}`)
      .then(a => { setAlbums(a || []); setLoading(false) })
      .catch(e => { setError(e.message || "Couldn't load albums"); setLoading(false) })
  }, [type])

  useEffect(() => { load() }, [load])

  const runSelection = async (action) => {
    setSelectionBusy(true)
    setSelectionError(null)
    // Merge is ordered, so it needs the ticks in the order they were made
    // rather than as a set — the first one picked becomes disc 1.
    const r = await runSelectionAction(action, selection.selected, selection.order)
    setSelectionBusy(false)
    if (!r.ok) {
      setSelectionError(
        r.reason === 'no-renderer' ? 'Choose an output first (☰ → Output).'
        : r.reason === 'no-tracks' ? 'Those albums have no playable tracks.'
        : r.error || "That didn't work.")
      return
    }
    setSelectionSheet(false)
    selection.exit()
    // A merge changes what this list contains, so it has to be re-read.
    if (r.reload) load()
  }

  return (
    <div style={s.page}>
      <div style={s.titleRow}>
        <h1 style={s.heading}>{spec.heading}</h1>
        {!selection.selecting && (
          <SelectChip
            selecting={selection.selecting}
            onToggle={() => selection.enter()}
            chipStyle={s.chip}
            activeStyle={s.chipOn}
          />
        )}
      </div>

      {selection.selecting && (
        <SelectionBar
          count={selection.count}
          busy={selectionBusy}
          onCancel={() => { selection.exit(); setSelectionError(null) }}
          onAct={() => { setSelectionError(null); setSelectionSheet(true) }}
        />
      )}

      {error && <div style={s.error}>{error}</div>}

      <div className="album-grid" style={s.grid}>
        {loading && albums.length === 0
          ? Array.from({ length: 12 }, (_, i) => <SkeletonTile key={`sk${i}`} />)
          : albums.map(a => (
              <AlbumTile
                key={a.id}
                album={a}
                subtitle={a.activity_at ? `${spec.verb} ${relTime(a.activity_at)}` : undefined}
                selecting={selection.selecting}
                selected={selection.selected.has(a.id)}
                // The tick shows the position, not just that it is on: with
                // merge in the sheet the ORDER is what decides which album
                // becomes disc 1, and a plain tick would hide that.
                selectionIndex={selection.indexOf(a.id)}
                onClick={() => {
                  if (selection.selecting) { selection.toggle(a.id); return }
                  onAlbumSelect && onAlbumSelect(a.id)
                }}
              />
            ))}
      </div>

      {!loading && !error && albums.length === 0 && (
        <div style={s.empty}>{spec.empty}</div>
      )}

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
    </div>
  )
}

function SkeletonTile() {
  return (
    <div style={s.tile}>
      <div style={{ ...s.art, ...s.artSkeleton }} />
      <div style={s.skelLine} />
      <div style={{ ...s.skelLine, width: '60%' }} />
    </div>
  )
}

const s = {
  // Screens pad themselves for the safe areas; the app shell never does.
  // See the iOS PWA rules in CLAUDE.md.
  page: { padding: '0 16px', paddingBottom: 'calc(120px + var(--safe-bot))' },
  titleRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: 12, paddingTop: 'calc(8px + var(--safe-top))',
  },
  heading: { fontSize: 26, fontWeight: 700, color: 'var(--text-primary)', margin: '8px 0 4px' },
  chip: {
    display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
    padding: '7px 12px',
    background: 'var(--bg-elevated)', color: 'var(--text-secondary)',
    border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
    fontSize: 13, fontWeight: 600, fontFamily: 'inherit',
    cursor: 'pointer', whiteSpace: 'nowrap',
  },
  chipOn: {
    background: 'var(--accent)', borderColor: 'var(--accent)',
    color: 'var(--on-accent)',
  },
  error: {
    margin: '10px 0 0', padding: '8px 10px', borderRadius: 6, fontSize: 13,
    background: 'rgba(255,59,92,0.08)', border: '1px solid rgba(255,59,92,0.30)',
    color: 'var(--text-secondary)',
  },
  // The columns come from the shared .album-grid class; only the top margin
  // is this screen's business.
  grid: { marginTop: 12 },
  tile: {
    background: 'none', border: 'none', padding: 0, margin: 0,
    textAlign: 'left', cursor: 'pointer', minWidth: 0,
  },
  art: {
    position: 'relative',
    width: '100%', aspectRatio: '1 / 1',
    borderRadius: 5, overflow: 'hidden',
    background: 'var(--bg-overlay)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    marginBottom: 5,
    boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
  },
  artSkeleton: { background: 'var(--bg-elevated)' },
  skelLine: {
    height: 9, borderRadius: 3, marginBottom: 4,
    background: 'var(--bg-elevated)',
  },
  empty: {
    padding: '18px 0', color: 'var(--text-tertiary)',
    fontSize: 13, lineHeight: 1.5,
  },
}
