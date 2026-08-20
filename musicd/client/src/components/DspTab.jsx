import React, { useEffect, useState } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import { Speaker, AlertTriangle } from 'lucide-react'
import FirSection from './FirSection'
import PeqEditor from './PeqEditor'
import HeadroomSection from './HeadroomSection'
import ProfileBar from './ProfileBar'

// DSP settings tab content (#29.0; #29.6 cleanup)
// =================================================
// All per-renderer DSP settings live on this single tab. Order top-to-bottom:
//   1. Renderer picker (which profile we're editing)
//   2. Profile bar (named profiles + Save / Save as / Manage / Bypass)
//   3. Eligibility notice (DSP not applied to Sonos etc.)
//   4. FIR convolution
//   5. PEQ
//
// Headroom and clipping-indicator UI removed in #29.6 — auto-preamp from
// peq_filters is the sole clipping protection now.
export default function DspTab({ forceRendererId } = {}) {
  const { renderers, rendererId } = useStore()
  // v54: when forceRendererId is set (from the NowPlaying DSP overlay
  // that opens for the active renderer), we lock the editor to that
  // renderer and hide the picker. The user explicitly arrived here
  // wanting to tune what's playing now; switching to a different
  // renderer mid-overlay would be surprising.
  const lockedRid = forceRendererId || null
  const [editingRid, setEditingRid] = useState(lockedRid || rendererId || (renderers[0]?.id || null))
  const [profile, setProfile] = useState(null)
  const [eligibility, setEligibility] = useState(null)
  const [loading, setLoading] = useState(false)

  // Keep editingRid in sync with forceRendererId if the parent re-mounts
  // with a different active renderer (e.g. user switched zones, then
  // opened DSP again). Without this, the locked renderer would freeze
  // at whatever was active when the overlay first mounted.
  useEffect(() => {
    if (lockedRid && lockedRid !== editingRid) setEditingRid(lockedRid)
  }, [lockedRid])

  // Load profile whenever the chosen renderer changes (or when a profile
  // is applied — the ProfileBar calls reloadProfile() to refresh us).
  const reloadProfile = async () => {
    if (!editingRid) return
    setLoading(true)
    try {
      const [p, e] = await Promise.all([
        api.get(`/dsp/profile/${encodeURIComponent(editingRid)}`),
        api.get(`/dsp/eligible/${encodeURIComponent(editingRid)}`),
      ])
      setProfile(p)
      setEligibility(e)
    } catch (err) {
      setProfile(null); setEligibility(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { reloadProfile() }, [editingRid])

  // Master-enable toggle (the "Bypass DSP" switch). Persists to live state
  // immediately because it's a single boolean — no Save button needed for
  // a switch the user expects to act now.
  const toggleMaster = async (enabled) => {
    if (!editingRid) return
    try {
      const r = await api.put(`/dsp/profile/${encodeURIComponent(editingRid)}`, {
        master_enabled: enabled,
      })
      setProfile(r)
    } catch (e) { console.warn('toggle master failed:', e) }
  }

  return (
    <div>
      {/* Renderer picker — top of tab, sticky-ish so it's always visible
          while scrolling subsections. v54: hidden when DspTab is rendered
          inside the NowPlaying DSP overlay (the renderer is fixed to
          whatever's playing). */}
      {!lockedRid && (
        <div style={s.headerRow}>
          <Speaker size={14} style={{ color: 'var(--text-tertiary)' }} />
          <select
            value={editingRid || ''}
            onChange={e => setEditingRid(e.target.value)}
            style={s.rendererSelect}
          >
            {renderers.length === 0 && <option value="">No renderers found</option>}
            {renderers.map(r => (
              <option key={r.id} value={r.id}>
                {r.name} ({(r.protocol || '').toUpperCase()})
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Profile bar — save / load / manage / bypass for this renderer's
          named profile sets. Sits between the renderer picker and the
          eligibility notice so the user always knows which named state
          they're editing. */}
      {editingRid && (
        <ProfileBar
          rendererId={editingRid}
          masterEnabled={profile?.profile?.master_enabled !== false}
          onMasterToggle={toggleMaster}
          onProfileApplied={reloadProfile}
          onProfilesChanged={reloadProfile}
        />
      )}

      {/* Eligibility notice */}
      {eligibility && !eligibility.eligible && (
        <div style={s.notice}>
          <AlertTriangle size={13} />
          <span>{eligibility.reason}</span>
        </div>
      )}
      {eligibility && eligibility.eligible && (
        <div style={s.eligibleNotice}>
          {eligibility.reason}
        </div>
      )}

      {/* Headroom (#v1.1.0.53) — sits above FIR Convolution because
          it's the safety margin that lets FIR work without clipping.
          Visually grouped with FIR so users find them together. */}
      <Subsection title="Headroom">
        {editingRid ? (
          <HeadroomSection
            rendererId={editingRid}
            profile={profile?.profile}
            onProfileChange={(r) => setProfile(r)}
          />
        ) : (
          <div style={s.placeholder}>Select a renderer to configure headroom.</div>
        )}
      </Subsection>

      {/* FIR convolution (#29.1) */}
      <Subsection title="FIR Convolution">
        {editingRid ? (
          <FirSection
            rendererId={editingRid}
            profile={profile?.profile}
            onProfileChange={(r) => setProfile(r)}
          />
        ) : (
          <div style={s.placeholder}>Select a renderer to configure FIR.</div>
        )}
      </Subsection>

      {/* PEQ editor (#29.2) */}
      <Subsection title="Parametric EQ">
        {editingRid ? (
          <PeqEditor
            rendererId={editingRid}
            profile={profile?.profile}
            onProfileChange={(r) => setProfile(r)}
          />
        ) : (
          <div style={s.placeholder}>Select a renderer to configure PEQ.</div>
        )}
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
  headerRow: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '4px 0 12px',
  },
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
  eligibleNotice: {
    padding: '6px 12px', marginBottom: 12,
    fontSize: 11,
    color: 'var(--text-tertiary)',
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

  placeholder: {
    fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5,
    padding: '4px 0',
  },

  peqSummary: { fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 },
  peqList: {
    display: 'flex', flexDirection: 'column', gap: 4,
    margin: '8px 0',
  },
  peqRow: {
    display: 'grid', gridTemplateColumns: '40px 80px 60px 1fr',
    alignItems: 'center', gap: 8,
    padding: '4px 8px',
    background: 'var(--bg-overlay)',
    borderRadius: 4,
    fontSize: 11, fontFamily: 'var(--font-mono)',
  },
  peqType: { color: 'var(--text-tertiary)' },
  peqFc: { color: 'var(--text-primary)' },
  peqQ: { color: 'var(--text-tertiary)' },
  peqGain: { textAlign: 'right', fontWeight: 700 },
  peqStats: {
    fontSize: 11, color: 'var(--text-tertiary)',
    padding: '4px 0', fontFamily: 'var(--font-mono)',
  },

  row: { padding: '6px 0' },
  label: {
    display: 'flex', alignItems: 'center', gap: 8,
    fontSize: 13, color: 'var(--text-primary)',
    cursor: 'pointer', userSelect: 'none',
  },
  subLabel: {
    display: 'block',
    fontSize: 12, color: 'var(--text-secondary)',
    marginBottom: 5,
  },
  checkbox: { width: 14, height: 14, accentColor: 'var(--accent)' },
  sliderRow: { display: 'flex', alignItems: 'center', gap: 8 },
  slider: { flex: 1, accentColor: 'var(--accent)' },
  valLabel: {
    width: 64, fontSize: 12, fontFamily: 'var(--font-mono)',
    color: 'var(--text-secondary)', textAlign: 'right',
  },
  help: {
    fontSize: 11, color: 'var(--text-tertiary)',
    lineHeight: 1.5, marginTop: 6,
  },

  saveRow: {
    display: 'flex', justifyContent: 'flex-end',
    paddingTop: 10, marginTop: 6,
    borderTop: '1px solid var(--border)',
  },
  saveBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '7px 14px',
    background: 'var(--accent)',
    color: 'var(--on-accent)',
    border: 'none',
    borderRadius: 'var(--radius-sm)',
    fontSize: 12, fontWeight: 600,
    cursor: 'pointer',
  },
  saveBtnDis: { opacity: 0.4, cursor: 'not-allowed' },
}
