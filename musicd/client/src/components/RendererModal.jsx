import React, { useEffect, useState } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import { X, RefreshCw } from 'lucide-react'
import RendererIcon from './RendererIcon'

// Group renderers by protocol so users see which can be grouped together
const PROTOCOL_LABELS = {
  alsa: 'USB DACs',
  dlna: 'UPnP / DLNA',
  sonos: 'Sonos',
  squeezelite: 'Squeezelite',
}

export default function RendererModal({ onClose: onCloseProp, mode = 'focus' }) {
  // v56: mode prop. "focus" (default, legacy) just changes which zone
  // the UI is showing — useful when you want to peek at another zone
  // without disturbing what's playing. "move" calls moveQueueToRenderer
  // server-side, which stops playback on the source zone and resumes
  // on the target. This is what users intuitively expect from a
  // "Switch playback" action.
  const {
    setShowRenderers, renderers, setRenderers,
    rendererId, setRendererId,
    playerStatus, currentTrack,
    zones, focusedZoneId, focusZone,
  } = useStore()
  // Per-renderer icon picker moved to Settings → Audio (#v1.1.0.8).
  // The Output sheet is now solely for picking where to play.
  const doClose = () => { if (onCloseProp) onCloseProp(); else setShowRenderers(false) }

  // Refreshing state for visual feedback (#v1.1.0.6). The button looked
  // dead because the search and re-fetch were silent. Now we show a
  // spinning icon and pulse-fade the rendrers list while the search runs.
  const [refreshing, setRefreshing] = useState(false)
  const [moving, setMoving] = useState(false)

  const refresh = async () => {
    setRefreshing(true)
    try {
      await api.post('/renderers/search').catch(() => {})
      // Give SSDP/mDNS a couple of seconds to respond, then re-fetch.
      await new Promise(r => setTimeout(r, 2000))
      await api.get('/renderers').then(setRenderers).catch(() => {})
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => {
    refresh()
    const t = setInterval(() => api.get('/renderers').then(setRenderers).catch(() => {}), 5000)
    return () => clearInterval(t)
  }, [])

  // Tap row → either focus the zone (default) or move the active queue
  // to the new renderer (mode="move"). The move path calls the
  // server's moveQueueToRenderer (already exposed at
  // /player/queue/move) which stops the source zone and resumes
  // playback on the target at the same queue position.
  const select = async (r) => {
    // Persist preference locally for boot-time hint (server has its
    // own per-zone persistence).
    localStorage.setItem('musicd_last_renderer', r.id)
    try { await api.post('/renderers/last-used', { rendererId: r.id }) } catch {}

    if (mode === 'move') {
      // No-op when the user re-taps the currently focused zone.
      if (r.id === rendererId) { doClose(); return }
      setMoving(true)
      try {
        await api.post('/player/queue/move', {
          fromRendererId: rendererId,
          toRendererId: r.id,
        })
        // Move the UI focus too, so the user lands on the new zone's
        // NowPlaying instead of staring at the old one's screen.
        await focusZone(r.id)
      } catch (e) {
        console.warn('Move queue failed:', e)
      } finally {
        setMoving(false)
        doClose()
      }
      return
    }

    // mode === 'focus' (legacy, default). Just change which zone the
    // UI is showing.
    await focusZone(r.id)

    doClose()
  }

  // Group renderers by protocol for display
  const grouped = {}
  for (const r of renderers || []) {
    const p = r.protocol || 'dlna'
    if (!grouped[p]) grouped[p] = []
    grouped[p].push(r)
  }
  const protocolOrder = ['alsa', 'dlna', 'sonos', 'squeezelite']

  return (
    <div style={s.overlay} onClick={doClose}>
      <div style={s.sheet} onClick={e => e.stopPropagation()}>
        <div style={s.handle} />
        <div style={s.header}>
          <h2 style={s.title}>{mode === 'move' ? 'Switch playback to…' : 'Output'}</h2>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              style={{ ...s.iconBtn, opacity: refreshing ? 0.6 : 1 }}
              onClick={refresh}
              disabled={refreshing}
              title="Re-scan">
              <RefreshCw size={14} style={refreshing ? { animation: 'spin 1s linear infinite' } : {}} />
            </button>
            <button style={s.iconBtn} onClick={doClose} title="Close"><X size={14} /></button>
          </div>
        </div>

        <div style={s.scrollArea}>
          {protocolOrder.map(proto => {
            const list = grouped[proto] || []
            if (list.length === 0) return null
            return (
              <div key={proto} style={s.section}>
                <div style={s.sectionHeader}>{PROTOCOL_LABELS[proto] || proto}</div>
                {list.map(r => {
                  // Multi-zone status (#v1.1.0.9): if this renderer's
                  // zone exists and is playing/paused, surface a pill
                  // showing the current track. Helps the user see at a
                  // glance "the Sonos is playing X, the DAC is paused
                  // on Y" before tapping.
                  const zoneState = zones && zones[r.id]
                  const isFocused = r.id === focusedZoneId
                  const z = zoneState || null
                  const playingHere = z && (z.status === 'playing' || z.status === 'loading')
                  const pausedHere  = z && z.status === 'paused' && z.currentTrack
                  return (
                    <div key={r.id} style={{ ...s.row, ...(isFocused ? s.rowActive : {}) }}>
                      <button style={s.rowBody} onClick={() => select(r)}>
                        <div style={s.iconCircle}><RendererIcon renderer={r} size={18} /></div>
                        <div style={s.rowText}>
                          <div style={s.rowName}>{r.name}</div>
                          <div style={s.rowMeta}>
                            {playingHere && z?.currentTrack
                              ? <span style={s.zoneStatusPlaying}>▶ {z.currentTrack.title || 'Playing'}</span>
                              : pausedHere
                                ? <span style={s.zoneStatusPaused}>❚❚ {z.currentTrack.title || 'Paused'}</span>
                                : <span>{r.ip}</span>}
                          </div>
                        </div>
                        {isFocused && <div style={s.activeDot} />}
                      </button>
                    </div>
                  )
                })}
              </div>
            )
          })}
          {Object.keys(grouped).length === 0 && (
            <div style={s.empty}>
              <div>No renderers found.</div>
              <button style={s.refreshBtn} onClick={refresh}>Search again</button>
            </div>
          )}
          {/* Hint: editing per-device settings (icon, fixed/variable,
              DSP bypass, Sonos 16-bit, etc) lives in Settings → Audio
              now (#v1.1.0.8). The Output sheet stays focused on
              picking where to play. */}
          <div style={s.editHint}>
            Edit device settings (icon, output mode, DSP, Sonos 16-bit) in <strong>Settings → Audio</strong>.
          </div>
        </div>
      </div>
    </div>
  )
}

const s = {
  overlay: { position: 'fixed', inset: 0, zIndex: 700, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'flex-end' },
  sheet: { background: 'var(--bg-surface)', borderRadius: '16px 16px 0 0', width: '100%', maxHeight: '70vh', display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--border)' },
  handle: { width: 40, height: 4, background: 'var(--text-muted)', borderRadius: 2, margin: '8px auto 4px', opacity: 0.4 },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 16px 12px', borderBottom: '1px solid var(--border)' },
  title: { fontSize: 16, fontWeight: 700, margin: 0 },
  iconBtn: { width: 30, height: 30, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-elevated)', color: 'var(--text-secondary)', border: '1px solid var(--border)', cursor: 'pointer' },
  scrollArea: { flex: 1, overflowY: 'auto', padding: '12px 12px 24px' },
  section: { marginBottom: 16 },
  sectionHeader: { fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-tertiary)', margin: '4px 8px 8px' },
  // Row is now a flex container holding the body button + edit
  // pencil side-by-side (#30.22). Background/border lives on the
  // wrapper so the active state highlights the whole row, not just
  // the body button.
  row: { width: '100%', display: 'flex', alignItems: 'stretch', borderRadius: 'var(--radius-md)', background: 'var(--bg-elevated)', border: '1px solid var(--border)', marginBottom: 6, overflow: 'hidden' },
  rowActive: { background: 'rgba(91,127,255,0.10)', borderColor: 'var(--accent)' },
  rowBody: { flex: 1, display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left' },
  // editBtn dropped in v1.1.0.8 -- pencil moved to Settings → Audio.
  // The hint below the device list points users there.
  editHint: {
    fontSize: 11, color: 'var(--text-tertiary)',
    padding: '14px 12px 8px',
    textAlign: 'center',
    lineHeight: 1.5,
  },
  iconCircle: { width: 32, height: 32, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-overlay)', color: 'var(--text-secondary)', flexShrink: 0 },
  rowText: { flex: 1, minWidth: 0 },
  rowName: { fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  rowMeta: { fontSize: 10, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' },
  // Per-zone status pills (#v1.1.0.9). Replaces the IP line when a
  // zone has live state to show.
  zoneStatusPlaying: {
    color: 'var(--accent)',
    fontFamily: 'inherit',
    fontWeight: 500,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    display: 'inline-block',
    maxWidth: '100%',
  },
  zoneStatusPaused: {
    color: 'var(--text-secondary)',
    fontFamily: 'inherit',
    fontWeight: 500,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    display: 'inline-block',
    maxWidth: '100%',
  },
  activeDot: { width: 8, height: 8, borderRadius: '50%', background: 'var(--accent)', flexShrink: 0 },
  empty: { padding: 30, textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13 },
  refreshBtn: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 14px', marginTop: 12, borderRadius: 16, background: 'var(--bg-elevated)', color: 'var(--text-secondary)', border: '1px solid var(--border)', cursor: 'pointer', fontSize: 12 },
}
