import React, { useEffect, useState } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import { Music2, Disc3, Mic2, Loader2 } from 'lucide-react'
import ServiceBadge from './ServiceBadge'

function fmtTime(s) {
  if (!s) return ''
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}

// v1.1.33.0 — results are local AND catalogue, in one list.
//
// The server merges them (see GET /api/library/search) and orders local
// first, because a result you already own plays instantly and one you do
// not needs a network fetch before it can. Each catalogue result carries
// `service`, which is the only thing this file branches on:
//
//   * a badge next to the title, so you can tell before tapping that a
//     result will go out to Qobuz or Tidal
//   * albums open through the service route, which caches the album into
//     the library on the way and then hands off to the ordinary album
//     page — the same page a local album opens
//   * tracks have no id yet (no local row exists until their album is
//     cached), so tapping one resolves it first and then plays it
//
// Artists are local-only by design: this app's artist screen is built out
// of local album rows, so a catalogue artist would open an empty page.
// Their albums still show up, in the Albums section here.
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

  // Which result is currently being fetched, so the row can say so. One
  // at a time is enough: these are taps, not a queue.
  const [pending, setPending] = useState(null)
  const [actionError, setActionError] = useState(null)

  const handleTrackPlay = async (track, index, allTracks) => {
    if (!rendererId) {
      alert('Tap ☰ → Output to select a renderer first')
      return
    }
    // A local track can be queued as-is. A catalogue track has no local
    // row until its album is cached, so it has no id to queue — resolve
    // it first, which caches the album and returns the real track id.
    if (!track.service) {
      playQueue(allTracks, index)
      return
    }
    setPending(`track:${track.service}:${track.serviceTrackId}`)
    setActionError(null)
    try {
      const r = await api.post(
        `/streaming/${track.service}/track/${encodeURIComponent(track.serviceTrackId)}/resolve`,
        { albumId: track.serviceAlbumId })
      // Queue the single resolved track. Queuing the rest of the result
      // list alongside it would mean resolving every other catalogue row
      // too — a search for one song should not fetch twenty albums.
      playQueue([{ ...track, id: r.trackId }], 0)
    } catch (e) {
      setActionError(e.message || 'Could not play that')
    } finally {
      setPending(null)
    }
  }

  const handleAlbumOpen = async (album) => {
    if (!album.service || album.in_library) {
      setSelectedAlbum(album.id)
      setSearchQuery('')
      return
    }
    // Catalogue album: the row for album.id does not exist yet. The
    // service route creates it, then the ordinary album page opens on it.
    setPending(`album:${album.service}:${album.serviceAlbumId}`)
    setActionError(null)
    try {
      const r = await api.get(
        `/streaming/${album.service}/album/${encodeURIComponent(album.serviceAlbumId)}`)
      setSelectedAlbum(r.localAlbumId || album.id)
      setSearchQuery('')
    } catch (e) {
      setActionError(e.message || 'Could not open that album')
    } finally {
      setPending(null)
    }
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

      {actionError && <div style={s.actionError}>{actionError}</div>}

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
            {results.albums.map(album => {
              const busy = pending === `album:${album.service}:${album.serviceAlbumId}`
              return (
                <button key={album.id} style={s.albumCard} onClick={() => handleAlbumOpen(album)}>
                  <div style={s.albumArt}>
                    {album.cover_art
                      ? <img src={album.cover_art} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} draggable={false} />
                      : <span style={{ fontSize: 20, color: 'var(--text-muted)' }}>♫</span>
                    }
                    {busy && (
                      <span style={s.busyOverlay}>
                        <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} />
                      </span>
                    )}
                  </div>
                  <div style={s.albumTitleRow}>
                    {album.service && <ServiceBadge service={album.service} size={12} />}
                    <span style={s.albumTitle}>{album.title}</span>
                  </div>
                  <div style={s.albumArtist}>{album.album_artist || album.artist}</div>
                </button>
              )
            })}
          </div>
        </Section>
      )}

      {/* Tracks */}
      {results.tracks.length > 0 && (
        <Section title="Tracks" icon={<Music2 size={13} />}>
          {results.tracks.map((track, i) => {
            const busy = pending === `track:${track.service}:${track.serviceTrackId}`
            return (
              // Local rows key on their track id; catalogue rows have none
              // yet, so they key on service + service track id. Using the
              // index alone would re-use a row across two different searches.
              <button key={track.id || `${track.service}:${track.serviceTrackId}`} style={s.trackRow}
                onClick={() => handleTrackPlay(track, i, results.tracks)}>
                <span style={s.trackNum}>
                  {busy
                    ? <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} />
                    : i + 1}
                </span>
                <span style={s.trackInfo}>
                  <span style={s.trackTitleRow}>
                    {track.service && <ServiceBadge service={track.service} size={12} />}
                    <span style={s.trackTitle}>{track.title}</span>
                  </span>
                  <span style={s.trackMeta}>{track.artist}{track.album ? ` · ${track.album}` : ''}</span>
                </span>
                <span style={s.trackFmt}>{(track.codec || track.format || '').toUpperCase()}</span>
                <span style={s.trackDur}>{fmtTime(track.duration)}</span>
              </button>
            )
          })}
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
  albumArt: { position: 'relative', width: '100%', aspectRatio: '1', borderRadius: 8, overflow: 'hidden', background: 'var(--bg-elevated)', marginBottom: 5, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  // v1.1.33.0 — badge + title share a row so the glyph sits with the
  // title rather than floating over the artwork, where at 12px it would
  // compete with the tile's own corner marker in the album wall.
  albumTitleRow: { display: 'flex', alignItems: 'center', gap: 4, overflow: 'hidden' },
  trackTitleRow: { display: 'flex', alignItems: 'center', gap: 5, overflow: 'hidden' },
  // Themed rather than a fixed dark scrim — see the same overlay in
  // ServiceScreen.jsx for why this app cannot assume a dark ground.
  busyOverlay: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--jp-bg)', opacity: 0.82, color: 'var(--jp-text)' },
  actionError: { margin: '0 0 16px', padding: '9px 11px', borderRadius: 6, fontSize: 12, color: 'var(--jp-hot)', background: 'rgba(255,90,90,0.08)' },
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
