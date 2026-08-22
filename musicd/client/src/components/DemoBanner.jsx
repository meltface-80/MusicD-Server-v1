// v1.1.3.3 — Demo tier banner.
//
// Displays at the top of every screen when the user is on the demo
// tier. Carries a single explanatory line and a link to the support
// page (where they can buy me a coffee in exchange for an unlock
// code).
//
// Behaviour:
//   - Polls /api/update/tier on mount and re-checks every 30 s. If
//     the user enters a code mid-session, the banner disappears on
//     the next tick.
//   - Dismiss-X stores a flag in sessionStorage so the banner stays
//     dismissed for the current browser session but reappears on
//     reload. This is intentional: we want demo users to be aware
//     of their tier without being badgered every time they tap a
//     button.
//   - Renders nothing for non-demo tiers and during the initial
//     fetch (before tier is known) so the layout doesn't flash.

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { api } from '../api'

const SESSION_KEY = 'musicd.demoBanner.dismissed'

export default function DemoBanner() {
  const [tier, setTier] = useState(null)  // null = not yet fetched
  const [dismissed, setDismissed] = useState(() => {
    try { return sessionStorage.getItem(SESSION_KEY) === '1' }
    catch { return false }
  })

  useEffect(() => {
    let mounted = true
    const refresh = () => {
      api.get('/update/tier')
        .then(d => { if (mounted) setTier(d.tier || 'demo') })
        .catch(() => { /* leave tier as-is; banner won't render until we get a confirmed value */ })
    }
    refresh()
    const interval = setInterval(refresh, 30000)
    return () => { mounted = false; clearInterval(interval) }
  }, [])

  if (tier !== 'demo') return null
  if (dismissed) return null

  const handleDismiss = () => {
    setDismissed(true)
    try { sessionStorage.setItem(SESSION_KEY, '1') } catch { /* */ }
  }

  return (
    <div style={s.banner} role="status">
      <div style={s.message}>
        <strong>Demo mode</strong>
        {' — limited to 50 albums and core playback only. To unlock the full library, DSP, scrobbling, backups and more, '}
        <a
          href="https://buymeacoffee.com/musicd"
          target="_blank"
          rel="noopener noreferrer"
          style={s.link}
        >
          buy me a coffee
        </a>
        {" — I'll reply with a code."}
      </div>
      <button
        type="button"
        onClick={handleDismiss}
        style={s.closeBtn}
        aria-label="Dismiss demo notice"
        title="Dismiss"
      >
        <X size={16} />
      </button>
    </div>
  )
}

const s = {
  banner: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '10px 14px',
    background: 'var(--bg-elevated)',
    borderBottom: '1px solid var(--border)',
    fontSize: 14,
    lineHeight: 1.5,
    color: 'var(--text-primary)',
  },
  message: {
    flex: 1,
    minWidth: 0,
  },
  link: {
    color: 'var(--accent)',
    textDecoration: 'underline',
    fontWeight: 600,
  },
  closeBtn: {
    flex: '0 0 auto',
    background: 'transparent',
    border: 'none',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    padding: 4,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 4,
  },
}
