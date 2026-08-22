import React, { useEffect, useState } from 'react'
import { api } from '../api'

// Settings → Home Screen (v1.1.20.0, extended v1.1.21.0).
//
// Two groups, separated by a rule, because the two halves promise different
// things and merging them would blur both:
//
//   CAROUSELS (top) — three rows that read this server's own library. No
//   outside request, no background work, nothing to schedule. ON by default:
//   two of them have been on the Home screen since #28.5 and an upgrade must
//   not quietly take them away.
//
//   MUSIC NEWS (below the rule) — four sources that fetch from Pitchfork,
//   Qobuz and Bandcamp. OFF on a new install, and off means off: with all
//   four off the server makes no upstream request and schedules no refresh.
//   See applyPrefs() in server/src/news.js.
//
// They are also two endpoints — /api/home/prefs and /api/news/prefs — for the
// same reason: one settings blob would have forced one default onto both, and
// whichever default won would have been wrong for the other half.
//
// Each switch is written on its own, as a partial patch, so two quick taps on
// different rows cannot race into overwriting each other with a stale copy of
// the whole object.
const CAROUSEL_ROWS = [
  {
    key: 'recentlyAdded',
    label: 'Recently added',
    sub: 'The newest albums the scanner has seen.',
  },
  {
    key: 'recentlyPlayed',
    label: 'Recently played',
    sub: 'Albums this server has played, most recent first.',
  },
  {
    key: 'randomAlbums',
    label: 'Random albums',
    sub: 'A fresh handful from the whole library. Tap the row’s title on the ' +
         'Home screen for a full page of them.',
  },
]

const NEWS_ROWS = [
  {
    key: 'qobuzReleases',
    label: 'New releases from Qobuz',
    // Said plainly because the Qobuz crawl produces both and there is no
    // separate switch for the magazine half.
    sub: 'Also brings Qobuz Magazine pieces into Articles.',
  },
  {
    key: 'bandcampReleases',
    label: 'New releases from Bandcamp',
    sub: 'Each release is looked up on its own Bandcamp page, so this one ' +
         'fetches the most.',
  },
  { key: 'pitchforkArticles', label: 'Pitchfork reviews and news' },
  { key: 'bandcampArticles',  label: 'Bandcamp Daily reviews' },
]

export default function HomeScreenSection() {
  const [carousels, setCarousels] = useState(null)
  const [news, setNews] = useState(null)
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    api.get('/home/prefs')
      .then(r => { if (!cancelled) setCarousels(r?.prefs || {}) })
      .catch(e => { if (!cancelled) setError(e.message || "Couldn't load settings") })
    api.get('/news/prefs')
      .then(r => { if (!cancelled) setNews(r?.prefs || {}) })
      .catch(e => { if (!cancelled) setError(e.message || "Couldn't load settings") })
    return () => { cancelled = true }
  }, [])

  // One toggle handler for both groups: the group supplies its endpoint and
  // its piece of state, so the optimistic-update-and-revert logic exists once
  // rather than being copied and then drifting.
  const makeToggle = (path, prefs, setPrefs) => async (key) => {
    if (busy || !prefs) return
    const next = !prefs[key]
    setBusy(key)
    setError(null)
    // Optimistic, reverted on failure — the same shape the favourite toggles
    // use, so a tap feels immediate without lying if the server refuses.
    setPrefs(p => ({ ...p, [key]: next }))
    try {
      const r = await api.put(path, { [key]: next })
      if (r?.prefs) setPrefs(r.prefs)
    } catch (e) {
      setPrefs(p => ({ ...p, [key]: !next }))
      setError(e.message || "Couldn't save that")
    } finally {
      setBusy(null)
    }
  }

  const toggleCarousel = makeToggle('/home/prefs', carousels, setCarousels)
  const toggleNews = makeToggle('/news/prefs', news, setNews)

  const anyNewsOn = news && NEWS_ROWS.some(r => news[r.key])

  return (
    <div>
      {error && <div style={s.error}>{error}</div>}

      <p style={s.blurb}>
        Which rows the Home screen shows. The library counters at the top of it
        are always there.
      </p>

      <Switches
        rows={CAROUSEL_ROWS}
        prefs={carousels}
        busy={busy}
        onToggle={toggleCarousel}
      />

      {/* The break line. Everything above it reads the local library;
          everything below it goes out to the internet. */}
      <hr style={s.rule} />

      <p style={s.blurb}>
        Music News. Everything here is off until you turn it on: with all four
        off the server makes no outside requests for news and schedules no
        background refresh.
      </p>

      <Switches
        rows={NEWS_ROWS}
        prefs={news}
        busy={busy}
        onToggle={toggleNews}
      />

      {news !== null && (
        <p style={s.footnote}>
          {anyNewsOn
            ? 'Enabled sources refresh about every 30 minutes.'
            : 'Nothing is being fetched. The Music News block is hidden on the Home screen.'}
        </p>
      )}
    </div>
  )
}

function Switches({ rows, prefs, busy, onToggle }) {
  if (prefs === null) return <div style={s.loading}>Loading…</div>
  return (
    <div style={s.rows}>
      {rows.map(row => (
        <div key={row.key} style={s.row}>
          <div style={s.rowText}>
            <div style={s.rowLabel}>{row.label}</div>
            {row.sub && <div style={s.rowSub}>{row.sub}</div>}
          </div>
          <button
            style={{ ...s.toggle, ...(prefs[row.key] ? s.toggleOn : {}) }}
            onClick={() => onToggle(row.key)}
            disabled={busy === row.key}
            role="switch"
            aria-checked={!!prefs[row.key]}
            aria-label={row.label}
          >
            <span style={{ ...s.knob, ...(prefs[row.key] ? s.knobOn : {}) }} />
          </button>
        </div>
      ))}
    </div>
  )
}

const s = {
  blurb: { fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55, margin: '0 0 14px' },
  loading: { fontSize: 13, color: 'var(--text-tertiary)', padding: '10px 0' },
  error: {
    margin: '0 0 10px', padding: '8px 10px', borderRadius: 6, fontSize: 13,
    background: 'rgba(255,59,92,0.08)', border: '1px solid rgba(255,59,92,0.30)',
    color: 'var(--text-secondary)',
  },
  // The break line between the local rows and the ones that go out to the
  // internet. Heavier than the hairline that separates individual switches,
  // so it reads as a division rather than as one more row boundary.
  rule: {
    border: 'none', borderTop: '1px solid var(--border)',
    margin: '26px 0 18px',
  },
  rows: { display: 'flex', flexDirection: 'column' },
  row: {
    display: 'flex', alignItems: 'center', gap: 14,
    padding: '12px 0',
    borderBottom: '1px solid var(--border-faint)',
  },
  rowText: { flex: 1, minWidth: 0 },
  rowLabel: { fontSize: 14, color: 'var(--text-primary)', fontWeight: 500 },
  rowSub: { fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.45, marginTop: 3 },
  toggle: {
    position: 'relative', flexShrink: 0,
    width: 44, height: 26, borderRadius: 999,
    background: 'rgba(var(--tint-rgb), 0.12)',
    border: '1px solid rgba(var(--tint-rgb), 0.10)',
    cursor: 'pointer', padding: 0,
    transition: 'background 0.16s ease',
  },
  toggleOn: { background: 'var(--accent)', borderColor: 'var(--accent)' },
  knob: {
    position: 'absolute', top: 2, left: 2,
    width: 20, height: 20, borderRadius: '50%',
    background: '#fff', display: 'block',
    transition: 'transform 0.16s ease',
  },
  knobOn: { transform: 'translateX(18px)' },
  footnote: { fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5, margin: '14px 0 0' },
}
