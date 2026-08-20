import React, { useEffect, useState, useCallback } from 'react'
import { api } from '../api'
import { Newspaper, RefreshCw, AlertCircle, Disc3 } from 'lucide-react'

// Music News section (#30 / #30.1 / #30.4 / #30.5).
//
// Layout:
//   [Header: Music News]                      [↻ refresh]
//   ── New Releases — Qobuz ───────────────────────────────
//   horizontal-scroll row of large square cards (album art + title + artist)
//   ── New Releases — Bandcamp Daily ──────────────────────
//   horizontal-scroll row of large square cards (same shape, different source)
//   ── Articles ──────────────────────────────────────────
//   vertical list of article cards: Bandcamp Daily pinned to the top,
//   then Pitchfork (news / album reviews / The Pitch) by published date.
//
// Each release row is optional — hidden if its source has zero cards. The
// articles list is always shown when at least one source returned anything.
// On a fresh boot before any fetch completes, we show a skeleton state.
//
// All cards are <a target="_blank">: tap opens the source page in the
// system browser (Qobuz album page, Bandcamp album page, Pitchfork article,
// or Bandcamp Daily article).

export default function NewsSection() {
  const [items, setItems] = useState([])
  const [phase, setPhase] = useState('loading')
  const [error, setError] = useState(null)
  const [refreshing, setRefreshing] = useState(false)
  const [cooldownSec, setCooldownSec] = useState(0)

  const load = useCallback(async () => {
    try {
      const r = await api.get('/news/feed?limit=60')
      // v1.1.20.0 — every source is off on a new install and nothing is
      // fetched until one is switched on. `enabled` says whether any is, so
      // the block can be left out entirely rather than showing a "no news
      // yet — first fetch is still running" that would never resolve.
      if (r && r.enabled === false) { setPhase('disabled'); setError(null); return }
      const list = r?.items || []
      setItems(list)
      setPhase(list.length === 0 ? 'empty' : 'ready')
      setError(null)
    } catch (e) {
      setError(e.message || "Couldn't load news")
      setPhase('error')
    }
  }, [])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (cooldownSec <= 0) return
    const t = setTimeout(() => setCooldownSec(cooldownSec - 1), 1000)
    return () => clearTimeout(t)
  }, [cooldownSec])

  const refresh = async () => {
    if (refreshing || cooldownSec > 0) return
    setRefreshing(true)
    try {
      const r = await fetch('/api/news/refresh', { method: 'POST' })
      const body = await r.json().catch(() => ({}))
      if (r.status === 429 && body?.retryInSec) {
        setCooldownSec(body.retryInSec)
      } else if (r.ok) {
        await load()
      } else {
        setError(body?.error || 'Refresh failed')
      }
    } catch (e) {
      setError(e.message || 'Refresh failed')
    } finally {
      setRefreshing(false)
    }
  }

  const refreshDisabled = refreshing || cooldownSec > 0

  // Split items by kind, then by source. Server returns everything sorted
  // by published_at, so within each split the newest is first.
  const releases         = items.filter(it => it.kind === 'release')
  const qobuzReleases    = releases.filter(it => it.source === 'qobuz')
  const bandcampReleases = releases.filter(it => it.source === 'bandcamp')
  // Articles list mixes Pitchfork, Bandcamp Daily, and Qobuz Magazine
  // fallback tiles. Bandcamp posts a handful per week vs Pitchfork's
  // dozens per day — without intervention the Bandcamp items would be
  // buried by date order. Pin Bandcamp first, then everything else in
  // server-supplied newest-first order. (#30.5)
  const articlesAll = items.filter(it => it.kind !== 'release')
  const bandcampArticles    = articlesAll.filter(it => it.source === 'bandcamp')
  const nonBandcampArticles = articlesAll.filter(it => it.source !== 'bandcamp')
  const articles = [...bandcampArticles, ...nonBandcampArticles]

  // Nothing enabled: render nothing at all. Not an empty panel with a header
  // and a refresh button that would fetch nothing — the whole point of the
  // switch being off is that this costs the user nothing.
  if (phase === 'disabled') return null

  return (
    <div style={s.panel}>
      <div style={s.header}>
        <div style={s.titleWrap}>
          <Newspaper size={16} style={{ color: 'var(--text-tertiary)' }} />
          <div style={s.title}>Music News</div>
        </div>
        <button
          onClick={refresh}
          disabled={refreshDisabled}
          style={{ ...s.refreshBtn, ...(refreshDisabled ? s.refreshBtnDis : {}) }}
          title={cooldownSec > 0 ? `Wait ${cooldownSec}s` : 'Refresh'}
          aria-label="Refresh news"
        >
          <RefreshCw size={13} style={{
            animation: refreshing ? 'spin 0.8s linear infinite' : undefined,
          }} />
          {cooldownSec > 0 && <span style={s.cooldownText}>{cooldownSec}s</span>}
        </button>
      </div>

      {phase === 'loading' && <LoadingState />}
      {phase === 'error' && (
        <div style={s.error}>
          <AlertCircle size={14} />
          <span>{error || "Couldn't load news"}</span>
          <button onClick={load} style={s.errorRetry}>Retry</button>
        </div>
      )}
      {phase === 'empty' && (
        <div style={s.empty}>
          No news yet — first fetch is still running. Try refresh in a moment.
        </div>
      )}
      {phase === 'ready' && (
        <>
          {qobuzReleases.length > 0 && (
            <ReleaseRow
              releases={qobuzReleases.slice(0, 12)}
              sourceLabel="FROM QOBUZ"
            />
          )}
          {bandcampReleases.length > 0 && (
            <ReleaseRow
              releases={bandcampReleases.slice(0, 12)}
              sourceLabel="FROM BANDCAMP"
            />
          )}
          {articles.length > 0 && (
            <ArticleList articles={articles} />
          )}
        </>
      )}
    </div>
  )
}

// ── New Releases (top row) — horizontal scroll, square cards ──────────
//
// Called once per source — each call produces its own labelled row. The
// sourceLabel string ("FROM QOBUZ" / "FROM BANDCAMP") lives in the
// sub-header on the right side; the left says "NEW RELEASES" regardless.
function ReleaseRow({ releases, sourceLabel }) {
  return (
    <div style={s.subsection}>
      <div style={s.subhead}>
        <Disc3 size={12} style={{ color: 'var(--text-tertiary)' }} />
        <div style={s.subheadLabel}>NEW RELEASES</div>
        {sourceLabel && (
          <div style={s.subheadSource}>{sourceLabel}</div>
        )}
      </div>
      <div style={s.releaseScroll}>
        {releases.map(r => <ReleaseCard key={r.id} release={r} />)}
      </div>
    </div>
  )
}

function ReleaseCard({ release }) {
  const [imgErr, setImgErr] = useState(false)
  const showImg = release.image_url && !imgErr
  return (
    <a
      href={release.url}
      target="_blank"
      rel="noopener noreferrer"
      style={s.releaseCard}
    >
      <div style={s.releaseArt}>
        {showImg ? (
          <img
            src={release.image_url}
            alt=""
            style={s.releaseImg}
            onError={() => setImgErr(true)}
            loading="lazy"
            draggable={false}
          />
        ) : (
          <div style={s.releaseImgFallback}>
            <Disc3 size={32} style={{ color: 'rgba(255,255,255,0.2)' }} />
          </div>
        )}
      </div>
      <div style={s.releaseTitle}>{release.title}</div>
      {release.artist && (
        <div style={s.releaseArtist}>{release.artist}</div>
      )}
    </a>
  )
}

// ── Articles (vertical list) — Pitchfork-style horizontal-thumbnail cards
function ArticleList({ articles }) {
  return (
    <div style={s.subsection}>
      <div style={s.subhead}>
        <Newspaper size={12} style={{ color: 'var(--text-tertiary)' }} />
        <div style={s.subheadLabel}>ARTICLES</div>
      </div>
      <div style={s.articleList}>
        {articles.map(it => <ArticleCard key={it.id} item={it} />)}
      </div>
    </div>
  )
}

function ArticleCard({ item }) {
  const [imgErr, setImgErr] = useState(false)
  const showImg = item.image_url && !imgErr
  return (
    <a
      href={item.url}
      target="_blank"
      rel="noopener noreferrer"
      style={s.card}
    >
      <div style={s.cardArt}>
        {showImg ? (
          <img
            src={item.image_url}
            alt=""
            style={s.cardImg}
            onError={() => setImgErr(true)}
            loading="lazy"
            draggable={false}
          />
        ) : (
          <div style={s.cardImgFallback}>
            <Newspaper size={24} style={{ color: 'var(--text-muted)' }} />
          </div>
        )}
      </div>
      <div style={s.cardBody}>
        <div style={s.cardBadge}>
          <span style={s.cardSource}>{sourceLabel(item.source)}</span>
          {item.section && (
            <>
              <span style={s.cardBadgeDot}>·</span>
              <span style={s.cardSection}>{item.section}</span>
            </>
          )}
        </div>
        <div style={s.cardTitle}>{item.title}</div>
        {item.excerpt && <div style={s.cardExcerpt}>{item.excerpt}</div>}
        <div style={s.cardMeta}>{relTime(item.published_at)}</div>
      </div>
    </a>
  )
}

function LoadingState() {
  return (
    <>
      <div style={s.subsection}>
        <div style={s.subhead}>
          <div style={{ ...s.subheadLabel, color: 'var(--text-muted)' }}>NEW RELEASES</div>
        </div>
        <div style={s.releaseScroll}>
          {[0, 1, 2].map(i => (
            <div key={i} style={{ ...s.releaseCard, cursor: 'default' }}>
              <div style={{ ...s.releaseArt, animation: 'pulse 1.4s ease-in-out infinite' }} />
              <div style={{ ...s.skelLine, width: '70%', height: 12, marginTop: 8 }} />
              <div style={{ ...s.skelLine, width: '50%', height: 10, marginTop: 4 }} />
            </div>
          ))}
        </div>
      </div>
      <div style={s.subsection}>
        <div style={s.subhead}>
          <div style={{ ...s.subheadLabel, color: 'var(--text-muted)' }}>ARTICLES</div>
        </div>
        <div style={s.articleList}>
          {[0, 1, 2].map(i => (
            <div key={i} style={s.skel}>
              <div style={s.skelArt} />
              <div style={s.skelBody}>
                <div style={{ ...s.skelLine, width: '40%' }} />
                <div style={{ ...s.skelLine, width: '90%', height: 14 }} />
                <div style={{ ...s.skelLine, width: '60%', height: 14 }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}

function sourceLabel(source) {
  if (source === 'pitchfork') return 'PITCHFORK'
  if (source === 'qobuz')     return 'QOBUZ'
  if (source === 'bandcamp')  return 'BANDCAMP DAILY'
  return (source || '').toUpperCase()
}

function relTime(unix) {
  if (!unix) return ''
  const now = Math.floor(Date.now() / 1000)
  const delta = Math.max(0, now - unix)
  if (delta < 60) return 'just now'
  const m = Math.floor(delta / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(delta / 3600)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(delta / 86400)
  if (d === 1) return 'yesterday'
  return `${d} days ago`
}

const s = {
  panel: { padding: '18px 0' },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '0 18px 8px',
    gap: 8,
  },
  titleWrap: { display: 'flex', alignItems: 'center', gap: 8 },
  title: { fontSize: 17, fontWeight: 700, color: 'var(--text-primary)' },
  refreshBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '6px 10px',
    background: 'var(--bg-elevated)',
    color: 'var(--text-secondary)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    fontSize: 11, cursor: 'pointer',
  },
  refreshBtnDis: { opacity: 0.5, cursor: 'not-allowed' },
  cooldownText: {
    fontSize: 10, fontVariantNumeric: 'tabular-nums',
    color: 'var(--text-tertiary)',
  },

  subsection: { paddingTop: 14 },
  subhead: {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '0 18px 10px',
  },
  subheadLabel: {
    fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
    color: 'var(--text-tertiary)',
  },
  subheadSource: {
    fontSize: 9, fontWeight: 600, letterSpacing: '0.1em',
    color: 'var(--accent)',
    marginLeft: 'auto',
  },

  releaseScroll: {
    display: 'flex', gap: 12,
    overflowX: 'auto', overflowY: 'hidden',
    padding: '0 18px 4px',
    WebkitOverflowScrolling: 'touch',
    scrollSnapType: 'x mandatory',
  },
  releaseCard: {
    flex: '0 0 auto',
    width: '44%', minWidth: 150, maxWidth: 200,
    background: 'none', border: 'none',
    padding: 0, margin: 0, textAlign: 'left',
    textDecoration: 'none',
    color: 'inherit',
    cursor: 'pointer',
    scrollSnapAlign: 'start',
    WebkitTapHighlightColor: 'transparent',
    display: 'flex', flexDirection: 'column',
  },
  releaseArt: {
    width: '100%', aspectRatio: '1 / 1',
    borderRadius: 6, overflow: 'hidden',
    background: 'var(--bg-overlay)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    marginBottom: 8,
    boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
  },
  releaseImg: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
  releaseImgFallback: {
    width: '100%', height: '100%',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  releaseTitle: {
    fontSize: 13, fontWeight: 700, color: 'var(--text-primary)',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
    marginBottom: 1,
  },
  releaseArtist: {
    fontSize: 12, color: 'var(--text-secondary)',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },

  articleList: {
    display: 'flex', flexDirection: 'column',
    padding: '0 14px',
    gap: 10,
  },
  card: {
    display: 'flex', gap: 12,
    padding: 10,
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border)',
    borderRadius: 10,
    textDecoration: 'none',
    color: 'inherit',
    cursor: 'pointer',
    WebkitTapHighlightColor: 'transparent',
  },
  cardArt: {
    flexShrink: 0,
    width: 84, height: 84,
    borderRadius: 6,
    overflow: 'hidden',
    background: 'var(--bg-overlay)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  cardImg: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
  cardImgFallback: {
    width: '100%', height: '100%',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  cardBody: {
    flex: 1, minWidth: 0,
    display: 'flex', flexDirection: 'column',
    gap: 4,
  },
  cardBadge: {
    display: 'flex', alignItems: 'center', gap: 6,
    fontSize: 9, fontWeight: 700, letterSpacing: '0.08em',
    color: 'var(--text-tertiary)',
  },
  cardSource: { color: 'var(--accent)' },
  cardBadgeDot: { color: 'var(--text-muted)' },
  cardSection: { },
  cardTitle: {
    fontSize: 13, fontWeight: 600,
    color: 'var(--text-primary)',
    lineHeight: 1.3,
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  },
  cardExcerpt: {
    fontSize: 11,
    color: 'var(--text-secondary)',
    lineHeight: 1.4,
    display: '-webkit-box',
    WebkitLineClamp: 1,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  },
  cardMeta: {
    fontSize: 10,
    color: 'var(--text-tertiary)',
    marginTop: 'auto',
  },

  empty: {
    padding: '24px 18px',
    color: 'var(--text-tertiary)',
    fontSize: 12,
    fontStyle: 'italic',
    lineHeight: 1.5,
  },
  error: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '12px 14px',
    margin: '0 14px',
    background: 'rgba(255,90,90,0.08)',
    border: '1px solid rgba(255,90,90,0.3)',
    borderRadius: 8,
    fontSize: 12, color: '#ff8888',
  },
  errorRetry: {
    marginLeft: 'auto',
    padding: '4px 10px',
    background: 'rgba(255,255,255,0.05)',
    color: '#ff8888',
    border: '1px solid rgba(255,90,90,0.3)',
    borderRadius: 4,
    fontSize: 11, cursor: 'pointer',
  },
  skel: {
    display: 'flex', gap: 12,
    padding: 10,
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border)',
    borderRadius: 10,
  },
  skelArt: {
    flexShrink: 0,
    width: 84, height: 84,
    borderRadius: 6,
    background: 'var(--bg-overlay)',
    animation: 'pulse 1.4s ease-in-out infinite',
  },
  skelBody: {
    flex: 1, display: 'flex', flexDirection: 'column', gap: 8,
    paddingTop: 6,
  },
  skelLine: {
    height: 10,
    background: 'var(--bg-overlay)',
    borderRadius: 4,
    animation: 'pulse 1.4s ease-in-out infinite',
  },
}
