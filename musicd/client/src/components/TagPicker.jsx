// v1.1.0.67 — TagPicker: an inline panel for selecting tags and
// creating new ones. Used inside both AlbumOverflowSheet and
// TrackOverflowSheet under the "Add to Tag" item.
//
// Behaviour:
//   - Shows all existing tags as togglable chips. Tapping flips the
//     tag on/off in the local "selected" set. The set is persisted
//     to the server when the user taps "Done", or auto-applied if
//     the parent passes autoApply=true.
//   - "+ New tag" expands an inline input. Submitting creates the
//     tag on the server, adds it to the selected set, and re-renders
//     the chip strip.
//   - Empty state: a friendly prompt to create the first tag.
//
// Props:
//   - entityKind: 'album' | 'track'
//   - entityId:   the album or track id
//   - onClose():  called when the user taps Done or backdrops out
//   - autoApply:  if true, every tag toggle hits the server
//                 immediately. If false (default), changes are
//                 queued locally and committed on Done.
//
// State model:
//   tags:        full tag catalog from the server (id, name, color)
//   selected:    Set<id> of tags currently applied to the entity
//   working:     Set<id> the user's pending edits (for non-autoApply)
//   newName:     string for the inline create input
//   busy:        boolean while a server call is in flight

import React, { useEffect, useState, useRef } from 'react'
import { useStore } from '../store'
import { Plus, X, Check, Tag as TagIcon } from 'lucide-react'

// v1.1.0.72 — colour palette for the create-tag form. Same set as
// the management screen in TagManagementSection. Keeping them as
// peer constants rather than a shared util because the picker and
// the management screen are conceptually independent surfaces and
// might diverge (e.g. the picker could one day expose only the most-
// used 4 swatches while management exposes all 8).
const PRESET_COLORS = [
  { name: 'None',    hex: null    },
  { name: 'Red',     hex: '#ef4444' },
  { name: 'Orange',  hex: '#f97316' },
  { name: 'Yellow',  hex: '#eab308' },
  { name: 'Green',   hex: '#22c55e' },
  { name: 'Cyan',    hex: '#06b6d4' },
  { name: 'Blue',    hex: '#3b82f6' },
  { name: 'Purple',  hex: '#a855f7' },
  { name: 'Pink',    hex: '#ec4899' },
]

export default function TagPicker({ entityKind, entityId, onClose, autoApply = false }) {
  const {
    loadTags, createTag,
    getAlbumTags, getTrackTags,
    setAlbumTags, setTrackTags,
  } = useStore()

  const [allTags, setAllTags] = useState([])
  const [working, setWorking] = useState(new Set())
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  // v1.1.0.72 — colour selection at create time. Same curated palette
  // as the management screen. The default (null) gives a monochrome
  // chip, which is the most common case.
  const [newColor, setNewColor] = useState(null)
  const [error, setError] = useState(null)
  const inputRef = useRef(null)

  const getEntityTags = entityKind === 'album' ? getAlbumTags : getTrackTags
  const setEntityTags = entityKind === 'album' ? setAlbumTags : setTrackTags

  // Initial load: fetch the full catalog and the entity's current tags.
  useEffect(() => {
    let cancelled = false
    Promise.all([
      loadTags(),
      getEntityTags(entityId),
    ]).then(([tags, current]) => {
      if (cancelled) return
      setAllTags(tags || [])
      setWorking(new Set((current || []).map(t => t.id)))
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [entityId, entityKind])

  // Focus the new-tag input when it appears.
  useEffect(() => {
    if (showCreate && inputRef.current) {
      inputRef.current.focus()
    }
  }, [showCreate])

  const toggle = async (tagId) => {
    const next = new Set(working)
    if (next.has(tagId)) next.delete(tagId)
    else next.add(tagId)
    setWorking(next)
    if (autoApply) {
      setBusy(true)
      const result = await setEntityTags(entityId, [...next])
      setBusy(false)
      if (result == null) setError('Failed to save')
    }
  }

  const handleCreate = async () => {
    const name = newName.trim()
    if (!name) return
    setBusy(true)
    setError(null)
    // v1.1.0.72 — pass the selected colour. createTag accepts null
    // for "no colour" (the default monochrome chip).
    const created = await createTag(name, newColor)
    setBusy(false)
    if (!created) {
      setError('Failed to create tag')
      return
    }
    if (created._error) {
      // 409 — already exists. Find it in the catalog (or refresh)
      // and toggle it on. The server's response on 409 includes the
      // existing id but the wrapper currently strips that; refetch.
      const fresh = await loadTags()
      setAllTags(fresh || [])
      const match = (fresh || []).find(t => t.name.toLowerCase() === name.toLowerCase())
      if (match) {
        const next = new Set(working)
        next.add(match.id)
        setWorking(next)
        if (autoApply) await setEntityTags(entityId, [...next])
      } else {
        setError(created._error)
      }
      setNewName('')
      setNewColor(null)
      setShowCreate(false)
      return
    }
    // Successfully created — add to catalog and to working set.
    setAllTags(prev => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)))
    const next = new Set(working)
    next.add(created.id)
    setWorking(next)
    if (autoApply) await setEntityTags(entityId, [...next])
    setNewName('')
    setNewColor(null)
    setShowCreate(false)
  }

  const handleDone = async () => {
    if (!autoApply) {
      setBusy(true)
      const result = await setEntityTags(entityId, [...working])
      setBusy(false)
      if (result == null) {
        setError('Failed to save')
        return
      }
    }
    onClose()
  }

  return (
    <div style={s.panel}>
      <div style={s.header}>
        <TagIcon size={14} style={{ color: 'var(--jp-text-2)' }} />
        <span style={s.headerText}>
          Tags · {entityKind === 'album' ? 'Album' : 'Track'}
        </span>
        <button style={s.closeBtn} onClick={onClose} aria-label="Close">
          <X size={14} />
        </button>
      </div>

      {loading ? (
        <div style={s.loading}>Loading tags…</div>
      ) : (
        <>
          {allTags.length === 0 && !showCreate && (
            <div style={s.empty}>
              No tags yet. Create your first one to get started.
            </div>
          )}
          {allTags.length > 0 && (
            <div style={s.chipsWrap}>
              {allTags.map(tag => {
                const on = working.has(tag.id)
                const chipStyle = {
                  ...s.chip,
                  ...(on ? s.chipOn : {}),
                  ...(tag.color && on ? { borderColor: tag.color, background: hexToRgba(tag.color, 0.18) } : {}),
                }
                return (
                  <button
                    key={tag.id}
                    style={chipStyle}
                    onClick={() => toggle(tag.id)}
                    disabled={busy}
                  >
                    {on && <Check size={11} style={{ marginRight: 4 }} />}
                    {tag.name}
                  </button>
                )
              })}
            </div>
          )}

          {showCreate ? (
            <div style={s.createBox}>
              <input
                ref={inputRef}
                type="text"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleCreate()
                  if (e.key === 'Escape') { setShowCreate(false); setNewName(''); setNewColor(null) }
                }}
                placeholder="Tag name"
                maxLength={60}
                style={s.input}
                disabled={busy}
              />
              {/* v1.1.0.72 — colour swatch row inside the create flow.
                  Lets users pick a colour without going to Settings →
                  Tags. Same curated palette as the management screen. */}
              <div style={s.swatchRow}>
                {PRESET_COLORS.map(c => (
                  <button
                    key={c.name}
                    type="button"
                    onClick={() => setNewColor(c.hex)}
                    style={{
                      ...s.swatch,
                      background: c.hex || 'transparent',
                      border: `1.5px solid ${newColor === c.hex ? 'var(--jp-text)' : 'var(--jp-border)'}`,
                    }}
                    title={c.name}
                    aria-label={c.name}
                  >
                    {c.hex === null && <span style={s.swatchNoneText}>—</span>}
                  </button>
                ))}
              </div>
              <div style={s.createBtnRow}>
                <button style={s.createBtn} onClick={handleCreate} disabled={busy || !newName.trim()}>
                  Create
                </button>
                <button style={s.cancelBtn} onClick={() => { setShowCreate(false); setNewName(''); setNewColor(null) }} disabled={busy}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button style={s.addNewBtn} onClick={() => setShowCreate(true)} disabled={busy}>
              <Plus size={13} /> New tag
            </button>
          )}

          {error && <div style={s.error}>{error}</div>}

          {!autoApply && (
            <button style={s.doneBtn} onClick={handleDone} disabled={busy}>
              {busy ? 'Saving…' : 'Done'}
            </button>
          )}
        </>
      )}
    </div>
  )
}

// Helper: convert "#rrggbb" + alpha to rgba(r,g,b,a) for chip backgrounds.
function hexToRgba(hex, alpha) {
  if (!hex || hex.length !== 7) return `rgba(var(--tint-rgb), ${alpha})`
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

const s = {
  // The panel is rendered inline inside an overflow sheet, so it
  // takes the sheet's padding and styling cues. JPLAY tokens
  // throughout. The chip colours respect a per-tag colour when set.
  panel: {
    padding: '6px 18px 14px',
  },
  header: {
    display: 'flex', alignItems: 'center', gap: 8,
    paddingBottom: 10,
    borderBottom: '1px solid var(--jp-border)',
    marginBottom: 12,
  },
  headerText: {
    flex: 1,
    fontSize: 12, fontWeight: 600, letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: 'var(--jp-text-2)',
  },
  closeBtn: {
    width: 28, height: 28,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'transparent', border: 'none',
    color: 'var(--jp-text-3)', cursor: 'pointer',
    borderRadius: 4,
  },
  loading: { fontSize: 14, color: 'var(--jp-text-3)', textAlign: 'center', padding: '14px 0' },
  empty: { fontSize: 13, color: 'var(--jp-text-3)', padding: '4px 0 10px', lineHeight: 1.5 },
  chipsWrap: {
    display: 'flex', flexWrap: 'wrap', gap: 6,
    marginBottom: 10,
  },
  chip: {
    display: 'inline-flex', alignItems: 'center',
    padding: '5px 10px',
    fontSize: 13, fontWeight: 500,
    background: 'transparent',
    color: 'var(--jp-text-2)',
    border: '1px solid var(--jp-border)',
    borderRadius: 999,
    cursor: 'pointer',
  },
  chipOn: {
    background: 'rgba(var(--tint-rgb), 0.10)',
    borderColor: 'var(--jp-border-hot)',
    color: 'var(--jp-text)',
  },
  addNewBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    padding: '6px 11px',
    fontSize: 13, fontWeight: 500,
    background: 'transparent',
    color: 'var(--jp-text-2)',
    border: '1px dashed var(--jp-border-hot)',
    borderRadius: 999,
    cursor: 'pointer',
  },
  createRow: {
    display: 'flex', gap: 6, alignItems: 'center',
    marginTop: 4,
  },
  // v1.1.0.72 — vertical create form with name input on top,
  // colour swatches in the middle, action buttons at the bottom.
  // Replaces the single-row layout when colour picking is enabled
  // (always — we always render the swatch row on create now).
  createBox: {
    display: 'flex', flexDirection: 'column', gap: 8,
    marginTop: 4,
  },
  swatchRow: {
    display: 'flex', flexWrap: 'wrap', gap: 4,
  },
  swatch: {
    width: 22, height: 22, borderRadius: '50%',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    cursor: 'pointer',
    padding: 0,
  },
  swatchNoneText: {
    fontSize: 12, color: 'var(--jp-text-3)',
    lineHeight: 1, fontWeight: 400,
  },
  createBtnRow: {
    display: 'flex', gap: 6,
  },
  input: {
    flex: 1, minWidth: 0,
    background: 'var(--jp-bg-elevated)',
    color: 'var(--jp-text)',
    border: '1px solid var(--jp-border)',
    borderRadius: 6,
    padding: '7px 10px',
    fontSize: 14,
    outline: 'none',
  },
  createBtn: {
    padding: '7px 12px',
    fontSize: 13, fontWeight: 600,
    background: 'var(--jp-accent)',
    color: 'var(--jp-bg)',
    border: 'none',
    borderRadius: 999,
    cursor: 'pointer',
    flexShrink: 0,
  },
  cancelBtn: {
    padding: '7px 10px',
    fontSize: 13, fontWeight: 500,
    background: 'transparent',
    color: 'var(--jp-text-2)',
    border: 'none',
    cursor: 'pointer',
    flexShrink: 0,
  },
  doneBtn: {
    display: 'block', width: '100%',
    marginTop: 12,
    padding: '11px 0',
    background: 'transparent',
    border: '1px solid var(--jp-border-hot)',
    borderRadius: 999,
    color: 'var(--jp-text)',
    fontSize: 14, fontWeight: 600,
    cursor: 'pointer',
  },
  error: {
    marginTop: 8,
    padding: '6px 10px',
    fontSize: 13,
    color: '#ff8989',
    background: 'rgba(255,59,92,0.08)',
    border: '1px solid rgba(255,59,92,0.30)',
    borderRadius: 6,
  },
}
