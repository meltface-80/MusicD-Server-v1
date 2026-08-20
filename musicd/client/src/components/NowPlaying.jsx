import React, { useState } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import { Play, Pause, Speaker, Volume2 } from 'lucide-react'
import NowPlayingFullScreen from './NowPlayingFullScreen'
import RendererIcon from './RendererIcon'

// Roon-style minimal mini-bar (#28.5).
//   [Play/Pause] [Track title + artist (tap → full-screen NP)]   [Renderer] [Volume]
//
// We deliberately strip everything else — album art, prev/next, signal-path
// orb, EQ animation. Those are all reachable from the full-screen Now Playing
// view. Keeping the mini bar to four targets makes a phone bar legible at a
// glance and leaves room for the centre text to actually breathe.
export default function NowPlaying({ onArtistClick, onAlbumClick, onGenreClick }) {
  const {
    playerStatus, currentTrack, rendererId,
    setShowRenderers,
    volume, outputMode, setPlayerState,
    renderers,
    zones, focusedZoneId,
    position, displayPosition,
  } = useStore()
  const [fullScreen, setFullScreen] = useState(false)
  const [volumePopup, setVolumePopup] = useState(false)

  const handlePause = async () => {
    if (!rendererId) return
    try { await api.post('/player/pause', { rendererId }) } catch {}
  }

  const handleVolume = async (val) => {
    setPlayerState({ volume: val })
    try { await api.post('/player/volume', { rendererId, volume: val }) } catch {}
  }

  const isPlaying = playerStatus === 'playing'
  const isLoading = playerStatus === 'loading'
  const activeRenderer = renderers.find(r => r.id === rendererId)

  // Multi-zone indicator (#v1.1.0.9): count how many *other* zones are
  // currently playing so we can surface a "+N" pip on the renderer
  // button. Tapping the renderer button still opens the Output sheet,
  // which now shows zones with their per-zone status.
  const otherPlayingCount = Object.entries(zones || {}).filter(([zid, z]) => {
    if (zid === focusedZoneId) return false
    return z.status === 'playing' || z.status === 'loading'
  }).length

  // v1.1.0.64: thin progress strip across the very top of the mini
  // bar. JPLAY shows playback position as an at-a-glance line above
  // the bar so you can see how close to track-end the playhead is
  // without opening the full-screen NP. Uses the smoothed
  // displayPosition (or falls back to raw position) to match the
  // full-screen progress.
  const duration = currentTrack?.duration || 0
  const shownPos = (displayPosition != null) ? displayPosition : position
  const progress = duration > 0 ? Math.min((shownPos / duration) * 100, 100) : 0

  return (
    <>
      {fullScreen && (
        <NowPlayingFullScreen
          onClose={() => setFullScreen(false)}
          onPause={handlePause}
          onArtistClick={(name) => { setFullScreen(false); onArtistClick && onArtistClick(name) }}
          onAlbumClick={(id) => { setFullScreen(false); onAlbumClick && onAlbumClick(id) }}
          onGenreClick={(g) => { setFullScreen(false); onGenreClick && onGenreClick(g) }}
        />
      )}

      {/* Lightweight inline volume popup. We mount it from the mini bar so
          users don't have to open full-screen NP just to nudge volume. */}
      {volumePopup && (
        <div style={s.volOverlay} onClick={() => setVolumePopup(false)}>
          <div style={s.volPopup} onClick={e => e.stopPropagation()}>
            <div style={s.volTitle}>Volume</div>
            <div style={s.volSliderWrap}>
              <span style={s.volMin}>0</span>
              <input
                type="range" min={0} max={100} value={volume}
                onChange={e => handleVolume(Number(e.target.value))}
                style={s.volSlider}
              />
              <span style={s.volMax}>{volume}</span>
            </div>
          </div>
        </div>
      )}

      <div style={s.bar}>
        {/* v1.1.0.64 — thin progress strip across the very top of
            the mini bar. Hidden when nothing is playing; otherwise
            shows the smoothed playhead as a 2px line. JPLAY uses
            this pattern so the user can see the position without
            opening full-screen NP. */}
        {currentTrack && (
          <div style={s.progressStrip}>
            <div style={{ ...s.progressFill, width: `${progress}%` }} />
          </div>
        )}

        {/* Album cover thumbnail (#v1.1.0.64). Sits to the left of
            the track text. Tapping the cover opens full-screen NP,
            same as tapping the text — gives a much more touch-
            friendly target especially with longer titles where the
            text column is full of ellipsis. Falls back to a neutral
            tile when there's no track or no art. */}
        <button
          style={s.coverTap}
          onClick={() => currentTrack && setFullScreen(true)}
          disabled={!currentTrack}
          aria-label="Open Now Playing"
        >
          {currentTrack ? (
            <img
              src={`/api/library/tracks/${currentTrack.id}/cover`}
              alt=""
              style={s.coverImg}
              onError={(e) => { e.target.style.display = 'none' }}
              draggable={false}
            />
          ) : (
            <div style={s.coverEmpty}>♫</div>
          )}
        </button>

        {/* Play/Pause — the dominant action. White circle, JPLAY-style. */}
        <button
          style={{ ...s.playBtn, opacity: currentTrack ? 1 : 0.5 }}
          onClick={(e) => { e.stopPropagation(); handlePause() }}
          disabled={!currentTrack}
          aria-label={isPlaying ? 'Pause' : 'Play'}
        >
          {isLoading
            ? <div style={s.spinner} />
            : isPlaying
              ? <Pause size={20} fill="currentColor" strokeWidth={0} />
              : <Play size={20} fill="currentColor" strokeWidth={0} />
          }
        </button>

        {/* Track text — flexible centre column. Tap anywhere here to open
            full-screen Now Playing. We keep it as a single button so the
            whole strip is one tap target rather than two-area click confusion. */}
        <button
          style={s.trackTap}
          onClick={() => currentTrack && setFullScreen(true)}
          disabled={!currentTrack}
        >
          {currentTrack ? (
            <>
              <div style={s.trackTitle}>{currentTrack.title}</div>
              <div style={s.trackArtist}>{currentTrack.artist}</div>
            </>
          ) : (
            <div style={s.idle}>Nothing playing</div>
          )}
        </button>

        {/* Right cluster: renderer picker, then volume. */}
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <button
            style={s.iconBtn}
            onClick={(e) => { e.stopPropagation(); setShowRenderers(true) }}
            title={activeRenderer ? `Output: ${activeRenderer.name}` : 'Pick output'}
            aria-label="Output"
          >
            {/* Renderer-specific icon when one is active (#30.22).
                Falls back to the generic Speaker icon when no renderer
                is selected. The picker button itself stays on this same
                tap target so the user can still switch outputs. */}
            {activeRenderer
              ? <RendererIcon renderer={activeRenderer} size={18} />
              : <Speaker size={18} />}
          </button>
          {/* Multi-zone pip (#v1.1.0.9): a small "+N" badge on the
              renderer button when other zones are also playing. Lets
              the user see at a glance "I have 2 things going" and tap
              through to the Output sheet to manage them. */}
          {otherPlayingCount > 0 && (
            <div style={s.zoneBadge} aria-label={`${otherPlayingCount} other zones playing`}>
              +{otherPlayingCount}
            </div>
          )}
        </div>
        {/* Volume slider hidden for fixed-mode renderers (#v1.1.0.8).
            The downstream amp owns the volume; showing the slider would
            be misleading.
            v1.1.0.91: icon now matches the one on the full-screen
            Now Playing — inline SVG of a tall device, drawn at 24px.
            Both icons share the same function (open the volume bar)
            so they should look the same. Size bumped from 18 to 24
            to match the +50% bar height. */}
        {outputMode !== 'fixed' && (
          <button
            style={s.iconBtn}
            onClick={(e) => { e.stopPropagation(); setVolumePopup(true) }}
            title="Volume"
            aria-label="Volume"
            disabled={!rendererId}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
              <rect x="5" y="3" width="14" height="18" rx="2"/>
              <line x1="12" y1="18" x2="12" y2="18.01"/>
            </svg>
          </button>
        )}
      </div>
    </>
  )
}

const s = {
  // v1.1.0.64 — JPLAY-style mini bar. Black ground (was charcoal
  // var(--bg-surface)), hairline border-top in --jp-border (was
  // the visible 10% white --border). The thin progress strip
  // sits absolutely at the top edge so it doesn't push the
  // height; the bar itself stays at --nowplaying-h.
  bar: {
    gridColumn: '1 / 3', gridRow: '2',
    background: 'var(--jp-bg-elevated)',
    borderTop: '1px solid var(--jp-border)',
    display: 'flex', alignItems: 'center',
    padding: '0 12px', gap: 12,
    // The bar now reaches the physical bottom edge, so its controls would
    // sit on the home indicator. Padding the content box (box-sizing is
    // border-box globally) re-centres them above it while the black ground
    // still fills to the edge — no chin, because this is the bar's own
    // padding and not a gap in the app shell.
    paddingBottom: 'env(safe-area-inset-bottom, 0px)',
    height: 'var(--nowplaying-h)', zIndex: 100,
    position: 'relative',
  },
  progressStrip: {
    position: 'absolute', top: 0, left: 0, right: 0,
    height: 2,
    background: 'rgba(var(--tint-rgb), 0.06)',
    overflow: 'hidden',
    pointerEvents: 'none',
  },
  progressFill: {
    height: '100%',
    background: 'var(--jp-accent)',
    transition: 'width 0.25s linear',
  },
  // v1.1.0.91: scaled up to match the +50% bar height (90→135).
  // Cover thumbnail 80×80 (was 56). Borders + radius unchanged
  // because they still read at the new size.
  coverTap: {
    width: 80, height: 80,
    borderRadius: 4, overflow: 'hidden',
    background: 'var(--jp-bg-surface)',
    border: 'none', padding: 0,
    flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    cursor: 'pointer',
  },
  coverImg: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
  coverEmpty: { fontSize: 30, color: 'rgba(var(--tint-rgb), 0.18)' },
  // Play button scaled 48→64 to match the bar growth. Same white
  // circle, same JPLAY-flat treatment, just larger to remain the
  // visual focal point of the bar.
  playBtn: {
    width: 64, height: 64, borderRadius: '50%',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--jp-accent)', color: 'var(--jp-bg)', border: 'none',
    cursor: 'pointer', flexShrink: 0,
    padding: 0,
  },
  spinner: { width: 22, height: 22, border: '2px solid rgba(0,0,0,0.2)', borderTopColor: 'var(--jp-bg)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' },

  // Tappable text column — flex 1 minWidth 0 so it truncates cleanly when
  // names are long instead of pushing the right cluster off-screen.
  trackTap: {
    flex: 1, minWidth: 0,
    display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'flex-start',
    background: 'none', border: 'none',
    padding: '0 4px', cursor: 'pointer',
    textAlign: 'left',
    height: '100%',
  },
  // 14/600 — slightly heavier than the 14/500 of the album row
  // because the mini-bar is fighting for attention at the bottom
  // of the screen. Title is the shoutiest token here.
  trackTitle: {
    fontSize: 14, fontWeight: 600,
    color: 'var(--jp-text)',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
    marginBottom: 2,
    width: '100%',
  },
  trackArtist: {
    fontSize: 12, fontWeight: 400, color: 'var(--jp-text-2)',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
    width: '100%',
  },
  idle: { fontSize: 13, color: 'var(--jp-text-3)' },

  // Right-cluster icon buttons (renderer + volume). No fill, no
  // border — just a quiet outline button on hover would be ideal
  // but we don't have hover-only-on-pointer-devices logic here, so
  // a permanent translucent fill is the compromise.
  iconBtn: {
    width: 38, height: 38,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'rgba(var(--tint-rgb), 0.04)',
    color: 'var(--jp-text-2)',
    border: '1px solid transparent',
    borderRadius: 6,
    cursor: 'pointer', padding: 0,
    flexShrink: 0,
  },

  // Multi-zone pip badge (#v1.1.0.9). Sits at the top-right corner of
  // the renderer icon button to show the user "+N other zones are
  // playing right now". Small but distinct -- accent colour, white
  // text, doesn't obscure the renderer icon.
  zoneBadge: {
    position: 'absolute',
    top: -4, right: -4,
    minWidth: 18, height: 18,
    padding: '0 4px',
    background: 'var(--accent)',
    color: 'var(--on-accent)',
    borderRadius: 9,
    fontSize: 10, fontWeight: 700,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    boxShadow: '0 0 0 2px var(--bg-surface)',
    pointerEvents: 'none',
  },

  // Volume popup — same layout as the full-screen NP one for consistency.
  volOverlay: {
    position: 'fixed', inset: 0, zIndex: 800,
    display: 'flex', alignItems: 'flex-end',
    background: 'rgba(0,0,0,0.3)',
  },
  volPopup: {
    background: 'var(--bg-surface)',
    border: '1px solid var(--border)',
    borderRadius: '20px 20px 0 0',
    width: '100%', padding: '20px 24px 48px',
    // v1.1.3.9 — clear the home indicator on top of the 48px.
    paddingBottom: 'calc(48px + var(--safe-bot))',
  },
  volTitle: { fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 20, textAlign: 'center' },
  volSliderWrap: { display: 'flex', alignItems: 'center', gap: 12 },
  volSlider: { flex: 1, accentColor: 'var(--accent)' },
  volMin: { fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', width: 16 },
  volMax: { fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', width: 28, textAlign: 'right' },
}
