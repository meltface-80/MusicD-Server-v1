// v1.1.0.72 — Tag management for Settings → Tags. Lists every user
// tag with its album/track usage counts. Each row offers rename,
// recolour, and delete. Also includes an inline create form so the
// user can seed tags without first having to open the TagPicker
// from an album / track sheet.
//
// The chip-strip filter on the Albums screen (v71) stays the read
// surface; this is the *write* surface. The TagPicker on overflow
// sheets remains the most common create path because it's where
// users reach when they're already thinking about applying a tag.
//
// Design notes:
//   - Colour picker is a row of preset swatches. Custom hex entry is
//     deliberately not exposed in the UI; the API supports it but
//     end-users rarely need anything outside a curated palette and a
//     freeform input introduces accessibility/contrast risks against
//     the JPLAY dark surfaces. The "no colour" state stays as a
//     monochrome chip — that's the default.
//   - Delete asks for confirmation only when the tag is in use.
//     Empty tags are deleted on a single tap with no nag.
//   - Errors are inlined per-row rather than as a global toast so the
//     user sees which tag failed without losing context.

import React, { useEffect, useState, useRef } from 'react'
import { api } from '../api'
import { Plus, Trash2, Edit2, Check, X, Tag as TagIcon } from 'lucide-react'

// Curated palette. Picked for legibility against #0a0a0c through
// #1a1a22 (the JPLAY surface scale) — every swatch hits at least
// 4.5:1 contrast against the elevated bg when used at 18% alpha
// fill + full-strength border in the active chip treatment.
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

export default function TagManagementSection() {
  const [tags, setTags] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [editingId, setEditingId] = useState(null)
  const [newTagName, setNewTagName] = useState('')
  const [newTagColor, setNewTagColor] = useState(null)
  const [creating, setCreating] = useState(false)
  const [showCreate, setShowCreate] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const fresh = await api.get('/tags')
      setTags(fresh || [])
      setError(null)
    } catch (e) {
      setError(e.message || 'Failed to load tags')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const handleCreate = async () => {
    const name = newTagName.trim()
    if (!name) return
    setCreating(true)
    try {
      await api.post('/tags', { name, color: newTagColor })
      setNewTagName('')
      setNewTagColor(null)
      setShowCreate(false)
      await load()
    } catch (e) {
      // 409 = already exists. We don't have access to the response
      // body here via api.post's error path; just surface the
      // message and let the user disambiguate.
      setError(e.message || 'Failed to create tag')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div>
      <div style={s.help}>
        Tags are user-defined labels you can attach to albums and tracks. Apply them via the ⋯ menu on any album or track. Filter the Albums screen by tag using the chip strip below the sort pills.
      </div>

      {loading ? (
        <div style={s.loading}>Loading…</div>
      ) : error ? (
        <div style={s.error}>{error}</div>
      ) : (
        <>
          {tags.length === 0 ? (
            <div style={s.empty}>
              No tags yet. Create your first one below.
            </div>
          ) : (
            <div style={s.list}>
              {tags.map(tag => (
                <TagRow
                  key={tag.id}
                  tag={tag}
                  isEditing={editingId === tag.id}
                  onEdit={() => setEditingId(tag.id)}
                  onCancelEdit={() => setEditingId(null)}
                  onSaved={async () => { setEditingId(null); await load() }}
                  onDeleted={async () => { setEditingId(null); await load() }}
                />
              ))}
            </div>
          )}

          {showCreate ? (
            <div style={s.createBox}>
              <input
                type="text"
                value={newTagName}
                onChange={e => setNewTagName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleCreate()
                  if (e.key === 'Escape') { setShowCreate(false); setNewTagName(''); setNewTagColor(null) }
                }}
                placeholder="Tag name"
                maxLength={60}
                autoFocus
                style={s.input}
                disabled={creating}
              />
              <div style={s.swatchRow}>
                {PRESET_COLORS.map(c => (
                  <button
                    key={c.name}
                    onClick={() => setNewTagColor(c.hex)}
                    style={{
                      ...s.swatch,
                      background: c.hex || 'transparent',
                      border: `1.5px solid ${newTagColor === c.hex ? 'var(--text-primary)' : 'var(--border)'}`,
                    }}
                    title={c.name}
                    aria-label={c.name}
                  >
                    {c.hex === null && <span style={s.swatchNoneText}>—</span>}
                    {newTagColor === c.hex && c.hex && <Check size={11} color="#fff" />}
                  </button>
                ))}
              </div>
              <div style={s.createBtnRow}>
                <button
                  style={s.createPrimary}
                  onClick={handleCreate}
                  disabled={creating || !newTagName.trim()}
                >
                  {creating ? 'Creating…' : 'Create tag'}
                </button>
                <button
                  style={s.createCancel}
                  onClick={() => { setShowCreate(false); setNewTagName(''); setNewTagColor(null) }}
                  disabled={creating}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button style={s.addBtn} onClick={() => setShowCreate(true)}>
              <Plus size={13} /> New tag
            </button>
          )}
        </>
      )}
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────────
// One tag row — display mode + edit mode in the same component so the
// row keeps its size when transitioning, avoiding a layout jump.

function TagRow({ tag, isEditing, onEdit, onCancelEdit, onSaved, onDeleted }) {
  const [name, setName] = useState(tag.name)
  const [color, setColor] = useState(tag.color)
  const [busy, setBusy] = useState(false)
  const [rowError, setRowError] = useState(null)
  const inputRef = useRef(null)

  // Whenever we enter edit mode, seed the local state from the latest
  // tag prop. Without this an external rename (e.g. tag created
  // elsewhere with the same id?) wouldn't show up.
  useEffect(() => {
    if (isEditing) {
      setName(tag.name)
      setColor(tag.color)
      setRowError(null)
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [isEditing, tag.name, tag.color])

  const totalUses = (tag.album_count || 0) + (tag.track_count || 0)

  const handleSave = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    setBusy(true)
    try {
      await api.patch(`/tags/${tag.id}`, { name: trimmed, color })
      onSaved()
    } catch (e) {
      setRowError(e.message || 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async () => {
    // Confirm only when the tag is in use somewhere — empty tags are
    // a single-tap cleanup operation.
    if (totalUses > 0) {
      const ok = confirm(`Delete "${tag.name}"? It's currently applied to ${tag.album_count || 0} album${tag.album_count === 1 ? '' : 's'} and ${tag.track_count || 0} track${tag.track_count === 1 ? '' : 's'}. The tag will be removed from all of them.`)
      if (!ok) return
    }
    setBusy(true)
    try {
      await api.del(`/tags/${tag.id}`)
      onDeleted()
    } catch (e) {
      setRowError(e.message || 'Delete failed')
      setBusy(false)
    }
  }

  if (isEditing) {
    return (
      <div style={s.row}>
        <div style={s.editCol}>
          <input
            ref={inputRef}
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') handleSave()
              if (e.key === 'Escape') onCancelEdit()
            }}
            maxLength={60}
            style={s.input}
            disabled={busy}
          />
          <div style={s.swatchRow}>
            {PRESET_COLORS.map(c => (
              <button
                key={c.name}
                onClick={() => setColor(c.hex)}
                style={{
                  ...s.swatch,
                  background: c.hex || 'transparent',
                  border: `1.5px solid ${color === c.hex ? 'var(--text-primary)' : 'var(--border)'}`,
                }}
                title={c.name}
                aria-label={c.name}
              >
                {c.hex === null && <span style={s.swatchNoneText}>—</span>}
                {color === c.hex && c.hex && <Check size={11} color="#fff" />}
              </button>
            ))}
          </div>
          {rowError && <div style={s.error}>{rowError}</div>}
        </div>
        <div style={s.editActions}>
          <button style={s.iconOk} onClick={handleSave} disabled={busy || !name.trim()} title="Save">
            <Check size={15} />
          </button>
          <button style={s.iconCancel} onClick={onCancelEdit} disabled={busy} title="Cancel">
            <X size={15} />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div style={s.row}>
      <div style={s.colDot}>
        <span style={{ ...s.colorDot, background: tag.color || 'var(--border-bright, rgba(var(--tint-rgb), 0.18))' }} />
      </div>
      <div style={s.colName}>
        <div style={s.tagName}>{tag.name}</div>
        <div style={s.tagSub}>
          {(tag.album_count || 0)} album{tag.album_count === 1 ? '' : 's'} · {(tag.track_count || 0)} track{tag.track_count === 1 ? '' : 's'}
        </div>
      </div>
      <div style={s.editActions}>
        <button style={s.iconBtn} onClick={onEdit} disabled={busy} title="Edit">
          <Edit2 size={14} />
        </button>
        <button style={{ ...s.iconBtn, ...s.iconDanger }} onClick={handleDelete} disabled={busy} title="Delete">
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  )
}

const s = {
  help: { fontSize: 13, color: 'var(--text-tertiary)', padding: '4px 0 12px', lineHeight: 1.5 },
  loading: { fontSize: 13, color: 'var(--text-tertiary)', padding: '12px 0' },
  empty: { fontSize: 14, color: 'var(--text-secondary)', padding: '12px 0', lineHeight: 1.5 },
  error: {
    marginTop: 8,
    padding: '6px 10px',
    fontSize: 13,
    color: '#ff8989',
    background: 'rgba(255,59,92,0.08)',
    border: '1px solid rgba(255,59,92,0.30)',
    borderRadius: 6,
  },
  list: {
    display: 'flex', flexDirection: 'column',
    gap: 4,
    marginBottom: 12,
  },
  row: {
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '10px 8px',
    borderRadius: 6,
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border)',
  },
  colDot: { flexShrink: 0 },
  colorDot: {
    display: 'block', width: 14, height: 14, borderRadius: '50%',
    border: '1px solid rgba(var(--tint-rgb), 0.10)',
  },
  colName: { flex: 1, minWidth: 0 },
  tagName: { fontSize: 15, fontWeight: 500, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  tagSub: { fontSize: 12, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', marginTop: 1 },
  editCol: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 },
  editActions: { display: 'flex', gap: 4, flexShrink: 0 },
  iconBtn: {
    width: 30, height: 30, borderRadius: 6,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'transparent',
    color: 'var(--text-secondary)',
    border: '1px solid var(--border)',
    cursor: 'pointer',
  },
  iconDanger: { color: '#f47174' },
  iconOk: {
    width: 30, height: 30, borderRadius: 6,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--accent, #7c3aed)',
    color: 'var(--on-accent)',
    border: 'none',
    cursor: 'pointer',
  },
  iconCancel: {
    width: 30, height: 30, borderRadius: 6,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'transparent',
    color: 'var(--text-secondary)',
    border: '1px solid var(--border)',
    cursor: 'pointer',
  },
  input: {
    width: '100%',
    background: 'var(--bg-surface)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '7px 10px',
    fontSize: 14,
    outline: 'none',
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
    fontSize: 12, color: 'var(--text-tertiary)',
    lineHeight: 1, fontWeight: 400,
  },
  addBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    padding: '7px 12px',
    fontSize: 13, fontWeight: 500,
    background: 'transparent',
    color: 'var(--text-secondary)',
    border: '1px dashed var(--border-bright, rgba(var(--tint-rgb), 0.16))',
    borderRadius: 999,
    cursor: 'pointer',
  },
  createBox: {
    padding: 10,
    borderRadius: 6,
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border)',
    display: 'flex', flexDirection: 'column', gap: 8,
    marginTop: 4,
  },
  createBtnRow: {
    display: 'flex', gap: 6,
  },
  createPrimary: {
    padding: '8px 14px',
    fontSize: 13, fontWeight: 600,
    background: 'var(--accent, #7c3aed)',
    color: 'var(--on-accent)',
    border: 'none',
    borderRadius: 999,
    cursor: 'pointer',
  },
  createCancel: {
    padding: '8px 12px',
    fontSize: 13, fontWeight: 500,
    background: 'transparent',
    color: 'var(--text-secondary)',
    border: '1px solid var(--border)',
    borderRadius: 999,
    cursor: 'pointer',
  },
}
