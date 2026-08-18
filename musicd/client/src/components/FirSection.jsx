import React, { useEffect, useState, useRef } from 'react'
import { api } from '../api'
import { Save, Upload, Trash2, FileAudio, AlertTriangle } from 'lucide-react'
import HelpTooltip from './HelpTooltip'

// FIR convolution settings (#29.1)
// =================================
// One row per supported sample rate. Each row shows: rate label, "Choose
// file" → upload, current IR info if uploaded, delete button. Below the
// rows: enable toggle + dry/wet sliders + Save button.
//
// We don't allow cross-rate IR substitution. If the user uploads a 48 kHz IR
// under the 96 kHz slot the server rejects it (rate mismatch); we surface
// that error inline. This protects against the silent-stretch failure mode
// that ruins room correction.
export default function FirSection({ rendererId, profile, onProfileChange }) {
  // Default sample-rate list used when no renderer is selected, when
  // the renderer has no FIR data yet, or when the API call fails for
  // any reason. v1.1.3.1: previously the default lived only inside
  // the success path of loadIrs(); if loadIrs early-returned (no
  // rendererId) or the catch fired (API failure during a heavy
  // scanner pass, timeout, etc.) supportedRates would stay as the
  // empty initial [] and the entire rate-row table would render as
  // zero rows. From the user's perspective, the upload UI vanished.
  // Hoisting the defaults here makes the rate list a pure UI
  // affordance (always visible, always interactive) rather than a
  // hostage to the API's response state.
  const DEFAULT_RATES = [44100, 48000, 88200, 96000, 176400, 192000]

  const [irs, setIrs] = useState({})           // map: rate -> ir info
  const [supportedRates, setSupportedRates] = useState(DEFAULT_RATES)
  const [loading, setLoading] = useState(false)
  const [uploadError, setUploadError] = useState(null)
  const [uploadingRate, setUploadingRate] = useState(null)

  // Local edit state for the dry/wet/enable controls — saved with the
  // shared "Save FIR" button at the bottom. dryDb default of -120 means
  // "no dry signal at all" (full wet, normal for correction filters).
  const [enabled, setEnabled] = useState(false)
  const [dryDb, setDryDb] = useState(-120)
  const [wetDb, setWetDb] = useState(0)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState(null)

  // File-input refs, one per rate, so we can programmatically open them
  // when the user taps the "Upload" button (the actual <input type=file>
  // is hidden — we want a styled button as the visible target).
  const fileInputs = useRef({})

  const loadIrs = () => {
    // v1.1.3.1: do NOT early-return without setting state. The rate
    // list must always be visible. If we have no renderer, just keep
    // the defaults and clear the irs map; if we have a renderer,
    // fetch and merge.
    if (!rendererId) {
      setIrs({})
      setSupportedRates(DEFAULT_RATES)
      return
    }
    setLoading(true)
    api.get(`/dsp/fir/${encodeURIComponent(rendererId)}`)
      .then(r => {
        setIrs(r.irs || {})
        // Honour server-supplied rate list when present; fall back to
        // defaults otherwise. An empty array from the server is treated
        // as "no data" rather than "show no rows".
        const rates = Array.isArray(r.supportedRates) && r.supportedRates.length > 0
          ? r.supportedRates
          : DEFAULT_RATES
        setSupportedRates(rates)
      })
      .catch(() => {
        // API failed (timeout, scanner thrashing, renderer offline).
        // Leave the rate list intact at defaults; clear irs so the
        // rows render their empty-state placeholder. The user can
        // still see the UI and try uploading; the upload itself will
        // surface a sensible error if the renderer truly isn't there.
        setIrs({})
        setSupportedRates(DEFAULT_RATES)
      })
      .finally(() => setLoading(false))
  }

  // Load IR list whenever the renderer changes
  useEffect(() => { loadIrs() }, [rendererId])

  // Sync local edit state from the loaded profile
  useEffect(() => {
    if (!profile) return
    setEnabled(!!profile.conv_enabled)
    setDryDb(profile.conv_dry_db ?? -120)
    setWetDb(profile.conv_wet_db ?? 0)
  }, [profile])

  const handlePick = (rate) => {
    setUploadError(null)
    fileInputs.current[rate]?.click()
  }

  const handleFile = async (rate, file) => {
    if (!file) {
      // iOS Safari sometimes calls onChange with no file when the user
      // cancels the picker. Treat as a no-op rather than an error.
      return
    }
    setUploadError(null)
    setUploadingRate(rate)
    try {
      const buffer = await file.arrayBuffer()

      // Check filename OR magic bytes -- iOS sometimes hands a file
      // with a generic name like "image.jpg" even for an audio pick,
      // so the .wav extension test is unreliable. The byte magic
      // (RIFF/RF64/BW64 at offset 0) is the real check.
      const hasWavExt = file.name && file.name.toLowerCase().endsWith('.wav')
      const view = new Uint8Array(buffer.slice(0, 4))
      const magic = String.fromCharCode(view[0] || 0, view[1] || 0, view[2] || 0, view[3] || 0)
      const hasWavMagic = (magic === 'RIFF' || magic === 'RF64' || magic === 'BW64')

      if (!hasWavExt && !hasWavMagic) {
        setUploadError(
          `Doesn't look like a WAV. ` +
          `Filename: "${file.name || '(none)'}". ` +
          `First 4 bytes: "${magic}". ` +
          `On iOS, try uploading from the Files app rather than Photos.`
        )
        return
      }

      // Note: api.post normally JSON-encodes — we need a raw upload, so go
      // through fetch directly with the WAV body.
      const resp = await fetch(`/api/dsp/fir/${encodeURIComponent(rendererId)}/${rate}`, {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: buffer,
      })
      const data = await resp.json()
      if (!resp.ok) {
        setUploadError(data?.error || `Upload failed (HTTP ${resp.status})`)
      } else {
        loadIrs()
      }
    } catch (e) {
      setUploadError(e.message)
    } finally {
      setUploadingRate(null)
    }
  }

  const handleDelete = async (rate) => {
    if (!rendererId) return
    if (!window.confirm(`Remove the ${(rate/1000).toFixed(1)} kHz IR?`)) return
    try {
      await fetch(`/api/dsp/fir/${encodeURIComponent(rendererId)}/${rate}`, { method: 'DELETE' })
      loadIrs()
    } catch (e) { setUploadError(e.message) }
  }

  const saveFir = async () => {
    if (!rendererId) return
    setSaving(true)
    try {
      const r = await api.put(`/dsp/profile/${encodeURIComponent(rendererId)}`, {
        conv_enabled: enabled,
        conv_dry_db: dryDb,
        conv_wet_db: wetDb,
      })
      onProfileChange?.(r)
      setSavedAt(Date.now())
    } catch (e) { setUploadError(e.message) }
    finally { setSaving(false) }
  }

  const dirty = profile && (
    enabled !== !!profile.conv_enabled
    || Math.abs(dryDb - (profile.conv_dry_db ?? -120)) > 0.001
    || Math.abs(wetDb - (profile.conv_wet_db ?? 0)) > 0.001
  )

  const populatedCount = Object.keys(irs).filter(r => irs[r]?.ok !== false).length

  return (
    <div>
      {/* v52: help text moved into HelpTooltip to free vertical space.
          The icon sits in the top-right corner so it's discoverable
          but doesn't take a row of its own. */}
      <div style={s.helpRow}>
        <HelpTooltip>
          Upload an impulse-response WAV per sample rate. The chain uses the IR
          whose rate matches the source — there's no automatic rate substitution,
          so for room correction at multiple rates you'll need an IR per rate.
          Mono or stereo WAV, 16/24/32-bit, max 1 second.

          {'\n\n'}
          Tracks that haven't been LUFS-scanned won't have any volume-levelling
          attenuation applied, which can leave a hot input running into the FIR.
          If you hear clipping after enabling FIR, either (a) run a Loudness
          scan from Settings, or (b) set Headroom to −5 dB or lower until the
          scan completes.
        </HelpTooltip>
      </div>

      {uploadError && (
        <div style={s.errorBox}>
          <AlertTriangle size={13} />
          <span>{uploadError}</span>
          <button onClick={() => setUploadError(null)} style={s.errorDismiss}>×</button>
        </div>
      )}

      {/* Per-rate row table */}
      <div style={s.rateTable}>
        {supportedRates.map(rate => {
          const ir = irs[String(rate)]
          const has = ir && ir.ok !== false
          const uploading = uploadingRate === rate
          return (
            <div key={rate} style={s.rateRow}>
              <div style={s.rateLabel}>
                <FileAudio size={11} style={{ color: 'var(--text-tertiary)' }} />
                <span>{(rate / 1000).toFixed(1)} kHz</span>
              </div>
              <div style={s.rateInfo}>
                {has ? (
                  <span style={s.rateMeta}>
                    {ir.channels === 1 ? 'mono' : 'stereo'} ·
                    {' '}{ir.bitDepth}-bit ·
                    {' '}{(ir.fileSize / 1024).toFixed(1)} KB
                    {/* v53: peak gain badge. Highlighted amber when the
                        IR alone would push the chain past 0 dBFS at
                        unity headroom. */}
                    {typeof ir.peakDb === 'number' && (
                      <span style={{ ...s.peakBadge, ...(ir.peakDb > 0 ? s.peakBadgeHot : {}) }}>
                        {' · '}peak {ir.peakDb >= 0 ? '+' : ''}{ir.peakDb.toFixed(1)} dB
                      </span>
                    )}
                  </span>
                ) : (
                  <span style={s.rateEmpty}>No IR uploaded</span>
                )}
              </div>
              <div style={s.rateActions}>
                {/* Hidden file input opened by the visible button.
                    iOS Safari (#v1.1.0.49 fix): accept="audio/*,.wav"
                    is more reliable than specific MIME types -- with
                    just ".wav" the picker sometimes returns without
                    firing a change event. Also resetting the input
                    value before pick (via key=) so a re-pick of the
                    same file fires onChange the second time. */}
                <input
                  type="file"
                  accept="audio/*,.wav"
                  ref={el => { fileInputs.current[rate] = el }}
                  style={{ display: 'none' }}
                  onChange={e => {
                    const f = e.target.files?.[0]
                    // Always reset the input so the next pick fires
                    // onChange even if the user re-selects the same
                    // file. iOS keeps the previous selection
                    // otherwise.
                    e.target.value = ''
                    handleFile(rate, f)
                  }}
                />
                <button
                  type="button"
                  style={s.uploadBtn}
                  onClick={() => handlePick(rate)}
                  disabled={uploading}
                  title={has ? 'Replace IR' : 'Upload IR'}
                >
                  <Upload size={12} />
                  {uploading ? '…' : (has ? 'Replace' : 'Upload')}
                </button>
                {has && (
                  <button
                    type="button"
                    style={s.deleteBtn}
                    onClick={() => handleDelete(rate)}
                    title="Remove this IR"
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <div style={s.statsRow}>
        {populatedCount === 0
          ? 'No IRs uploaded yet'
          : `${populatedCount} IR${populatedCount === 1 ? '' : 's'} uploaded`}
      </div>

      {/* Convolution master + dry/wet */}
      <div style={s.row}>
        <label style={s.label}>
          <input type="checkbox"
            checked={enabled}
            onChange={e => setEnabled(e.target.checked)}
            style={s.checkbox}
            disabled={populatedCount === 0}
          />
          <span>Enable convolution</span>
        </label>
      </div>

      <div style={s.row}>
        <label style={s.subLabel}>Dry signal</label>
        <div style={s.sliderRow}>
          <input type="range" min={-120} max={0} step={1} value={dryDb}
            onChange={e => setDryDb(Number(e.target.value))}
            disabled={!enabled}
            style={s.slider}
          />
          <span style={{ ...s.valLabel, opacity: enabled ? 1 : 0.5 }}>
            {dryDb <= -100 ? '−∞ dB' : `${dryDb} dB`}
          </span>
        </div>
        <label style={s.subLabel}>Wet (convolved) signal</label>
        <div style={s.sliderRow}>
          <input type="range" min={-12} max={12} step={0.5} value={wetDb}
            onChange={e => setWetDb(Number(e.target.value))}
            disabled={!enabled}
            style={s.slider}
          />
          <span style={{ ...s.valLabel, opacity: enabled ? 1 : 0.5 }}>{wetDb.toFixed(1)} dB</span>
        </div>
        <div style={s.helpRow}>
          <HelpTooltip>
            Standard room correction: dry −∞, wet 0 dB (full effect). For A/B
            comparison: dry 0 dB, wet −∞ dB temporarily disables the convolved
            signal without rebuilding the chain.
          </HelpTooltip>
        </div>
      </div>

      <div style={s.saveRow}>
        <button
          type="button"
          style={{ ...s.saveBtn, ...((!dirty || saving) ? s.saveBtnDis : {}) }}
          disabled={!dirty || saving}
          onClick={saveFir}
        >
          <Save size={12} />
          {saving ? 'Saving…' : (savedAt && !dirty ? 'Saved' : 'Save FIR')}
        </button>
      </div>
    </div>
  )
}

const s = {
  help: { fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.5, marginBottom: 8 },
  // v52: helpRow is the host for a HelpTooltip when help text used
  // to live inline. Right-aligned with -2px margin so it tucks into
  // the gutter rather than taking a row of its own.
  helpRow: { display: 'flex', justifyContent: 'flex-end', marginTop: -2, marginBottom: 4 },
  errorBox: {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '8px 10px', marginBottom: 10,
    background: 'rgba(255, 90, 90, 0.10)',
    border: '1px solid rgba(255, 90, 90, 0.35)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 12, color: '#ff6b6b',
  },
  errorDismiss: {
    marginLeft: 'auto',
    width: 18, height: 18,
    background: 'none', border: 'none',
    color: '#ff6b6b', cursor: 'pointer', fontSize: 16, padding: 0,
    lineHeight: 1,
  },
  rateTable: {
    border: '1px solid var(--border)',
    borderRadius: 4,
    background: 'var(--bg-overlay)',
    overflow: 'hidden',
  },
  rateRow: {
    display: 'grid', gridTemplateColumns: '90px 1fr auto',
    alignItems: 'center', gap: 8,
    padding: '8px 10px',
    borderBottom: '1px solid var(--border)',
  },
  rateLabel: {
    display: 'flex', alignItems: 'center', gap: 5,
    fontSize: 12, fontFamily: 'var(--font-mono)',
    color: 'var(--text-primary)',
  },
  rateInfo: { minWidth: 0, overflow: 'hidden' },
  rateMeta: { fontSize: 10, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' },
  peakBadge: { color: 'var(--text-tertiary)' },
  peakBadgeHot: { color: 'var(--amber)', fontWeight: 600 },
  rateEmpty: { fontSize: 10, color: 'var(--text-tertiary)', fontStyle: 'italic' },
  rateActions: { display: 'flex', gap: 4 },
  uploadBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    padding: '5px 9px', borderRadius: 4,
    background: 'var(--bg-elevated)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border)',
    fontSize: 11, fontWeight: 600,
    cursor: 'pointer',
  },
  deleteBtn: {
    width: 26, height: 26,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 0, borderRadius: 4,
    background: 'var(--bg-elevated)',
    color: '#ff8888',
    border: '1px solid var(--border)',
    cursor: 'pointer',
  },
  statsRow: { fontSize: 10, color: 'var(--text-tertiary)', padding: '8px 0', fontFamily: 'var(--font-mono)' },

  row: { padding: '6px 0' },
  label: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-primary)', cursor: 'pointer', userSelect: 'none' },
  subLabel: { display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 5, marginTop: 6 },
  checkbox: { width: 14, height: 14, accentColor: 'var(--accent)' },
  sliderRow: { display: 'flex', alignItems: 'center', gap: 8 },
  slider: { flex: 1, accentColor: 'var(--accent)' },
  valLabel: { width: 70, fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', textAlign: 'right' },

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
}
