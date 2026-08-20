// CpuTweaksSection — Settings → CPU Tweaks sub-page.
//
// v1.1.3.5 — first cut.
//
// Shows:
//   - Detected CPU model + core count
//   - Currently effective scan limits (concurrency + temp ceiling)
//   - Live CPU temperature (polled every 2 s)
//   - Two number inputs to override concurrency + ceiling
//   - "Apply suggested defaults" button — fills the inputs with
//     whatever the auto-detect bucket suggests
//   - "Save" button — persists to DB
//
// Why no automatic application of suggested defaults: the hardware
// classifier is best-effort. If it gets your machine wrong, the
// suggested defaults could be too aggressive (overheating) or too
// conservative (slow scans). The user has the final say.
//
// Why no graph: scope-cut for v1.1.3.5. Live temperature is shown
// as a single number with a colour cue (green if under ceiling,
// amber if approaching, red if at/above). A real-time graph might
// land in a later release.

import { useEffect, useState } from 'react'
import { Cpu, Save, Sparkles } from 'lucide-react'
import { api } from '../api'
import HelpTooltip from './HelpTooltip'

export default function CpuTweaksSection() {
  // Server data
  const [cpuInfo, setCpuInfo] = useState(null)
  const [settings, setSettings] = useState(null)

  // Local edits — only flushed to server on Save
  const [editConcurrency, setEditConcurrency] = useState('')
  const [editTempCeiling, setEditTempCeiling] = useState('')
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState(null)
  // v1.1.3.6 — collapsible sensor diagnostics
  const [showSensorDiag, setShowSensorDiag] = useState(false)

  // Initial fetch
  useEffect(() => {
    api.get('/settings/cpu').then(d => {
      setCpuInfo(d)
      // Initialise edit fields from current effective values
      setEditConcurrency(String(d.current.concurrency))
      setEditTempCeiling(String(d.current.tempCeiling))
    }).catch(() => {})
    api.get('/settings').then(setSettings).catch(() => {})
  }, [])

  // Live temp polling — every 2 s while the page is open. Only
  // refreshes the cpuTempC field; the rest of the page stays put.
  useEffect(() => {
    let mounted = true
    const tick = () => {
      api.get('/settings/cpu').then(d => {
        if (mounted) setCpuInfo(prev => prev ? { ...prev, cpuTempC: d.cpuTempC } : d)
      }).catch(() => {})
    }
    const id = setInterval(tick, 2000)
    return () => { mounted = false; clearInterval(id) }
  }, [])

  if (!cpuInfo) {
    return <div style={s.loading}>Detecting CPU…</div>
  }

  const applySuggested = () => {
    setEditConcurrency(String(cpuInfo.suggested.concurrency))
    setEditTempCeiling(String(cpuInfo.suggested.tempCeiling))
  }

  const save = async () => {
    setSaving(true)
    try {
      await api.patch('/settings', {
        vl_max_concurrency: parseInt(editConcurrency, 10),
        vl_max_cpu_temp_c:  parseInt(editTempCeiling, 10),
      })
      // Re-fetch the cpu summary so "current" reflects what we just saved
      const d = await api.get('/settings/cpu')
      setCpuInfo(d)
      setSavedAt(Date.now())
    } catch (e) {
      // Silent — the user will notice the values didn't update if a save fails
    }
    setSaving(false)
  }

  // Visual cue on the live temp: green / amber / red based on
  // distance to ceiling.
  const tempColour = (() => {
    const t = cpuInfo.cpuTempC
    const ceil = cpuInfo.current.tempCeiling
    if (t === null || t === undefined) return 'var(--text-secondary)'
    if (t >= ceil) return 'var(--red, #d62828)'
    if (t >= ceil - 5) return 'var(--amber, #e8a44a)'
    return 'var(--green, #4caf82)'
  })()

  // Has the user edited away from current?
  const isDirty =
    parseInt(editConcurrency, 10) !== cpuInfo.current.concurrency ||
    parseInt(editTempCeiling, 10) !== cpuInfo.current.tempCeiling

  return (
    <div style={s.wrap}>
      {/* Detected hardware panel */}
      <div style={s.panel}>
        <div style={s.panelTitle}>
          <Cpu size={14} style={{ marginRight: 6, verticalAlign: '-2px' }} />
          Detected hardware
        </div>
        <div style={s.row}>
          <div style={s.rowLabel}>CPU</div>
          <div style={s.rowValue}>{cpuInfo.detected.label}</div>
        </div>
        <div style={s.row}>
          <div style={s.rowLabel}>Cores</div>
          <div style={s.rowValue}>{cpuInfo.detected.cores}</div>
        </div>
        <div style={s.row}>
          <div style={s.rowLabel}>Profile bucket</div>
          <div style={s.rowValue}>{cpuInfo.detected.bucket}</div>
        </div>
        <div style={s.row}>
          <div style={s.rowLabel}>Live temperature</div>
          <div style={{ ...s.rowValue, color: tempColour, fontWeight: 600 }}>
            {cpuInfo.cpuTempC !== null && cpuInfo.cpuTempC !== undefined
              ? `${cpuInfo.cpuTempC.toFixed(1)}°C`
              : '—'}
          </div>
        </div>
        {/* v1.1.3.6 — sensor diagnostics. Always show which sensor
            we picked. Clicking reveals all sensors found on the host
            so users on weird hardware can see why we picked what we
            picked, and report problems with concrete data. */}
        {cpuInfo.sensor && (
          <>
            <div style={s.row}>
              <div style={s.rowLabel}>Sensor in use</div>
              <div style={s.rowValue}>{cpuInfo.sensor.type || '—'}</div>
            </div>
            {cpuInfo.sensor.candidates && cpuInfo.sensor.candidates.length > 1 && (
              <button
                type="button"
                style={s.diagToggle}
                onClick={() => setShowSensorDiag(v => !v)}>
                {showSensorDiag ? 'Hide' : 'Show'} all detected sensors ({cpuInfo.sensor.candidates.length})
              </button>
            )}
            {showSensorDiag && cpuInfo.sensor.candidates.length > 0 && (
              <div style={s.diagList}>
                {cpuInfo.sensor.candidates.map((c, i) => (
                  <div key={`${c.source}-${c.type}-${i}`} style={s.diagRow}>
                    <span style={s.diagType}>{c.type}</span>
                    <span style={s.diagSrc}>{c.source}</span>
                    <span style={s.diagValue}>{c.valueC.toFixed(1)}°C</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Suggested defaults panel */}
      <div style={s.panel}>
        <div style={s.panelTitle}>
          <Sparkles size={14} style={{ marginRight: 6, verticalAlign: '-2px' }} />
          Suggested for this hardware
          <HelpTooltip>
            Suggestions are auto-detected based on your CPU type.
            They're starting points, not guarantees — every install
            has different cooling and ambient temperatures.
            Review and adjust below.
          </HelpTooltip>
        </div>
        <div style={s.row}>
          <div style={s.rowLabel}>Concurrent workers</div>
          <div style={s.rowValue}>{cpuInfo.suggested.concurrency}</div>
        </div>
        <div style={s.row}>
          <div style={s.rowLabel}>Temperature ceiling</div>
          <div style={s.rowValue}>{cpuInfo.suggested.tempCeiling}°C</div>
        </div>
        <button type="button" style={s.applyBtn} onClick={applySuggested}>
          Use suggested values
        </button>
      </div>

      {/* Editable settings */}
      <div style={s.panel}>
        <div style={s.panelTitle}>Scan limits</div>

        <div style={s.editRow}>
          <label style={s.editLabel}>
            Concurrent workers
            <HelpTooltip>
              How many tracks the loudness scan analyses in parallel.
              Higher = faster scans but more CPU load and heat.
              Recommended: 1 to {cpuInfo.detected.cores - 1} (leaves
              headroom for the system to stay responsive).
            </HelpTooltip>
          </label>
          <input
            type="number"
            min={1}
            max={16}
            value={editConcurrency}
            onChange={e => setEditConcurrency(e.target.value)}
            style={s.input}
          />
        </div>

        <div style={s.editRow}>
          <label style={s.editLabel}>
            Temperature ceiling (°C)
            <HelpTooltip>
              Scan workers pause if CPU temperature reaches this value.
              Lower = quieter and cooler but slower scans (workers
              spend time waiting). Higher = faster but warmer.
              Most CPUs are safe up to 80°C+ but you may not want
              that in a quiet room.
            </HelpTooltip>
          </label>
          <input
            type="number"
            min={40}
            max={95}
            value={editTempCeiling}
            onChange={e => setEditTempCeiling(e.target.value)}
            style={s.input}
          />
        </div>

        <div style={s.actionRow}>
          <button
            type="button"
            style={isDirty ? s.saveBtn : s.saveBtnDisabled}
            onClick={save}
            disabled={saving || !isDirty}>
            <Save size={14} style={{ marginRight: 6, verticalAlign: '-2px' }} />
            {saving ? 'Saving…' : (savedAt && !isDirty ? 'Saved' : 'Save')}
          </button>
        </div>

        <div style={s.note}>
          Changes apply on the next loudness scan. Currently in
          effect: {cpuInfo.current.concurrency} workers,{' '}
          {cpuInfo.current.tempCeiling}°C ceiling.
        </div>
      </div>
    </div>
  )
}

const s = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 14 },
  loading: { padding: 14, color: 'var(--text-secondary)', fontSize: 13 },

  panel: {
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border)',
    borderRadius: 10,
    padding: 14,
  },
  panelTitle: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: 'var(--text-secondary)',
    marginBottom: 10,
    display: 'flex',
    alignItems: 'center',
  },

  row: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '6px 0',
    borderBottom: '1px solid var(--border)',
  },
  rowLabel: { fontSize: 13, color: 'var(--text-secondary)' },
  rowValue: { fontSize: 13, color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' },

  editRow: { display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 0' },
  editLabel: {
    fontSize: 13, color: 'var(--text-primary)',
    display: 'flex', alignItems: 'center',
  },
  input: {
    background: 'var(--bg-overlay)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-bright)',
    borderRadius: 6,
    padding: '8px 10px',
    fontSize: 14,
    fontFamily: 'var(--font-mono)',
    width: 100,
  },

  applyBtn: {
    marginTop: 10,
    padding: '8px 14px',
    background: 'transparent',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-bright)',
    borderRadius: 8,
    fontSize: 13, fontWeight: 600,
    cursor: 'pointer',
  },

  actionRow: { display: 'flex', justifyContent: 'flex-end', marginTop: 6 },

  saveBtn: {
    padding: '8px 16px',
    background: 'var(--accent)',
    color: 'var(--on-accent)',
    border: 'none',
    borderRadius: 8,
    fontSize: 13, fontWeight: 600,
    cursor: 'pointer',
    display: 'flex', alignItems: 'center',
  },
  saveBtnDisabled: {
    padding: '8px 16px',
    background: 'var(--bg-overlay)',
    color: 'var(--text-tertiary)',
    border: 'none',
    borderRadius: 8,
    fontSize: 13, fontWeight: 600,
    cursor: 'default',
    display: 'flex', alignItems: 'center',
  },

  note: {
    marginTop: 10,
    fontSize: 11,
    color: 'var(--text-tertiary)',
    lineHeight: 1.5,
  },

  // v1.1.3.6 — sensor diagnostics
  diagToggle: {
    marginTop: 8,
    background: 'transparent',
    border: 'none',
    color: 'var(--text-tertiary)',
    cursor: 'pointer',
    fontSize: 11,
    textDecoration: 'underline',
    padding: '2px 0',
    fontFamily: 'inherit',
    display: 'block',
  },
  diagList: {
    marginTop: 6,
    padding: '8px 10px',
    background: 'var(--bg-overlay)',
    borderRadius: 6,
    fontSize: 11,
    fontFamily: 'var(--font-mono)',
  },
  diagRow: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 12,
    padding: '3px 0',
    color: 'var(--text-secondary)',
  },
  diagType: { flex: 1, color: 'var(--text-primary)' },
  diagSrc: { color: 'var(--text-tertiary)', fontSize: 10 },
  diagValue: { fontFamily: 'var(--font-mono)', fontWeight: 600 },
}
