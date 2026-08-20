import React, { useEffect, useState, useRef } from 'react'
import { api } from '../api'
import { Save, Plus, Settings as SettingsIcon, Power, AlertTriangle, X, Check } from 'lucide-react'

// Profile bar (#29.3)
// =====================
// Top-of-DspTab control: select between this renderer's saved profiles,
// save changes, create new ones, manage (rename/delete), bypass entire DSP.
//
// Active profile lifecycle:
//   • user picks "Late Night" from dropdown → server applies (live state ←
//     payload), reloads editor below
//   • user edits a slider, hits "Save PEQ" inside the editor → live state
//     updated, but the SAVED profile is now stale
//   • user hits "Save" here → live state copied back into the active profile
//     (commits edits to the named slot)
//   • user hits "Save as…" → new named profile from live state
//
// We don't auto-overwrite on every editor save because that conflates "I
// want to hear this on next track" (live state) with "I want this to be the
// permanent meaning of profile X" (saved snapshot). Editor saves are cheap;
// profile saves are deliberate.
export default function ProfileBar({ rendererId, onProfilesChanged, onProfileApplied, masterEnabled, onMasterToggle }) {
  const [profileList, setProfileList] = useState([])
  const [activeId, setActiveId] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saveAsName, setSaveAsName] = useState(null)  // null = not in save-as mode; string = current input
  const [error, setError] = useState(null)
  const [showManage, setShowManage] = useState(false)

  const loadProfiles = async () => {
    if (!rendererId) { setProfileList([]); setActiveId(null); return }
    try {
      const r = await api.get(`/dsp/profiles/${encodeURIComponent(rendererId)}`)
      const list = r.profiles || []
      setProfileList(list)
      const active = list.find(p => p.is_active)
      setActiveId(active ? active.id : (list[0]?.id || null))
    } catch (e) {
      setProfileList([])
      setActiveId(null)
    }
  }

  useEffect(() => { loadProfiles() }, [rendererId])

  const applyProfile = async (id) => {
    if (!id || id === activeId) { setActiveId(id); return }
    try {
      await api.put(`/dsp/profile/${id}/apply`)
      setActiveId(id)
      await loadProfiles()
      onProfileApplied?.()
    } catch (e) {
      setError(e.message || 'Apply failed')
    }
  }

  const saveActive = async () => {
    if (!activeId) return
    setSaving(true); setError(null)
    try {
      await api.put(`/dsp/profile/${activeId}/save`)
      await loadProfiles()
    } catch (e) {
      setError(e.message || 'Save failed')
    } finally { setSaving(false) }
  }

  const submitSaveAs = async () => {
    const name = (saveAsName || '').trim()
    if (!name) { setSaveAsName(null); return }
    setSaving(true); setError(null)
    try {
      const r = await api.post(`/dsp/profiles/${encodeURIComponent(rendererId)}`, { name })
      setSaveAsName(null)
      await loadProfiles()
      // Switch dropdown to the new profile (server already marked it active)
      if (r?.id) setActiveId(r.id)
      onProfilesChanged?.()
    } catch (e) {
      setError(e.message || 'Create failed')
    } finally { setSaving(false) }
  }

  return (
    <div style={s.bar}>
      <div style={s.row1}>
        <span style={s.barLabel}>Profile</span>

        {saveAsName != null ? (
          // Inline name input for "Save as…" — Enter or check button submits;
          // Esc or X cancels. Auto-focused so the user can start typing
          // immediately.
          <SaveAsInput
            value={saveAsName}
            onChange={setSaveAsName}
            onSubmit={submitSaveAs}
            onCancel={() => { setSaveAsName(null); setError(null) }}
            disabled={saving}
          />
        ) : (
          <select
            style={s.select}
            value={activeId || ''}
            onChange={e => applyProfile(parseInt(e.target.value, 10))}
            disabled={saving || profileList.length === 0}
          >
            {profileList.length === 0 ? (
              <option value="">— no profiles —</option>
            ) : profileList.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        )}

        <label style={s.bypassLabel} title="Bypass all DSP processing without changing the saved profile">
          <input
            type="checkbox"
            checked={!masterEnabled}
            onChange={e => onMasterToggle?.(!e.target.checked)}
            style={s.checkbox}
          />
          <Power size={11} />
          <span>Bypass</span>
        </label>
      </div>

      {saveAsName == null && (
        <div style={s.row2}>
          <button
            type="button"
            style={s.btn}
            onClick={saveActive}
            disabled={saving || !activeId}
            title="Overwrite the selected profile with the current settings"
          >
            <Save size={11} />
            Save
          </button>
          <button
            type="button"
            style={s.btn}
            onClick={() => setSaveAsName('')}
            disabled={saving || !rendererId}
            title="Create a new profile from the current settings"
          >
            <Plus size={11} />
            Save as…
          </button>
          <button
            type="button"
            style={s.btn}
            onClick={() => setShowManage(true)}
            disabled={!rendererId || profileList.length === 0}
            title="Rename or delete saved profiles"
          >
            <SettingsIcon size={11} />
            Manage…
          </button>
        </div>
      )}

      {error && (
        <div style={s.error}>
          <AlertTriangle size={11} />
          <span>{error}</span>
          <button onClick={() => setError(null)} style={s.errorX}>×</button>
        </div>
      )}

      {showManage && (
        <ManageModal
          rendererId={rendererId}
          profiles={profileList}
          onClose={() => setShowManage(false)}
          onChanged={() => { loadProfiles(); onProfilesChanged?.() }}
        />
      )}
    </div>
  )
}

function SaveAsInput({ value, onChange, onSubmit, onCancel, disabled }) {
  const ref = useRef(null)
  useEffect(() => { ref.current?.focus() }, [])
  return (
    <div style={s.saveAsRow}>
      <input
        ref={ref}
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') onSubmit()
          if (e.key === 'Escape') onCancel()
        }}
        placeholder="Profile name"
        maxLength={80}
        disabled={disabled}
        style={s.saveAsInput}
      />
      <button onClick={onSubmit} disabled={disabled || !value.trim()} style={s.saveAsBtn} title="Create"><Check size={12} /></button>
      <button onClick={onCancel} disabled={disabled} style={s.saveAsBtnGhost} title="Cancel"><X size={12} /></button>
    </div>
  )
}

// Manage modal: lists all profiles for this renderer with checkboxes.
// Each row supports inline rename (click name → input). Multi-select
// + delete with a custom inline "are you sure" confirm bar at the top.
function ManageModal({ rendererId, profiles, onClose, onChanged }) {
  const [selected, setSelected] = useState(new Set())
  const [renamingId, setRenamingId] = useState(null)
  const [renameValue, setRenameValue] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const toggle = (id) => {
    setSelected(prev => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id); else n.add(id)
      return n
    })
  }

  const startRename = (p) => {
    setRenamingId(p.id)
    setRenameValue(p.name)
  }
  const submitRename = async () => {
    const name = renameValue.trim()
    if (!name) { setRenamingId(null); return }
    setBusy(true); setError(null)
    try {
      await api.put(`/dsp/profile/${renamingId}/rename`, { name })
      setRenamingId(null)
      onChanged?.()
    } catch (e) {
      setError(e.message || 'Rename failed')
    } finally { setBusy(false) }
  }

  const confirmDelete = async () => {
    if (selected.size === 0) return
    setBusy(true); setError(null)
    try {
      await fetch('/api/dsp/profiles', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: Array.from(selected) }),
      }).then(async r => {
        const data = await r.json()
        if (!r.ok) throw new Error(data?.error || 'Delete failed')
        return data
      })
      setSelected(new Set())
      setConfirming(false)
      onChanged?.()
    } catch (e) {
      setError(e.message || 'Delete failed')
    } finally { setBusy(false) }
  }

  return (
    <div style={s.modalBackdrop} onClick={onClose}>
      <div style={s.modal} onClick={e => e.stopPropagation()}>
        <div style={s.modalHeader}>
          <span>Manage profiles</span>
          <button onClick={onClose} style={s.modalClose}><X size={14} /></button>
        </div>

        {confirming ? (
          // Inline confirmation toast — replaces the action bar with a
          // dedicated "are you sure?" until the user commits or cancels.
          // We deliberately don't use window.confirm() because it doesn't
          // theme with the rest of the app and on iOS Safari the modal
          // styling is jarring.
          <div style={s.confirmBar}>
            <AlertTriangle size={13} style={{ color: '#f5c450' }} />
            <span style={s.confirmText}>
              Delete {selected.size} profile{selected.size === 1 ? '' : 's'}?
              This can't be undone.
            </span>
            <button onClick={confirmDelete} disabled={busy} style={s.confirmBtn}>
              {busy ? 'Deleting…' : 'Yes, delete'}
            </button>
            <button onClick={() => setConfirming(false)} disabled={busy} style={s.confirmBtnGhost}>
              Cancel
            </button>
          </div>
        ) : (
          <div style={s.actionBar}>
            <button
              onClick={() => setConfirming(true)}
              disabled={selected.size === 0 || busy}
              style={{ ...s.deleteBtn, ...(selected.size === 0 ? s.deleteBtnDis : {}) }}
            >
              Delete {selected.size > 0 ? `(${selected.size})` : 'selected'}
            </button>
          </div>
        )}

        {error && (
          <div style={s.modalError}>
            <AlertTriangle size={11} />
            <span>{error}</span>
          </div>
        )}

        <div style={s.profileList} className="dsp-scroll-region">
          {profiles.map(p => (
            <div key={p.id} style={s.profileRow}>
              <input
                type="checkbox"
                checked={selected.has(p.id)}
                onChange={() => toggle(p.id)}
                style={s.checkbox}
              />
              {renamingId === p.id ? (
                <input
                  type="text"
                  value={renameValue}
                  onChange={e => setRenameValue(e.target.value)}
                  onBlur={submitRename}
                  onKeyDown={e => {
                    if (e.key === 'Enter') submitRename()
                    if (e.key === 'Escape') setRenamingId(null)
                  }}
                  autoFocus
                  maxLength={80}
                  style={s.renameInput}
                  disabled={busy}
                />
              ) : (
                <button
                  onClick={() => startRename(p)}
                  style={s.profileName}
                  title="Click to rename"
                >
                  {p.name}
                  {p.is_active ? <span style={s.activeBadge}>active</span> : null}
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

const s = {
  bar: {
    background: 'var(--bg-overlay)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    padding: 8,
    marginBottom: 10,
  },
  row1: { display: 'flex', alignItems: 'center', gap: 8 },
  row2: { display: 'flex', gap: 6, marginTop: 8 },
  barLabel: {
    fontSize: 10, fontWeight: 700, letterSpacing: '0.05em',
    color: 'var(--text-tertiary)', textTransform: 'uppercase',
    flexShrink: 0,
  },
  select: {
    flex: 1, minWidth: 0,
    padding: '5px 7px',
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border)',
    borderRadius: 4,
    color: 'var(--text-primary)',
    fontSize: 12,
  },
  bypassLabel: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    fontSize: 11, color: 'var(--text-secondary)',
    cursor: 'pointer', userSelect: 'none',
    flexShrink: 0,
  },
  checkbox: { width: 13, height: 13, accentColor: 'var(--accent)' },
  btn: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '5px 9px',
    background: 'var(--bg-elevated)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border)',
    borderRadius: 4,
    fontSize: 11, fontWeight: 600,
    cursor: 'pointer',
    flex: '0 1 auto',
  },
  error: {
    display: 'flex', alignItems: 'center', gap: 5,
    padding: '6px 9px', marginTop: 8,
    background: 'rgba(255,90,90,0.1)',
    border: '1px solid rgba(255,90,90,0.3)',
    borderRadius: 4,
    fontSize: 11, color: '#ff8888',
  },
  errorX: { marginLeft: 'auto', background: 'none', border: 'none', color: '#ff8888', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 0 },

  saveAsRow: { display: 'flex', flex: 1, gap: 4 },
  saveAsInput: {
    flex: 1, minWidth: 0,
    padding: '5px 7px',
    background: 'var(--bg-elevated)',
    border: '1px solid var(--accent)',
    borderRadius: 4,
    color: 'var(--text-primary)',
    fontSize: 12,
  },
  saveAsBtn: {
    width: 28, height: 28,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--accent)', color: 'var(--on-accent)',
    border: 'none', borderRadius: 4, cursor: 'pointer',
  },
  saveAsBtnGhost: {
    width: 28, height: 28,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--bg-elevated)', color: 'var(--text-tertiary)',
    border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer',
  },

  modalBackdrop: {
    position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
    background: 'rgba(0,0,0,0.55)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 100,
  },
  modal: {
    background: 'var(--bg-surface)',
    border: '1px solid var(--border-bright)',
    borderRadius: 8,
    width: '90%', maxWidth: 420,
    maxHeight: '70vh',
    display: 'flex', flexDirection: 'column',
    overflow: 'hidden',
  },
  modalHeader: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '10px 14px',
    borderBottom: '1px solid var(--border)',
    fontSize: 13, fontWeight: 600,
    color: 'var(--text-primary)',
  },
  modalClose: {
    width: 24, height: 24,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer',
  },
  actionBar: {
    padding: '8px 12px',
    borderBottom: '1px solid var(--border)',
  },
  confirmBar: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '10px 12px',
    background: 'rgba(245,196,80,0.10)',
    borderBottom: '1px solid rgba(245,196,80,0.35)',
    flexWrap: 'wrap',
  },
  confirmText: { flex: 1, fontSize: 12, color: 'var(--text-primary)', minWidth: 140 },
  confirmBtn: {
    padding: '5px 10px',
    background: '#d04848',
    color: '#fff', border: 'none', borderRadius: 4,
    fontSize: 11, fontWeight: 600, cursor: 'pointer',
  },
  confirmBtnGhost: {
    padding: '5px 10px',
    background: 'var(--bg-elevated)',
    color: 'var(--text-secondary)',
    border: '1px solid var(--border)', borderRadius: 4,
    fontSize: 11, cursor: 'pointer',
  },
  deleteBtn: {
    padding: '5px 12px',
    background: '#d04848', color: '#fff',
    border: 'none', borderRadius: 4,
    fontSize: 11, fontWeight: 600, cursor: 'pointer',
  },
  deleteBtnDis: { opacity: 0.4, cursor: 'not-allowed', background: 'var(--bg-elevated)', color: 'var(--text-tertiary)' },
  modalError: {
    display: 'flex', alignItems: 'center', gap: 5,
    padding: '6px 12px',
    background: 'rgba(255,90,90,0.1)',
    fontSize: 11, color: '#ff8888',
  },
  profileList: { overflowY: 'auto', flex: 1 },
  profileRow: {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '8px 12px',
    borderBottom: '1px solid var(--border)',
  },
  profileName: {
    flex: 1, textAlign: 'left',
    background: 'none', border: 'none',
    color: 'var(--text-primary)',
    fontSize: 13, padding: 0,
    cursor: 'pointer',
    display: 'flex', alignItems: 'center', gap: 8,
  },
  activeBadge: {
    fontSize: 9, fontWeight: 700, letterSpacing: '0.05em',
    color: 'var(--accent)',
    background: 'var(--accent-dim)',
    padding: '2px 6px',
    borderRadius: 8,
    textTransform: 'uppercase',
  },
  renameInput: {
    flex: 1,
    padding: '4px 6px',
    background: 'var(--bg-elevated)',
    border: '1px solid var(--accent)',
    borderRadius: 4,
    color: 'var(--text-primary)',
    fontSize: 13,
  },
}
