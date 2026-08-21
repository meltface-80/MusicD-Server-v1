import React from 'react'

// v1.1.33.0 — the "this one streams" marker.
//
// DELIBERATELY NOT A LOGO. Reproducing the Qobuz or Tidal marks from
// memory would be the same mistake this repo already made twice with its
// own artwork on the share card: an approximation of somebody's real
// logo, drawn from a description. These are the app's own type — an
// initial in the mono face, in a tinted circle — plus a title and
// aria-label carrying the actual service name. Unmistakable at 14px,
// and not pretending to be anyone's brand.
//
// Two forms:
//   <ServiceBadge service="qobuz" />           a 16px disc for album tiles
//   <ServiceBadge service="tidal" variant="chip" />   a text chip with room
//
// Both return null for a local album (service null/undefined), so callers
// can render one unconditionally rather than guarding at every site —
// which is how half the sites end up without it.

const SERVICES = {
  qobuz: { label: 'Qobuz', initial: 'Q', tint: '#0f7bc4' },
  tidal: { label: 'Tidal', initial: 'T', tint: '#00b3c7' },
}

export default function ServiceBadge({ service, variant = 'dot', size = 16 }) {
  const def = SERVICES[service]
  if (!def) return null

  if (variant === 'chip') {
    return (
      <span style={{ ...s.chip, color: def.tint, borderColor: hexA(def.tint, 0.4) }}
        title={def.label} aria-label={def.label}>
        {def.label}
      </span>
    )
  }

  return (
    <span
      style={{
        ...s.dot,
        width: size, height: size,
        fontSize: Math.round(size * 0.6),
        background: hexA(def.tint, 0.92),
      }}
      title={def.label}
      aria-label={def.label}
      role="img"
    >
      {def.initial}
    </span>
  )
}

// Small helper so the tint can be written once as a hex string above and
// still be used at partial opacity, without pulling in a colour library
// for two call sites.
function hexA(hex, alpha) {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

export function serviceLabel(service) {
  return SERVICES[service] ? SERVICES[service].label : null
}

export const SERVICE_IDS = Object.keys(SERVICES)

const s = {
  // Tile corner disc. White glyph on the service tint reads at 16px over
  // any artwork, which a tinted glyph on a translucent ground does not.
  // The one fixed white in this feature, and it is the allowed kind: a
  // label on a fill that is itself a fixed colour, exactly like the white
  // on ProfileBar's #d04848. The disc is the service tint in every theme —
  // that is the whole point of it — so the glyph on top has to be fixed
  // too, or it goes mid-grey on mid-blue when the palette changes under
  // it. themes.test.js lists this file for that reason. The shadow IS
  // themed, because it falls on the artwork rather than on the disc.
  dot: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    borderRadius: '50%', color: '#fff', fontWeight: 700,
    fontFamily: 'var(--font-mono)', lineHeight: 1,
    boxShadow: '0 1px 3px rgba(var(--tint-rgb), 0.35)',
    flexShrink: 0, userSelect: 'none',
  },
  chip: {
    display: 'inline-flex', alignItems: 'center',
    padding: '2px 7px', borderRadius: 4,
    fontSize: 10, fontWeight: 600, letterSpacing: '0.06em',
    textTransform: 'uppercase', fontFamily: 'var(--font-mono)',
    border: '1px solid', background: 'transparent',
    flexShrink: 0, whiteSpace: 'nowrap',
  },
}
