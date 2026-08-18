import React, { useEffect, useState } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import { Music2, Disc3, Mic2 } from 'lucide-react'

function fmtTime(s) {
  if (!s) return ''
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}

export default function SearchResults({ onArtistClick }) {
  const { searchQuery, rendererId, setSelectedAlbum, playQueue, setSearchQuery } = useStore()
  const [results, setResults] = useState({ tracks: [], albums: [], artists: [] })
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!searchQuery.trim()) { setResults({ tracks: [], albums: [], artists: [] }); return }
    setLoading(true)
    const t = setTimeout(async () => {
      try {
        const q = encodeURIComponent(searchQuery)
        const [tracks, albums, artists] = await Promise.all([
          api.get(`/library/search?q=${q}&type=tracks`),
          api.get(`/library/search?q=${q}&type=albums`),
          api.get(`/library/search?q=${q}&type=artists`),
        ])
        setResults({ tracks, albums, artists })
      } catch {}
      setLoading(false)
    }, 250)
    return () => clearTimeout(t)
  }, [searchQuery])

  const handleTrackPlay = (track, index, allTracks) => {
    if (!rendererId) {
      alert('Tap ☰ → Output to select a renderer first')
      return
    }
    playQueue(allTracks, index)
  }

  const handleAlbumOpen = (album) => {
    setSelectedAlbum(album.id)
    setSearchQuery('')
  }

  const handleArtistOpen = (artistName) => {
    if (onArtistClick) onArtistClick(artistName)
    setSearchQuery('')
  }

  const total = results.tracks.length + results.albums.length + results.artists.length

  if (loading) return <div style={s.loading}><div style={s.spinner} /></div>
  if (!searchQuery.trim()) return null

  return (
    <div style={s.page}>
      <div style={s.header}>
        <span style={s.heading}>"{searchQuery}"</span>
        <span style={s.count}>{total} result{total !== 1 ? 's' : ''}</span>
      </div>

      {total === 0 && (
        <div style={s.empty}>No results found</div>
      )}

      {/* Artists */}
      {results.artists.length > 0 && (
        <Section title="Artists" icon={<Mic2 size={13} />}>
          {results.artists.map((a, i) => (
            <button key={i} style={s.artistRow} onClick={() => handleArtistOpen(a.name)}>
              <div style={s.artistAvatar}>{(a.name || '?')[0].toUpperCase()}</div>
              <div style={s.artistInfo}>
                <span style={s.artistName}>{a.name}</span>
                <span style={s.artistCount}>{a.album_count} album{a.album_count !== 1 ? 's' : ''}</span>
              </div>
              <span style={s.chevron}>›</span>
            </button>
          ))}
        </Section>
      )}

      {/* Albums */}
      {results.albums.length > 0 && (
        <Section title="Albums" icon={<Disc3 size={13} />}>
          <div className="album-grid">
            {results.albums.map(album => (
              <button key={album.id} style={s.albumCard} onClick={() => handleAlbumOpen(album)}>
                <div style={s.albumArt}>
                  {album.cover_art
                    ? <img src={album.cover_art} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                    : <span style={{ fontSize: 20, color: 'var(--text-muted)' }}>♫</span>
                  }
                </div>
                <div style={s.albumTitle}>{album.title}</div>
                <div style={s.albumArtist}>{album.album_artist || album.artist}</div>
              </button>
            ))}
          </div>
        </Section>
      )}

      {/* Tracks */}
      {results.tracks.length > 0 && (
        <Section title="Tracks" icon={<Music2 size={13} />}>
          {results.tracks.map((track, i) => (
            <button key={track.id} style={s.trackRow}
              onClick={() => handleTrackPlay(track, i, results.tracks)}>
              <span style={s.trackNum}>{i + 1}</span>
              <span style={s.trackInfo}>
                <span style={s.trackTitle}>{track.title}</span>
                <span style={s.trackMeta}>{track.artist}{track.album ? ` · ${track.album}` : ''}</span>
              </span>
              <span style={s.trackFmt}>{(track.codec || track.format || '').toUpperCase()}</span>
              <span style={s.trackDur}>{fmtTime(track.duration)}</span>
            </button>
          ))}
        </Section>
      )}
    </div>
  )
}

function Section({ title, icon, children }) {
  return (
    <div style={s.section}>
      <div style={s.sectionHeader}>{icon}<span>{title}</span></div>
      {children}
    </div>
  )
}

const s = {
  page: { padding: '16px 12px 120px' },
  loading: { display: 'flex', justifyContent: 'center', paddingTop: 60 },
  spinner: { width: 22, height: 22, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' },
  header: { display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 20 },
  heading: { fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' },
  count: { fontSize: 12, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' },
  empty: { paddingTop: 40, textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13 },
  section: { marginBottom: 28 },
  sectionHeader: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, color: 'var(--text-tertiary)', fontSize: 11, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase' },

  // Artists
  artistRow: { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 4px', background: 'none', border: 'none', width: '100%', cursor: 'pointer', borderBottom: '1px solid var(--border)', textAlign: 'left' },
  artistAvatar: { width: 38, height: 38, borderRadius: '50%', background: 'var(--accent-dim)', color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 700, flexShrink: 0 },
  artistInfo: { flex: 1, display: 'flex', flexDirection: 'column', gap: 2 },
  artistName: { fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' },
  artistCount: { fontSize: 11, color: 'var(--text-tertiary)' },
  chevron: { fontSize: 18, color: 'var(--text-tertiary)', paddingRight: 4 },

  // Albums
  albumGrid: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 },
  albumCard: { background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' },
  albumArt: { width: '100%', aspectRatio: '1', borderRadius: 8, overflow: 'hidden', background: 'var(--bg-elevated)', marginBottom: 5, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  albumTitle: { fontSize: 11, fontWeight: 500, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  albumArtist: { fontSize: 10, color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },

  // Tracks
  trackRow: { display: 'grid', gridTemplateColumns: '28px 1fr auto 46px', alignItems: 'center', gap: 8, padding: '9px 4px', background: 'none', border: 'none', cursor: 'pointer', width: '100%', borderBottom: '1px solid var(--border)', textAlign: 'left' },
  trackNum: { fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', textAlign: 'right' },
  trackInfo: { display: 'flex', flexDirection: 'column', gap: 2, overflow: 'hidden' },
  trackTitle: { fontSize: 13, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  trackMeta: { fontSize: 10, color: 'var(--text-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  trackFmt: { fontSize: 9, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)' },
  trackDur: { fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', textAlign: 'right' },
}
