import React, { useState } from 'react'
import { api } from '../api'
import { X, Check, RotateCcw } from 'lucide-react'
import RendererIcon, { ICONS, CATEGORIES, defaultIconFor } from './RendererIcon'

// Renderer icon picker (#30.22)
// =============================
// Modal that opens on top of the renderer modal. Lets the user pick
// an icon for one specific renderer from a categorised grid of ~24
// icons. Persists the choice via POST /api/renderers/icon, then
// fires onChange so the parent modal can refresh its list.
//
// "Reset to default" clears the saved choice (sends iconId: null);
// the renderer falls back to the protocol-based default.

export default function RendererIconPicker({ renderer, onClose, onChange }) {
  const currentId = (renderer.icon_id && ICONS.find(i => i.id === renderer.icon_id))
    ? renderer.icon_id
    : defaultIconFor(renderer)

  const [selected, setSelected] = useState(currentId)
  const [activeCat, setActiveCat] = useState(
    ICONS.find(i => i.id === currentId)?.category || 'speakers'
  )
  const [saving, setSaving] = useState(false)
  // Save error surfaced in the modal (#30.24). Without this, save
  // failures only logged to console and the user thought the save
  // had worked when it hadn't.
  const [saveError, setSaveError] = useState(null)

  const save = async (iconIdOrNull) => {
    setSaving(true)
    setSaveError(null)
    try {
      await api.post('/renderers/icon', {
        rendererId: renderer.id,
        iconId: iconIdOrNull,
      })
      onChange && onChange()
      onClose()
    } catch (e) {
      console.error('[icon-picker] save failed:', e)
      setSaveError(e.message || 'Save failed -- check connection and try again.')
      setSaving(false)
    }
  }

  const filteredIcons = ICONS.filter(i => i.category === activeCat)

  return (
    // Higher z-index than the underlying renderer modal (700) so this
    // sits on top. Click on backdrop dismisses without saving.
    <div style={s.overlay} onClick={onClose}>
      <div style={s.sheet} onClick={e => e.stopPropagation()}>
        <div style={s.handle} />

        <div style={s.header}>
          <div>
            <div style={s.title}>Choose icon</div>
            <div style={s.subtitle}>{renderer.name}</div>
          </div>
          <button style={s.iconBtn} onClick={onClose} title="Cancel"><X size={14} /></button>
        </div>

        {/* Category tabs. Horizontally scrollable on phones since 7
            categories don't fit on a 360px viewport. */}
        <div style={s.tabs}>
          {CATEGORIES.map(cat => (
            <button
              key={cat.id}
              style={{ ...s.tab, ...(activeCat === cat.id ? s.tabActive : {}) }}
              onClick={() => setActiveCat(cat.id)}
            >
              {cat.label}
            </button>
          ))}
        </div>

        {/* Icon grid. 5 cols on phone, scales up to 7+ on tablet via
            the same media queries used for the album grid. */}
        <div style={s.grid}>
          {filteredIcons.map(icon => {
            const isSelected = selected === icon.id
            return (
              <button
                key={icon.id}
                style={{ ...s.gridCell, ...(isSelected ? s.gridCellActive : {}) }}
                onClick={() => setSelected(icon.id)}
                title={icon.label}
              >
                <RendererIcon renderer={{ ...renderer, icon_id: icon.id }} size={28} />
                <div style={s.gridLabel}>{icon.label}</div>
                {isSelected && (
                  <div style={s.gridCheck}><Check size={10} /></div>
                )}
              </button>
            )
          })}
        </div>

        {saveError && (
          <div style={s.saveError}>{saveError}</div>
        )}

        <div style={s.footer}>
          <button style={s.resetBtn}
                  onClick={() => save(null)}
                  disabled={saving}
                  title="Clear saved choice and use the default for this renderer's protocol/brand">
            <RotateCcw size={11} /> Reset to default
          </button>
          <button style={s.saveBtn}
                  onClick={() => save(selected)}
                  disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

const s = {
  overlay: {
    // z-index 800 sits above the renderer modal (700) but below the
    // top-level full-screen Now Playing (which uses 900+).
    position: 'fixed', inset: 0, zIndex: 800,
    background: 'rgba(0,0,0,0.65)',
    display: 'flex', alignItems: 'flex-end',
  },
  sheet: {
    background: 'var(--bg-surface)',
    borderRadius: '16px 16px 0 0',
    width: '100%', maxHeight: '85vh',
    display: 'flex', flexDirection: 'column',
    borderTop: '1px solid var(--border)',
  },
  handle: { width: 40, height: 4, background: 'var(--text-muted)', borderRadius: 2, margin: '8px auto 4px', opacity: 0.4 },
  header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '8px 16px 12px', borderBottom: '1px solid var(--border)', gap: 12 },
  title: { fontSize: 15, fontWeight: 700 },
  subtitle: { fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 },
  iconBtn: { width: 30, height: 30, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-elevated)', color: 'var(--text-secondary)', border: '1px solid var(--border)', cursor: 'pointer', flexShrink: 0 },

  tabs: {
    display: 'flex', gap: 4,
    padding: '8px 12px',
    overflowX: 'auto',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0,
    // Hide scrollbar on iOS but keep scrolling working
    scrollbarWidth: 'none',
  },
  tab: {
    padding: '6px 12px',
    borderRadius: 14,
    fontSize: 11, fontWeight: 500,
    background: 'transparent',
    color: 'var(--text-tertiary)',
    border: '1px solid transparent',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  tabActive: {
    background: 'var(--bg-elevated)',
    color: 'var(--text-primary)',
    borderColor: 'var(--border)',
  },

  grid: {
    flex: 1, overflowY: 'auto',
    padding: 12,
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: 8,
  },
  gridCell: {
    position: 'relative',
    display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center',
    gap: 6,
    padding: '12px 6px',
    borderRadius: 'var(--radius-md)',
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border)',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    minHeight: 76,
  },
  gridCellActive: {
    background: 'rgba(91,127,255,0.10)',
    borderColor: 'var(--accent)',
    color: 'var(--accent)',
  },
  gridLabel: {
    fontSize: 9,
    color: 'var(--text-tertiary)',
    textAlign: 'center',
    lineHeight: 1.2,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    width: '100%',
    whiteSpace: 'nowrap',
  },
  gridCheck: {
    position: 'absolute',
    top: 4, right: 4,
    width: 16, height: 16,
    borderRadius: '50%',
    background: 'var(--accent)',
    color: 'white',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },

  footer: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: 12, gap: 8,
    borderTop: '1px solid var(--border)',
    flexShrink: 0,
  },
  // Save-error pill, surfaced when api.post('/renderers/icon') fails.
  // Sits above the footer so it's clearly attached to the action.
  saveError: {
    margin: '0 12px',
    padding: '6px 10px',
    fontSize: 11,
    color: '#e85a7a',
    background: 'rgba(232,90,122,0.08)',
    border: '1px solid rgba(232,90,122,0.25)',
    borderRadius: 'var(--radius-sm)',
  },
  resetBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    padding: '8px 12px',
    borderRadius: 14, fontSize: 11,
    background: 'transparent',
    color: 'var(--text-tertiary)',
    border: '1px solid var(--border)',
    cursor: 'pointer',
  },
  saveBtn: {
    padding: '8px 18px',
    borderRadius: 14, fontSize: 12, fontWeight: 600,
    background: 'var(--accent)',
    color: 'white',
    border: 'none',
    cursor: 'pointer',
  },
}
