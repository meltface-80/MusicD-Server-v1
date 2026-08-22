import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import { Search, X } from 'lucide-react'
import ServiceBadge, { serviceLabel } from './ServiceBadge'
import AlbumTile from './AlbumTile'

// The Qobuz and Tidal screens (v1.1.33.0).
//
// One component, two services — they show the same page types their own
// apps do, and the differences between them are data, not code:
//
//   Qobuz   New Releases · Favourites · Recent · Browse
//   Tidal   New Releases · Favourites · Recent
//
// Tidal has no Browse tab because the API surface this client uses has no
// equivalent of Qobuz's eight editorial lists. An empty tab would be
// worse than no tab, so the server returns an empty category list for
// Tidal and the tab is dropped here.
//
// WHAT A TAP DOES, AND WHY IT IS THE SAME EVERYWHERE. Opening an album
// here goes to the ordinary album page, not to some service-specific
// view. The server caches the album into the library tables on the way
// (GET /streaming/<service>/album/<id>), so by the time the page opens
// there is a real album row with real tracks behind it. That is the
// whole reason a Qobuz album plays to a Sonos zone with your DSP on it,
// and the reason there is no second album screen to keep in step with
// the first.
//
// The tab bodies are deliberately dumb: fetch a list of normalised
// albums, draw a grid. Every list endpoint returns the same shape, so
// AlbumTile below is the only thing that knows what an album looks like.

const TABS_FOR = {
  qobuz: [
    { key: 'releases',  label: 'New Releases' },
    { key: 'favorites', label: 'Favourites' },
    { key: 'recent',    label: 'Recent' },
    { key: 'browse',    label: 'Browse' },
  ],
  tidal: [
    { key: 'releases',  label: 'New Releases' },
    { key: 'favorites', label: 'Favourites' },
    { key: 'recent',    label: 'Recent' },
  ],
}

export default function ServiceScreen({ service, onAlbumSelect }) {
  const { setSelectedAlbum } = useStore()
  const openAlbum = onAlbumSelect || setSelectedAlbum

  const tabs = TABS_FOR[service] || TABS_FOR.qobuz
  const [tab, setTab] = useState('releases')
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')

  const label = serviceLabel(service) || service

  // Reset when switching between Qobuz and Tidal via the side menu —
  // without this, landing on Tidal while Qobuz's Browse tab was open
  // leaves a tab selected that Tidal does not have, and the body renders
  // nothing at all.
  useEffect(() => {
    setTab('releases')
    setSearching(false)
    setQuery('')
  }, [service])

  return (
    <div style={s.page}>
      <div style={s.header}>
        <div style={s.titleRow}>
          <ServiceBadge service={service} size={20} />
          <span style={s.title}>{label}</span>
          <button
            style={s.searchBtn}
            onClick={() => { setSearching(v => !v); setQuery('') }}
            aria-label={searching ? 'Close search' : `Search ${label}`}>
            {searching ? <X size={15} /> : <Search size={15} />}
          </button>
        </div>

        {searching
          ? (
            <input
              style={s.searchInput}
              autoFocus
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={`Search the ${label} catalogue`}
              type="search"
            />
          )
          : (
            <nav style={s.tabs} role="tablist">
              {tabs.map(t => (
                <button
                  key={t.key}
                  role="tab"
                  aria-selected={tab === t.key}
                  style={{ ...s.tab, ...(tab === t.key ? s.tabOn : {}) }}
                  onClick={() => setTab(t.key)}>
                  {t.label}
                </button>
              ))}
            </nav>
          )}
      </div>

      {searching
        ? <SearchTab service={service} query={query} onOpen={openAlbum} />
        : tab === 'browse'
          ? <BrowseTab service={service} onOpen={openAlbum} />
          : <ListTab service={service} tab={tab} onOpen={openAlbum} />}
    </div>
  )
}

// ---- opening an album -----------------------------------------------------
//
// Shared by every tab and by search. Caches server-side, then hands the
// local id to the normal album page. Held here rather than in each tab so
// there is one place that knows the sequence.
function useOpenAlbum(service, onOpen) {
  const [opening, setOpening] = useState(null)
  const [error, setError] = useState(null)

  const open = useCallback(async (album) => {
    setOpening(album.serviceAlbumId)
    setError(null)
    try {
      const r = await api.get(`/streaming/${service}/album/${encodeURIComponent(album.serviceAlbumId)}`)
      onOpen(r.localAlbumId || album.localAlbumId)
    } catch (e) {
      setError(e.message || 'Could not open that album')
    } finally {
      setOpening(null)
    }
  }, [service, onOpen])

  return { open, opening, error }
}

// ---- the list tabs --------------------------------------------------------

const ENDPOINT_FOR = {
  releases:  (svc) => `/streaming/${svc}/new-releases?limit=50`,
  favorites: (svc) => `/streaming/${svc}/favorites/albums?limit=100`,
  recent:    (svc) => `/streaming/${svc}/recent-plays?limit=50`,
}

const EMPTY_FOR = {
  releases:  'Nothing new to show right now.',
  favorites: 'No favourites yet. Add one with the ⊕ on any album page and it joins your library.',
  recent:    'Nothing played from here yet.',
}

function ListTab({ service, tab, onOpen }) {
  const [albums, setAlbums] = useState(null)
  const [error, setError] = useState(null)
  const { open, opening, error: openError } = useOpenAlbum(service, onOpen)

  useEffect(() => {
    let cancelled = false
    setAlbums(null); setError(null)
    api.get(ENDPOINT_FOR[tab](service))
      .then(r => { if (!cancelled) setAlbums(r.albums || []) })
      .catch(e => { if (!cancelled) setError(e.message || 'Could not load that') })
    return () => { cancelled = true }
  }, [service, tab])

  return (
    <Body
      albums={albums}
      error={error || openError}
      empty={EMPTY_FOR[tab]}
      onOpen={open}
      opening={opening}
    />
  )
}

// ---- browse (Qobuz) -------------------------------------------------------

function BrowseTab({ service, onOpen }) {
  const [categories, setCategories] = useState([])
  const [active, setActive] = useState(null)
  const [albums, setAlbums] = useState(null)
  const [error, setError] = useState(null)
  const { open, opening, error: openError } = useOpenAlbum(service, onOpen)

  useEffect(() => {
    let cancelled = false
    api.get(`/streaming/${service}/browse`)
      .then(r => {
        if (cancelled) return
        const cats = r.categories || []
        setCategories(cats)
        if (cats.length) setActive(cats[0].type)
      })
      .catch(e => { if (!cancelled) setError(e.message || 'Could not load categories') })
    return () => { cancelled = true }
  }, [service])

  useEffect(() => {
    if (!active) return
    let cancelled = false
    setAlbums(null); setError(null)
    api.get(`/streaming/${service}/browse/${encodeURIComponent(active)}?limit=50`)
      .then(r => { if (!cancelled) setAlbums(r.albums || []) })
      .catch(e => { if (!cancelled) setError(e.message || 'Could not load that list') })
    return () => { cancelled = true }
  }, [service, active])

  return (
    <>
      <div style={s.chipRow}>
        {categories.map(c => (
          <button
            key={c.type}
            style={{ ...s.chip, ...(active === c.type ? s.chipOn : {}) }}
            onClick={() => setActive(c.type)}>
            {c.label}
          </button>
        ))}
      </div>
      <Body
        albums={albums}
        error={error || openError}
        empty="Nothing in this list right now."
        onOpen={open}
        opening={opening}
      />
    </>
  )
}

// ---- search ---------------------------------------------------------------

function SearchTab({ service, query, onOpen }) {
  const [albums, setAlbums] = useState(null)
  const [error, setError] = useState(null)
  const { open, opening, error: openError } = useOpenAlbum(service, onOpen)
  const timerRef = useRef(null)

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    if (!query.trim()) { setAlbums(null); setError(null); return }
    let cancelled = false
    // Debounced: every keystroke is a catalogue call otherwise, and both
    // services rate-limit on the app credentials rather than per user.
    timerRef.current = setTimeout(() => {
      api.get(`/streaming/${service}/search?q=${encodeURIComponent(query)}&type=albums&limit=50`)
        .then(r => { if (!cancelled) setAlbums(r.albums || []) })
        .catch(e => { if (!cancelled) setError(e.message || 'Search failed') })
    }, 350)
    return () => { cancelled = true; if (timerRef.current) clearTimeout(timerRef.current) }
  }, [service, query])

  if (!query.trim()) {
    return <div style={s.empty}>Search the full {serviceLabel(service)} catalogue.</div>
  }
  return (
    <Body
      albums={albums}
      error={error || openError}
      empty="Nothing found."
      onOpen={open}
      opening={opening}
    />
  )
}

// ---- shared body ----------------------------------------------------------

function Body({ albums, error, empty, onOpen, opening }) {
  if (error) return <div style={s.error}>{error}</div>
  if (albums === null) return <div style={s.loading}><div style={s.spinner} /></div>
  if (albums.length === 0) return <div style={s.empty}>{empty}</div>
  return (
    <div className="album-grid" style={s.grid}>
      {albums.map(a => (
        // v1.1.34.0 — the shared tile, identical to the album wall's.
        // These screens used to draw their own, with a quality line that
        // only appeared when the service reported one, so tiles came out
        // at two different heights and the grid rows stretched unevenly.
        // Quality now rides on the album page, where it does not fight
        // the layout.
        <AlbumTile
          key={a.localAlbumId || a.serviceAlbumId}
          album={a}
          onClick={() => onOpen(a)}
          busy={opening === a.serviceAlbumId}
          inLibrary={!!a.in_library}
          dim={a.streamable === false}
        />
      ))}
    </div>
  )
}

const s = {
  page: { padding: '0 16px 120px', background: 'var(--jp-bg)', minHeight: '100%' },
  header: {
    position: 'sticky', top: 0, zIndex: 10,
    background: 'var(--jp-bg)', margin: '0 -16px', padding: '14px 16px 0',
    borderBottom: '1px solid var(--jp-border)',
  },
  titleRow: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 },
  title: { flex: 1, fontSize: 22, fontWeight: 600, letterSpacing: '-0.3px', color: 'var(--jp-text)' },
  searchBtn: {
    width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center',
    borderRadius: 6, background: 'transparent', border: '1px solid var(--jp-border)',
    color: 'var(--jp-text-2)', cursor: 'pointer', flexShrink: 0,
  },
  searchInput: {
    width: '100%', padding: '9px 12px', marginBottom: 12, borderRadius: 6,
    fontSize: 13, background: 'var(--jp-bg-surface)', color: 'var(--jp-text)',
    border: '1px solid var(--jp-border)', outline: 'none',
  },
  tabs: { display: 'flex', gap: 4, overflowX: 'auto', paddingBottom: 2 },
  tab: {
    padding: '8px 12px', fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap',
    background: 'transparent', border: 'none', borderBottom: '2px solid transparent',
    color: 'var(--jp-text-3)', cursor: 'pointer',
  },
  tabOn: { color: 'var(--jp-text)', borderBottomColor: 'var(--jp-text)' },
  chipRow: { display: 'flex', gap: 6, overflowX: 'auto', padding: '12px 0 4px' },
  chip: {
    padding: '6px 11px', borderRadius: 14, fontSize: 11, whiteSpace: 'nowrap',
    background: 'transparent', border: '1px solid var(--jp-border)',
    color: 'var(--jp-text-2)', cursor: 'pointer',
  },
  chipOn: { background: 'rgba(var(--tint-rgb), 0.10)', color: 'var(--jp-text)' },
  grid: { paddingTop: 14 },
  loading: { display: 'flex', justifyContent: 'center', paddingTop: 60 },
  spinner: {
    width: 22, height: 22, border: '2px solid var(--jp-border)',
    borderTopColor: 'var(--jp-text-2)', borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
  },
  empty: { paddingTop: 50, textAlign: 'center', color: 'var(--jp-text-3)', fontSize: 13, lineHeight: 1.6 },
  error: { paddingTop: 50, textAlign: 'center', color: 'var(--jp-hot)', fontSize: 13 },
}
