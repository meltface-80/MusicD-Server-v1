import React, { useEffect, useState, useRef } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import { ArrowLeft, Play, Plus, BookOpen } from 'lucide-react'
import BioModal from './BioModal'
import ServiceBadge from './ServiceBadge'
import VersionBadge from './VersionBadge'
import AlbumTile from './AlbumTile'

export default function ArtistAlbums({ artist, onBack, onAlbumSelect, hideBack = false }) {
  const { rendererId, playQueue, appendToQueue } = useStore()
  const [albums, setAlbums] = useState([])
  const [collabs, setCollabs] = useState([])
  const [loading, setLoading] = useState(true)
  const [actionBusy, setActionBusy] = useState(false)
  // Bio modal for the artist (#30.23). Updated #30.24 to gate the
  // About button on whether the artist has a known MBID. Without
  // an MBID the bio fetcher returns no_mbid; showing a clearly
  // disabled-with-explanation button is more helpful than a button
  // that always opens to a "no match" message.
  const [showBio, setShowBio] = useState(false)
  const [artistInfo, setArtistInfo] = useState(null)

  useEffect(() => {
    setLoading(true)
    // v1.1.34.0 — artist pages collapse album versions too. This is the
    // page where duplicates are most obvious: three Moon Safari tiles in
    // a row of one artist's records. Server-side the setting still
    // decides; this only marks the surface as one that may collapse.
    api.get(`/library/albums?artist=${encodeURIComponent(artist)}&sort=year&limit=500&versions=collapse`)
      .then(all => {
        const primary = all.filter(a => a.album_artist === artist)
        const collab = all.filter(a => a.album_artist !== artist)
        setAlbums(primary)
        setCollabs(collab)
      })
      .finally(() => setLoading(false))
    // Parallel fetch for artist info (MBID, logo). 404s are fine
    // for an artist row that doesn't exist yet; the button just
    // stays disabled.
    api.get(`/library/artists/${encodeURIComponent(artist)}`)
      .then(setArtistInfo)
      .catch(() => setArtistInfo(null))
  }, [artist])

  const handleOpen = (albumId) => {
    if (onAlbumSelect) onAlbumSelect(albumId)
  }

  // Build the full track list for this artist's catalogue, ordered to match
  // the on-screen layout (Albums first by year, then Collaborations).
  // We use the dedicated server endpoint to do this in a single round-trip
  // rather than fetching every album's tracks individually.
  const fetchAllTracks = async () => {
    // Two calls: primary (albums where this artist is the album_artist) and
    // collaborations (everything else). Concatenated in display order.
    const url = (primary) =>
      `/library/artists/${encodeURIComponent(artist)}/tracks?sort=year&primary=${primary ? 1 : 0}`
    const [primaryResp, allResp] = await Promise.all([
      api.get(url(true)),
      api.get(url(false)),
    ])
    const primaryIds = new Set((primaryResp?.tracks || []).map(t => t.id))
    const collabTracks = (allResp?.tracks || []).filter(t => !primaryIds.has(t.id))
    return [...(primaryResp?.tracks || []), ...collabTracks]
  }

  const handlePlayAll = async () => {
    if (!rendererId) { alert('Tap ☰ → Output to select a renderer first'); return }
    setActionBusy(true)
    try {
      const tracks = await fetchAllTracks()
      if (tracks.length) playQueue(tracks, 0)
    } finally { setActionBusy(false) }
  }

  const handleQueueAll = async () => {
    setActionBusy(true)
    try {
      const tracks = await fetchAllTracks()
      if (tracks.length) appendToQueue(tracks)
    } finally { setActionBusy(false) }
  }

  const total = albums.length + collabs.length

  return (
    <div style={s.page}>
      {!hideBack && (
        <button style={s.back} onClick={onBack}>
          <ArrowLeft size={14} /><span>Artists</span>
        </button>
      )}

      <div style={s.header}>
        <h2 style={s.heading}>{artist}</h2>
        <div style={s.sub}>{loading ? '…' : `${total} album${total !== 1 ? 's' : ''}`}</div>
      </div>

      {/* Play-all / queue-all action row (#12) — only shown when there are albums.
          Bio "About" pill (#30.23) sits alongside since it's a related action
          on the artist as a whole. The modal handles empty states gracefully
          so we don't need to know up front whether a bio is available. */}
      {!loading && total > 0 && (
        <div style={s.actionRow}>
          <button style={s.playAllBtn} onClick={handlePlayAll} disabled={actionBusy}>
            <Play size={13} fill="currentColor" strokeWidth={0} />
            Play all
          </button>
          <button style={s.queueAllBtn} onClick={handleQueueAll} disabled={actionBusy}>
            <Plus size={13} />
            Queue all
          </button>
          <button
            style={{ ...s.bioBtn, ...(artistInfo?.mb_artist_id ? {} : s.bioBtnDisabled) }}
            onClick={() => setShowBio(true)}
            disabled={!artistInfo?.mb_artist_id}
            title={artistInfo?.mb_artist_id
              ? 'About this artist'
              : 'Bio requires this artist to have a MusicBrainz ID. Run "Fetch missing logos" in Settings → Metadata Refresh -- it resolves artist MBIDs as a side effect.'}
          >
            <BookOpen size={13} />
            About
          </button>
        </div>
      )}

      {/* Bio modal (#30.23). Loaded lazily; modal mounts and fetches.
          Artists without an MBID get a friendly "no match" message
          rather than a broken state. */}
      {showBio && (
        <BioModal
          kind="artist"
          id={artist}
          title={artist}
          onClose={() => setShowBio(false)}
        />
      )}

      {loading ? (
        <div style={s.loadWrap}><div style={s.spinner} /></div>
      ) : (
        <>
          {albums.length > 0 && (
            <Section title="Albums" count={albums.length}>
              <AlbumGrid albums={albums} onOpen={handleOpen} />
            </Section>
          )}
          {collabs.length > 0 && (
            <Section title="Collaborations" count={collabs.length}>
              <AlbumGrid albums={collabs} onOpen={handleOpen} showArtist />
            </Section>
          )}
          {total === 0 && (
            <div style={s.empty}>No albums found</div>
          )}
        </>
      )}
    </div>
  )
}

function Section({ title, count, children }) {
  return (
    <div style={s.section}>
      <div style={s.sectionHeader}>
        <span style={s.sectionTitle}>{title}</span>
        <span style={s.sectionCount}>{count}</span>
      </div>
      {children}
    </div>
  )
}

function AlbumGrid({ albums, onOpen, showArtist }) {
  return (
    <div className="album-grid">
      {albums.map(album => (
        <AlbumCard key={album.id} album={album} onOpen={onOpen} showArtist={showArtist} />
      ))}
    </div>
  )
}

// v1.1.34.0 — the shared tile. This page kept its own copy, which is
// why the Qobuz / Tidal glyph added in v1.1.33.0 was missing here.
function AlbumCard({ album, onOpen, showArtist }) {
  return (
    <AlbumTile
      album={album}
      onClick={() => onOpen(album.id)}
      showArtist={!!showArtist}
    />
  )
}

const s = {
  // v1.1.0.65 — JPLAY-style artist-page layout. Pure black ground,
  // 20/16 padding to match AlbumGrid (was 14/10 with no bg). Heading
  // 24/600 (was 22/700). Section headers and card text follow the
  // same JPLAY token discipline as AlbumGrid + AlbumDetail.
  page: { padding: '20px 16px 120px', background: 'var(--jp-bg)', minHeight: '100%' },
  back: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--jp-text-3)', marginBottom: 14, background: 'none', border: 'none', cursor: 'pointer' },
  header: { marginBottom: 16 },
  heading: { fontSize: 24, fontWeight: 600, letterSpacing: '-0.3px', marginBottom: 4, color: 'var(--jp-text)' },
  sub: { fontSize: 11, color: 'var(--jp-text-3)', fontFamily: 'var(--font-mono)' },
  actionRow: { display: 'flex', gap: 8, marginBottom: 22, flexWrap: 'wrap' },
  // White-fill primary action — matches AlbumDetail's Play button.
  playAllBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '8px 14px', borderRadius: 999,
    background: 'var(--jp-accent)', color: 'var(--jp-bg)',
    fontSize: 12, fontWeight: 600,
    border: 'none', cursor: 'pointer',
  },
  // Outline-style secondary action — quiet white-on-translucent.
  queueAllBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '8px 13px', borderRadius: 999,
    background: 'transparent', color: 'var(--jp-text-2)',
    fontSize: 12, fontWeight: 500,
    border: '1px solid var(--jp-border-hot)', cursor: 'pointer',
  },
  bioBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '8px 13px', borderRadius: 999,
    background: 'transparent', color: 'var(--jp-text-2)',
    fontSize: 12, fontWeight: 500,
    border: '1px solid var(--jp-border)', cursor: 'pointer',
  },
  bioBtnDisabled: {
    opacity: 0.4,
    cursor: 'not-allowed',
  },
  infoBtn: { width: 32, height: 32, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', color: 'var(--jp-text-2)', border: '1px solid var(--jp-border)', cursor: 'pointer', flexShrink: 0 },
  loadWrap: { display: 'flex', justifyContent: 'center', paddingTop: 60 },
  spinner: { width: 22, height: 22, border: '2px solid var(--jp-border)', borderTopColor: 'var(--jp-accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' },
  empty: { paddingTop: 40, textAlign: 'center', color: 'var(--jp-text-3)', fontSize: 13 },
  // Section: lighter divider (was solid var(--border) at 10%
  // white). JPLAY uses barely-there dividers — just enough to
  // structure the page without drawing borders into the eye.
  section: { marginBottom: 28 },
  sectionHeader: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, paddingBottom: 6, borderBottom: '1px solid var(--jp-border)' },
  sectionTitle: { fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--jp-text-2)' },
  sectionCount: { fontSize: 11, color: 'var(--jp-text-3)', fontFamily: 'var(--font-mono)' },
  grid: { /* layout via .album-grid in index.css (now JPLAY-tuned) */ },
  // (cardYear retained as an inert style for any leftover callers
  // but no longer rendered — year was dropped from the card to
  // match the JPLAY library aesthetic.)
  cardYear: { display: 'none' },
}
