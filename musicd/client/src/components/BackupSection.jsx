import React, { useEffect, useState, useCallback } from 'react'
import { api } from '../api'
import { Save, Download, Trash2, AlertTriangle, RefreshCw, Upload, AlertCircle } from 'lucide-react'

// Database backup tool (#30.10)
// =============================
// Section in Settings → Backup. Lets the user create a snapshot of the
// musicd database + DSP folders, download it to keep elsewhere, and
// delete old snapshots. Restore is not in-app for v30.10 — there's a
// hint at the bottom telling users how to manually restore (stop
// container, extract tar over /var/lib/musicd-data, start container).
//
// The mount is optional — older docker run commands won't have it. If
// the API reports configured=false, we render a "not configured" panel
// with the docker command excerpt the user needs to add.

export default function BackupSection() {
  const [state, setState] = useState({ configured: null, backups: [], running: false })
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [deletingFile, setDeletingFile] = useState(null)
  const [error, setError] = useState(null)
  // Restore state (#v1.1.0.2). We track which backup is being
  // confirmed-for-restore (two-tap to avoid accidental overwrites)
  // and which is mid-flight. After a successful restore we show
  // a "restart pending" banner -- the container is restarting
  // itself so the API will go away momentarily.
  const [confirmRestoreFile, setConfirmRestoreFile] = useState(null)
  const [restoringFile, setRestoringFile] = useState(null)
  const [restoreSucceeded, setRestoreSucceeded] = useState(null)

  const load = useCallback(async () => {
    try {
      const r = await api.get('/library/backups')
      setState(r)
      setError(null)
    } catch (e) {
      setError(e.message || 'Failed to load backups')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Poll while a backup is running so the UI updates without the user
  // having to refresh. We only poll while the running flag is set —
  // otherwise the page is quiet.
  useEffect(() => {
    if (!state.running) return
    const t = setInterval(load, 2000)
    return () => clearInterval(t)
  }, [state.running, load])

  const create = async () => {
    setCreating(true)
    setError(null)
    try {
      await api.post('/library/backups')
      await load()
    } catch (e) {
      setError(e.message || 'Backup failed')
    } finally {
      setCreating(false)
    }
  }

  const remove = async (filename) => {
    if (!window.confirm(`Delete ${filename}?\n\nThis cannot be undone. Make sure you've downloaded a copy if you want to keep it.`)) return
    setDeletingFile(filename)
    try {
      await api.del(`/library/backups/${encodeURIComponent(filename)}`)
      await load()
    } catch (e) {
      setError(e.message || 'Delete failed')
    } finally {
      setDeletingFile(null)
    }
  }

  // Restore handler (#v1.1.0.2). Stages the backup at /data/.pending-restore/
  // then calls docker restart musicd via the host docker socket. The
  // entrypoint detects the staging dir and swaps the DB into place
  // before Node starts.
  const restore = async (filename) => {
    setError(null)
    setRestoringFile(filename)
    try {
      await api.post(`/library/backups/${encodeURIComponent(filename)}/restore`, { restart: true })
      setRestoreSucceeded(filename)
      // The container will be gone within a second or two. Don't
      // try to refresh -- the API call would fail.
    } catch (e) {
      setError(e.message || 'Restore failed')
      setRestoringFile(null)
      setConfirmRestoreFile(null)
    }
  }

  const downloadHref = (filename) =>
    `/api/library/backups/${encodeURIComponent(filename)}`

  if (loading) {
    return <div style={s.loading}>Loading…</div>
  }

  if (state.configured === false) {
    return <NotConfigured reason={state.reason} />
  }

  return (
    <div>
      <div style={s.intro}>
        Backups capture the musicd database (favourites, play history, library
        scope, settings, cover art, DSP profiles) and your manual DSP files
        (FIR impulse responses and PEQ profiles). Music files themselves
        aren&apos;t included — just the metadata about them.
      </div>

      <button
        style={{ ...s.createBtn, ...((creating || state.running) ? s.createBtnDisabled : {}) }}
        onClick={create}
        disabled={creating || state.running}
      >
        {creating || state.running
          ? <><RefreshCw size={13} className="spin" /> Creating backup…</>
          : <><Save size={13} /> Create backup now</>}
      </button>

      {error && (
        <div style={s.error}>
          <AlertTriangle size={12} style={{ flexShrink: 0 }} />
          <span>{error}</span>
        </div>
      )}

      {restoreSucceeded && (
        <div style={s.restoreSuccessBanner}>
          <RefreshCw size={14} style={{ animation: 'spin 1.5s linear infinite' }} />
          <div>
            <strong>Restoring from {restoreSucceeded}</strong>
            <div style={{ fontSize: 11, marginTop: 2, opacity: 0.85 }}>
              musicd is restarting -- the page will be unreachable for ~30 seconds. Refresh the browser when it comes back. If the API doesn't return after 60 seconds, check the container with <code>docker logs musicd</code>.
            </div>
          </div>
        </div>
      )}

      {state.backups.length === 0 ? (
        <div style={s.empty}>
          No backups yet. Tap the button above to create one.
        </div>
      ) : (
        <div style={s.list}>
          <div style={s.listHeader}>
            {state.backups.length} backup{state.backups.length === 1 ? '' : 's'}
          </div>
          {state.backups.map(b => (
            <div key={b.filename} style={s.row}>
              <div style={s.rowText}>
                <div style={s.rowName}>{b.filename}</div>
                <div style={s.rowMeta}>
                  {humanDate(b.createdAt)} · {humanSize(b.sizeBytes)}
                </div>
                {confirmRestoreFile === b.filename && (
                  <div style={s.confirmRestore}>
                    <AlertCircle size={12} />
                    <span>Restore will replace the current database. The container will restart automatically. Continue?</span>
                    <button style={s.confirmYes} onClick={() => restore(b.filename)} disabled={restoringFile === b.filename}>
                      {restoringFile === b.filename ? 'Staging…' : 'Yes, restore'}
                    </button>
                    <button style={s.confirmNo} onClick={() => setConfirmRestoreFile(null)}>
                      Cancel
                    </button>
                  </div>
                )}
              </div>
              <div style={s.rowActions}>
                <button
                  style={{ ...s.iconBtn, ...(restoringFile === b.filename ? { opacity: 0.5 } : {}) }}
                  onClick={() => setConfirmRestoreFile(b.filename === confirmRestoreFile ? null : b.filename)}
                  disabled={!!restoringFile || !!restoreSucceeded}
                  title="Restore from this backup"
                  aria-label="Restore"
                >
                  <Upload size={13} />
                </button>
                <a
                  href={downloadHref(b.filename)}
                  download={b.filename}
                  style={s.iconBtn}
                  title="Download"
                  aria-label="Download backup"
                >
                  <Download size={13} />
                </a>
                <button
                  style={{ ...s.iconBtn, ...(deletingFile === b.filename ? { opacity: 0.5 } : {}) }}
                  onClick={() => remove(b.filename)}
                  disabled={deletingFile === b.filename || !!restoringFile || !!restoreSucceeded}
                  title="Delete"
                  aria-label="Delete backup"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <details style={s.details}>
        <summary style={s.summary}>How to restore a backup</summary>
        <div style={s.restoreHelp}>
          To restore manually (in-app restore button is on the way -- see the per-backup actions above):
          <ol style={s.restoreList}>
            <li>SSH into your DietPi host</li>
            <li><code>docker stop musicd</code></li>
            <li>Move the existing data dir aside with a unique timestamp suffix so re-runs of the procedure don&apos;t collide:<br/>
              <code>sudo mv /var/lib/musicd-data /var/lib/musicd-data.before-restore.$(date +%s)</code>
            </li>
            <li>Recreate it and extract the backup:<br/>
              <code>sudo mkdir -p /var/lib/musicd-data</code><br/>
              <code>sudo tar -xzf /mnt/dietpi_userdata/musicd_backups/&lt;backup&gt;.tar.gz -C /var/lib/musicd-data</code>
            </li>
            <li>Fix ownership:<br/>
              <code>sudo chown -R 1000:1000 /var/lib/musicd-data</code>
            </li>
            <li><code>docker start musicd</code></li>
          </ol>
          Once you&apos;ve confirmed it works, remove the <code>musicd-data.before-restore.*</code> directories. Older snapshots from previous restore attempts are also safe to delete.
        </div>
      </details>
    </div>
  )
}

function NotConfigured({ reason }) {
  const reasonText = reason === 'mount_readonly'
    ? 'The /mnt/backups path exists in your container but isn\'t writable. The mount may have :ro accidentally set, or the directory permissions are wrong.'
    : 'No backup mount is configured. To enable backups you need to recreate your musicd container with an extra -v flag pointing at a writable host directory.'

  return (
    <div>
      <div style={s.notConfigBox}>
        <div style={s.notConfigTitle}>
          <AlertTriangle size={14} /> Backup not configured
        </div>
        <div style={s.notConfigText}>{reasonText}</div>
        <div style={s.notConfigText}>
          Stop the container and recreate it with the new mount:
        </div>
        <pre style={s.codeBlock}>{`# Once, on the host:
sudo mkdir -p /mnt/dietpi_userdata/musicd_backups
sudo chown 1000:1000 /mnt/dietpi_userdata/musicd_backups

docker stop musicd
docker rm musicd

# Then run docker run with the extra mount:
#   -v /mnt/dietpi_userdata/musicd_backups:/mnt/backups
#
# (See the README for the full docker run command for v1.0.30.10)`}</pre>
        <div style={s.notConfigText}>
          Once recreated, this section will show the backup tool.
        </div>
      </div>
    </div>
  )
}

function humanDate(ms) {
  if (!ms) return '—'
  const d = new Date(ms)
  const now = Date.now()
  const diff = now - ms
  const min = 60 * 1000, hour = 60 * min, day = 24 * hour
  if (diff < min) return 'just now'
  if (diff < hour) return `${Math.floor(diff / min)} min ago`
  if (diff < day) return `${Math.floor(diff / hour)} hr ago`
  if (diff < 7 * day) return `${Math.floor(diff / day)} days ago`
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function humanSize(bytes) {
  if (!bytes) return '0 B'
  const k = 1024
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = bytes
  while (v >= k && i < units.length - 1) { v /= k; i++ }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`
}

const s = {
  loading: { padding: 12, fontSize: 12, color: 'var(--text-tertiary)' },
  intro: {
    fontSize: 12, lineHeight: 1.5, color: 'var(--text-secondary)',
    padding: '4px 0 12px',
  },
  createBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 8,
    padding: '10px 18px',
    fontSize: 13, fontWeight: 500,
    background: 'var(--accent)', color: 'var(--bg-base)',
    border: 'none', borderRadius: 'var(--radius-sm)',
    cursor: 'pointer',
    marginBottom: 12,
  },
  createBtnDisabled: {
    opacity: 0.6, cursor: 'wait',
  },
  error: {
    display: 'flex', alignItems: 'flex-start', gap: 6,
    padding: '8px 10px',
    background: 'rgba(244, 113, 116, 0.08)',
    border: '1px solid rgba(244, 113, 116, 0.3)',
    borderRadius: 'var(--radius-sm)',
    color: 'var(--red, #f47174)',
    fontSize: 12, lineHeight: 1.4,
    marginBottom: 12,
  },
  empty: {
    fontSize: 12, color: 'var(--text-tertiary)',
    padding: '12px 0',
    fontStyle: 'italic',
  },
  list: { marginTop: 8, marginBottom: 12 },
  listHeader: {
    fontSize: 10, fontWeight: 700,
    color: 'var(--text-tertiary)',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    marginBottom: 6,
    padding: '0 2px',
  },
  row: {
    display: 'grid',
    gridTemplateColumns: '1fr auto',
    alignItems: 'center',
    gap: 10,
    padding: '8px 10px',
    background: 'var(--bg-overlay)',
    borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--border)',
    marginBottom: 5,
  },
  rowText: { minWidth: 0, overflow: 'hidden' },
  rowName: {
    fontSize: 11, fontFamily: 'var(--font-mono)',
    color: 'var(--text-primary)',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  rowMeta: {
    fontSize: 10, color: 'var(--text-tertiary)',
    marginTop: 2,
  },
  rowActions: { display: 'flex', gap: 6, flexShrink: 0 },
  iconBtn: {
    width: 28, height: 28,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'transparent', color: 'var(--text-secondary)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    textDecoration: 'none',
    cursor: 'pointer',
  },

  // Two-tap restore confirmation (#v1.1.0.2). Inline below the backup
  // filename so the user sees exactly which backup they're about to
  // overwrite their DB with. Yellow tint to flag destructive op.
  confirmRestore: {
    display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
    marginTop: 8,
    padding: '8px 10px',
    background: 'rgba(255, 196, 0, 0.08)',
    border: '1px solid rgba(255, 196, 0, 0.30)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 11,
    color: 'var(--text-primary)',
  },
  confirmYes: {
    padding: '4px 10px', fontSize: 11, fontWeight: 600,
    background: '#e6a700', color: 'black',
    border: 'none', borderRadius: 12,
    cursor: 'pointer',
  },
  confirmNo: {
    padding: '4px 10px', fontSize: 11,
    background: 'transparent', color: 'var(--text-secondary)',
    border: '1px solid var(--border)', borderRadius: 12,
    cursor: 'pointer',
  },
  // Success/in-progress banner shown after restore is staged and the
  // container is restarting itself.
  restoreSuccessBanner: {
    display: 'flex', alignItems: 'flex-start', gap: 10,
    marginBottom: 12,
    padding: 12,
    background: 'rgba(94, 209, 117, 0.08)',
    border: '1px solid rgba(94, 209, 117, 0.30)',
    borderRadius: 'var(--radius-sm)',
    color: 'var(--text-primary)',
    fontSize: 12,
  },

  // Not-configured panel
  notConfigBox: {
    padding: 12,
    background: 'rgba(255, 196, 0, 0.06)',
    border: '1px solid rgba(255, 196, 0, 0.3)',
    borderRadius: 'var(--radius-sm)',
  },
  notConfigTitle: {
    display: 'flex', alignItems: 'center', gap: 6,
    fontSize: 13, fontWeight: 600,
    color: 'var(--amber, #e6a700)',
    marginBottom: 8,
  },
  notConfigText: {
    fontSize: 11, lineHeight: 1.5,
    color: 'var(--text-secondary)',
    margin: '6px 0',
  },
  codeBlock: {
    fontFamily: 'var(--font-mono)',
    fontSize: 10, lineHeight: 1.5,
    background: 'var(--bg-base)',
    color: 'var(--text-primary)',
    padding: 10,
    borderRadius: 4,
    overflowX: 'auto',
    whiteSpace: 'pre',
    margin: '8px 0',
    border: '1px solid var(--border)',
  },

  // Restore details
  details: {
    marginTop: 16,
    padding: 8,
    background: 'var(--bg-overlay)',
    borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--border)',
  },
  summary: {
    fontSize: 12, fontWeight: 600,
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    padding: 4,
  },
  restoreHelp: {
    fontSize: 11, lineHeight: 1.5,
    color: 'var(--text-secondary)',
    padding: '8px 4px 4px',
  },
  restoreList: {
    paddingLeft: 18,
    margin: '6px 0',
    lineHeight: 1.6,
  },
}
