import React, { useEffect, useState, useCallback } from 'react'
import { api } from '../api'
import { Folder, FolderOpen, Plus, X, ChevronRight, ChevronDown, ChevronLeft, FileAudio } from 'lucide-react'

// Library scope (#30.9)
// =====================
// Lets the user pick which subfolders under /music are scanned. The
// current selection is shown as a list at the top; an "Add folder"
// button opens a tree-browser modal where each disclosure click fetches
// one level of children (lazy load).
//
// Removing a folder doesn't delete its tracks — the database keeps them
// with excluded=1 so re-including later is instant. The UI doesn't need
// to know about the soft-delete; it only sees the active scope list and
// the file/folder structure on disk.

export default function LibraryScopeSection() {
  const [scope, setScope] = useState([])
  const [musicRoot, setMusicRoot] = useState('/music')
  const [loading, setLoading] = useState(true)
  const [browseOpen, setBrowseOpen] = useState(false)
  const [actionBusy, setActionBusy] = useState(null) // path being added/removed

  const loadScope = useCallback(async () => {
    try {
      const r = await api.get('/library/scope')
      setScope(r.scope || [])
      setMusicRoot(r.musicRoot || '/music')
    } catch (e) {
      // On error keep last-known list; the user can retry by reopening
      // the section.
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadScope() }, [loadScope])

  const handleRemove = async (path) => {
    if (!window.confirm(`Remove ${path} from your library?\n\nIts tracks will be hidden but kept in the database, so you can re-add this folder later without losing favourites or play counts.`)) return
    setActionBusy(path)
    try {
      await api.post('/library/scope', { path, action: 'remove' })
      await loadScope()
    } catch (e) {
      alert('Remove failed: ' + (e.message || 'unknown error'))
    } finally {
      setActionBusy(null)
    }
  }

  const handleAdd = async (path) => {
    setActionBusy(path)
    try {
      await api.post('/library/scope', { path, action: 'add' })
      await loadScope()
    } catch (e) {
      alert('Add failed: ' + (e.message || 'unknown error'))
    } finally {
      setActionBusy(null)
    }
  }

  if (loading) {
    return <div style={s.loading}>Loading scope…</div>
  }

  return (
    <div>
      <div style={s.intro}>
        Pick the folders to include in your library. Files under any
        selected folder are scanned and shown. Files outside the selection
        are hidden but kept in the database — re-add a folder to restore
        them with their favourites and play counts intact.
      </div>

      {scope.length === 0 ? (
        <div style={s.empty}>
          <div style={s.emptyTitle}>No folders selected</div>
          <div style={s.emptyHint}>Your library is currently empty. Tap below to choose what to scan.</div>
        </div>
      ) : (
        <div style={s.list}>
          {scope.map(item => (
            <div key={item.path} style={s.row}>
              <div style={s.rowIcon}><FolderOpen size={14} /></div>
              <div style={s.rowText}>
                <div style={s.rowPath}>{item.path}</div>
                <div style={s.rowSub}>{item.tracks.toLocaleString()} track{item.tracks === 1 ? '' : 's'}</div>
              </div>
              <button
                style={{ ...s.removeBtn, ...(actionBusy === item.path ? { opacity: 0.5 } : {}) }}
                onClick={() => handleRemove(item.path)}
                disabled={!!actionBusy}
                title="Remove folder from library"
                aria-label={`Remove ${item.path}`}
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      <button style={s.addBtn} onClick={() => setBrowseOpen(true)} disabled={!!actionBusy}>
        <Plus size={13} />
        <span>Add folder</span>
      </button>

      {browseOpen && (
        <BrowserModal
          rootPath={musicRoot}
          scope={scope.map(s => s.path)}
          onClose={() => setBrowseOpen(false)}
          onAdd={async (path) => {
            await handleAdd(path)
            // Don't auto-close — user might want to add several. They
            // close via the X or by tapping outside.
          }}
        />
      )}
    </div>
  )
}

// ── Tree browser modal ─────────────────────────────────────────────────
//
// Starts at musicRoot, fetches one level on demand. Each folder row
// has an expand triangle (if it has subdirs), a name, a metadata
// summary (audio file count + has-more-folders), and an Add button.
//
// State held here:
//   • A Map of expanded paths → their fetched children. Caches by path
//     so re-expanding a folder doesn't re-fetch in the same session.
//   • A Set of paths that are currently fetching (so we can show a
//     spinner without re-firing the request).
//   • A Set of paths that errored (for inline error feedback).
//
// We deliberately don't load the entire tree upfront — even on a small
// library that's a lot of fs.readdir calls. Lazy-load matches the user's
// mental model of "I don't care about Audiobooks, don't read them".

function BrowserModal({ rootPath, scope, onClose, onAdd }) {
  // Keys are folder paths; values are { children, audioFilesAtThisLevel, error? }
  const [cache, setCache] = useState({})
  // Set of currently-expanded paths
  const [expanded, setExpanded] = useState(new Set([rootPath]))
  // Set of paths currently fetching
  const [fetching, setFetching] = useState(new Set())

  const fetchPath = useCallback(async (path) => {
    if (cache[path] || fetching.has(path)) return
    setFetching(prev => new Set([...prev, path]))
    try {
      const r = await api.get(`/library/browse?path=${encodeURIComponent(path)}`)
      setCache(prev => ({ ...prev, [path]: r }))
    } catch (e) {
      setCache(prev => ({ ...prev, [path]: { error: e.message || 'fetch failed', children: [] } }))
    } finally {
      setFetching(prev => {
        const next = new Set(prev)
        next.delete(path)
        return next
      })
    }
  }, [cache, fetching])

  // Auto-fetch the root on mount
  useEffect(() => { fetchPath(rootPath) }, [rootPath, fetchPath])

  const toggleExpand = (path, hasSubdirs) => {
    if (!hasSubdirs && path !== rootPath) return
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else { next.add(path); fetchPath(path) }
      return next
    })
  }

  // Recursively render a folder and (if expanded) its children. Indent
  // increases with depth so the tree shape is visible.
  //
  // `childEntry` is the entry for THIS folder as returned by the parent's
  // /browse response (or null for the root). We use childEntry.hasSubdirs
  // as the signal for whether the disclosure button is enabled, instead
  // of trying to derive it from this folder's own (not-yet-fetched) data.
  // Earlier versions read `data && data.children.some(c => c.hasSubdirs)`
  // and disabled the button when data was missing -- but data is only
  // fetched on expand, so the button stayed disabled and the user could
  // never expand past depth 1 (#v1.1.0.5).
  const renderFolder = (folderPath, depth, isRoot = false, childEntry = null) => {
    const data = cache[folderPath]
    const isExpanded = expanded.has(folderPath)
    const isFetching = fetching.has(folderPath)
    const inScopeExact = scope.includes(folderPath)
    const coveredByAncestor = !inScopeExact && scope.some(s => folderPath.startsWith(s + '/'))
    // hasSubdirs comes from the parent's perspective (cheap server-side
    // peek); fall back to the folder's own data if known, then to "true"
    // so the user can always try to expand and discover.
    const hasSubdirs = childEntry
      ? childEntry.hasSubdirs
      : (data ? (data.children || []).some(c => c.hasSubdirs) : true)

    return (
      <React.Fragment key={folderPath}>
        {/* The root is rendered as a header strip rather than a row. Children
            are listed underneath. */}
        {!isRoot && (
          <div style={{ ...s.browseRow, paddingLeft: 12 + depth * 16 }}>
            <button
              style={s.disclosureBtn}
              onClick={() => toggleExpand(folderPath, hasSubdirs)}
              disabled={!hasSubdirs}
              aria-label={isExpanded ? 'Collapse' : 'Expand'}
            >
              {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
            <div style={s.browseRowName}>
              <Folder size={13} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
              <span style={s.browseRowNameText}>{basename(folderPath)}</span>
            </div>
            <BrowseRowMeta data={data} childEntry={childEntry} isFetching={isFetching} />
            <BrowseRowAction
              path={folderPath}
              inScopeExact={inScopeExact}
              coveredByAncestor={coveredByAncestor}
              onAdd={onAdd}
            />
          </div>
        )}

        {/* Children list. We render them only when expanded AND we have
            data (no skeleton — the spinner sits next to the folder name
            on its own row above). Each child is passed its own data
            entry so the disclosure button and meta know hasSubdirs and
            audioFiles without needing to be fetched first (#v1.1.0.5). */}
        {isExpanded && data && (data.children || []).length > 0 && (
          <>
            {data.children.map(child => renderFolder(child.path, depth + 1, false, child))}
          </>
        )}
        {isExpanded && data && data.error && (
          <div style={{ ...s.browseError, paddingLeft: 12 + (depth + 1) * 16 }}>
            Failed to read folder: {data.error}
          </div>
        )}
        {isExpanded && data && (data.children || []).length === 0 && !data.error && (
          <div style={{ ...s.browseEmpty, paddingLeft: 12 + (depth + 1) * 16 }}>
            No subfolders here{(data.audioFilesAtThisLevel || 0) > 0 ? ` — ${data.audioFilesAtThisLevel} audio file${data.audioFilesAtThisLevel === 1 ? '' : 's'} at this level` : ''}
          </div>
        )}
      </React.Fragment>
    )
  }

  // Click-outside-to-close: stopPropagation on the sheet itself, click
  // on the overlay closes.
  return (
    // Full-screen page rather than a bottom-sheet (#v1.1.0.8). Bottom-
    // sheet was only ~80vh tall and tucked at the bottom of the screen,
    // making deep folder trees painful to navigate on small phones.
    // Full-screen + larger fonts means the user can actually see what
    // they're picking.
    <div style={s.fullPage}>
      <div style={s.fullPageHeader}>
        <button style={s.backBtn} onClick={onClose} aria-label="Back">
          <ChevronLeft size={20} />
        </button>
        <div style={s.fullPageTitle}>Browse music folders</div>
        {/* Spacer to balance the back button so the title centres */}
        <div style={{ width: 36 }} />
      </div>
      <div style={s.fullPageSub}>
        Tap <span style={{ display: 'inline-flex', verticalAlign: 'middle' }}><Plus size={13} /></span> to add a folder. Tap the triangle to see what's inside.
      </div>
      <div style={s.tree}>
        {/* Root header */}
        <div style={s.rootHeader}>
          <Folder size={16} style={{ color: 'var(--text-secondary)' }} />
          <span style={s.rootHeaderText}>{rootPath}</span>
          {fetching.has(rootPath) && <span style={s.spinner} />}
        </div>
        {/* Root's children */}
        {cache[rootPath] && (cache[rootPath].children || []).map(child => renderFolder(child.path, 0, false, child))}
        {cache[rootPath] && (cache[rootPath].children || []).length === 0 && !cache[rootPath].error && (
          <div style={s.browseEmpty}>
            {rootPath} contains no subfolders.
            {(cache[rootPath].audioFilesAtThisLevel || 0) > 0 && ` There are ${cache[rootPath].audioFilesAtThisLevel} audio files directly under it.`}
          </div>
        )}
        {cache[rootPath] && cache[rootPath].error && (
          <div style={s.browseError}>Failed to read {rootPath}: {cache[rootPath].error}</div>
        )}
      </div>
    </div>
  )
}

function BrowseRowMeta({ data, childEntry, isFetching }) {
  if (isFetching) return <span style={s.rowMeta}>…</span>
  // Prefer post-fetch data (knows full count of subfolders too), but
  // fall back to the parent-side childEntry which has audioFiles +
  // hasSubdirs. This means rows show their counts before the user
  // expands them, instead of being silent (#v1.1.0.5).
  if (data) {
    const audio = data.audioFilesAtThisLevel || 0
    const folders = (data.children || []).length
    const parts = []
    if (audio > 0) parts.push(`${audio} ${audio === 1 ? 'file' : 'files'}`)
    if (folders > 0) parts.push(`${folders} ${folders === 1 ? 'subfolder' : 'subfolders'}`)
    return <span style={s.rowMeta}>{parts.join(' · ')}</span>
  }
  if (childEntry) {
    const parts = []
    if (childEntry.audioFiles > 0) parts.push(`${childEntry.audioFiles} ${childEntry.audioFiles === 1 ? 'file' : 'files'}`)
    if (childEntry.hasSubdirs) parts.push('has subfolders')
    return <span style={s.rowMeta}>{parts.join(' · ')}</span>
  }
  return <span style={s.rowMeta} />
}

function BrowseRowAction({ path, inScopeExact, coveredByAncestor, onAdd }) {
  if (inScopeExact) {
    return <span style={s.tagAdded}>Added</span>
  }
  if (coveredByAncestor) {
    return <span style={s.tagCovered}>via parent</span>
  }
  return (
    <button
      style={s.addRowBtn}
      onClick={() => onAdd(path)}
      title="Add this folder"
      aria-label="Add folder"
    >
      <Plus size={11} />
    </button>
  )
}

function basename(p) {
  if (!p) return ''
  const i = p.lastIndexOf('/')
  return i === -1 ? p : p.slice(i + 1) || p
}

const s = {
  loading: { padding: 12, fontSize: 12, color: 'var(--text-tertiary)' },
  intro: {
    fontSize: 12, lineHeight: 1.5, color: 'var(--text-secondary)',
    padding: '4px 0 12px',
  },
  empty: {
    padding: '16px 12px',
    background: 'var(--bg-overlay)',
    borderRadius: 'var(--radius-sm)',
    border: '1px dashed var(--border)',
    marginBottom: 10,
  },
  emptyTitle: { fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 3 },
  emptyHint:  { fontSize: 11, color: 'var(--text-tertiary)' },
  list: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 },
  row: {
    display: 'grid',
    gridTemplateColumns: '20px 1fr 28px',
    alignItems: 'center',
    gap: 10,
    padding: '8px 10px',
    background: 'var(--bg-overlay)',
    borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--border)',
  },
  rowIcon: { color: 'var(--accent)' },
  rowText: { minWidth: 0, overflow: 'hidden' },
  rowPath: {
    fontSize: 12, fontFamily: 'var(--font-mono)',
    color: 'var(--text-primary)',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  rowSub: { fontSize: 10, color: 'var(--text-tertiary)', marginTop: 2 },
  removeBtn: {
    width: 24, height: 24,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'transparent', color: 'var(--text-tertiary)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
  },
  addBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '8px 14px',
    fontSize: 12,
    background: 'var(--bg-elevated)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    cursor: 'pointer',
  },

  // Modal
  // Full-screen page chrome (#v1.1.0.8). Replaces the previous bottom-
  // sheet with a proper page that fills the viewport. Matches the
  // pattern used by SettingsScreen sub-pages.
  fullPage: {
    position: 'fixed', inset: 0, zIndex: 800,
    background: 'var(--bg-base)',
    display: 'flex', flexDirection: 'column',
  },
  fullPageHeader: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '14px 12px 10px',
    borderBottom: '1px solid var(--border)',
  },
  fullPageTitle: { fontSize: 17, fontWeight: 700 },
  fullPageSub: {
    fontSize: 13, color: 'var(--text-tertiary)',
    padding: '12px 16px 16px',
    borderBottom: '1px solid var(--border)',
    lineHeight: 1.4,
  },
  backBtn: {
    width: 36, height: 36, borderRadius: '50%',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'transparent', color: 'var(--text-primary)',
    border: '1px solid var(--border)',
    cursor: 'pointer',
  },
  // Legacy overlay/sheet styles kept in case of any other modal in
  // this file -- harmless dead code if not referenced. (Currently the
  // BrowserModal was the only consumer, so they could be dropped, but
  // leaving them avoids accidentally breaking something I didn't see.)
  overlay: {
    position: 'fixed', inset: 0, zIndex: 800,
    background: 'rgba(0,0,0,0.55)',
    display: 'flex', alignItems: 'flex-end',
  },
  sheet: {
    background: 'var(--bg-surface)',
    borderRadius: '16px 16px 0 0',
    width: '100%', maxHeight: '80vh',
    display: 'flex', flexDirection: 'column',
    borderTop: '1px solid var(--border)',
  },
  sheetHeader: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '12px 16px 6px',
  },
  sheetTitle: { fontSize: 15, fontWeight: 700 },
  sheetSub: {
    fontSize: 11, color: 'var(--text-tertiary)',
    padding: '0 16px 12px',
    borderBottom: '1px solid var(--border)',
  },
  closeBtn: {
    width: 28, height: 28, borderRadius: '50%',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--bg-elevated)', color: 'var(--text-tertiary)',
    border: '1px solid var(--border)',
  },
  tree: {
    flex: 1, overflowY: 'auto',
    padding: '8px 0 24px',
  },
  rootHeader: {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '10px 16px 12px',
    fontSize: 14, fontFamily: 'var(--font-mono)',
    color: 'var(--text-secondary)',
  },
  rootHeaderText: { fontSize: 14 },

  browseRow: {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '10px 16px 10px 0',
    minHeight: 40,
  },
  disclosureBtn: {
    width: 26, height: 26,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'transparent', color: 'var(--text-tertiary)',
    border: 'none', flexShrink: 0,
    cursor: 'pointer',
  },
  browseRowName: {
    flex: 1, display: 'flex', alignItems: 'center', gap: 8,
    minWidth: 0, overflow: 'hidden',
  },
  browseRowNameText: {
    fontSize: 15, color: 'var(--text-primary)',
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  rowMeta: {
    fontSize: 12, color: 'var(--text-tertiary)',
    fontFamily: 'var(--font-mono)',
    flexShrink: 0,
    minWidth: 0,
  },
  addRowBtn: {
    width: 30, height: 30,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--accent-dim)', color: 'var(--accent)',
    border: '1px solid var(--accent)',
    borderRadius: 6,
    flexShrink: 0,
    cursor: 'pointer',
  },
  tagAdded: {
    fontSize: 10, fontWeight: 700,
    padding: '3px 8px',
    background: 'var(--accent-dim)',
    color: 'var(--accent)',
    borderRadius: 4,
    flexShrink: 0,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
  },
  tagCovered: {
    fontSize: 10,
    padding: '3px 8px',
    background: 'transparent',
    color: 'var(--text-tertiary)',
    border: '1px solid var(--border)',
    borderRadius: 4,
    flexShrink: 0,
    letterSpacing: '0.04em',
  },
  browseEmpty: {
    fontSize: 13, color: 'var(--text-tertiary)',
    padding: '6px 16px 6px 0',
    fontStyle: 'italic',
  },
  browseError: {
    fontSize: 13, color: 'var(--red, #f47174)',
    padding: '6px 16px 6px 0',
  },
  spinner: {
    width: 14, height: 14,
    border: '2px solid var(--border)',
    borderTopColor: 'var(--accent)',
    borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
    marginLeft: 8,
  },
}
