import React from 'react'
import { useStore } from '../store'
import { X, FileAudio, Cpu, Waves, Wifi, GitMerge, Sliders, Volume2, Music, Layers, Send, Speaker, FileCode } from 'lucide-react'

// Read orb colour from server-provided signalPath. Server attaches it to path[0].orbColor
// as 'green' (lossless+bit-perfect), 'purple' (lossless+converted) or 'yellow' (lossy source).
function pathQuality(path) {
  if (!path || path.length === 0) return null
  const c = path[0]?.orbColor
  if (c === 'yellow') return 'lossy'
  if (c === 'purple') return 'converted'
  return 'lossless'
}

const QUALITY_META = {
  lossless:  { label: 'Lossless · Bit-Perfect', color: '#3fd07a', desc: 'File streamed verbatim. No format conversion or DSP.' },
  converted: { label: 'Lossless · Converted',   color: '#b27aff', desc: 'Lossless source with conversion applied (DSD demod, volume levelling, bit-depth). All math performed in 64-bit float; audio content is preserved.' },
  lossy:     { label: 'Lossy Source',           color: '#f5c450', desc: 'The source file is a lossy format such as MP3 or AAC.' },
}

const NODE_META = {
  source:     { color: '#4caf82', bg: '#4caf8218' },
  decoder:    { color: '#7da3ff', bg: '#7da3ff18' },
  processing: { color: '#e8a44a', bg: '#e8a44a18' },
  output:     { color: '#b27aff', bg: '#b27aff18' },
  transport:  { color: '#9090a0', bg: '#90909018' },
  renderer:   { color: '#a78bfa', bg: '#a78bfa18' },
}

function IconForNode(node) {
  switch (node.icon) {
    case 'file':      return FileAudio
    case 'decoder':   return FileCode
    case 'dsd':       return Waves
    case 'precision': return Cpu
    case 'volume':    return Volume2
    case 'srate':     return Music
    case 'bitdepth':  return Layers
    case 'encode':    return Cpu
    case 'transport': return Send
    case 'speaker':   return Speaker
    case 'multichannel': return GitMerge
    case 'eq':        return Sliders
    case 'network':   return Wifi
    default:          return FileAudio
  }
}

function formatHz(hz) {
  if (!hz) return null
  return hz >= 1000 ? `${(hz / 1000).toFixed(1)} kHz` : `${hz} Hz`
}

export default function SignalPathModal() {
  const { setShowSignalPath, signalPath, currentTrack } = useStore()
  const path = signalPath || []
  const quality = pathQuality(path)
  const qm = quality ? QUALITY_META[quality] : null

  return (
    <div style={s.overlay} onClick={() => setShowSignalPath(false)}>
      <div style={s.sheet} onClick={e => e.stopPropagation()} className="fade-in">
        {/* Header */}
        <div style={s.header}>
          <div>
            <div style={s.title}>Signal Path</div>
            {currentTrack && <div style={s.subtitle}>{currentTrack.title} · {currentTrack.artist}</div>}
          </div>
          <button style={s.close} onClick={() => setShowSignalPath(false)}><X size={16} /></button>
        </div>

        {/* Quality banner */}
        {qm && (
          <div style={{ ...s.qualityBanner, borderColor: qm.color }}>
            <div style={{ ...s.qualityDot, background: qm.color, boxShadow: `0 0 8px ${qm.color}` }} />
            <div>
              <div style={{ ...s.qualityLabel, color: qm.color }}>{qm.label}</div>
              <div style={s.qualityDesc}>{qm.desc}</div>
            </div>
          </div>
        )}

        {path.length === 0 ? (
          <div style={s.empty}>Start playback to see the signal path</div>
        ) : (
          <div style={s.chain}>
            {path.map((node, i) => {
              const meta = NODE_META[node.type] || NODE_META.processing
              const Icon = IconForNode(node)
              const isLast = i === path.length - 1
              const dimmed = node.bypassed || node.passthrough

              return (
                <div key={i} style={s.nodeWrap}>
                  {/* Left spine */}
                  <div style={s.spine}>
                    <div style={{ ...s.spineIcon, background: meta.bg, border: `2px solid ${meta.color}`, opacity: dimmed ? 0.45 : 1 }}>
                      <Icon size={16} style={{ color: meta.color }} />
                    </div>
                    {!isLast && <div style={{ ...s.spineLine, background: meta.color + '40' }} />}
                  </div>

                  {/* Content */}
                  <div style={{ ...s.nodeContent, opacity: dimmed ? 0.55 : 1 }}>
                    <div style={{ ...s.nodeTitle, color: meta.color }}>
                      {node.label}
                      {node.bypassed && <span style={s.bypassTag}>BYPASSED</span>}
                      {node.passthrough && <span style={s.passTag}>PASS-THROUGH</span>}
                    </div>
                    {(node.sub || node.detail) && (
                      <div style={s.nodeDetail}>{node.sub || node.detail}</div>
                    )}

                    {/* Source metadata */}
                    {/* Source: warn if probe failed (data may be wrong) */}
                    {node.type === 'source' && node.unverified && (
                      <div style={s.warnNote}>
                        ⚠ ffprobe unavailable — values shown are from scan-time metadata and may not reflect the actual stream{node.probeError ? ` (${node.probeError})` : ''}.
                      </div>
                    )}

                    {/* VL metadata */}
                    {node.icon === 'volume' && (node.measuredLufs != null || node.targetLufs != null) && (
                      <div style={s.metaGrid}>
                        {node.vlMode && (
                          <div style={{ ...s.metaItem, gridColumn: '1/-1' }}>
                            <span style={{
                              display: 'inline-block',
                              fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
                              textTransform: 'uppercase',
                              padding: '2px 6px', borderRadius: 4,
                              background: node.vlMode === 'album' ? 'rgba(178,122,255,0.18)' : 'rgba(91,127,255,0.18)',
                              color: node.vlMode === 'album' ? '#b27aff' : '#7da3ff',
                              border: `1px solid ${node.vlMode === 'album' ? 'rgba(178,122,255,0.35)' : 'rgba(91,127,255,0.35)'}`,
                            }}>
                              {node.vlMode === 'album' ? 'Album Gain' : 'Track Gain'}
                            </span>
                          </div>
                        )}
                        {node.measuredLufs != null && <MetaItem label="Measured" value={`${node.measuredLufs.toFixed(1)} LUFS`} mono />}
                        {node.targetLufs != null && <MetaItem label="Target" value={`${node.targetLufs} LUFS`} mono />}
                        {node.gainDb != null && <MetaItem label="Gain" value={`${node.gainDb >= 0 ? '+' : ''}${node.gainDb.toFixed(2)} dB`} mono />}
                      </div>
                    )}

                    {/* Encoder metadata */}
                    {node.type === 'output' && (
                      <div style={s.metaGrid}>
                        {node.sampleRate && <MetaItem label="Out · Rate" value={formatHz(node.sampleRate)} />}
                        {node.bitDepth && <MetaItem label="Out · Depth" value={`${node.bitDepth} bit`} />}
                        {node.channels && <MetaItem label="Out · Ch" value={
                          node.channels > 2 ? `${node.channels} ch` : node.channels === 2 ? 'Stereo' : 'Mono'
                        } />}
                      </div>
                    )}

                    {/* Renderer metadata */}
                    {node.type === 'renderer' && (
                      <div style={s.metaGrid}>
                        {node.ip && <MetaItem label="IP" value={node.ip} mono />}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function MetaItem({ label, value, mono }) {
  return (
    <div style={s.metaItem}>
      <div style={s.metaLabel}>{label}</div>
      <div style={{ ...s.metaValue, ...(mono ? { fontFamily: 'var(--font-mono)' } : {}) }}>{value}</div>
    </div>
  )
}

const s = {
  overlay: {
    position: 'fixed', inset: 0,
    background: 'rgba(0,0,0,0.65)',
    backdropFilter: 'blur(6px)',
    display: 'flex', alignItems: 'flex-end',
    zIndex: 1000,
  },
  sheet: { paddingBottom: 'var(--safe-bot)',
    background: 'var(--bg-surface)',
    borderRadius: '20px 20px 0 0',
    border: '1px solid var(--border-bright)',
    width: '100%',
    maxHeight: '88vh',
    display: 'flex', flexDirection: 'column',
    overflow: 'hidden',
    boxShadow: '0 -8px 40px rgba(0,0,0,0.5)',
  },
  header: {
    display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
    padding: '18px 20px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0,
  },
  title: { fontSize: 16, fontWeight: 700, marginBottom: 2 },
  subtitle: { fontSize: 11, color: 'var(--text-tertiary)' },
  close: { width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 'var(--radius-sm)', background: 'var(--bg-elevated)', color: 'var(--text-tertiary)' },
  qualityBanner: {
    display: 'flex', alignItems: 'flex-start', gap: 12,
    margin: '12px 20px', padding: '12px 14px',
    borderRadius: 'var(--radius)',
    background: 'var(--bg-elevated)',
    border: '1px solid',
    flexShrink: 0,
  },
  qualityDot: { width: 10, height: 10, borderRadius: '50%', marginTop: 3, flexShrink: 0 },
  qualityLabel: { fontSize: 13, fontWeight: 700, marginBottom: 2 },
  qualityDesc: { fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5 },
  empty: { padding: 40, textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13 },
  chain: { overflowY: 'auto', padding: '8px 20px 32px', flex: 1 },
  nodeWrap: { display: 'flex', gap: 14, minHeight: 60 },
  spine: { display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0, width: 36 },
  spineIcon: { width: 36, height: 36, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, zIndex: 1, transition: 'opacity 0.2s' },
  spineLine: { width: 2, flex: 1, minHeight: 12, margin: '2px 0' },
  nodeContent: { flex: 1, paddingBottom: 16, paddingTop: 6, transition: 'opacity 0.2s' },
  nodeTitle: { fontSize: 13, fontWeight: 700, marginBottom: 2, letterSpacing: '0.01em', display: 'flex', alignItems: 'center', gap: 8 },
  bypassTag: { fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', padding: '1px 5px', borderRadius: 3, background: 'rgba(var(--tint-rgb), 0.08)', color: 'rgba(var(--tint-rgb), 0.55)' },
  passTag: { fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', padding: '1px 5px', borderRadius: 3, background: 'rgba(63,208,122,0.15)', color: '#3fd07a' },
  warnNote: { fontSize: 11, color: '#f5c450', background: 'rgba(245,196,80,0.08)', border: '1px solid rgba(245,196,80,0.25)', borderRadius: 4, padding: '6px 8px', marginTop: 6, lineHeight: 1.4 },
  nodeDetail: { fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.4, marginBottom: 4 },
  metaGrid: { display: 'flex', flexWrap: 'wrap', gap: '6px 16px', marginTop: 8 },
  metaItem: {},
  metaLabel: { fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-tertiary)', marginBottom: 1 },
  metaValue: { fontSize: 12, color: 'var(--text-primary)' },
}
