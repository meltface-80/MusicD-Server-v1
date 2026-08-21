import React, { useEffect, useState } from 'react'
import { api } from '../api'
import { Save, AlertTriangle } from 'lucide-react'
import HelpTooltip from './HelpTooltip'

/**
 * HeadroomSection — manual headroom slider for end-of-chain
 * attenuation before bit-narrow.
 *
 * v1.1.0.53 introduced this as a pre-FIR knob (margin for FIR boost
 * peaks). v1.1.0.75 broadens it: headroom now sits at the END of
 * the DSP chain, applied whenever the user has the toggle on,
 * regardless of whether FIR is also active. The mental model:
 * float-64 → all DSP → headroom → bit convert.
 *
 * Range: -12 dB to 0 dB. Default -3 dB. Off by default.
 *
 * Volume Levelling collision: when VL is on, the stream pipeline
 * already attenuates each track to a LUFS target. Stacking
 * headroom on top would over-attenuate. The stream route
 * suppresses headroom whenever VL has produced gain for a track;
 * this section surfaces a note explaining that, so the user knows
 * not to bother enabling both.
 *
 * If the predicted post-FIR peak is above 0 dBFS, the section
 * still gets a "Will clip" warning. The signal-path orb in the
 * player also pulses red in that state.
 */
export default function HeadroomSection({ rendererId, profile, onProfileChange, enabled = false }) {
  // v1.1.32.0 — `enabled` is a PROP now, not draft state with a checkbox in
  // this body. The switch lives on the section's heading and writes straight
  // through, because a toggle that collapses its own section would otherwise
  // hide the Save button needed to commit it. This section no longer sends
  // headroom_enabled at all: saveProfile merges a patch, so leaving the key out is what
  // keeps the heading's value authoritative.
  const [headroomDb, setHeadroomDb] = useState(-3)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState(null)
  const [error, setError] = useState(null)
  // v1.1.0.75 — load VL state so we can show the collision note.
  // The actual suppression happens server-side; this is purely
  // informational so the user understands why headroom isn't
  // doing anything when both toggles are on.
  const [vlEnabled, setVlEnabled] = useState(false)

  useEffect(() => {
    if (!profile) return
    setHeadroomDb(typeof profile.headroom_db === 'number' ? profile.headroom_db : -3)
  }, [profile])

  useEffect(() => {
    let cancelled = false
    api.get('/settings').then(s => {
      if (!cancelled) setVlEnabled(!!s?.vl_enabled)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  const dirty = profile && (
    Math.abs(headroomDb - (profile.headroom_db ?? -3)) > 0.01
  )

  const save = async () => {
    if (!rendererId) return
    setSaving(true)
    setError(null)
    try {
      const r = await api.put(`/dsp/profile/${encodeURIComponent(rendererId)}`, {
        headroom_db: headroomDb,
      })
      setSavedAt(Date.now())
      onProfileChange?.(r)
    } catch (e) {
      setError(e.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const willClip = !!profile?.clipping_indicator
  const predictedDb = typeof profile?.predicted_post_fir_db === 'number'
    ? profile.predicted_post_fir_db
    : null

  // v1.1.0.60 — guidance banner for the VL+FIR interaction. The
  // clipping prediction shown above doesn't know about Volume
  // Levelling normalisation: if a track hasn't been LUFS-scanned,
  // VL has no per-track gain to apply, so the prediction is
  // optimistic. Practical rule from listening tests: when FIR is
  // active, set headroom to at least −5 dB until the library has
  // been LUFS-scanned.
  // Show this only when FIR is on and the user's current headroom
  // is shallower than −5 dB. We don't suppress it on willClip
  // because they're complementary: willClip warns about the
  // mathematical worst-case from IR peaks; this warns about the
  // empirical case from un-normalised loud sources.
  const showVlGuidance = !!profile?.conv_enabled && (
    !enabled || headroomDb > -5
  )

  return (
    <div>
      <div style={s.helpRow}>
        <HelpTooltip>
          End-of-chain attenuation applied just before the 24-bit
          quantiser. Reduces signal level so transient peaks don't
          clip during bit-narrow. The PEQ already has its own
          automatic preamp; this slider is on top, useful when FIR
          convolution adds gain or when working with hot masters.
          Default −3 dB is safe for most setups. Range −12 to 0 dB.
        </HelpTooltip>
      </div>

      {/* v1.1.0.75 — VL collision note. When Volume Levelling is on,
          the stream route silently suppresses headroom for each
          track that has a measured LUFS gain (because VL is already
          attenuating). This note explains that — so the user
          doesn't enable both and wonder why the stream sounds
          quieter than expected. */}
      {vlEnabled && enabled && (
        <div style={s.vlCollision}>
          <AlertTriangle size={13} />
          <span>
            Volume Levelling is on. Headroom is automatically
            suppressed on tracks VL has scanned, since VL already
            attenuates to a LUFS target. You don't need both — turn
            off whichever feels redundant.
          </span>
        </div>
      )}

      {willClip && (
        <div style={s.clipWarn}>
          <AlertTriangle size={13} />
          <span>
            Chain may clip
            {predictedDb !== null && ` (+${predictedDb.toFixed(1)} dB over)`}
            . Increase headroom or lower IR gain.
          </span>
        </div>
      )}

      {showVlGuidance && !willClip && !vlEnabled && (
        <div style={s.vlGuidance}>
          <AlertTriangle size={13} />
          <span>
            FIR convolution is active. With Volume Levelling off, hot
            masters can still push past 0 dBFS during convolution.
            Setting headroom to −5 dB or lower covers the typical
            measurement-IR worst case.
          </span>
        </div>
      )}


      <div style={s.sliderRow}>
        <span style={{ ...s.endLabel, opacity: enabled ? 1 : 0.5 }}>−12 dB</span>
        <input
          type="range"
          min={-12} max={0} step={0.5}
          value={headroomDb}
          onChange={e => setHeadroomDb(Number(e.target.value))}
          disabled={!enabled}
          style={s.slider}
        />
        <span style={{ ...s.endLabel, opacity: enabled ? 1 : 0.5 }}>0 dB</span>
        <span style={{ ...s.valLabel, opacity: enabled ? 1 : 0.5 }}>{headroomDb.toFixed(1)} dB</span>
      </div>

      {error && <div style={s.errorRow}>{error}</div>}

      <div style={s.saveRow}>
        <button
          type="button"
          style={{ ...s.saveBtn, ...((!dirty || saving) ? s.saveBtnDis : {}) }}
          disabled={!dirty || saving}
          onClick={save}
        >
          <Save size={12} />
          <span>{saving ? 'Saving…' : (dirty ? 'Save Headroom' : (savedAt ? 'Saved ✓' : 'No changes'))}</span>
        </button>
      </div>
    </div>
  )
}

const s = {
  helpRow: { display: 'flex', justifyContent: 'flex-end', marginTop: -2, marginBottom: 4 },
  row: { display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' },
  label: { display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-primary)', fontSize: 12, cursor: 'pointer' },
  checkbox: { width: 14, height: 14, accentColor: 'var(--accent)' },
  sliderRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0' },
  endLabel: { fontSize: 10, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', minWidth: 38 },
  slider: { flex: 1, height: 4, accentColor: 'var(--accent)' },
  valLabel: { fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', minWidth: 56, textAlign: 'right' },
  clipWarn: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '8px 10px',
    background: 'rgba(224,85,85,0.10)',
    border: '1px solid rgba(224,85,85,0.45)',
    borderRadius: 6,
    fontSize: 11,
    color: '#f08080',
    marginBottom: 8,
  },
  vlGuidance: {
    display: 'flex', alignItems: 'flex-start', gap: 8,
    padding: '8px 10px',
    background: 'rgba(245,196,80,0.06)',
    border: '1px solid rgba(245,196,80,0.30)',
    borderRadius: 6,
    fontSize: 11,
    color: '#d4a849',
    marginBottom: 8,
    lineHeight: 1.4,
  },
  // v1.1.0.75 — VL collision note. Same visual weight as vlGuidance
  // (informational, not error) but uses an accent-blue tint to
  // distinguish "VL is on, your headroom is being suppressed" from
  // "VL is off, you should set more headroom for FIR safety."
  vlCollision: {
    display: 'flex', alignItems: 'flex-start', gap: 8,
    padding: '8px 10px',
    background: 'rgba(91,127,255,0.06)',
    border: '1px solid rgba(91,127,255,0.30)',
    borderRadius: 6,
    fontSize: 11,
    color: 'var(--text-secondary)',
    marginBottom: 8,
    lineHeight: 1.4,
  },
  errorRow: {
    fontSize: 11, color: 'var(--red)', marginTop: 4,
  },
  saveRow: { display: 'flex', justifyContent: 'flex-end', marginTop: 10 },
  saveBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '7px 14px',
    background: 'var(--accent)',
    color: 'var(--on-accent)',
    border: 'none', borderRadius: 6,
    fontSize: 12, fontWeight: 600,
    cursor: 'pointer',
  },
  saveBtnDis: { opacity: 0.5, cursor: 'default' },
}
