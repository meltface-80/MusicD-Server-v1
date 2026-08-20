import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useStore } from './store'
import { api } from './api'
import { restoreScrollTop } from './scrollRestore'
import { Menu, ChevronLeft, Search } from 'lucide-react'
import Sidebar from './components/Sidebar'
import AlbumGrid from './components/AlbumGrid'
import AlbumDetail from './components/AlbumDetail'
import NowPlaying from './components/NowPlaying'
import SignalPathModal from './components/SignalPathModal'
import RendererModal from './components/RendererModal'
import SearchResults from './components/SearchResults'
import QueueModal from './components/QueueModal'
import ArtistAlbums from './components/ArtistAlbums'
import GenreScreen from './components/GenreScreen'
import ArtistList from './components/ArtistList'
import LibraryStatusBanner from './components/LibraryStatusBanner'
import DemoBanner from './components/DemoBanner'
import SettingsScreen from './components/SettingsScreen'
import HomeScreen from './components/HomeScreen'
import UnmatchedScreen from './components/UnmatchedScreen'
import FocusLibraryScreen from './components/FocusLibraryScreen'
import PlaylistsScreen from './components/PlaylistsScreen'
import TagsScreen from './components/TagsScreen'
import RandomAlbumsScreen from './components/RandomAlbumsScreen'

// Screen identity for the scroll memory below. Declared at module scope so
// it exists before every use inside the component.
//
// Settings sub-pages count as their own screen: a sub-page REPLACES the
// section list inside the same scroll container, so sharing one key would
// have the list restore to a sub-page's offset on the way back out.
function screenKeyFor(sidebarSection, settingsSubSection) {
  if (sidebarSection === 'settings') return `settings:${settingsSubSection || ''}`
  return sidebarSection || 'home'
}

export default function App() {
  const {
    initWebSocket, setRenderers, setSelectedAlbum, setSidebarSection,
    setRendererId,
    selectedAlbumId, showSignalPath, showRenderers, showQueue,
    searchQuery, setSearchQuery, sidebarSection,
    settingsSubSection, setSettingsSubSection,
  } = useStore()

  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [artistFilter, setArtistFilter] = useState(null)
  // When the user taps an album while inside ArtistAlbums, we stash the artist
  // here so the album's Back button can return to that artist's album list
  // instead of the global Albums grid.
  const [returnToArtist, setReturnToArtist] = useState(null)
  // Pending genre filter (#v1.1.0.30). When the user taps the genre
  // pill on AlbumDetail we want to land them in GenreScreen with
  // that genre already selected. This holds the genre name until
  // GenreScreen consumes it on mount.
  const [pendingGenre, setPendingGenre] = useState(null)
  const scrollRef = useRef(null)
  // Scroll position memory keyed by screen identifier (sidebarSection, or
  // 'home' for the home screen). Using a Map rather than a literal object
  // means new sections work automatically — adding e.g. 'playlists' to
  // the sidebar doesn't need to also be listed here.
  const scrollPositions = useRef(new Map())
  // The restore currently in flight, if any. onScrollCapture consults it so
  // that a clamped programmatic scroll is never mistaken for the user
  // moving the list — mistaking one for the other is what used to erase the
  // saved position before it could be restored. See ./scrollRestore.js.
  const scrollRestore = useRef(null)

  const currentScreenKey = (() => {
    if (selectedAlbumId || artistFilter || searchQuery) return null
    return screenKeyFor(sidebarSection, settingsSubSection)
  })()

  const handleSetSelectedAlbum = (id) => {
    if (id && scrollRef.current && currentScreenKey) {
      scrollPositions.current.set(currentScreenKey, scrollRef.current.scrollTop)
    }
    setSelectedAlbum(id)
  }
  const handleSetArtistFilter = (a) => {
    if (a && scrollRef.current && currentScreenKey) {
      scrollPositions.current.set(currentScreenKey, scrollRef.current.scrollTop)
    }
    if (a) {
      setSelectedAlbum(null)
      setReturnToArtist(null)
    }
    setArtistFilter(a)
  }

  // Genre filter (#v1.1.0.30). Triggered from AlbumDetail's genre
  // pill: stash the chosen genre, jump to the genre browser, which
  // consumes pendingGenre on mount and auto-selects.
  const handleSetGenreFilter = (genreName) => {
    if (!genreName) return
    setPendingGenre(genreName)
    // GenreScreen auto-selects this genre on mount, so we land on a genre's
    // album list — not on the genre browser the remembered offset belongs
    // to. Forget it rather than restore it onto different content.
    scrollPositions.current.delete(screenKeyFor('genres', null))
    handleSidebarSection('genres')
  }

  // Centralised section change so HomeScreen tiles and Sidebar entries hit
  // the same path. Clears any nested state (selected album, artist filter,
  // search) before switching.
  //
  // Section changes deliberately KEEP the remembered scroll position. Every
  // other route into a section (the sidebar's own handler, FocusLibrary)
  // calls the store's setter directly rather than coming through here, so a
  // reset here would make a Home tile behave differently from the identical
  // sidebar entry. One rule for all of them: a section is where you left it.
  const handleSidebarSection = (section) => {
    setSidebarSection(section)
    setSearchQuery('')
    setSelectedAlbum(null)
    setArtistFilter(null)
    setReturnToArtist(null)
    // Reset Settings sub-section when navigating between sidebar
    // sections, so opening Settings always lands on the section list.
    setSettingsSubSection(null)
  }

  useEffect(() => {
    initWebSocket()
    api.get('/renderers').then(setRenderers).catch(() => {})

    const local = localStorage.getItem('musicd_last_renderer')
    if (local) {
      setRendererId(local)
    } else {
      api.get('/renderers/last-used').then(d => {
        if (d?.rendererId) setRendererId(d.rendererId)
      }).catch(() => {})
    }
  }, [])

  // Restore the remembered offset whenever the visible screen changes.
  //
  // useLayoutEffect, not useEffect: the container clamps its own scrollTop
  // the instant the new screen's (initially much shorter) content is
  // committed, and that clamp dispatches a scroll event. A passive effect
  // can be scheduled after that event, which would leave onScrollCapture
  // unguarded long enough to write the clamped 0 over the saved position —
  // the memory was being destroyed before the restore even started.
  //
  // The restore itself re-applies until it sticks; a single assignment
  // lands on whatever height happens to exist 50ms in, which on the library
  // screen is a spinner. See ./scrollRestore.js.
  useLayoutEffect(() => {
    scrollRestore.current = null
    const el = scrollRef.current
    if (!currentScreenKey || !el) return
    const target = scrollPositions.current.get(currentScreenKey) || 0
    if (target <= 0) {
      // Nothing remembered for this screen: start at the top rather than
      // inheriting the offset the previous screen was left at.
      el.scrollTop = 0
      return
    }
    const handle = restoreScrollTop(el, target)
    scrollRestore.current = handle
    return () => {
      handle.cancel()
      if (scrollRestore.current === handle) scrollRestore.current = null
    }
  }, [currentScreenKey])

  // A real scroll gesture always wins: stop re-applying straight away
  // rather than waiting for the next frame to notice the element moved.
  const cancelScrollRestore = () => {
    if (scrollRestore.current) scrollRestore.current.cancel()
  }

  const onScrollCapture = (e) => {
    if (!currentScreenKey) return
    const top = e.target.scrollTop
    const r = scrollRestore.current
    if (r && !r.settled && top !== r.target) {
      // A restore is in flight and this is not it landing. The event is
      // either our own assignment clamping short, or the browser clamping
      // the outgoing screen's offset as the new screen mounts. Recording it
      // would overwrite the very position being restored.
      return
    }
    scrollPositions.current.set(currentScreenKey, top)
  }

  // ---- Back navigation (#28.5) ----
  // The top bar shows a single back button in a fixed position on every screen
  // except Home. It unwinds one logical step:
  //   search → close search
  //   album  → ArtistAlbums (if we came from there) or section list
  //   artist → section list
  //   non-home section → Home
  // Disabled (greyed) when there's nothing to go back to.
  // Back-chevron logic, ordered most-deeply-nested first. Settings
  // sub-sections (#30.26) sit between the Settings list and Home --
  // a chevron tap inside a sub-section returns to the Settings list,
  // not all the way out to Home. canGoBack reflects every level of
  // nesting we know how to back out of.
  const canGoBack = !!(searchQuery || selectedAlbumId || artistFilter || settingsSubSection || (sidebarSection && sidebarSection !== 'home'))

  const goBack = () => {
    if (searchQuery) { setSearchQuery(''); return }
    if (selectedAlbumId) {
      setSelectedAlbum(null)
      if (returnToArtist) {
        setArtistFilter(returnToArtist)
        setReturnToArtist(null)
      }
      return
    }
    if (artistFilter) {
      setArtistFilter(null)
      setReturnToArtist(null)
      return
    }
    // Settings sub-section: clear it but stay on the Settings list.
    if (settingsSubSection) {
      setSettingsSubSection(null)
      return
    }
    if (sidebarSection && sidebarSection !== 'home') {
      handleSidebarSection('home')
      return
    }
  }

  const mainContent = () => {
    // v1.1.1.4 diagnostic — log which branch is taken. Lets us
    // verify whether the App is even attempting to render
    // AlbumDetail when selectedAlbumId is set. Fire-and-forget;
    // wrapped in try because this runs on every render and we
    // can't have it throw.
    if (typeof window !== 'undefined') {
      try {
        const branch = searchQuery ? 'search'
                     : sidebarSection === 'settings' ? 'settings'
                     : selectedAlbumId ? 'album-detail'
                     : artistFilter ? 'artist'
                     : 'home'
        fetch('/api/debug/client-log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tag: 'main-content',
            message: `branch=${branch}`,
            data: { selectedAlbumId, artistFilter, searchQuery, sidebarSection }
          })
        }).catch(() => {})
      } catch {}
    }
    if (searchQuery) return <SearchResults onArtistClick={handleSetArtistFilter} />
    if (sidebarSection === 'settings') return <SettingsScreen onBack={() => setSidebarSection('home')} />
    if (selectedAlbumId) return <AlbumDetail
      albumId={selectedAlbumId}
      onArtistClick={handleSetArtistFilter}
      onGenreClick={handleSetGenreFilter}
      backLabel={returnToArtist || 'Albums'}
      hideBack={true}
      onBack={goBack}
    />
    if (artistFilter) return <ArtistAlbums
      artist={artistFilter}
      hideBack={true}
      onBack={goBack}
      onAlbumSelect={(albumId) => {
        setReturnToArtist(artistFilter)
        setArtistFilter(null)
        handleSetSelectedAlbum(albumId)
      }}
    />
    if (sidebarSection === 'genres') return <GenreScreen
      onAlbumSelect={handleSetSelectedAlbum}
      initialGenre={pendingGenre}
      onInitialConsumed={() => setPendingGenre(null)}
    />
    if (sidebarSection === 'artists') return <ArtistList onArtistClick={handleSetArtistFilter} />
    if (sidebarSection === 'favorites') return <AlbumGrid onAlbumSelect={handleSetSelectedAlbum} favoritesOnly={true} />
    // v1.1.0.70 — Saved-for-later list. Reuses AlbumGrid via the new
    // savedOnly prop. The filter itself is server-side (?saved=1 on
    // /library/albums); the grid is otherwise identical to Albums.
    if (sidebarSection === 'saved') return <AlbumGrid onAlbumSelect={handleSetSelectedAlbum} savedOnly={true} />
    if (sidebarSection === 'unmatched') return <UnmatchedScreen />
    // v1.1.0.82 — Focus Library: list of saved focus combinations.
    // Tapping one routes back to Albums with the focus loaded via
    // pendingFocusToLoad in the store.
    if (sidebarSection === 'focusLibrary') return <FocusLibraryScreen />
    if (sidebarSection === 'playlists') return <PlaylistsScreen />
    if (sidebarSection === 'tags') return <TagsScreen />
    // v1.1.21.0 — the full 3-across Random-albums wall, opened by tapping the
    // Home screen carousel's heading. Routed as a section rather than as local
    // state so the top bar's back chevron already knows how to leave it.
    if (sidebarSection === 'random') return <RandomAlbumsScreen onAlbumSelect={handleSetSelectedAlbum} />
    if (sidebarSection === 'albums') return <AlbumGrid onAlbumSelect={handleSetSelectedAlbum} />
    return <HomeScreen
      onAlbumSelect={handleSetSelectedAlbum}
      onSidebarSection={handleSidebarSection}
    />
  }

  return (
    <div style={s.root}>
      <div style={{ ...s.sidebarWrap, ...(sidebarOpen ? s.sidebarOpen : {}) }}>
        <Sidebar onClose={() => setSidebarOpen(false)} />
      </div>
      {sidebarOpen && <div style={s.backdrop} onClick={() => setSidebarOpen(false)} />}

      <main style={s.main}>
        <TopBar
          onMenuClick={() => setSidebarOpen(v => !v)}
          canGoBack={canGoBack}
          onBack={goBack}
        />
        <LibraryStatusBanner />
        <DemoBanner />
        <div
          ref={scrollRef}
          style={s.content}
          onScroll={onScrollCapture}
          onWheelCapture={cancelScrollRestore}
          onTouchMoveCapture={cancelScrollRestore}
        >
          {mainContent()}
        </div>
      </main>

      <NowPlaying onArtistClick={handleSetArtistFilter} onAlbumClick={handleSetSelectedAlbum} onGenreClick={handleSetGenreFilter} />

      {showSignalPath && <SignalPathModal />}
      {showRenderers && <RendererModal />}
      {showQueue && <QueueModal />}
    </div>
  )
}

// Roon-style top bar (#28.5):
//   - hamburger left, back arrow next to it (greyed at Home), magnifier right
//   - tapping the magnifier expands an inline search input that takes over
//     the bar; ChevronLeft on the input collapses it back
//
// The search query lives in the store so SearchResults can render off it.
// The "expanded" UI flag is local state — once the user clears the field via
// the back chevron we collapse back to icon mode.
function TopBar({ onMenuClick, canGoBack, onBack }) {
  const { searchQuery, setSearchQuery, setSelectedAlbum } = useStore()
  const [searchExpanded, setSearchExpanded] = useState(false)
  const inputRef = useRef(null)

  const expandSearch = () => {
    setSearchExpanded(true)
    // rAF instead of immediate focus — iOS Safari sometimes drops the focus
    // when the input mounts in the same tick as the state change.
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  const collapseSearch = () => {
    setSearchQuery('')
    setSelectedAlbum(null)
    setSearchExpanded(false)
  }

  return (
    <div style={s.topbar}>
      {searchExpanded ? (
        <>
          <button style={s.iconBtn} onClick={collapseSearch} aria-label="Close search">
            <ChevronLeft size={22} />
          </button>
          <div style={s.searchWrap}>
            <Search size={14} style={s.searchIcon} />
            <input
              ref={inputRef}
              style={s.search}
              placeholder="Search library…"
              value={searchQuery}
              onChange={e => {
                setSearchQuery(e.target.value)
                if (!e.target.value) setSelectedAlbum(null)
              }}
            />
            {searchQuery && (
              <button
                type="button"
                style={s.clearBtn}
                aria-label="Clear search"
                onMouseDown={e => e.preventDefault()}
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setSearchQuery('')
                  setSelectedAlbum(null)
                  inputRef.current?.focus()
                }}
              >X</button>
            )}
          </div>
        </>
      ) : (
        <>
          <button style={s.iconBtn} onClick={onMenuClick} aria-label="Menu">
            <Menu size={22} />
          </button>
          {/* Back chevron is only rendered when there's somewhere to go
              back to. On the home screen there's no parent route, so we
              omit the chevron entirely rather than showing a greyed-out
              one (#30.14). When search is expanded, the search-mode
              branch above always shows a chevron to collapse search. */}
          {canGoBack && (
            <button
              style={s.iconBtn}
              onClick={onBack}
              aria-label="Back"
            >
              <ChevronLeft size={22} />
            </button>
          )}
          <div style={s.topbarSpacer} />
          <button style={s.iconBtn} onClick={expandSearch} aria-label="Search">
            <Search size={20} />
          </button>
        </>
      )}
    </div>
  )
}

const s = {
  // v1.1.3.9 — height is 100% of #root (which is height:100% of html/body),
  // not 100vh. Under viewport-fit=cover on iOS the viewport units and the
  // physical display disagree about whether the safe areas are included, and
  // the shell came up short — a percentage of a fixed-height ancestor has no
  // such ambiguity. No padding here on purpose: screens pad themselves.
  root: { display: 'grid', gridTemplateColumns: '1fr', gridTemplateRows: '1fr var(--nowplaying-h)', height: '100%', background: 'var(--bg-base)', position: 'relative', overflow: 'hidden' },
  sidebarWrap: { position: 'fixed', top: 0, left: 0, bottom: 0, width: 'var(--sidebar-w)', transform: 'translateX(-100%)', transition: 'transform 0.25s ease', zIndex: 200 },
  sidebarOpen: { transform: 'translateX(0)' },
  backdrop: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 199 },
  main: { gridColumn: '1', gridRow: '1', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  topbar: {
    display: 'flex', alignItems: 'center', gap: 4,
    padding: '8px 8px',
    // With viewport-fit=cover the viewport spans the whole display, so
    // this bar starts underneath the status bar. Pad its CONTENT down by
    // the top inset — the bar's own background still runs edge to edge,
    // so there is no visible band, and the buttons come back into reach.
    paddingTop: 'calc(8px + env(safe-area-inset-top, 0px))',
    borderBottom: '1px solid var(--border)',
    background: 'var(--bg-surface)',
    flexShrink: 0, zIndex: 10,
    minHeight: 48,
  },
  topbarSpacer: { flex: 1 },
  iconBtn: {
    width: 38, height: 38,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    borderRadius: 'var(--radius-sm)',
    background: 'none', border: 'none',
    color: 'var(--text-secondary)',
    cursor: 'pointer', padding: 0, flexShrink: 0,
  },
  iconBtnDisabled: {
    color: 'var(--text-muted)',
    opacity: 0.4,
    cursor: 'default',
  },
  searchWrap: { position: 'relative', flex: 1, display: 'flex', alignItems: 'center' },
  searchIcon: { position: 'absolute', left: 9, color: 'var(--text-tertiary)', pointerEvents: 'none' },
  search: { width: '100%', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '8px 38px 8px 30px', color: 'var(--text-primary)', fontSize: 14, outline: 'none' },
  clearBtn: {
    position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)',
    width: 28, height: 28,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 13, fontWeight: 700, lineHeight: 1,
    color: 'var(--text-tertiary)',
    background: 'var(--bg-overlay)',
    border: '1px solid var(--border)',
    borderRadius: '50%',
    cursor: 'pointer',
    padding: 0,
    zIndex: 2,
  },
  content: { flex: 1, overflowY: 'auto', overflowX: 'hidden' },
}
