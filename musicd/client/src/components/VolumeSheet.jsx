import React, { useEffect, useState } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import { Sliders, Cast, Settings, X, Plus, Minus, Volume2 } from 'lucide-react'
import RendererModal from './RendererModal'
import DspTab from './DspTab'
import { DeviceSettingsPage } from './AudioSection'

// The volume sheet, and the three places it can send you (v1.1.26.0).
//
// There were two of these. The full-screen Now Playing one had an icon row
// (DSP / Switch / Device), a Volume2 glyph, discrete − / + steps and a "Fixed
// Output" state for renderers whose volume the app does not own. The mini
// transport bar's had a title, a "0", a slider and a number — and a comment
// claiming it was "the same layout as the full-screen NP one for consistency",
// which is exactly the aspiration that had already failed. Every improvement
// since v54 landed on one of them.
//
// One component now, and it owns its own destinations rather than taking three
// callbacks: what "Switch output" means must not depend on which bar you
// opened it from. The host is told when a destination is open (onOverlayChange)
// because the Now Playing screen suppresses its queue swipe while anything is
// stacked over it — that is the host's business, not this sheet's.
const VOLUME_STEP = 1

export default function VolumeSheet({ onClose, onOverlayChange }) {
  const {
    volume, outputMode, rendererId, renderers, setPlayerState,
  } = useStore()

  // Which destination is open, if any. Opening one closes the sheet itself, so
  // the user is never left with two stacked overlays to back out of.
  const [dest, setDest] = useState(null)   // 'dsp' | 'switch' | 'device' | null

  const activeRenderer = renderers.find(r => r.id === rendererId)

  // The host suppresses gestures while a destination is up. Reported from an
  // effect rather than from the click handlers so it cannot get out of step
  // with what is actually rendered.
  useEffect(() => {
    if (onOverlayChange) onOverlayChange(!!dest)
  }, [dest, onOverlayChange])
  // And cleared on unmount: a host left believing an overlay is open would
  // suppress its gestures forever.
  useEffect(() => () => { if (onOverlayChange) onOverlayChange(false) }, [onOverlayChange])

  const handleVolume = async (val) => {
    setPlayerState({ volume: val })
    try { await api.post('/player/volume', { rendererId, volume: val }) } catch {}
  }

  // v1.1.3.8 — discrete volume steps for the − / + buttons beside the
  // slider. Routed through handleVolume so the optimistic store update
  // and the POST stay in one place, and clamped to the same 0–100
  // range the slider enforces. Bails when already at a rail so a tap
  // on a disabled rail can't fire a pointless request.
  const handleVolumeStep = (delta) => {
    const next = Math.max(0, Math.min(100, volume + delta))
    if (next === volume) return
    handleVolume(next)
  }

  const goto = (which) => { setDest(which) }
  const back = () => setDest(null)

  if (dest === 'dsp') {
    return (
      <div style={s.modalOverlay}>
        <DspOverlay rendererId={rendererId} onClose={back} />
      </div>
    )
  }
  if (dest === 'device') {
    return (
      <div style={s.modalOverlay}>
        <DeviceSettingsOverlay
          rendererId={rendererId}
          renderer={activeRenderer}
          onClose={back}
        />
      </div>
    )
  }
  if (dest === 'switch') {
    return (
      <div style={{ position: 'absolute', inset: 0, zIndex: 700 }}>
        <RendererModal mode="move" onClose={back} />
      </div>
    )
  }

  return (
    <div style={s.volOverlay} onClick={onClose}>
      <div style={s.volPopup} onClick={e => e.stopPropagation()}>
        {/* Icon row above the slider (#v1.1.0.54). Three actions:
            DSP shortcut, switch-output device, device-settings cog. */}
        <div style={s.volIconRow}>
          <button
            style={s.volIconBtn}
            onClick={() => goto('dsp')}
            title="DSP settings"
            aria-label="Open DSP settings"
          >
            <Sliders size={18} />
            <span style={s.volIconLabel}>DSP</span>
          </button>
          <button
            style={s.volIconBtn}
            onClick={() => goto('switch')}
            title="Switch output device"
            aria-label="Switch output device"
          >
            <Cast size={18} />
            <span style={s.volIconLabel}>Switch</span>
          </button>
          <button
            style={s.volIconBtn}
            onClick={() => goto('device')}
            title="Audio device settings"
            aria-label="Audio device settings"
          >
            <Settings size={18} />
            <span style={s.volIconLabel}>Device</span>
          </button>
        </div>

        {/* Volume slider — only shown when the renderer's output is
            variable. Fixed-output devices show a static label instead so the
            user understands the sheet is still useful for the icon row even
            though the slider would be inert. */}
        {outputMode !== 'fixed' ? (
          <div style={s.volSliderWrap}>
            <Volume2 size={16} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
            <input
              type="range" min={0} max={100} value={volume}
              onChange={e => handleVolume(Number(e.target.value))}
              style={s.volSlider}
            />
            <span style={s.volMax}>{volume}</span>
            {/* v1.1.3.8 — discrete − / + steps at the right end of
                the row, for people who'd rather tap than drag. Bound
                to onClick only (no touch handlers) so one tap fires
                exactly once and nothing races the slider's own drag,
                which is left completely untouched. */}
            <div style={s.volStepGroup}>
              <button
                style={{ ...s.volStepBtn, opacity: volume > 0 ? 1 : 0.3 }}
                onClick={() => handleVolumeStep(-VOLUME_STEP)}
                disabled={volume <= 0}
                title="Volume down"
                aria-label="Volume down"
              >
                <Minus size={16} />
              </button>
              <button
                style={{ ...s.volStepBtn, opacity: volume < 100 ? 1 : 0.3 }}
                onClick={() => handleVolumeStep(VOLUME_STEP)}
                disabled={volume >= 100}
                title="Volume up"
                aria-label="Volume up"
              >
                <Plus size={16} />
              </button>
            </div>
          </div>
        ) : (
          <div style={s.volFixedLabel}>Fixed Output</div>
        )}
      </div>
    </div>
  )
}

// v1.1.0.54 — DSP settings for the active renderer, over whatever opened it.
export function DspOverlay({ rendererId, onClose }) {
  // v56: switched from CommonJS require() to ES import at the top of
  // the module. Vite (the client bundler) doesn't expose require() in
  // the browser, so the v55 build threw "require is not defined" the
  // moment the user tapped DSP — overlay never mounted, looked dead.
  return (
    <div style={s.dspOverlay}>
      <div style={s.dspOverlayHeader}>
        <button style={s.dspOverlayClose} onClick={onClose} aria-label="Close DSP">
          <X size={22} />
        </button>
        <span style={s.dspOverlayTitle}>DSP</span>
        <div style={{ width: 36 }} />
      </div>
      <div style={s.dspOverlayBody}>
        {/* Pass forceRendererId so DspTab locks to the active renderer
            and hides its own dropdown. Without this, the user could
            switch which renderer they're editing while playing through
            a different one — confusing. */}
        <DspTab forceRendererId={rendererId} />
      </div>
    </div>
  )
}

// v1.1.0.54 — the device settings page for the currently-playing renderer.
export function DeviceSettingsOverlay({ rendererId, renderer, onClose }) {
  // v56: switched from require() to top-level ES import. Same Vite
  // browser-runtime issue as DspOverlay — v55's require call broke
  // the overlay before it could render.
  const [device, setDevice] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await api.get('/audio/all')
      const d = (r.devices || []).find(x => x.id === rendererId)
      if (!d) {
        setError('not-found')
      } else {
        setDevice(d)
      }
    } catch (e) {
      setError(e?.message || 'load failed')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [rendererId])

  // Optimistic local update + server persistence — same wiring as the
  // Audio Devices section uses.
  const updateSettings = async (id, patch) => {
    setDevice(prev => (prev ? { ...prev, ...patch } : prev))
    try {
      await api.post(`/audio/renderers/${encodeURIComponent(id)}/settings`, patch)
    } catch (e) {
      console.warn('Settings update failed:', e)
      load()
    }
  }

  return (
    <div style={s.dspOverlay}>
      <div style={s.dspOverlayHeader}>
        <button style={s.dspOverlayClose} onClick={onClose} aria-label="Close">
          <X size={22} />
        </button>
        <span style={s.dspOverlayTitle}>{device?.name || renderer?.name || 'Device'}</span>
        <div style={{ width: 36 }} />
      </div>
      <div style={s.dspOverlayBody}>
        {loading && (
          <div style={{ padding: '24px 18px', color: 'var(--text-tertiary)', fontSize: 14 }}>
            Loading…
          </div>
        )}
        {!loading && error === 'not-found' && (
          <div style={{ padding: '14px 18px', color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.6 }}>
            <b>{renderer?.name || 'This device'}</b> doesn't expose per-device audio settings.
            Sonos, DLNA, and other network renderers are configured at the device itself —
            try the Sonos app or your renderer's web UI.
          </div>
        )}
        {!loading && error && error !== 'not-found' && (
          <div style={{ padding: '14px 18px', color: 'var(--red, #f47174)', fontSize: 14 }}>
            Couldn't load device settings: {error}
          </div>
        )}
        {!loading && !error && device && (
          // Pass a no-op onBack — the overlay's X button handles close.
          // DeviceSettingsPage's internal back button will appear and
          // call onBack; we make it close the overlay too so the user
          // has two consistent ways out.
          <DeviceSettingsPage
            device={device}
            onBack={onClose}
            onUpdate={updateSettings}
          />
        )}
      </div>
    </div>
  )
}

const s = {
  // The sheet and its destinations are absolutely positioned, so whichever
  // host renders <VolumeSheet /> has to give them a positioned ancestor. The
  // Now Playing screen is position:fixed; the mini bar wraps this in one.
  volOverlay: {
    position: 'absolute', inset: 0, zIndex: 600,
    display: 'flex', alignItems: 'flex-end',
    background: 'rgba(0,0,0,0.3)',
  },
  volPopup: {
    background: 'var(--jp-bg-surface)',
    border: '1px solid rgba(var(--tint-rgb), 0.1)',
    borderRadius: '20px 20px 0 0',
    width: '100%',
    // v1.1.0.91: trimmed bottom padding 48 → 28, top 20 → 16. Popup
    // reads slightly more compact without losing breathing room.
    padding: '16px 24px 28px',
    // v1.1.3.8: the slider sat too low, so drag gestures collided with
    // the iOS swipe-up-to-close gesture. Clear the home indicator, then
    // 44px of actual breathing room on top of it.
    //
    // This padding belongs to the popup, never to the app shell. Putting
    // an inset on the root grid instead reserves a visible band at the
    // bottom of every screen and pushes the top controls out of reach —
    // that was the v1.1.3.8 regression. Components pad themselves; the
    // shell stays edge to edge.
    paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 44px)',
  },
  volSliderWrap: { display: 'flex', alignItems: 'center', gap: 12 },
  volSlider: { flex: 1, accentColor: 'var(--accent)' },
  volMax: { fontSize: 12, color: 'rgba(var(--tint-rgb), 0.5)', fontFamily: 'var(--font-mono)', width: 28, textAlign: 'right' },
  // v1.1.3.8 — circular − / + volume steps at the right end of the
  // slider row. Same 36px circle as the Now Playing screen's device
  // button so every round control reads as one family. touch-action
  // manipulation kills the double-tap-zoom delay so a quick series of
  // taps registers as a series of single taps.
  volStepGroup: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 },
  volStepBtn: {
    width: 36, height: 36,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: 'rgba(var(--tint-rgb), 0.85)',
    background: 'rgba(var(--tint-rgb), 0.08)',
    border: '1px solid rgba(var(--tint-rgb), 0.12)',
    borderRadius: 999,
    cursor: 'pointer',
    flexShrink: 0,
    touchAction: 'manipulation',
  },
  volIconRow: {
    display: 'flex', justifyContent: 'space-around',
    paddingBottom: 8, marginBottom: 14,
  },
  volIconBtn: {
    display: 'inline-flex', flexDirection: 'column', alignItems: 'center',
    gap: 4, padding: '6px 14px',
    background: 'transparent',
    border: 'none',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
  },
  volIconLabel: { fontSize: 12, fontWeight: 500, letterSpacing: '0.02em' },
  volFixedLabel: {
    textAlign: 'center', padding: '12px 0',
    fontSize: 14, fontWeight: 500,
    color: 'var(--text-tertiary)',
    fontFamily: 'var(--font-mono)',
  },

  modalOverlay: {
    position: 'absolute', inset: 0, zIndex: 700,
    background: 'var(--bg-base)',
    display: 'flex', flexDirection: 'column',
    animation: 'settings-slide-in 0.2s ease',
  },
  dspOverlay: {
    position: 'absolute', inset: 0,
    background: 'var(--bg-base)',
    display: 'flex', flexDirection: 'column',
    overflow: 'hidden',
  },
  dspOverlayHeader: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '14px 14px 10px',
    paddingTop: 'calc(14px + var(--safe-top))',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0,
  },
  dspOverlayClose: {
    width: 36, height: 36,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'none', border: 'none',
    color: 'var(--text-primary)',
    cursor: 'pointer', borderRadius: 6,
  },
  dspOverlayTitle: {
    fontSize: 15, fontWeight: 700,
    color: 'var(--text-primary)',
    letterSpacing: '0.02em',
  },
  dspOverlayBody: {
    flex: 1, overflowY: 'auto',
    padding: '8px 14px 80px',
  },
}
