import React, { useState, useEffect, useMemo, useRef } from 'react'
import { api } from '../api'
import { Save, Plus, Trash2, RotateCcw } from 'lucide-react'
import HelpTooltip from './HelpTooltip'
import { magnitudeResponse, calculatePeakGain } from '../peqMath'

// Manual PEQ editor (#29.2)
// ===========================
// One row per biquad with sliders for frequency, Q, gain, and a type dropdown.
// Above the rows: a frequency-response graph that updates live as the user
// drags. Below: enable toggle, peak/preamp display, Save PEQ button.
//
// Why live graph but save-only audio:
//   The client has the same biquad math as the server (peqMath.js) so the
//   graph can update at 60 fps without server round-trips. But applying the
//   chain to actual audio requires rebuilding the ffmpeg filter graph on
//   the server, which would glitch playback if done on every drag. So:
//     • slider drag → instant graph update (visual)
//     • Save button → server applies on next track (audio)
//
// This split is what made the previous PEQ attempt unusable: editing without
// graph feedback meant users couldn't tell what they'd built, and the change
// either didn't sound right or did nothing. We address both halves here.

const FILTER_TYPES = [
  { id: 'PK',  label: 'Peak'      },
  { id: 'LSC', label: 'Low Shelf' },
  { id: 'HSC', label: 'High Shelf'},
]

const MAX_FILTERS = 16

// Default filter values when adding a new row. Peaking @ 1 kHz, Q=1, 0 dB gain
// produces a no-op until the user changes something — but the row is visible
// and editable. Better than starting with a random gain that immediately
// changes the sound.
const newFilter = () => ({ type: 'PK', fc: 1000, q: 1.0, gain: 0 })

export default function PeqEditor({ rendererId, profile, onProfileChange, enabled = false }) {
  // Local edit state. We deliberately don't sync filters back to the server
  // until Save — but we DO refresh from the profile when the renderer
  // changes (e.g. user picks a different output to edit).
  const [filters, setFilters] = useState([])
  // v1.1.32.0 — `enabled` is a PROP now, not draft state with a checkbox in
  // this body. The switch lives on the section's heading and writes straight
  // through, because a toggle that collapses its own section would otherwise
  // hide the Save button needed to commit it. This section no longer sends
  // peq_enabled at all: saveProfile merges a patch, so leaving the key out is what
  // keeps the heading's value authoritative.
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState(null)
  const [error, setError] = useState(null)

  // Pull filters from the profile when it loads or renderer changes
  useEffect(() => {
    if (!profile) {
      setFilters([])
      return
    }
    // Deep-clone so our edits don't mutate the parent's profile reference
    setFilters((profile.peq_filters || []).map(f => ({ ...f })))
  }, [profile, rendererId])

  // Magnitude curve — recomputed on every filter change. Cheap (O(filters ×
  // 121 points)), runs on every keystroke without lag.
  const curve = useMemo(() => magnitudeResponse(filters), [filters])
  const peakDb = useMemo(() => calculatePeakGain(filters), [filters])
  const autoPreamp = -peakDb   // server applies the negative on save

  const update = (idx, patch) => {
    setFilters(prev => prev.map((f, i) => i === idx ? { ...f, ...patch } : f))
  }
  const addFilter = () => {
    if (filters.length >= MAX_FILTERS) return
    setFilters(prev => [...prev, newFilter()])
  }
  const removeFilter = (idx) => {
    setFilters(prev => prev.filter((_, i) => i !== idx))
  }
  const resetAll = () => {
    if (!window.confirm('Clear all PEQ filters?')) return
    setFilters([])
  }

  const save = async () => {
    if (!rendererId) return
    setSaving(true); setError(null)
    try {
      const r = await api.put(`/dsp/profile/${encodeURIComponent(rendererId)}`, {
        peq_filters: filters,
        // Note: peq_preamp_db is server-calculated. We don't send it.
        // Sending autoeq_model: null clears any previous AutoEQ label since
        // the user has now manually edited — the chain no longer reflects
        // a single AutoEQ preset.
        autoeq_model: null,
      })
      onProfileChange?.(r)
      setSavedAt(Date.now())
    } catch (e) {
      setError(e.message || 'Save failed')
    } finally { setSaving(false) }
  }

  // "Dirty" check: did the local state diverge from what's on the server?
  const dirty = profile && (
    JSON.stringify(filters) !== JSON.stringify(profile.peq_filters || [])
  )

  return (
    <div>
      <div style={s.helpRow}>
        <HelpTooltip>
          Each filter is a biquad applied to the audio after volume levelling.
          Peaks add gain at the centre frequency; shelves apply gain above
          (high) or below (low) the corner. The system automatically applies
          a negative preamp on save to keep the chain below 0 dBFS.
        </HelpTooltip>
      </div>

      {profile?.autoeq_model && (
        <div style={s.autoeqBadge}>
          Loaded from <b>{profile.autoeq_model}</b>. Editing here will detach
          the manual setting from the AutoEQ preset.
        </div>
      )}

      {/* Frequency response graph */}
      <FrequencyResponseGraph curve={curve} filters={filters} />

      {/* Filter rows */}
      <div style={s.filterList}>
        {filters.length === 0 ? (
          <div style={s.empty}>No filters yet. Tap "Add filter" below.</div>
        ) : filters.map((f, i) => (
          <FilterRow
            key={i}
            filter={f}
            onChange={patch => update(i, patch)}
            onRemove={() => removeFilter(i)}
          />
        ))}
      </div>

      {/* Toolbar — add / reset */}
      <div style={s.toolbar}>
        <button
          type="button"
          style={{ ...s.toolBtn, ...(filters.length >= MAX_FILTERS ? s.toolBtnDis : {}) }}
          onClick={addFilter}
          disabled={filters.length >= MAX_FILTERS}
          title={filters.length >= MAX_FILTERS ? `Max ${MAX_FILTERS} filters` : 'Add filter'}
        >
          <Plus size={12} />
          Add filter
        </button>
        {filters.length > 0 && (
          <button
            type="button"
            style={s.toolBtnGhost}
            onClick={resetAll}
            title="Remove all filters"
          >
            <RotateCcw size={12} />
            Clear all
          </button>
        )}
        <span style={s.filterCount}>{filters.length} / {MAX_FILTERS}</span>
      </div>

      {/* Stats — peak gain + preamp the server will apply on save */}
      <div style={s.stats}>
        <div style={s.statBlock}>
          <div style={s.statLabel}>Peak gain</div>
          <div style={{ ...s.statValue, color: peakDb > 0 ? '#ff8888' : 'var(--text-primary)' }}>
            {peakDb > 0 ? '+' : ''}{peakDb.toFixed(2)} dB
          </div>
        </div>
        <div style={s.statBlock}>
          <div style={s.statLabel}>Auto-preamp on save</div>
          <div style={s.statValue}>{autoPreamp.toFixed(2)} dB</div>
        </div>
        <div style={s.statBlock}>
          <div style={s.statLabel}>Currently saved preamp</div>
          <div style={s.statValue}>
            {profile?.peq_preamp_db != null ? `${Number(profile.peq_preamp_db).toFixed(2)} dB` : '—'}
          </div>
        </div>
      </div>

      {/* Enable toggle + Save */}

      {error && <div style={s.error}>{error}</div>}

      <div style={s.saveRow}>
        <button
          type="button"
          style={{ ...s.saveBtn, ...((!dirty || saving) ? s.saveBtnDis : {}) }}
          disabled={!dirty || saving}
          onClick={save}
        >
          <Save size={12} />
          {saving ? 'Saving…' : (savedAt && !dirty ? 'Saved' : 'Save PEQ')}
        </button>
      </div>
    </div>
  )
}

// One filter editor row — type dropdown + freq slider + Q slider + gain
// slider + remove button. Each slider has a value display so the user can
// see exact values rather than reading them off the slider position.
function FilterRow({ filter, onChange, onRemove }) {
  return (
    <div style={s.row2}>
      <select
        value={filter.type || 'PK'}
        onChange={e => onChange({ type: e.target.value })}
        style={s.typeSelect}
      >
        {FILTER_TYPES.map(t => (
          <option key={t.id} value={t.id}>{t.label}</option>
        ))}
      </select>

      <FilterSlider
        label="Hz"
        min={20} max={20000} step={1}
        // Frequency uses log scale for sane slider feel — 20-200 Hz takes
        // the same slider distance as 2-20 kHz.
        value={filter.fc}
        onChange={v => onChange({ fc: v })}
        format={v => v < 1000 ? `${Math.round(v)} Hz` : `${(v/1000).toFixed(2)} kHz`}
        log
      />
      <FilterSlider
        label="Q"
        min={0.1} max={10} step={0.05}
        value={filter.q}
        onChange={v => onChange({ q: v })}
        format={v => v.toFixed(2)}
      />
      <FilterSlider
        label="dB"
        min={-20} max={20} step={0.1}
        value={filter.gain}
        onChange={v => onChange({ gain: v })}
        format={v => `${v >= 0 ? '+' : ''}${v.toFixed(1)}`}
      />
      <button
        type="button"
        style={s.removeBtn}
        onClick={onRemove}
        aria-label="Remove filter"
      >
        <Trash2 size={11} />
      </button>
    </div>
  )
}

// Slider with a value label and optional log scaling. Log mode means the
// slider value is treated as a log-frequency: 0..1 maps to log10(min)..log10(max).
// This makes it as easy to set 50 Hz as 5 kHz — both are equally far from
// each end.
function FilterSlider({ label, min, max, step, value, onChange, format, log }) {
  // Map between linear slider position and log-frequency value when log=true
  const slMin = log ? Math.log10(min) : min
  const slMax = log ? Math.log10(max) : max
  const slVal = log ? Math.log10(Math.max(min, Math.min(max, value))) : value
  const slStep = log ? (slMax - slMin) / 1000 : step  // smooth log slider

  const handle = (e) => {
    const raw = Number(e.target.value)
    const real = log ? Math.pow(10, raw) : raw
    onChange(real)
  }
  return (
    <label style={s.sliderLabel}>
      <span style={s.sliderText}>{label}</span>
      <input
        type="range"
        min={slMin} max={slMax} step={slStep}
        value={slVal}
        onChange={handle}
        style={s.slider}
      />
      <span style={s.sliderVal}>{format(value)}</span>
    </label>
  )
}

// SVG frequency-response graph. Log-frequency x-axis (20 Hz to 20 kHz),
// linear-dB y-axis (-24 to +24 dB). Plots the combined chain as a strong
// line and individual filters as faint guides.
function FrequencyResponseGraph({ curve, filters }) {
  const ref = useRef(null)
  // Container width is observed so the SVG fills the available space.
  // We can't use 100% width directly because we need pixel coordinates for
  // the polyline. ResizeObserver is the modern way; a simple useEffect on
  // mount is enough for our needs since rotation/window-resize is rare.
  const [width, setWidth] = useState(360)
  useEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver(entries => {
      for (const e of entries) setWidth(Math.max(200, Math.floor(e.contentRect.width)))
    })
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])

  const HEIGHT = 140
  const PAD_L = 30
  const PAD_R = 8
  const PAD_T = 8
  const PAD_B = 22
  const plotW = width - PAD_L - PAD_R
  const plotH = HEIGHT - PAD_T - PAD_B

  // Coordinate mapping. Frequency is log10-scaled; dB is linear.
  const fMin = 20, fMax = 20000
  const dbMin = -24, dbMax = 24
  const xOf = (hz) => PAD_L + plotW * (Math.log10(hz) - Math.log10(fMin)) / (Math.log10(fMax) - Math.log10(fMin))
  const yOf = (db) => PAD_T + plotH * (1 - (db - dbMin) / (dbMax - dbMin))

  // Build polyline points string: "x1,y1 x2,y2 ..."
  const polyPoints = (gains) =>
    curve.freqs.map((f, i) => `${xOf(f).toFixed(1)},${yOf(gains[i]).toFixed(1)}`).join(' ')

  const gridFreqs = [50, 100, 200, 500, 1000, 2000, 5000, 10000]
  const gridDbs   = [-18, -12, -6, 0, 6, 12, 18]
  const fmtFreq = (f) => f >= 1000 ? `${f/1000}k` : `${f}`

  return (
    <div ref={ref} style={s.graphWrap} className="peq-graph">
      <svg width={width} height={HEIGHT} style={s.graphSvg}>
        {/* Background */}
        <rect x={PAD_L} y={PAD_T} width={plotW} height={plotH} fill="rgba(var(--tint-rgb), 0.02)" />

        {/* Vertical gridlines (frequencies) */}
        {gridFreqs.map(f => (
          <g key={f}>
            <line x1={xOf(f)} y1={PAD_T} x2={xOf(f)} y2={PAD_T + plotH}
              stroke="rgba(var(--tint-rgb), 0.06)" strokeWidth={1} />
            <text x={xOf(f)} y={HEIGHT - 6} textAnchor="middle"
              fontSize="9" fill="rgba(var(--tint-rgb), 0.4)" fontFamily="monospace">
              {fmtFreq(f)}
            </text>
          </g>
        ))}

        {/* Horizontal gridlines (dB) */}
        {gridDbs.map(db => (
          <g key={db}>
            <line x1={PAD_L} y1={yOf(db)} x2={PAD_L + plotW} y2={yOf(db)}
              stroke={db === 0 ? 'rgba(var(--tint-rgb), 0.18)' : 'rgba(var(--tint-rgb), 0.06)'}
              strokeWidth={1} />
            <text x={PAD_L - 4} y={yOf(db) + 3} textAnchor="end"
              fontSize="9" fill="rgba(var(--tint-rgb), 0.4)" fontFamily="monospace">
              {db > 0 ? '+' : ''}{db}
            </text>
          </g>
        ))}

        {/* Per-filter contributions — faint, so the user can see which knob
            does what without losing the combined response. */}
        {curve.perFilter.map((g, i) => (
          <polyline key={i}
            points={polyPoints(g)}
            fill="none"
            stroke="rgba(91,127,255,0.35)"
            strokeWidth="1"
          />
        ))}

        {/* Combined response — bold accent colour. This is the curve the
            audio chain will actually produce. */}
        {filters.length > 0 && (
          <polyline
            points={polyPoints(curve.gains)}
            fill="none"
            stroke="var(--accent)"
            strokeWidth="2"
          />
        )}

        {/* Frame */}
        <rect x={PAD_L} y={PAD_T} width={plotW} height={plotH}
          fill="none" stroke="rgba(var(--tint-rgb), 0.12)" strokeWidth={1} />
      </svg>
    </div>
  )
}

const s = {
  help: { fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.5, marginBottom: 8 },
  helpRow: { display: 'flex', justifyContent: 'flex-end', marginTop: -2, marginBottom: 4 },
  autoeqBadge: {
    fontSize: 11, color: 'var(--text-secondary)',
    padding: '6px 10px',
    background: 'var(--accent-dim)',
    borderRadius: 'var(--radius-sm)',
    marginBottom: 8,
  },

  graphWrap: {
    background: 'var(--bg-overlay)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    padding: 4,
    marginBottom: 10,
  },
  graphSvg: { display: 'block', width: '100%' },

  filterList: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 6 },
  empty: {
    padding: '14px',
    textAlign: 'center',
    fontSize: 11, color: 'var(--text-tertiary)',
    background: 'var(--bg-overlay)',
    border: '1px dashed var(--border)',
    borderRadius: 'var(--radius-sm)',
  },

  // Filter row — desktop has type-select + 3 sliders + remove inline.
  // On phone the sliders stack to keep the touch targets large enough.
  row2: {
    display: 'grid',
    gridTemplateColumns: '70px 1fr 1fr 1fr 26px',
    alignItems: 'center', gap: 5,
    padding: '7px 8px',
    background: 'var(--bg-overlay)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
  },
  typeSelect: {
    padding: '4px 4px',
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border)',
    borderRadius: 4,
    color: 'var(--text-primary)',
    fontSize: 10,
    minWidth: 0,
  },
  sliderLabel: {
    display: 'grid',
    gridTemplateColumns: '14px 1fr',
    alignItems: 'center',
    gap: 4,
    minWidth: 0,
  },
  sliderText: { fontSize: 9, color: 'var(--text-tertiary)', fontFamily: 'monospace', textTransform: 'uppercase' },
  slider: {
    width: '100%', minWidth: 0,
    accentColor: 'var(--accent)',
    gridColumn: '1 / 3',
  },
  sliderVal: {
    fontSize: 9, fontFamily: 'monospace',
    color: 'var(--text-secondary)',
    textAlign: 'center',
    gridColumn: '1 / 3',
  },
  removeBtn: {
    width: 24, height: 24,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--bg-elevated)',
    color: '#ff8888',
    border: '1px solid var(--border)',
    borderRadius: 4,
    padding: 0, cursor: 'pointer',
  },

  toolbar: {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '6px 0',
  },
  toolBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    padding: '5px 10px',
    background: 'var(--bg-elevated)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 11, fontWeight: 600, cursor: 'pointer',
  },
  toolBtnDis: { opacity: 0.4, cursor: 'not-allowed' },
  toolBtnGhost: {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    padding: '5px 10px',
    background: 'none',
    color: 'var(--text-tertiary)',
    border: '1px solid transparent',
    borderRadius: 'var(--radius-sm)',
    fontSize: 11, fontWeight: 500, cursor: 'pointer',
  },
  filterCount: {
    marginLeft: 'auto',
    fontSize: 10, color: 'var(--text-tertiary)',
    fontFamily: 'monospace',
  },

  stats: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: 6,
    padding: '8px 0',
  },
  statBlock: {
    padding: '6px 8px',
    background: 'var(--bg-overlay)',
    border: '1px solid var(--border)',
    borderRadius: 4,
  },
  statLabel: {
    fontSize: 9, color: 'var(--text-tertiary)',
    textTransform: 'uppercase', letterSpacing: '0.05em',
  },
  statValue: {
    fontSize: 13, fontWeight: 700,
    color: 'var(--text-primary)',
    fontFamily: 'monospace',
    marginTop: 2,
  },

  row: { padding: '6px 0' },
  label: {
    display: 'flex', alignItems: 'center', gap: 8,
    fontSize: 13, color: 'var(--text-primary)',
    cursor: 'pointer', userSelect: 'none',
  },
  checkbox: { width: 14, height: 14, accentColor: 'var(--accent)' },

  error: {
    padding: '6px 10px',
    fontSize: 12, color: '#ff6b6b',
    background: 'rgba(255,90,90,0.1)',
    border: '1px solid rgba(255,90,90,0.35)',
    borderRadius: 'var(--radius-sm)',
    marginBottom: 8,
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
    color: 'var(--on-accent)', border: 'none',
    borderRadius: 'var(--radius-sm)',
    fontSize: 12, fontWeight: 600, cursor: 'pointer',
  },
  saveBtnDis: { opacity: 0.4, cursor: 'not-allowed' },
}
