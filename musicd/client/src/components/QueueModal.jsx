import React, { useState } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import { X, Speaker, Check, ChevronUp, ChevronDown, Trash2, Edit3, Radio } from 'lucide-react'

function fmtTime(s) { if(!s) return ''; const m=Math.floor(s/60),sec=Math.floor(s%60); return `${m}:${String(sec).padStart(2,'0')}` }

export default function QueueModal() {
  const {
    setShowQueue,
    queue, queueIndex,
    playQueue, reorderQueue, removeFromQueue,
    rendererId, renderers,
    radio, setRadio,
    moveQueueToZone, focusZone,
  } = useStore()
  const [showZoneList, setShowZoneList] = useState(false)
  const [switching, setSwitching] = useState(false)
  // Edit mode swaps the per-row tap target out for explicit move-up / move-down
  // / remove buttons. We deliberately use buttons rather than HTML5 drag-and-drop
  // because the latter is finicky on mobile touch and would require a third-
  // party gesture library to feel right.
  const [editMode, setEditMode] = useState(false)
  const activeRenderer = renderers.find(r => r.id === rendererId)

  // "Send queue to..." action (#v1.1.0.9). Now uses moveQueueToZone
  // which is a true queue move -- old zone stops, new zone picks up at
  // the same position. (Pre-v1.1.0.9 this called /switch-renderer
  // which had the same effect because there was only one zone; with
  // true multi-zone the action is now distinct from "focus this zone"
  // -- the user might want to focus a different zone WITHOUT moving
  // the queue, which is what tapping a renderer in the Output sheet
  // does now.)
  const switchZone = async (newId) => {
    if (newId === rendererId) {
      setShowZoneList(false)
      return
    }
    setSwitching(true)
    setShowZoneList(false)
    try {
      // If the source zone is empty (nothing to move), just focus the
      // destination instead. Avoids a no-op server call.
      if (queue.length === 0) {
        await focusZone(newId)
      } else {
        await moveQueueToZone(rendererId, newId)
      }
    } catch (e) { /* server broadcasts state update */ }
    setSwitching(false)
  }

  const moveUp = (i) => { if (i > 0) reorderQueue(i, i - 1) }
  const moveDown = (i) => { if (i < queue.length - 1) reorderQueue(i, i + 1) }

  return (
    <div style={s.overlay} onClick={() => setShowQueue(false)}>
      <div style={s.sheet} onClick={e => e.stopPropagation()}>
        <div style={s.header}>
          <div style={s.title}>Play Queue</div>
          <div style={s.headerActions}>
            {/* Radio toggle (#14): when on, the queue keeps refilling itself
                with random albums after the current queue ends. */}
            <button
              style={{ ...s.headerChip, ...(radio ? s.headerChipActive : {}) }}
              onClick={() => setRadio(!radio)}
              title={radio ? 'MusicD Radio is on' : 'Continuous music — appends a random album when the queue ends'}
              aria-pressed={radio}
            >
              <Radio size={13} />
              <span>Radio</span>
            </button>
            <button
              style={{ ...s.headerChip, ...(editMode ? s.headerChipActive : {}) }}
              onClick={() => setEditMode(v => !v)}
              title={editMode ? 'Done editing' : 'Reorder or remove tracks'}
              aria-pressed={editMode}
            >
              <Edit3 size={13} />
              <span>{editMode ? 'Done' : 'Edit'}</span>
            </button>
            <button style={s.zoneBtn}
              onClick={() => setShowZoneList(v => !v)}
              title="Switch zone"
              disabled={switching}>
              <Speaker size={13} />
              <span style={s.zoneName}>{activeRenderer?.name || 'No zone'}</span>
            </button>
            <button style={s.close} onClick={() => setShowQueue(false)}><X size={16} /></button>
          </div>
        </div>

        {showZoneList && (
          <div style={s.zonePicker}>
            <div style={s.zonePickerTitle}>
              {queue.length === 0 ? 'Focus a zone…' : 'Send queue to…'}
            </div>
            {queue.length > 0 && (
              <div style={s.zonePickerHelp}>
                Moves the current queue and starts playback there. The current zone will stop.
              </div>
            )}
            {renderers.length === 0 && <div style={s.zoneEmpty}>No zones available</div>}
            {renderers.map(r => {
              const z = useStore.getState().zones?.[r.id]
              const isPlaying = z && (z.status === 'playing' || z.status === 'loading')
              const isPaused  = z && z.status === 'paused' && z.currentTrack
              const trackTitle = z?.currentTrack?.title || ''
              return (
                <button key={r.id}
                  style={{ ...s.zoneRow, ...(r.id === rendererId ? s.zoneRowActive : {}) }}
                  onClick={() => switchZone(r.id)}>
                  <Speaker size={13} style={{ color: 'var(--text-tertiary)' }} />
                  <div style={s.zoneRowText}>
                    <span style={s.zoneRowName}>{r.name}</span>
                    {(isPlaying || isPaused) && (
                      <span style={s.zoneRowStatus}>
                        {isPlaying ? '▶' : '❚❚'} {trackTitle}
                      </span>
                    )}
                  </div>
                  <span style={s.zoneRowProto}>{(r.protocol || '').toUpperCase()}</span>
                  {r.id === rendererId && <Check size={13} style={{ color: 'var(--accent)' }} />}
                </button>
              )
            })}
          </div>
        )}

        {queue.length === 0 ? (
          <div style={s.empty}>Queue is empty</div>
        ) : (
          <div style={s.list}>
            {queue.map((track, i) => {
              const isCurrent = i === queueIndex
              const isPast = i < queueIndex
              const canMoveUp = i > 0
              const canMoveDown = i < queue.length - 1
              const canRemove = !isCurrent

              if (editMode) {
                return (
                  <div key={(track.id || 'x') + ':' + i}
                       style={{ ...s.editRow, ...(isCurrent ? s.rowActive : {}), opacity: isPast ? 0.5 : 1 }}>
                    <span style={s.num}>
                      {isCurrent ? <span style={{color:'var(--accent)'}}>▶</span> : i+1}
                    </span>
                    <span style={s.info}>
                      <span style={{ ...s.trackTitle, color: isCurrent ? 'var(--accent)' : 'var(--text-primary)' }}>
                        {track.title || track.id}
                      </span>
                      <span style={s.trackArtist}>{track.artist}</span>
                    </span>
                    <div style={s.editControls}>
                      <button
                        style={{ ...s.iconBtn, ...(canMoveUp ? {} : s.iconBtnDisabled) }}
                        onClick={() => moveUp(i)}
                        disabled={!canMoveUp}
                        title="Move up"
                        aria-label="Move up"
                      ><ChevronUp size={14} /></button>
                      <button
                        style={{ ...s.iconBtn, ...(canMoveDown ? {} : s.iconBtnDisabled) }}
                        onClick={() => moveDown(i)}
                        disabled={!canMoveDown}
                        title="Move down"
                        aria-label="Move down"
                      ><ChevronDown size={14} /></button>
                      <button
                        style={{ ...s.iconBtn, ...(canRemove ? {} : s.iconBtnDisabled) }}
                        onClick={() => removeFromQueue(i)}
                        disabled={!canRemove}
                        title={canRemove ? 'Remove' : 'Cannot remove the currently-playing track'}
                        aria-label="Remove"
                      ><Trash2 size={13} /></button>
                    </div>
                  </div>
                )
              }

              return (
                <button key={(track.id || 'x') + ':' + i}
                  style={{ ...s.row, ...(isCurrent ? s.rowActive : {}), opacity: isPast ? 0.4 : 1 }}
                  onClick={() => { playQueue(queue, i); setShowQueue(false) }}>
                  <span style={s.num}>
                    {isCurrent ? <span style={{color:'var(--accent)'}}>▶</span> : i+1}
                  </span>
                  <span style={s.info}>
                    <span style={{ ...s.trackTitle, color: isCurrent ? 'var(--accent)' : 'var(--text-primary)' }}>
                      {track.title || track.id}
                    </span>
                    <span style={s.trackArtist}>{track.artist}</span>
                  </span>
                  <span style={s.dur}>{fmtTime(track.duration)}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

const s = {
  overlay: { position:'fixed', inset:0, background:'rgba(0,0,0,0.65)', backdropFilter:'blur(6px)', display:'flex', alignItems:'flex-end', zIndex:1000 },
  sheet: { paddingBottom: 'var(--safe-bot)', background:'var(--bg-surface)', borderRadius:'20px 20px 0 0', border:'1px solid var(--border-bright)', width:'100%', maxHeight:'80vh', display:'flex', flexDirection:'column', overflow:'hidden' },
  header: { display:'flex', alignItems:'center', justifyContent:'space-between', padding:'16px 16px 12px', borderBottom:'1px solid var(--border)', flexShrink:0, gap: 8 },
  headerActions: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' },
  title: { fontSize:16, fontWeight:700 },
  // Compact pill chip for header toggles (Radio, Edit). The active state uses
  // the accent colour so it reads as "this mode is on".
  headerChip: {
    display:'inline-flex', alignItems:'center', gap:5,
    padding:'6px 10px', borderRadius:14,
    fontSize:11, fontWeight:600,
    color:'var(--text-secondary)',
    background:'var(--bg-elevated)',
    border:'1px solid var(--border)',
    cursor:'pointer',
  },
  headerChipActive: {
    color:'var(--accent)',
    background:'var(--accent-dim)',
    borderColor:'transparent',
  },
  zoneBtn: { display:'inline-flex', alignItems:'center', gap:6, background:'var(--bg-elevated)', color:'var(--text-secondary)', border:'1px solid var(--border)', borderRadius:'var(--radius-sm)', padding:'6px 10px', fontSize:11, fontWeight:600, cursor:'pointer', maxWidth: 140 },
  zoneName: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  close: { width:30, height:30, display:'flex', alignItems:'center', justifyContent:'center', borderRadius:'var(--radius-sm)', background:'var(--bg-elevated)', color:'var(--text-tertiary)', border:'1px solid var(--border)', cursor:'pointer' },
  zonePicker: { borderBottom:'1px solid var(--border)', padding:'10px 16px 14px', flexShrink:0 },
  zonePickerTitle: { fontSize:10, fontWeight:700, letterSpacing:'0.07em', textTransform:'uppercase', color:'var(--text-tertiary)', marginBottom:8 },
  zonePickerHelp: { fontSize:11, color:'var(--text-tertiary)', marginBottom:8, lineHeight:1.4 },
  zoneEmpty: { fontSize:11, color:'var(--text-tertiary)', textAlign:'center', padding:'8px 0' },
  zoneRow: { display:'grid', gridTemplateColumns:'18px 1fr auto auto', alignItems:'center', gap:8, padding:'8px 8px', background:'none', border:'none', cursor:'pointer', width:'100%', textAlign:'left', borderRadius:'var(--radius-sm)' },
  zoneRowActive: { background:'var(--accent-dim)' },
  zoneRowText: { display:'flex', flexDirection:'column', gap:2, minWidth:0 },
  zoneRowName: { fontSize:13, color:'var(--text-primary)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' },
  zoneRowStatus: { fontSize:11, color:'var(--accent)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' },
  zoneRowProto: { fontSize:9, fontFamily:'var(--font-mono)', color:'var(--text-tertiary)', letterSpacing:'1px' },
  empty: { padding:40, textAlign:'center', color:'var(--text-tertiary)', fontSize:13 },
  list: { overflowY:'auto', flex:1, padding:'8px 0 24px' },
  // Display row (tap-to-jump). Same grid as before.
  row: { display:'grid', gridTemplateColumns:'36px 1fr 48px', alignItems:'center', padding:'9px 16px', background:'none', border:'none', cursor:'pointer', width:'100%', textAlign:'left' },
  // Edit row (move/remove controls). Wider right column to fit the icon trio.
  editRow: { display:'grid', gridTemplateColumns:'36px 1fr auto', alignItems:'center', padding:'7px 16px', width:'100%' },
  rowActive: { background:'var(--accent-dim)' },
  num: { fontSize:12, color:'var(--text-tertiary)', fontFamily:'var(--font-mono)', textAlign:'right', paddingRight:10 },
  info: { display:'flex', flexDirection:'column', gap:2, overflow:'hidden' },
  trackTitle: { fontSize:13, fontWeight:400, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' },
  trackArtist: { fontSize:11, color:'var(--text-tertiary)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' },
  dur: { fontSize:11, color:'var(--text-tertiary)', fontFamily:'var(--font-mono)', textAlign:'right' },
  editControls: { display:'flex', alignItems:'center', gap:4, marginLeft:8 },
  // Compact icon button for the move/remove controls. Slightly larger than
  // the icon itself for a comfortable touch target.
  iconBtn: {
    width:30, height:30,
    display:'flex', alignItems:'center', justifyContent:'center',
    background:'var(--bg-elevated)',
    color:'var(--text-secondary)',
    border:'1px solid var(--border)',
    borderRadius:'var(--radius-sm)',
    cursor:'pointer', padding:0,
  },
  iconBtnDisabled: {
    opacity:0.35, cursor:'default',
  },
}
