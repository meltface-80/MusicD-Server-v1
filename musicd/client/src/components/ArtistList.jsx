import React, { useEffect, useState } from 'react'
import { api } from '../api'
import { LayoutGrid, List } from 'lucide-react'
import { loadArtistView, saveArtistView } from '../artistView'

// v1.1.0.65 — JPLAY-style artist list. The hueFromName helper that
// gave each artist's avatar a unique chromatic gradient is no longer
// used: JPLAY's monochrome aesthetic doesn't permit per-artist
// colour. Avatars without a real logo now show the artist's
// initials on a flat near-black tile with a subtle border, matching
// the discipline of the album grid.

export default function ArtistList({ onArtistClick }) {
  const [artists, setArtists] = useState([])
  const [loading, setLoading] = useState(true)
  // Read once, at mount, from localStorage — see artistView.js for why it is
  // not component state.
  const [view, setView] = useState(() => loadArtistView())

  useEffect(() => {
    api.get('/library/artists?limit=2000')
      .then(setArtists)
      .finally(() => setLoading(false))
  }, [])

  const choose = (v) => {
    if (v === view) return
    setView(v)
    saveArtistView(v)
  }

  if (loading) return <div style={s.loadWrap}><div style={s.spinner} /></div>

  return (
    <div style={s.page}>
      <div style={s.header}>
        <div style={s.headerRow}>
          <h1 style={s.heading}>Artists</h1>
          {/* v1.1.26.0 — grid or list. Two segments rather than one toggle
              button: a single button would have to show either the state or
              the action, and whichever it showed would read as the other. */}
          <div style={s.viewToggle} role="radiogroup" aria-label="Artist layout">
            <button
              style={{ ...s.viewBtn, ...(view === 'grid' ? s.viewBtnOn : {}) }}
              onClick={() => choose('grid')}
              role="radio"
              aria-checked={view === 'grid'}
              aria-label="Grid"
              title="Grid"
            >
              <LayoutGrid size={15} />
            </button>
            <button
              style={{ ...s.viewBtn, ...(view === 'list' ? s.viewBtnOn : {}) }}
              onClick={() => choose('list')}
              role="radio"
              aria-checked={view === 'list'}
              aria-label="List"
              title="List"
            >
              <List size={15} />
            </button>
          </div>
        </div>
        <div style={s.sub}>{artists.length} artist{artists.length !== 1 ? 's' : ''}</div>
      </div>

      {view === 'list' ? (
        <div style={s.list}>
          {artists.map(a => (
            <ArtistRow key={a.name} artist={a} onClick={() => onArtistClick(a.name)} />
          ))}
        </div>
      ) : (
        <div className="jp-artist-grid" style={s.grid}>
          {artists.map(a => (
            <ArtistCard key={a.name} artist={a} onClick={() => onArtistClick(a.name)} />
          ))}
        </div>
      )}
    </div>
  )
}

// The avatar, shared by both views so a logo that renders in one renders in
// the other. `size` is the only thing that differs — the grid's is a column
// wide, the list's is a fixed circle beside the name.
function ArtistAvatar({ artist, size = null }) {
  const [imgErr, setImgErr] = React.useState(false)
  const words = (artist.name || '').split(/\s+/).filter(Boolean)
  const initials = words.slice(0, 2).map(w => w[0]?.toUpperCase()).join('')
    || (artist.name[0]?.toUpperCase() || '?')
  const hasLogo = !!artist.has_logo && !imgErr
  const logoSrc = `/api/library/artists/${encodeURIComponent(artist.name)}/logo`
  const box = size
    ? { ...s.avatar, width: size, height: size, marginBottom: 0, flexShrink: 0 }
    : s.avatar
  return (
    <div style={box}>
      {hasLogo
        ? <img src={logoSrc} alt={artist.name} style={s.logo} onError={() => setImgErr(true)} draggable={false} />
        : <span style={size ? { ...s.initials, fontSize: Math.round(size * 0.38) } : s.initials}>{initials}</span>
      }
    </div>
  )
}

// v1.1.26.0 — the list row: a mini avatar, the name, and the album count.
//
// The name is ALWAYS written here, even for artists whose logo is the real
// artwork. The grid hides it in that case because the logo says the name; at
// 40px beside a line of text it does not, and a wall of unlabelled circles is
// not a list.
function ArtistRow({ artist, onClick }) {
  return (
    <button style={s.row} onClick={onClick}>
      <ArtistAvatar artist={artist} size={40} />
      <span style={s.rowName}>{artist.name}</span>
      {artist.album_count !== undefined && (
        <span style={s.rowCount}>
          {artist.album_count} album{artist.album_count !== 1 ? 's' : ''}
        </span>
      )}
    </button>
  )
}

function ArtistCard({ artist, onClick }) {
  const words = (artist.name || '').split(/\s+/).filter(Boolean)
  // Hide the redundant text label only when we have a real (non-typographic) logo
  const isRealLogo = !!artist.has_logo && artist.logo_source && artist.logo_source !== 'typographic'
  // Allow names with more than two words to wrap to a second line below the avatar.
  const allowWrap = words.length > 2
  const nameStyle = allowWrap ? s.nameWrap : s.name
  return (
    <button style={s.card} onClick={onClick}>
      <ArtistAvatar artist={artist} />
      {!isRealLogo && (
        <div style={nameStyle}>{artist.name}</div>
      )}
      {artist.album_count !== undefined && (
        <div style={s.count}>{artist.album_count} album{artist.album_count !== 1 ? 's' : ''}</div>
      )}
    </button>
  )
}

const s = {
  // v1.1.0.65 — JPLAY page layout. Pure black ground, generous
  // 20/16 padding matching AlbumGrid.
  page: { padding: '20px 16px 120px', background: 'var(--jp-bg)', minHeight: '100%' },
  loadWrap: { display: 'flex', justifyContent: 'center', paddingTop: 60, background: 'var(--jp-bg)' },
  spinner: { width: 22, height: 22, border: '2px solid var(--jp-border)', borderTopColor: 'var(--jp-accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' },
  header: { marginBottom: 16 },
  headerRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  // Segmented grid/list control. Sized off the same 15px icons the topbar
  // uses so it does not shout next to a 24px heading.
  viewToggle: {
    display: 'flex', flexShrink: 0,
    border: '1px solid var(--jp-border)',
    borderRadius: 999,
    overflow: 'hidden',
  },
  viewBtn: {
    width: 40, height: 30,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'transparent', border: 'none',
    color: 'var(--jp-text-3)',
    cursor: 'pointer', padding: 0,
  },
  viewBtnOn: { background: 'var(--jp-accent)', color: 'var(--jp-bg)' },
  heading: { fontSize: 24, fontWeight: 600, letterSpacing: '-0.3px', margin: 0, color: 'var(--jp-text)' },
  sub: { fontSize: 11, color: 'var(--jp-text-3)', fontFamily: 'var(--font-mono)', marginTop: 2 },
  // 2-col phone, 3 / 4 / 5 at the larger breakpoints — see the
  // .jp-artist-grid class in index.css. Inline grid-template
  // dropped so the className-driven media queries apply
  // unobstructed; an inline rule would always win regardless of
  // viewport width.
  grid: {
    display: 'grid',
    gap: 12,
  },
  card: { background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'center', minWidth: 0, width: '100%' },
  // Avatar tile: flat near-black fill with a 6%-white border. No
  // shadow, no chromatic gradient. Matches the "no card chrome"
  // discipline applied to album tiles in v62.
  avatar: {
    width: '100%', aspectRatio: '1 / 1', borderRadius: '50%',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    marginBottom: 10,
    overflow: 'hidden',
    background: 'var(--jp-bg-surface)',
    border: '1px solid var(--jp-border)',
  },
  logo: { width: '92%', height: '92%', objectFit: 'contain', display: 'block' },
  initials: { fontSize: 28, fontWeight: 500, color: 'var(--jp-text-2)', letterSpacing: '-0.5px' },
  name: { fontSize: 13, fontWeight: 500, color: 'var(--jp-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', lineHeight: 1.25 },
  nameWrap: {
    fontSize: 13, fontWeight: 500, color: 'var(--jp-text)',
    lineHeight: 1.25,
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    wordBreak: 'break-word',
    minHeight: 'calc(1.25em * 2)',
  },
  count: { fontSize: 11, color: 'var(--jp-text-3)', fontFamily: 'var(--font-mono)', marginTop: 3 },

  // ── List view ───────────────────────────────────────────────────────
  // A hairline between rows rather than a card each: at one line per artist
  // the whole point is density, and cards would give back everything the
  // list was chosen for.
  list: { display: 'flex', flexDirection: 'column' },
  row: {
    display: 'flex', alignItems: 'center', gap: 12,
    width: '100%', padding: '8px 2px',
    background: 'none', border: 'none',
    borderBottom: '1px solid var(--jp-border)',
    textAlign: 'left', cursor: 'pointer',
    fontFamily: 'inherit',
  },
  rowName: {
    flex: 1, minWidth: 0,
    fontSize: 14, fontWeight: 500, color: 'var(--jp-text)',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  rowCount: {
    flexShrink: 0,
    fontSize: 11, color: 'var(--jp-text-3)', fontFamily: 'var(--font-mono)',
  },
}
