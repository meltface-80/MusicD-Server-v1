import React from 'react'
import { useStore } from '../store'

// Phase labels + icons. Tweaks to copy go here.
const PHASES = {
  walking:           { label: 'Looking for files', icon: '📁' },
  loading_existing:  { label: 'Reading existing tracks', icon: '📋' },
  scanning:          { label: 'Reading metadata', icon: '🔍' },
  rebuilding_stats:  { label: 'Updating album stats', icon: '📊' },
  enriching_art:     { label: 'Fetching cover art', icon: '🎨' },
}

export default function LibraryStatusBanner() {
  const { libraryStatus } = useStore()
  if (!libraryStatus || libraryStatus.phase === 'idle') return null

  const phase = PHASES[libraryStatus.phase] || { label: libraryStatus.phase, icon: '⚙️' }
  const { processedFiles, totalFiles, artProcessed, artTotal } = libraryStatus

  // Pick the right progress to show based on phase
  let progressLabel = phase.label
  let pct = null
  if (libraryStatus.phase === 'scanning' && totalFiles > 0) {
    pct = (processedFiles / totalFiles) * 100
    progressLabel = `${phase.icon}  ${phase.label} — ${processedFiles.toLocaleString()} / ${totalFiles.toLocaleString()}`
  } else if (libraryStatus.phase === 'enriching_art' && artTotal > 0) {
    pct = (artProcessed / artTotal) * 100
    progressLabel = `${phase.icon}  ${phase.label} — ${artProcessed} / ${artTotal}`
  } else {
    progressLabel = `${phase.icon}  ${phase.label}…`
  }

  return (
    <div style={s.bar}>
      <div style={s.label}>{progressLabel}</div>
      <div style={s.track}>
        <div style={{ ...s.fill, ...(pct === null ? s.fillIndeterminate : { width: `${pct}%` }) }} />
      </div>
    </div>
  )
}

const s = {
  bar: {
    padding: '6px 14px',
    background: 'var(--bg-elevated)',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0,
    // Banner needs explicit relative+zIndex so it sits ABOVE
    // page-level fixed backgrounds (#v1.1.0.16). AlbumDetail uses
    // position:fixed cover-art blur as a hero background -- those
    // fixed elements cover the viewport, including under the banner,
    // making the banner appear translucent/dimmed. Promoting the
    // banner to a stacking context above z-index 1 keeps it readable
    // regardless of what page is visible behind it.
    position: 'relative',
    zIndex: 10,
  },
  label: { fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4, fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  track: { height: 2, background: 'var(--bg-overlay)', borderRadius: 1, overflow: 'hidden', position: 'relative' },
  fill: { height: '100%', background: 'var(--accent)', transition: 'width 0.4s ease' },
  fillIndeterminate: {
    width: '30%',
    animation: 'indeterminate 1.4s ease-in-out infinite',
  },
}
