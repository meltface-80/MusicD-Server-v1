import React from 'react'
import TagManagementSection from './TagManagementSection'

// Tags, as a sidebar screen (v1.1.20.0).
//
// This lived under Settings → Tags, which put a browsing surface behind an
// admin screen: tags are a way through the library, like Favourites and Saved
// for later, and those are in the side menu. The management UI itself is
// unchanged — TagManagementSection is the same component Settings rendered —
// only where it hangs has moved.
export default function TagsScreen() {
  return (
    <div style={s.page}>
      <div style={s.titleRow}>
        <h1 style={s.heading}>Tags</h1>
      </div>
      <p style={s.blurb}>
        Rename, recolour and delete your tags. Apply them from the ⋯ menu on a
        track, or from an album's overflow sheet.
      </p>
      <TagManagementSection />
    </div>
  )
}

const s = {
  // Screens pad themselves for the safe areas; the app shell never does.
  // See the iOS PWA rules in CLAUDE.md.
  page: { padding: '0 16px', paddingBottom: 'calc(120px + var(--safe-bot))' },
  titleRow: { display: 'flex', alignItems: 'center', paddingTop: 'calc(8px + var(--safe-top))' },
  heading: { fontSize: 26, fontWeight: 700, color: 'var(--jp-text)', margin: '8px 0 4px' },
  blurb: { fontSize: 12, color: 'var(--jp-text-3)', lineHeight: 1.5, margin: '0 0 14px' },
}
