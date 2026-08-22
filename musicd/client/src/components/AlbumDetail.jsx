import React, { useEffect, useState, useRef } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import { ArrowLeft, Play, Plus, Clock, Share2, X, Heart, Copy, ExternalLink, Check, BookOpen, ChevronDown, Shuffle, ListMusic, Star, MoreHorizontal, Tag, Bookmark, Layers, PlusCircle, CheckCircle2 } from 'lucide-react'
import BioModal from './BioModal'
import TagPicker from './TagPicker'
import ServiceBadge, { serviceLabel } from './ServiceBadge'

function fmtDur(secs) {
  if (!secs) return '--:--'
  const m = Math.floor(secs / 60)
  const s = Math.floor(secs % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function fmtTotalDur(secs) {
  if (!secs) return ''
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m} min`
}

// v1.1.0.91 — render the album's release date in the most human form
// the data supports. Example outputs:
//   "01 May 1982"  if release_date is "1982-05-01"
//   "May 1982"     if release_date is "1982-05"
//   "1982"         if release_date is "1982"  (or only year is present)
// The DD MMM YYYY ordering matches the user's UK preference. Falls
// back to the integer year column when release_date is null.
function formatReleaseDate(releaseDate, year) {
  if (!releaseDate) return year ? String(year) : ''
  const m = String(releaseDate).match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/)
  if (!m) return year ? String(year) : String(releaseDate)
  const y = m[1]
  const mo = m[2] ? parseInt(m[2], 10) : null
  const d = m[3] ? parseInt(m[3], 10) : null
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  if (d && mo) {
    const dd = String(d).padStart(2, '0')
    return `${dd} ${monthNames[mo - 1]} ${y}`
  }
  if (mo) return `${monthNames[mo - 1]} ${y}`
  return y
}

// Strip surrounding straight or curly quotes from album titles like
// "Foo" or “Foo” → Foo. Tags occasionally include them; they're never wanted
// in the heading.
function cleanTitle(t) {
  if (!t) return ''
  return t
    .replace(/^["“”'‘’`]+/, '')
    .replace(/["“”'‘’`]+$/, '')
    .trim()
}

function shortCodec(format, codec) {
  const raw = (codec || format || '').toLowerCase()
  if (raw.includes('flac')) return 'FLAC'
  if (raw.includes('mp3') || raw.includes('mpeg')) return 'MP3'
  if (raw === 'dsf' || raw === 'dsd' || raw === 'dff') return 'DSD'
  if (raw.includes('wav')) return 'WAV'
  if (raw.includes('aiff') || raw.includes('aif')) return 'AIFF'
  if (raw.includes('ogg')) return 'OGG'
  return (codec || format || '?').toUpperCase().substring(0, 6)
}

const CODEC_COLOR = {
  FLAC: '#4caf82', DSD: '#a78bfa', MP3: '#e8a44a',
  WAV: '#5b7fff', AIFF: '#5b7fff', default: '#5a5a6a',
}

function FormatBadge({ format, codec }) {
  const label = shortCodec(format, codec)
  const color = CODEC_COLOR[label] || CODEC_COLOR.default
  return (
    <span style={{
      padding: '1px 5px', borderRadius: 3,
      fontSize: 9, fontWeight: 700, fontFamily: 'var(--font-mono)',
      background: `${color}22`, color, border: `1px solid ${color}44`,
      flexShrink: 0,
    }}>{label}</span>
  )
}

function EQBars() {
  return (
    <span style={{ display: 'flex', alignItems: 'flex-end', gap: 1.5, height: 14 }}>
      {[1, 2, 3].map(i => (
        <span key={i} style={{
          display: 'block', width: 3,
          background: 'var(--accent)', borderRadius: 1,
          animation: `eq-bar 0.${6 + i}s ease-in-out infinite`,
          animationDelay: `${i * 0.1}s`,
        }} />
      ))}
    </span>
  )
}

export default function AlbumDetail({ albumId, onArtistClick, onGenreClick, onBack, backLabel = 'Albums', hideBack = false }) {
  // v1.1.1.4 diagnostic — log on every render. This fires before
  // the useEffect, so it tells us whether the component is being
  // constructed at all when the user taps. Throttled to once per
  // mount-id by checking a useRef.
  if (typeof window !== 'undefined') {
    try {
      fetch('/api/debug/client-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tag: 'album-detail',
          message: 'render',
          data: { albumId, hasAlbumIdProp: !!albumId }
        })
      }).catch(() => {})
    } catch {}
  }
  const { setSelectedAlbum, playerStatus, currentTrack, rendererId, playQueue, appendToQueue, insertNextInQueue, shufflePlay } = useStore()
  const [album, setAlbum] = useState(null)
  const [loading, setLoading] = useState(true)
  const [imgErr, setImgErr] = useState(false)
  const [shareCardUrl, setShareCardUrl] = useState(null)
  const [shareLoading, setShareLoading] = useState(false)
  const [isFavorite, setIsFavorite] = useState(false)
  const [favBusy, setFavBusy] = useState(false)
  // v1.1.0.67 — Save for later. Mirrors isFavorite exactly. The
  // server stores it as a column on the album row; the album-detail
  // fetch returns it via the same endpoint, so we hydrate from the
  // album payload on load.
  const [isSavedForLater, setIsSavedForLater] = useState(false)
  const [savedBusy, setSavedBusy] = useState(false)
  // v1.1.0.67 — Which entity (if any) is currently being tag-edited.
  // null means the picker isn't visible. {kind: 'album', id} or
  // {kind: 'track', id, track} when open.
  const [tagPickerFor, setTagPickerFor] = useState(null)
  // MBID copy feedback (#30.21). Briefly shows a tick instead of the
  // copy icon after navigator.clipboard.writeText resolves. Reverts
  // to the copy icon after ~1.5s so the chip looks idle again.
  const [mbidCopied, setMbidCopied] = useState(false)
  // Bio modal visibility (#30.23). Toggled by the "About" pill;
  // the modal itself handles loading state and fetch.
  const [showBio, setShowBio] = useState(false)
  // v56: Play split-button dropdown. Opens on chevron tap; choices
  // are Play Now / Play Next / Add to Queue / Shuffle.
  const [showPlayMenu, setShowPlayMenu] = useState(false)
  // v1.1.0.61: ⋯ overflow sheet for the album page (top-right). Same
  // bottom-sheet pattern as NowPlaying's overflow. Owns Heart, Share,
  // Play Next, Shuffle Play, plus disabled placeholders for v62 tag
  // and save-for-later actions.
  const [showAlbumMenu, setShowAlbumMenu] = useState(false)
  // v1.1.0.98 — Change-type sub-sheet. Opens from the album overflow
  // menu's "Change type" item. Picks one of the six taxonomy values
  // (or "Auto-detect" to clear the lock) and POSTs to
  // /albums/:id/type. Optimistically updates the local album state
  // so the user sees the change immediately.
  const [showTypeSheet, setShowTypeSheet] = useState(false)
  // v1.1.0.63 — track-level action sheet. Replaces the always-visible
  // Heart + Star widgets that the JPLAY-style row no longer carries.
  // Long-press a track row OR right-click → openTrackSheet(track).
  // Sheet content is the same vocabulary as the album sheet (Favourite,
  // Rate, Play next, Add to queue) plus track-only items.
  const [trackSheetTrack, setTrackSheetTrack] = useState(null)
  const trackPressTimer = useRef(null)
  const startTrackLongPress = (track, e) => {
    cancelTrackLongPress()
    trackPressTimer.current = setTimeout(() => {
      // Stop the click that would otherwise fire on touchend so a
      // long-press doesn't also play the track. We do this by
      // emitting the sheet-open and ignoring the next click via the
      // sheet's own backdrop swallowing the event.
      setTrackSheetTrack(track)
    }, 500)
  }
  const cancelTrackLongPress = () => {
    if (trackPressTimer.current) {
      clearTimeout(trackPressTimer.current)
      trackPressTimer.current = null
    }
  }
  const openTrackSheet = (track) => setTrackSheetTrack(track)
  // Toast message (#v1.1.0.37). Shown briefly when the user taps Play
  // or Queue, anchored above the mini-now-playing bar. Set to a string
  // to show; auto-clears after 3 seconds via the toast-timer effect.
  const [toast, setToast] = useState(null)
  const toastTimerRef = useRef(null)
  const showToast = (msg) => {
    setToast(msg)
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    toastTimerRef.current = setTimeout(() => setToast(null), 3000)
  }
  useEffect(() => () => {
    // Clean up the auto-dismiss timer on unmount so it doesn't
    // call setState on a stale component.
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
  }, [])

  useEffect(() => {
    // v1.1.1.4 diagnostic — log AlbumDetail's lifecycle to the
    // server so we can see whether the component is mounting at
    // all when the user taps an album, whether the fetch fires,
    // and what the response looks like.
    const dlog = (message, data) => {
      try {
        fetch('/api/debug/client-log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tag: 'album-detail', message, data })
        }).catch(() => {})
      } catch {}
    }
    dlog('useEffect fired', { albumId })
    setLoading(true)
    setImgErr(false)
    api.get(`/library/albums/${albumId}`).then(a => {
      dlog('fetch resolved', {
        albumId,
        gotAlbum: !!a,
        title: a?.title || null,
        trackCount: a?.tracks?.length || 0,
      })
      setAlbum(a)
      setIsFavorite(!!a?.is_favorite)
      setIsSavedForLater(!!a?.is_saved_for_later)
    }).catch(e => {
      dlog('fetch rejected', { albumId, error: String(e) })
    }).finally(() => setLoading(false))
  }, [albumId])

  // v1.1.33.0 — the circled plus, on Qobuz and Tidal albums only.
  //
  // It is NOT the heart, and the two live side by side on purpose. The
  // heart is this app's own favourite: local, and identical in meaning on
  // a streaming album and a local one. The ⊕ writes the favourite at the
  // SERVICE — the same list the Qobuz or Tidal app shows — and that list
  // is what defines which streaming albums are in this library. So:
  //
  //   ⊕ on   → the album is in your Qobuz/Tidal favourites, and appears
  //            in the album wall, in Focus, in search, everywhere a local
  //            album does
  //   ⊕ off  → it goes back to being something you can browse to
  //
  // Collapsing the two would mean un-hearting an album here silently
  // removed it from the user's streaming account, which is not a thing a
  // heart should ever do.
  //
  // Which service an album belongs to is read from its own id prefix
  // rather than passed down, so this works wherever an album page is
  // opened from — the wall, search, a service screen, a queue item.
  const service = albumId && String(albumId).startsWith('qobuz:') ? 'qobuz'
                : albumId && String(albumId).startsWith('tidal:') ? 'tidal'
                : null
  const serviceAlbumId = service ? String(albumId).slice(service.length + 1) : null
  // v1.1.37.0 — hoisted out of AlbumVersions. The button now shares a row
  // with the ReplayGain figures while its expanded list has to run the full
  // page width beneath that row, so the two halves are rendered in different
  // places and cannot own the state between them.
  const [versionsOpen, setVersionsOpen] = useState(false)
  const [inService, setInService] = useState(false)
  const [serviceBusy, setServiceBusy] = useState(false)
  const [serviceErr, setServiceErr] = useState(null)

  useEffect(() => {
    if (!service) { setInService(false); return }
    let cancelled = false
    setServiceErr(null)
    api.get(`/streaming/${service}/favorites/album/${encodeURIComponent(serviceAlbumId)}/status`)
      .then(r => { if (!cancelled) setInService(!!r.favorited) })
      .catch(() => { /* signed out, or the service is unreachable: leave it off
                        rather than showing a state we cannot back up */ })
    return () => { cancelled = true }
  }, [service, serviceAlbumId])

  const handleToggleService = async () => {
    if (!service || serviceBusy) return
    const next = !inService
    setInService(next)            // optimistic; rolled back below on failure
    setServiceBusy(true)
    setServiceErr(null)
    try {
      const path = `/streaming/${service}/favorites/album/${encodeURIComponent(serviceAlbumId)}`
      if (next) await api.post(path, {})
      else await api.del(path)
    } catch (e) {
      setInService(!next)
      setServiceErr(e.message || `Could not update ${serviceLabel(service)}`)
    } finally {
      setServiceBusy(false)
    }
  }

  const handleToggleFavorite = async () => {
    if (!album || favBusy) return
    // Optimistic update — flip immediately, roll back on failure.
    const next = !isFavorite
    setIsFavorite(next)
    setFavBusy(true)
    try {
      const res = await api.post(`/library/albums/${album.id}/favorite`, { value: next })
      // Honour server's authoritative value in case of race conditions
      if (typeof res?.is_favorite === 'boolean') setIsFavorite(res.is_favorite)
    } catch {
      setIsFavorite(!next) // rollback
    } finally {
      setFavBusy(false)
    }
  }

  // v1.1.0.67 — Save-for-later toggle. Same optimistic-update
  // pattern as the favourite toggle.
  const handleToggleSavedForLater = async () => {
    if (!album || savedBusy) return
    const next = !isSavedForLater
    setIsSavedForLater(next)
    setSavedBusy(true)
    try {
      const res = await api.post(`/library/albums/${album.id}/save-for-later`, { value: next })
      if (typeof res?.is_saved_for_later === 'boolean') setIsSavedForLater(res.is_saved_for_later)
    } catch {
      setIsSavedForLater(!next)
    } finally {
      setSavedBusy(false)
    }
  }

  // v1.1.0.98 — change-type handler. Accepts either a literal type
  // value (locks the album to that type) or 'auto' (clears the lock
  // and re-derives). Updates the local album state so the user sees
  // the change without a refetch. Errors are swallowed quietly with
  // a console.warn — the sheet stays open and the user can retry.
  const handleChangeType = async (typeOrAuto) => {
    if (!album) return
    const body = typeOrAuto === 'auto' ? { auto: true } : { type: typeOrAuto }
    try {
      const res = await api.post(`/library/albums/${album.id}/type`, body)
      setAlbum(prev => ({
        ...prev,
        album_type: res.album_type,
        album_type_locked: res.album_type_locked,
      }))
      setShowTypeSheet(false)
    } catch (e) {
      console.warn('[album] change type failed:', e?.message || e)
    }
  }

  const handlePlayFrom = (index) => {
    if (!rendererId) { alert('Tap ☰ → Output to select a renderer first'); return }
    if (!album?.tracks?.length) return
    playQueue(album.tracks, index)
    // Confirmation toast (#v1.1.0.37). Only shown for the album-level
    // Play button (index 0); per-track plays from the tracklist are
    // a different action and don't get a toast.
    if (index === 0) showToast('Album now playing')
  }

  const handleAppend = () => {
    if (!album?.tracks?.length) return
    appendToQueue(album.tracks)
    showToast('Album added to end of queue')
  }

  // v56: Play [▾] dropdown actions. Play Now duplicates the primary
  // Play button; left in the menu for symmetry with the photo. Play
  // Next inserts after the now-playing track. Shuffle plays a
  // shuffled copy of the album.
  const handlePlayNext = () => {
    if (!rendererId) { alert('Tap ☰ → Output to select a renderer first'); return }
    if (!album?.tracks?.length) return
    insertNextInQueue(album.tracks)
    showToast('Album will play next')
  }
  const handleShuffle = () => {
    if (!rendererId) { alert('Tap ☰ → Output to select a renderer first'); return }
    if (!album?.tracks?.length) return
    shufflePlay(album.tracks)
    showToast('Shuffling album')
  }

  const handleShare = async () => {
    setShareLoading(true)
    try {
      const res = await fetch(`/api/share/album/${albumId}.png`)
      if (!res.ok) throw new Error('Share image failed')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      setShareCardUrl({ url, blob })
    } catch (e) {
      console.error('Share failed:', e)
    } finally {
      setShareLoading(false)
    }
  }

  const handleShareClose = () => {
    if (shareCardUrl) URL.revokeObjectURL(shareCardUrl.url)
    setShareCardUrl(null)
  }

  if (loading) return (
    <div style={s.loadWrap}><div style={s.spinner} /></div>
  )
  if (!album) return null

  const totalDuration = album.tracks?.reduce((a, t) => a + (t.duration || 0), 0)
  // v1.1.0.92 — numeric sort on disc numbers. Default Array.sort is
  // lexical (so "10" sorts before "2"). For multi-disc albums with
  // 10+ discs (rare but real — Yessongs is 3, but Beatles
  // collections can hit 10) this matters.
  const discs = [...new Set(album.tracks?.map(t => t.disc_number || 1))].sort((a, b) => a - b)

  // v1.1.0.76 — album-level ReplayGain summary. Use the album_gain
  // and album_peak that every track in this album shares (every
  // track's row carries the same album-level values, since they're
  // derived per-album not per-track). Take the first non-null
  // value found. coverage = how many tracks have at least a track
  // gain value, used for the "scanned 8/12 tracks" subtitle.
  // v1.1.37.0 — read in two places now (the detail row's button and the
  // list below it), so it is computed once rather than repeated.
  const hasVersions = Array.isArray(album.versions) && album.versions.length > 1
  const rgScannedCount = album.tracks?.filter(t => typeof t.track_gain_db === 'number').length || 0
  const rgFirstWithAlbum = album.tracks?.find(t => typeof t.album_gain_db === 'number')
  const albumRg = rgFirstWithAlbum ? {
    albumGainDb:  rgFirstWithAlbum.album_gain_db,
    albumPeakDb:  typeof rgFirstWithAlbum.album_peak === 'number' ? rgFirstWithAlbum.album_peak : null,
    referenceLufs: typeof rgFirstWithAlbum.reference_lufs === 'number' ? rgFirstWithAlbum.reference_lufs : null,
  } : null

  return (
    <div style={s.page}>
      {/* Background art blur */}
      {album.cover_art && !imgErr && (
        <div style={{ ...s.bgArt, backgroundImage: `url(${album.cover_art})` }} />
      )}
      <div style={s.bgDim} />

      {/* Confirmation toast (#v1.1.0.37). Fixed position above the
          mini now-playing bar (90px), centred horizontally. White
          pill with dark text per user spec. Auto-dismisses after 3s
          via the showToast helper. pointer-events: none so it
          doesn't block taps on whatever is underneath. */}
      {toast && (
        <div style={s.toast} role="status" aria-live="polite">
          {toast}
        </div>
      )}

      <div style={s.content}>
        {/* Top nav row — Back on the left, ⋯ on the right (#v1.1.0.61).
            The ⋯ replaces the Heart + Share pills that previously
            lived in the hero-actions row; both are now items inside
            the overflow sheet. Keeps the hero-action row focused on
            the primary verbs (Play, Add Queue) and consolidates
            secondary actions in one place — same pattern as the
            NowPlaying overflow. */}
        <div style={s.topNav}>
          {!hideBack ? (
            <button style={s.back} onClick={onBack || (() => setSelectedAlbum(null))}>
              <ArrowLeft size={14} /><span>{backLabel}</span>
            </button>
          ) : <div />}
          <button
            style={s.topMore}
            onClick={() => setShowAlbumMenu(true)}
            aria-label="More album actions"
            title="More"
          >
            <MoreHorizontal size={20} />
          </button>
        </div>

        {/* Hero */}
        <div style={s.hero}>
          <div style={s.artWrap}>
            {album.cover_art && !imgErr
              ? <img src={album.cover_art} alt={album.title} style={s.art} onError={() => setImgErr(true)} draggable={false} />
              : <div style={s.artFallback}>♫</div>
            }
          </div>
          <div style={s.heroInfo}>
            <div>
              <h1 style={s.heroTitle}>{cleanTitle(album.title)}</h1>
              <button style={s.artistBtn} onClick={() => onArtistClick && onArtistClick(album.album_artist || album.artist)}>
                {album.album_artist || album.artist}
              </button>
            </div>
              <div style={s.heroActions}>
                <div style={s.playSplitWrap}>
                  <button
                    style={s.playBtnSplit}
                    onClick={() => handlePlayFrom(0)}
                    aria-label="Play album"
                  >
                    <Play size={14} fill="currentColor" strokeWidth={0} />Play
                  </button>
                  <button
                    style={s.playSplitChevron}
                    onClick={() => setShowPlayMenu(v => !v)}
                    aria-label="Play options"
                    aria-expanded={showPlayMenu}
                    aria-haspopup="menu"
                  >
                    <ChevronDown size={13} />
                  </button>
                  {showPlayMenu && (
                    <PlayOptionsMenu
                      onClose={() => setShowPlayMenu(false)}
                      onPlayNow={() => { setShowPlayMenu(false); handlePlayFrom(0) }}
                      onPlayNext={() => { setShowPlayMenu(false); handlePlayNext() }}
                      onAddToQueue={() => { setShowPlayMenu(false); handleAppend() }}
                      onShuffle={() => { setShowPlayMenu(false); handleShuffle() }}
                    />
                  )}
                </div>
                {/* v1.1.36.0 — the server favourite, out of the ⋯ sheet and
                    into the action row. Hollow when off, filled red when on;
                    the same #ff3b5c the sheet used, so the two readings of
                    "favourited" cannot drift apart in colour.

                    This is THIS app's favourite and it applies to every album,
                    local or streaming. The ⊕ beside it is a different
                    statement — that one writes the favourite at Qobuz or
                    Tidal — which is why they are two controls and not one. */}
                <button
                  style={{ ...s.heroIconBtn, ...(isFavorite ? s.heroIconBtnFav : {}) }}
                  onClick={handleToggleFavorite}
                  disabled={favBusy}
                  aria-pressed={isFavorite}
                  aria-label={isFavorite ? 'Remove from favourites' : 'Add to favourites'}
                  title={isFavorite ? 'Remove from favourites' : 'Add to favourites'}
                >
                  <Heart
                    size={17}
                    fill={isFavorite ? '#ff3b5c' : 'none'}
                    color={isFavorite ? '#ff3b5c' : 'currentColor'}
                    strokeWidth={isFavorite ? 0 : 1.8}
                  />
                </button>
                {/* v1.1.33.0 — the circled plus. Only on Qobuz / Tidal albums;
                    a local album has no service favourite to write. Filled once
                    the album is in that service's favourites, which is also what
                    puts it in this library. */}
                {service && (
                  <button
                    style={{ ...s.heroIconBtn, ...(inService ? s.heroIconBtnOn : {}) }}
                    onClick={handleToggleService}
                    disabled={serviceBusy}
                    aria-pressed={inService}
                    title={inService
                      ? `In your ${serviceLabel(service)} favourites — tap to remove`
                      : `Add to your ${serviceLabel(service)} favourites`}>
                    {inService
                      ? <CheckCircle2 size={18} strokeWidth={1.8} />
                      : <PlusCircle size={18} strokeWidth={1.8} />}
                  </button>
                )}
              </div>
          </div>
        </div>

        {/* v1.1.35.0 — everything except the cover, the title and the artist
            now runs the FULL width of the page rather than sharing a column
            with a 144px cover. On a phone that column was about 200pt wide,
            which is why the format line and the ReplayGain line wrapped and
            the whole header read as cramped. Same information, given room. */}
        <div style={s.heroBelow}>
            <div style={s.heroMeta}>
              {(album.release_date || album.year) && (
                <>
                  <span>{formatReleaseDate(album.release_date, album.year)}</span>
                  <span style={s.heroMetaSep}>·</span>
                </>
              )}
              <span>{album.tracks?.length || 0} tracks</span>
              <span style={s.heroMetaSep}>·</span>
              <span>{fmtTotalDur(totalDuration)}</span>
              {album.genre && (
                <>
                  <span style={s.heroMetaSep}>·</span>
                  <button
                    style={s.heroMetaGenre}
                    onClick={() => onGenreClick && onGenreClick(album.genre)}
                    title={`Show albums in ${album.genre}`}
                  >
                    {album.genre}
                  </button>
                </>
              )}
            </div>
            {/* v1.1.0.76 — album-level ReplayGain summary line.
                Renders below the year/tracks/genre line when at
                least one track in the album has tagged RG. Shows
                the album gain (single value shared across all
                tracks) and a count when the album is partially
                scanned. The chip in each track row gives the
                track-level number; this line gives the album
                context. */}
            {/* v1.1.37.0 — the ReplayGain figures and the versions button
                share one row. Two short things each taking a full line was a
                row of the page spent on very little. The RG group flexes and
                wraps internally; the button does not shrink, so on a narrow
                screen the figures wrap and the button keeps its place, and
                only if there is genuinely no room does it drop to its own
                line — which is where it was anyway. */}
            {(albumRg || hasVersions) && (
              <div style={s.detailRow}>
                {albumRg && (
                  <span style={s.heroRgRow}>
                    <span style={s.heroRgLabel}>RG</span>
                    <span style={s.heroRgValue}>
                      Album {albumRg.albumGainDb > 0 ? '+' : ''}{albumRg.albumGainDb.toFixed(2)} dB
                      {albumRg.albumPeakDb !== null && (
                        <> · peak {albumRg.albumPeakDb.toFixed(2)} dBFS</>
                      )}
                      {albumRg.referenceLufs !== null && (
                        <> · ref {albumRg.referenceLufs.toFixed(0)} LUFS</>
                      )}
                    </span>
                    {rgScannedCount < (album.tracks?.length || 0) && (
                      <span style={s.heroRgCoverage}>
                        {rgScannedCount}/{album.tracks?.length || 0} tracks
                      </span>
                    )}
                  </span>
                )}
                {hasVersions && (
                  <button
                    style={s.versionsToggle}
                    onClick={() => setVersionsOpen(v => !v)}
                    aria-expanded={versionsOpen}
                  >
                    <Layers size={13} strokeWidth={1.8} />
                    <span>{album.versions.length} versions</span>
                    <ChevronDown size={13} style={{ transform: versionsOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s ease' }} />
                  </button>
                )}
              </div>
            )}
            {/* Action row (#v1.1.0.56). Play becomes a split button:
                Play (the primary action — Play Now) and a chevron that
                opens a small menu with Play Now / Play Next / Add to
                Queue / Shuffle. Add Queue stays as its own pill so the
                "queue this album to the end" function is one tap from
                the row. Heart and Share are unchanged. The standalone
                Plus and Bookmark icons that lived between Add Queue
                and Heart in the v55 mock-up are dropped. */}
            {/* v1.1.34.0 — the other copies of this album you own. Shown
                whenever there is more than one, INDEPENDENT of the grouping
                toggle: knowing you have three copies of a record is useful
                whether or not the wall is collapsing them, and this is where
                you would come to compare or play a particular one.
                v1.1.37.0 — the button that opens this sits up in the detail
                row; only the list itself is here, because it needs the full
                width and the button does not. */}
            {hasVersions && versionsOpen && (
              <AlbumVersionsList versions={album.versions} onOpen={(id) => setSelectedAlbum(id)} />
            )}
            {service && (
              <div style={s.serviceLine}>
                <ServiceBadge service={service} variant="chip" />
                <span style={s.serviceLineText}>
                  {serviceErr
                    ? serviceErr
                    : inService
                      ? 'In your library'
                      : `Browsing ${serviceLabel(service)} — add it to keep it`}
                </span>
              </div>
            )}
            {album.match_status === 'matched' && album.mb_release_group_id && (
            <div style={s.matchedPillRow}>
              {album.match_status === 'matched' && album.mb_release_group_id && (
                <div style={s.mbidChip}>
                  <span style={s.mbidLabel}>MBID:</span>
                  <span style={s.mbidValue}>{album.mb_release_group_id.slice(0, 8)}…</span>
                  <button
                    style={s.mbidIconBtn}
                    onClick={async () => {
                      const fullId = album.mb_release_group_id
                      if (navigator.clipboard?.writeText) {
                        try {
                          await navigator.clipboard.writeText(fullId)
                          setMbidCopied(true)
                          setTimeout(() => setMbidCopied(false), 1500)
                          return
                        } catch {
                          // Fall through to the legacy path below.
                        }
                      }
                      try {
                        const ta = document.createElement('textarea')
                        ta.value = fullId
                        ta.style.position = 'fixed'
                        ta.style.left = '-9999px'
                        ta.setAttribute('readonly', '')
                        document.body.appendChild(ta)
                        ta.select()
                        const ok = document.execCommand('copy')
                        document.body.removeChild(ta)
                        if (ok) {
                          setMbidCopied(true)
                          setTimeout(() => setMbidCopied(false), 1500)
                          return
                        }
                      } catch {}
                      window.prompt('Copy this MBID:', fullId)
                    }}
                    title="Copy full MBID"
                    aria-label="Copy MBID"
                  >
                    {mbidCopied ? <Check size={11} /> : <Copy size={11} />}
                  </button>
                  <a
                    style={s.mbidIconBtn}
                    href={`https://musicbrainz.org/release-group/${album.mb_release_group_id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="View on musicbrainz.org"
                    aria-label="View on MusicBrainz"
                  >
                    <ExternalLink size={11} />
                  </a>
                </div>
              )}
              {album.match_status === 'matched' && album.mb_release_group_id && (
                <button
                  style={s.bioBtn}
                  onClick={() => setShowBio(true)}
                  title="About this album"
                >
                  <BookOpen size={12} />
                  <span>About</span>
                </button>
              )}
            </div>
            )}
        </div>

        {/* Bio modal (#30.23). Lazy-loaded; the modal itself fetches
            from /api/library/albums/:id/bio when it mounts. */}
        {showBio && (
          <BioModal
            kind="album"
            id={album.id}
            title={cleanTitle(album.title)}
            subtitle={album.album_artist || album.artist}
            onClose={() => setShowBio(false)}
          />
        )}

        {/* Share card preview modal */}
        {shareCardUrl && (
          <div style={s.shareOverlay} onClick={handleShareClose}>
            <div style={s.shareSheet} onClick={e => e.stopPropagation()}>
              <div style={s.shareHeader}>
                <span style={s.shareTitle}>Share Card</span>
                <button style={s.shareClose} onClick={handleShareClose}><X size={16} /></button>
              </div>
              {/* allow-callout: holding this image to add it to Photos is
                  a real thing to want, and the callout is the only way to
                  it. See the artwork rules in index.css. */}
              <img src={shareCardUrl.url} alt="Share card" style={s.sharePreview} className="allow-callout" />
              {/* v1.1.19.0 — no Download button. On a plain-HTTP LAN install
                  navigator.canShare is undefined, so this only ever offered a
                  blob download; touch-and-hold on the image gives the OS share
                  and save sheet, which is what .allow-callout is here for. */}
              <div style={s.shareHint}>Touch and hold the card to save or share it</div>
            </div>
          </div>
        )}

        {/* Track list */}
        <div style={s.tracklist}>
          {discs.map(disc => (
            <div key={disc}>
              {discs.length > 1 && <div style={s.discHeader}>Disc {disc}</div>}
              <div style={s.trackHeader}>
                <span style={s.thNum}>#</span>
                <span>Title</span>
                <span style={{ textAlign: 'right' }}><Clock size={10} /></span>
              </div>
              {album.tracks
                ?.filter(t => (t.disc_number || 1) === disc)
                .map((track, i) => {
                  const isPlaying = currentTrack?.id === track.id && playerStatus === 'playing'
                  const isActive = currentTrack?.id === track.id
                  const trackIndex = album.tracks.findIndex(t => t.id === track.id)
                  // Track metadata badges (#30.17). LUFS comes from
                  // track_loudness via LEFT JOIN on the album endpoint;
                  // it's null if the track hasn't been analysed yet.
                  // We round to 1dp because anything tighter is noise.
                  const lufsLabel = (typeof track.integrated_lufs === 'number')
                    ? `${track.integrated_lufs.toFixed(1)} LUFS`
                    : null
                  const spec = [
                    track.sample_rate ? `${(track.sample_rate / 1000).toFixed(1)}kHz` : null,
                    track.bitrate ? `${track.bitrate}kbps` : null,
                    lufsLabel,
                  ].filter(Boolean).join(' · ')

                  return (
                    <div key={track.id}
                      role="button"
                      tabIndex={0}
                      style={{ ...s.trackRow, ...(isActive ? s.trackRowActive : {}) }}
                      onClick={() => handlePlayFrom(trackIndex)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handlePlayFrom(trackIndex) } }}
                      onTouchStart={(e) => startTrackLongPress(track, e)}
                      onTouchEnd={cancelTrackLongPress}
                      onTouchMove={cancelTrackLongPress}
                      onContextMenu={(e) => { e.preventDefault(); openTrackSheet(track) }}
                    >
                      <span style={s.trackNum}>
                        {isPlaying
                          ? <EQBars />
                          : <span style={{ color: isActive ? 'var(--jp-text)' : 'var(--jp-text-3)' }}>
                              {track.track_number || i + 1}
                            </span>
                        }
                      </span>
                      <span style={s.trackInfo}>
                        <span style={{ ...s.trackTitle, color: isActive ? 'var(--jp-text)' : 'var(--jp-text)' }}>
                          {track.title}
                        </span>
                        <span style={s.trackSpec}>
                          <FormatBadge format={track.format} codec={track.codec} />
                          {spec && <span style={s.specText}>{spec}</span>}
                          {(track.channels || 0) > 2 && <span style={s.multiTag}>{track.channels}ch</span>}
                          {/* v1.1.0.76 — quiet RG chip. Renders the
                              tagged track gain (rounded to one
                              decimal), so the user can see at a
                              glance whether the file has RG and
                              roughly how much. Long-press the row
                              for the full track gain / album gain
                              / peaks / reference loudness. */}
                          {typeof track.track_gain_db === 'number' && (
                            <span style={s.rgChip} title={`Track gain ${track.track_gain_db.toFixed(2)} dB`}>
                              RG {track.track_gain_db > 0 ? '+' : ''}{track.track_gain_db.toFixed(1)}
                            </span>
                          )}
                          {/* v1.1.0.63: surface favourite + rating
                              quietly inside the spec line instead of
                              as a row of action buttons. The buttons
                              were always-visible in v58 which fought
                              with the JPLAY aesthetic; the row was
                              also becoming a cluttered grid. The
                              long-press sheet is the canonical place
                              to change these now. Render only when
                              set so the row stays clean. */}
                          {track.is_favorite ? <Heart size={11} fill="var(--jp-hot)" color="var(--jp-hot)" strokeWidth={0} /> : null}
                          {track.user_rating ? <span style={s.trackRatingChip}>{'★'.repeat(track.user_rating)}</span> : null}
                        </span>
                      </span>
                      <span style={s.trackDur}>{fmtDur(track.duration)}</span>
                    </div>
                  )
                })}
            </div>
          ))}
        </div>

        {/* v1.1.0.99 — Inline sections below the tracklist:
            About this album (bio cache) and More by this artist
            (up to 6 album tiles). Each section collapses to its
            header when there's no data — keeps the page rhythm
            consistent across albums whether or not we have content.
            Loaded once per album mount via /albums/:id/related.

            v1.1.2.1 — onAlbumSelect was previously `selectAlbum`,
            which doesn't exist in this scope (it's a name from
            AlbumGrid). The result was a ReferenceError thrown on
            every album page render the moment React evaluated this
            JSX, blanking the page. setSelectedAlbum on the store
            does the right thing; the related-tiles handler passes
            the full album object so we unwrap to its id here. */}
        <AlbumRelatedSections
          albumId={album.id}
          artistName={album.album_artist || album.artist}
          onAlbumSelect={(a) => setSelectedAlbum(a?.id || a)}
        />
      </div>

      {/* v1.1.0.61 — album overflow sheet, bottom-sheet style.
          Mirrors the NowPlaying overflow visual idiom. */}
      {showAlbumMenu && (
        <AlbumOverflowSheet
          onClose={() => setShowAlbumMenu(false)}
          isFavorite={isFavorite}
          favBusy={favBusy}
          onFavoriteToggle={() => { handleToggleFavorite(); setShowAlbumMenu(false) }}
          isSavedForLater={isSavedForLater}
          savedBusy={savedBusy}
          onSavedForLaterToggle={() => { handleToggleSavedForLater(); setShowAlbumMenu(false) }}
          onTagsClick={() => { setShowAlbumMenu(false); setTagPickerFor({ kind: 'album', id: album.id }) }}
          onPlayNext={() => { handlePlayNext(); setShowAlbumMenu(false) }}
          onShuffle={() => { handleShuffle(); setShowAlbumMenu(false) }}
          onShare={() => { setShowAlbumMenu(false); handleShare() }}
          shareLoading={shareLoading}
          albumType={album?.album_type}
          albumTypeLocked={!!album?.album_type_locked}
          onChangeTypeClick={() => { setShowAlbumMenu(false); setShowTypeSheet(true) }}
        />
      )}

      {/* v1.1.0.98 — Album type sub-sheet. Opens from the overflow
          menu. Picks one of six types (locks the album to that
          value) or "Auto-detect" (clears the lock and re-derives). */}
      {showTypeSheet && (
        <AlbumTypeSheet
          onClose={() => setShowTypeSheet(false)}
          currentType={album?.album_type}
          isLocked={!!album?.album_type_locked}
          onPick={handleChangeType}
        />
      )}

      {/* v1.1.0.63 — per-track action sheet. Long-press a track row
          (or right-click on desktop) opens this. Replaces the
          always-visible Heart + Star widgets that v58 drew on every
          row. The sheet does the same job in a way that doesn't
          clutter the row: one gesture, then choose what to do. */}
      {trackSheetTrack && (
        <TrackOverflowSheet
          track={trackSheetTrack}
          onClose={() => setTrackSheetTrack(null)}
          onPlay={() => {
            const idx = album.tracks.findIndex(t => t.id === trackSheetTrack.id)
            if (idx >= 0) handlePlayFrom(idx)
            setTrackSheetTrack(null)
          }}
          onTagsClick={() => {
            const t = trackSheetTrack
            setTrackSheetTrack(null)
            setTagPickerFor({ kind: 'track', id: t.id, track: t })
          }}
        />
      )}

      {/* v1.1.0.67 — TagPicker shown as a bottom sheet over the same
          backdrop pattern as the overflow sheets. Closes on backdrop
          tap or the picker's internal Done/Close buttons. */}
      {tagPickerFor && (
        <div style={s.sheetBackdrop} onClick={() => setTagPickerFor(null)}>
          <div style={s.sheetPanel} onClick={e => e.stopPropagation()}>
            <div style={s.sheetGrabber} />
            <TagPicker
              entityKind={tagPickerFor.kind}
              entityId={tagPickerFor.id}
              onClose={() => setTagPickerFor(null)}
            />
          </div>
        </div>
      )}
    </div>
  )
}

// v1.1.0.61 — album-page ⋯ bottom-sheet. Same idiom as the
// NowPlaying overflow: translucent backdrop captures outside taps,
// rounded inner panel slides up from the bottom, item rows are 44px
// tall for comfortable thumb taps, divider between primary
// v1.1.0.99 — Inline sections below the tracklist on the album page.
// Replaces the v90 user request "album page additional sections" —
// "More by [artist]" tiles row + "About this album" prose section.
// Each subsection collapses to its header alone when there's no data
// (e.g. an artist with only one album in the library, or an album
// with no bio cached yet). Keeps the page rhythm consistent across
// albums regardless of metadata coverage.
//
// Data flows from a single endpoint: /albums/:id/related. The
// endpoint reads bio from cache only (no network) and selects up to
// 6 other albums by album_artist. Both are server-side reads against
// the local sqlite — fast and safe to call on every album mount.
//
// Layout:
//   "More by <Artist>"        ← horizontal scroll row of tiles
//   "About this album"        ← collapsed section with prose + source
//
// Section order matches what the user listed in the v90 batch (#19):
//   "more albums by artist row of 3, 5 suggestions via genre+last.fm,
//    album description, about-the-album"
// The "5 suggestions via genre+last.fm" subsection is deferred to a
// future release because it needs a similar-artist fetcher we don't
// currently have.
function AlbumRelatedSections({ albumId, artistName, onAlbumSelect }) {
  const [data, setData] = useState(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoaded(false)
    setData(null)
    api.get(`/library/albums/${albumId}/related`).then(r => {
      if (!cancelled) {
        setData(r)
        setLoaded(true)
      }
    }).catch(e => {
      if (!cancelled) {
        // v1.1.0.99 — log instead of swallow. The /related endpoint is
        // read-only against local data so failures are unexpected;
        // visibility helps future debugging.
        console.warn('[album related] load failed:', e?.message || e)
        setLoaded(true)
      }
    })
    return () => { cancelled = true }
  }, [albumId])

  // Don't render until we've at least attempted the load — avoids a
  // brief layout shift while the page renders empty headers, then
  // pops in content.
  if (!loaded) return null

  const moreAlbums = (data?.more_by_artist) || []
  const bio = data?.bio || null

  // If both subsections have no data, render nothing. Hides the
  // sections completely on the (rare) album where the artist has
  // only one album AND bio fetch hasn't filled in. Otherwise show
  // the section(s) we have — empty subsections still render their
  // header so the page has a consistent rhythm even when partially
  // empty.
  if (moreAlbums.length === 0 && !bio) return null

  return (
    <div style={relStyles.wrap}>
      {moreAlbums.length > 0 && (
        <div style={relStyles.section}>
          <div style={relStyles.sectionHeader}>
            More by {artistName}
          </div>
          <div style={relStyles.tilesRow} className="jp-chip-row">
            {moreAlbums.map(a => (
              <button
                key={a.id}
                style={relStyles.tile}
                onClick={() => onAlbumSelect(a)}
              >
                <div style={relStyles.tileArtBox}>
                  {a.cover_art
                    ? <img src={a.cover_art} alt="" style={relStyles.tileArt} loading="lazy" draggable={false} />
                    : <div style={relStyles.tileArtEmpty}>♫</div>
                  }
                </div>
                <div style={relStyles.tileTitle}>{cleanTitle(a.title)}</div>
                {a.year && <div style={relStyles.tileYear}>{a.year}</div>}
              </button>
            ))}
          </div>
        </div>
      )}

      {bio && (
        <div style={relStyles.section}>
          <div style={relStyles.sectionHeader}>
            About this album
          </div>
          <div style={relStyles.bioContent}>
            {bio.content}
          </div>
          {bio.source_url && (
            <a
              href={bio.source_url}
              target="_blank"
              rel="noopener noreferrer"
              style={relStyles.bioSource}
            >
              {bio.source ? `Source: ${bio.source}` : 'Source'}
              <ExternalLink size={11} style={{ marginLeft: 4, verticalAlign: 'middle' }} />
            </a>
          )}
        </div>
      )}
    </div>
  )
}

// Scoped styles for the related sections — kept separate from the
// main `s` map so the section styling is self-contained and easy to
// tweak without disturbing existing album-page layout.
const relStyles = {
  wrap: {
    marginTop: 32,
    paddingTop: 20,
    borderTop: '1px solid rgba(var(--tint-rgb), 0.06)',
  },
  section: {
    marginBottom: 28,
  },
  sectionHeader: {
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: 'rgba(var(--tint-rgb), 0.45)',
    marginBottom: 12,
  },
  tilesRow: {
    display: 'flex',
    gap: 12,
    overflowX: 'auto',
    overflowY: 'hidden',
    WebkitOverflowScrolling: 'touch',
    paddingBottom: 6,
  },
  tile: {
    flex: '0 0 auto',
    width: 110,
    background: 'none',
    border: 'none',
    padding: 0,
    cursor: 'pointer',
    textAlign: 'left',
  },
  tileArtBox: {
    width: 110,
    height: 110,
    borderRadius: 4,
    overflow: 'hidden',
    background: 'var(--jp-bg-surface)',
    marginBottom: 6,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileArt: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    display: 'block',
  },
  tileArtEmpty: {
    fontSize: 22,
    color: 'rgba(var(--tint-rgb), 0.18)',
  },
  tileTitle: {
    fontSize: 12,
    fontWeight: 500,
    color: 'var(--jp-text)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    lineHeight: 1.25,
  },
  tileYear: {
    fontSize: 10,
    color: 'var(--jp-text-3)',
    fontFamily: 'var(--font-mono)',
    marginTop: 1,
  },
  bioContent: {
    fontSize: 13,
    lineHeight: 1.55,
    color: 'var(--jp-text-2)',
    whiteSpace: 'pre-wrap',
    // Give the bio prose a subtle visual container without making
    // it feel like a card. Just a left rule — same idiom blogs use
    // for blockquotes.
    paddingLeft: 12,
    borderLeft: '2px solid rgba(var(--tint-rgb), 0.08)',
  },
  bioSource: {
    display: 'inline-block',
    marginTop: 10,
    fontSize: 11,
    color: 'var(--jp-text-3)',
    textDecoration: 'none',
    paddingLeft: 12,
  },
}

// v1.1.0.61 — album-page ⋯ bottom-sheet. Same idiom as the
// NowPlaying overflow: translucent backdrop captures outside taps,
// rounded inner panel slides up from the bottom, item rows are 44px
// tall for comfortable thumb taps, divider between primary
// (favourite/share) and queue (play next/shuffle) and the v62
// placeholders. Style refs to NowPlaying's overflow* keys aren't
// shared because AlbumDetail has its own `s` map; we duplicate the
// minimal style needed here so the file stays self-contained.
function AlbumOverflowSheet({
  onClose,
  isFavorite, favBusy, onFavoriteToggle,
  isSavedForLater, savedBusy, onSavedForLaterToggle,
  onTagsClick,
  onPlayNext, onShuffle,
  onShare, shareLoading,
  albumType, albumTypeLocked, onChangeTypeClick,
}) {
  return (
    <div style={s.sheetBackdrop} onClick={onClose}>
      <div style={s.sheetPanel} onClick={e => e.stopPropagation()}>
        <div style={s.sheetGrabber} />

        {/* v1.1.36.0 — the favourite moved to the hero action row, next to
            Play. Not left here as well: a second way to do the same thing is
            what the Add Queue pill was, and it went for the same reason. */}

        <button style={s.sheetItem} onClick={onShare} disabled={shareLoading}>
          <Share2 size={18} style={s.sheetItemIcon} />
          <span>Share album link</span>
        </button>

        <div style={s.sheetDivider} />

        <button style={s.sheetItem} onClick={onPlayNext}>
          <ListMusic size={18} style={s.sheetItemIcon} />
          <span>Play next</span>
        </button>

        <button style={s.sheetItem} onClick={onShuffle}>
          <Shuffle size={18} style={s.sheetItemIcon} />
          <span>Shuffle play</span>
        </button>

        <div style={s.sheetDivider} />

        <button style={s.sheetItem} onClick={onTagsClick}>
          <Tag size={18} style={s.sheetItemIcon} />
          <span>Add to Tag…</span>
        </button>
        <button style={s.sheetItem} onClick={onSavedForLaterToggle} disabled={savedBusy}>
          <Bookmark
            size={18}
            style={s.sheetItemIcon}
            fill={isSavedForLater ? 'currentColor' : 'none'}
            strokeWidth={isSavedForLater ? 0 : 1.8}
          />
          <span>{isSavedForLater ? 'Saved for later' : 'Save for later'}</span>
        </button>

        {/* v1.1.0.98 — Change type entry. Shows the current type
            (and "manual" when the user has overridden the
            auto-detection) so the album's classification is visible
            from one tap. Tapping opens the type sub-sheet. */}
        <button style={s.sheetItem} onClick={onChangeTypeClick}>
          <Layers size={18} style={s.sheetItemIcon} />
          <span>Change type</span>
          <span style={s.sheetSoon}>
            {albumType
              ? (albumTypeLocked ? `${albumType} · manual` : albumType)
              : '—'}
          </span>
        </button>

        <button style={s.sheetClose} onClick={onClose}>Close</button>
      </div>
    </div>
  )
}

// v1.1.0.98 — Change-type sub-sheet. Six type rows with the current
// pick highlighted, plus an "Auto-detect" row at the bottom that
// clears any user override and re-derives from the album's
// title/folder/track-count.
const ALBUM_TYPE_OPTIONS = [
  { value: 'main',       label: 'Main',       hint: 'Full-length studio album' },
  { value: 'ep',         label: 'EP',         hint: '4–7 tracks, under 30 min' },
  { value: 'single',     label: 'Single',     hint: '1–3 tracks' },
  { value: 'soundtrack', label: 'Soundtrack', hint: 'OST / film / game music' },
  { value: 'deluxe',     label: 'Deluxe',     hint: 'Bonus tracks / anniversary edition' },
  { value: 'limited',    label: 'Limited',    hint: 'Special / collector edition' },
]
function AlbumTypeSheet({ onClose, currentType, isLocked, onPick }) {
  return (
    <div style={s.sheetBackdrop} onClick={onClose}>
      <div style={s.sheetPanel} onClick={e => e.stopPropagation()}>
        <div style={s.sheetGrabber} />
        <div style={{ padding: '4px 22px 12px' }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Album type</div>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
            Used by the Type filter on the Albums screen.
          </div>
        </div>
        {ALBUM_TYPE_OPTIONS.map(opt => {
          const isCurrent = currentType === opt.value
          return (
            <button
              key={opt.value}
              style={s.sheetItem}
              onClick={() => onPick(opt.value)}
            >
              {isCurrent
                ? <Check size={18} style={s.sheetItemIcon} color="#5fd97f" />
                : <span style={{ ...s.sheetItemIcon, width: 18 }} />}
              <div style={{ flex: 1 }}>
                <div>{opt.label}</div>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>{opt.hint}</div>
              </div>
              {isCurrent && isLocked && (
                <span style={s.sheetSoon}>manual</span>
              )}
            </button>
          )
        })}
        <div style={s.sheetDivider} />
        <button style={s.sheetItem} onClick={() => onPick('auto')}>
          <span style={{ ...s.sheetItemIcon, width: 18 }} />
          <div style={{ flex: 1 }}>
            <div>Auto-detect</div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>
              Clear manual override and re-derive from album metadata.
            </div>
          </div>
        </button>
        <button style={s.sheetClose} onClick={onClose}>Close</button>
      </div>
    </div>
  )
}

// v1.1.0.63 — per-track action sheet. Same bottom-sheet idiom as the
// album sheet. Keeps the Heart + Star + Rate functionality from v58
// reachable now that those buttons no longer live always-visible on
// the row. Fav and Rate state is local for the optimistic update;
// the canonical value comes back from the server response, and the
// album page re-fetches when the user closes back to it via Back.
function TrackOverflowSheet({ track, onClose, onPlay, onTagsClick }) {
  const { setTrackFavorite, setTrackRating, setTrackSavedForLater } = useStore()
  const [isFav, setIsFav] = useState(!!track.is_favorite)
  const [rating, setRating] = useState(track.user_rating || 0)
  // v1.1.0.67 — track-level Save for later. Local optimistic state
  // mirroring the favourite/rating pattern. The album-detail row
  // doesn't show this anywhere visible yet (no chip in the spec
  // line — that's a small future addition); for now the sheet is
  // the only place it's edited and seen.
  const [isSaved, setIsSaved] = useState(!!track.is_saved_for_later)
  const [busyFav, setBusyFav] = useState(false)
  const [busySaved, setBusySaved] = useState(false)
  const [showRater, setShowRater] = useState(false)
  const [busyRating, setBusyRating] = useState(false)

  const toggleFav = async () => {
    if (busyFav) return
    const next = !isFav
    setIsFav(next)
    setBusyFav(true)
    const r = await setTrackFavorite(track.id, next)
    setBusyFav(false)
    if (r == null || !!r !== next) setIsFav(r == null ? !next : !!r)
    else { track.is_favorite = next ? 1 : 0 }
  }
  const toggleSaved = async () => {
    if (busySaved) return
    const next = !isSaved
    setIsSaved(next)
    setBusySaved(true)
    const r = await setTrackSavedForLater(track.id, next)
    setBusySaved(false)
    if (r == null || !!r !== next) setIsSaved(r == null ? !next : !!r)
    else { track.is_saved_for_later = next ? 1 : 0 }
  }
  const setStars = async (n) => {
    if (busyRating) return
    const prev = rating
    setRating(n)
    setBusyRating(true)
    const r = await setTrackRating(track.id, n)
    setBusyRating(false)
    if (r == null) setRating(prev)
    else { setRating(r); track.user_rating = r }
  }

  return (
    <div style={s.sheetBackdrop} onClick={onClose}>
      <div style={s.sheetPanel} onClick={e => e.stopPropagation()}>
        <div style={s.sheetGrabber} />
        <div style={s.sheetTrackHeader}>
          <div style={s.sheetTrackTitle}>{track.title}</div>
          <div style={s.sheetTrackArtist}>{track.artist}</div>
        </div>

        <button style={s.sheetItem} onClick={onPlay}>
          <Play size={16} fill="currentColor" strokeWidth={0} style={s.sheetItemIcon} />
          <span>Play track</span>
        </button>

        <div style={s.sheetDivider} />

        <button style={s.sheetItem} onClick={toggleFav} disabled={busyFav}>
          <Heart
            size={18}
            style={s.sheetItemIcon}
            fill={isFav ? 'var(--jp-hot)' : 'none'}
            color={isFav ? 'var(--jp-hot)' : 'currentColor'}
            strokeWidth={isFav ? 0 : 1.8}
          />
          <span>{isFav ? 'Unfavourite this track' : 'Favourite this track'}</span>
        </button>

        <button style={s.sheetItem} onClick={() => setShowRater(v => !v)}>
          <Star
            size={18}
            style={s.sheetItemIcon}
            fill={rating > 0 ? '#ffc62b' : 'none'}
            color={rating > 0 ? '#ffc62b' : 'currentColor'}
            strokeWidth={rating > 0 ? 0 : 1.8}
          />
          <span>{rating > 0 ? `Rated ${rating}/5` : 'Rate'}</span>
          <span style={s.sheetSoon}>{showRater ? 'Hide' : 'Edit'}</span>
        </button>
        {showRater && (
          <div style={s.sheetRaterRow}>
            {[1, 2, 3, 4, 5].map(n => (
              <button
                key={n}
                style={s.sheetRaterStar}
                onClick={() => setStars(n === rating ? 0 : n)}
                aria-label={`${n} star${n === 1 ? '' : 's'}`}
                disabled={busyRating}
              >
                <Star
                  size={22}
                  fill={n <= rating ? '#ffc62b' : 'none'}
                  color={n <= rating ? '#ffc62b' : 'currentColor'}
                  strokeWidth={n <= rating ? 0 : 1.6}
                />
              </button>
            ))}
            <button
              style={{ ...s.sheetRaterStar, marginLeft: 'auto' }}
              onClick={() => setStars(0)}
              aria-label="Clear rating"
              disabled={busyRating || rating === 0}
            >
              <X size={16} />
            </button>
          </div>
        )}

        <div style={s.sheetDivider} />

        <button style={s.sheetItem} onClick={onTagsClick}>
          <Tag size={18} style={s.sheetItemIcon} />
          <span>Add to Tag…</span>
        </button>
        <button style={s.sheetItem} onClick={toggleSaved} disabled={busySaved}>
          <Bookmark
            size={18}
            style={s.sheetItemIcon}
            fill={isSaved ? 'currentColor' : 'none'}
            strokeWidth={isSaved ? 0 : 1.8}
          />
          <span>{isSaved ? 'Saved for later' : 'Save for later'}</span>
        </button>

        {/* v1.1.0.76 — ReplayGain info block. Renders only when the
            track has been scanned and at least one RG tag was
            present. Shows the values exactly as the file is tagged
            (track gain / album gain / peaks), plus the reference
            loudness if present. The chip at the bottom of the
            spec line in the album row is the at-a-glance summary;
            this is the detail view for users who care about the
            actual numbers. */}
        {(typeof track.track_gain_db === 'number' || typeof track.album_gain_db === 'number') && (
          <>
            <div style={s.sheetDivider} />
            <div style={s.rgBlock}>
              <div style={s.rgBlockTitle}>ReplayGain</div>
              <div style={s.rgGrid}>
                {typeof track.track_gain_db === 'number' && (
                  <>
                    <span style={s.rgLabel}>Track gain</span>
                    <span style={s.rgValue}>{track.track_gain_db.toFixed(2)} dB</span>
                  </>
                )}
                {typeof track.true_peak === 'number' && (
                  <>
                    <span style={s.rgLabel}>Track peak</span>
                    <span style={s.rgValue}>{track.true_peak.toFixed(2)} dBFS</span>
                  </>
                )}
                {typeof track.album_gain_db === 'number' && (
                  <>
                    <span style={s.rgLabel}>Album gain</span>
                    <span style={s.rgValue}>{track.album_gain_db.toFixed(2)} dB</span>
                  </>
                )}
                {typeof track.album_peak === 'number' && (
                  <>
                    <span style={s.rgLabel}>Album peak</span>
                    <span style={s.rgValue}>{track.album_peak.toFixed(2)} dBFS</span>
                  </>
                )}
                {typeof track.reference_lufs === 'number' && (
                  <>
                    <span style={s.rgLabel}>Reference</span>
                    <span style={s.rgValue}>{track.reference_lufs.toFixed(2)} LUFS</span>
                  </>
                )}
              </div>
            </div>
          </>
        )}

        <button style={s.sheetClose} onClick={onClose}>Close</button>
      </div>
    </div>
  )
}

// v56: small dropdown anchored to the Play split-button's chevron.
// Contains Play Now / Play Next / Add to Queue / Shuffle. Closes on
// outside click. Per-item icons mirror the photo: a list-style icon
// for the queue actions, Shuffle for the random one.
function PlayOptionsMenu({ onClose, onPlayNow, onPlayNext, onAddToQueue, onShuffle }) {
  const ref = useRef(null)
  useEffect(() => {
    // Defer one tick so the click that *opened* the menu doesn't
    // also close it. Same pattern used by NowPlaying's BulkMenu.
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
  return (
    <div ref={ref} style={s.playMenu} role="menu">
      <button style={s.playMenuItem} onClick={onPlayNow} role="menuitem">
        <ListMusic size={14} style={s.playMenuIcon} />
        <span>Play Now</span>
      </button>
      <button style={s.playMenuItem} onClick={onPlayNext} role="menuitem">
        <ListMusic size={14} style={s.playMenuIcon} />
        <span>Play Next</span>
      </button>
      <button style={s.playMenuItem} onClick={onAddToQueue} role="menuitem">
        <Plus size={14} style={s.playMenuIcon} />
        <span>Add to Queue</span>
      </button>
      <button style={s.playMenuItem} onClick={onShuffle} role="menuitem">
        <Shuffle size={14} style={s.playMenuIcon} />
        <span>Shuffle</span>
      </button>
    </div>
  )
}

// v58: per-track Heart + Star UI. Tapping the heart toggles
// tracks.is_favorite; tapping the star advances rating 0→1→2→3→4→5
// and back to 0 (single-tap rating, no half-stars). Each control is
// a real <button> so it intercepts the click and prevents the row's
// play handler from firing. Local state seeds from props on first
// render and updates optimistically; if the server rejects, the
// state reverts.
function TrackRowActions({ track, onFavoriteChange, onRatingChange }) {
  const { setTrackFavorite, setTrackRating } = useStore()
  const [isFav, setIsFav] = useState(!!track.is_favorite)
  const [rating, setRating] = useState(track.user_rating || 0)
  const [busyFav, setBusyFav] = useState(false)
  const [busyRating, setBusyRating] = useState(false)

  // If the parent re-fetches and the track row remounts with new
  // props, mirror them into local state. This keeps the row in sync
  // when the user navigates away and back.
  useEffect(() => { setIsFav(!!track.is_favorite) }, [track.is_favorite])
  useEffect(() => { setRating(track.user_rating || 0) }, [track.user_rating])

  const toggleFav = async (e) => {
    e.stopPropagation()
    if (busyFav) return
    const next = !isFav
    setIsFav(next)
    setBusyFav(true)
    const result = await setTrackFavorite(track.id, next)
    setBusyFav(false)
    if (result == null || !!result !== next) {
      // Server didn't confirm — revert to whatever it returned (or
      // back to previous if no result at all).
      setIsFav(result == null ? !next : !!result)
    } else if (onFavoriteChange) {
      onFavoriteChange(next)
    }
  }

  const cycleRating = async (e) => {
    e.stopPropagation()
    if (busyRating) return
    const next = rating >= 5 ? 0 : rating + 1
    setRating(next)
    setBusyRating(true)
    const result = await setTrackRating(track.id, next)
    setBusyRating(false)
    if (result == null) {
      // Revert
      setRating(rating)
    } else {
      setRating(result)
      if (onRatingChange) onRatingChange(result)
    }
  }

  return (
    <span style={s.trackActions} onClick={(e) => e.stopPropagation()}>
      <button
        style={s.trackActionBtn}
        onClick={toggleFav}
        title={isFav ? 'Unfavourite track' : 'Favourite track'}
        aria-pressed={isFav}
        disabled={busyFav}
      >
        <Heart
          size={14}
          fill={isFav ? '#ff3b5c' : 'none'}
          color={isFav ? '#ff3b5c' : 'currentColor'}
          strokeWidth={isFav ? 0 : 1.8}
        />
      </button>
      <button
        style={s.trackActionBtn}
        onClick={cycleRating}
        title={rating === 0 ? 'Rate track' : `Rating: ${rating}/5`}
        aria-label={`Rate track, current rating ${rating} of 5`}
        disabled={busyRating}
      >
        <Star
          size={14}
          fill={rating > 0 ? '#ffc62b' : 'none'}
          color={rating > 0 ? '#ffc62b' : 'currentColor'}
          strokeWidth={rating > 0 ? 0 : 1.8}
        />
        {rating > 0 && <span style={s.trackRatingNum}>{rating}</span>}
      </button>
    </span>
  )
}

// v1.1.34.0 — every version of this album, best quality first.
//
// The server orders these (bit depth, sample rate, track count), so the
// first row is the one a collapsed tile on the album wall would have
// shown. Rendering in that order means the list agrees with the wall
// without this component having to know the rule.
// v1.1.37.0 — the list only. Its toggle button moved up into the detail row
// beside the ReplayGain figures, and the open state with it: the button and
// the list are no longer siblings, so neither can own it.
function AlbumVersionsList({ versions, onOpen }) {
  return (
        <div style={s.versionsList}>
          {versions.map(v => (
            <button
              key={v.id}
              style={{ ...s.versionRow, ...(v.is_current ? s.versionRowOn : {}) }}
              onClick={() => { if (!v.is_current && onOpen) onOpen(v.id) }}
              disabled={v.is_current}
            >
              <span style={s.versionTitle}>{v.title}</span>
              <span style={s.versionMeta}>
                {v.primary_bit_depth && v.primary_sample_rate
                  ? `${v.primary_bit_depth}/${Math.round(v.primary_sample_rate / 100) / 10}`
                  : (v.primary_format || '').toUpperCase()}
                {v.track_count ? ` · ${v.track_count} tracks` : ''}
                {v.year ? ` · ${v.year}` : ''}
              </span>
              {v.is_current && <Check size={12} style={{ color: 'var(--green)', flexShrink: 0 }} />}
            </button>
          ))}
        </div>
  )
}


// v1.1.35.0 — one definition of the track-row column layout, used by both the
// header and every row. Two copies of a grid template is two chances for the
// header's "#" to stop sitting over the numbers it labels.
//
// 20px is two monospace digits with nothing spare, so a right-aligned number
// finishes level with the row's left padding rather than floating in from it;
// 46px holds "10:00" the same way on the other side.
const TRACK_GRID = '20px 1fr 38px'

const s = {
  // v1.1.0.63 — JPLAY-style album page. Pure black ground (was the
  // legacy charcoal-blue #0a0a10). The blurred-art bgArt and bgDim
  // gradient are no longer rendered (the JSX still references them
  // but the styles are no-ops here so we can flip them back in a
  // future revision without wider surgery). JPLAY pages run on a
  // clean black canvas — atmospheric halos around the cover read
  // as "iTunes" rather than "audiophile control point."
  page: { position: 'relative', minHeight: '100%', background: 'var(--jp-bg)' },
  bgArt: { display: 'none' },
  bgDim: { display: 'none' },
  // v1.1.36.0 — 8px of top padding, down from 20. With the ⋯ row above it
  // the artwork was sitting a long way down the screen for no reason.
  content: { position: 'relative', zIndex: 2, padding: '8px 16px 120px' },
  loadWrap: { display: 'flex', justifyContent: 'center', paddingTop: 80, background: 'var(--jp-bg)', minHeight: '100%' },
  spinner: { width: 24, height: 24, border: '2px solid rgba(var(--tint-rgb), 0.1)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' },
  back: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'rgba(var(--tint-rgb), 0.4)', background: 'none', border: 'none', cursor: 'pointer' },

  // v1.1.0.61: top nav row — back arrow on the left, ⋯ overflow on
  // the right. Replaces the old single-line back button at the top
  // of the album page; the marginBottom that lived on `back` is now
  // on this wrapper so the layout below is unaffected.
  // v1.1.0.95 — corrected visual asymmetry. The back button's
  // ArrowLeft icon sits flush with the left edge of its button (no
  // padding before it), while the ⋯ button was 36×36 with the icon
  // centered, leaving ~11px of empty space between the icon and the
  // right edge of the screen. Reading the album page side by side
  // the back arrow felt like it lived at the screen edge while the
  // ⋯ floated inward — a subtle but real off-centre feel.
  //
  // Fix: ⋯ button shrunk to 24×24 with the icon centered on it,
  // matching the visual weight of the ArrowLeft+text on the left.
  // Both icons now sit at the same distance from their respective
  // screen edges.
  topNav: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 6,
  },
  topMore: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-end',
    width: 24, height: 24,
    background: 'transparent',
    border: 'none',
    color: 'rgba(var(--tint-rgb), 0.7)',
    cursor: 'pointer',
    padding: 0,
  },

  // v1.1.0.61: bottom-sheet overflow for album page. Mirrors the
  // visual shape of the NowPlaying overflow sheet so the two screens
  // feel like the same product.
  sheetBackdrop: {
    position: 'fixed', inset: 0, zIndex: 800,
    background: 'rgba(0,0,0,0.55)',
    display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
    animation: 'sheetFade 0.18s ease',
  },
  // paddingBottom AFTER the shorthand: React writes these in order, so a
  // `padding` set later resets all four sides and this inset had never once
  // applied. Same trap fixed at five other sites in v1.1.26.0.
  sheetPanel: {
    width: '100%', maxWidth: 520,
    background: '#15151c',
    borderTopLeftRadius: 18, borderTopRightRadius: 18,
    padding: '8px 0 24px',
    paddingBottom: 'calc(24px + var(--safe-bot))',
    boxShadow: '0 -8px 30px rgba(0,0,0,0.5)',
    animation: 'sheetSlide 0.22s ease',
  },
  sheetGrabber: {
    width: 38, height: 4,
    background: 'rgba(var(--tint-rgb), 0.18)',
    borderRadius: 2,
    margin: '4px auto 14px',
  },
  sheetItem: {
    display: 'flex', alignItems: 'center', gap: 14,
    width: '100%',
    padding: '14px 22px',
    background: 'transparent',
    border: 'none',
    color: 'var(--text-primary)',
    fontSize: 15, fontWeight: 500,
    textAlign: 'left',
    cursor: 'pointer',
  },
  sheetItemDisabled: {
    display: 'flex', alignItems: 'center', gap: 14,
    width: '100%',
    padding: '14px 22px',
    background: 'transparent',
    border: 'none',
    color: 'rgba(var(--tint-rgb), 0.35)',
    fontSize: 15, fontWeight: 500,
    textAlign: 'left',
    cursor: 'default',
  },
  sheetItemIcon: { flexShrink: 0 },
  sheetSoon: {
    marginLeft: 'auto',
    fontSize: 11, fontWeight: 600,
    color: 'rgba(var(--tint-rgb), 0.4)',
    fontFamily: 'var(--font-mono)',
    letterSpacing: '0.05em',
  },
  sheetDivider: {
    height: 1,
    background: 'rgba(var(--tint-rgb), 0.06)',
    margin: '4px 22px',
  },
  sheetClose: {
    display: 'block', width: 'calc(100% - 44px)',
    margin: '14px 22px 0',
    padding: '14px 0',
    background: 'transparent',
    border: '1px solid rgba(var(--tint-rgb), 0.12)',
    borderRadius: 999,
    color: 'var(--text-primary)',
    fontSize: 14, fontWeight: 600,
    cursor: 'pointer',
  },
  // v1.1.0.63: track-action-sheet specific bits. The album sheet
  // doesn't need a header (the album page is the context); the
  // track sheet does, so the user knows which track they're acting
  // on. 14/600 title, 12/400 artist; tucked above the action items.
  sheetTrackHeader: {
    padding: '0 22px 12px',
    borderBottom: '1px solid rgba(var(--tint-rgb), 0.06)',
    marginBottom: 6,
  },
  sheetTrackTitle: {
    fontSize: 14, fontWeight: 600,
    color: 'var(--jp-text)',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  sheetTrackArtist: {
    fontSize: 12, fontWeight: 400,
    color: 'var(--jp-text-2)',
    marginTop: 2,
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  // Inline rater row inside the track sheet, expanded under "Rate".
  sheetRaterRow: {
    display: 'flex', alignItems: 'center',
    padding: '6px 18px 12px',
    gap: 4,
  },
  sheetRaterStar: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 36, height: 36,
    background: 'transparent',
    border: 'none',
    color: 'rgba(var(--tint-rgb), 0.35)',
    cursor: 'pointer',
    borderRadius: 6,
    padding: 0,
  },
  // Toast confirmation pill (#v1.1.0.37). Fixed position so it
  // floats above all content, anchored to the bottom of the viewport
  // ABOVE the mini now-playing bar (--nowplaying-h is 90px). White
  // background with dark text per user spec; same font size as the
  // album title (18px) so it reads as a peer to the content rather
  // than a system notification.
  // pointer-events:none lets taps go through to whatever's below --
  // there's nothing actionable in a toast.
  // The fade-in animation softens the appearance; without it the
  // pill pops abruptly at 3-second intervals.
  toast: {
    position: 'fixed',
    left: '50%',
    bottom: 'calc(var(--nowplaying-h) + 14px)',
    transform: 'translateX(-50%)',
    zIndex: 200,
    padding: '10px 22px',
    borderRadius: 24,
    background: 'var(--jp-accent)',
    color: 'var(--jp-bg)',
    fontSize: 18,
    fontWeight: 600,
    letterSpacing: '-0.2px',
    boxShadow: '0 6px 24px rgba(0,0,0,0.45)',
    pointerEvents: 'none',
    animation: 'toastIn 180ms ease-out',
    whiteSpace: 'nowrap',
    maxWidth: 'calc(100vw - 28px)',
  },
  // #v1.1.0.30 -- hero anchors at flex-start so the album art
  // sits at the top of its column rather than dropping down to
  // align with the bottom of the info block. Small marginTop
  // pushes the whole hero away from the topbar.
  // v1.1.0.63 — JPLAY-style hero. Was a 130×130 rounded-10 cover
  // with a heavy 8/32 dropshadow inline-flex with the info column.
  // JPLAY uses larger covers, sharper corners (4px), and no
  // dropshadow — the cover sits flat on the black ground, same as
  // album tiles in the grid. The marginBottom shrinks because we're
  // also dropping the noisy meta + genre pill into a single line.
  // v1.1.35.0 — the hero row is now just the cover and the title block, so
  // centring them against each other reads better than top-aligning a two-line
  // block against a 144px square. Everything else moved to heroBelow.
  // v1.1.36.0 — the column beside the cover STRETCHES to the cover's height
  // and space-betweens its two children. That is what puts the title's top
  // level with the top of the artwork and the Play row's bottom level with
  // its bottom, at any cover size and however long the title runs.
  hero: { display: 'flex', gap: 14, marginTop: 0, marginBottom: 16, alignItems: 'stretch' },
  // 132, down from 144. The action row now shares this line, and three
  // controls plus a split button do not fit beside a 144px cover on a phone.
  artWrap: { width: 132, height: 132, flexShrink: 0, borderRadius: 4, overflow: 'hidden', background: 'var(--jp-bg-surface)' },
  art: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
  artFallback: { width: '100%', height: '100%', background: 'rgba(var(--tint-rgb), 0.04)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 36, color: 'rgba(var(--tint-rgb), 0.15)' },
  heroInfo: {
    flex: 1, minWidth: 0,
    display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
    // A long title pushes the actions down rather than out of the column.
    gap: 10,
  },
  // The full-width block under the cover: format line, ReplayGain, actions,
  // versions. Given the whole page width, these stop wrapping on a phone.
  heroBelow: { marginBottom: 14 },
  // 22/600 (was 18/700). Reads as "section heading" not "headline".
  heroTitle: { fontSize: 25, fontWeight: 600, color: 'var(--jp-text)', letterSpacing: '-0.4px', lineHeight: 1.18, marginBottom: 5, wordBreak: 'break-word' },
  // Artist name 14/500 secondary-text (was 15/500 at 78% white).
  // Sits as a peer to the title without competing for attention.
  artistBtn: { background: 'none', border: 'none', padding: 0, fontSize: 15, fontWeight: 500, color: 'var(--jp-text-2)', cursor: 'pointer', marginBottom: 0, display: 'block', textAlign: 'left' },
  // Meta line: year · tracks · duration · genre · format-mix all on
  // a single mono line. Each token separated by a thin middle-dot.
  // No more separate genrePill; the genre joins the meta string and
  // is still tappable (rendered as a span with onClick + a subtle
  // underline on hover). 11/400 mono in --jp-text-3 — quiet
  // metadata, not foreground content.
  // 12.5 rather than 11, and a wider gap. The line has the full page width
  // now, so it can afford to be read at arm's length.
  heroMeta: { display: 'flex', gap: 8, fontSize: 12.5, color: 'var(--jp-text-3)', fontFamily: 'var(--font-mono)', marginBottom: 10, flexWrap: 'wrap', alignItems: 'center', lineHeight: 1.5 },
  heroMetaSep: { color: 'rgba(var(--tint-rgb), 0.18)', userSelect: 'none' },
  heroMetaGenre: {
    background: 'none', border: 'none', padding: 0,
    color: 'var(--jp-text-2)', cursor: 'pointer', fontSize: 11,
    fontFamily: 'var(--font-mono)',
    textDecoration: 'underline', textDecorationColor: 'rgba(var(--tint-rgb), 0.15)',
    textUnderlineOffset: 3,
  },
  // Kept defined for any leftover callers but no longer rendered
  // by the v63 hero. The visual design pulls the genre into the
  // meta line instead.
  genrePill: { display: 'none' },
  // Action row -- Play, Queue, Heart, Share inline distributed
  // across the full width with equal spacing (#v1.1.0.33). Uses
  // space-between so the row spans edge-to-edge with the same gap
  // on each side, which is what "equal gap on both sides of the
  // screen" actually requires (centred + flex-wrap was wrapping
  // the share button to a second row on iPhone widths). flex-wrap
  // disabled here on purpose -- if it ever doesn't fit, we'd
  // rather see horizontal overflow than a broken visual rhythm.
  // v1.1.34.0 — flex-start, NOT space-between.
  //
  // space-between only looked right because the phone was cramped. This
  // row sits inside heroInfo, which is flex:1 beside a fixed 144px cover
  // — so on a phone there is barely room for Play and Add Queue and they
  // end up touching, while on a tablet the same rule throws them to
  // opposite ends of a very wide box with a lane of empty space between
  // them. The buttons were never actually being placed side by side;
  // they were being spread, and on a narrow screen spread happens to
  // look like adjacent.
  //
  // flex-start with a real gap puts them side by side at every width,
  // and wrap means a narrow phone with the circled plus in the row
  // moves a button to a second line instead of squashing all three.
  heroActions: { display: 'flex', alignItems: 'center', justifyContent: 'flex-start', flexWrap: 'wrap', marginTop: 10, gap: 8 },
  // Row that holds the MBID chip + About button (or the
  // not-matched placeholder) below the action buttons.
  // #v1.1.0.33: changed from centred to space-between so the two
  // pills spread edge-to-edge matching the action row above. Same
  // visual rhythm: equal gap on both sides of the screen.
  matchedPillRow: {
    display: 'flex',
    alignItems: 'center',
    // v1.1.34.0 — follows heroActions to flex-start for the same reason.
    // Its comment above says it was set to space-between to match the
    // action row; keeping it that way would now be the mismatch.
    justifyContent: 'flex-start',
    gap: 8,
    marginTop: 14,
    marginBottom: 16,
  },
  // MBID chip (#30.21). #v1.1.0.31 -- shape matched to the About pill
  // beside it so the pair reads as a balanced row rather than
  // mismatched chip + pill. Same border-radius (12) and vertical
  // padding (5px) as bioBtn; horizontal padding kept slightly larger
  // because the chip carries more inline content (label, value, two
  // icon buttons). Monospace font preserved so the UUID-like value
  // stays legible as a technical identifier.
  mbidChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '4px 10px',
    background: 'rgba(var(--tint-rgb), 0.06)',
    border: '1px solid rgba(var(--tint-rgb), 0.12)',
    borderRadius: 11,
    fontSize: 10,
    fontFamily: 'var(--font-mono)',
    color: 'rgba(var(--tint-rgb), 0.7)',
    width: 'fit-content',
  },
  mbidLabel: { color: 'rgba(var(--tint-rgb), 0.45)', letterSpacing: '0.04em' },
  mbidValue: { color: 'rgba(var(--tint-rgb), 0.85)' },
  mbidIconBtn: {
    width: 18, height: 18,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    background: 'transparent',
    color: 'rgba(var(--tint-rgb), 0.6)',
    border: 'none',
    borderRadius: 4,
    cursor: 'pointer',
    textDecoration: 'none',
    padding: 0,
  },
  // "About" bio pill (#30.23) -- sits next to the MBID chip via the
  // matchedPillRow flex container. Margin removed in #v1.1.0.30 since
  // gap on the parent row handles spacing now.
  bioBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    padding: '5px 12px',
    background: 'rgba(var(--tint-rgb), 0.06)',
    color: 'rgba(var(--tint-rgb), 0.85)',
    border: '1px solid rgba(var(--tint-rgb), 0.12)',
    borderRadius: 12,
    fontSize: 11,
    fontWeight: 500,
    cursor: 'pointer',
  },
  // Play and Queue pills -- padding tightened in #v1.1.0.33 so all
  // four action buttons (Play / Queue / Heart / Share) fit
  // comfortably on a single row at iPhone widths.
  playBtn: { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '8px 14px', borderRadius: 20, background: 'var(--jp-accent)', color: 'var(--jp-bg)', fontSize: 13, fontWeight: 700, border: 'none', cursor: 'pointer' },
  // v1.1.33.0 — the circled plus and the line under it. Four new keys;
  // none of them already existed in this map (a duplicate key here is an
  // esbuild WARNING, not an error, and the later value silently wins).
  // Sized and cornered to sit level with Add Queue rather than to match
  // the round pills either side of it, because it is an icon action and
  // not a labelled one.
  // v1.1.36.0 — one shell for both round actions in the hero row, the heart
  // and the service ⊕, so the pair cannot end up different sizes. 34px rather
  // than 38: two of them plus the split Play button have to fit beside the
  // cover on a phone.
  heroIconBtn: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 34, height: 34, borderRadius: 18, flexShrink: 0,
    background: 'transparent', color: 'var(--jp-text-2)',
    border: '1px solid rgba(var(--tint-rgb), 0.15)', cursor: 'pointer', padding: 0,
  },
  heroIconBtnFav: {
    background: 'rgba(255, 59, 92, 0.10)',
    borderColor: 'rgba(255, 59, 92, 0.35)',
  },
  heroIconBtnOn: {
    background: 'rgba(var(--tint-rgb), 0.12)',
    color: 'var(--green)',
    borderColor: 'rgba(var(--tint-rgb), 0.25)',
  },
  serviceLine: {
    display: 'flex', alignItems: 'center', gap: 8, marginTop: 10,
    flexWrap: 'wrap',
  },
  serviceLineText: { fontSize: 11, color: 'var(--jp-text-3)' },
  versionsToggle: {
    display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0,
    padding: '6px 11px', borderRadius: 20, fontSize: 12, fontWeight: 600,
    background: 'transparent', color: 'var(--jp-text-2)',
    border: '1px solid rgba(var(--tint-rgb), 0.15)', cursor: 'pointer',
  },
  versionsList: { width: '100%', display: 'flex', flexDirection: 'column', gap: 4, marginTop: -4, marginBottom: 14 },
  versionRow: {
    display: 'flex', alignItems: 'center', gap: 10, width: '100%',
    padding: '9px 12px', borderRadius: 6, textAlign: 'left',
    background: 'transparent', color: 'var(--jp-text-2)',
    border: '1px solid var(--jp-border)', cursor: 'pointer',
  },
  versionRowOn: { background: 'rgba(var(--tint-rgb), 0.08)', color: 'var(--jp-text)', cursor: 'default' },
  versionTitle: { flex: 1, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  versionMeta: { fontSize: 10, color: 'var(--jp-text-3)', fontFamily: 'var(--font-mono)', flexShrink: 0 },

  // v56: Play split-button. Two halves of one visual pill — the left
  // half (label "Play") triggers Play Now directly; the right half
  // (chevron) opens the dropdown menu. Subtle vertical divider
  // between the halves echoes the photo. The wrapper is positioned
  // relative so the menu can absolute-position below it.
  playSplitWrap: {
    position: 'relative',
    display: 'inline-flex', alignItems: 'stretch',
    background: 'var(--jp-accent)', color: 'var(--jp-bg)',
    borderRadius: 20,
    overflow: 'visible',
  },
  playBtnSplit: {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    padding: '8px 12px 8px 14px',
    background: 'transparent', color: 'var(--jp-bg)',
    fontSize: 13, fontWeight: 700,
    border: 'none', cursor: 'pointer',
    borderRadius: '20px 0 0 20px',
    borderRight: '1px solid rgba(0,0,0,0.18)',
  },
  playSplitChevron: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    padding: '0 10px',
    background: 'transparent', color: 'var(--jp-bg)',
    border: 'none', cursor: 'pointer',
    borderRadius: '0 20px 20px 0',
  },
  playMenu: {
    position: 'absolute',
    top: 'calc(100% + 6px)',
    left: 0,
    minWidth: 200,
    background: 'rgba(28, 28, 36, 0.96)',
    backdropFilter: 'blur(18px)',
    WebkitBackdropFilter: 'blur(18px)',
    border: '1px solid rgba(var(--tint-rgb), 0.12)',
    borderRadius: 10,
    boxShadow: '0 12px 32px rgba(0,0,0,0.55)',
    padding: 4,
    zIndex: 600,
    display: 'flex', flexDirection: 'column',
  },
  playMenuItem: {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '11px 14px',
    background: 'transparent',
    border: 'none',
    textAlign: 'left',
    color: 'var(--jp-text)',
    fontSize: 14, fontWeight: 500,
    cursor: 'pointer',
    borderRadius: 6,
    width: '100%',
  },
  playMenuIcon: { color: 'rgba(var(--tint-rgb), 0.7)', flexShrink: 0 },
  // The heart sits above the pill; both align as a small vertical pair on the right of the action row.
  shareCol: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, marginLeft: 'auto' },
  // Heart and share buttons -- height matched to Play/Queue pills
  // (#v1.1.0.32) so they align cleanly when sitting inline with them.
  // Width still 44 each so the pair feels visually consistent.
  heartBtn: {
    width: 44, height: 34,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'rgba(var(--tint-rgb), 0.05)',
    color: 'rgba(var(--tint-rgb), 0.55)',
    border: '1px solid rgba(var(--tint-rgb), 0.12)',
    borderRadius: 17,
    cursor: 'pointer',
    padding: 0,
    transition: 'background 0.15s, border-color 0.15s, transform 0.1s',
  },
  heartBtnActive: {
    background: 'rgba(255,59,92,0.15)',
    borderColor: 'rgba(255,59,92,0.45)',
  },
  // Pill-shaped share button — same width and height as the heart.
  shareBtnPill: {
    width: 44, height: 34,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'rgba(var(--tint-rgb), 0.08)',
    color: 'rgba(var(--tint-rgb), 0.75)',
    border: '1px solid rgba(var(--tint-rgb), 0.15)',
    borderRadius: 17,
    cursor: 'pointer',
    padding: 0,
  },
  tracklist: { borderTop: '1px solid rgba(var(--tint-rgb), 0.08)', paddingTop: 6 },
  discHeader: { fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'rgba(var(--tint-rgb), 0.3)', padding: '14px 8px 4px' },
  // v1.1.35.0 — the number column was 32px wide with a further 10px of right
  // padding, so a single-digit track number sat ~22px in from the row edge
  // while the duration finished 8px from the other one. The left gutter read
  // as visibly deeper than the right.
  //
  // The column is now just wide enough for two digits with no extra padding,
  // and the row is padded equally on both sides — so the number and the time
  // are inset by the same amount, and the title starts ~12px earlier into the
  // bargain.
  trackHeader: { display: 'grid', gridTemplateColumns: TRACK_GRID, gap: 5, padding: '4px 8px', fontSize: 9, fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'rgba(var(--tint-rgb), 0.25)', borderBottom: '1px solid rgba(var(--tint-rgb), 0.06)', marginBottom: 2 },
  thNum: { textAlign: 'right' },
  // v1.1.0.63 — JPLAY-style track row. Was a 4-column grid (num /
  // info / dur / actions) where the actions column held the
  // always-visible Heart + Star buttons added in v58. The buttons
  // moved into the long-press TrackOverflowSheet, so the grid loses
  // its trailing column. Row padding bumped from 8 to 10/8 so
  // 44-row spacing reads as comfortable on phone without growing
  // the height too much. Active row gets a quiet 4% white wash —
  // half what the old "0.06" was — JPLAY's active highlights are
  // restrained.
  trackRow: { display: 'grid', gridTemplateColumns: TRACK_GRID, alignItems: 'center', gap: 5, padding: '11px 8px', borderRadius: 6, width: '100%', cursor: 'pointer', background: 'none', border: 'none', textAlign: 'left', transition: 'background 0.1s' },
  trackRowActive: { background: 'rgba(var(--tint-rgb), 0.04)' },
  trackNum: { textAlign: 'right', fontSize: 12.5, fontFamily: 'var(--font-mono)', display: 'flex', justifyContent: 'flex-end', alignItems: 'center', minHeight: 14 },
  trackInfo: { display: 'flex', flexDirection: 'column', gap: 4, overflow: 'hidden' },
  // 14/500 (was 13/400). JPLAY's track title weight is the
  // visually-dominant element of the row — slightly heavier than
  // the spec line below.
  trackTitle: { fontSize: 15, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--jp-text)' },
  // v1.1.35.0 — wraps rather than clips. This line only ever just fitted a
  // phone, and the ReplayGain chip is last, so any width it lost got taken
  // out of the chip mid-word — "RG -8.(" with the rest cut off. Wrapping
  // costs a few pixels of row height on a narrow screen and keeps every
  // figure readable, which is the trade the information is worth.
  trackSpec: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', rowGap: 4, minWidth: 0 },
  specText: { fontSize: 10, color: 'var(--jp-text-3)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' },
  trackDur: { fontSize: 12, color: 'var(--jp-text-3)', fontFamily: 'var(--font-mono)', textAlign: 'right' },
  // v1.1.0.63: small ★ chip rendered inline in the spec line when a
  // track has a non-zero rating. Tiny, gold, no background — just
  // sits among the other meta tokens. Hidden when rating is 0 so
  // unrated rows are pure clean.
  trackRatingChip: {
    fontSize: 10,
    color: '#ffc62b',
    letterSpacing: 0.5,
    fontFamily: 'var(--font-mono)',
  },
  multiTag: { padding: '1px 4px', borderRadius: 3, fontSize: 9, fontWeight: 700, fontFamily: 'var(--font-mono)', background: 'rgba(91,127,255,0.2)', color: 'var(--accent)', border: '1px solid rgba(91,127,255,0.3)' },

  // v1.1.0.76 — quiet RG chip in the track spec line. Same visual
  // weight as the "kHz / kbps / LUFS" specText to its left, but
  // styled as a soft pill so it reads as a distinct item rather
  // than continuation of the format string. No icon — would just
  // be noise at this size.
  rgChip: {
    padding: '1px 5px',
    borderRadius: 3,
    fontSize: 9,
    fontWeight: 600,
    fontFamily: 'var(--font-mono)',
    background: 'rgba(var(--tint-rgb), 0.05)',
    color: 'var(--jp-text-2)',
    border: '1px solid var(--jp-border)',
    whiteSpace: 'nowrap',
  },
  // v1.1.0.76 — RG detail block in the track overflow sheet. Two-
  // column grid (label / value), all values right-aligned for
  // numeric scanning. Lives between the existing item rows and
  // the Close button.
  rgBlock: {
    padding: '10px 18px',
  },
  rgBlockTitle: {
    fontSize: 10, fontWeight: 600,
    color: 'var(--jp-text-3)',
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  rgGrid: {
    display: 'grid',
    gridTemplateColumns: 'auto 1fr',
    columnGap: 16,
    rowGap: 4,
  },
  rgLabel: {
    fontSize: 11,
    color: 'var(--jp-text-2)',
  },
  rgValue: {
    fontSize: 11,
    color: 'var(--jp-text)',
    fontFamily: 'var(--font-mono)',
    textAlign: 'right',
  },
  // v1.1.0.76 — album-level RG row in the hero. Smaller than the
  // year/tracks/genre meta line above it; reads as a sub-line.
  // v1.1.37.0 — one row holding the ReplayGain figures and the versions
  // button. The RG group flexes and shrinks; the button does not. So the
  // figures wrap inside their own box to make room, and the button only
  // drops to a second line when there is genuinely none left.
  detailRow: {
    display: 'flex',
    alignItems: 'center',
    // NOT wrap. Wrapping let the button drop to a line of its own the
    // moment the figures got long, which is the row this change exists to
    // save. Held on one line, the RG group shrinks and its text wraps
    // INSIDE its own box instead, and the button keeps its place at the
    // right whatever the figures say.
    flexWrap: 'nowrap',
    gap: 10,
    marginBottom: 14,
  },
  heroRgRow: {
    // inline-flex, not flex: this is a flex ITEM of detailRow now, not a
    // row of its own. As a block it would take the full width and push the
    // versions button onto the next line every time.
    display: 'inline-flex',
    flex: '1 1 auto',
    minWidth: 0,
    alignItems: 'flex-start',
    gap: 8,
    marginTop: 0,
    fontSize: 12,
    color: 'var(--jp-text-3)',
    fontFamily: 'var(--font-mono)',
    flexWrap: 'nowrap',
    lineHeight: 1.5,
  },
  // v1.1.35.0 — reads "RG". Spelled out, it was the longest thing on the line
  // and the least interesting: the numbers beside it are the content. Boxed so
  // a two-letter label still reads as a label rather than as the start of the
  // value.
  heroRgLabel: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.06em',
    color: 'var(--jp-text-3)',
    border: '1px solid var(--jp-border)',
    borderRadius: 3,
    padding: '1px 5px',
    flexShrink: 0,
  },
  heroRgValue: {
    color: 'var(--jp-text-2)',
    // Wraps INSIDE its own box. Letting the row wrap instead left the "RG"
    // chip stranded on a line of its own with the numbers underneath it.
    flex: 1,
    minWidth: 0,
  },
  heroRgCoverage: {
    color: 'var(--jp-text-3)',
    opacity: 0.8,
  },

  // (v58 trackActions / trackActionBtn / trackRatingNum styles
  // removed in v63 — replaced by the long-press TrackOverflowSheet
  // and the inline ★ chip rendered into trackSpec when rating>0.)
  btnSpinner: { width: 15, height: 15, border: '2px solid rgba(var(--tint-rgb), 0.2)', borderTopColor: 'rgba(var(--tint-rgb), 0.7)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' },
  // v1.1.19.0 — centred, not a bottom sheet.
  //
  // This was alignItems:'flex-end', which put the card at the bottom of the
  // screen where the mini transport bar sits on top of it — the card's own
  // Download button ended up underneath the player. Centring it clears the
  // bar entirely and gives the preview the room it deserves.
  shareOverlay: {
    position: 'fixed', inset: 0, zIndex: 300,
    background: 'rgba(0,0,0,0.72)', backdropFilter: 'blur(6px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 20,
    // The screen is full-bleed under viewport-fit=cover, so the overlay
    // clears the status bar and home indicator itself.
    paddingTop: 'calc(20px + var(--safe-top))',
    paddingBottom: 'calc(20px + var(--safe-bot))',
  },
  shareSheet: {
    width: 'min(100%, 420px)', maxHeight: '100%',
    overflowY: 'auto',
    background: 'var(--bg-surface)',
    borderRadius: 20,
    border: '1px solid var(--border-bright)',
    padding: '0 0 16px',
    boxShadow: '0 8px 40px rgba(0,0,0,0.5)',
  },
  shareHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 20px 14px' },
  shareTitle: { fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' },
  shareClose: { width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 'var(--radius-sm)', background: 'var(--bg-elevated)', color: 'var(--text-tertiary)', border: 'none', cursor: 'pointer' },
  sharePreview: { width: 'calc(100% - 32px)', margin: '0 16px 16px', borderRadius: 10, display: 'block', boxShadow: '0 4px 20px rgba(0,0,0,0.4)' },
  shareHint: { padding: '0 16px', fontSize: 12, color: 'var(--text-tertiary)', textAlign: 'center' },
}

// v1.1.0.57 — named exports so NowPlaying's About panel can use the
// same format badge and codec helpers without duplicating logic.
export { FormatBadge, shortCodec }

