import React, { useEffect, useState, useCallback } from 'react'
import { useStore } from '../store'
import { ListMusic, Play, Plus, Trash2, ChevronLeft, Pencil, Check, X } from 'lucide-react'

const fmtDur = (sec) => {
  const s = Math.max(0, Math.floor(sec || 0))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s % 60}s`
  return `${s}s`
}
const fmtT = (s) => (!s ? '' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`)

// The Playlists screen (v1.1.19.0). Two states in one component: the list of
// playlists, and one playlist opened. Kept together because the second is
// reached only from the first and shares its loading and delete paths —
// splitting them would mean threading the same reload callback through a
// parent for no gain.
export default function PlaylistsScreen() {
  const {
    loadPlaylists, getPlaylist, createPlaylist, deletePlaylist,
    renamePlaylist, removeFromPlaylist, playQueue, appendToQueue,
  } = useStore()

  const [lists, setLists] = useState(null)
  const [openId, setOpenId] = useState(null)
  const [detail, setDetail] = useState(null)      // { playlist, tracks }
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [renameTo, setRenameTo] = useState('')

  const refreshList = useCallback(async () => setLists(await loadPlaylists()), [loadPlaylists])
  useEffect(() => { refreshList() }, [refreshList])

  useEffect(() => {
    let cancelled = false
    if (!openId) { setDetail(null); return }
    setDetail(null)
    getPlaylist(openId).then(d => { if (!cancelled) setDetail(d) })
    return () => { cancelled = true }
  }, [openId, getPlaylist])

  const create = async () => {
    const name = newName.trim()
    if (!name) return
    const p = await createPlaylist(name)
    setNewName(''); setCreating(false)
    if (p) refreshList()
  }

  const remove = async (id, name) => {
    if (!confirm(`Delete "${name}"? The tracks stay in your library.`)) return
    if (await deletePlaylist(id)) {
      if (openId === id) setOpenId(null)
      refreshList()
    }
  }

  // ---- One playlist ----
  if (openId) {
    const tracks = detail?.tracks || []
    const name = detail?.playlist?.name || ''
    return (
      <div style={s.page}>
        <div style={s.detailHead}>
          <button style={s.backBtn} onClick={() => setOpenId(null)} aria-label="Back to playlists">
            <ChevronLeft size={20} />
          </button>
          {renaming ? (
            <div style={s.renameRow}>
              <input
                autoFocus value={renameTo} maxLength={80}
                onChange={e => setRenameTo(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { renamePlaylist(openId, renameTo).then(ok => { if (ok) { setRenaming(false); setDetail(d => d ? { ...d, playlist: { ...d.playlist, name: renameTo.trim() } } : d); refreshList() } }) } }}
                style={s.renameInput}
              />
              <button style={s.iconBtn} onClick={async () => {
                if (await renamePlaylist(openId, renameTo)) {
                  setDetail(d => d ? { ...d, playlist: { ...d.playlist, name: renameTo.trim() } } : d)
                  refreshList()
                }
                setRenaming(false)
              }} aria-label="Save name"><Check size={16} /></button>
              <button style={s.iconBtn} onClick={() => setRenaming(false)} aria-label="Cancel"><X size={16} /></button>
            </div>
          ) : (
            <>
              <h1 style={s.detailTitle}>{name}</h1>
              <button style={s.iconBtn} onClick={() => { setRenameTo(name); setRenaming(true) }} aria-label="Rename playlist">
                <Pencil size={15} />
              </button>
            </>
          )}
        </div>

        <div style={s.detailMeta}>
          {tracks.length} track{tracks.length === 1 ? '' : 's'}
          {tracks.length > 0 && ` · ${fmtDur(tracks.reduce((a, t) => a + (t.duration || 0), 0))}`}
        </div>

        {tracks.length > 0 && (
          <div style={s.actionRow}>
            <button style={s.primaryBtn} onClick={() => playQueue(tracks, 0)}>
              <Play size={13} fill="currentColor" strokeWidth={0} /> Play
            </button>
            <button style={s.ghostBtn} onClick={() => appendToQueue(tracks)}>
              <Plus size={14} /> Queue
            </button>
          </div>
        )}

        {detail === null ? (
          <div style={s.empty}>Loading…</div>
        ) : tracks.length === 0 ? (
          <div style={s.empty}>
            Nothing here yet. Add tracks from the ⋯ menu on the Now Playing screen.
          </div>
        ) : (
          <div style={s.trackList}>
            {tracks.map((t, i) => (
              <div key={t.id} style={s.trackRow}>
                <button style={s.trackMain} onClick={() => playQueue(tracks, i)}>
                  <span style={s.trackNum}>{i + 1}</span>
                  <span style={s.trackText}>
                    <span style={s.trackTitle}>{t.title || t.id}</span>
                    <span style={s.trackSub}>
                      {t.artist || ''}{t.album ? ` · ${t.album}` : ''}
                    </span>
                  </span>
                  <span style={s.trackDur}>{fmtT(t.duration)}</span>
                </button>
                <button
                  style={s.rowRemove}
                  aria-label={`Remove ${t.title} from playlist`}
                  onClick={async () => {
                    if (await removeFromPlaylist(openId, t.id)) {
                      setDetail(d => d ? { ...d, tracks: d.tracks.filter(x => x.id !== t.id) } : d)
                      refreshList()
                    }
                  }}
                ><Trash2 size={14} /></button>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  // ---- The list ----
  return (
    <div style={s.page}>
      <div style={s.titleRow}>
        <h1 style={s.heading}>Playlists</h1>
      </div>

      {creating ? (
        <div style={s.createRow}>
          <input
            autoFocus value={newName} maxLength={80}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') create() }}
            placeholder="Playlist name"
            style={s.renameInput}
          />
          <button style={{ ...s.primaryBtn, opacity: newName.trim() ? 1 : 0.45 }}
                  onClick={create} disabled={!newName.trim()}>Create</button>
          <button style={s.ghostBtn} onClick={() => { setCreating(false); setNewName('') }}>Cancel</button>
        </div>
      ) : (
        <div style={s.actionRow}>
          <button style={s.primaryBtn} onClick={() => setCreating(true)}>
            <Plus size={14} /> New playlist
          </button>
        </div>
      )}

      {lists === null ? (
        <div style={s.empty}>Loading…</div>
      ) : lists.length === 0 ? (
        <div style={s.empty}>
          No playlists yet. Make one here, or add a track to a new playlist from
          the ⋯ menu on the Now Playing screen.
        </div>
      ) : (
        <div style={s.list}>
          {lists.map(p => (
            <div key={p.id} style={s.listRow}>
              <button style={s.listMain} onClick={() => setOpenId(p.id)}>
                <span style={s.listIcon}><ListMusic size={16} /></span>
                <span style={s.trackText}>
                  <span style={s.trackTitle}>{p.name}</span>
                  <span style={s.trackSub}>
                    {p.trackCount || 0} track{(p.trackCount || 0) === 1 ? '' : 's'}
                    {p.duration ? ` · ${fmtDur(p.duration)}` : ''}
                  </span>
                </span>
              </button>
              <button style={s.rowRemove} onClick={() => remove(p.id, p.name)}
                      aria-label={`Delete ${p.name}`}><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const s = {
  // Screens pad themselves for the safe areas; the app shell never does.
  // See the iOS PWA rules in CLAUDE.md.
  page: { padding: '0 16px', paddingBottom: 'calc(120px + var(--safe-bot))' },
  titleRow: { display: 'flex', alignItems: 'center', paddingTop: 'calc(8px + var(--safe-top))' },
  heading: { fontSize: 26, fontWeight: 700, color: 'var(--jp-text)', margin: '8px 0 4px' },
  detailHead: {
    display: 'flex', alignItems: 'center', gap: 6,
    paddingTop: 'calc(8px + var(--safe-top))',
  },
  backBtn: {
    width: 34, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'none', border: 'none', color: 'var(--jp-text-2)', cursor: 'pointer',
  },
  detailTitle: {
    fontSize: 22, fontWeight: 700, color: 'var(--jp-text)', margin: '8px 0 4px',
    flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  detailMeta: { fontSize: 12, color: 'var(--jp-text-3)', padding: '0 0 10px 40px' },
  iconBtn: {
    width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center',
    borderRadius: 8, background: 'var(--jp-bg-surface)', border: '1px solid var(--jp-border)',
    color: 'var(--jp-text-2)', cursor: 'pointer', flexShrink: 0,
  },
  renameRow: { display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 },
  renameInput: {
    flex: 1, minWidth: 0, boxSizing: 'border-box', padding: '9px 10px', borderRadius: 8,
    fontSize: 14, background: 'var(--jp-bg-surface)', border: '1px solid var(--jp-border)',
    color: 'var(--jp-text)',
  },
  actionRow: { display: 'flex', gap: 8, padding: '4px 0 14px' },
  createRow: { display: 'flex', gap: 6, padding: '4px 0 14px' },
  primaryBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '8px 14px', borderRadius: 999, border: 'none',
    background: 'var(--jp-accent)', color: '#000', fontSize: 12, fontWeight: 700,
    cursor: 'pointer', whiteSpace: 'nowrap',
  },
  ghostBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '8px 14px', borderRadius: 999,
    background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.10)',
    color: 'var(--jp-text-2)', fontSize: 12, fontWeight: 600, cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  empty: { padding: '28px 6px', fontSize: 13, color: 'var(--jp-text-3)', lineHeight: 1.5 },
  list: { display: 'flex', flexDirection: 'column', gap: 2 },
  listRow: { display: 'flex', alignItems: 'center', gap: 4 },
  listMain: {
    display: 'flex', alignItems: 'center', gap: 12, flex: 1, minWidth: 0,
    padding: '10px 8px', borderRadius: 10, minHeight: 52,
    background: 'none', border: 'none', color: 'var(--jp-text)',
    textAlign: 'left', cursor: 'pointer',
  },
  listIcon: {
    width: 38, height: 38, flexShrink: 0, borderRadius: 8,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--jp-bg-surface)', color: 'var(--jp-text-2)',
  },
  trackList: { display: 'flex', flexDirection: 'column', gap: 1 },
  trackRow: { display: 'flex', alignItems: 'center', gap: 4 },
  trackMain: {
    display: 'flex', alignItems: 'center', gap: 12, flex: 1, minWidth: 0,
    padding: '9px 8px', borderRadius: 8, minHeight: 46,
    background: 'none', border: 'none', color: 'var(--jp-text)',
    textAlign: 'left', cursor: 'pointer',
  },
  trackNum: { width: 22, flexShrink: 0, fontSize: 12, color: 'var(--jp-text-3)', fontVariantNumeric: 'tabular-nums' },
  trackText: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 },
  trackTitle: { fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  trackSub: { fontSize: 11, color: 'var(--jp-text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  trackDur: { fontSize: 11, color: 'var(--jp-text-3)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' },
  rowRemove: {
    width: 34, height: 34, flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    borderRadius: 8, background: 'none', border: 'none',
    color: 'var(--jp-text-3)', cursor: 'pointer',
  },
}
