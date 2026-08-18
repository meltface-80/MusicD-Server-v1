// v1.1.0.82 — Focus Library screen.
//
// Lists the user's saved focus combinations. Tap one to navigate to
// the Albums view with that focus pre-applied. Long-tap the trash
// icon (or just tap any card) to enter selection mode for bulk
// delete.
//
// Layout matches the rest of the app's listing screens:
//   - Sticky header with title + trash icon (plus 'Done' when in
//     selection mode)
//   - Card grid below, scrolls vertically
//
// Selection mode UX (per user spec):
//   - Tap a card → opens a tickbox on every card
//   - Tick the cards you want gone
//   - Trash icon turns red when at least one card is selected
//   - Tap red trash → centred confirmation modal "Are you sure you
//     want to remove selected items" Yes/No
//   - Yes → DELETE /api/library/focus/saved with the id list
//   - No → close modal, selection mode persists
//   - Tap Done in the header → exit selection mode, no deletion
//
// Cards show the saved focus name plus a one-line summary of its
// picks (e.g. "Genre: Jazz · 24-bit · 1970s") so the user can tell
// "Late Night Jazz" from "Sunday Morning Jazz" at a glance.

import { useEffect, useState, useCallback, useMemo } from 'react'
import { Trash2, SlidersHorizontal, Pencil } from 'lucide-react'
import { api } from '../api'
import { useStore } from '../store'
import { FOCUS_SECTIONS, FocusModal } from './Focus'

export default function FocusLibraryScreen() {
  const setSidebarSection = useStore(s => s.setSidebarSection)
  const setPendingFocusToLoad = useStore(s => s.setPendingFocusToLoad)

  const [rows, setRows] = useState(null) // null = loading
  const [error, setError] = useState(null)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selected, setSelected] = useState(() => new Set())
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  // v1.1.0.83 — rename modal. null = closed; otherwise an object
  // { id, name (current edit value), originalName, busy, error }.
  const [renameModal, setRenameModal] = useState(null)

  const handleStartRename = useCallback((row) => {
    setRenameModal({
      id: row.id,
      name: row.name,
      originalName: row.name,
      busy: false,
      error: null,
    })
  }, [])

  const handleConfirmRename = useCallback(async () => {
    if (!renameModal) return
    const trimmed = renameModal.name.trim()
    if (!trimmed) {
      setRenameModal(prev => prev ? { ...prev, error: 'Name required' } : prev)
      return
    }
    if (trimmed === renameModal.originalName) {
      // No-op: user opened the modal but didn't actually change the
      // name. Just close.
      setRenameModal(null)
      return
    }
    setRenameModal(prev => prev ? { ...prev, busy: true, error: null } : prev)
    try {
      const r = await api.put(`/library/focus/saved/${renameModal.id}`, { name: trimmed })
      // Update the local list optimistically using the server's
      // returned row (so created_at / updated_at are correct).
      setRows(prev => (prev || []).map(x => x.id === renameModal.id ? r.row : x).sort((a, b) => a.name.localeCompare(b.name)))
      setRenameModal(null)
    } catch (e) {
      const msg = e?.message || 'Rename failed'
      setRenameModal(prev => prev ? { ...prev, busy: false, error: msg } : prev)
    }
  }, [renameModal])

  const reload = useCallback(async () => {
    try {
      const data = await api.get('/library/focus/saved')
      setRows(data?.rows || [])
    } catch (e) {
      setError(e?.message || 'Failed to load saved focuses')
      setRows([])
    }
  }, [])

  useEffect(() => { reload() }, [reload])

  const exitSelection = useCallback(() => {
    setSelectionMode(false)
    setSelected(new Set())
  }, [])

  const toggleCard = useCallback((row) => {
    if (selectionMode) {
      // In selection mode, tap toggles tickbox.
      setSelected(prev => {
        const next = new Set(prev)
        if (next.has(row.id)) next.delete(row.id); else next.add(row.id)
        return next
      })
    } else {
      // Otherwise, tap loads the focus and routes to Albums.
      setPendingFocusToLoad(row)
      setSidebarSection('albums')
    }
  }, [selectionMode, setPendingFocusToLoad, setSidebarSection])

  const handleTrash = useCallback(() => {
    if (!selectionMode) {
      // First tap on trash icon → enter selection mode but don't
      // pre-select anything. Per spec: "Tap on a save focus save
      // and it opens a tick box." So selection mode opens via card
      // tap OR trash tap; trash with nothing selected just enables
      // the mode.
      setSelectionMode(true)
      return
    }
    if (selected.size === 0) {
      // In selection mode but nothing ticked → trash exits selection.
      exitSelection()
      return
    }
    // Selected items present → confirm.
    setConfirmDelete(true)
  }, [selectionMode, selected, exitSelection])

  const handleConfirmDelete = useCallback(async () => {
    if (selected.size === 0) {
      setConfirmDelete(false)
      return
    }
    setDeleting(true)
    try {
      // v1.1.0.92 — was `api.delete(...)` which doesn't exist; the
      // api object exports `del`, not `delete`. Same bug as the
      // Reset Order button on the Focus bar (see AlbumGrid.jsx).
      await api.del('/library/focus/saved', { ids: [...selected] })
      // Optimistic local update
      setRows(prev => (prev || []).filter(r => !selected.has(r.id)))
      exitSelection()
      setConfirmDelete(false)
    } catch (e) {
      setError(e?.message || 'Delete failed')
      setConfirmDelete(false)
    } finally {
      setDeleting(false)
    }
  }, [selected, exitSelection])

  const trashIsActive = selected.size > 0

  return (
    <div style={S.page}>
      <div style={S.header}>
        <div style={S.titleRow}>
          <h1 style={S.heading}>Focus library</h1>
          <div style={S.headerActions}>
            {selectionMode && (
              <button onClick={exitSelection} style={S.doneBtn}>Done</button>
            )}
            <button
              onClick={handleTrash}
              style={{
                ...S.trashBtn,
                ...(trashIsActive ? S.trashBtnActive : {}),
              }}
              title={selectionMode
                ? (selected.size > 0 ? `Delete ${selected.size}` : 'Cancel')
                : 'Select to delete'}
              aria-label="Delete saved focuses"
            >
              <Trash2 size={16} />
            </button>
          </div>
        </div>
        {rows && rows.length > 0 && (
          <div style={S.statsRow}>
            {rows.length} saved focus{rows.length === 1 ? '' : 'es'}
            {selectionMode && selected.size > 0 && ` · ${selected.size} selected`}
          </div>
        )}
      </div>

      {rows === null ? (
        <div style={S.loadWrap}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={S.emptyMsg}>
          <SlidersHorizontal size={32} style={{ opacity: 0.3, marginBottom: 12 }} />
          <div>No saved focuses yet.</div>
          <div style={S.emptyHint}>
            Open the Focus bar from the Albums screen, pick filters, then tap “Save as new”.
          </div>
        </div>
      ) : (
        <div style={S.grid}>
          {rows.map(row => (
            <FocusCard
              key={row.id}
              row={row}
              selectionMode={selectionMode}
              selected={selected.has(row.id)}
              onClick={() => toggleCard(row)}
              onRename={handleStartRename}
            />
          ))}
        </div>
      )}

      {/* v1.1.0.83 — rename modal */}
      <FocusModal
        open={!!renameModal}
        onCancel={() => !renameModal?.busy && setRenameModal(null)}
        title="Rename focus"
      >
        {renameModal && (
          <div>
            <input
              type="text"
              autoFocus
              value={renameModal.name}
              onChange={e => setRenameModal(prev => prev ? { ...prev, name: e.target.value, error: null } : prev)}
              onKeyDown={e => { if (e.key === 'Enter' && !renameModal.busy) handleConfirmRename() }}
              placeholder="Name"
              maxLength={60}
              disabled={renameModal.busy}
              style={{
                width: '100%', boxSizing: 'border-box',
                padding: 10,
                fontSize: 13,
                background: 'var(--jp-bg-surface)',
                border: '1px solid var(--jp-border)',
                borderRadius: 6,
                color: 'var(--jp-text)',
                marginBottom: 6,
              }}
            />
            {renameModal.error && (
              <div style={{ fontSize: 11, color: '#ff8a9a', marginBottom: 6 }}>
                {renameModal.error}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 }}>
              <button
                onClick={() => setRenameModal(null)}
                disabled={renameModal.busy}
                style={S.modalBtnGhost}
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmRename}
                disabled={renameModal.busy || !renameModal.name.trim()}
                style={{
                  padding: '7px 14px',
                  background: 'var(--jp-accent)',
                  border: 'none', borderRadius: 6,
                  color: '#0a0a0c', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  opacity: (renameModal.busy || !renameModal.name.trim()) ? 0.5 : 1,
                }}
              >
                {renameModal.busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        )}
      </FocusModal>

      <FocusModal
        open={confirmDelete}
        onCancel={() => !deleting && setConfirmDelete(false)}
        title="Delete saved focuses"
      >
        <div>
          <div style={{ marginBottom: 12 }}>
            Are you sure you want to remove {selected.size} selected item{selected.size === 1 ? '' : 's'}?
          </div>
          <div style={{ fontSize: 11, color: 'var(--jp-text-3)', marginBottom: 12 }}>
            This only removes the saved focus. Your music files are not touched.
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button
              onClick={() => setConfirmDelete(false)}
              disabled={deleting}
              style={S.modalBtnGhost}
            >
              No
            </button>
            <button
              onClick={handleConfirmDelete}
              disabled={deleting}
              style={S.modalBtnDanger}
            >
              {deleting ? 'Deleting…' : 'Yes'}
            </button>
          </div>
        </div>
      </FocusModal>

      {error && (
        <div style={S.errorBar}>{error}</div>
      )}
    </div>
  )
}

// ── Card ─────────────────────────────────────────────────────────────
//
// v1.1.0.83 — adds a pencil button for renaming. The pencil is hidden
// in selection mode (the tickbox sits in the same corner there) and
// when nothing is selected so the card stays clean. Click on the
// pencil opens the rename modal in the parent screen via onRename.
function FocusCard({ row, selectionMode, selected, onClick, onRename }) {
  const summary = useMemo(() => summarisePicks(row.picks), [row.picks])
  const handlePencilClick = (e) => {
    // Don't let the pencil click bubble to the card's main click
    // handler — that would be confusing (rename AND load focus).
    e.stopPropagation()
    if (onRename) onRename(row)
  }
  return (
    <div
      onClick={onClick}
      style={{
        ...S.card,
        ...(selected ? S.cardSelected : {}),
        cursor: 'pointer',
      }}
      role="button"
      tabIndex={0}
    >
      {selectionMode ? (
        <div style={{ ...S.tickbox, ...(selected ? S.tickboxOn : {}) }}>
          {selected ? '✓' : ''}
        </div>
      ) : (
        // Pencil button — only when not in selection mode. Renders as
        // a plain icon button in the card's top-right.
        onRename && (
          <button
            onClick={handlePencilClick}
            style={S.pencilBtn}
            title="Rename"
            aria-label="Rename"
          >
            <Pencil size={12} />
          </button>
        )
      )}
      <div style={S.cardName}>{row.name}</div>
      <div style={S.cardSummary}>{summary || 'No picks'}</div>
    </div>
  )
}

// summarisePicks — short text summary of a picks blob. Best-effort,
// truncated; the canonical "what's in this focus" is the picks
// themselves, recoverable by tapping the card.
function summarisePicks(picks) {
  if (!picks) return ''
  const parts = []
  for (const section of FOCUS_SECTIONS) {
    const sec = picks[section.key]
    if (!sec) continue
    const inc = sec.include || []
    const exc = sec.exclude || []
    if (inc.length === 0 && exc.length === 0) continue
    const labels = []
    for (const v of inc) labels.push(formatVal(section.key, v))
    for (const v of exc) labels.push('-' + formatVal(section.key, v))
    if (labels.length > 0) parts.push(labels.join(', '))
  }
  const joined = parts.join(' · ')
  return joined.length > 80 ? joined.slice(0, 78) + '…' : joined
}

function formatVal(sectionKey, v) {
  if (sectionKey === 'decade') return `${v}s`
  if (sectionKey === 'format') return String(v).toUpperCase()
  if (sectionKey === 'bitDepth') return `${v}-bit`
  if (sectionKey === 'sampleRate') {
    const k = v / 1000
    return Math.abs(k - Math.round(k)) < 0.05 ? `${Math.round(k)}kHz` : `${k.toFixed(1)}kHz`
  }
  if (sectionKey === 'channelLayout') {
    if (v === 1) return 'Mono'
    if (v === 2) return 'Stereo'
    if (v === 6) return '5.1'
    if (v === 8) return '7.1'
    return `${v}ch`
  }
  if (sectionKey === 'lastPlayed' || sectionKey === 'addedOn') return v
  return v
}


const S = {
  page: { padding: '0 16px', background: 'var(--jp-bg)', minHeight: '100%' },
  header: {
    position: 'sticky', top: 0, zIndex: 10,
    paddingTop: 12, paddingBottom: 8,
    marginLeft: -16, marginRight: -16,
    paddingLeft: 16, paddingRight: 16,
    background: 'var(--jp-bg)',
    borderBottom: '1px solid var(--jp-border)',
  },
  titleRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  heading: { fontSize: 24, fontWeight: 600, letterSpacing: '-0.3px', color: 'var(--jp-text)' },
  headerActions: { display: 'flex', gap: 8, alignItems: 'center' },
  doneBtn: {
    padding: '5px 12px',
    background: 'transparent',
    border: '1px solid var(--jp-border)',
    borderRadius: 6,
    color: 'var(--jp-text-2)',
    fontSize: 12,
    cursor: 'pointer',
  },
  trashBtn: {
    width: 32, height: 32,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    padding: 0,
    background: 'transparent',
    border: '1px solid var(--jp-border)',
    borderRadius: 16,
    color: 'var(--jp-text-2)',
    cursor: 'pointer',
  },
  trashBtnActive: {
    background: 'rgba(255,59,92,0.18)',
    borderColor: 'rgba(255,59,92,0.36)',
    color: '#ff8a9a',
  },
  statsRow: { fontSize: 11, color: 'var(--jp-text-3)', fontFamily: 'var(--font-mono)' },
  loadWrap: { padding: 60, textAlign: 'center', color: 'var(--jp-text-3)' },
  emptyMsg: {
    padding: '60px 24px', textAlign: 'center',
    color: 'var(--jp-text-2)', fontSize: 14,
    display: 'flex', flexDirection: 'column', alignItems: 'center',
  },
  emptyHint: {
    fontSize: 12, color: 'var(--jp-text-3)',
    marginTop: 8, maxWidth: 320,
  },
  grid: {
    paddingTop: 12, paddingBottom: 120,
    display: 'grid',
    gap: 10,
    gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
  },
  card: {
    position: 'relative',
    display: 'block',
    width: '100%',
    padding: '14px 16px',
    background: 'var(--jp-bg-elevated)',
    border: '1px solid var(--jp-border)',
    borderRadius: 10,
    color: 'var(--jp-text)',
    textAlign: 'left',
    cursor: 'pointer',
    transition: 'border-color 120ms',
  },
  cardSelected: {
    borderColor: 'var(--jp-accent)',
    background: 'var(--jp-bg-surface)',
  },
  tickbox: {
    position: 'absolute',
    top: 8, right: 8,
    width: 18, height: 18,
    borderRadius: 4,
    border: '1px solid var(--jp-border)',
    background: 'var(--jp-bg)',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 11, fontWeight: 600,
    color: 'transparent',
  },
  tickboxOn: {
    background: 'var(--jp-accent)',
    borderColor: 'var(--jp-accent)',
    color: '#0a0a0c',
  },
  // v1.1.0.83 — pencil button for rename. Same corner as the
  // tickbox (only one of the two ever renders at once: tickbox in
  // selection mode, pencil otherwise). Kept low-contrast so it
  // doesn't compete with the card title.
  pencilBtn: {
    position: 'absolute',
    top: 8, right: 8,
    width: 22, height: 22,
    padding: 0,
    background: 'transparent',
    border: '1px solid var(--jp-border)',
    borderRadius: 4,
    color: 'var(--jp-text-3)',
    cursor: 'pointer',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  },
  cardName: {
    fontSize: 14, fontWeight: 600,
    color: 'var(--jp-text)',
    marginBottom: 4,
    paddingRight: 24,  // room for tickbox
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  cardSummary: {
    fontSize: 11,
    color: 'var(--jp-text-3)',
    lineHeight: 1.4,
    overflow: 'hidden', display: '-webkit-box',
    WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
  },
  errorBar: {
    position: 'fixed', bottom: 80, left: '50%', transform: 'translateX(-50%)',
    padding: '8px 14px',
    background: 'rgba(255,59,92,0.18)',
    border: '1px solid rgba(255,59,92,0.36)',
    borderRadius: 6,
    color: '#ff8a9a', fontSize: 12,
    zIndex: 100,
  },
  modalBtnGhost: {
    padding: '7px 14px',
    background: 'transparent',
    border: '1px solid var(--jp-border)', borderRadius: 6,
    color: 'var(--jp-text-2)', fontSize: 12, cursor: 'pointer',
  },
  modalBtnDanger: {
    padding: '7px 14px',
    background: '#ff3b5c',
    border: 'none', borderRadius: 6,
    color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer',
  },
}
