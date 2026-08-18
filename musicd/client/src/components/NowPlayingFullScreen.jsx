import React, { useState, useRef, useEffect } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import { ChevronLeft, Play, Pause, SkipBack, SkipForward, ChevronUp, ChevronDown, Trash2, Speaker, Check, Music, ListMusic, Sliders, Cast, Settings, X, Plus, Minus, Volume2, Share2, MoreHorizontal, Heart, Disc, User, Tag, Bookmark, Star, Sparkles } from 'lucide-react'
import RendererModal from './RendererModal'
// v56: pull these in at module load instead of via dynamic require()
// inside the component bodies. Vite doesn't provide require() in the
// browser bundle, so the v55 in-function requires threw at runtime
// and the overlays never opened.
import DspTab from './DspTab'
import { DeviceSettingsPage } from './AudioSection'
// v57: pull FormatBadge from AlbumDetail (named export added in v57)
// so the format strip under the transport row uses the same visual
// language as the per-track rows in the album view.
import { FormatBadge } from './AlbumDetail'

function fmtTime(s) {
  if (!s || s < 0) return '0:00'
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}

// v1.1.3.8 — step used by the − / + volume buttons beside the slider.
const VOLUME_STEP = 5

function pathOrbColor(signalPath) {
  if (!signalPath || signalPath.length === 0) return '#444'
  const c = signalPath[0]?.orbColor
  if (c === 'green') return '#3fd07a'
  if (c === 'purple') return '#b27aff'
  if (c === 'yellow') return '#f5c450'
  if (c === 'red') return '#e05555'
  return '#3fd07a'
}

// v1.1.0.53: returns true when the current DSP profile predicts that
// the chain will clip (FIR boost + headroom < 0 dBFS). Drives a red
// orb plus a soft pulse so the user sees the warning at a glance from
// the player without going to settings.
function pathClipping(signalPath) {
  return !!signalPath?.[0]?.clippingPredicted
}

export default function NowPlayingFullScreen({ onClose, onPause, onArtistClick, onAlbumClick, onGenreClick }) {
  const {
    playerStatus, currentTrack, queue, queueIndex,
    position, displayPosition, renderers, rendererId, volume, outputMode, signalPath,
    setPlayerState, setShowSignalPath,
    playNext, playPrev,
  } = useStore()

  const [imgErr, setImgErr] = useState(false)
  const [showVolume, setShowVolume] = useState(false)
  const [showRendererLocal, setShowRendererLocal] = useState(false)
  // v54: DSP overlay + device-settings overlay both open over NowPlaying
  // and close back to it. Triggered from the volume popover icon row.
  const [showDsp, setShowDsp] = useState(false)
  const [showDeviceSettings, setShowDeviceSettings] = useState(false)
  // v57: ⋯ overflow menu (top-right) and About-the-Track panel.
  // Overflow opens a small dropdown with track-context actions.
  // About is a full-screen overlay launched from the chevron under
  // the HI-RES badge.
  const [showOverflow, setShowOverflow] = useState(false)
  const [showAbout, setShowAbout] = useState(false)
  // v1.1.3.8 — share-card sheet. Held as { url, blob }: the preview
  // <img> needs an object URL, but Web Share needs the raw blob to
  // build a File. Same shape AlbumDetail uses for the album card.
  const [shareCard, setShareCard] = useState(null)
  const [shareLoading, setShareLoading] = useState(false)
  // v1.1.0.60 — swipe-up gesture origin tracking for About chevron
  const aboutSwipeStartY = useRef(null)
  const [activeTab, setActiveTab] = useState('nowplaying')

  // v1.1.0.60 — horizontal swipe across the NowPlaying screen.
  // Swipe right→left switches to the queue tab. Swipe left→right
  // returns to the now-playing tab. Mirrors the gesture already
  // wired into the About panel. Disabled when any overlay is open
  // (volume popup, DSP, About, Renderer modal, share card — v1.1.3.8)
  // so they don't fight for the gesture.
  const screenTouchRef = useRef({ x: 0, y: 0, t: 0, active: false })
  const onScreenTouchStart = (e) => {
    if (showVolume || showRendererLocal || showDsp || showDeviceSettings || showAbout || showOverflow || shareCard) {
      screenTouchRef.current.active = false
      return
    }
    const t = e.touches?.[0]
    if (!t) return
    screenTouchRef.current = { x: t.clientX, y: t.clientY, t: Date.now(), active: true }
  }
  const onScreenTouchEnd = (e) => {
    const ref = screenTouchRef.current
    if (!ref.active) return
    ref.active = false
    const t = e.changedTouches?.[0]
    if (!t) return
    const dx = t.clientX - ref.x
    const dy = t.clientY - ref.y
    const ax = Math.abs(dx)
    const ay = Math.abs(dy)
    // Require a clearly horizontal gesture; ignore short flicks and
    // anything mostly-vertical (those might be queue scrolls or the
    // chevron swipe-up).
    if (ax < 60 || ax < ay * 1.5) return
    if (dx < 0 && activeTab !== 'queue') {
      // Right→left: open queue
      setActiveTab('queue')
    } else if (dx > 0 && activeTab === 'queue') {
      // Left→right: back to now-playing
      setActiveTab('nowplaying')
    }
  }

  const isPlaying = playerStatus === 'playing'
  const isLoading = playerStatus === 'loading'
  const duration = currentTrack?.duration || 0
  // Use the smoothed display position (interpolated between server polls)
  // for the visible bar/timer; fall back to the raw anchor when no display
  // value is set yet (initial render before the ticker starts).
  const shown = (displayPosition != null) ? displayPosition : position
  const progress = duration > 0 ? Math.min((shown / duration) * 100, 100) : 0
  const hasPrev = queueIndex > 0
  const hasNext = queueIndex < queue.length - 1
  const activeRenderer = renderers.find(r => r.id === rendererId)
  const orbColor = pathOrbColor(signalPath)
  // v1.1.0.60: only pulse the clip-warning orb while audio is actually
  // playing. The clipping flag itself is a static prediction (computed
  // on profile save), so it stays red after playback stops — visually
  // suggesting "live clipping happening NOW" even when nothing's
  // playing. The flag still drives the orb colour (red) so the user
  // can see the prediction; we just stop the pulse animation when the
  // player is paused / stopped / loading. Bug reported in v58
  // listening session (Psychedelic Furs / Come All Ye Faithful).
  const orbClipping = pathClipping(signalPath) && playerStatus === 'playing'

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

  // v1.1.3.8 — share the current track as a card. The server renders
  // the PNG for whatever is playing right now, so there's nothing to
  // pass in; we fetch it, preview it, then hand the blob off to the
  // system share sheet. Mirrors AlbumDetail's album-card share flow.
  const handleShare = async () => {
    if (shareLoading) return
    setShareLoading(true)
    try {
      const res = await fetch('/api/share/now-playing.png')
      if (!res.ok) throw new Error('Share image failed')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      setShareCard({ url, blob })
    } catch (e) {
      console.error('Share failed:', e)
    } finally {
      setShareLoading(false)
    }
  }

  const handleShareSend = async () => {
    if (!shareCard) return
    const name = `${currentTrack?.title || 'now-playing'}.png`
    const file = new File([shareCard.blob], name, { type: 'image/png' })
    // Phone path: Web Share with a File attachment opens the native
    // iOS share sheet. canShare is checked against the real payload —
    // some browsers expose share() but reject files outright.
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({
          files: [file],
          title: currentTrack?.title || 'Now Playing',
          text: `${currentTrack?.title || ''} — ${currentTrack?.artist || ''}`,
        })
      } catch (e) {
        // Dismissing the iOS share sheet throws AbortError. That's the
        // user saying "no", not a failure worth surfacing.
        if (e.name !== 'AbortError') console.error('Share failed:', e)
      }
    } else {
      // Desktop fallback: download the PNG.
      const a = document.createElement('a')
      a.href = shareCard.url
      a.download = name
      a.click()
    }
  }

  const handleShareClose = () => {
    if (shareCard) URL.revokeObjectURL(shareCard.url)
    setShareCard(null)
  }

  const handleRendererOpen = () => {
    setShowRendererLocal(true)
  }

  const handleQueueTab = () => {
    setActiveTab('queue')
  }

  const handleNowPlayingTab = () => {
    setActiveTab('nowplaying')
  }

  return (
    <div
      style={s.screen}
      onTouchStart={onScreenTouchStart}
      onTouchEnd={onScreenTouchEnd}
    >
      {/* Static dark background — no blur overlay */}
      <div style={s.staticBg} />

      {/* Subtle art colour wash — very faint */}
      {currentTrack && !imgErr && (
        <div style={{ ...s.bgWash, backgroundImage: `url(/api/library/tracks/${currentTrack.id}/cover)` }} />
      )}

      {/* Volume popup — overlays this screen only */}
      {showVolume && (
        <div style={s.volOverlay} onClick={() => setShowVolume(false)}>
          <div style={s.volPopup} onClick={e => e.stopPropagation()}>
            {/* Icon row above the slider (#v1.1.0.54). Three actions:
                DSP shortcut, switch-output device, device-settings cog.
                Each closes the volume popover when used so the user
                isn't left with two overlays stacked. */}
            <div style={s.volIconRow}>
              <button
                style={s.volIconBtn}
                onClick={() => { setShowVolume(false); setShowDsp(true); }}
                title="DSP settings"
                aria-label="Open DSP settings"
              >
                <Sliders size={18} />
                <span style={s.volIconLabel}>DSP</span>
              </button>
              <button
                style={s.volIconBtn}
                onClick={() => { setShowVolume(false); setShowRendererLocal(true); }}
                title="Switch output device"
                aria-label="Switch output device"
              >
                <Cast size={18} />
                <span style={s.volIconLabel}>Switch</span>
              </button>
              <button
                style={s.volIconBtn}
                onClick={() => { setShowVolume(false); setShowDeviceSettings(true); }}
                title="Audio device settings"
                aria-label="Audio device settings"
              >
                <Settings size={18} />
                <span style={s.volIconLabel}>Device</span>
              </button>
            </div>

            {/* Volume slider — only shown when the renderer's output
                is variable. Fixed-output devices show a static label
                instead so the user understands the popover is still
                useful for the icon row even though the slider is
                inert. */}
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
      )}

      {/* v1.1.3.8 — share-card sheet. Bottom sheet with the rendered
          PNG and a single action: the system share sheet on a phone,
          a plain download everywhere else. Tapping the scrim closes
          it and revokes the object URL. */}
      {shareCard && (
        <div style={s.shareOverlay} onClick={handleShareClose}>
          <div style={s.shareSheet} onClick={e => e.stopPropagation()}>
            <div style={s.shareHeader}>
              <span style={s.shareTitle}>Share Card</span>
              <button style={s.shareClose} onClick={handleShareClose} aria-label="Close share card">
                <X size={16} />
              </button>
            </div>
            <img src={shareCard.url} alt="Share card" style={s.sharePreview} />
            <button style={s.shareBtn} onClick={handleShareSend}>
              <Share2 size={15} />
              {navigator.canShare ? 'Share…' : 'Download'}
            </button>
          </div>
        </div>
      )}

      {/* DSP overlay (#v1.1.0.54). Opens above NowPlaying showing the
          DSP settings for the active renderer. Closing returns here. */}
      {showDsp && (
        <div style={s.modalOverlay}>
          <DspOverlay rendererId={rendererId} onClose={() => setShowDsp(false)} />
        </div>
      )}

      {/* Audio-device-settings overlay (#v1.1.0.54). Opens the device
          settings page for the currently-playing renderer over
          NowPlaying. Closes back to NowPlaying. */}
      {showDeviceSettings && (
        <div style={s.modalOverlay}>
          <DeviceSettingsOverlay
            rendererId={rendererId}
            renderer={activeRenderer}
            onClose={() => setShowDeviceSettings(false)}
          />
        </div>
      )}

      {/* v57: ⋯ overflow menu — small dropdown anchored under the
          top-right ⋯ button. Track-context actions: Album, Artist,
          Genre links work today; Add to Favorites toggles the album
          favourite (track-level lands in v58); the rest are placeholder
          rows showing what's coming so the user can see the shape. */}
      {showOverflow && currentTrack && (
        <TrackOverflowMenu
          track={currentTrack}
          onClose={() => setShowOverflow(false)}
          onCloseScreen={onClose}
          onArtistClick={onArtistClick}
          onAlbumClick={onAlbumClick}
          onGenreClick={onGenreClick}
        />
      )}

      {/* v57: About-the-Track full-screen overlay. Opens from the
          chevron under the format strip. Shows artist bio + track
          metadata that exists today; track credits and suggestions
          are stubbed/hidden until those data sources land. */}
      {showAbout && currentTrack && (
        <div style={s.modalOverlay}>
          <AboutTrackOverlay
            track={currentTrack}
            onClose={() => setShowAbout(false)}
            onSwipeQueue={() => { setShowAbout(false); setActiveTab('queue') }}
          />
        </div>
      )}

      {/* Renderer modal — renders inside this screen, no navigation.
          v56: mode="move" so tapping a device actually transfers the
          active queue to that renderer. The picker behind the volume
          popover's Switch icon is conceptually "Switch playback to…",
          not "Look at another zone". */}
      {showRendererLocal && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 700 }}>
          <RendererModal mode="move" onClose={() => setShowRendererLocal(false)} />
        </div>
      )}

      <div style={s.inner}>
        {/* Top bar (#v1.1.0.54). Two icon-pill tabs for Now Playing and
            Queue, centred. Back arrow on the left, action overflow ⋯
            on the right. Orb has moved to the bottom-right corner where
            it sits stacked above the device-icon button — see bottomBar
            below. */}
        <div style={s.topBar}>
          <button style={s.topBtn} onClick={onClose} aria-label="Back">
            <ChevronLeft size={22} />
          </button>

          <div style={s.tabPill}>
            <button
              style={{ ...s.tabPillBtn, ...(activeTab === 'nowplaying' ? s.tabPillBtnActive : {}) }}
              onClick={handleNowPlayingTab}
              aria-label="Now Playing"
              aria-pressed={activeTab === 'nowplaying'}
            >
              <Music size={18} strokeWidth={2} />
            </button>
            <button
              style={{ ...s.tabPillBtn, ...(activeTab === 'queue' ? s.tabPillBtnActive : {}) }}
              onClick={handleQueueTab}
              aria-label="Queue"
              aria-pressed={activeTab === 'queue'}
            >
              <ListMusic size={18} strokeWidth={2} />
            </button>
          </div>

          {/* v57: ⋯ overflow menu trigger. Replaces the v56 spacer.
              Opens TrackOptionsMenu with track-context actions (album,
              artist, genre links, favourite, plus disabled placeholder
              rows for items shipping in v58+). */}
          <button
            style={s.topBtn}
            onClick={() => setShowOverflow(true)}
            aria-label="Track options"
            aria-haspopup="menu"
            aria-expanded={showOverflow}
            disabled={!currentTrack}
          >
            <MoreHorizontal size={22} />
          </button>
        </div>

        {activeTab === 'queue' ? (
          <QueueView queue={queue} queueIndex={queueIndex} onSelectTrack={(i) => {
            const { playQueue } = useStore.getState()
            playQueue(queue, i)
          }} />
        ) : (
          <>
            {/* Album art */}
            <div style={s.artWrap}>
              {currentTrack && !imgErr
                ? <img src={`/api/library/tracks/${currentTrack.id}/cover`} style={s.art} onError={() => setImgErr(true)} />
                : <div style={s.artEmpty}><span style={{ fontSize: 72, opacity: 0.1 }}>♫</span></div>
              }
            </div>

            {/* Track info */}
            <div style={s.infoSection}>
              <div style={s.trackTitle}>{currentTrack?.title || 'Nothing playing'}</div>
              {currentTrack?.artist && (
                <div style={s.trackArtist} onClick={() => onArtistClick && onArtistClick(currentTrack.album_artist || currentTrack.artist)}>
                  {currentTrack.artist}
                </div>
              )}
              {currentTrack?.album && (
                <div style={s.trackAlbum} onClick={async () => {
                  if (!onAlbumClick) return
                  try {
                    const albums = await api.get(`/library/albums?artist=${encodeURIComponent(currentTrack.album_artist || currentTrack.artist)}&limit=200`)
                    const a = albums.find(x => x.title === currentTrack.album)
                    if (a) onAlbumClick(a.id)
                  } catch {}
                }}>{currentTrack.album}</div>
              )}
            </div>

            {/* Progress */}
            <div style={s.progressSection}>
              <div style={s.progressTrack}>
                <div style={{ ...s.progressFill, width: `${progress}%` }} />
              </div>
              <div style={s.times}>
                <span>{fmtTime(shown)}</span>
                <span>{fmtTime(duration)}</span>
              </div>
            </div>

            {/* Transport */}
            <div style={s.transport}>
              <button style={{ ...s.skipBtn, opacity: hasPrev ? 1 : 0.3 }} onClick={playPrev} disabled={!hasPrev}>
                <SkipBack size={28} fill="currentColor" strokeWidth={0} />
              </button>
              <button style={s.playBtn} onClick={onPause} disabled={!currentTrack}>
                {isLoading
                  ? <div style={s.spinner} />
                  : isPlaying
                    ? <Pause size={30} fill="currentColor" strokeWidth={0} />
                    : <Play size={30} fill="currentColor" strokeWidth={0} />
                }
              </button>
              <button style={{ ...s.skipBtn, opacity: hasNext ? 1 : 0.3 }} onClick={playNext} disabled={!hasNext}>
                <SkipForward size={28} fill="currentColor" strokeWidth={0} />
              </button>
            </div>

            {/* v57: format/sample-rate strip under transport. Was shown
                inline-only in album rows previously; pulling it up to
                NowPlaying so the user always knows what they're
                hearing. Tapping the chevron under it opens the
                About-the-Track panel. */}
            {currentTrack && (
              <div style={s.formatStrip}>
                <FormatBadge format={currentTrack.format} codec={currentTrack.codec} />
                <span style={s.formatText}>
                  {currentTrack.bit_depth ? `${currentTrack.bit_depth}-bit ` : ''}
                  {currentTrack.sample_rate
                    ? `${(currentTrack.sample_rate / 1000).toFixed(currentTrack.sample_rate % 1000 === 0 ? 0 : 1)}kHz`
                    : ''}
                </span>
              </div>
            )}
            {/* v1.1.0.60 — chevron is now a small (44×44) square
                absolutely pinned to the bottom-centre. It opens the
                About panel on tap, and also accepts a swipe-up
                gesture originating on the chevron itself (anything
                ≥30 px upward movement counts). The earlier full-width
                button was opening the About panel on accidental
                taps anywhere below the format strip. */}
            <button
              style={s.aboutChevron}
              onClick={() => currentTrack && setShowAbout(true)}
              onTouchStart={(e) => {
                if (!currentTrack) return
                aboutSwipeStartY.current = e.touches[0].clientY
              }}
              onTouchEnd={(e) => {
                if (!currentTrack) return
                const startY = aboutSwipeStartY.current
                aboutSwipeStartY.current = null
                if (startY == null) return
                const dy = e.changedTouches[0].clientY - startY
                if (dy < -30) setShowAbout(true)
              }}
              disabled={!currentTrack}
              aria-label="About this track"
              title="About this track"
            >
              <ChevronDown size={20} />
            </button>

            {/* Bottom bar.
                v1.1.0.91: orb moved from a stacked column on the right
                to the bottom-left, on the same horizontal plane as
                the volume / output icon. The two were paired together
                in v54 with the orb above the device icon, but the
                visual weight of two stacked controls on the right
                made the layout asymmetric. Spreading them across the
                bottom bar (orb left, device-icon right) reads
                cleaner and gives each control breathing room. */}
            <div style={s.bottomBar}>
              <div style={s.bottomLeftCluster}>
                {/* Signal-path orb. v53 retained: red + pulsing when
                    the DSP chain predicts clipping. */}
                <button
                  style={s.orbBtnSmall}
                  onClick={() => setShowSignalPath(true)}
                  title={orbClipping ? "Signal Path — chain may clip" : "Signal Path"}
                  aria-label="Signal Path"
                >
                  <div style={{
                    ...s.orb,
                    background: orbColor,
                    boxShadow: `0 0 ${orbClipping ? 14 : 10}px ${orbColor}`,
                    animation: orbClipping ? 'orbClipPulse 1s ease-in-out infinite' : 'none',
                  }} />
                </button>

                {/* v1.1.3.8 — share the current track as a card. The
                    v91 comment on bottomLeftCluster left room for
                    exactly this: extra controls stack horizontally to
                    the right of the orb. Disabled while the server
                    renders the PNG so it can't be double-fired. */}
                <button
                  style={{ ...s.shareIconBtn, opacity: currentTrack && !shareLoading ? 1 : 0.3 }}
                  onClick={handleShare}
                  disabled={!currentTrack || shareLoading}
                  title="Share this track"
                  aria-label="Share this track"
                >
                  <Share2 size={18} />
                </button>
              </div>
              <div style={{ flex: 1 }} />
              <div style={s.bottomRightCluster}>
                {/* Device-icon button. Always present — opens the
                    volume popover regardless of whether the renderer's
                    output is variable or fixed (the popover handles
                    that distinction internally). */}
                <button
                  style={s.deviceIconBtn}
                  onClick={() => setShowVolume(true)}
                  title={activeRenderer?.name || 'Output'}
                  aria-label="Volume and output"
                >
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                    <rect x="5" y="3" width="14" height="18" rx="2"/>
                    <line x1="12" y1="18" x2="12" y2="18.01"/>
                  </svg>
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function QueueView({ queue, queueIndex, onSelectTrack }) {
  function fmtT(s) { if(!s) return ''; return `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}` }
  // v55: queue rows stay informational, but the header now has + and
  // − action buttons that open sub-menus. Selection mode is entered
  // via tap-and-hold on a row OR by choosing "Add/Remove selected"
  // from the menu. While selecting, rows show a checkbox; the header
  // becomes a "N selected · Cancel · Apply" bar.
  const { playQueue, radio, setRadio, removeFromQueueBatch, appendIdsToQueue } = useStore()

  // Sub-menu open state. Only one menu (or none) open at a time.
  const [openMenu, setOpenMenu] = useState(null) // 'add' | 'remove' | null
  // Selection mode + which indices are selected.
  const [isSelecting, setIsSelecting] = useState(false)
  const [selectedIndices, setSelectedIndices] = useState(new Set())
  // Pending action when selection started from a menu — we apply it
  // when the user hits "Apply".
  const [pendingAction, setPendingAction] = useState(null) // 'add' | 'remove' | null
  // Tap-and-hold timer ref. We start a timer on touchstart/mousedown,
  // cancel it on touchend/mouseup. If it fires, we enter select mode.
  const holdTimerRef = useRef(null)
  const HOLD_MS = 500

  // "Remaining" header counts tracks AFTER the now-playing one and
  // sums their durations.
  const remainingTracks = Math.max(queue.length - queueIndex - 1, 0)
  const remainingSec = queue.slice(queueIndex + 1).reduce((acc, t) => acc + (t.duration || 0), 0)
  const remainingMin = Math.floor(remainingSec / 60)
  const remainingS = Math.floor(remainingSec % 60)
  const remainingLabel = remainingMin > 0
    ? `${remainingMin}m ${remainingS}s left`
    : `${remainingS}s left`

  // ---- Selection helpers ----
  const toggleSelected = (i) => {
    setSelectedIndices(prev => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i); else next.add(i)
      return next
    })
  }
  const exitSelectMode = () => {
    setIsSelecting(false)
    setSelectedIndices(new Set())
    setPendingAction(null)
  }
  const enterSelectMode = (preselectIndex = null) => {
    setIsSelecting(true)
    setSelectedIndices(preselectIndex == null ? new Set() : new Set([preselectIndex]))
  }

  // ---- Tap-and-hold ----
  const startHold = (i) => {
    if (isSelecting) return // already selecting; tap-and-hold is a no-op
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current)
    holdTimerRef.current = setTimeout(() => {
      enterSelectMode(i)
      holdTimerRef.current = null
    }, HOLD_MS)
  }
  const cancelHold = () => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current)
      holdTimerRef.current = null
    }
  }

  // ---- Bulk action handlers ----
  // The four "remove" actions all funnel through removeFromQueueBatch
  // with different index sets. The current track is excluded
  // server-side, so it's safe to include it in the indices.
  const removeAll = async () => {
    setOpenMenu(null)
    const all = Array.from({ length: queue.length }, (_, i) => i)
    await removeFromQueueBatch(all)
  }
  const removePlayed = async () => {
    setOpenMenu(null)
    if (queueIndex <= 0) return
    const played = Array.from({ length: queueIndex }, (_, i) => i)
    await removeFromQueueBatch(played)
  }
  const removeUpcoming = async () => {
    setOpenMenu(null)
    const upcoming = []
    for (let i = queueIndex + 1; i < queue.length; i++) upcoming.push(i)
    if (upcoming.length === 0) return
    await removeFromQueueBatch(upcoming)
  }
  const removeSelectedAction = async () => {
    setOpenMenu(null)
    if (!isSelecting) {
      // Enter selection mode and remember the pending action
      enterSelectMode(null)
      setPendingAction('remove')
      return
    }
    if (selectedIndices.size === 0) { exitSelectMode(); return }
    await removeFromQueueBatch(Array.from(selectedIndices))
    exitSelectMode()
  }

  // The four "add" actions all funnel through appendIdsToQueue. "Add all"
  // duplicates the entire queue at the end; "Add played" duplicates
  // played tracks; "Add now playing" duplicates the current track;
  // "Add selected" duplicates whichever rows the user picks.
  const addAll = async () => {
    setOpenMenu(null)
    const ids = queue.map(t => t.id).filter(Boolean)
    if (ids.length === 0) return
    await appendIdsToQueue(ids)
  }
  const addPlayed = async () => {
    setOpenMenu(null)
    const ids = queue.slice(0, queueIndex).map(t => t.id).filter(Boolean)
    if (ids.length === 0) return
    await appendIdsToQueue(ids)
  }
  const addNowPlaying = async () => {
    setOpenMenu(null)
    const t = queue[queueIndex]
    if (!t || !t.id) return
    await appendIdsToQueue([t.id])
  }
  const addSelectedAction = async () => {
    setOpenMenu(null)
    if (!isSelecting) {
      enterSelectMode(null)
      setPendingAction('add')
      return
    }
    if (selectedIndices.size === 0) { exitSelectMode(); return }
    const ids = Array.from(selectedIndices)
      .map(i => queue[i]?.id)
      .filter(Boolean)
    if (ids.length === 0) { exitSelectMode(); return }
    await appendIdsToQueue(ids)
    exitSelectMode()
  }

  // Apply button in the selection-mode header. Routes to whichever
  // pending action the user picked from the sub-menu. If they entered
  // selection mode via tap-and-hold (no pending action), Apply is
  // hidden — they must tap "Cancel" or pick an action menu.
  const applyPending = async () => {
    if (pendingAction === 'remove') {
      if (selectedIndices.size === 0) { exitSelectMode(); return }
      await removeFromQueueBatch(Array.from(selectedIndices))
    } else if (pendingAction === 'add') {
      const ids = Array.from(selectedIndices).map(i => queue[i]?.id).filter(Boolean)
      if (ids.length > 0) await appendIdsToQueue(ids)
    }
    exitSelectMode()
  }

  return (
    <div style={s.queueList}>
      {/* Radio toggle row */}
      <div style={s.queueRadioRow}>
        <span style={s.queueRadioLabel}>Start radio after queue ends</span>
        <button
          style={{ ...s.queueRadioToggle, ...(radio ? s.queueRadioToggleOn : {}) }}
          onClick={() => setRadio(!radio)}
          role="switch"
          aria-checked={radio}
          aria-label="Radio after queue ends"
        >
          <span style={{ ...s.queueRadioKnob, ...(radio ? s.queueRadioKnobOn : {}) }} />
        </button>
      </div>

      {/* Header. In normal mode: remaining count + bulk action icons.
          In selection mode: selected count + Cancel + Apply (when an
          action is pending from a menu pick). */}
      {isSelecting ? (
        <div style={s.queueSelectHeader}>
          <span style={s.queueSelectCount}>
            {selectedIndices.size} selected
          </span>
          <div style={s.queueSelectBtns}>
            <button
              style={s.queueSelectCancel}
              onClick={exitSelectMode}
            >Cancel</button>
            {pendingAction && (
              <button
                style={{ ...s.queueSelectApply, ...(selectedIndices.size === 0 ? s.queueSelectApplyDisabled : {}) }}
                onClick={applyPending}
                disabled={selectedIndices.size === 0}
              >
                {pendingAction === 'remove' ? 'Remove' : 'Add'}
              </button>
            )}
          </div>
        </div>
      ) : (
        <div style={s.queueHeader}>
          <span style={s.queueHeaderCount}>
            {remainingTracks === 0
              ? 'No tracks remaining'
              : `${remainingTracks} track${remainingTracks === 1 ? '' : 's'} remaining`}
          </span>
          {remainingTracks > 0 && (
            <span style={s.queueHeaderTime}>· {remainingLabel}</span>
          )}
          <div style={{ flex: 1 }} />
          {/* Remove menu trigger */}
          <div style={{ position: 'relative' }}>
            <button
              style={{ ...s.queueBulkBtn, ...(openMenu === 'remove' ? s.queueBulkBtnActive : {}) }}
              onClick={() => setOpenMenu(openMenu === 'remove' ? null : 'remove')}
              aria-label="Remove tracks from queue"
              aria-expanded={openMenu === 'remove'}
            >
              <Minus size={16} />
            </button>
            {openMenu === 'remove' && (
              <BulkMenu onClose={() => setOpenMenu(null)}>
                <button style={s.queueMenuItem} onClick={removeAll}>Remove all</button>
                <button
                  style={{ ...s.queueMenuItem, ...(queueIndex <= 0 ? s.queueMenuItemDisabled : {}) }}
                  onClick={removePlayed}
                  disabled={queueIndex <= 0}
                >Remove played</button>
                <button
                  style={{ ...s.queueMenuItem, ...(queueIndex >= queue.length - 1 ? s.queueMenuItemDisabled : {}) }}
                  onClick={removeUpcoming}
                  disabled={queueIndex >= queue.length - 1}
                >Remove upcoming</button>
                <button style={s.queueMenuItem} onClick={removeSelectedAction}>Remove selected…</button>
              </BulkMenu>
            )}
          </div>
          {/* Add menu trigger */}
          <div style={{ position: 'relative' }}>
            <button
              style={{ ...s.queueBulkBtn, ...(openMenu === 'add' ? s.queueBulkBtnActive : {}) }}
              onClick={() => setOpenMenu(openMenu === 'add' ? null : 'add')}
              aria-label="Add tracks to queue"
              aria-expanded={openMenu === 'add'}
            >
              <Plus size={16} />
            </button>
            {openMenu === 'add' && (
              <BulkMenu onClose={() => setOpenMenu(null)}>
                <button style={s.queueMenuItem} onClick={addAll}>Add all</button>
                <button
                  style={{ ...s.queueMenuItem, ...(queueIndex <= 0 ? s.queueMenuItemDisabled : {}) }}
                  onClick={addPlayed}
                  disabled={queueIndex <= 0}
                >Add played</button>
                <button
                  style={{ ...s.queueMenuItem, ...(!queue[queueIndex]?.id ? s.queueMenuItemDisabled : {}) }}
                  onClick={addNowPlaying}
                  disabled={!queue[queueIndex]?.id}
                >Add now playing</button>
                <button style={s.queueMenuItem} onClick={addSelectedAction}>Add selected…</button>
              </BulkMenu>
            )}
          </div>
        </div>
      )}

      {queue.length === 0 ? (
        <div style={s.queueEmpty}>Queue is empty</div>
      ) : queue.map((track, i) => {
        const isCurrent = i === queueIndex
        const isPast = i < queueIndex
        const isSelected = selectedIndices.has(i)
        // The currently-playing track can't be selected for removal
        // (the server refuses) and including it in "Add selected"
        // would just duplicate the current track to the end — fine,
        // but the UX is clearer if it's just disabled in select mode.
        const selectable = isSelecting && !isCurrent

        const onRowTap = () => {
          if (isSelecting) {
            if (selectable) toggleSelected(i)
            return
          }
          playQueue(queue, i)
        }

        return (
          <React.Fragment key={(track.id || 'x') + ':' + i}>
            {isCurrent && (
              <div style={s.npDivider}>
                <span style={s.npDividerLine} />
                <span style={s.npDividerLabel}>Now Playing</span>
                <span style={s.npDividerLine} />
              </div>
            )}
            <button
              style={{
                ...s.queueRow2,
                opacity: isPast && !isSelecting ? 0.45 : 1,
                background: isSelected
                  ? 'rgba(107,138,255,0.14)'
                  : (isCurrent ? 'rgba(255,255,255,0.04)' : 'none'),
                cursor: isSelecting && !selectable ? 'not-allowed' : 'pointer',
              }}
              onClick={onRowTap}
              onTouchStart={() => startHold(i)}
              onTouchEnd={cancelHold}
              onTouchMove={cancelHold}
              onTouchCancel={cancelHold}
              onMouseDown={() => startHold(i)}
              onMouseUp={cancelHold}
              onMouseLeave={cancelHold}
            >
              {/* Selection-mode checkbox replaces the cover-art slot */}
              {isSelecting ? (
                <span style={{
                  ...s.queueRowCheckbox,
                  ...(isSelected ? s.queueRowCheckboxOn : {}),
                  ...(selectable ? {} : s.queueRowCheckboxDisabled),
                }}>
                  {isSelected && <Check size={14} strokeWidth={3} />}
                </span>
              ) : (
                <span style={s.queueRowArt}>
                  {track.id
                    ? <img src={`/api/library/tracks/${track.id}/cover`} style={s.queueRowArtImg} alt="" onError={e => { e.currentTarget.style.display = 'none' }} />
                    : null}
                </span>
              )}
              <span style={s.queueRowInfo}>
                <span style={{
                  ...s.queueRowTitle,
                  color: isCurrent ? 'var(--accent)' : 'var(--text-primary)',
                }}>
                  {track.title || track.id}
                </span>
                <span style={s.queueRowSub}>
                  <span style={s.queueRowArtist}>{track.artist || ''}</span>
                  {track.album && <span style={s.queueRowSubDot}>·</span>}
                  {track.album && <span style={s.queueRowAlbum}>{track.album}</span>}
                </span>
              </span>
              <span style={s.queueRowDur}>{fmtT(track.duration)}</span>
            </button>
          </React.Fragment>
        )
      })}
    </div>
  )
}

// v55: tiny dropdown that closes on outside click. Used for the
// queue header + and − sub-menus.
function BulkMenu({ children, onClose }) {
  const ref = useRef(null)
  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose()
    }
    // Defer for a tick so the click that *opened* the menu doesn't
    // also close it.
    const t = setTimeout(() => {
      document.addEventListener('mousedown', handler)
      document.addEventListener('touchstart', handler)
    }, 0)
    return () => {
      clearTimeout(t)
      document.removeEventListener('mousedown', handler)
      document.removeEventListener('touchstart', handler)
    }
  }, [onClose])
  return (
    <div ref={ref} style={s.queueMenu} role="menu">
      {children}
    </div>
  )
}

// v54: DSP overlay opens above NowPlaying. Lazy import to avoid a
// circular dependency between NowPlaying and DspTab (DspTab pulls the
// store, store pulls modal state, etc).
function DspOverlay({ rendererId, onClose }) {
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

// v54: device-settings overlay. Mirrors the per-device settings page
// from Settings → Audio Devices, but opened over NowPlaying for the
// currently playing renderer. Closes back to NowPlaying.
function DeviceSettingsOverlay({ rendererId, renderer, onClose }) {
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
          <div style={{ padding: '24px 18px', color: 'var(--text-tertiary)', fontSize: 13 }}>
            Loading…
          </div>
        )}
        {!loading && error === 'not-found' && (
          <div style={{ padding: '14px 18px', color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.6 }}>
            <b>{renderer?.name || 'This device'}</b> doesn't expose per-device audio settings.
            Sonos, DLNA, and other network renderers are configured at the device itself —
            try the Sonos app or your renderer's web UI.
          </div>
        )}
        {!loading && error && error !== 'not-found' && (
          <div style={{ padding: '14px 18px', color: 'var(--red, #f47174)', fontSize: 13 }}>
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

// v57: ⋯ overflow menu. Small dropdown anchored under the top-right
// ⋯ button. The first three items navigate (Album / Artist / Genre);
// "Add to Favorites" toggles the *album* favourite for now (track-
// level fav lands in v58 — at that point the wording can become
// "Favourite this track"). The remaining items render disabled with
// a "v58+" badge so the surface is committed but doesn't lie about
// being functional.
function TrackOverflowMenu({ track, onClose, onCloseScreen, onArtistClick, onAlbumClick, onGenreClick }) {
  const ref = useRef(null)
  const { setTrackFavorite, setTrackRating } = useStore()
  const [isFav, setIsFav] = useState(false)
  const [favBusy, setFavBusy] = useState(false)
  const albumIdRef = useRef(null)
  // v58: track-level favourite + rating state. Seeded from the track
  // object passed in from NowPlaying (which the WebSocket broadcast
  // hydrates). Local state mirrors so the UI updates instantly on
  // tap; revert on server failure.
  const [isTrackFav, setIsTrackFav] = useState(!!track?.is_favorite)
  const [trackFavBusy, setTrackFavBusy] = useState(false)
  const [trackRating, setTrackRating_] = useState(track?.user_rating || 0)
  const [showRater, setShowRater] = useState(false)
  const [ratingBusy, setRatingBusy] = useState(false)

  const toggleTrackFav = async () => {
    if (!track?.id || trackFavBusy) return
    const next = !isTrackFav
    setIsTrackFav(next)
    setTrackFavBusy(true)
    const r = await setTrackFavorite(track.id, next)
    setTrackFavBusy(false)
    if (r == null || !!r !== next) setIsTrackFav(r == null ? !next : !!r)
  }
  const setRating = async (n) => {
    if (!track?.id || ratingBusy) return
    const prev = trackRating
    setTrackRating_(n)
    setRatingBusy(true)
    const r = await setTrackRating(track.id, n)
    setRatingBusy(false)
    if (r == null) setTrackRating_(prev)
    else setTrackRating_(r)
  }

  // Resolve album id for the current track on mount so we can read +
  // toggle is_favorite. Tracks carry album text but not always an id;
  // the album lookup is by (album, album_artist or artist).
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const albums = await api.get(
          `/library/albums?artist=${encodeURIComponent(track.album_artist || track.artist || '')}&limit=200`
        )
        const a = albums.find(x => x.title === track.album)
        if (cancelled) return
        if (a) {
          albumIdRef.current = a.id
          setIsFav(!!a.is_favorite)
        }
      } catch {}
    }
    load()
    return () => { cancelled = true }
  }, [track?.id])

  // Outside-click dismiss. Defer one tick so the click that opened
  // the menu doesn't immediately close it.
  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose()
    }
    const t = setTimeout(() => {
      document.addEventListener('mousedown', handler)
      document.addEventListener('touchstart', handler)
    }, 0)
    return () => {
      clearTimeout(t)
      document.removeEventListener('mousedown', handler)
      document.removeEventListener('touchstart', handler)
    }
  }, [onClose])

  // Each navigation handler closes the menu, then closes the
  // NowPlaying full-screen so the destination shows. Without the
  // close, the user stays on NowPlaying with nothing visible
  // changed.
  const goAlbum = async () => {
    onClose()
    if (!onAlbumClick) return
    try {
      const albums = await api.get(
        `/library/albums?artist=${encodeURIComponent(track.album_artist || track.artist || '')}&limit=200`
      )
      const a = albums.find(x => x.title === track.album)
      if (a) {
        if (onCloseScreen) onCloseScreen()
        onAlbumClick(a.id)
      }
    } catch (e) { console.warn('go-album failed:', e) }
  }
  const goArtist = () => {
    onClose()
    if (onArtistClick && (track.album_artist || track.artist)) {
      if (onCloseScreen) onCloseScreen()
      onArtistClick(track.album_artist || track.artist)
    }
  }
  const goGenre = () => {
    onClose()
    if (onGenreClick && track.genre) {
      if (onCloseScreen) onCloseScreen()
      onGenreClick(track.genre)
    }
  }
  const toggleFav = async () => {
    if (!albumIdRef.current || favBusy) return
    setFavBusy(true)
    const next = !isFav
    setIsFav(next)
    try {
      await api.post(`/library/albums/${albumIdRef.current}/favorite`, { value: next })
    } catch {
      setIsFav(!next) // revert
    } finally {
      setFavBusy(false)
    }
  }

  return (
    <div style={s.overflowSheet} role="menu">
      <div ref={ref} style={s.overflowBox}>
        {/* Header — track summary (mini cover + title + artist + actions) */}
        <div style={s.overflowHeader}>
          <span style={s.overflowArt}>
            {track.id && (
              <img
                src={`/api/library/tracks/${track.id}/cover`}
                style={s.overflowArtImg}
                alt=""
                onError={e => { e.currentTarget.style.display = 'none' }}
              />
            )}
          </span>
          <div style={s.overflowHeaderText}>
            <div style={s.overflowTitle}>{track.title || track.id}</div>
            <div style={s.overflowSub}>{track.artist || ''}</div>
          </div>
        </div>

        <button style={s.overflowItem} onClick={goAlbum} disabled={!track.album}>
          <Disc size={16} style={s.overflowItemIcon} />
          <span>{track.album || 'Album'}</span>
        </button>
        <button style={s.overflowItem} onClick={goArtist} disabled={!(track.artist || track.album_artist)}>
          <User size={16} style={s.overflowItemIcon} />
          <span>{track.album_artist || track.artist || 'Artist'}</span>
        </button>
        <button style={s.overflowItem} onClick={goGenre} disabled={!track.genre}>
          <Music size={16} style={s.overflowItemIcon} />
          <span>{track.genre || 'Genre'}</span>
        </button>

        <div style={s.overflowDivider} />

        {/* v58: track-level favourite. Independent of album favourite
            (which moves to a sub-action below). The state seed comes
            from track.is_favorite in the WebSocket-broadcast track
            object, but we also mirror local state so the icon updates
            immediately on tap. */}
        <button style={s.overflowItem} onClick={toggleTrackFav} disabled={!track.id || trackFavBusy}>
          <Heart
            size={16}
            style={s.overflowItemIcon}
            fill={isTrackFav ? '#ff3b5c' : 'none'}
            color={isTrackFav ? '#ff3b5c' : 'currentColor'}
          />
          <span>{isTrackFav ? 'Unfavourite this track' : 'Favourite this track'}</span>
        </button>

        {/* v58: track rating. Shows current value if rated; tapping
            opens the inline rating row (5 star buttons) below the
            menu. Tapping a star sets the rating; tapping the same
            star clears it (rating → 0). */}
        <button
          style={s.overflowItem}
          onClick={() => setShowRater(v => !v)}
          disabled={!track.id}
          aria-expanded={showRater}
        >
          <Star
            size={16}
            style={s.overflowItemIcon}
            fill={trackRating > 0 ? '#ffc62b' : 'none'}
            color={trackRating > 0 ? '#ffc62b' : 'currentColor'}
          />
          <span>{trackRating > 0 ? `Rated ${trackRating}/5` : 'Rate'}</span>
          <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-tertiary)' }}>
            {showRater ? 'Hide' : 'Edit'}
          </span>
        </button>
        {showRater && (
          <div style={s.raterRow}>
            {[1, 2, 3, 4, 5].map(n => (
              <button
                key={n}
                style={s.raterStar}
                onClick={() => setRating(n === trackRating ? 0 : n)}
                aria-label={`${n} star${n === 1 ? '' : 's'}`}
                disabled={ratingBusy}
              >
                <Star
                  size={22}
                  fill={n <= trackRating ? '#ffc62b' : 'none'}
                  color={n <= trackRating ? '#ffc62b' : 'currentColor'}
                  strokeWidth={n <= trackRating ? 0 : 1.6}
                />
              </button>
            ))}
            <button
              style={{ ...s.raterStar, marginLeft: 'auto' }}
              onClick={() => setRating(0)}
              aria-label="Clear rating"
              disabled={ratingBusy || trackRating === 0}
            >
              <X size={16} />
            </button>
          </div>
        )}

        <button style={s.overflowItem} onClick={toggleFav} disabled={!albumIdRef.current || favBusy}>
          <Heart
            size={16}
            style={{ ...s.overflowItemIcon, opacity: 0.7 }}
            fill={isFav ? '#ff3b5c' : 'none'}
            color={isFav ? '#ff3b5c' : 'currentColor'}
          />
          <span style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
            {isFav ? 'Remove album favourite' : 'Favourite this album'}
          </span>
        </button>

        {/* v60+ placeholders. Render disabled so the user sees the
            shape of the menu without being misled into expecting them
            to work. Each gets a small label in the trailing slot. */}
        <button style={s.overflowItemDisabled} disabled aria-disabled="true">
          <ListMusic size={16} style={s.overflowItemIcon} />
          <span>Add to Playlist</span>
          <span style={s.overflowSoon}>v60</span>
        </button>
        <button style={s.overflowItemDisabled} disabled aria-disabled="true">
          <Tag size={16} style={s.overflowItemIcon} />
          <span>Add to Tag</span>
          <span style={s.overflowSoon}>v61</span>
        </button>
        <button style={s.overflowItemDisabled} disabled aria-disabled="true">
          <Bookmark size={16} style={s.overflowItemIcon} />
          <span>Save for later</span>
          <span style={s.overflowSoon}>v61</span>
        </button>
        <button style={s.overflowItemDisabled} disabled aria-disabled="true">
          <Sparkles size={16} style={s.overflowItemIcon} />
          <span>Suggestions</span>
          <span style={s.overflowSoon}>v62+</span>
        </button>

        <button style={s.overflowClose} onClick={onClose}>Close</button>
      </div>
    </div>
  )
}

// v57: About-the-Track full-screen overlay. Renders a scrollable
// page with the artist bio (fetched on mount), track metadata fields,
// and stubbed sections (Track Credits / Suggestions) that hide
// themselves until backing data exists. Swipe-left dismisses to the
// queue tab; swipe-down dismisses to NowPlaying.
function AboutTrackOverlay({ track, onClose, onSwipeQueue }) {
  const [bioState, setBioState] = useState({ loading: true, text: null, error: null })
  const [bioExpanded, setBioExpanded] = useState(false)
  // Touch tracking for swipe gestures. We measure the start point on
  // touchstart and resolve a direction on touchend; if the swipe is
  // more horizontal than vertical we treat it as left/right, else
  // up/down. Threshold is conservative (60px) so casual scrolls
  // don't trigger.
  const touchRef = useRef({ x: 0, y: 0, t: 0 })
  const SWIPE_PX = 60

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const name = track.album_artist || track.artist
      if (!name) { setBioState({ loading: false, text: null, error: 'no-artist' }); return }
      try {
        const r = await api.get(`/library/artists/${encodeURIComponent(name)}/bio`)
        if (cancelled) return
        // bioFetch returns either { bio: "..." } or { content/summary } depending on source.
        const text = r?.bio || r?.content || r?.summary || null
        setBioState({ loading: false, text, error: text ? null : 'empty' })
      } catch (e) {
        if (!cancelled) setBioState({ loading: false, text: null, error: e.message || 'fetch failed' })
      }
    }
    load()
    return () => { cancelled = true }
  }, [track?.album_artist, track?.artist])

  // v1.1.0.72 — touch handler now only resolves *horizontal* swipes
  // (left → queue tab). The previous down-swipe-to-close was being
  // triggered by stray downward motion during normal reading scrolls
  // — even short flicks crossed the 60 px threshold, and on a long
  // bio you couldn't reach the bottom without the panel dismissing
  // itself. The X in the header is the canonical close. We keep the
  // start-point capture and use the AY < SWIPE_PX guard so a swipe
  // that's more vertical than horizontal is silently ignored rather
  // than mis-interpreted as a horizontal swipe with too little
  // X movement.
  const onTouchStart = (e) => {
    const t = e.touches?.[0]
    if (!t) return
    touchRef.current = { x: t.clientX, y: t.clientY, t: Date.now() }
  }
  const onTouchEnd = (e) => {
    const t = e.changedTouches?.[0]
    if (!t) return
    const dx = t.clientX - touchRef.current.x
    const dy = t.clientY - touchRef.current.y
    const ax = Math.abs(dx)
    const ay = Math.abs(dy)
    if (ax < SWIPE_PX) return
    // Only respond to motion that's clearly horizontal — at least
    // ~50% more X than Y. Otherwise the user is probably scrolling
    // (vertical-dominant) and we let the body's overflow handle it.
    if (ax < ay * 1.5) return
    // Horizontal swipe. Left → queue (mirrors the NowPlaying gesture).
    if (dx < -SWIPE_PX && onSwipeQueue) onSwipeQueue()
  }

  // Format helpers
  const fmtDur = (s) => {
    if (!s) return '—'
    const m = Math.floor(s / 60); const ss = Math.floor(s % 60)
    return `${m}:${String(ss).padStart(2, '0')}`
  }
  const fmtRate = (hz) => {
    if (!hz) return null
    return hz % 1000 === 0 ? `${hz / 1000}kHz` : `${(hz / 1000).toFixed(1)}kHz`
  }
  const audioFormat = [
    track.bit_depth ? `${track.bit_depth}-bit` : null,
    fmtRate(track.sample_rate),
  ].filter(Boolean).join(' · ')

  return (
    <div
      style={s.aboutOverlay}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      <div style={s.aboutHeader}>
        <button style={s.dspOverlayClose} onClick={onClose} aria-label="Close">
          <X size={22} />
        </button>
        <span style={s.dspOverlayTitle}>About</span>
        <div style={{ width: 36 }} />
      </div>

      <div style={s.aboutBody}>
        {/* Artist header */}
        <div style={s.aboutArtistHeader}>
          <span style={s.aboutArtistLabel}>Artist</span>
          <span style={s.aboutArtistName}>{track.album_artist || track.artist || 'Unknown'}</span>
        </div>

        {/* Bio. Collapsed to ~3 lines initially with a chevron to
            expand. Full text and any newlines are preserved. */}
        {bioState.loading && (
          <div style={s.aboutBioLoading}>Loading bio…</div>
        )}
        {!bioState.loading && bioState.text && (
          <div style={{ ...s.aboutBio, ...(bioExpanded ? {} : s.aboutBioCollapsed) }}>
            {bioState.text}
          </div>
        )}
        {!bioState.loading && bioState.text && (
          <button
            style={s.aboutBioToggle}
            onClick={() => setBioExpanded(v => !v)}
            aria-expanded={bioExpanded}
            aria-label={bioExpanded ? 'Collapse bio' : 'Expand bio'}
          >
            {bioExpanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
          </button>
        )}
        {!bioState.loading && !bioState.text && (
          <div style={s.aboutBioEmpty}>
            No biography available for this artist.
          </div>
        )}

        {/* About the track */}
        <div style={s.aboutSectionHeading}>
          <span style={s.aboutSectionRule} />
          About the Track
        </div>
        <AboutRow label="Title" value={track.title} />
        <AboutRow label="Album" value={track.album} />
        <AboutRow label="Duration" value={fmtDur(track.duration)} />
        {track.genre && <AboutRow label="Genre" value={track.genre} />}
        <AboutRow label="Artist" value={track.artist} />
        {audioFormat && <AboutRow label="Audio Format" value={audioFormat} />}
        {/* Composer / Label / Copyright / Album Release Date —
            placeholders for fields that don't exist in the schema
            today. They'll appear automatically once the scanner is
            extended to extract them from file tags. */}

        {/* Suggestions and Track Credits — backing data doesn't exist
            yet. Hidden until v58/v61+. The headings are deliberately
            absent rather than empty so the user doesn't see "Coming
            soon" stubs in a place where they expect data. */}
      </div>
    </div>
  )
}

function AboutRow({ label, value }) {
  return (
    <div style={s.aboutRow}>
      <div style={s.aboutRowLabel}>{label}</div>
      <div style={s.aboutRowValue}>{value || '—'}</div>
    </div>
  )
}

const s = {
  // v1.1.0.64 — JPLAY-style full-screen Now Playing.
  // Pure black ground (was #0a0a10 charcoal-blue). The bgWash
  // album-tinted blur stays but is dialled WAY back from the
  // previous setting (opacity 0.6 brightness 0.2) to a near-
  // imperceptible 0.18 brightness 0.10 — just enough warmth to
  // stop the screen feeling sterile, but not enough to read as
  // a colour cast.
  screen: { position: 'fixed', inset: 0, zIndex: 500, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  staticBg: { position: 'absolute', inset: 0, background: 'var(--jp-bg)', zIndex: 0 },
  bgWash: {
    position: 'absolute', inset: 0, zIndex: 1,
    backgroundSize: 'cover', backgroundPosition: 'center',
    filter: 'blur(80px) saturate(0.5) brightness(0.10)',
    opacity: 0.18,
  },
  volOverlay: {
    position: 'absolute', inset: 0, zIndex: 600,
    display: 'flex', alignItems: 'flex-end',
    background: 'rgba(0,0,0,0.3)',
  },
  volPopup: {
    background: '#1a1a24',
    border: '1px solid rgba(255,255,255,0.1)',
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
  volTitle: { fontSize: 14, fontWeight: 600, color: '#fff', marginBottom: 20, textAlign: 'center' },
  volSliderWrap: { display: 'flex', alignItems: 'center', gap: 12 },
  volSlider: { flex: 1, accentColor: 'var(--accent)' },
  volMin: { fontSize: 11, color: 'rgba(255,255,255,0.3)', fontFamily: 'var(--font-mono)', width: 16 },
  volMax: { fontSize: 11, color: 'rgba(255,255,255,0.5)', fontFamily: 'var(--font-mono)', width: 28, textAlign: 'right' },
  // v1.1.3.8 — circular − / + volume steps at the right end of the
  // slider row. Same 36px circle as deviceIconBtn so every round
  // control on this screen reads as one family. touch-action
  // manipulation kills the double-tap-zoom delay so a quick series of
  // taps registers as a series of single taps.
  volStepGroup: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 },
  volStepBtn: {
    width: 36, height: 36,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: 'rgba(255,255,255,0.85)',
    background: 'rgba(255,255,255,0.08)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 999,
    cursor: 'pointer',
    flexShrink: 0,
    touchAction: 'manipulation',
  },

  inner: { position: 'relative', zIndex: 2, display: 'flex', flexDirection: 'column', height: '100%', padding: '0 20px' },

  topBar: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    // Same reasoning as App.jsx's topbar: this screen is full-bleed under
    // viewport-fit=cover, so the row clears the status bar itself.
    paddingTop: 'calc(14px + env(safe-area-inset-top, 0px))',
    paddingBottom: 10, flexShrink: 0,
  },
  orbBtn: { width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none' },
  orb: { width: 11, height: 11, borderRadius: '50%', transition: 'all 0.3s' },
  topBtn: { width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.7)', background: 'none', border: 'none' },

  tabs: { display: 'flex', alignItems: 'center', gap: 20 },
  tabBtn: { background: 'none', border: 'none', cursor: 'pointer', padding: '2px 0', position: 'relative' },
  tabLabel: { fontSize: 12, fontWeight: 700, color: 'rgba(255,255,255,0.3)', letterSpacing: '0.08em', display: 'block' },
  tabLabelActive: { color: '#fff' },
  tabUnderline: { position: 'absolute', bottom: -2, left: 0, right: 0, height: 2, background: 'var(--accent)', borderRadius: 1 },

  // v54: icon-pill tabs for Now Playing / Queue. Single rounded
  // background with two icon buttons; the active button gets a
  // ring-outlined inset and the accent foreground colour, a la the
  // photo's Roon-ish design.
  tabPill: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: 4,
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid rgba(255,255,255,0.10)',
    borderRadius: 999,
  },
  tabPillBtn: {
    width: 36, height: 36,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    border: '1.5px solid transparent',
    borderRadius: 999,
    background: 'transparent',
    color: 'rgba(255,255,255,0.55)',
    cursor: 'pointer',
    transition: 'all 0.15s',
  },
  tabPillBtnActive: {
    color: 'var(--accent)',
    borderColor: 'var(--accent)',
    background: 'rgba(107,138,255,0.10)',
  },

  // v54: bottom-right stacked column. Kept defined for any leftover
  // callers but no longer used; v91 split orb and device-icon into
  // two horizontal clusters across the bottom bar (left: orb,
  // right: device-icon).
  bottomRightStack: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
  },
  // v1.1.0.91 — orb cluster on the bottom-left of the now-playing
  // screen, on the same horizontal plane as the volume / output
  // icon (bottom-right). Just the orb for now; if more controls
  // are added later they stack horizontally to the right.
  bottomLeftCluster: {
    display: 'flex', alignItems: 'center', gap: 6,
  },
  // v1.1.0.91 — device-icon cluster on the bottom-right.
  bottomRightCluster: {
    display: 'flex', alignItems: 'center', gap: 6,
  },
  orbBtnSmall: {
    width: 28, height: 28,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'none', border: 'none', cursor: 'pointer',
  },
  deviceIconBtn: {
    width: 36, height: 36,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: 'rgba(255,255,255,0.85)',
    background: 'rgba(255,255,255,0.08)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 999,
    cursor: 'pointer',
  },
  // v1.1.3.8 — share button beside the orb in the bottom-left
  // cluster. Same circle as deviceIconBtn so the two ends of the
  // bottom bar balance.
  shareIconBtn: {
    width: 36, height: 36,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: 'rgba(255,255,255,0.85)',
    background: 'rgba(255,255,255,0.08)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 999,
    cursor: 'pointer',
    touchAction: 'manipulation',
  },

  // v1.1.3.8 — share-card sheet. Same bottom-sheet geometry as the
  // ⋯ overflow box so the two read as siblings. Sits above every
  // other overlay on this screen (overflowSheet is 720).
  shareOverlay: {
    position: 'absolute', inset: 0, zIndex: 730,
    background: 'rgba(0,0,0,0.55)',
    display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
    animation: 'fadeIn 0.18s ease',
  },
  shareSheet: {
    width: '100%', maxWidth: 480,
    background: '#1a1a24',
    border: '1px solid rgba(255,255,255,0.10)',
    borderRadius: '20px 20px 0 0',
    boxShadow: '0 -10px 40px rgba(0,0,0,0.5)',
    paddingBottom: 32,
  },
  shareHeader: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '18px 20px 14px',
  },
  shareTitle: { fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' },
  shareClose: {
    width: 30, height: 30,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    borderRadius: 'var(--radius-sm)',
    background: 'var(--bg-elevated)',
    color: 'var(--text-tertiary)',
    border: 'none', cursor: 'pointer',
  },
  sharePreview: {
    width: 'calc(100% - 32px)', margin: '0 16px 16px',
    borderRadius: 10, display: 'block',
    boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
  },
  shareBtn: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    margin: '0 16px', width: 'calc(100% - 32px)',
    padding: '14px', borderRadius: 12,
    background: 'var(--accent)', color: '#fff',
    fontSize: 15, fontWeight: 700,
    border: 'none', cursor: 'pointer',
  },

  // v54: volume popover icon row + fixed-output label + slider tweaks.
  // The icon row is three buttons evenly spaced above the slider,
  // each one a small icon + label so the user can read what they do.
  // v1.1.0.91: borderBottom removed — the divider was reading too
  // hard against the dark popup background. The row sits directly
  // above the slider with just margin-spacing now, which is cleaner
  // and matches the JPLAY flat aesthetic.
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
  volIconLabel: { fontSize: 11, fontWeight: 500, letterSpacing: '0.02em' },
  volFixedLabel: {
    textAlign: 'center', padding: '12px 0',
    fontSize: 13, fontWeight: 500,
    color: 'var(--text-tertiary)',
    fontFamily: 'var(--font-mono)',
  },

  // v54: full-screen modal overlay sliding up over NowPlaying. Used
  // for the DSP overlay and the device-settings overlay.
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
    fontSize: 14, fontWeight: 700,
    color: 'var(--text-primary)',
    letterSpacing: '0.02em',
  },
  dspOverlayBody: {
    flex: 1, overflowY: 'auto',
    padding: '8px 14px 80px',
  },

  // v54: queue redesign. Informational rows; per-row actions removed.
  // Two-line layout (title / artist · album), clamped to 1 line each
  // with ellipsis. Phone vs tablet differs only in horizontal padding.
  queueRadioRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '10px 4px 14px',
    borderBottom: '1px solid var(--border)',
    marginBottom: 10,
  },
  queueRadioLabel: {
    fontSize: 13, fontWeight: 500, color: 'var(--text-primary)',
  },
  queueRadioToggle: {
    width: 44, height: 24, padding: 2,
    background: 'rgba(255,255,255,0.10)',
    border: '1px solid rgba(255,255,255,0.14)',
    borderRadius: 999,
    cursor: 'pointer',
    transition: 'background 0.15s',
    display: 'inline-flex', alignItems: 'center',
  },
  queueRadioToggleOn: {
    background: 'var(--accent)',
    border: '1px solid var(--accent)',
  },
  queueRadioKnob: {
    width: 18, height: 18, borderRadius: '50%',
    background: '#fff',
    boxShadow: '0 1px 3px rgba(0,0,0,0.5)',
    transition: 'transform 0.15s',
    transform: 'translateX(0)',
    display: 'inline-block',
  },
  queueRadioKnobOn: {
    transform: 'translateX(20px)',
  },
  queueHeader: {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '6px 4px 14px',
    fontSize: 12,
    color: 'var(--text-tertiary)',
    fontFamily: 'var(--font-mono)',
  },
  queueHeaderCount: { fontWeight: 600, color: 'var(--text-secondary)' },
  queueHeaderTime: { fontWeight: 500 },

  // v54: queueRow2 is the new informational row. (Old queueRow style
  // is kept for any leftover references but no longer used in the
  // QueueView render.)
  queueRow2: {
    display: 'grid',
    gridTemplateColumns: '40px 1fr auto',
    alignItems: 'center',
    gap: 10,
    padding: '7px 6px',
    border: 'none', cursor: 'pointer',
    textAlign: 'left',
    borderRadius: 6,
    width: '100%',
  },
  queueRowArt: {
    width: 36, height: 36,
    background: 'rgba(255,255,255,0.06)',
    borderRadius: 4,
    overflow: 'hidden', flexShrink: 0,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  },
  queueRowArtImg: {
    width: '100%', height: '100%', objectFit: 'cover', display: 'block',
  },
  queueRowInfo: { minWidth: 0, overflow: 'hidden' },
  queueRowTitle: {
    fontSize: 13, fontWeight: 600,
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
    display: 'block',
    marginBottom: 2,
  },
  queueRowSub: {
    fontSize: 11,
    color: 'var(--text-tertiary)',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
    display: 'block',
  },
  queueRowArtist: { color: 'var(--text-secondary)' },
  queueRowSubDot: { margin: '0 4px' },
  queueRowAlbum: { color: 'var(--text-tertiary)' },
  queueRowDur: {
    fontSize: 11, color: 'var(--text-tertiary)',
    fontFamily: 'var(--font-mono)',
    flexShrink: 0,
  },

  // "Now Playing" divider above the active queue row.
  npDivider: {
    display: 'flex', alignItems: 'center', gap: 8,
    margin: '14px 4px 6px',
  },
  npDividerLine: {
    flex: 1, height: 1, background: 'var(--accent)',
    opacity: 0.35,
  },
  npDividerLabel: {
    fontSize: 10, fontWeight: 700, letterSpacing: '0.10em',
    textTransform: 'uppercase',
    color: 'var(--accent)',
  },

  // v55: queue header bulk-action buttons (+ and −) and the
  // dropdown menu they open. Round-rect mono icon buttons that turn
  // accent-coloured when their menu is open.
  queueBulkBtn: {
    width: 30, height: 30,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid rgba(255,255,255,0.10)',
    borderRadius: 999,
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    marginLeft: 6,
  },
  queueBulkBtnActive: {
    background: 'rgba(107,138,255,0.16)',
    borderColor: 'var(--accent)',
    color: 'var(--accent)',
  },
  queueMenu: {
    position: 'absolute',
    top: 'calc(100% + 6px)',
    right: 0,
    minWidth: 180,
    background: '#1a1a24',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 8,
    boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
    padding: 4,
    zIndex: 800,
    display: 'flex', flexDirection: 'column',
  },
  queueMenuItem: {
    display: 'block', width: '100%',
    padding: '10px 12px',
    background: 'transparent',
    border: 'none',
    textAlign: 'left',
    color: 'var(--text-primary)',
    fontSize: 13,
    cursor: 'pointer',
    borderRadius: 4,
  },
  queueMenuItemDisabled: {
    color: 'var(--text-tertiary)',
    cursor: 'not-allowed',
    opacity: 0.5,
  },

  // v55: selection-mode header. Replaces the remaining-tracks header
  // when the queue is in select mode. Cancel always present; Apply
  // only present if a pending action came from a sub-menu pick.
  queueSelectHeader: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '8px 4px 12px',
    borderBottom: '1px solid var(--accent)',
    marginBottom: 6,
  },
  queueSelectCount: {
    fontSize: 13, fontWeight: 600,
    color: 'var(--accent)',
  },
  queueSelectBtns: { display: 'flex', alignItems: 'center', gap: 8 },
  queueSelectCancel: {
    padding: '6px 12px',
    background: 'transparent',
    border: '1px solid rgba(255,255,255,0.16)',
    borderRadius: 999,
    color: 'var(--text-secondary)',
    fontSize: 12, fontWeight: 500,
    cursor: 'pointer',
  },
  queueSelectApply: {
    padding: '6px 14px',
    background: 'var(--accent)',
    border: '1px solid var(--accent)',
    borderRadius: 999,
    color: '#fff',
    fontSize: 12, fontWeight: 600,
    cursor: 'pointer',
  },
  queueSelectApplyDisabled: {
    opacity: 0.4,
    cursor: 'not-allowed',
  },

  // v55: row checkbox shown in selection mode in place of cover art.
  queueRowCheckbox: {
    width: 36, height: 36,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    border: '2px solid rgba(255,255,255,0.30)',
    borderRadius: 6,
    background: 'transparent',
    color: '#fff',
    flexShrink: 0,
  },
  queueRowCheckboxOn: {
    background: 'var(--accent)',
    borderColor: 'var(--accent)',
  },
  queueRowCheckboxDisabled: {
    opacity: 0.3,
  },

  // v57: format strip + chevron under transport (HI-RES + bit-rate
  // line, then a downward chevron to open About-the-Track).
  formatStrip: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    gap: 8, paddingTop: 8,
    flexShrink: 0,
  },
  formatText: {
    fontSize: 12, fontWeight: 500,
    color: 'var(--text-secondary)',
    fontFamily: 'var(--font-mono)',
    letterSpacing: '0.02em',
  },
  aboutChevron: {
    // v1.1.0.60 — was a full-width button which made any tap below
    // the transport open the About panel by accident. Now a 44×44
    // square (≈10mm at iPad/iPhone density, matches Apple HIG min
    // tap target), pinned to the very bottom of the NowPlaying inner
    // container so it doesn't crowd the format strip.
    position: 'absolute',
    left: '50%',
    bottom: 4,
    transform: 'translateX(-50%)',
    width: 44,
    height: 44,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 0,
    background: 'transparent', border: 'none',
    color: 'var(--text-tertiary)',
    cursor: 'pointer',
    flexShrink: 0,
    touchAction: 'none', // we handle vertical swipe ourselves
  },

  // v57: ⋯ overflow menu. Anchored under top-right via a translucent
  // backdrop sheet that captures outside clicks. The inner box is a
  // bottom-sheet-style panel with rounded corners, listing the
  // track-context items.
  overflowSheet: {
    position: 'absolute', inset: 0, zIndex: 720,
    background: 'rgba(0,0,0,0.4)',
    display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
    animation: 'fadeIn 0.18s ease',
  },
  overflowBox: {
    width: '100%', maxWidth: 480,
    background: '#1a1a24',
    border: '1px solid rgba(255,255,255,0.10)',
    borderRadius: '20px 20px 0 0',
    padding: '8px 0 32px',
    boxShadow: '0 -10px 40px rgba(0,0,0,0.5)',
  },
  overflowHeader: {
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '12px 16px 16px',
  },
  overflowArt: {
    width: 56, height: 56,
    borderRadius: 4,
    overflow: 'hidden',
    background: 'rgba(255,255,255,0.06)',
    flexShrink: 0,
  },
  overflowArtImg: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
  overflowHeaderText: { minWidth: 0, flex: 1 },
  overflowTitle: {
    fontSize: 15, fontWeight: 700,
    color: 'var(--text-primary)',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  overflowSub: {
    fontSize: 13, color: 'var(--text-secondary)',
    marginTop: 2,
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  overflowDivider: {
    height: 1, background: 'rgba(255,255,255,0.08)',
    margin: '6px 16px',
  },
  overflowItem: {
    display: 'flex', alignItems: 'center', gap: 12,
    width: '100%',
    padding: '14px 18px',
    background: 'transparent',
    border: 'none',
    textAlign: 'left',
    color: 'var(--text-primary)',
    fontSize: 14, fontWeight: 500,
    cursor: 'pointer',
  },
  overflowItemDisabled: {
    display: 'flex', alignItems: 'center', gap: 12,
    width: '100%',
    padding: '14px 18px',
    background: 'transparent',
    border: 'none',
    textAlign: 'left',
    color: 'var(--text-tertiary)',
    fontSize: 14, fontWeight: 500,
    cursor: 'not-allowed',
    opacity: 0.55,
  },
  overflowItemIcon: { color: 'var(--text-secondary)', flexShrink: 0 },
  overflowSoon: {
    marginLeft: 'auto',
    fontSize: 10, fontWeight: 700,
    fontFamily: 'var(--font-mono)',
    color: 'var(--text-tertiary)',
    border: '1px solid var(--border)',
    borderRadius: 4,
    padding: '2px 6px',
  },
  overflowClose: {
    display: 'block', width: 'calc(100% - 32px)',
    margin: '12px 16px 0',
    padding: '14px 0',
    background: 'transparent',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 999,
    color: 'var(--text-primary)',
    fontSize: 14, fontWeight: 600,
    cursor: 'pointer',
  },

  // v58: inline 5-star rater row, expanded under the Rate menu item.
  raterRow: {
    display: 'flex', alignItems: 'center',
    padding: '4px 18px 12px',
    gap: 4,
  },
  raterStar: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 36, height: 36,
    background: 'transparent',
    border: 'none',
    color: 'rgba(255,255,255,0.35)',
    cursor: 'pointer',
    borderRadius: 6,
  },

  // v57: About-the-Track overlay
  aboutOverlay: {
    position: 'absolute', inset: 0,
    background: 'var(--bg-base)',
    display: 'flex', flexDirection: 'column',
    overflow: 'hidden',
  },
  aboutHeader: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '14px 14px 10px',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0,
  },
  aboutBody: {
    flex: 1, overflowY: 'auto',
    padding: '12px 18px 80px',
  },
  aboutArtistHeader: {
    display: 'flex', flexDirection: 'column', gap: 2,
    marginBottom: 8,
  },
  aboutArtistLabel: {
    fontSize: 11, fontWeight: 600,
    color: 'var(--text-tertiary)',
    textTransform: 'uppercase', letterSpacing: '0.08em',
  },
  aboutArtistName: {
    fontSize: 22, fontWeight: 700,
    color: 'var(--text-primary)',
  },
  aboutBio: {
    fontSize: 14, lineHeight: 1.55,
    color: 'var(--text-secondary)',
    whiteSpace: 'pre-wrap',
    marginTop: 8,
  },
  aboutBioCollapsed: {
    display: '-webkit-box',
    WebkitLineClamp: 4,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  },
  aboutBioToggle: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: '100%',
    padding: '6px 0 8px',
    background: 'transparent', border: 'none',
    color: 'var(--text-tertiary)',
    cursor: 'pointer',
  },
  aboutBioLoading: {
    fontSize: 13, color: 'var(--text-tertiary)',
    padding: '12px 0',
  },
  aboutBioEmpty: {
    fontSize: 13, color: 'var(--text-tertiary)',
    fontStyle: 'italic',
    padding: '12px 0',
  },
  aboutSectionHeading: {
    display: 'flex', alignItems: 'center', gap: 8,
    fontSize: 16, fontWeight: 700,
    color: 'var(--text-primary)',
    marginTop: 22, marginBottom: 4,
  },
  aboutSectionRule: {
    width: 3, height: 18,
    background: 'var(--accent)',
    borderRadius: 2,
  },
  aboutRow: {
    display: 'flex', flexDirection: 'column', gap: 2,
    padding: '12px 0',
    borderBottom: '1px solid var(--border)',
  },
  aboutRowLabel: {
    fontSize: 11, fontWeight: 600,
    color: 'var(--text-tertiary)',
    textTransform: 'uppercase', letterSpacing: '0.05em',
  },
  aboutRowValue: {
    fontSize: 14, fontWeight: 500,
    color: 'var(--text-primary)',
  },

  // v1.1.0.64 — sharper art corners (4 not 14), no heavy
  // dropshadow. The art sits flat on the black canvas just like
  // album tiles in the library grid. Background fallback is pure
  // black so a missing cover doesn't pop out as a charcoal hole.
  artWrap: {
    flex: '1 1 0', minHeight: 0,
    borderRadius: 4, overflow: 'hidden',
    background: 'var(--jp-bg-surface)',
    marginBottom: 22, flexShrink: 1,
    alignSelf: 'center', width: '100%',
  },
  art: { width: '100%', height: '100%', objectFit: 'contain', display: 'block', background: 'var(--jp-bg-surface)' },
  artEmpty: { width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' },

  // Title + artist + album cluster. Title 22/600 (was 20/700) to
  // pair visually with AlbumDetail's hero. Artist 14/500 in
  // --jp-text-2. Album 12/400 in --jp-text-3, no italic — JPLAY
  // doesn't italicise album names; the muting alone reads "this is
  // context, not the headline".
  infoSection: { textAlign: 'center', marginBottom: 14, flexShrink: 0 },
  trackTitle: { fontSize: 22, fontWeight: 600, color: 'var(--jp-text)', letterSpacing: '-0.3px', lineHeight: 1.2, marginBottom: 6 },
  // v1.1.0.69 — bumped artist + album sizes for phone readability.
  // The 14/12 from v64 read as caption text rather than as the
  // primary "what am I listening to" answer. Title stays at 22/600,
  // artist now 16/500 (was 14/500), album 14/500 in --jp-text-2
  // (was 12/400 in --jp-text-3). Album also gets a slight contrast
  // lift since it was bordering on too-dim against the new bg.
  trackArtist: { fontSize: 16, fontWeight: 500, color: 'var(--jp-text-2)', marginBottom: 4, cursor: 'pointer' },
  trackAlbum: { fontSize: 14, fontWeight: 500, color: 'var(--jp-text-3)', cursor: 'pointer' },

  // Progress: 2px line, white fill on a 8% white track. Times in
  // mono at --jp-text-3.
  progressSection: { flexShrink: 0, marginBottom: 16 },
  progressTrack: { height: 2, background: 'rgba(255,255,255,0.08)', borderRadius: 1, marginBottom: 6, overflow: 'hidden' },
  progressFill: { height: '100%', background: 'var(--jp-accent)', borderRadius: 1, transition: 'width 0.25s linear' },
  times: { display: 'flex', justifyContent: 'space-between', fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--jp-text-3)' },

  // Transport: monochrome on black. Play button keeps the white-
  // fill circle (it's the dominant action and JPLAY does this
  // too) but loses the heavy 28px white glow that read as
  // "iTunes button". Skip buttons stay outlined.
  transport: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    gap: 36, flexShrink: 0, marginBottom: 22,
  },
  skipBtn: { width: 56, height: 56, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--jp-text)', background: 'none', border: 'none' },
  playBtn: {
    width: 76, height: 76, borderRadius: '50%',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--jp-accent)', color: '#000', border: 'none', flexShrink: 0,
  },
  spinner: { width: 24, height: 24, border: '2px solid rgba(0,0,0,0.2)', borderTopColor: '#000', borderRadius: '50%', animation: 'spin 0.8s linear infinite' },

  bottomBar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 32, flexShrink: 0 },
  bottomBtn: {
    display: 'flex', alignItems: 'center', gap: 7,
    padding: '8px 14px', borderRadius: 20,
    background: 'rgba(255,255,255,0.07)',
    border: '1px solid rgba(255,255,255,0.1)',
    color: 'rgba(255,255,255,0.7)', cursor: 'pointer', maxWidth: '46%',
  },
  bottomBtnLabel: { fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },

  // Queue tab
  queueList: { flex: 1, overflowY: 'auto', paddingBottom: 32 },
  queueToolbar: {
    display: 'flex', gap: 6, padding: '4px 0 12px',
    position: 'sticky', top: 0,
    background: 'transparent',
  },
  queueChip: {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    padding: '5px 11px', borderRadius: 14,
    fontSize: 11, fontWeight: 600,
    color: 'rgba(255,255,255,0.55)',
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid rgba(255,255,255,0.10)',
    cursor: 'pointer',
  },
  queueChipActive: {
    color: 'var(--accent)',
    background: 'var(--accent-dim)',
    borderColor: 'transparent',
  },
  // Zone-switcher chip — sized similarly to the Radio/Edit chips but pushed
  // to the right and given room for a truncated zone name.
  queueZoneChip: {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    padding: '5px 11px', borderRadius: 14,
    fontSize: 11, fontWeight: 600,
    color: 'rgba(255,255,255,0.55)',
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid rgba(255,255,255,0.10)',
    cursor: 'pointer',
    marginLeft: 'auto',
    maxWidth: 160,
  },
  queueZoneName: {
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  // Inline picker that appears below the toolbar when the zone chip is tapped.
  // Mirrors QueueModal's picker so users get a consistent zone-switch UX in
  // either place.
  queueZonePicker: {
    margin: '0 0 12px',
    padding: '10px 8px',
    borderRadius: 12,
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.08)',
  },
  queueZonePickerTitle: {
    fontSize: 10, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase',
    color: 'rgba(255,255,255,0.45)', margin: '0 4px 6px',
  },
  queueZoneEmpty: { fontSize: 11, color: 'rgba(255,255,255,0.4)', textAlign: 'center', padding: '8px 0' },
  queueZoneRow: {
    display: 'grid', gridTemplateColumns: '18px 1fr auto auto', alignItems: 'center',
    gap: 8, padding: '7px 8px',
    background: 'none', border: 'none', cursor: 'pointer',
    width: '100%', textAlign: 'left', borderRadius: 8,
  },
  queueZoneRowActive: { background: 'var(--accent-dim)' },
  queueZoneRowName: {
    fontSize: 13, color: 'rgba(255,255,255,0.92)',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  queueZoneRowProto: {
    fontSize: 9, fontFamily: 'var(--font-mono)',
    color: 'rgba(255,255,255,0.35)', letterSpacing: '1px',
  },
  queueEmpty: { paddingTop: 60, textAlign: 'center', color: 'rgba(255,255,255,0.3)', fontSize: 13 },
  queueRow: { display: 'grid', gridTemplateColumns: '32px 1fr 44px', alignItems: 'center', gap: 8, padding: '10px 8px', width: '100%', border: 'none', cursor: 'pointer', borderRadius: 8, textAlign: 'left' },
  queueNum: { fontSize: 12, fontFamily: 'var(--font-mono)', textAlign: 'right' },
  queueInfo: { display: 'flex', flexDirection: 'column', gap: 2, overflow: 'hidden' },
  queueTitle: { fontSize: 13, fontWeight: 400, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  queueArtist: { fontSize: 11, color: 'rgba(255,255,255,0.35)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  queueDur: { fontSize: 11, color: 'rgba(255,255,255,0.3)', fontFamily: 'var(--font-mono)', textAlign: 'right' },
  queueEditCtrls: { display: 'flex', alignItems: 'center', gap: 4 },
  queueIconBtn: {
    width: 28, height: 28,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'rgba(255,255,255,0.08)',
    color: 'rgba(255,255,255,0.7)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 6,
    cursor: 'pointer', padding: 0,
  },
  queueIconBtnDisabled: { opacity: 0.35, cursor: 'default' },
}
