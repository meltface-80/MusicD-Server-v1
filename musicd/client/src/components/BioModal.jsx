import React, { useEffect, useState } from 'react'
import { api } from '../api'
import { X, ExternalLink, RefreshCw } from 'lucide-react'

// Bio modal (#30.23)
// ===================
// Sheet that shows narrative content for one album or artist. Loaded
// lazily via /api/library/{albums|artists}/.../bio. The endpoint
// caches results on the server, so the first open of an entity is
// network-bound; subsequent opens are instant.
//
// We render the prose as plain text wrapped in <p> per paragraph.
// Source attribution and "read full article" link sit in a footer
// that reflects whichever provider gave us content.
//
// Props:
//   kind        -- 'album' | 'artist'
//   id          -- albumId for albums, artist name for artists
//   title       -- display string for the header (album title or artist name)
//   subtitle    -- optional secondary line (album artist for albums)
//   onClose     -- dismiss callback

const SOURCE_LABELS = {
  wikipedia:     'Wikipedia',
  lastfm:        'Last.fm',
  audiodb:       'TheAudioDB',
  'mb-annotation': 'MusicBrainz',
}

export default function BioModal({ kind, id, title, subtitle, onClose }) {
  const [bio, setBio] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [refreshing, setRefreshing] = useState(false)
  // Matcher-running flag (#30.24). When the matcher is going at
  // 1 req/sec, our bio fetch queues behind it on the shared MB
  // throttle and could take many minutes to start. Showing a
  // special "queued" message lets the user choose to wait or
  // close, rather than stare at a generic spinner.
  const [matcherRunning, setMatcherRunning] = useState(false)

  const path = kind === 'album'
    ? `/library/albums/${id}/bio`
    : `/library/artists/${encodeURIComponent(id)}/bio`

  const load = async (force = false) => {
    if (force) {
      setRefreshing(true)
    } else {
      setLoading(true)
    }
    // Check matcher state up front so we can show the right
    // loading message. We fetch matcher progress in parallel with
    // the bio request so total latency isn't worsened.
    api.get('/library/match/progress')
      .then(p => setMatcherRunning(!!p?.running))
      .catch(() => {})
    try {
      const data = await api.get(`${path}${force ? '?force=1' : ''}`)
      setBio(data)
      setError(null)
    } catch (e) {
      setError(e.message || 'Failed to load')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => { load(false) }, [id])

  // Split bio content into paragraphs. Sources differ in how they
  // signal paragraph breaks; the bio fetcher's stripHtml normalises
  // them all to \n\n before storage. This split renders one <p> per
  // paragraph; if a source returned a single block of text, we get
  // one paragraph and that's fine.
  const paragraphs = (bio?.content || '')
    .split(/\n\n+/)
    .map(p => p.trim())
    .filter(Boolean)

  return (
    <div style={s.overlay} onClick={onClose}>
      <div style={s.sheet} onClick={e => e.stopPropagation()}>
        <div style={s.handle} />
        <div style={s.header}>
          <div style={s.headerText}>
            <div style={s.title}>{title}</div>
            {subtitle && <div style={s.subtitle}>{subtitle}</div>}
          </div>
          <div style={s.headerBtns}>
            {/* Refresh button (#30.24): shown for ok, no_match, and
                error states. Previously only ok -- meaning users who
                got a "no bio available" cached result had no way to
                retry. Hidden during initial load and for no_mbid
                (where retry won't help -- they need to run the
                matcher first). */}
            {bio && bio.fetch_status !== 'no_mbid' && (
              <button
                style={s.iconBtn}
                onClick={() => load(true)}
                disabled={refreshing}
                title="Refresh"
              >
                <RefreshCw size={13} style={refreshing ? { animation: 'pulse 1.5s ease-in-out infinite' } : {}} />
              </button>
            )}
            <button style={s.iconBtn} onClick={onClose} aria-label="Close">
              <X size={14} />
            </button>
          </div>
        </div>

        <div style={s.body}>
          {loading && (
            <div style={s.message}>
              {matcherRunning
                ? 'The album matcher is running and we share its 1 req/sec MusicBrainz throttle. Your bio request is queued -- this can take anywhere from a few seconds to a few minutes depending on queue depth. Stay or close and come back later.'
                : 'Looking up bio…'}
            </div>
          )}

          {error && !loading && (
            <div style={{ ...s.message, color: '#e85a7a' }}>{error}</div>
          )}

          {bio && bio.fetch_status === 'no_mbid' && (
            <div style={s.message}>
              <div style={s.emptyTitle}>No MusicBrainz match</div>
              <div style={s.emptyHint}>
                This {kind} hasn't been matched against MusicBrainz, so we can't reliably fetch a bio. Run the album matcher in Settings → Metadata Refresh, then come back.
              </div>
            </div>
          )}

          {bio && bio.fetch_status === 'error' && bio.source === 'no_mb_contact' && (
            <div style={s.message}>
              <div style={s.emptyTitle}>MusicBrainz contact required</div>
              <div style={s.emptyHint}>
                Set a contact (URL or email) in Settings → Metadata Refresh → Album matching. MusicBrainz requires identifying contact info before serving requests, and the bio fetcher uses MusicBrainz to find canonical Wikipedia URLs.
              </div>
            </div>
          )}

          {bio && bio.fetch_status === 'no_match' && (
            <div style={s.message}>
              <div style={s.emptyTitle}>No bio available</div>
              <div style={s.emptyHint}>
                We checked Wikipedia, Last.fm, and a few other sources but none had content for this {kind}. Bios are sparser for less-mainstream artists and deeper-cut albums.
                {bio.source_url && (
                  <div style={{ marginTop: 12 }}>
                    <a href={bio.source_url} target="_blank" rel="noopener noreferrer" style={s.link}>
                      View on MusicBrainz <ExternalLink size={11} />
                    </a>
                  </div>
                )}
              </div>
            </div>
          )}

          {bio && bio.fetch_status === 'error' && (
            <div style={s.message}>
              <div style={s.emptyTitle}>Couldn't reach bio sources</div>
              <div style={s.emptyHint}>
                A network error stopped the fetch. Try the refresh button.
              </div>
            </div>
          )}

          {bio && bio.fetch_status === 'ok' && bio.content && (
            <>
              <div style={s.prose}>
                {paragraphs.map((p, i) => (
                  <p key={i} style={s.paragraph}>{p}</p>
                ))}
              </div>
              <div style={s.footer}>
                <span style={s.attribution}>
                  From <strong>{SOURCE_LABELS[bio.source] || bio.source}</strong>
                </span>
                {bio.source_url && (
                  <a href={bio.source_url} target="_blank" rel="noopener noreferrer" style={s.link}>
                    Read full article <ExternalLink size={11} />
                  </a>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

const s = {
  overlay: { position: 'fixed', inset: 0, zIndex: 850, background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'flex-end' },
  sheet: { background: 'var(--bg-surface)', borderRadius: '16px 16px 0 0', width: '100%', maxHeight: '88vh', display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--border)' },
  handle: { width: 40, height: 4, background: 'var(--text-muted)', borderRadius: 2, margin: '8px auto 4px', opacity: 0.4 },
  header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '8px 16px 12px', borderBottom: '1px solid var(--border)', gap: 8 },
  headerText: { flex: 1, minWidth: 0 },
  title: { fontSize: 15, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  subtitle: { fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  headerBtns: { display: 'flex', gap: 6, flexShrink: 0 },
  iconBtn: { width: 30, height: 30, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-elevated)', color: 'var(--text-secondary)', border: '1px solid var(--border)', cursor: 'pointer' },
  body: { flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' },

  message: { padding: 28, textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13 },
  emptyTitle: { fontSize: 14, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8 },
  emptyHint: { fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 },

  prose: {
    flex: 1,
    padding: '16px 18px',
    color: 'var(--text-primary)',
  },
  paragraph: {
    fontSize: 13,
    lineHeight: 1.6,
    color: 'var(--text-secondary)',
    marginBottom: 12,
  },

  footer: {
    padding: '12px 18px',
    borderTop: '1px solid var(--border)',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    fontSize: 11,
    color: 'var(--text-tertiary)',
    flexWrap: 'wrap',
    gap: 8,
  },
  attribution: { fontSize: 11, color: 'var(--text-tertiary)' },
  link: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    color: 'var(--accent)',
    textDecoration: 'none',
    fontSize: 11,
  },
}
