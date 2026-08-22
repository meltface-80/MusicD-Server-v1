import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { RefreshCw } from 'lucide-react'
// v1.1.34.0 — the shared album tile. This screen had a local component of
// the same name: the fourth copy of an album tile in the app, and one more
// place the streaming glyph and the version badge would have had to be
// added by hand.
import AlbumTile from './AlbumTile'
import {
  useAlbumSelection, runSelectionAction,
  SelectChip, SelectionBar, SelectionSheet, SelectionTick,
} from './AlbumSelection'

// The full Random-albums wall (v1.1.21.0).
//
// Reached by tapping the "Random albums" heading on the Home screen. Three
// across and five down — fifteen albums, one screenful, no scrolling on a
// phone — with a Refresh at the top for another roll. Modelled on
// MusicD-Remote's random wall, which is where the shape and the refresh
// affordance come from; that build fits its rows to the viewport, this one
// pins 3x5 because that is what was asked for.
//
// Back navigation is the app shell's: this is sidebar section 'random', so
// the top bar's chevron already returns to Home.
const COLS = 3
const ROWS = 5
const COUNT = COLS * ROWS

export default function RandomAlbumsScreen({ onAlbumSelect }) {
  const [albums, setAlbums] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // v1.1.29.0 — the same multi-select the album wall has, from the same
  // module. Two grids drawing the same tiles with two implementations is how
  // the volume sheet and the queue view each ended up in two copies.
  const selection = useAlbumSelection()
  const [selectionSheet, setSelectionSheet] = useState(false)
  const [selectionBusy, setSelectionBusy] = useState(false)
  const [selectionError, setSelectionError] = useState(null)

  const runSelection = async (action) => {
    setSelectionBusy(true)
    setSelectionError(null)
    const r = await runSelectionAction(action, selection.selected)
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
  }

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    api.get(`/library/albums/random-set?limit=${COUNT}`)
      .then(a => { setAlbums(a || []); setLoading(false) })
      .catch(e => { setError(e.message || "Couldn't load albums"); setLoading(false) })
  }, [])

  useEffect(() => { load() }, [load])

  return (
    <div style={s.page}>
      <div style={s.titleRow}>
        <h1 style={s.heading}>Random albums</h1>
        <div style={s.titleActions}>
          {/* Refresh is hidden while selecting: re-rolling the wall would
              throw away the albums the user has just ticked, and they would
              have no way to get them back. */}
          {!selection.selecting && (
            <>
              <SelectChip
                selecting={selection.selecting}
                onToggle={() => selection.enter()}
                chipStyle={s.refresh}
                activeStyle={s.refreshOn}
              />
              <button
                style={{ ...s.refresh, ...(loading ? s.refreshBusy : {}) }}
                onClick={load}
                disabled={loading}
                aria-label="Refresh"
              >
                <RefreshCw size={15} style={loading ? s.refreshSpin : undefined} />
                <span>Refresh</span>
              </button>
            </>
          )}
        </div>
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

      {/* Skeletons rather than a spinner: the grid keeps its shape between
          rolls, so tapping Refresh does not collapse the page and bounce the
          scroll position back to the top. */}
      <div style={s.grid}>
        {loading && albums.length === 0
          ? Array.from({ length: COUNT }, (_, i) => <SkeletonTile key={`sk${i}`} />)
          : albums.map(a => (
              <AlbumTile
                key={a.id}
                album={a}
                selecting={selection.selecting}
                selected={selection.selected.has(a.id)}
                onClick={() => {
                  if (selection.selecting) { selection.toggle(a.id); return }
                  onAlbumSelect && onAlbumSelect(a.id)
                }}
              />
            ))}
      </div>

      {!loading && !error && albums.length === 0 && (
        <div style={s.empty}>No albums in the library yet.</div>
      )}

      {selectionSheet && (
        <SelectionSheet
          count={selection.count}
          error={selectionError}
          onClose={() => { setSelectionSheet(false); setSelectionError(null) }}
          onPick={runSelection}
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
  refresh: {
    display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
    padding: '7px 12px',
    background: 'var(--bg-elevated)', color: 'var(--text-secondary)',
    border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
    fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
    cursor: 'pointer', whiteSpace: 'nowrap',
  },
  titleActions: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 },
  refreshOn: {
    background: 'var(--accent)', borderColor: 'var(--accent)',
    color: 'var(--on-accent)',
  },
  refreshBusy: { opacity: 0.6, cursor: 'default' },
  refreshSpin: { animation: 'spin 0.8s linear infinite' },

  error: {
    margin: '10px 0 0', padding: '8px 10px', borderRadius: 6, fontSize: 12,
    background: 'rgba(255,59,92,0.08)', border: '1px solid rgba(255,59,92,0.30)',
    color: 'var(--text-secondary)',
  },

  // Three across, and as many rows as there are albums — fifteen of them, so
  // five. Not a fixed gridTemplateRows: a library with fewer than fifteen
  // albums should end after its last one, not leave empty tracks behind.
  grid: {
    display: 'grid', gridTemplateColumns: `repeat(${COLS}, 1fr)`,
    gap: 10, marginTop: 12,
  },
  tile: {
    background: 'none', border: 'none', padding: 0, margin: 0,
    textAlign: 'left', cursor: 'pointer', minWidth: 0,
  },
  art: {
    // position: relative so the selection tick can sit over the artwork.
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
    fontSize: 12, lineHeight: 1.5,
  },
}
