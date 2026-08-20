import React, { useEffect, useState } from 'react'
import { api } from '../api'

// Settings → Home Screen (v1.1.20.0).
//
// Four switches for the four rows the Home screen can show. All of them are
// OFF on a new install, and off means off: the server makes no request to
// Pitchfork, Qobuz or Bandcamp, and schedules no refresh, until one is turned
// on. Turning the last one off stops the timer again — see applyPrefs() in
// server/src/news.js.
//
// Each switch is written on its own, as a partial patch, so two quick taps on
// different rows cannot race into overwriting each other with a stale copy of
// the whole object.
const ROWS = [
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
  const [prefs, setPrefs] = useState(null)
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    api.get('/news/prefs')
      .then(r => { if (!cancelled) setPrefs(r?.prefs || {}) })
      .catch(e => { if (!cancelled) setError(e.message || "Couldn't load settings") })
    return () => { cancelled = true }
  }, [])

  const toggle = async (key) => {
    if (busy || !prefs) return
    const next = !prefs[key]
    setBusy(key)
    setError(null)
    // Optimistic, reverted on failure — the same shape the favourite toggles
    // use, so a tap feels immediate without lying if the server refuses.
    setPrefs(p => ({ ...p, [key]: next }))
    try {
      const r = await api.put('/news/prefs', { [key]: next })
      if (r?.prefs) setPrefs(r.prefs)
    } catch (e) {
      setPrefs(p => ({ ...p, [key]: !next }))
      setError(e.message || "Couldn't save that")
    } finally {
      setBusy(null)
    }
  }

  const anyOn = prefs && ROWS.some(r => prefs[r.key])

  return (
    <div>
      <p style={s.blurb}>
        Music News on the Home screen. Everything here is off until you turn it
        on: with all four off the server makes no outside requests for news and
        schedules no background refresh.
      </p>

      {error && <div style={s.error}>{error}</div>}

      {prefs === null ? (
        <div style={s.loading}>Loading…</div>
      ) : (
        <div style={s.rows}>
          {ROWS.map(row => (
            <div key={row.key} style={s.row}>
              <div style={s.rowText}>
                <div style={s.rowLabel}>{row.label}</div>
                {row.sub && <div style={s.rowSub}>{row.sub}</div>}
              </div>
              <button
                style={{ ...s.toggle, ...(prefs[row.key] ? s.toggleOn : {}) }}
                onClick={() => toggle(row.key)}
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
      )}

      {prefs !== null && (
        <p style={s.footnote}>
          {anyOn
            ? 'Enabled sources refresh about every 30 minutes.'
            : 'Nothing is being fetched. The Music News block is hidden on the Home screen.'}
        </p>
      )}
    </div>
  )
}

const s = {
  blurb: { fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.55, margin: '0 0 14px' },
  loading: { fontSize: 12, color: 'var(--text-tertiary)', padding: '10px 0' },
  error: {
    margin: '0 0 10px', padding: '8px 10px', borderRadius: 6, fontSize: 12,
    background: 'rgba(255,59,92,0.08)', border: '1px solid rgba(255,59,92,0.30)',
    color: 'var(--text-secondary)',
  },
  rows: { display: 'flex', flexDirection: 'column' },
  row: {
    display: 'flex', alignItems: 'center', gap: 14,
    padding: '12px 0',
    borderBottom: '1px solid var(--border-faint)',
  },
  rowText: { flex: 1, minWidth: 0 },
  rowLabel: { fontSize: 13, color: 'var(--text-primary)', fontWeight: 500 },
  rowSub: { fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.45, marginTop: 3 },
  toggle: {
    position: 'relative', flexShrink: 0,
    width: 44, height: 26, borderRadius: 999,
    background: 'rgba(255,255,255,0.12)',
    border: '1px solid rgba(255,255,255,0.10)',
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
  footnote: { fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.5, margin: '14px 0 0' },
}
