import React, { useEffect, useState } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import { Speaker, AlertTriangle } from 'lucide-react'
import FirSection from './FirSection'
import PeqEditor from './PeqEditor'
import HeadroomSection from './HeadroomSection'
import ProfileBar from './ProfileBar'
import AutoEqTab from './AutoEqTab'
import HelpTooltip from './HelpTooltip'
import { loadDspOpen, saveDspOpen } from '../dspPanels'

// DSP settings tab content (#29.0; #29.6 cleanup; v1.1.32.0 restructure)
// ======================================================================
// Every per-zone DSP setting lives on this one page. Top to bottom:
//   1. Zone picker — which zone's settings these are
//   2. Profile bar (named profiles + Save / Save as / Manage / Bypass)
//   3. Eligibility notice (DSP not applied to Sonos etc.)
//   4. Volume levelling
//   5. Headroom
//   6. FIR convolution
//   7. Parametric EQ
//   8. AutoEQ headphone presets
//
// v1.1.32.0 — each category is a <Category>: a heading with its on/off switch
// at the right-hand end, and a body that is only rendered when it is on. The
// page was a long column of always-open panels with an "Enable" checkbox
// buried somewhere inside each one.
//
// THE SWITCH WRITES THROUGH IMMEDIATELY, and the section bodies no longer
// send their enable flag at all. That is not a style choice: the switch
// collapses its own section, so a value it only staged would need the section's
// Save button to commit it — and that button is inside the part that just
// disappeared. saveProfile merges a patch, so a body leaving the key out is
// what keeps the heading authoritative.
//
// Volume levelling moved here from the global Settings page in the same
// release and is per zone now; see renderer_dsp in db.js.
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

  // One field of the profile, written straight through. Used by every
  // category heading; see the note at the top of this file for why these do
  // not go through the sections' own Save buttons.
  const setFlag = async (patch) => {
    if (!editingRid) return
    try {
      const r = await api.put(`/dsp/profile/${encodeURIComponent(editingRid)}`, patch)
      setProfile(r)
    } catch (e) { console.warn('dsp flag write failed:', e) }
  }

  const p = profile?.profile || null

  // AutoEQ has no on/off of its own — it loads a preset into this zone's PEQ,
  // and that curve is already governed by the Parametric EQ switch above it. A
  // second switch claiming to enable the same filters would be a lie, so this
  // one only opens and closes the panel. Per zone and remembered, so it
  // behaves like the others from the user's side.
  const [autoEqOpen, setAutoEqOpen] = useState(() => loadDspOpen('autoeq', editingRid))
  useEffect(() => { setAutoEqOpen(loadDspOpen('autoeq', editingRid)) }, [editingRid])
  const toggleAutoEq = (v) => { setAutoEqOpen(v); saveDspOpen('autoeq', editingRid, v) }

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

      {!editingRid && (
        <div style={s.placeholder}>Select a zone to configure its DSP.</div>
      )}

      {/* Volume levelling. Global until v1.1.32.0, and per zone since — see
          renderer_dsp in db.js for what an upgrade does (nothing, until you
          change something). */}
      {editingRid && (
        <Category
          title="Volume levelling"
          on={!!p?.vl_enabled}
          onToggle={(v) => setFlag({ vl_enabled: v })}
        >
          <div style={s.vlRow}>
            <span style={s.vlLabel}>Gain mode</span>
            <div style={s.segControl}>
              {['track', 'album'].map(m => (
                <button
                  key={m}
                  type="button"
                  style={{ ...s.segBtn, ...((p?.vl_mode || 'track') === m ? s.segBtnActive : {}) }}
                  onClick={() => setFlag({ vl_mode: m })}
                >
                  {m === 'track' ? 'Track' : 'Album'}
                </button>
              ))}
            </div>
          </div>
          <div style={s.vlRow}>
            <span style={s.vlLabel}>Target LUFS</span>
            <div style={s.vlSliderRow}>
              <input
                type="range" min="-23" max="-14" step="1"
                value={p?.vl_target_lufs ?? -18}
                onChange={e => setFlag({ vl_target_lufs: parseInt(e.target.value, 10) })}
                style={s.vlSlider}
              />
              <span style={s.vlValLabel}>{p?.vl_target_lufs ?? -18} LUFS</span>
            </div>
          </div>
          <div style={s.helpRow}>
            <HelpTooltip>
              Album mode preserves relative track dynamics within an album; Track
              mode normalises each track independently. This is set per zone. To
              populate the database with loudness values, run the scan in
              <strong> Settings → Metadata</strong>.
            </HelpTooltip>
          </div>
        </Category>
      )}

      {/* Headroom (#v1.1.0.53) — sits above FIR Convolution because
          it's the safety margin that lets FIR work without clipping. */}
      {editingRid && (
        <Category
          title="Headroom"
          on={!!p?.headroom_enabled}
          onToggle={(v) => setFlag({ headroom_enabled: v })}
        >
          <HeadroomSection
            rendererId={editingRid}
            profile={p}
            enabled={!!p?.headroom_enabled}
            onProfileChange={(r) => setProfile(r)}
          />
        </Category>
      )}

      {/* FIR convolution (#29.1) */}
      {editingRid && (
        <Category
          title="FIR Convolution"
          on={!!p?.conv_enabled}
          onToggle={(v) => setFlag({ conv_enabled: v })}
        >
          <FirSection
            rendererId={editingRid}
            profile={p}
            enabled={!!p?.conv_enabled}
            onProfileChange={(r) => setProfile(r)}
          />
        </Category>
      )}

      {/* PEQ editor (#29.2) */}
      {editingRid && (
        <Category
          title="Parametric EQ"
          on={!!p?.peq_enabled}
          onToggle={(v) => setFlag({ peq_enabled: v })}
        >
          <PeqEditor
            rendererId={editingRid}
            profile={p}
            enabled={!!p?.peq_enabled}
            onProfileChange={(r) => setProfile(r)}
          />
        </Category>
      )}

      {/* AutoEQ (v1.1.32.0) — moved here from its own Settings section. It
          always edited a renderer's PEQ, so it belongs with the rest of that
          zone's chain rather than on a page of its own with a second zone
          picker to keep in step. */}
      {editingRid && (
        <Category
          title="AutoEQ headphone presets"
          on={autoEqOpen}
          onToggle={toggleAutoEq}
        >
          <AutoEqTab rendererId={editingRid} onProfileChange={reloadProfile} />
        </Category>
      )}
    </div>
  )
}

// A DSP category: heading, switch at the right-hand end, and a body that is
// only mounted while it is on. Not merely hidden — a collapsed FIR section
// would otherwise keep polling its IR list, and a collapsed PEQ would keep a
// draft the user cannot see.
function Category({ title, on, onToggle, children }) {
  return (
    <div style={s.subsection}>
      <button
        type="button"
        style={s.catHead}
        onClick={() => onToggle(!on)}
        aria-expanded={on}
      >
        <span style={s.subTitle}>{title}</span>
        <span style={{ ...s.switch, ...(on ? s.switchOn : {}) }} aria-hidden="true">
          <span style={{ ...s.knob, ...(on ? s.knobOn : {}) }} />
        </span>
      </button>
      {on && <div style={s.subBody}>{children}</div>}
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
    fontSize: 14,
  },
  notice: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '8px 12px', marginBottom: 12,
    background: 'rgba(245, 196, 80, 0.10)',
    border: '1px solid rgba(245, 196, 80, 0.35)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 13, color: '#f5c450',
  },
  eligibleNotice: {
    padding: '6px 12px', marginBottom: 12,
    fontSize: 12,
    color: 'var(--text-tertiary)',
  },

  // The heading is the whole switch: tapping anywhere on the row toggles it,
  // so the target is the full width rather than a 40px pill on the right.
  catHead: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: 12, width: '100%',
    padding: 0, margin: 0,
    background: 'none', border: 'none',
    cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
  },
  switch: {
    width: 38, height: 22, flexShrink: 0,
    borderRadius: 11,
    background: 'var(--bg-overlay)',
    border: '1px solid var(--border)',
    position: 'relative',
    transition: 'background 0.15s, border-color 0.15s',
  },
  switchOn: { background: 'var(--accent)', borderColor: 'var(--accent)' },
  knob: {
    position: 'absolute', width: 16, height: 16, borderRadius: '50%',
    background: '#fff', top: 2, left: 2,
    transition: 'left 0.15s',
  },
  knobOn: { left: 19 },

  // Volume levelling, which has no section component of its own — its two
  // controls write straight through like the switch above them.
  vlRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: 12, padding: '8px 0',
  },
  vlLabel: { fontSize: 14, color: 'var(--text-secondary)' },
  vlSliderRow: { display: 'flex', alignItems: 'center', gap: 10 },
  // v1.1.38.0 — these two were called `slider` and `valLabel`, and this
  // object declares BOTH names again a hundred lines further down for the
  // PEQ controls. A duplicate key in an object literal is an esbuild
  // WARNING, not an error: the build succeeded, the later definition
  // silently won, and this pair had never once applied. So the volume
  // levelling slider was taking `flex: 1` and stretching to fill its row
  // instead of sitting at its intended 120px, and its readout was 64px
  // wide in --text-secondary rather than 62px in --text-tertiary.
  //
  // Renamed to the vl* prefix the three properties around them already
  // use, rather than renaming the PEQ pair, because these are the local
  // exception and those are the general case. This is the exact hazard
  // CLAUDE.md warns about, found by reading a build warning that has been
  // scrolling past for some time.
  vlSlider: { width: 120, accentColor: 'var(--accent)' },
  vlValLabel: {
    fontSize: 12, fontFamily: 'var(--font-mono)',
    color: 'var(--text-tertiary)', width: 62, textAlign: 'right',
  },
  segControl: {
    display: 'flex', background: 'var(--bg-overlay)',
    border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden',
  },
  segBtn: {
    padding: '5px 14px', fontSize: 13, fontWeight: 500,
    color: 'var(--text-tertiary)', background: 'transparent',
    border: 'none', cursor: 'pointer', borderRadius: 0, fontFamily: 'inherit',
  },
  segBtnActive: { background: 'var(--accent)', color: 'var(--on-accent)', fontWeight: 700 },
  helpRow: { display: 'flex', justifyContent: 'flex-end', paddingTop: 4 },

  subsection: {
    marginBottom: 14,
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    background: 'var(--bg-elevated)',
    overflow: 'hidden',
  },
  subTitle: {
    padding: '9px 12px',
    fontSize: 12, fontWeight: 700,
    letterSpacing: '0.06em', textTransform: 'uppercase',
    color: 'var(--text-secondary)',
    background: 'var(--bg-overlay)',
    borderBottom: '1px solid var(--border)',
  },
  subBody: { padding: '10px 12px' },

  placeholder: {
    fontSize: 13, color: 'var(--text-tertiary)', lineHeight: 1.5,
    padding: '4px 0',
  },

  peqSummary: { fontSize: 13, color: 'var(--text-secondary)', marginBottom: 6 },
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
    fontSize: 12, fontFamily: 'var(--font-mono)',
  },
  peqType: { color: 'var(--text-tertiary)' },
  peqFc: { color: 'var(--text-primary)' },
  peqQ: { color: 'var(--text-tertiary)' },
  peqGain: { textAlign: 'right', fontWeight: 700 },
  peqStats: {
    fontSize: 12, color: 'var(--text-tertiary)',
    padding: '4px 0', fontFamily: 'var(--font-mono)',
  },

  row: { padding: '6px 0' },
  label: {
    display: 'flex', alignItems: 'center', gap: 8,
    fontSize: 14, color: 'var(--text-primary)',
    cursor: 'pointer', userSelect: 'none',
  },
  subLabel: {
    display: 'block',
    fontSize: 13, color: 'var(--text-secondary)',
    marginBottom: 5,
  },
  checkbox: { width: 14, height: 14, accentColor: 'var(--accent)' },
  sliderRow: { display: 'flex', alignItems: 'center', gap: 8 },
  slider: { flex: 1, accentColor: 'var(--accent)' },
  valLabel: {
    width: 64, fontSize: 13, fontFamily: 'var(--font-mono)',
    color: 'var(--text-secondary)', textAlign: 'right',
  },
  help: {
    fontSize: 12, color: 'var(--text-tertiary)',
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
    fontSize: 13, fontWeight: 600,
    cursor: 'pointer',
  },
  saveBtnDis: { opacity: 0.4, cursor: 'not-allowed' },
}
