import React, { useEffect, useState, useCallback } from 'react'
import { api } from '../api'
import { AlertCircle, HelpCircle, X, ExternalLink, Search, ScanLine } from 'lucide-react'

// Unmatched albums screen (#30.19, manual matching #v1.1.0.21)
// =============================================================
// Lists albums whose MusicBrainz match is uncertain (multiple
// candidates or low score) or unmatched (nothing found). User can
// open one to see candidates the matcher considered, confirm one,
// reject the album entirely, or do a free-text MB search to find
// it manually.

export default function UnmatchedScreen() {
  const [data, setData] = useState({ total: 0, albums: [], offset: 0 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selected, setSelected] = useState(null)  // { id, title, ... }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api.get('/library/unmatched?limit=200')
      setData(r)
      setError(null)
    } catch (e) {
      setError(e.message || 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  if (loading) return <div style={s.message}>Loading…</div>

  if (error) {
    return (
      <div style={s.message}>
        <div style={s.errorRow}>
          <AlertCircle size={14} />
          <span>{error}</span>
        </div>
        <button style={s.btn} onClick={load}>Retry</button>
      </div>
    )
  }

  if (data.total === 0) {
    return (
      <div style={s.message}>
        <div style={s.empty}>
          <div style={s.emptyTitle}>Nothing to triage</div>
          <div style={s.emptyHint}>
            All your albums either matched cleanly to MusicBrainz or haven't been processed yet. Run the matcher from Settings → Metadata.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={s.root}>
      <div style={s.header}>
        <div style={s.title}>Unmatched</div>
        <div style={s.subtitle}>
          {data.total} album{data.total === 1 ? '' : 's'} need attention
        </div>
        <div style={s.help}>
          The matcher couldn't confidently identify these albums on MusicBrainz. Tap one to confirm a candidate, search MusicBrainz manually, or reject the album.
        </div>
      </div>

      <div style={s.list}>
        {data.albums.map(a => (
          <button key={a.id} style={s.row} onClick={() => setSelected(a)}>
            {a.cover_art
              ? <img src={a.cover_art} alt="" style={s.cover} draggable={false} />
              : <div style={s.coverPlaceholder} />}
            <div style={s.rowText}>
              <div style={s.rowTitle}>{a.title}</div>
              <div style={s.rowArtist}>{a.album_artist}</div>
              <div style={s.rowMeta}>
                {a.year ? `${a.year} · ` : ''}
                {a.track_count} track{a.track_count === 1 ? '' : 's'} ·{' '}
                <span style={a.match_status === 'unmatched' ? s.statusUnmatched : s.statusUncertain}>
                  {a.match_status === 'unmatched' ? 'no match' : `uncertain (${a.match_confidence ?? 0}%)`}
                </span>
              </div>
            </div>
            <HelpCircle size={14} style={{ flexShrink: 0, color: 'var(--text-tertiary)' }} />
          </button>
        ))}
      </div>

      {selected && (
        <CandidatesModal
          album={selected}
          onClose={() => setSelected(null)}
          onResolved={() => { setSelected(null); load(); }}
        />
      )}
    </div>
  )
}

// Modal showing candidates for a given album with confirm / reject /
// manual-search actions (#v1.1.0.21).
function CandidatesModal({ album, onClose, onResolved }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [busyMbid, setBusyMbid] = useState(null)
  const [actionError, setActionError] = useState(null)

  // Manual-search state. Search is opt-in (a button toggles the
  // search box) so we don't push 25 fresh MB results onto every
  // user who's just confirming an existing candidate.
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQ, setSearchQ] = useState(`${album.title} ${album.album_artist}`)
  const [searchResults, setSearchResults] = useState(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState(null)

  // AcoustID fingerprint state (#v1.1.0.22). Single button that
  // fingerprints up to 3 tracks and returns release-group candidates.
  // Call is synchronous server-side and takes 5-30s.
  const [fpResults, setFpResults] = useState(null)
  const [fpRunning, setFpRunning] = useState(false)
  const [fpError, setFpError] = useState(null)
  const [fpReason, setFpReason] = useState(null)

  useEffect(() => {
    let cancelled = false
    api.get(`/library/match/${album.id}/candidates`)
      .then(r => { if (!cancelled) setData(r) })
      .catch(e => { if (!cancelled) setError(e.message || 'Failed') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [album.id])

  const confirm = async (cand) => {
    setBusyMbid(cand.mbid)
    setActionError(null)
    try {
      await api.post(`/library/match/${album.id}/confirm`, {
        mbid: cand.mbid,
        title: cand.title,
        artist: cand.artist,
        year: cand.firstReleaseDate ? cand.firstReleaseDate.slice(0, 4) : null,
      })
      onResolved && onResolved()
    } catch (e) {
      setActionError(e.message || 'Confirm failed')
    } finally {
      setBusyMbid(null)
    }
  }

  const reject = async () => {
    setBusyMbid('__reject__')
    setActionError(null)
    try {
      await api.post(`/library/match/${album.id}/reject`)
      onResolved && onResolved()
    } catch (e) {
      setActionError(e.message || 'Reject failed')
    } finally {
      setBusyMbid(null)
    }
  }

  const runSearch = async () => {
    const q = searchQ.trim()
    if (q.length < 2) return
    setSearching(true)
    setSearchError(null)
    setSearchResults(null)
    try {
      const r = await api.get(`/library/match/search?q=${encodeURIComponent(q)}`)
      setSearchResults(r.results || [])
    } catch (e) {
      setSearchError(e.message || 'Search failed')
    } finally {
      setSearching(false)
    }
  }

  // Fingerprint match (#v1.1.0.22). Synchronous server call that
  // fingerprints up to 3 tracks and queries AcoustID. Takes 5-30s.
  const runFingerprint = async () => {
    setFpRunning(true)
    setFpError(null)
    setFpResults(null)
    setFpReason(null)
    try {
      const r = await api.post(`/library/match/${album.id}/fingerprint`)
      setFpResults(r.candidates || [])
      setFpReason(r.reason || null)
    } catch (e) {
      setFpError(e.message || 'Fingerprint match failed')
    } finally {
      setFpRunning(false)
    }
  }

  const renderCandidate = (c, key) => (
    <div key={key} style={s.candRow}>
      <div style={s.candText}>
        <div style={s.candTitle}>{c.title}</div>
        <div style={s.candArtist}>{c.artist}</div>
        <div style={s.candMeta}>
          {c.firstReleaseDate ? `${c.firstReleaseDate.slice(0, 4)} · ` : ''}
          {c.primaryType || 'release group'}
          {c.score != null ? ` · score ${c.score}` : ''}
          {c.mbScore && c.mbScore !== c.score ? ` · MB ${c.mbScore}` : ''}
        </div>
      </div>
      <div style={s.candActions}>
        <a href={`https://musicbrainz.org/release-group/${c.mbid}`}
           target="_blank" rel="noopener noreferrer"
           style={s.iconBtn}
           title="View on MusicBrainz">
          <ExternalLink size={12} />
        </a>
        <button
          style={{ ...s.confirmBtn, ...(busyMbid === c.mbid ? s.btnBusy : {}) }}
          disabled={!!busyMbid}
          onClick={() => confirm(c)}>
          {busyMbid === c.mbid ? '…' : 'Use this'}
        </button>
      </div>
    </div>
  )

  return (
    <div style={s.overlay} onClick={onClose}>
      <div style={s.sheet} onClick={e => e.stopPropagation()}>
        <div style={s.sheetHeader}>
          <div>
            <div style={s.sheetTitle}>{album.title}</div>
            <div style={s.sheetSubtitle}>{album.album_artist}{album.year ? ` · ${album.year}` : ''}</div>
          </div>
          <button style={s.closeBtn} onClick={onClose} aria-label="Close"><X size={14} /></button>
        </div>

        {loading && <div style={s.message}>Loading candidates…</div>}
        {error && <div style={{ ...s.message, color: '#e85a7a' }}>{error}</div>}

        <div style={s.scrollArea}>
          {data && data.candidates.length === 0 && !searchOpen && (
            <div style={s.message}>
              <div style={s.emptyHint}>
                The matcher found no candidates on MusicBrainz. Try a manual search below — the album may use a non-Latin script, or the artist/title tags may not match what's in MB.
              </div>
            </div>
          )}

          {data && data.candidates.length > 0 && (
            <div style={s.candList}>
              <div style={s.sectionLabel}>Candidates the matcher found</div>
              {data.candidates.map((c, i) => renderCandidate(c, `auto-${i}`))}
            </div>
          )}

          {/* Fingerprint section (#v1.1.0.22). Single button that
              fingerprints up to 3 tracks and queries AcoustID. Slow
              (5-30s) so we surface a clear loading state and don't
              auto-run -- user has to tap. */}
          <div style={s.searchSection}>
            {!fpResults && !fpError && (
              <button
                style={{ ...s.searchOpenBtn, ...(fpRunning ? s.btnBusy : {}) }}
                disabled={fpRunning}
                onClick={runFingerprint}>
                <ScanLine size={12} />
                {fpRunning ? ' Fingerprinting tracks…' : ' Try AcoustID fingerprint match'}
              </button>
            )}
            {fpRunning && (
              <div style={s.fpHint}>
                Sampling tracks and querying AcoustID. This usually takes 5–30 seconds.
              </div>
            )}
            {fpError && (
              <div style={s.searchErr}>{fpError}</div>
            )}
            {fpResults && fpResults.length === 0 && (
              <div style={s.searchEmpty}>
                AcoustID found no match.{fpReason ? ` (${fpReason})` : ''}
              </div>
            )}
            {fpResults && fpResults.length > 0 && (
              <div style={s.searchResults}>
                <div style={s.sectionLabel}>Fingerprint results ({fpResults.length})</div>
                {fpResults.map((c, i) => renderCandidate(c, `fp-${i}`))}
              </div>
            )}
          </div>

          {/* Manual search section. Closed by default; opens with a tap.
              Pre-populates with title + artist so the most common case
              ("the matcher's query was almost right") needs zero typing. */}
          <div style={s.searchSection}>
            {!searchOpen && (
              <button style={s.searchOpenBtn} onClick={() => setSearchOpen(true)}>
                <Search size={12} /> Search MusicBrainz manually
              </button>
            )}
            {searchOpen && (
              <>
                <div style={s.searchRow}>
                  <input
                    style={s.searchInput}
                    type="text"
                    value={searchQ}
                    onChange={e => setSearchQ(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && runSearch()}
                    placeholder="album title and/or artist"
                  />
                  <button
                    style={{ ...s.searchBtn, ...(searching ? s.btnBusy : {}) }}
                    disabled={searching || searchQ.trim().length < 2}
                    onClick={runSearch}>
                    {searching ? '…' : 'Search'}
                  </button>
                </div>
                {searchError && (
                  <div style={s.searchErr}>{searchError}</div>
                )}
                {searchResults && searchResults.length === 0 && (
                  <div style={s.searchEmpty}>No results.</div>
                )}
                {searchResults && searchResults.length > 0 && (
                  <div style={s.searchResults}>
                    <div style={s.sectionLabel}>Search results ({searchResults.length})</div>
                    {searchResults.map((c, i) => renderCandidate(c, `search-${i}`))}
                  </div>
                )}
              </>
            )}
          </div>

          {actionError && (
            <div style={s.searchErr}>{actionError}</div>
          )}
        </div>

        <div style={s.sheetFooter}>
          <button
            style={{ ...s.rejectBtn, ...(busyMbid === '__reject__' ? s.btnBusy : {}) }}
            disabled={!!busyMbid}
            onClick={reject}>
            {busyMbid === '__reject__' ? '…' : "Reject — there's no MB record for this"}
          </button>
        </div>
      </div>
    </div>
  )
}

const s = {
  root: { padding: 16, paddingBottom: 80 },
  header: { marginBottom: 16 },
  title: { fontSize: 22, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 },
  subtitle: { fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 12 },
  help: { fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 },
  message: { padding: 24, textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13 },
  errorRow: { display: 'inline-flex', alignItems: 'center', gap: 6, color: '#e85a7a', marginBottom: 12 },
  empty: { },
  emptyTitle: { fontSize: 16, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8 },
  emptyHint: { fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 },
  btn: { padding: '8px 14px', borderRadius: 'var(--radius-sm)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border)', fontSize: 12, cursor: 'pointer' },

  list: { display: 'flex', flexDirection: 'column', gap: 6 },
  row: {
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '10px 12px',
    background: 'var(--bg-overlay)', border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    width: '100%', textAlign: 'left', cursor: 'pointer',
  },
  cover: { width: 48, height: 48, borderRadius: 4, objectFit: 'cover', flexShrink: 0 },
  coverPlaceholder: { width: 48, height: 48, borderRadius: 4, background: 'var(--bg-elevated)', flexShrink: 0 },
  rowText: { flex: 1, minWidth: 0, overflow: 'hidden' },
  rowTitle: { fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  rowArtist: { fontSize: 11, color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 1 },
  rowMeta: { fontSize: 10, color: 'var(--text-tertiary)', marginTop: 3 },
  statusUnmatched: { color: '#e85a7a' },
  statusUncertain: { color: '#e6a700' },

  // Candidates modal
  overlay: { position: 'fixed', inset: 0, zIndex: 900, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'flex-end' },
  sheet: { paddingBottom: 'var(--safe-bot)', background: 'var(--bg-surface)', borderRadius: '16px 16px 0 0', width: '100%', maxHeight: '85vh', display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--border)' },
  sheetHeader: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid var(--border)', gap: 8 },
  sheetTitle: { fontSize: 15, fontWeight: 700 },
  sheetSubtitle: { fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2 },
  closeBtn: { width: 28, height: 28, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-elevated)', color: 'var(--text-tertiary)', border: '1px solid var(--border)', flexShrink: 0 },
  // Middle scrollable area inside the sheet -- holds candidates +
  // search section. Pinned header stays above; pinned reject footer
  // stays below; this scrolls. (#v1.1.0.21)
  scrollArea: { flex: 1, overflowY: 'auto' },
  // candList is no longer the scroll container -- the manual-search
  // section sits below it and the whole stack scrolls together. Each
  // section just renders its own candidate rows. (#v1.1.0.21)
  candList: { padding: '8px 12px 0' },
  // Section label above each group of candidates ("Candidates the
  // matcher found", "Search results"). Quiet, all-caps, like a list
  // header in iOS settings.
  sectionLabel: { fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-tertiary)', padding: '0 4px 6px' },
  candRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', background: 'var(--bg-overlay)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', marginBottom: 6 },
  candText: { flex: 1, minWidth: 0, overflow: 'hidden' },
  candTitle: { fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  candArtist: { fontSize: 11, color: 'var(--text-secondary)', marginTop: 1 },
  candMeta: { fontSize: 10, color: 'var(--text-tertiary)', marginTop: 3, fontFamily: 'var(--font-mono)' },
  candActions: { display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 },
  iconBtn: { width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 'var(--radius-sm)', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-tertiary)', textDecoration: 'none' },
  confirmBtn: { padding: '6px 10px', fontSize: 11, fontWeight: 600, borderRadius: 'var(--radius-sm)', background: 'var(--accent)', color: 'var(--on-accent)', border: 'none', cursor: 'pointer', whiteSpace: 'nowrap' },
  rejectBtn: { width: '100%', padding: '10px 12px', fontSize: 12, fontWeight: 500, borderRadius: 'var(--radius-sm)', background: 'transparent', color: '#e85a7a', border: '1px solid #e85a7a', cursor: 'pointer' },
  btnBusy: { opacity: 0.6, cursor: 'wait' },
  // Manual search section (#v1.1.0.21). Sits between candidate list
  // and the footer reject button. Closed by default; a single button
  // opens an input + Search button. Pre-populated with the album's
  // existing title + artist so the obvious case needs no typing.
  searchSection: { padding: '8px 12px 12px', borderTop: '1px solid var(--border-soft, var(--border))' },
  searchOpenBtn: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 12px', fontSize: 12, color: 'var(--text-secondary)', background: 'var(--bg-overlay)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer' },
  searchRow: { display: 'flex', gap: 6, marginBottom: 8 },
  searchInput: { flex: 1, minWidth: 0, padding: '8px 10px', fontSize: 13, background: 'var(--bg-overlay)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', outline: 'none' },
  searchBtn: { padding: '8px 12px', fontSize: 12, fontWeight: 600, background: 'var(--accent)', color: 'var(--on-accent)', border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer' },
  searchErr: { padding: '8px 12px', fontSize: 11, color: '#e85a7a' },
  searchEmpty: { padding: '8px 4px', fontSize: 11, color: 'var(--text-tertiary)' },
  searchResults: { paddingTop: 4 },
  // Fingerprint loading hint (#v1.1.0.22). Italic, secondary colour,
  // makes the wait feel intentional rather than broken.
  fpHint: { padding: '8px 4px', fontSize: 11, color: 'var(--text-tertiary)', fontStyle: 'italic' },
  sheetFooter: { padding: '12px 16px', borderTop: '1px solid var(--border)' },
}
