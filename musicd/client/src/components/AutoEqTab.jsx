import React, { useEffect, useState, useMemo, useRef } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import { Speaker, Save, AlertTriangle, Headphones, Search, RefreshCw } from 'lucide-react'
import HelpTooltip from './HelpTooltip'

// AutoEQ tab (#29.0)
// ===================
// Two sections:
//   1. AutoEQ headphone preset loader. Type-to-search dropdown over the
//      bundled starter database, plus a "Refresh database" button (UI-only
//      placeholder for v29.0 — actual GitHub fetch is in v29.1).
//      Picking a model and tapping "Apply preset" loads the biquads into
//      the renderer's PEQ profile.
//   2. Crossfeed picker — headphones-only, profile selector + Save.
//
// Both sections share the renderer picker at the top of the tab.
export default function AutoEqTab() {
  const { renderers, rendererId } = useStore()
  const [editingRid, setEditingRid] = useState(rendererId || (renderers[0]?.id || null))
  const [profile, setProfile] = useState(null)
  const [eligibility, setEligibility] = useState(null)

  // AutoEQ state
  const [autoeqIndex, setAutoeqIndex] = useState([])
  const [autoeqSearch, setAutoeqSearch] = useState('')
  const [autoeqSelected, setAutoeqSelected] = useState('')
  const [autoeqApplying, setAutoeqApplying] = useState(false)
  const [autoeqResult, setAutoeqResult] = useState(null)

  // Database refresh state. Polled while a refresh is running so the user
  // sees progress. We only poll when actually running — no background
  // polling cost otherwise.
  const [updateProgress, setUpdateProgress] = useState(null)  // null = not active
  const [updateError, setUpdateError] = useState(null)
  const pollRef = useRef(null)

  // Crossfeed state
  const [cfProfiles, setCfProfiles] = useState([])
  const [cfEnabled, setCfEnabled] = useState(false)
  const [cfProfile, setCfProfile] = useState('default')
  const [cfSaving, setCfSaving] = useState(false)
  const [cfSavedAt, setCfSavedAt] = useState(null)

  // Load profile + AutoEQ index on mount (and when renderer changes)
  useEffect(() => {
    if (!editingRid) return
    Promise.all([
      api.get(`/dsp/profile/${encodeURIComponent(editingRid)}`),
      api.get(`/dsp/eligible/${encodeURIComponent(editingRid)}`),
    ])
      .then(([p, e]) => {
        setProfile(p)
        setEligibility(e)
        setCfEnabled(p.profile.crossfeed_enabled)
        setCfProfile(p.profile.crossfeed_profile || 'default')
        setAutoeqSelected(p.profile.autoeq_model || '')
      })
      .catch(() => {})
  }, [editingRid])

  useEffect(() => {
    api.get('/dsp/autoeq/index').then(r => setAutoeqIndex(r.models || [])).catch(() => setAutoeqIndex([]))
    api.get('/dsp/crossfeed/profiles').then(setCfProfiles).catch(() => setCfProfiles([]))
    // Check whether a refresh is already running (e.g. user navigated away
    // and came back). If yes, start polling.
    api.get('/dsp/autoeq/update/progress').then(p => {
      if (p?.running) {
        setUpdateProgress(p)
        startPolling()
      }
    }).catch(() => {})
    return () => stopPolling()
  }, [])

  // Poll progress every 1s while a refresh is running. We stop the poll
  // when the server reports phase=done or phase=error, or when the
  // component unmounts.
  const startPolling = () => {
    if (pollRef.current) return
    pollRef.current = setInterval(async () => {
      try {
        const p = await api.get('/dsp/autoeq/update/progress')
        setUpdateProgress(p)
        if (!p.running) {
          stopPolling()
          // Reload the index so the new presets appear in the dropdown
          api.get('/dsp/autoeq/index').then(r => setAutoeqIndex(r.models || []))
          if (p.error) setUpdateError(p.error)
        }
      } catch (e) { /* keep polling — transient errors are fine */ }
    }, 1000)
  }
  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
  }

  const startUpdate = async () => {
    setUpdateError(null)
    try {
      const r = await api.post('/dsp/autoeq/update', { replace: false })
      if (r?.error) { setUpdateError(r.error); return }
      // Optimistic — show "fetching tree" state immediately so the button
      // responds, then real progress arrives via polling.
      setUpdateProgress({ running: true, phase: 'fetching-tree', total: 0, done: 0 })
      startPolling()
    } catch (e) {
      setUpdateError(e.message || 'Failed to start update')
    }
  }

  // Filtered AutoEQ list — case-insensitive substring match on model name.
  // We don't bother building a fuzzy index since the bundled snapshot has
  // ~22 entries; a simple includes() is fast enough.
  const filteredModels = useMemo(() => {
    const q = autoeqSearch.trim().toLowerCase()
    if (!q) return autoeqIndex.slice(0, 50)
    return autoeqIndex.filter(m => m.model.toLowerCase().includes(q)).slice(0, 50)
  }, [autoeqIndex, autoeqSearch])

  const applyAutoeq = async () => {
    if (!editingRid || !autoeqSelected) return
    setAutoeqApplying(true)
    try {
      const r = await api.post('/dsp/autoeq/apply', {
        rendererId: editingRid,
        slug: autoeqSelected,
      })
      setProfile(r)
      setAutoeqResult(r)
    } catch (e) { console.warn('autoeq apply failed:', e) }
    finally { setAutoeqApplying(false) }
  }

  const saveCrossfeed = async () => {
    if (!editingRid) return
    setCfSaving(true)
    try {
      const r = await api.put(`/dsp/profile/${encodeURIComponent(editingRid)}`, {
        crossfeed_enabled: cfEnabled,
        crossfeed_profile: cfProfile,
      })
      setProfile(r)
      setCfSavedAt(Date.now())
    } catch (e) { console.warn('save crossfeed failed:', e) }
    finally { setCfSaving(false) }
  }

  const cfDirty = profile && (
    cfEnabled !== profile.profile.crossfeed_enabled
    || cfProfile !== (profile.profile.crossfeed_profile || 'default')
  )

  return (
    <div>
      <div style={s.headerRow}>
        <Speaker size={14} style={{ color: 'var(--text-tertiary)' }} />
        <select
          value={editingRid || ''}
          onChange={e => setEditingRid(e.target.value)}
          style={s.rendererSelect}
        >
          {renderers.length === 0 && <option value="">No renderers found</option>}
          {renderers.map(r => (
            <option key={r.id} value={r.id}>{r.name} ({(r.protocol || '').toUpperCase()})</option>
          ))}
        </select>
      </div>

      {eligibility && !eligibility.eligible && (
        <div style={s.notice}>
          <AlertTriangle size={13} />
          <span>{eligibility.reason}</span>
        </div>
      )}

      {/* AutoEQ preset loader */}
      <Subsection title="AutoEQ Headphone Preset">
        <div style={s.helpRow}>
          <HelpTooltip>
            Loads a tested PEQ preset for your headphones into this renderer's
            parametric EQ. The preset replaces any existing PEQ filters.
          </HelpTooltip>
        </div>

        <div style={s.dbStatusRow}>
          <div style={s.dbStatusText}>
            {updateProgress?.running ? (
              <>
                <RefreshCw size={11} style={{ animation: 'spin 1s linear infinite' }} />
                {' '}
                {updateProgress.phase === 'fetching-tree' && 'Listing AutoEQ database…'}
                {updateProgress.phase === 'downloading' && (
                  <>Downloading <b>{updateProgress.done}</b> / {updateProgress.total} presets…</>
                )}
                {updateProgress.phase === 'finalising' && 'Building index…'}
              </>
            ) : (
              <>
                <b>{autoeqIndex.length}</b> headphone{autoeqIndex.length === 1 ? '' : 's'} in database
                {autoeqIndex.length < 100 && (
                  <span style={s.starterBadge}> (starter — full database is ~3000)</span>
                )}
              </>
            )}
          </div>
          <button
            type="button"
            style={{ ...s.refreshBtn, ...(updateProgress?.running ? s.refreshBtnDis : {}) }}
            onClick={startUpdate}
            disabled={updateProgress?.running}
            title="Fetch the full AutoEQ database from GitHub (~30-60 seconds, ~3000 presets)"
          >
            <RefreshCw size={11} />
            {updateProgress?.running ? 'Updating…' : 'Update database'}
          </button>
        </div>

        {updateError && (
          <div style={s.notice}>
            <AlertTriangle size={13} />
            <span>{updateError}</span>
          </div>
        )}

        <div style={s.searchRow}>
          <Search size={12} style={s.searchIcon} />
          <input type="text"
            value={autoeqSearch}
            onChange={e => setAutoeqSearch(e.target.value)}
            placeholder="Search headphones…"
            style={s.searchInput}
          />
        </div>

        <div style={s.modelList} className="dsp-scroll-region">
          {filteredModels.length === 0 ? (
            <div style={s.emptyList}>
              {autoeqIndex.length === 0 ? 'AutoEQ database not loaded.' : 'No matches.'}
            </div>
          ) : filteredModels.map(m => (
            <button
              key={m.slug}
              type="button"
              style={{ ...s.modelRow, ...(m.slug === autoeqSelected ? s.modelRowActive : {}) }}
              onClick={() => setAutoeqSelected(m.slug)}
            >
              <Headphones size={12} style={{ color: 'var(--text-tertiary)' }} />
              <span style={s.modelName}>{m.model}</span>
              <span style={s.modelCat}>{m.category || ''}</span>
            </button>
          ))}
        </div>

        {profile?.profile?.autoeq_model && (
          <div style={s.currentLoaded}>
            Currently loaded: <b>{profile.profile.autoeq_model}</b>
            {' '}({profile.profile.peq_filters?.length || 0} filters,
            preamp {profile.profile.peq_preamp_db?.toFixed(1)} dB)
          </div>
        )}

        <div style={s.saveRow}>
          <button
            type="button"
            style={{ ...s.saveBtn, ...((!autoeqSelected || autoeqApplying) ? s.saveBtnDis : {}) }}
            disabled={!autoeqSelected || autoeqApplying}
            onClick={applyAutoeq}
          >
            <Save size={12} />
            {autoeqApplying ? 'Applying…' : 'Apply Preset'}
          </button>
        </div>
      </Subsection>

      {/* Crossfeed */}
      <Subsection title="Crossfeed (Bauer)">
        <div style={s.helpRow}>
          <HelpTooltip>
            Reduces in-head localisation when listening on headphones by mixing
            a small, frequency-shaped amount of each channel into the other.
            Has no audible effect on speakers.
          </HelpTooltip>
        </div>

        <div style={s.row}>
          <label style={s.label}>
            <input type="checkbox"
              checked={cfEnabled}
              onChange={e => setCfEnabled(e.target.checked)}
              style={s.checkbox}
            />
            <span>Enable crossfeed</span>
          </label>
        </div>

        <div style={s.row}>
          <label style={s.subLabel}>Profile</label>
          <div style={s.profileBtns}>
            {cfProfiles.map(p => (
              <button
                key={p.id}
                type="button"
                style={{ ...s.profileBtn, ...(cfProfile === p.id ? s.profileBtnActive : {}) }}
                onClick={() => setCfProfile(p.id)}
                disabled={!cfEnabled}
              >
                <div style={s.profileName}>{p.name}</div>
                <div style={s.profileDesc}>{p.desc}</div>
              </button>
            ))}
          </div>
        </div>

        <div style={s.saveRow}>
          <button
            type="button"
            style={{ ...s.saveBtn, ...((!cfDirty || cfSaving) ? s.saveBtnDis : {}) }}
            disabled={!cfDirty || cfSaving}
            onClick={saveCrossfeed}
          >
            <Save size={12} />
            {cfSaving ? 'Saving…' : (cfSavedAt && !cfDirty ? 'Saved' : 'Save Crossfeed')}
          </button>
        </div>
      </Subsection>
    </div>
  )
}

function Subsection({ title, children }) {
  return (
    <div style={s.subsection}>
      <div style={s.subTitle}>{title}</div>
      <div style={s.subBody}>{children}</div>
    </div>
  )
}

const s = {
  headerRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0 12px' },
  rendererSelect: {
    flex: 1, minWidth: 0,
    padding: '7px 9px',
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    color: 'var(--text-primary)',
    fontSize: 13,
  },
  notice: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '8px 12px', marginBottom: 12,
    background: 'rgba(245, 196, 80, 0.10)',
    border: '1px solid rgba(245, 196, 80, 0.35)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 12, color: '#f5c450',
  },

  subsection: {
    marginBottom: 14,
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    background: 'var(--bg-elevated)',
    overflow: 'hidden',
  },
  subTitle: {
    padding: '9px 12px',
    fontSize: 11, fontWeight: 700,
    letterSpacing: '0.06em', textTransform: 'uppercase',
    color: 'var(--text-secondary)',
    background: 'var(--bg-overlay)',
    borderBottom: '1px solid var(--border)',
  },
  subBody: { padding: '10px 12px' },

  searchRow: {
    position: 'relative',
    margin: '8px 0',
  },
  searchIcon: { position: 'absolute', left: 9, top: 9, color: 'var(--text-tertiary)', pointerEvents: 'none' },
  searchInput: {
    width: '100%',
    padding: '7px 10px 7px 28px',
    background: 'var(--bg-overlay)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    color: 'var(--text-primary)', fontSize: 12,
    outline: 'none',
  },

  modelList: {
    maxHeight: 220, overflowY: 'auto',
    border: '1px solid var(--border)',
    borderRadius: 4,
    background: 'var(--bg-overlay)',
  },
  emptyList: { padding: 20, fontSize: 11, color: 'var(--text-tertiary)', textAlign: 'center' },
  modelRow: {
    display: 'grid', gridTemplateColumns: '20px 1fr auto',
    alignItems: 'center', gap: 8,
    padding: '6px 10px', width: '100%',
    background: 'none', border: 'none',
    borderBottom: '1px solid var(--border)',
    cursor: 'pointer', textAlign: 'left',
  },
  modelRowActive: { background: 'var(--accent-dim)' },
  modelName: { fontSize: 12, color: 'var(--text-primary)' },
  modelCat: { fontSize: 9, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' },

  currentLoaded: {
    fontSize: 11, color: 'var(--text-secondary)',
    padding: '8px 0 0',
  },

  row: { padding: '6px 0' },
  label: {
    display: 'flex', alignItems: 'center', gap: 8,
    fontSize: 13, color: 'var(--text-primary)',
    cursor: 'pointer', userSelect: 'none',
  },
  subLabel: { display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 5 },
  checkbox: { width: 14, height: 14, accentColor: 'var(--accent)' },
  help: { fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.5, marginBottom: 8 },
  helpRow: { display: 'flex', justifyContent: 'flex-end', marginTop: -2, marginBottom: 4 },

  profileBtns: { display: 'flex', flexDirection: 'column', gap: 4 },
  profileBtn: {
    padding: '8px 10px',
    background: 'var(--bg-overlay)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    cursor: 'pointer',
    textAlign: 'left',
  },
  profileBtnActive: {
    borderColor: 'var(--accent)',
    background: 'var(--accent-dim)',
  },
  profileName: { fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' },
  profileDesc: { fontSize: 10, color: 'var(--text-tertiary)', marginTop: 2 },

  saveRow: {
    display: 'flex', justifyContent: 'flex-end',
    paddingTop: 10, marginTop: 6,
    borderTop: '1px solid var(--border)',
  },
  saveBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '7px 14px',
    background: 'var(--accent)',
    color: '#fff', border: 'none',
    borderRadius: 'var(--radius-sm)',
    fontSize: 12, fontWeight: 600,
    cursor: 'pointer',
  },
  saveBtnDis: { opacity: 0.4, cursor: 'not-allowed' },

  // Database status + Update button row above the search input.
  dbStatusRow: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '8px 0',
  },
  dbStatusText: {
    flex: 1,
    fontSize: 11, color: 'var(--text-secondary)',
    display: 'flex', alignItems: 'center', gap: 5,
  },
  starterBadge: {
    color: 'var(--text-tertiary)', fontStyle: 'italic',
    marginLeft: 4,
  },
  refreshBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    padding: '5px 10px',
    background: 'var(--bg-overlay)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 11, fontWeight: 600,
    cursor: 'pointer', flexShrink: 0,
  },
  refreshBtnDis: { opacity: 0.5, cursor: 'not-allowed' },
}
