import React, { useEffect, useState } from 'react'
import { useStore } from '../store'
import { Check, Plus, X, ListMusic } from 'lucide-react'

// "Add to Playlist", the sheet behind the menu row that shipped disabled in
// v57 with a "v60" badge on it.
//
// Two things it does that a plain list would not:
//
//   - It ticks the playlists the track is already in, so the user is not
//     offered an action that would silently do nothing. Adding is idempotent
//     server-side; this is what makes that visible rather than mysterious.
//   - It creates and fills in one round trip, so "New playlist" from here is
//     one action rather than create-then-remember-to-add.
//
// `trackIds` is an array so the same sheet serves a single track from a menu
// and a multi-selection later without changing shape.
export default function AddToPlaylistSheet({ trackIds, title, onClose }) {
  const { loadPlaylists, createPlaylist, addToPlaylist, playlistsForTrack } = useStore()

  const [playlists, setPlaylists] = useState(null)   // null = still loading
  const [inIds, setInIds] = useState(() => new Set())
  const [busy, setBusy] = useState(null)             // playlist id being written
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [note, setNote] = useState(null)

  const ids = Array.isArray(trackIds) ? trackIds.filter(Boolean) : []
  const single = ids.length === 1

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const [lists, already] = await Promise.all([
        loadPlaylists(),
        // Only meaningful for one track. For a selection, "already in" is
        // per-track and ticking the row would be a half-truth.
        single ? playlistsForTrack(ids[0]) : Promise.resolve([]),
      ])
      if (cancelled) return
      setPlaylists(lists)
      setInIds(new Set(already))
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids.join(',')])

  const add = async (playlist) => {
    if (busy) return
    setBusy(playlist.id)
    setNote(null)
    const r = await addToPlaylist(playlist.id, ids)
    setBusy(null)
    if (!r) { setNote(`Couldn't add to ${playlist.name}`); return }
    if (r.added > 0) {
      setInIds(prev => new Set(prev).add(playlist.id))
      setPlaylists(prev => (prev || []).map(p =>
        p.id === playlist.id ? { ...p, trackCount: (p.trackCount || 0) + r.added } : p))
      setNote(`Added ${r.added === 1 ? '' : `${r.added} tracks `}to ${playlist.name}`)
    } else {
      // Not a failure — the server refused to duplicate. Say so plainly.
      setNote(single ? `Already in ${playlist.name}` : `Already in ${playlist.name}`)
    }
  }

  const create = async () => {
    const name = newName.trim()
    if (!name || busy) return
    setBusy('new')
    setNote(null)
    const p = await createPlaylist(name, ids)
    setBusy(null)
    if (!p) { setNote("Couldn't create that playlist"); return }
    setPlaylists(prev => [{ ...p, trackCount: p.trackCount || ids.length }, ...(prev || [])])
    setInIds(prev => new Set(prev).add(p.id))
    setNewName('')
    setCreating(false)
    setNote(`Created ${p.name}`)
  }

  return (
    <div style={s.backdrop} onClick={onClose}>
      <div style={s.sheet} onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
        <div style={s.head}>
          <span style={s.title}>Add to Playlist</span>
          <button style={s.close} onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        {title && <div style={s.sub}>{title}</div>}

        <div style={s.list}>
          {playlists === null ? (
            <div style={s.empty}>Loading…</div>
          ) : playlists.length === 0 && !creating ? (
            <div style={s.empty}>No playlists yet.</div>
          ) : (
            playlists.map(p => {
              const already = inIds.has(p.id)
              return (
                <button
                  key={p.id}
                  style={{ ...s.row, ...(already ? s.rowOn : {}) }}
                  onClick={() => add(p)}
                  disabled={busy === p.id}
                  aria-pressed={already}
                >
                  <span style={s.rowIcon}>
                    {already ? <Check size={15} /> : <ListMusic size={15} />}
                  </span>
                  <span style={s.rowText}>
                    <span style={s.rowName}>{p.name}</span>
                    <span style={s.rowMeta}>
                      {p.trackCount || 0} track{(p.trackCount || 0) === 1 ? '' : 's'}
                      {already ? ' · already in' : ''}
                    </span>
                  </span>
                </button>
              )
            })
          )}
        </div>

        {creating ? (
          <div style={s.createRow}>
            <input
              autoFocus
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') create() }}
              placeholder="Playlist name"
              maxLength={80}
              style={s.input}
            />
            <button
              style={{ ...s.createBtn, opacity: newName.trim() ? 1 : 0.45 }}
              onClick={create}
              disabled={!newName.trim() || busy === 'new'}
            >{busy === 'new' ? 'Creating…' : 'Create'}</button>
          </div>
        ) : (
          <button style={s.newBtn} onClick={() => setCreating(true)}>
            <Plus size={15} /> New playlist
          </button>
        )}

        {note && <div style={s.note}>{note}</div>}
        <button style={s.done} onClick={onClose}>Done</button>
      </div>
    </div>
  )
}

const s = {
  backdrop: {
    position: 'fixed', inset: 0, zIndex: 800,
    background: 'rgba(0,0,0,0.6)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 20,
    // Full-bleed under viewport-fit=cover, so the sheet clears the status bar
    // and home indicator itself rather than trusting an ancestor to.
    paddingTop: 'calc(20px + var(--safe-top))',
    paddingBottom: 'calc(20px + var(--safe-bot))',
  },
  sheet: {
    width: 'min(100%, 420px)', maxHeight: '100%',
    display: 'flex', flexDirection: 'column',
    background: 'var(--jp-bg-elevated)',
    border: '1px solid var(--jp-border)',
    borderRadius: 16,
    boxShadow: '0 20px 60px rgba(0,0,0,0.55)',
    padding: 8,
  },
  head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 8px 4px' },
  title: { fontSize: 15, fontWeight: 700, color: 'var(--jp-text)' },
  close: {
    width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center',
    borderRadius: 8, background: 'var(--jp-bg-surface)', color: 'var(--jp-text-2)',
    border: 'none', cursor: 'pointer',
  },
  sub: {
    padding: '0 8px 8px', fontSize: 12, color: 'var(--jp-text-2)',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  // The list scrolls; the create row and Done stay put, so a long list of
  // playlists cannot push the primary actions off screen.
  list: { overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2, minHeight: 0 },
  empty: { padding: '18px 10px', fontSize: 12, color: 'var(--jp-text-3)', textAlign: 'center' },
  row: {
    display: 'flex', alignItems: 'center', gap: 10,
    width: '100%', boxSizing: 'border-box', minHeight: 46,
    padding: '8px 10px', borderRadius: 10,
    background: 'transparent', border: '1px solid transparent',
    color: 'var(--jp-text-2)', textAlign: 'left', cursor: 'pointer',
  },
  rowOn: {
    background: 'var(--jp-bg-surface)',
    borderColor: 'var(--jp-border-hot)',
    color: 'var(--jp-text)',
  },
  rowIcon: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 18, flexShrink: 0 },
  rowText: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
  rowName: { fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  rowMeta: { fontSize: 11, color: 'var(--jp-text-3)' },
  newBtn: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    margin: '6px 0 0', padding: '11px', borderRadius: 10,
    background: 'var(--jp-bg-surface)', border: '1px solid var(--jp-border)',
    color: 'var(--jp-text)', fontSize: 13, fontWeight: 600, cursor: 'pointer',
  },
  createRow: { display: 'flex', gap: 6, marginTop: 6 },
  input: {
    flex: 1, minWidth: 0, boxSizing: 'border-box', padding: '11px 10px',
    borderRadius: 10, fontSize: 13,
    background: 'var(--jp-bg-surface)', border: '1px solid var(--jp-border)',
    color: 'var(--jp-text)',
  },
  createBtn: {
    padding: '11px 14px', borderRadius: 10, border: 'none',
    background: 'var(--jp-accent)', color: 'var(--jp-bg)',
    fontSize: 13, fontWeight: 700, cursor: 'pointer',
  },
  note: { padding: '8px 10px 0', fontSize: 11, color: 'var(--jp-text-2)', textAlign: 'center' },
  done: {
    marginTop: 8, padding: '11px', borderRadius: 10,
    background: 'transparent', border: '1px solid var(--jp-border)',
    color: 'var(--jp-text-3)', fontSize: 13, cursor: 'pointer',
  },
}
