import React, { useState } from 'react'
import { Check } from 'lucide-react'
import { THEMES, applyTheme, loadThemeId, saveThemeId } from '../theme'

// Settings → Appearance (v1.1.24.0).
//
// The four themes from MusicD-Remote. Each row previews its OWN palette
// rather than the applied one — that is the point of a picker, and it is what
// the data-theme/data-palette pair on the swatch buys: the palette blocks in
// index.css are written as plain attribute selectors, so any element carrying
// both attributes gets that palette's tokens.
//
// Tapping a row applies it immediately. The remote makes this a two-step
// select-then-Apply, because there it also has to reload; here the whole app
// reads CSS variables, so the change is instant and reversible by tapping
// another row — a confirm step would be ceremony around something with no
// consequence.
export default function AppearanceSection() {
  const [current, setCurrent] = useState(() => loadThemeId())

  const choose = (id) => {
    if (id === current) return
    setCurrent(applyTheme(id))
    saveThemeId(id)
  }

  return (
    <div>
      <p style={s.blurb}>
        The palette this device uses. Kept per device rather than on the
        server: a phone at night and a desktop in daylight want different
        answers, and one shared setting would force them to agree.
      </p>

      <div style={s.list}>
        {THEMES.map(t => {
          const on = t.id === current
          return (
            <button
              key={t.id}
              style={{ ...s.row, ...(on ? s.rowOn : {}) }}
              onClick={() => choose(t.id)}
              role="radio"
              aria-checked={on}
              aria-label={t.label}
            >
              {/* The swatch renders INSIDE its own palette, so it shows the
                  theme instead of describing it. */}
              <span
                data-theme={t.theme}
                data-palette={t.palette}
                style={s.swatch}
              >
                <span style={s.swatchAccent} />
              </span>
              <span style={s.rowText}>
                <span style={{ ...s.rowLabel, ...(on ? s.rowLabelOn : {}) }}>{t.label}</span>
                <span style={s.rowNote}>{t.note}</span>
              </span>
              <span style={s.rowCheck}>{on && <Check size={16} />}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

const s = {
  blurb: { fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.55, margin: '0 0 14px' },
  list: { display: 'flex', flexDirection: 'column', gap: 8 },
  row: {
    display: 'flex', alignItems: 'center', gap: 12,
    width: '100%', padding: '10px 12px',
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    textAlign: 'left', cursor: 'pointer',
    fontFamily: 'inherit',
  },
  rowOn: { borderColor: 'var(--accent)', background: 'var(--accent-dim)' },
  // The swatch carries its own data-theme/data-palette, so --bg-base and
  // --accent inside it are that theme's, not the applied one's.
  swatch: {
    width: 40, height: 40, flexShrink: 0,
    borderRadius: 'var(--radius-sm)',
    background: 'var(--bg-base)',
    border: '1px solid var(--border-bright)',
    display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end',
    padding: 4, overflow: 'hidden',
  },
  swatchAccent: {
    width: 16, height: 16, borderRadius: '50%',
    background: 'var(--accent)', display: 'block',
  },
  rowText: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 },
  rowLabel: { fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' },
  rowLabelOn: { color: 'var(--accent)', fontWeight: 700 },
  rowNote: { fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.4 },
  rowCheck: {
    width: 20, flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: 'var(--accent)',
  },
}
