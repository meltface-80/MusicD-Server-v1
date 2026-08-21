import React, { useEffect, useState } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import { Disc3, Mic2, ListMusic, Wifi, X, Tag, Settings, Heart, AlertCircle, Bookmark } from 'lucide-react'
import RendererIcon from './RendererIcon'

export default function Sidebar({ onClose }) {
  const {
    sidebarSection, setSidebarSection,
    setSelectedAlbum, setSearchQuery,
    renderers, rendererId, setShowRenderers,
    // v1.1.0.68 — reset the Settings sub-section when navigating
    // away via the sidebar. Without this, opening Settings → DSP,
    // tapping the hamburger and choosing Albums, then later coming
    // back to Settings dumps the user straight into DSP again instead
    // of the Settings list. The user reported this as "the settings
    // page reruns minimised" — visually, the section list never
    // re-appears because settingsSubSection is sticky.
    setSettingsSubSection,
  } = useStore()

  // Number of albums needing manual triage on the Unmatched page
  // (#30.19). Polled on mount and every 30s. Updated #30.24 to
  // pause polling when the page is hidden -- if the user has the
  // app backgrounded or the tab inactive, there's no reason to keep
  // hitting the endpoint. We also fetch immediately on becoming
  // visible again so the badge is fresh when the user returns.
  const [unmatchedCount, setUnmatchedCount] = useState(0)
  useEffect(() => {
    let cancelled = false
    let timer = null
    const fetchCount = () => {
      api.get('/library/match/progress')
        .then(r => { if (!cancelled) setUnmatchedCount(r?.unmatchedCount || 0) })
        .catch(() => {}) // sidebar shouldn't error if the endpoint hiccups
    }
    const startPolling = () => {
      if (timer) return  // already polling
      fetchCount()
      timer = setInterval(fetchCount, 30000)
    }
    const stopPolling = () => {
      if (timer) { clearInterval(timer); timer = null }
    }
    const onVisChange = () => {
      if (document.hidden) stopPolling()
      else startPolling()
    }
    // Initial state: poll if visible, idle if not.
    if (!document.hidden) startPolling()
    document.addEventListener('visibilitychange', onVisChange)
    return () => {
      cancelled = true
      stopPolling()
      document.removeEventListener('visibilitychange', onVisChange)
    }
  }, [])

  // Side menu order (#30.15): Albums first, then Artists, Genres, Favourites,
  // Settings. Home was removed because the user always lands at Home by
  // default; tapping the MusicD logo at the top of the menu also returns to
  // Home. The previous "Library / Output" grouping remains because the
  // renderer picker visually belongs in its own section.
  //
  // v1.1.25.0 — Queue left too. It opened a second, separate queue screen; the
  // one behind the Now Playing screen's tab switcher is the real one, and two
  // views of the same queue that had drifted apart in what they could do was
  // one more than anybody needed.
  const sections = [
    { id: 'albums', label: 'Albums', icon: Disc3 },
    { id: 'artists', label: 'Artists', icon: Mic2 },
    { id: 'genres', label: 'Genres', icon: Tag },
    { id: 'favorites', label: 'Favourites', icon: Heart },
    // v1.1.0.70 — Save-for-later list, surfacing the v67 backend.
    // Sits next to Favourites in the Library group because they're
    // conceptually paired (one is "love this," the other is "come
    // back to this"). Bookmark icon to distinguish from the Heart
    // and from the Tag-as-Genres icon. The list view itself is a
    // simple AlbumGrid driven by ?saved=1 on /library/albums.
    // v1.1.20.0 — Tags moved here from Settings → Tags. It is a way through
    // the library, like the two entries around it, not an admin screen.
    { id: 'tags', label: 'Tags', icon: Tag },
    { id: 'saved', label: 'Saved for later', icon: Bookmark },
    // v1.1.19.0 — playlists. Sits after the other saved-collection entries
    // because it belongs with them rather than with the browse-by-metadata
    // ones above.
    { id: 'playlists', label: 'Playlists', icon: ListMusic },
  ]

  const activeRenderer = renderers.find(r => r.id === rendererId)

  const handleSection = (id) => {
    setSidebarSection(id)
    setSearchQuery('')
    setSelectedAlbum(null)
    // v1.1.0.68 — drop any open Settings sub-section so re-opening
    // Settings always lands on the section list.
    setSettingsSubSection(null)
    onClose()
  }

  const handleSettings = () => {
    setSidebarSection('settings')
    // v1.1.0.68 — when the user explicitly taps Settings from the
    // sidebar, they expect to see the section list, not whichever
    // sub-section was last open from a previous visit.
    setSettingsSubSection(null)
    onClose()
  }

  // Tapping the MusicD logo returns to Home. This replaces the explicit
  // "Home" menu item that was removed in #30.15.
  const handleHome = () => {
    setSidebarSection('home')
    setSearchQuery('')
    setSelectedAlbum(null)
    // v1.1.0.68 — reset Settings sub-section on Home nav too.
    setSettingsSubSection(null)
    onClose()
  }

  return (
    <aside style={s.sidebar}>
      <div style={s.header}>
        <button style={s.logoBtn} onClick={handleHome} aria-label="Home">
          <span style={s.logoText}>
            <span style={s.logoMusic}>Music</span><span style={s.logoD}>D</span>
          </span>
        </button>
        <button style={s.closeBtn} onClick={onClose}><X size={16} /></button>
      </div>

      <nav style={s.nav}>
        <div style={s.navLabel}>Library</div>
        {sections.map(({ id, label, icon: Icon }, i) => (
          <React.Fragment key={id}>
            <button
              style={{ ...s.navItem, ...(sidebarSection === id ? s.navItemActive : {}) }}
              onClick={() => handleSection(id)}>
              <Icon size={16} strokeWidth={1.8} /><span>{label}</span>
            </button>
            {/* Insert Unmatched item right after Genres (index 2),
                only when there's something to triage. Keeps the
                menu clean for users with a fully-matched library
                (#30.19). The badge shows the queue size at a glance. */}
            {i === 2 && unmatchedCount > 0 && (
              <button
                style={{ ...s.navItem, ...(sidebarSection === 'unmatched' ? s.navItemActive : {}) }}
                onClick={() => handleSection('unmatched')}>
                <AlertCircle size={16} strokeWidth={1.8} />
                <span>Unmatched</span>
                <span style={s.unmatchedBadge}>{unmatchedCount}</span>
              </button>
            )}
          </React.Fragment>
        ))}
        <button style={{ ...s.navItem, ...(sidebarSection === 'settings' ? s.navItemActive : {}) }}
          onClick={handleSettings}>
          <Settings size={16} strokeWidth={1.8} /><span>Settings</span>
        </button>
      </nav>

      <div style={s.divider} />

      <div style={s.navLabel}>Output</div>
      <button style={s.rendererBtn} onClick={() => { setShowRenderers(true); onClose() }}>
        {/* Renderer icon (#30.22) -- shows the user's chosen icon
            when one is set, falling back to a protocol-based default
            otherwise. Replaces the old plain green dot; the WiFi
            indicator on the right still shows connectivity status. */}
        {activeRenderer
          ? <div style={s.rendererIconWrap}><RendererIcon renderer={activeRenderer} size={20} /></div>
          : <div style={s.dot(false)} />
        }
        <div style={s.rendererInfo}>
          <span style={s.rendererName}>{activeRenderer ? activeRenderer.name : 'No renderer selected'}</span>
          <span style={s.rendererSub}>{activeRenderer ? activeRenderer.ip : 'Tap to choose'}</span>
        </div>
        <Wifi size={13} style={{ color: activeRenderer ? 'var(--green)' : 'var(--text-tertiary)', flexShrink: 0 }} />
      </button>
    </aside>
  )
}

const s = {
  // v1.1.0.65 — JPLAY-style sidebar. Pure black ground (was charcoal
  // var(--bg-surface)). Hairline border-right in --jp-border (was the
  // visible 10% white --border). The MusicD wordmark loses the bright
  // blue D — JPLAY is monochrome, and the chromatic accent against
  // the otherwise monochrome menu read as a leftover. The "D" stays
  // visually distinct via weight, not colour.
  sidebar: { height: '100%', background: 'var(--jp-bg)', borderRight: '1px solid var(--jp-border)', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  header: { paddingTop: 'calc(18px + var(--safe-top))', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 16px', borderBottom: '1px solid var(--jp-border)', flexShrink: 0 },
  logoBtn: { display: 'flex', alignItems: 'center', gap: 10, background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' },
  logoText: { fontSize: 16, fontWeight: 600, letterSpacing: '-0.3px', display: 'inline-flex', color: 'var(--jp-text)' },
  logoMusic: { color: 'var(--jp-text)', fontWeight: 500 },
  logoD: { color: 'var(--jp-text)', fontWeight: 700 },
  closeBtn: { width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, color: 'var(--jp-text-2)', background: 'transparent', border: 'none', cursor: 'pointer' },
  nav: { padding: '12px 8px', flex: '0 0 auto' },
  navLabel: { fontSize: 10, fontWeight: 600, letterSpacing: '0.10em', textTransform: 'uppercase', color: 'var(--jp-text-3)', padding: '12px 10px 6px' },
  // Nav rows: more breathing room (12px vertical was 10px),
  // 14/500 text in --jp-text-2 by default. Active row uses the
  // monochrome JPLAY pattern: white-fill bar with slightly
  // brighter text. No chromatic accent.
  navItem: { display: 'flex', alignItems: 'center', gap: 12, width: '100%', padding: '12px 12px', borderRadius: 6, fontSize: 14, fontWeight: 500, color: 'var(--jp-text-2)', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left' },
  navItemActive: { background: 'rgba(var(--tint-rgb), 0.06)', color: 'var(--jp-text)' },
  // Unmatched count badge — kept amber for the "needs attention"
  // identity, but slightly more restrained against the new black
  // ground.
  unmatchedBadge: {
    marginLeft: 'auto', fontSize: 10, fontWeight: 600,
    padding: '2px 7px', borderRadius: 10,
    background: 'rgba(255,196,0,0.12)', color: '#e6a700',
    minWidth: 18, textAlign: 'center',
    fontFamily: 'var(--font-mono)',
  },
  divider: { height: 1, background: 'var(--jp-border)', margin: '6px 14px' },
  // Output renderer button: outline-style (transparent fill,
  // hairline border) — matches the JPLAY card discipline of
  // "no chrome unless the chrome is the content."
  rendererBtn: { display: 'flex', alignItems: 'center', gap: 10, width: 'calc(100% - 16px)', margin: '4px 8px', padding: '12px', borderRadius: 8, background: 'transparent', border: '1px solid var(--jp-border)', cursor: 'pointer' },
  rendererIconWrap: {
    width: 24, height: 24, flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: 'var(--jp-text-2)',
  },
  dot: (active) => ({ width: 8, height: 8, borderRadius: '50%', background: active ? 'var(--green)' : 'var(--jp-text-3)', boxShadow: active ? '0 0 6px var(--green)' : 'none', flexShrink: 0 }),
  rendererInfo: { flex: 1, display: 'flex', flexDirection: 'column', gap: 2, textAlign: 'left', overflow: 'hidden' },
  rendererName: { fontSize: 13, fontWeight: 500, color: 'var(--jp-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  rendererSub: { fontSize: 11, color: 'var(--jp-text-3)', fontFamily: 'var(--font-mono)' },
}
