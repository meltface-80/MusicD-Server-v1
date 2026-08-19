import React, { useEffect, useState } from 'react'
import { api } from '../api'
import { ArrowLeft } from 'lucide-react'

// Module-level view cache — same idea as AlbumGrid's page cache.
//
// Tapping an album inside a genre's album list unmounts this whole screen
// (App.jsx swaps in AlbumDetail), and `selectedGenre` went with it: the way
// back landed on the genre browser rather than on the list the album was
// picked from. That also made the scroll position App.jsx remembers wrong
// rather than merely lost — the offset was taken inside the album list and
// would have been restored onto the genre browser.
//
// In memory only, like the other client caches: a page load starts clean.
const _genreViewCache = { genre: null, albums: [], savedAt: 0 };
const GENRE_VIEW_CACHE_TTL_MS = 30 * 60 * 1000;

function readGenreViewCache() {
  if (!_genreViewCache.genre) return null;
  if (Date.now() - _genreViewCache.savedAt > GENRE_VIEW_CACHE_TTL_MS) {
    _genreViewCache.genre = null;
    _genreViewCache.albums = [];
    return null;
  }
  return _genreViewCache;
}

export default function GenreScreen({ onAlbumSelect, initialGenre = null, onInitialConsumed = () => {} }) {
  const [genres, setGenres] = useState([])
  const [loading, setLoading] = useState(true)
  // Read once, at mount. An initialGenre from the AlbumDetail genre pill is
  // an explicit instruction and outranks whatever was last open here.
  const [restoredView] = useState(() => (initialGenre ? null : readGenreViewCache()))
  const [selectedGenre, setSelectedGenre] = useState(restoredView ? restoredView.genre : null)
  const [genreAlbums, setGenreAlbums] = useState(restoredView ? restoredView.albums : [])
  const [loadingAlbums, setLoadingAlbums] = useState(false)

  useEffect(() => {
    api.get('/library/genres')
      .then(setGenres)
      .finally(() => setLoading(false))
  }, [])

  // Restored from the cache: refresh that genre's albums in the background
  // so coming back never shows a stale slice of the library. The restored
  // list stays on screen at full height meanwhile, which is what lets
  // App.jsx put the scroll position back. Mount-only on purpose —
  // restoredView is fixed for the life of this mount.
  useEffect(() => {
    if (!restoredView) return
    api.get(`/library/albums?genre=${encodeURIComponent(restoredView.genre.name)}&limit=500`)
      .then(setGenreAlbums)
      .catch(() => {
        // Silence is safe here: a failed refresh is no reason to empty the
        // list the user has just come back to. The restored copy stands.
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Mirror the open genre view into the cache, and clear it when the user
  // steps back out to the genre browser — there is then nothing to return
  // to, and a stale entry would hijack the next mount.
  useEffect(() => {
    if (selectedGenre) {
      _genreViewCache.genre = selectedGenre
      _genreViewCache.albums = genreAlbums
      _genreViewCache.savedAt = Date.now()
    } else {
      _genreViewCache.genre = null
      _genreViewCache.albums = []
    }
  }, [selectedGenre, genreAlbums])

  // Auto-select on mount when an initialGenre was provided
  // (#v1.1.0.30 -- user tapped a genre pill on AlbumDetail).
  // Once consumed we tell the parent so the value doesn't get
  // reapplied on re-render.
  useEffect(() => {
    if (!initialGenre || selectedGenre || genres.length === 0) return
    const match = genres.find(g => g.name === initialGenre)
    if (match) {
      handleGenreSelect(match)
    } else {
      // The genre may be valid even if it's not in our top-N list.
      // Synthesize a minimal genre object so the filtered view loads.
      handleGenreSelect({ name: initialGenre, count: 0 })
    }
    onInitialConsumed()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialGenre, genres])

  const handleGenreSelect = async (genre) => {
    setSelectedGenre(genre)
    setLoadingAlbums(true)
    api.get(`/library/albums?genre=${encodeURIComponent(genre.name)}&limit=500`)
      .then(setGenreAlbums)
      .finally(() => setLoadingAlbums(false))
  }

  // Checked before `loading`: the genre catalogue is not needed to draw one
  // genre's albums, and returning a spinner here would give the screen no
  // height for App.jsx's scroll restore to land on.
  if (selectedGenre) {
    return (
      <div style={s.page}>
        <button style={s.back} onClick={() => { setSelectedGenre(null); setGenreAlbums([]) }}>
          <ArrowLeft size={14} /> Genres
        </button>
        <h1 style={s.heading}>{selectedGenre.name}</h1>
        <div style={s.sub}>{selectedGenre.count} album{selectedGenre.count !== 1 ? 's' : ''}</div>
        {loadingAlbums
          ? <div style={s.loadWrap}><div style={s.spinner} /></div>
          : (
            <div className="album-grid" style={{ marginTop: 12 }}>
              {genreAlbums.map(a => (
                <AlbumCard key={a.id} album={a} onClick={() => onAlbumSelect(a.id)} />
              ))}
            </div>
          )}
      </div>
    )
  }

  if (loading) return <div style={s.loadWrap}><div style={s.spinner} /></div>

  return (
    <div style={s.page}>
      <div style={s.header}>
        <h1 style={s.heading}>Genres</h1>
        <div style={s.sub}>{genres.length} genre{genres.length !== 1 ? 's' : ''}</div>
      </div>
      <div style={s.genreGrid}>
        {genres.map(g => (
          <button key={g.name} style={s.genreCard} onClick={() => handleGenreSelect(g)}>
            <div style={s.genreName}>{g.name}</div>
            <div style={s.genreCount}>{g.count}</div>
          </button>
        ))}
      </div>
    </div>
  )
}

function AlbumCard({ album, onClick }) {
  const [imgErr, setImgErr] = useState(false)
  return (
    <button style={s.albumCard} onClick={onClick}>
      <div style={s.albumArt}>
        {album.cover_art && !imgErr
          ? <img src={album.cover_art} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} onError={() => setImgErr(true)} draggable={false} />
          : <span style={{ fontSize: 20, color: 'var(--text-muted)' }}>♫</span>}
      </div>
      <div style={s.albumTitle}>{album.title}</div>
      <div style={s.albumArtist}>{album.album_artist}</div>
    </button>
  )
}

const s = {
  page: { padding: '14px 12px 120px' },
  loadWrap: { display: 'flex', justifyContent: 'center', paddingTop: 40 },
  spinner: { width: 22, height: 22, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' },
  back: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 14, background: 'none', border: 'none', cursor: 'pointer' },
  header: { marginBottom: 14 },
  heading: { fontSize: 22, fontWeight: 700, letterSpacing: '-0.4px', margin: 0 },
  sub: { fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', marginTop: 2, marginBottom: 12 },
  genreGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 },
  // Pill-style genre buttons — wider than tall, no aspect-ratio constraint.
  // The user asked for "less taller, more pill shaped".
  genreCard: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    minWidth: 0, width: '100%',
    padding: '10px 14px',
    borderRadius: 18,
    background: 'linear-gradient(135deg, rgba(120,150,200,0.18), rgba(80,110,160,0.10))',
    border: '1px solid rgba(140,170,210,0.18)',
    cursor: 'pointer', textAlign: 'left',
  },
  genreName: { fontSize: 13, fontWeight: 600, color: '#cfd9e8', letterSpacing: '-0.2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1, lineHeight: 1.2 },
  genreCount: { fontSize: 10, color: 'rgba(207,217,232,0.55)', fontFamily: 'var(--font-mono)', marginLeft: 8, flexShrink: 0 },
  albumGrid: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginTop: 12 },
  albumCard: { background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left', minWidth: 0, width: '100%' },
  albumArt: { width: '100%', aspectRatio: '1 / 1', borderRadius: 8, overflow: 'hidden', background: 'var(--bg-elevated)', marginBottom: 5, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  albumTitle: { fontSize: 11, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  albumArtist: { fontSize: 10, color: 'var(--text-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
}
