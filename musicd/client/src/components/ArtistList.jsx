import React, { useEffect, useState } from 'react'
import { api } from '../api'

// v1.1.0.65 — JPLAY-style artist list. The hueFromName helper that
// gave each artist's avatar a unique chromatic gradient is no longer
// used: JPLAY's monochrome aesthetic doesn't permit per-artist
// colour. Avatars without a real logo now show the artist's
// initials on a flat near-black tile with a subtle border, matching
// the discipline of the album grid.

export default function ArtistList({ onArtistClick }) {
  const [artists, setArtists] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.get('/library/artists?limit=2000')
      .then(setArtists)
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div style={s.loadWrap}><div style={s.spinner} /></div>

  return (
    <div style={s.page}>
      <div style={s.header}>
        <h1 style={s.heading}>Artists</h1>
        <div style={s.sub}>{artists.length} artist{artists.length !== 1 ? 's' : ''}</div>
      </div>
      <div className="jp-artist-grid" style={s.grid}>
        {artists.map(a => (
          <ArtistCard key={a.name} artist={a} onClick={() => onArtistClick(a.name)} />
        ))}
      </div>
    </div>
  )
}

function ArtistCard({ artist, onClick }) {
  const words = (artist.name || '').split(/\s+/).filter(Boolean)
  const initials = words.slice(0, 2).map(w => w[0]?.toUpperCase()).join('') || (artist.name[0]?.toUpperCase() || '?')
  const [imgErr, setImgErr] = React.useState(false)
  const hasLogo = !!artist.has_logo && !imgErr
  const logoSrc = `/api/library/artists/${encodeURIComponent(artist.name)}/logo`
  // Hide the redundant text label only when we have a real (non-typographic) logo
  const isRealLogo = hasLogo && artist.logo_source && artist.logo_source !== 'typographic'
  // Allow names with more than two words to wrap to a second line below the avatar.
  const allowWrap = words.length > 2
  const nameStyle = allowWrap ? s.nameWrap : s.name
  return (
    <button style={s.card} onClick={onClick}>
      <div style={s.avatar}>
        {hasLogo
          ? <img src={logoSrc} alt={artist.name} style={s.logo} onError={() => setImgErr(true)} draggable={false} />
          : <span style={s.initials}>{initials}</span>
        }
      </div>
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
}
