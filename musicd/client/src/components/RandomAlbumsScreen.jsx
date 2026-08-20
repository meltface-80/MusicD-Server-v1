import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { RefreshCw } from 'lucide-react'

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
        <button
          style={{ ...s.refresh, ...(loading ? s.refreshBusy : {}) }}
          onClick={load}
          disabled={loading}
          aria-label="Refresh"
        >
          <RefreshCw size={15} style={loading ? s.refreshSpin : undefined} />
          <span>Refresh</span>
        </button>
      </div>

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
                onClick={() => onAlbumSelect && onAlbumSelect(a.id)}
              />
            ))}
      </div>

      {!loading && !error && albums.length === 0 && (
        <div style={s.empty}>No albums in the library yet.</div>
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

function AlbumTile({ album, onClick }) {
  const [imgErr, setImgErr] = useState(false)
  return (
    <button style={s.tile} onClick={onClick}>
      <div style={s.art}>
        {album.cover_art && !imgErr
          ? <img
              src={album.cover_art}
              alt=""
              style={s.img}
              onError={() => setImgErr(true)}
              draggable={false}
            />
          : <div style={s.artEmpty}>♫</div>}
      </div>
      <div style={s.title}>{album.title}</div>
      <div style={s.artist}>{album.album_artist || album.artist}</div>
    </button>
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
    width: '100%', aspectRatio: '1 / 1',
    borderRadius: 5, overflow: 'hidden',
    background: 'var(--bg-overlay)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    marginBottom: 5,
    boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
  },
  artSkeleton: { background: 'var(--bg-elevated)' },
  artEmpty: { fontSize: 24, color: 'rgba(255,255,255,0.2)' },
  img: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
  title: {
    fontSize: 11, fontWeight: 700, color: 'var(--text-primary)',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
    marginBottom: 1,
  },
  artist: {
    fontSize: 10, color: 'var(--text-secondary)',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  skelLine: {
    height: 9, borderRadius: 3, marginBottom: 4,
    background: 'var(--bg-elevated)',
  },
  empty: {
    padding: '18px 0', color: 'var(--text-tertiary)',
    fontSize: 12, lineHeight: 1.5,
  },
}
