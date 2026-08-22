import React, { useEffect, useState } from 'react'
import { api } from '../api'
import { Layers } from 'lucide-react'

// Settings → Library → Album versions (v1.1.34.0).
//
// A library that has the original, the deluxe and the remaster of one
// record shows three tiles for one album. With this on, they collapse
// into one — the best-quality copy — with the others reachable from its
// page, the way Roon does it.
//
// TWO THINGS WORTH SAYING ON THE PAGE, because both are the difference
// between this feeling safe and feeling risky:
//
//   Nothing is merged or deleted. Grouping is a way of LOOKING at the
//   library, not a change to it. Turn it off and every version is back,
//   because none of them ever went anywhere.
//
//   It only applies where you browse a catalogue — the album wall and
//   artist pages. Favourites, Saved for later, Tags, Playlists and
//   search still show every version, because there you picked a
//   specific one and hiding it behind another copy would lose it.
//
// Off by default: an upgrade should not silently change what somebody's
// library looks like.
export default function AlbumVersionsSection() {
  const [on, setOn] = useState(null)      // null = not loaded yet
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    api.get('/settings')
      .then(s => { if (!cancelled) setOn(!!s.library_group_versions) })
      .catch(() => { if (!cancelled) setOn(false) })
    return () => { cancelled = true }
  }, [])

  const toggle = async () => {
    if (busy || on === null) return
    const next = !on
    setOn(next)               // optimistic; rolled back below
    setBusy(true)
    setError(null)
    try {
      await api.patch('/settings', { library_group_versions: next })
    } catch (e) {
      setOn(!next)
      setError(e.message || 'Could not save that')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={s.wrap}>
      <div style={s.row}>
        <div style={s.rowText}>
          <div style={s.rowLabel}>
            <Layers size={13} style={{ marginRight: 6, verticalAlign: '-2px' }} />
            Group album versions
          </div>
          <div style={s.rowSub}>
            Show one tile per album instead of one per copy. The original,
            the deluxe and the remaster become a single entry, and the
            version you get is the best quality one you own.
          </div>
        </div>
        <button
          style={{ ...s.toggle, ...(on ? s.toggleOn : {}) }}
          onClick={toggle}
          disabled={busy || on === null}
          role="switch"
          aria-checked={!!on}
          aria-label="Group album versions"
        >
          <span style={{ ...s.knob, ...(on ? s.knobOn : {}) }} />
        </button>
      </div>

      {error && <div style={s.error}>{error}</div>}

      <p style={s.footnote}>
        Nothing is merged or deleted — this changes how the library is
        shown, not what is in it. Every version is still there, listed on
        the album's own page, and turning this off brings them all back.
      </p>
      <p style={s.footnote}>
        Applies to the album wall and artist pages. Favourites, Saved for
        later, Tags, Playlists and search keep showing every version,
        because there you picked a particular one.
      </p>
      <p style={s.footnote}>
        Versions are matched by MusicBrainz release group where an album
        has been matched, and by album title and artist where it has not
        — so running the matcher makes the grouping more accurate.
      </p>
    </div>
  )
}

const s = {
  wrap: { paddingBottom: 4 },
  row: { display: 'flex', alignItems: 'flex-start', gap: 14, padding: '4px 0 12px' },
  rowText: { flex: 1, minWidth: 0 },
  rowLabel: { fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 },
  rowSub: { fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 },
  // Same switch as Settings → Home Screen. Deliberately identical rather
  // than a second look for the same control; the white knob is the fixed
  // fill themes.test.js lists this file for.
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
  error: {
    margin: '0 0 10px', padding: '8px 10px', borderRadius: 6, fontSize: 12,
    background: 'rgba(255,59,92,0.08)', border: '1px solid rgba(255,59,92,0.30)',
    color: 'var(--text-secondary)',
  },
  footnote: { fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.5, margin: '0 0 8px' },
}
