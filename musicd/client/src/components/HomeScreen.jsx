import React, { useEffect, useState, useRef } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import { Mic2, Disc3, Music2, Tag, Download, AlertTriangle, X } from 'lucide-react'
import NewsSection from './NewsSection'

// Roon-style Home screen (#28.5 / #29.8 / #30).
// Top: greeting + 4 stats tiles.
// Then: "Recent activity" with PLAYED/ADDED tabs and a horizontal scroller of
// album tiles.
// Then: "Music News" — Pitchfork-sourced headlines, full implementation in
// NewsSection.jsx (#30).
//
// As of #29.8 the screen is vertically scrollable (was fixed-height in 28.5).
// The recent-activity row still scrolls horizontally inside its own panel.
//
// Update notifications appear as a top banner when /api/update/check returns
// an availableVersion. Tapping triggers a two-step confirmation flow before
// posting /api/update/run.
export default function HomeScreen({ onAlbumSelect, onSidebarSection }) {
  const [stats, setStats] = useState({ total_artists: 0, total_albums: 0, total_tracks: 0 })
  const [genreCount, setGenreCount] = useState(0)
  const [tab, setTab] = useState('added')
  const [albums, setAlbums] = useState([])
  const [loadingRecent, setLoadingRecent] = useState(true)
  // Update banner state. We poll /api/update/check on mount and every 60s
  // thereafter — the SettingsScreen polls every 3s but home doesn't need
  // that frequency, the update check just scans a directory.
  const [updateInfo, setUpdateInfo] = useState(null)
  const [updateDismissed, setUpdateDismissed] = useState(false)

  // Stats — fired once on mount. /library/stats is cached server-side so this
  // is cheap.
  useEffect(() => {
    api.get('/library/stats').then(setStats).catch(() => {})
    // Genre count comes from a separate endpoint that returns the full list;
    // we just want its length.
    api.get('/library/genres').then(g => setGenreCount(Array.isArray(g) ? g.length : 0)).catch(() => {})
  }, [])

  // Recent activity — refetch when tab changes.
  useEffect(() => {
    setLoadingRecent(true)
    api.get(`/library/albums/recent?type=${tab}&limit=12`)
      .then(setAlbums)
      .catch(() => setAlbums([]))
      .finally(() => setLoadingRecent(false))
  }, [tab])

  // Update check — poll periodically. 60s is enough; the user usually
  // notices a new tar within a fresh visit to the home screen.
  useEffect(() => {
    const check = () => api.get('/update/check').then(setUpdateInfo).catch(() => {})
    check()
    const t = setInterval(check, 60_000)
    return () => clearInterval(t)
  }, [])

  const showUpdateBanner = !!(updateInfo?.availableVersion) && !updateDismissed

  return (
    <div style={s.page}>
      {/* Update banner — pinned to the top of the scroll surface. We don't
          fix-position it because that floats over content awkwardly when the
          page scrolls; pinning to flow keeps the layout calm. */}
      {showUpdateBanner && (
        <UpdateBanner
          info={updateInfo}
          onDismiss={() => setUpdateDismissed(true)}
        />
      )}

      {/* Greeting */}
      <div style={s.greeting}>Library</div>

      {/* Stats tiles. Artists / Albums / Genres are tappable and jump to that
          section in the sidebar. Tracks is a number-only tile (we don't have
          a flat track-list screen yet). */}
      <div style={s.tilesRow}>
        <StatTile
          icon={<Mic2 size={16} />}
          value={stats.total_artists}
          label="ARTISTS"
          onClick={() => onSidebarSection && onSidebarSection('artists')}
        />
        <StatTile
          icon={<Disc3 size={16} />}
          value={stats.total_albums}
          label="ALBUMS"
          onClick={() => onSidebarSection && onSidebarSection('albums')}
        />
        <StatTile
          icon={<Music2 size={16} />}
          value={stats.total_tracks}
          label="TRACKS"
        />
        <StatTile
          icon={<Tag size={16} />}
          value={genreCount}
          label="GENRES"
          onClick={() => onSidebarSection && onSidebarSection('genres')}
        />
      </div>

      {/* Recent activity panel. Distinct background tint so it reads as a
          separate region (matches the Roon reference). #29.8: no longer
          flex: 1 — sized to its content, with margin below for the gap
          before Music News. */}
      <div style={s.recentPanel}>
        <div style={s.recentHeader}>
          <div style={s.recentTitle}>Recent activity</div>
        </div>
        <div style={s.tabs}>
          <button
            style={{ ...s.tabBtn, ...(tab === 'played' ? s.tabBtnActive : {}) }}
            onClick={() => setTab('played')}
            aria-pressed={tab === 'played'}
          >
            PLAYED
            {tab === 'played' && <div style={s.tabUnderline} />}
          </button>
          <button
            style={{ ...s.tabBtn, ...(tab === 'added' ? s.tabBtnActive : {}) }}
            onClick={() => setTab('added')}
            aria-pressed={tab === 'added'}
          >
            ADDED
            {tab === 'added' && <div style={s.tabUnderline} />}
          </button>
        </div>

        <RecentRow
          albums={albums}
          loading={loadingRecent}
          tab={tab}
          onAlbumSelect={onAlbumSelect}
        />
      </div>

      {/* Music News — pulls cached Pitchfork headlines from /api/news/feed.
          See NewsSection.jsx for the rendering and refresh logic. The
          server's news.js module owns fetching/parsing/caching. */}
      <NewsSection />
    </div>
  )
}

function StatTile({ icon, value, label, onClick }) {
  // Tiles render as buttons when navigable (so they're keyboard-accessible),
  // and as plain divs when not (Tracks). The visual is identical either way.
  const Component = onClick ? 'button' : 'div'
  return (
    <Component
      style={{ ...s.tile, ...(onClick ? s.tileClickable : {}) }}
      onClick={onClick || undefined}
    >
      <div style={s.tileIcon}>{icon}</div>
      <div style={s.tileValue}>{(value || 0).toLocaleString()}</div>
      <div style={s.tileLabel}>{label}</div>
    </Component>
  )
}

// Update banner with two-step confirmation flow (#29.8).
//
// State machine:
//   idle    — shows "Update v1.2.3 available — Update | Dismiss"
//   confirm — shows "Are you sure? The server will restart. — Yes, update | Cancel"
//   running — shows spinner + "Updating…". Server goes down; the page will
//             reconnect once the new container is up. We don't try to track
//             progress beyond this — /api/update/run returns 202 and the
//             server stops responding shortly after.
//   error   — shows the failure message + retry/dismiss
//
// Why two steps: the user explicitly asked for this. The first tap signals
// intent; the second prevents accidental fat-finger updates on a phone where
// a single tap is easy to fire by accident.
function UpdateBanner({ info, onDismiss }) {
  const [phase, setPhase] = useState('idle')
  const [error, setError] = useState(null)

  const startUpdate = async () => {
    setPhase('running')
    setError(null)
    try {
      await api.post('/update/run')
      // Server will stop responding within seconds. We leave the running
      // banner visible — when the new server comes up, the home screen
      // remounts on reconnect and updateInfo gets refetched (showing no
      // available version since the running version now matches).
    } catch (e) {
      setError(e.message || 'Update failed to start')
      setPhase('error')
    }
  }

  if (phase === 'running') {
    // For remote updates, the /update/run POST is synchronous through
    // download + image-rebuild kickoff. Title acknowledges both phases
    // so the user understands why the spinner sits for a few seconds
    // before the server actually goes away.
    const isRemote = info.source === 'remote'
    return (
      <div style={s.banner}>
        <div style={s.bannerIcon}><div style={s.bannerSpinner} /></div>
        <div style={s.bannerBody}>
          <div style={s.bannerTitle}>
            {isRemote ? `Downloading & installing v${info.availableVersion}…`
                      : `Updating to v${info.availableVersion}…`}
          </div>
          <div style={s.bannerSub}>
            {isRemote
              ? 'Pulling the update from the release server. The app will reconnect once the new container is up.'
              : 'Server is restarting. The app will reconnect when ready.'}
          </div>
        </div>
      </div>
    )
  }

  if (phase === 'error') {
    return (
      <div style={{ ...s.banner, ...s.bannerError }}>
        <div style={s.bannerIcon}><AlertTriangle size={18} /></div>
        <div style={s.bannerBody}>
          <div style={s.bannerTitle}>Update failed</div>
          <div style={s.bannerSub}>{error}</div>
        </div>
        <div style={s.bannerActions}>
          <button onClick={() => setPhase('idle')} style={s.bannerBtnGhost}>Retry</button>
          <button onClick={onDismiss} style={s.bannerBtnGhost}>Dismiss</button>
        </div>
      </div>
    )
  }

  if (phase === 'confirm') {
    return (
      <div style={{ ...s.banner, ...s.bannerConfirm }}>
        <div style={s.bannerIcon}><AlertTriangle size={18} /></div>
        <div style={s.bannerBody}>
          <div style={s.bannerTitle}>Are you sure?</div>
          <div style={s.bannerSub}>The server will restart and the app will briefly disconnect.</div>
        </div>
        <div style={s.bannerActions}>
          <button onClick={startUpdate} style={s.bannerBtn}>Yes, update</button>
          <button onClick={() => setPhase('idle')} style={s.bannerBtnGhost}>Cancel</button>
        </div>
      </div>
    )
  }

  return (
    <div style={s.banner}>
      <div style={s.bannerIcon}><Download size={18} /></div>
      <div style={s.bannerBody}>
        <div style={s.bannerTitle}>Update v{info.availableVersion} available</div>
        <div style={s.bannerSub}>
          You're on v{info.currentVersion}. Do you wish to update?
          {info.releaseNotes && (
            <span style={{ display: 'block', marginTop: 4, opacity: 0.85 }}>
              {info.releaseNotes}
            </span>
          )}
        </div>
      </div>
      <div style={s.bannerActions}>
        <button onClick={() => setPhase('confirm')} style={s.bannerBtn}>Update</button>
        <button onClick={onDismiss} style={s.bannerBtnX} aria-label="Dismiss">
          <X size={14} />
        </button>
      </div>
    </div>
  )
}

function RecentRow({ albums, loading, tab, onAlbumSelect }) {
  if (loading) {
    return <div style={s.recentLoading}><div style={s.spinner} /></div>
  }
  if (!albums || albums.length === 0) {
    return (
      <div style={s.recentEmpty}>
        {tab === 'played'
          ? 'No recent plays yet — anything you play here will show up.'
          : 'No recently-added albums.'}
      </div>
    )
  }
  return (
    <div style={s.recentScroll}>
      {albums.map(a => (
        <RecentTile key={a.id} album={a} tab={tab} onClick={() => onAlbumSelect && onAlbumSelect(a.id)} />
      ))}
    </div>
  )
}

// Format a unix timestamp as "Played 2 days ago" / "Added 11 days ago".
// Kept short — these are the secondary line on the tile.
function relTime(unix) {
  if (!unix) return ''
  const now = Math.floor(Date.now() / 1000)
  const delta = Math.max(0, now - unix)
  const days = Math.floor(delta / 86400)
  if (days === 0) {
    const hours = Math.floor(delta / 3600)
    if (hours === 0) return 'just now'
    return `${hours}h ago`
  }
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(days / 365)}y ago`
}

// Format the album's primary format as a short audio-quality tag (FLAC 16/44).
// Best-effort: we have primary_format from the albums table but not sample
// rate per album, so we just show the codec.
function formatTag(album) {
  const f = (album.primary_format || '').toLowerCase()
  if (!f) return null
  if (f === 'flac') return 'FLAC'
  if (f === 'mp3') return 'MP3'
  if (f === 'dsf' || f === 'dff' || f === 'dsd') return 'DSD'
  if (f === 'wav' || f === 'aiff' || f === 'aif') return f.toUpperCase()
  return f.toUpperCase()
}

function RecentTile({ album, tab, onClick }) {
  const [imgErr, setImgErr] = useState(false)
  const tileRef = useRef(null)
  const [src, setSrc] = useState(null)

  // Lazy-load cover art only once the tile is near the viewport. The Home
  // screen's recent row is horizontal so IntersectionObserver works the same
  // way it does on the album grid.
  useEffect(() => {
    if (!album.cover_art) return
    const obs = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) { setSrc(album.cover_art); obs.disconnect() }
    }, { rootMargin: '150px' })
    if (tileRef.current) obs.observe(tileRef.current)
    return () => obs.disconnect()
  }, [album.cover_art])

  const fmt = formatTag(album)
  const subline = tab === 'played' ? `Played ${relTime(album.activity_at)}` : `Added ${relTime(album.activity_at)}`

  return (
    <button ref={tileRef} style={s.tile2} onClick={onClick}>
      <div style={s.tile2Art}>
        {src && !imgErr
          ? <img src={src} alt="" style={s.tile2Img} onError={() => setImgErr(true)} draggable={false} />
          : <div style={s.tile2Empty}>♫</div>}
      </div>
      <div style={s.tile2Sub}>{subline}</div>
      <div style={s.tile2Title}>{album.title}</div>
      <div style={s.tile2Artist}>{album.album_artist || album.artist}</div>
      {fmt && <div style={s.tile2Fmt}>{fmt}</div>}
    </button>
  )
}

const s = {
  page: {
    height: '100%',
    display: 'flex', flexDirection: 'column',
    // #29.8: was overflow: hidden (fixed-height home). Now scrollable so
    // Music News can sit below recent activity. Bottom padding keeps the
    // last section clear of the now-playing minibar.
    overflowY: 'auto',
    overflowX: 'hidden',
    background: 'var(--bg-base)',
    paddingBottom: 24,
  },
  greeting: {
    fontSize: 32, fontWeight: 700, letterSpacing: '-0.5px',
    padding: '20px 16px 12px',
    color: 'var(--text-primary)',
  },

  // Stats tiles — 4 in a row, each compact. Match Roon's outlined-card look.
  // v1.1.0.95 — horizontal padding standardised 14 → 16 to match the
  // greeting, recent-activity header, and tabs above/below. v91
  // standardised most screen padding but missed this row.
  tilesRow: {
    display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
    gap: 8, padding: '0 16px 18px',
  },
  // Library counter tiles. Width is driven by the parent grid; only
  // the vertical proportions live here. #v1.1.0.39 -- vertical padding
  // reduced (14 → 8) and inner gap tightened (4 → 2) so the tiles
  // read as squat rectangles rather than tall squares. Width
  // unchanged.
  tile: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    gap: 2, padding: '8px 6px',
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border)',
    borderRadius: 12,
    color: 'var(--text-secondary)',
    minWidth: 0,
  },
  tileClickable: { cursor: 'pointer' },
  tileIcon: { color: 'var(--text-secondary)' },
  tileValue: {
    fontSize: 17, fontWeight: 700, color: 'var(--text-primary)',
    fontVariantNumeric: 'tabular-nums',
    lineHeight: 1.1,
  },
  tileLabel: {
    fontSize: 9, fontWeight: 700, letterSpacing: '0.08em',
    color: 'var(--text-tertiary)',
    lineHeight: 1,
  },

  // Recent activity panel — coloured background to set it apart.
  // #29.8: was flex: 1 (filling all remaining vertical space). Now sized
  // to its content so the blue tint stops just below the album tiles,
  // leaving a visual gap before the next section.
  // #v1.1.0.30: panel reduced ~half height -- tighter padding, smaller
  // tiles, smaller header. Tiles keep their square art but scale down
  // proportionally. The footer area (year + title under each tile)
  // stays in the same aspect ratio to the art so the tile composition
  // doesn't change shape, just shrinks.
  recentPanel: {
    background: 'var(--accent-dim)',
    padding: '10px 0 10px',
    display: 'flex', flexDirection: 'column',
    marginBottom: 20,
  },
  recentHeader: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '0 16px 2px',
  },
  recentTitle: { fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' },

  tabs: { display: 'flex', gap: 18, padding: '4px 16px 8px' },
  tabBtn: {
    background: 'none', border: 'none', cursor: 'pointer',
    padding: '3px 0', position: 'relative',
    fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
    color: 'var(--text-tertiary)',
  },
  tabBtnActive: { color: 'var(--text-primary)' },
  tabUnderline: {
    position: 'absolute', bottom: -1, left: 0, right: 0,
    height: 2, background: 'var(--accent)', borderRadius: 1,
  },

  recentLoading: { display: 'flex', justifyContent: 'center', padding: '20px 0' },
  recentEmpty: {
    padding: '18px 16px', color: 'var(--text-tertiary)',
    fontSize: 11, lineHeight: 1.4,
  },
  spinner: {
    width: 22, height: 22,
    border: '2px solid var(--border)', borderTopColor: 'var(--accent)',
    borderRadius: '50%', animation: 'spin 0.8s linear infinite',
  },

  // Horizontal scroller. Tiles narrower in #v1.1.0.30 -- ~30% of
  // viewport so three peek at once. The art stays square; the
  // sub-text and title under it scale with the tile width so the
  // overall aspect of art-to-text remains consistent.
  // v1.1.0.91 — bumped horizontal padding 16 → 18 so the first
  // album tile has visible breathing room from the screen edge.
  // Also added scroll-snap-padding-left so when the user scrolls
  // back to the start, the snapped-into-place tile sits a bit
  // inside the panel rather than flush against the edge.
  recentScroll: {
    display: 'flex', gap: 10,
    overflowX: 'auto', overflowY: 'hidden',
    padding: '0 18px 4px',
    scrollPaddingLeft: 18,
    WebkitOverflowScrolling: 'touch',
    scrollSnapType: 'x mandatory',
  },
  tile2: {
    flex: '0 0 auto', width: '30%', minWidth: 100,
    background: 'none', border: 'none', cursor: 'pointer',
    padding: 0, margin: 0, textAlign: 'left',
    scrollSnapAlign: 'start',
  },
  tile2Art: {
    width: '100%', aspectRatio: '1 / 1',
    borderRadius: 5, overflow: 'hidden',
    background: 'var(--bg-overlay)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    marginBottom: 5,
    boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
  },
  tile2Img: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
  tile2Empty: { fontSize: 24, color: 'rgba(255,255,255,0.2)' },
  tile2Sub: {
    fontSize: 9, color: 'var(--text-tertiary)',
    marginBottom: 2,
  },
  tile2Title: {
    fontSize: 11, fontWeight: 700, color: 'var(--text-primary)',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
    marginBottom: 1,
  },
  tile2Artist: {
    fontSize: 10, color: 'var(--text-secondary)',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
    marginBottom: 2,
  },
  tile2Fmt: {
    fontSize: 9, fontFamily: 'var(--font-mono)',
    color: 'var(--text-tertiary)', letterSpacing: '0.04em',
  },

  // Update banner — top of home screen when /api/update/check sees a newer
  // tar. Designed to feel like an info banner rather than a modal so the
  // user can dismiss and come back later.
  banner: {
    margin: '12px 14px 0',
    padding: '12px 14px',
    background: 'var(--accent-dim)',
    border: '1px solid var(--accent)',
    borderRadius: 10,
    display: 'flex', alignItems: 'center', gap: 12,
  },
  bannerConfirm: {
    background: 'rgba(245,196,80,0.10)',
    borderColor: 'rgba(245,196,80,0.55)',
  },
  bannerError: {
    background: 'rgba(255,90,90,0.10)',
    borderColor: 'rgba(255,90,90,0.55)',
  },
  bannerIcon: {
    width: 32, height: 32, flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: 'var(--accent)',
    background: 'rgba(255,255,255,0.04)',
    borderRadius: 8,
  },
  bannerSpinner: {
    width: 18, height: 18,
    border: '2px solid rgba(255,255,255,0.2)',
    borderTopColor: 'var(--accent)',
    borderRadius: '50%', animation: 'spin 0.8s linear infinite',
  },
  bannerBody: { flex: 1, minWidth: 0 },
  bannerTitle: {
    fontSize: 13, fontWeight: 700,
    color: 'var(--text-primary)', marginBottom: 2,
  },
  bannerSub: {
    fontSize: 11, color: 'var(--text-secondary)',
    lineHeight: 1.4,
  },
  bannerActions: {
    display: 'flex', gap: 6, flexShrink: 0,
  },
  bannerBtn: {
    padding: '6px 12px',
    background: 'var(--accent)', color: '#fff',
    border: 'none', borderRadius: 6,
    fontSize: 11, fontWeight: 600, cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  bannerBtnGhost: {
    padding: '6px 10px',
    background: 'var(--bg-elevated)', color: 'var(--text-secondary)',
    border: '1px solid var(--border)', borderRadius: 6,
    fontSize: 11, cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  bannerBtnX: {
    width: 28, height: 28,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'none', border: 'none', cursor: 'pointer',
    color: 'var(--text-tertiary)',
  },
}
