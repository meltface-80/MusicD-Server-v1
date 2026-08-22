import React from 'react'
import { Layers } from 'lucide-react'

// v1.1.34.0 — "this tile stands for more than one copy of the album".
//
// Drawn only when a tile is actually representing others, which is why
// the server sends version_count as ABSENT rather than 1 for a normal
// album: a badge that has to compare a number against 1 at every call
// site is a badge that eventually gets drawn saying "1 version".
//
// Top-right, opposite the streaming service glyph in the bottom-left,
// so an album that is both a Qobuz album and one of several versions
// shows both without them colliding.
export default function VersionBadge({ count }) {
  if (!count || count < 2) return null
  return (
    <span style={s.badge} title={`${count} versions of this album`} aria-label={`${count} versions`}>
      <Layers size={9} strokeWidth={2} />
      <span style={s.count}>{count}</span>
    </span>
  )
}

const s = {
  // Themed rather than a fixed dark chip: this sits over album art, and
  // the app has two light palettes. See themes.test.js — the fixed
  // white/black list is short on purpose and this does not need to join it.
  badge: {
    position: 'absolute', top: 6, right: 6,
    display: 'inline-flex', alignItems: 'center', gap: 3,
    padding: '2px 6px', borderRadius: 10,
    background: 'var(--jp-bg)', color: 'var(--jp-text-2)',
    border: '1px solid var(--jp-border)',
    boxShadow: '0 1px 3px rgba(var(--tint-rgb), 0.25)',
    pointerEvents: 'none', userSelect: 'none',
  },
  count: { fontSize: 10, fontWeight: 700, fontFamily: 'var(--font-mono)', lineHeight: 1 },
}
