import React, { useEffect, useState, useCallback } from 'react'
import { api } from '../api'
import { RefreshCw, Volume2, AlertCircle, Cable, ChevronLeft, ChevronRight, Speaker, Radio, Wifi, HardDrive, Edit2, Image as ImageIcon, Check, X } from 'lucide-react'
import RendererIcon from './RendererIcon'
import RendererIconPicker from './RendererIconPicker'

// Audio settings UI (#v1.1.0.0, consolidated #v1.1.0.8)
// =====================================================
//
// Lists every output device musicd knows about -- USB DACs, Sonos
// devices, DLNA renderers, and Squeezelite players -- in one place.
// Each device has its own settings sub-page (back arrow returns to
// the list).
//
// Per-device settings vary by device type:
//   All: output_mode (fixed/variable), DSP bypass, custom icon
//   USB DAC: + DSD mode, test tone, capability summary
//   Sonos:   + force 16-bit toggle
//
// Settings persist across disconnects (renderer_settings table is
// keyed by renderer ID, which is stable for a given physical device).
// Disconnected devices appear greyed out so users can preview/tweak
// settings before plugging hardware back in.

export default function AudioSection() {
  const [devices, setDevices] = useState([])
  const [loading, setLoading]  = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [selectedId, setSelectedId] = useState(null)
  // v1.1.0.93 — USB DAC diagnostic sheet state
  const [showUsbDiag, setShowUsbDiag] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await api.get('/audio/all')
      setDevices(r.devices || [])
    } catch (e) {
      console.warn('Audio devices load failed:', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Re-fetch every 10s while the section is visible so the list
  // reacts to live discovery changes (DAC plugged in, Sonos went
  // offline, etc). Less responsive than push but very simple.
  useEffect(() => {
    const t = setInterval(load, 10000)
    return () => clearInterval(t)
  }, [load])

  const refresh = async () => {
    setRefreshing(true)
    try {
      await api.post('/audio/refresh').catch(() => {})
      await load()
    } finally {
      setRefreshing(false)
    }
  }

  // Per-device settings update. Optimistic local update + server
  // persistence; if the server rejects, the next load() corrects it.
  // v1.1.0.68 — when the patch includes custom_name we also have to
  // recompute the displayed `name` field so the header / list row
  // updates immediately. Empty string / null in custom_name reverts
  // to the discovered_name.
  const updateSettings = useCallback(async (id, patch) => {
    setDevices(prev => prev.map(d => {
      if (d.id !== id) return d
      const next = { ...d, ...patch }
      if ('custom_name' in patch) {
        const trimmed = (patch.custom_name || '').trim()
        next.custom_name = trimmed || null
        // discovered_name is set by the server in /audio/all from
        // v1.1.0.68 onwards. For rows that pre-date this release
        // (still in our local state from before reload) fall back
        // to the existing name as the discovered fallback.
        const fallback = d.discovered_name || d.name
        next.name = next.custom_name || fallback
        // Lock in the discovered_name on the local row so the
        // "was: …" subline can render correctly until the next
        // /audio/all confirms it.
        if (!next.discovered_name) next.discovered_name = fallback
      }
      return next
    }))
    try {
      await api.post(`/audio/renderers/${encodeURIComponent(id)}/settings`, patch)
    } catch (e) {
      console.warn('Settings update failed:', e)
      load() // revert from server
    }
  }, [load])

  // Per-device sub-page navigation. We use internal state rather
  // than the global settingsSubSection because this is a level
  // deeper than the Section system (Settings → Audio → <device>).
  if (selectedId) {
    const device = devices.find(d => d.id === selectedId)
    if (!device) {
      // Device disappeared while we were on its page (unplugged).
      // Bump back to the list rather than rendering an empty page.
      setSelectedId(null)
      return null
    }
    return (
      <DeviceSettingsPage
        device={device}
        onBack={() => setSelectedId(null)}
        onUpdate={(patch) => updateSettings(device.id, patch)}
        onReload={load}
      />
    )
  }

  if (loading) {
    return <div style={s.loading}>Loading audio devices…</div>
  }

  // Group by type for the list view. Each group has a header.
  const grouped = groupByType(devices)
  const totalDevices = devices.length

  return (
    <div>
      <div style={s.toolbar}>
        <div style={s.toolbarText}>
          {totalDevices === 0
            ? 'No output devices found'
            : `${totalDevices} output device${totalDevices === 1 ? '' : 's'}`}
        </div>
        <button
          style={s.refreshBtn}
          onClick={refresh}
          disabled={refreshing}
          aria-label="Refresh">
          <RefreshCw size={14} style={refreshing ? { animation: 'spin 1s linear infinite' } : {}} />
        </button>
      </div>

      {totalDevices === 0 && (
        <div style={s.empty}>
          <Cable size={32} style={{ color: 'var(--text-tertiary)', marginBottom: 12 }} />
          <div style={{ fontSize: 14, marginBottom: 6 }}>No output devices yet.</div>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 14 }}>
            Plug in a USB DAC, or wait for Sonos / DLNA / Squeezelite discovery to find devices on your network.
          </div>
          {/* v1.1.0.94 — Diagnose button surfaced in the empty state too.
              v93 added it only when other devices were present; users
              with NO devices (e.g. expecting a USB DAC that isn't
              showing) had no way to find out why. */}
          <button
            style={s.usbDiagBtn}
            onClick={() => setShowUsbDiag(true)}
          >
            Diagnose USB DAC
          </button>
        </div>
      )}

      {GROUP_ORDER.map(type => {
        const list = grouped[type] || []
        if (list.length === 0) return null
        return (
          <div key={type} style={s.group}>
            <div style={s.groupHeader}>{TYPE_LABELS[type] || type}</div>
            {list.map(device => (
              <DeviceListItem
                key={device.id}
                device={device}
                onTap={() => setSelectedId(device.id)}
              />
            ))}
          </div>
        )
      })}

      {/* v1.1.0.93 — USB DAC diagnostic. Shown when there are
          devices listed (so the user isn't on the empty state) but
          no USB DACs among them. The user might be expecting one
          and wondering why it's missing. The link opens a sheet
          that runs /api/audio/usb-diagnostics and presents a
          checklist. */}
      {totalDevices > 0 && (grouped.usb_dac || []).length === 0 && (
        <div style={s.usbDiagBanner}>
          <span style={{ flex: 1 }}>
            Don't see your USB DAC?
          </span>
          <button
            style={s.usbDiagBtn}
            onClick={() => setShowUsbDiag(true)}
          >
            Diagnose
          </button>
        </div>
      )}

      <div style={s.footnote}>
        Tap a device to configure it. Disconnected devices keep their settings, so unplugging and reconnecting picks up where you left off.
      </div>

      {showUsbDiag && (
        <UsbDiagSheet onClose={() => setShowUsbDiag(false)} />
      )}
    </div>
  )
}

// ── USB DAC diagnostic sheet (v1.1.0.93) ────────────────────────────
//
// Renders a checklist of detection-pipeline status to help users
// figure out why their USB DAC isn't appearing. Calls
// /api/audio/usb-diagnostics which is read-only and side-effect-free.
function UsbDiagSheet({ onClose }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    api.get('/audio/usb-diagnostics')
      .then(r => { if (!cancelled) setData(r) })
      .catch(e => { if (!cancelled) setError(e?.message || 'Diagnostics failed') })
    return () => { cancelled = true }
  }, [])

  const Check = ({ ok, label, detail }) => (
    <div style={s.diagCheckRow}>
      <span style={{ color: ok ? '#5fd97f' : '#ff7766', fontWeight: 600, marginRight: 10 }}>
        {ok ? '✓' : '✗'}
      </span>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13 }}>{label}</div>
        {detail && <div style={s.diagDetail}>{detail}</div>}
      </div>
    </div>
  )

  return (
    <div style={s.diagOverlay} onClick={onClose}>
      <div style={s.diagSheet} onClick={e => e.stopPropagation()}>
        <div style={s.diagHeader}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>USB DAC Diagnostics</div>
          <button style={s.diagCloseBtn} onClick={onClose}>×</button>
        </div>
        {error && <div style={s.diagError}>Diagnostics failed: {error}</div>}
        {!data && !error && <div style={s.diagLoading}>Running checks…</div>}
        {data && (
          <>
            <Check
              ok={data.dev_snd_visible}
              label="/dev/snd accessible"
              detail={data.dev_snd_visible
                ? `${data.dev_snd_entries?.length || 0} device node(s) visible`
                : 'Container cannot see audio device nodes'} />
            <Check
              ok={data.proc_asound_visible}
              label="/proc/asound visible"
              detail={data.proc_asound_visible
                ? 'Host audio state readable for capability detection'
                : 'Falls back to aplay probing — slower but functional'} />
            <Check
              ok={data.aplay_works}
              label="aplay -l runs"
              detail={data.aplay_error || (data.aplay_works ? 'ALSA tools functional' : 'aplay failed')} />
            <Check
              ok={data.detect_returned > 0}
              label={`${data.detect_returned} USB DAC${data.detect_returned === 1 ? '' : 's'} detected`}
              detail={data.detected_devices?.map(d => `${d.name} (card ${d.card})`).join(', ') || null} />

            {data.advice && data.advice.length > 0 && (
              <div style={s.diagAdvice}>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Suggestions</div>
                {data.advice.map((a, i) => (
                  <div key={i} style={s.diagAdviceItem}>• {a}</div>
                ))}
              </div>
            )}

            {data.aplay_l_text && (
              <details style={{ marginTop: 12 }}>
                <summary style={s.diagDetailSummary}>Show raw `aplay -l` output</summary>
                <pre style={s.diagPre}>{data.aplay_l_text}</pre>
              </details>
            )}
            {data.proc_asound_cards_text && (
              <details style={{ marginTop: 8 }}>
                <summary style={s.diagDetailSummary}>Show /proc/asound/cards</summary>
                <pre style={s.diagPre}>{data.proc_asound_cards_text}</pre>
              </details>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ── Device list item ─────────────────────────────────────────────────

function DeviceListItem({ device, onTap }) {
  const Icon = ICON_FOR_TYPE[device.type] || Speaker
  return (
    <button
      style={{
        ...s.deviceRow,
        ...(device.connected ? {} : s.deviceRowDisconnected),
      }}
      onClick={onTap}>
      <div style={s.deviceIconCircle}>
        <Icon size={18} />
      </div>
      <div style={s.deviceText}>
        <div style={s.deviceName}>
          {device.name}
          {!device.connected && (
            <span style={s.disconnectedBadge}>offline</span>
          )}
        </div>
        <div style={s.deviceMeta}>
          {device.ip || (device.card !== undefined ? `card ${device.card}` : '')}
          {device.output_mode === 'fixed' && <span style={s.tag}>fixed</span>}
          {device.bypass_dsp && <span style={s.tag}>bypass</span>}
        </div>
      </div>
      <ChevronRight size={16} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
    </button>
  )
}

// ── Per-device settings sub-page ─────────────────────────────────────

function DeviceSettingsPage({ device, onBack, onUpdate, onReload }) {
  const [testing, setTesting] = useState(false)
  const [testError, setTestError] = useState(null)
  // v1.1.0.68 — inline name editor + icon picker for this zone.
  // The name editor is a controlled input that swaps in over the
  // static name when the user taps the edit pencil. Submitting
  // (Enter or the tick) calls onUpdate({ custom_name: ... });
  // empty string is canonicalised to null on the server, which
  // restores the discovered name. The icon picker reuses the
  // existing RendererIconPicker modal — only difference here is
  // the parent (this page) owns whether it's open.
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState(device.name || '')
  const [showIconPicker, setShowIconPicker] = useState(false)
  const [nameError, setNameError] = useState(null)

  const test = async () => {
    setTesting(true)
    setTestError(null)
    try {
      await api.post(`/audio/devices/${encodeURIComponent(device.id)}/test`)
    } catch (e) {
      setTestError(e.message || 'Test failed')
    } finally {
      setTesting(false)
    }
  }

  // Submit the name draft. Trim and apply; empty string is sent as
  // an explicit empty string so the server can canonicalise to null
  // (which restores the discovered name on next /audio/all load).
  const submitName = () => {
    const draft = (nameDraft || '').trim()
    // 60-char cap matches the server validation. Show an inline
    // message instead of letting the server bounce back.
    if (draft.length > 60) {
      setNameError('Too long (60 char limit)')
      return
    }
    setNameError(null)
    setEditingName(false)
    // Always send custom_name so an empty string clears any prior
    // override. The server treats '' === null.
    onUpdate({ custom_name: draft })
  }

  const cancelNameEdit = () => {
    setNameDraft(device.name || '')
    setNameError(null)
    setEditingName(false)
  }

  // Reset to discovered name. Sent as empty string so the server
  // canonicalises to null and the next /audio/all load shows the
  // discovered name again.
  const resetName = () => {
    onUpdate({ custom_name: '' })
    setEditingName(false)
    setNameError(null)
  }

  const isUsb   = device.type === 'usb_dac'
  const isSonos = device.type === 'sonos'

  return (
    <div>
      <div style={s.subHeader}>
        <button style={s.backBtn} onClick={onBack} aria-label="Back to device list">
          <ChevronLeft size={18} />
        </button>
        <div style={s.subTitle}>{device.name}</div>
        <div style={{ width: 36 }} />
      </div>

      {!device.connected && (
        <div style={s.disconnectedNotice}>
          This device is currently offline. Settings are preserved -- reconnect the hardware (or wait for the network device to reappear) to apply them.
        </div>
      )}

      {/* v1.1.0.68 — Identity (rename + icon).
          The user reported this feature had disappeared at some
          point. RendererIconPicker existed in the codebase but
          wasn't mounted anywhere; the rename column existed in the
          schema only after this release. Both now sit at the top
          of each device's settings page so they're discoverable. */}
      <div style={s.subSectionTitle}>Identity</div>

      <div style={s.identityRow}>
        <button
          style={s.iconTile}
          onClick={() => setShowIconPicker(true)}
          aria-label="Change icon"
          title="Change icon">
          <RendererIcon renderer={device} size={26} />
          <div style={s.iconTileEdit}><ImageIcon size={11} /></div>
        </button>

        <div style={s.identityText}>
          {editingName ? (
            <div style={s.nameEditRow}>
              <input
                type="text"
                value={nameDraft}
                onChange={e => setNameDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') submitName()
                  if (e.key === 'Escape') cancelNameEdit()
                }}
                placeholder="Zone name"
                maxLength={60}
                autoFocus
                style={s.nameInput}
              />
              <button style={s.nameOkBtn} onClick={submitName} title="Save"><Check size={14} /></button>
              <button style={s.nameCancelBtn} onClick={cancelNameEdit} title="Cancel"><X size={14} /></button>
            </div>
          ) : (
            <button style={s.nameDisplayBtn} onClick={() => { setNameDraft(device.name || ''); setEditingName(true); setNameError(null) }}>
              <span style={s.nameValue}>{device.name}</span>
              <Edit2 size={12} style={{ color: 'var(--text-tertiary)', marginLeft: 6, flexShrink: 0 }} />
            </button>
          )}
          {device.custom_name && device.discovered_name && device.custom_name !== device.discovered_name && !editingName && (
            <div style={s.nameDiscovered}>
              was: {device.discovered_name}
              <button style={s.nameResetBtn} onClick={resetName}>reset</button>
            </div>
          )}
          {nameError && <div style={s.nameError}>{nameError}</div>}
        </div>
      </div>

      {showIconPicker && (
        <RendererIconPicker
          renderer={device}
          onClose={() => setShowIconPicker(false)}
          onChange={() => { onReload && onReload() }}
        />
      )}

      {/* ─── Output mode ─────────────────────────────────────────── */}
      <div style={s.subSectionTitle}>Output mode</div>
      <ModeRow
        active={device.output_mode === 'variable' || !device.output_mode}
        title="Variable"
        sub="Volume slider controls this device. Default for most setups."
        onTap={() => onUpdate({ output_mode: 'variable' })}
      />
      <ModeRow
        active={device.output_mode === 'fixed'}
        title="Fixed"
        sub="Forces 100% on selection. Volume slider is hidden -- the downstream amp owns the volume."
        onTap={() => onUpdate({ output_mode: 'fixed' })}
      />

      {/* ─── DSP bypass ──────────────────────────────────────────── */}
      <div style={{ ...s.divider, margin: '20px 0 14px' }} />
      <div style={s.subSectionTitle}>DSP</div>
      <ToggleRow
        title="Bypass DSP"
        sub="Send unprocessed audio to this device. Loudness leveling, AutoEQ and PEQ are skipped."
        on={!!device.bypass_dsp}
        onChange={v => onUpdate({ bypass_dsp: v })}
      />

      {/* ─── Sonos: force 16-bit ─────────────────────────────────── */}
      {isSonos && (
        <>
          <div style={{ ...s.divider, margin: '20px 0 14px' }} />
          <div style={s.subSectionTitle}>Sonos pipeline</div>
          <ToggleRow
            title="Limit to 16-bit"
            sub="Truncates anything above 16-bit (with dither) before sending. Some users find this more reliable for Sonos streaming."
            on={!!device.sonos_force_16bit}
            onChange={v => onUpdate({ sonos_force_16bit: v })}
          />
        </>
      )}

      {/* ─── USB DAC: capabilities + DSD + test ──────────────────── */}
      {isUsb && (
        <>
          <div style={{ ...s.divider, margin: '20px 0 14px' }} />
          <div style={s.subSectionTitle}>Capabilities</div>
          <CapabilitySummary device={device} />

          {(device.dsdFormats?.length > 0 || device.dopMaxRate > 0) && (
            <>
              <div style={{ ...s.divider, margin: '20px 0 14px' }} />
              <div style={s.subSectionTitle}>DSD handling</div>
              <DsdModePicker
                value={device.dsd_mode || 'auto'}
                hasNative={device.hasNativeDsd}
                hasDoP={device.dopMaxRate > 0}
                onChange={v => onUpdate({ dsd_mode: v })}
              />
            </>
          )}

          <div style={{ ...s.divider, margin: '20px 0 14px' }} />
          <div style={s.subSectionTitle}>Test</div>
          <div style={s.help}>
            Plays a 2-second 1 kHz sine wave at low level through this DAC. Use it to confirm the audio path is wired up.
          </div>
          <button style={s.testBtn} onClick={test} disabled={testing}>
            <Volume2 size={13} />
            {testing ? ' Playing test tone…' : ' Play test tone'}
          </button>
          {testError && (
            <div style={s.errorBox}>
              <AlertCircle size={12} /> {testError}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── Helpers ──────────────────────────────────────────────────────────

function ModeRow({ active, title, sub, onTap }) {
  return (
    <button
      style={{ ...s.modeRow, ...(active ? s.modeRowActive : {}) }}
      onClick={onTap}>
      <div style={{ ...s.modeRadio, ...(active ? s.modeRadioActive : {}) }} />
      <div style={s.modeText}>
        <div style={s.modeTitle}>{title}</div>
        <div style={s.modeSub}>{sub}</div>
      </div>
    </button>
  )
}

function ToggleRow({ title, sub, on, onChange }) {
  return (
    <div style={s.toggleRow}>
      <div style={s.toggleText}>
        <div style={s.toggleTitle}>{title}</div>
        <div style={s.toggleSub}>{sub}</div>
      </div>
      <button
        style={{ ...s.toggle, ...(on ? s.toggleOn : {}) }}
        onClick={() => onChange(!on)}
        aria-pressed={on}>
        <div style={{ ...s.toggleKnob, ...(on ? s.toggleKnobOn : {}) }} />
      </button>
    </div>
  )
}

function CapabilitySummary({ device }) {
  // The /audio/all API nests live capability data under `capabilities`
  // (server/routes/audio.js). Earlier versions stored these as flat
  // properties on the device; this component now reads from either
  // location so it works during transitions and against either path.
  // (#v1.1.0.18)
  const caps = device.capabilities || device
  const pcmTop = caps.pcmRates?.length ? caps.pcmRates[caps.pcmRates.length - 1] : null
  const dsdTop = caps.dsdRates?.length ? caps.dsdRates[caps.dsdRates.length - 1] : null
  if (!pcmTop && !dsdTop) {
    return (
      <div style={s.help}>
        Capabilities not yet probed. Will show after the next discovery cycle, or tap the refresh button at the top of the Audio Devices page.
      </div>
    )
  }
  return (
    <div style={s.capRow}>
      {pcmTop && <Stat label="PCM" value={`up to ${formatRate(pcmTop)}`} />}
      {caps.pcmFormats?.length > 0 && (
        <Stat label="Formats" value={caps.pcmFormats.join(', ')} />
      )}
      {caps.maxChannels > 0 && <Stat label="Channels" value={caps.maxChannels} />}
      {dsdTop && <Stat label="DSD" value={`up to ${formatRate(dsdTop)}`} />}
      {caps.dopMaxRate > 0 && (
        <Stat label="DoP" value={`up to ${formatRate(caps.dopMaxRate)}`} />
      )}
      {caps.hasNativeDsd && <Stat label="Native DSD" value="yes" />}
    </div>
  )
}

function Stat({ label, value }) {
  return (
    <div style={s.statBlock}>
      <div style={s.statLabel}>{label}</div>
      <div style={s.statValue}>{value}</div>
    </div>
  )
}

function DsdModePicker({ value, hasNative, hasDoP, onChange }) {
  return (
    <div>
      <ModeRow
        active={value === 'auto'}
        title="Auto"
        sub="Pick the best available mode (native > DoP > PCM decode)."
        onTap={() => onChange('auto')}
      />
      <ModeRow
        active={value === 'pcm'}
        title="PCM decode"
        sub="Decode DSD to PCM in software before output. Most compatible."
        onTap={() => onChange('pcm')}
      />
      {hasDoP && (
        <ModeRow
          active={value === 'dop'}
          title="DoP (DSD over PCM)"
          sub="Wrap DSD samples in PCM frames. Requires DAC support."
          onTap={() => onChange('dop')}
        />
      )}
      {hasNative && (
        <ModeRow
          active={value === 'native'}
          title="Native DSD"
          sub="Send DSD samples directly to the DAC. Best fidelity if supported."
          onTap={() => onChange('native')}
        />
      )}
    </div>
  )
}

function formatRate(hz) {
  if (hz >= 1000) return `${(hz / 1000).toFixed(hz % 1000 === 0 ? 0 : 1)} kHz`
  return `${hz} Hz`
}

function groupByType(devices) {
  const groups = {}
  for (const d of devices) {
    const k = d.type || 'unknown'
    if (!groups[k]) groups[k] = []
    groups[k].push(d)
  }
  // Stable sort within each group: connected first, then alphabetical
  for (const k of Object.keys(groups)) {
    groups[k].sort((a, b) => {
      if (a.connected !== b.connected) return a.connected ? -1 : 1
      return (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' })
    })
  }
  return groups
}

const GROUP_ORDER = ['usb_dac', 'sonos', 'dlna', 'squeezelite', 'unknown']

const TYPE_LABELS = {
  usb_dac:     'USB DACs',
  sonos:       'Sonos',
  dlna:        'UPnP / DLNA',
  squeezelite: 'Squeezelite',
  unknown:     'Other',
}

const ICON_FOR_TYPE = {
  usb_dac:     Cable,
  sonos:       Speaker,
  dlna:        Wifi,
  squeezelite: Radio,
  unknown:     HardDrive,
}

const s = {
  loading: { padding: 24, color: 'var(--text-secondary)', fontSize: 13 },

  toolbar: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '4px 0 14px',
  },
  toolbarText: { fontSize: 13, color: 'var(--text-secondary)' },
  refreshBtn: {
    width: 32, height: 32, borderRadius: '50%',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'transparent', color: 'var(--text-secondary)',
    border: '1px solid var(--border)',
    cursor: 'pointer',
  },

  empty: {
    padding: '32px 16px',
    textAlign: 'center',
    background: 'var(--bg-elevated)',
    borderRadius: 8,
  },

  group: { marginBottom: 16 },
  groupHeader: {
    fontSize: 11, fontWeight: 700,
    letterSpacing: '0.06em', textTransform: 'uppercase',
    color: 'var(--text-tertiary)',
    padding: '8px 4px',
  },

  deviceRow: {
    display: 'flex', alignItems: 'center', gap: 12,
    width: '100%',
    padding: '10px 12px',
    marginBottom: 6,
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    color: 'var(--text-primary)',
    cursor: 'pointer',
    textAlign: 'left',
  },
  deviceRowDisconnected: { opacity: 0.55 },
  deviceIconCircle: {
    width: 36, height: 36, borderRadius: '50%',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--bg-surface)',
    color: 'var(--text-secondary)',
    flexShrink: 0,
  },
  deviceText: { flex: 1, minWidth: 0 },
  deviceName: {
    fontSize: 14, fontWeight: 500,
    display: 'flex', alignItems: 'center', gap: 8,
    color: 'var(--text-primary)',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  deviceMeta: {
    fontSize: 12, color: 'var(--text-tertiary)',
    fontFamily: 'var(--font-mono)',
    display: 'flex', alignItems: 'center', gap: 6,
    marginTop: 2,
  },
  disconnectedBadge: {
    fontSize: 9, fontWeight: 700,
    padding: '2px 6px',
    background: 'rgba(255, 196, 0, 0.12)',
    color: '#e6a700',
    borderRadius: 3,
    letterSpacing: '0.04em', textTransform: 'uppercase',
  },
  tag: {
    fontSize: 9, fontWeight: 700,
    padding: '2px 5px',
    background: 'var(--accent-dim)',
    color: 'var(--accent)',
    borderRadius: 3,
    letterSpacing: '0.04em', textTransform: 'uppercase',
  },

  footnote: {
    fontSize: 12, color: 'var(--text-tertiary)',
    padding: '14px 4px',
    lineHeight: 1.5,
  },

  // v1.1.0.93 — USB DAC diagnostic banner + sheet
  usbDiagBanner: {
    display: 'flex', alignItems: 'center', gap: 10,
    margin: '8px 0',
    padding: '12px 14px',
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid var(--border)',
    borderRadius: 10,
    fontSize: 13,
    color: 'var(--text-secondary)',
  },
  usbDiagBtn: {
    padding: '7px 14px',
    background: 'var(--accent)',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    fontSize: 12, fontWeight: 600,
    cursor: 'pointer',
  },
  diagOverlay: {
    position: 'fixed', inset: 0,
    background: 'rgba(0,0,0,0.6)',
    display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
    zIndex: 9999,
  },
  diagSheet: {
    width: '100%', maxWidth: 560,
    maxHeight: '85vh',
    overflowY: 'auto',
    background: 'var(--bg-elevated, #1a1a1a)',
    borderRadius: '14px 14px 0 0',
    padding: '18px 18px 24px',
    border: '1px solid var(--border)',
  },
  diagHeader: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    paddingBottom: 14,
    borderBottom: '1px solid var(--border)',
    marginBottom: 14,
  },
  diagCloseBtn: {
    width: 32, height: 32,
    background: 'transparent',
    color: 'var(--text-primary)',
    border: 'none',
    fontSize: 22, lineHeight: 1,
    cursor: 'pointer',
  },
  diagCheckRow: {
    display: 'flex', alignItems: 'flex-start',
    padding: '8px 0',
  },
  diagDetail: {
    fontSize: 11, color: 'var(--text-tertiary)',
    marginTop: 2,
  },
  diagAdvice: {
    marginTop: 16,
    padding: 14,
    background: 'rgba(255,180,0,0.06)',
    border: '1px solid rgba(255,180,0,0.18)',
    borderRadius: 8,
  },
  diagAdviceItem: {
    fontSize: 12,
    color: 'var(--text-secondary)',
    marginBottom: 6,
    lineHeight: 1.5,
  },
  diagDetailSummary: {
    fontSize: 12,
    color: 'var(--text-tertiary)',
    cursor: 'pointer',
    padding: '6px 0',
  },
  diagPre: {
    fontSize: 11,
    fontFamily: 'monospace',
    background: 'rgba(0,0,0,0.3)',
    padding: 10,
    borderRadius: 6,
    overflowX: 'auto',
    color: 'var(--text-secondary)',
    margin: '6px 0',
    whiteSpace: 'pre-wrap',
  },
  diagError: {
    color: '#ff7766',
    fontSize: 13,
    padding: 14,
  },
  diagLoading: {
    fontSize: 13,
    color: 'var(--text-tertiary)',
    padding: 24,
    textAlign: 'center',
  },

  // Sub-page (per-device settings)
  subHeader: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '6px 0 14px',
    borderBottom: '1px solid var(--border)',
    marginBottom: 16,
  },
  backBtn: {
    width: 36, height: 36, borderRadius: '50%',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'transparent', color: 'var(--text-primary)',
    border: '1px solid var(--border)',
    cursor: 'pointer',
  },
  subTitle: {
    flex: 1, textAlign: 'center',
    fontSize: 15, fontWeight: 700,
    overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
    padding: '0 8px',
  },
  subSectionTitle: {
    fontSize: 11, fontWeight: 700,
    letterSpacing: '0.06em', textTransform: 'uppercase',
    color: 'var(--text-tertiary)',
    padding: '8px 0 8px',
  },
  divider: { height: 1, background: 'var(--border)' },

  disconnectedNotice: {
    padding: '10px 12px',
    background: 'rgba(255, 196, 0, 0.06)',
    border: '1px solid rgba(255, 196, 0, 0.30)',
    borderRadius: 8,
    fontSize: 12, color: 'var(--text-primary)',
    marginBottom: 16,
    lineHeight: 1.5,
  },

  modeRow: {
    display: 'flex', alignItems: 'flex-start', gap: 12,
    width: '100%',
    padding: '10px 12px',
    marginBottom: 6,
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    color: 'var(--text-primary)',
    cursor: 'pointer',
    textAlign: 'left',
  },
  modeRowActive: {
    borderColor: 'var(--accent)',
    background: 'var(--accent-dim)',
  },
  modeRadio: {
    width: 16, height: 16, borderRadius: '50%',
    border: '2px solid var(--border)',
    flexShrink: 0,
    marginTop: 2,
  },
  modeRadioActive: {
    border: '2px solid var(--accent)',
    background: 'var(--accent)',
    boxShadow: 'inset 0 0 0 3px var(--bg-elevated)',
  },
  modeText: { flex: 1 },
  modeTitle: { fontSize: 14, fontWeight: 500, marginBottom: 2 },
  modeSub: { fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.4 },

  toggleRow: {
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '10px 0',
  },
  toggleText: { flex: 1 },
  toggleTitle: { fontSize: 14, fontWeight: 500, marginBottom: 2 },
  toggleSub: { fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.4 },
  toggle: {
    width: 40, height: 22, borderRadius: 11,
    background: 'var(--border)', border: 'none',
    position: 'relative', cursor: 'pointer',
    flexShrink: 0,
    transition: 'background 0.15s',
  },
  toggleOn: { background: 'var(--accent)' },
  toggleKnob: {
    width: 16, height: 16, borderRadius: '50%',
    background: 'white',
    position: 'absolute', top: 3, left: 3,
    transition: 'left 0.15s',
  },
  toggleKnobOn: { left: 21 },

  capRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))',
    gap: 8,
  },
  statBlock: {
    padding: '8px 10px',
    background: 'var(--bg-elevated)',
    borderRadius: 6,
  },
  statLabel: {
    fontSize: 10, fontWeight: 700,
    letterSpacing: '0.06em', textTransform: 'uppercase',
    color: 'var(--text-tertiary)',
    marginBottom: 2,
  },
  statValue: { fontSize: 13, color: 'var(--text-primary)' },

  testBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '8px 14px',
    background: 'var(--bg-elevated)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border)',
    borderRadius: 16,
    fontSize: 13,
    cursor: 'pointer',
  },
  errorBox: {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: 8,
    marginTop: 8,
    background: 'rgba(244, 113, 116, 0.08)',
    border: '1px solid rgba(244, 113, 116, 0.30)',
    borderRadius: 6,
    fontSize: 12,
    color: 'var(--red, #f47174)',
  },

  help: {
    fontSize: 12, color: 'var(--text-tertiary)',
    padding: '4px 0 12px',
    lineHeight: 1.5,
  },

  // v1.1.0.68 — Identity row (icon tile + editable name).
  // Same row layout as the device-list rows so the tile is the
  // recognisable size, but with the tile being its own tappable
  // target (opens the icon picker) and the name area swapping
  // between display and edit modes.
  identityRow: {
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '4px 0 12px',
  },
  iconTile: {
    position: 'relative',
    width: 56, height: 56, borderRadius: 8,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border)',
    color: 'var(--text-primary)',
    cursor: 'pointer',
    flexShrink: 0,
    padding: 0,
  },
  iconTileEdit: {
    position: 'absolute', right: -4, bottom: -4,
    width: 20, height: 20, borderRadius: 10,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--accent, #7c3aed)',
    color: '#fff',
    boxShadow: '0 0 0 2px var(--bg-elevated)',
  },
  identityText: { flex: 1, minWidth: 0 },
  // Static name display — tappable to enter edit mode. Pencil
  // glyph at the end is a discoverability cue.
  nameDisplayBtn: {
    display: 'inline-flex', alignItems: 'center',
    background: 'transparent', border: 'none', padding: 0,
    fontSize: 15, fontWeight: 500,
    color: 'var(--text-primary)',
    cursor: 'pointer',
    textAlign: 'left',
    maxWidth: '100%',
  },
  nameValue: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  nameEditRow: {
    display: 'flex', alignItems: 'center', gap: 6,
  },
  nameInput: {
    flex: 1, minWidth: 0,
    background: 'var(--bg-surface)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '7px 10px',
    fontSize: 14,
    outline: 'none',
  },
  nameOkBtn: {
    width: 32, height: 32, borderRadius: 6,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--accent, #7c3aed)',
    color: '#fff',
    border: 'none', cursor: 'pointer',
    flexShrink: 0,
  },
  nameCancelBtn: {
    width: 32, height: 32, borderRadius: 6,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'transparent',
    color: 'var(--text-secondary)',
    border: '1px solid var(--border)',
    cursor: 'pointer',
    flexShrink: 0,
  },
  // "was: WiiM Pro Plus" subline shown when the user has overridden
  // the discovered name. Includes a quiet "reset" link to revert.
  nameDiscovered: {
    fontSize: 11,
    color: 'var(--text-tertiary)',
    marginTop: 4,
    fontFamily: 'var(--font-mono)',
  },
  nameResetBtn: {
    background: 'transparent', border: 'none', padding: 0,
    marginLeft: 6,
    color: 'var(--text-secondary)',
    fontSize: 11,
    fontFamily: 'var(--font-mono)',
    textDecoration: 'underline',
    textUnderlineOffset: 2,
    cursor: 'pointer',
  },
  nameError: {
    fontSize: 11, color: 'var(--red, #f47174)',
    marginTop: 4,
  },
}

// v1.1.0.55 — named export so the NowPlaying device-settings overlay
// can mount the per-device page directly without going through the
// Audio Devices list view.
export { DeviceSettingsPage }

