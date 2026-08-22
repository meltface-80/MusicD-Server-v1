import React, { useEffect, useRef, useState } from 'react'
import { Loader2, Check } from 'lucide-react'
import ServiceBadge from './ServiceBadge'
import VersionBadge from './VersionBadge'
import { SelectionTick } from './AlbumSelection'

// One album tile, for every grid in the app (v1.1.34.0).
//
// WHY THIS EXISTS. There were three separate implementations of "an
// album tile": the library wall, the artist page, and the Qobuz / Tidal
// screens. They drifted, exactly as three copies of anything do:
//
//   * the streaming service glyph added in v1.1.33.0 reached the
//     library wall and not the artist page
//   * the Qobuz screens grew a conditional quality line under the
//     artist, so tiles with a quality string were TALLER than tiles
//     without one and the grid rows stretched unevenly — the reported
//     "Qobuz albums are all different sizes"
//
// So the tile is one component now, and its structure is FIXED: a
// square cover, one line of title, one line of subtitle. Always those
// three, always one line each, whatever the data. That is what makes
// every tile in every grid exactly the same height — a tile whose
// height depends on whether a field happens to be present cannot line
// up with its neighbours, and no amount of CSS on the grid fixes it.
//
// Everything else — the service glyph, the version count, the
// selection tick, the in-library tick, the loading spinner — is drawn
// as an OVERLAY on the artwork, absolutely positioned. Overlays cannot
// change the tile's height, which is the whole point.
//
// Accepts both row shapes the app has: a library album row
// (cover_art / album_artist) and a normalised streaming album
// (cover / artist), so callers pass what they already have.
export default function AlbumTile({
  album,
  onClick,
  showArtist = true,
  subtitle,            // overrides the artist line when given
  selecting = false,
  selected = false,
  busy = false,        // a spinner over the art: fetching before navigating
  inLibrary = false,   // a tick: you already have this streaming album
  dim = false,         // unavailable in this region
  disabled = false,
}) {
  const [imgSrc, setImgSrc] = useState(null)
  const [imgErr, setImgErr] = useState(false)
  const cardRef = useRef(null)

  const cover = album.cover_art || album.cover || null
  const artist = album.album_artist || album.artist || ''

  // Lazy load: the wall can be thousands of tiles, and fetching every
  // cover on mount is what makes a large library crawl on a phone.
  useEffect(() => {
    if (!cover) return
    setImgErr(false)
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setImgSrc(cover)
        observer.disconnect()
      }
    }, { rootMargin: '150px' })
    if (cardRef.current) observer.observe(cardRef.current)
    return () => observer.disconnect()
  }, [cover])

  return (
    <button
      ref={cardRef}
      style={{ ...s.card, ...(dim ? s.cardDim : {}) }}
      onClick={disabled || dim ? undefined : onClick}
      disabled={disabled || dim}
      // Kept from the library wall: a right-click or long-press on a
      // tile otherwise raises the browser's own image menu, which is
      // what the iOS callout suppression in index.css exists to stop.
      onContextMenu={e => e.preventDefault()}
      aria-pressed={selecting ? selected : undefined}
    >
      <div style={{ ...s.artBox, ...(selecting && !selected ? s.artBoxDim : {}) }}>
        {imgSrc && !imgErr
          ? <img src={imgSrc} alt="" style={s.art} onError={() => setImgErr(true)} loading="lazy" draggable={false} />
          : <div style={s.artEmpty}>♫</div>
        }

        {/* Overlays. None of these affect the tile's height. */}
        {selecting && <SelectionTick on={selected} />}
        {album.service && (
          <span style={s.serviceBadge}>
            <ServiceBadge service={album.service} size={16} />
          </span>
        )}
        <VersionBadge count={album.version_count} />
        {inLibrary && !selecting && (
          <span style={s.inLibrary} title="Already in your library">
            <Check size={10} strokeWidth={3} />
          </span>
        )}
        {busy && (
          <div style={s.busy}>
            <Loader2 size={18} style={{ animation: 'spin 1s linear infinite' }} />
          </div>
        )}
      </div>

      {/* Exactly two text lines, always. The subtitle falls back to a
          non-breaking space — written as an escape because a literal one
          is invisible in the source — so a tile with no artist is still
          exactly as tall as one that has an artist. A plain space would
          collapse in JSX and the line would lose its height, which is
          the ragged-grid bug this component was extracted to fix. */}
      <div style={s.cardTitle}>{album.title}</div>
      {showArtist && <div style={s.cardArtist}>{subtitle || artist || '\u00a0'}</div>}
    </button>
  )
}

// Lifted verbatim from the library wall's own tile, so "the same as the
// main library" is true by construction rather than by having been
// copied carefully once.
const s = {
  card: { display: 'block', background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left', minWidth: 0 },
  cardDim: { opacity: 0.4, cursor: 'default' },
  artBox: {
    position: 'relative', width: '100%', aspectRatio: '1/1', borderRadius: 4,
    overflow: 'hidden', background: 'var(--jp-bg-surface)', marginBottom: 8,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  artBoxDim: { opacity: 0.45 },
  art: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
  artEmpty: { fontSize: 24, color: 'rgba(var(--tint-rgb), 0.18)' },
  cardTitle: { fontSize: 13, fontWeight: 500, color: 'var(--jp-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginBottom: 2, lineHeight: 1.25 },
  cardArtist: { fontSize: 12, fontWeight: 400, color: 'var(--jp-text-2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  serviceBadge: { position: 'absolute', left: 6, bottom: 6, display: 'flex', pointerEvents: 'none' },
  inLibrary: {
    position: 'absolute', right: 6, bottom: 6,
    width: 17, height: 17, borderRadius: '50%',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--jp-bg)', color: 'var(--green)',
    border: '1px solid var(--jp-border)', pointerEvents: 'none',
  },
  busy: {
    position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
    justifyContent: 'center', background: 'var(--jp-bg)', opacity: 0.82,
    color: 'var(--jp-text)',
  },
}
