import React, { useEffect, useState } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import { Volume2, Play, Square, Download, RefreshCw, ChevronRight, ChevronLeft, User, Sliders, Headphones, Folder, Save, Image as ImageIcon, Radio, LogOut, Cable, Key, Home, Power, Cpu } from 'lucide-react'
import DspTab from './DspTab'
import AutoEqTab from './AutoEqTab'
import LibraryScopeSection from './LibraryScopeSection'
import HelpTooltip from './HelpTooltip'
import {
  classifyShare, hasAsyncClipboard, reportDownloadUrl,
  SHARE_FILES, SHARE_INSECURE,
} from '../bugReportShare'
import BackupSection from './BackupSection'
import HomeScreenSection from './HomeScreenSection'
import AudioSection from './AudioSection'
import CpuTweaksSection from './CpuTweaksSection'

// Settings section navigation (#30.26).
// Sections used to be inline accordions. They're now full-screen
// sub-pages: tap a card on the index → slide in to that section's
// content; tap the back chevron in its topbar → slide back to the
// index. The state lives in the global store (settingsSubSection)
// so App.jsx's topbar back chevron knows about Settings sub-pages.
//
// SectionCard: the tappable row on the Settings index.
// SectionPage: the full-screen content view (header + scrollable body).
// RestartButton: top-right of the Settings index — calls
//   /api/settings/restart, polls /api/health until the server is
//   back, then reloads the page. v1.1.3.3.
//
// v1.1.3.4: when confirming, the prompt now takes over the full
// brand row instead of trying to share it with the icon and title.
// On a phone, 56px of right-aligned width was too narrow for the
// "Are you sure…?" string, which clipped past the screen edge.
// The cleanest fix is to coordinate state at the brand-row level
// and conditionally render either the icon+title+button OR the
// full-width confirm prompt.

function RestartButton({ onConfirm }) {
  return (
    <button
      type="button"
      style={s.restartBtn}
      onClick={onConfirm}
      title="Restart server"
      aria-label="Restart server"
    >
      <Power size={26} />
    </button>
  )
}

function RestartBusy() {
  return (
    <div style={s.restartBusy} title="Restarting…">
      <RefreshCw size={20} style={{ animation: 'spin 1s linear infinite' }} />
    </div>
  )
}

function RestartConfirmRow({ onYes, onNo }) {
  return (
    <div style={s.restartConfirmRow} role="alertdialog" aria-label="Confirm restart">
      <div style={s.restartConfirmText}>Are you sure you want to restart the server?</div>
      <div style={s.restartConfirmActions}>
        <button type="button" style={s.restartConfirmYes} onClick={onYes}>Yes</button>
        <button type="button" style={s.restartConfirmNo} onClick={onNo}>No</button>
      </div>
    </div>
  )
}

// Wraps the restart logic so the brand row can call into it without
// having to know about polling/redirects.
function useRestartFlow() {
  const [phase, setPhase] = useState('idle')  // idle | confirming | restarting

  const begin = () => setPhase('confirming')
  const cancel = () => setPhase('idle')

  const fire = async () => {
    setPhase('restarting')
    try {
      await api.post('/settings/restart')
    } catch {
      // Server may exit before flushing the response — that's fine,
      // health polling tells us when it's back.
    }
    const deadline = Date.now() + 60000
    const tick = async () => {
      if (Date.now() > deadline) {
        setPhase('idle')
        alert('Server did not come back within 60 seconds. Try reloading the page manually.')
        return
      }
      try {
        const r = await fetch('/api/settings/health', { cache: 'no-store' })
        if (r.ok) {
          window.location.reload()
          return
        }
      } catch { /* still down */ }
      setTimeout(tick, 1000)
    }
    setTimeout(tick, 1500)
  }

  return { phase, begin, cancel, fire }
}

function SectionCard({ id, title, icon, onOpen }) {
  return (
    <button type="button" style={s.sectionCard} onClick={() => onOpen(id)}>
      <span style={s.sectionCardTitle}>{icon}{title}</span>
      <ChevronRight size={16} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
    </button>
  )
}

function SectionPage({ title, icon, onBack, children }) {
  return (
    <div style={s.sectionPage}>
      <button type="button" style={s.sectionPageHeader} onClick={onBack}>
        <ChevronLeft size={18} style={{ color: 'var(--text-secondary)' }} />
        <span style={s.sectionPageTitle}>{icon}{title}</span>
      </button>
      <div style={s.sectionPageBody}>
        {children}
      </div>
    </div>
  )
}

// Backwards-compat shim. The codebase calls <Section id=... title=...>
// in many places. This component used to render an inline accordion
// (#15) and was rewritten in #30.26 for full-screen sub-pages. It
// now only renders its children when its id matches the currently
// open sub-section. The card list on the Settings index is rendered
// explicitly by SettingsScreen, not via these Section components --
// they only do anything when a sub-section is active.
function Section({ id, openSection, children }) {
  if (openSection === id) {
    return <>{children}</>
  }
  return null
}

export default function SettingsScreen({ onBack }) {
  const [settings, setSettings] = useState(null)
  const restartFlow = useRestartFlow()
  const [progress, setProgress] = useState({ running: false, processed: 0, total: 0 })
  const [logoProgress, setLogoProgress] = useState({ running: false, processed: 0, total: 0, sources: { fanart: 0, audiodb: 0, typographic: 0 } })
  // MusicBrainz matcher progress (#30.19). Same shape as the loudness
  // and logo progress objects but with match-specific fields.
  const [matchProgress, setMatchProgress] = useState({ running: false, processed: 0, total: 0, matched: 0, uncertain: 0, unmatched: 0, errored: 0, lastError: null, unmatchedCount: 0 })
  // Last.fm scrobbler state (#30.25). Populated from /api/scrobble/status.
  const [scrobbleStatus, setScrobbleStatus] = useState({ connected: false, username: null, lastError: null, queueDepth: 0, hasApiKey: false, hasApiSecret: false })
  // Login form drafts (not persisted; cleared after successful login).
  const [scrobbleUsername, setScrobbleUsername] = useState('')
  const [scrobblePassword, setScrobblePassword] = useState('')
  const [scrobbleError, setScrobbleError] = useState(null)
  const [scrobbleBusy, setScrobbleBusy] = useState(false)
  const [updateInfo, setUpdateInfo] = useState({ currentVersion: '', availableVersion: null })
  const [updateChecking, setUpdateChecking] = useState(false)
  const [updateRunning, setUpdateRunning] = useState(false)
  const [updateError, setUpdateError] = useState(null)
  const [updateLog, setUpdateLog] = useState(null)
  const [showLog, setShowLog] = useState(false)
  // Changelog modal visibility (#v1.1.0.25). Opens in-app, doesn't
  // navigate away from Settings.
  const [showChangelog, setShowChangelog] = useState(false)
  // Remote update status (#30.6) -- last-check timestamp + last
  // result. Polled from /api/update/status. The manifest URL itself
  // is no longer user-configurable as of #v1.1.0.25 (baked in,
  // override via MUSICD_MANIFEST_URL env var) so the related "draft"
  // and "saved" state has been removed.
  const [remoteStatus, setRemoteStatus] = useState(null)
  // v1.1.1.3 — tier and channel state. Polled from /api/update/tier
  // alongside the existing update status. Drives the channel picker,
  // demo banner, "enter code" modal, and feature-flag gates across
  // the rest of the Settings screen.
  const [tierInfo, setTierInfo] = useState(null)
  const [showCodeModal, setShowCodeModal] = useState(false)
  const [codeInput, setCodeInput] = useState('')
  const [codeBusy, setCodeBusy] = useState(false)
  const [codeError, setCodeError] = useState(null)
  const [channelBusy, setChannelBusy] = useState(false)
  // Service health snapshot (#v1.1.0.24). Polled alongside the rest;
  // renders status dots in the API → Built-in services section.
  const [serviceHealth, setServiceHealth] = useState(null)
  // Sub-section nav (#30.26). Source of truth lives in the global
  // store so App.jsx's topbar chevron handler can react to it. When
  // null, we render the section list; when set to an id, we render
  // that section's content full-screen.
  const { settingsSubSection: openSection, setSettingsSubSection: setOpenSection } = useStore()

  const loadAll = () => {
    api.get('/settings').then(setSettings).catch(() => {})
    api.get('/settings/loudness/progress').then(setProgress).catch(() => {})
    api.get('/settings/logos/progress').then(setLogoProgress).catch(() => {})
    api.get('/library/match/progress').then(setMatchProgress).catch(() => {})
    api.get('/scrobble/status').then(setScrobbleStatus).catch(() => {})
    api.get('/settings/health').then(setServiceHealth).catch(() => {})
    // /update/status now returns BOTH the cached check and remote-loop
    // state (manifest URL, last check timestamp, last result).
    api.get('/update/status').then(s => {
      setUpdateInfo({
        currentVersion:   s.currentVersion,
        availableVersion: s.available?.availableVersion || null,
        tarFilename:      s.available?.tarFilename || null,
        source:           s.available?.source || null,
        releaseNotes:     s.available?.releaseNotes || null,
      })
      setRemoteStatus(s.remote || null)
    }).catch(() => {})
    api.get('/update/log').then(r => setUpdateLog(r?.log || null)).catch(() => {})
    // v1.1.1.3 — tier info. Independent of /update/status so a
    // manifest-fetch failure doesn't break the tier UI.
    api.get('/update/tier').then(setTierInfo).catch(() => {})
  }

  useEffect(() => {
    loadAll()
    const t = setInterval(loadAll, 3000)
    return () => clearInterval(t)
  }, [])

  // v1.1.0.78 — diagnostic auto-loads on mount so the Rescan
  // Unmatched section renders its count + Re-queue button
  // immediately. Refreshes every 30s (much slower than loadAll's
  // 3s cadence — the diagnostic does a full albums-table scan
  // with per-row cleaner evaluation, so we don't want it on the
  // hot polling loop). Also refreshes after a manual re-queue
  // (see runRematch below) so the count drops to zero promptly.
  useEffect(() => {
    const fetchDiag = () => {
      api.get('/library/match/diagnostic').then(setDiagnostic).catch(() => {})
    }
    fetchDiag()
    const t = setInterval(fetchDiag, 30_000)
    return () => clearInterval(t)
  }, [])

  // Settings whose values are credentials/tokens we paste from
  // external sites. Apply normalisation defensively at the input
  // layer too (#v1.1.0.2): strip whitespace and surrounding straight
  // or smart quote chars on every keystroke. Mobile copy-paste
  // sometimes drags these in invisibly.
  //
  // v1.1.0.23: lastfm/fanart/audiodb keys are now baked in (see
  // server/src/apiCredentials.js) so the only paste-credential left
  // is the MusicBrainz contact (per-deployer).
  const CREDENTIAL_KEYS = new Set(['mb_contact'])
  const TRIM_QUOTES_REGEX = /^[\s"'\u201C\u201D\u2018\u2019]+|[\s"'\u201C\u201D\u2018\u2019]+$/g

  const update = (key, value) => {
    if (CREDENTIAL_KEYS.has(key) && typeof value === 'string') {
      value = value.replace(TRIM_QUOTES_REGEX, '')
    }
    setSettings(prev => ({ ...prev, [key]: value }))
    api.patch('/settings', { [key]: value }).catch(() => {})
  }

  const startAnalysis = async (force) => {
    await api.post('/settings/loudness/scan', { force })
    setTimeout(loadAll, 500)
  }

  const abortAnalysis = async () => {
    await api.post('/settings/loudness/abort')
    setTimeout(loadAll, 500)
  }

  const startLogos = async (force) => {
    await api.post('/settings/logos/run', { force })
    setTimeout(loadAll, 500)
  }
  const abortLogos = async () => {
    await api.post('/settings/logos/abort')
    setTimeout(loadAll, 500)
  }

  // MusicBrainz album matcher (#30.19). Errors come back as 400s
  // when contact isn't set; we surface those inline so the user
  // sees what to fix without diving into devtools.
  const [matchError, setMatchError] = useState(null)
  const startMatch = async () => {
    setMatchError(null)
    try {
      await api.post('/library/match/start')
      setTimeout(loadAll, 500)
    } catch (e) {
      setMatchError(e.message || 'Failed to start matcher')
    }
  }
  const stopMatch = async () => {
    await api.post('/library/match/stop')
    setTimeout(loadAll, 500)
  }
  // v1.1.0.77 — resetMatch handler removed. The "Reset all" button it
  // backed was a destructive footgun; failed/uncertain/errored
  // matches are now re-queued automatically once per day by the
  // metadata scheduler. The /library/match/reset endpoint stays in
  // place server-side for any tooling that needs it, but no UI
  // surface calls it any more.

  // v1.1.0.66 — diagnostic + rematch for the unmatched set.
  // The diagnostic runs a dry analysis (no MB calls) of how many
  // currently-unmatched albums would be re-queried with a different
  // string under the v66 cleaners. Rematch flips them to pending so
  // the regular worker re-processes them.
  const [diagnostic, setDiagnostic] = useState(null)
  const [diagnosticBusy, setDiagnosticBusy] = useState(false)
  const [rematchBusy, setRematchBusy] = useState(false)
  const [rematchResult, setRematchResult] = useState(null)
  const runDiagnostic = async () => {
    setMatchError(null)
    setDiagnosticBusy(true)
    try {
      const data = await api.get('/library/match/diagnostic')
      setDiagnostic(data)
    } catch (e) {
      setMatchError(e.message || 'Diagnostic failed')
    } finally {
      setDiagnosticBusy(false)
    }
  }
  const runRematch = async () => {
    if (!confirm('Re-queue all currently unmatched, uncertain, or errored albums for retry? They\'ll be processed in the next matcher run at 1 MusicBrainz request per second.')) return
    setMatchError(null)
    setRematchResult(null)
    setRematchBusy(true)
    try {
      const r = await api.post('/library/match/rematch-unmatched')
      setRematchResult(r)
      // Don't auto-start the matcher — the user has to hit "Start"
      // themselves so they're in control of when the MB load happens.
      setTimeout(loadAll, 500)
      // v1.1.0.78 — refresh the diagnostic too, so the count
      // updates after the re-queue (otherwise it stays stale until
      // the next 30s tick).
      api.get('/library/match/diagnostic').then(setDiagnostic).catch(() => {})
    } catch (e) {
      setMatchError(e.message || 'Rematch failed')
    } finally {
      setRematchBusy(false)
    }
  }

  // Scrobble auth handlers (#30.25). Login exchanges the user's
  // Last.fm credentials for a session key on the server. Password is
  // never stored -- it goes through the form once, gets sent over
  // HTTPS to Last.fm, and we keep only the returned session key.
  const scrobbleLogin = async () => {
    setScrobbleError(null)
    if (!scrobbleUsername.trim() || !scrobblePassword) {
      setScrobbleError('Username and password required')
      return
    }
    setScrobbleBusy(true)
    try {
      await api.post('/scrobble/auth/login', {
        username: scrobbleUsername.trim(),
        password: scrobblePassword,
      })
      // Clear the password field immediately on success. We never want
      // it sticking around in component state.
      setScrobblePassword('')
      setScrobbleUsername('')
      // Refresh status so the UI flips to "connected" mode.
      const status = await api.get('/scrobble/status')
      setScrobbleStatus(status)
    } catch (e) {
      setScrobbleError(e.message || 'Login failed')
    } finally {
      setScrobbleBusy(false)
    }
  }
  const scrobbleLogout = async () => {
    if (!confirm('Disconnect from Last.fm? Your local listening history is preserved but tracks will no longer scrobble.')) return
    try {
      await api.post('/scrobble/auth/logout')
      const status = await api.get('/scrobble/status')
      setScrobbleStatus(status)
    } catch (e) {
      setScrobbleError(e.message || 'Logout failed')
    }
  }
  const scrobbleFlush = async () => {
    try {
      const r = await api.post('/scrobble/flush')
      setScrobbleStatus(r.status || (await api.get('/scrobble/status')))
    } catch (e) {
      setScrobbleError(e.message || 'Flush failed')
    }
  }

  const checkForUpdate = async () => {
    setUpdateChecking(true)
    setUpdateError(null)
    try {
      // /check-now triggers a fresh remote-manifest fetch (in addition
      // to scanning the local downloads dir). The shape matches /check.
      const info = await api.post('/update/check-now')
      setUpdateInfo({
        currentVersion:   info.currentVersion,
        availableVersion: info.availableVersion,
        tarFilename:      info.tarFilename || null,
        source:           info.source || null,
        releaseNotes:     info.releaseNotes || null,
      })
      // /check-now also returns remoteStatus when no update is available,
      // so the "last check" timestamp updates immediately.
      if (info.remoteStatus) setRemoteStatus(info.remoteStatus)
      // Refresh full status once more after to pick up everything.
      setTimeout(loadAll, 200)
    } catch (e) {
      setUpdateError(e.message || 'Check failed')
    } finally {
      setUpdateChecking(false)
    }
  }

  // saveManifestUrl removed in #v1.1.0.25 -- manifest URL is no
  // longer user-configurable (baked into the build, overridable via
  // MUSICD_MANIFEST_URL env variable).

  // Library rescan and artwork refresh — moved here from the sidebar
  // (#30.16) so admin actions live alongside the other admin settings.
  // Both fire-and-forget — the actual progress is surfaced by the
  // existing library-status banner on the home screen.
  const [scanning, setScanning] = useState(false)
  const [fetchingArt, setFetchingArt] = useState(false)
  const [artMessage, setArtMessage] = useState(null)
  const handleRescan = async () => {
    setScanning(true)
    try { await api.post('/library/scan') } catch {}
    // Even if the POST returns immediately, give visual feedback for a
    // few seconds so the button doesn't snap back too quickly.
    setTimeout(() => setScanning(false), 3000)
  }
  const handleArtworkRefresh = async () => {
    setFetchingArt(true)
    setArtMessage('Searching for missing artwork...')
    try {
      await api.post('/library/artwork')
      setArtMessage('Running in the background. Check back shortly.')
    } catch (e) {
      setArtMessage('Failed: ' + (e.message || 'unknown error'))
    }
    setTimeout(() => { setFetchingArt(false); setArtMessage(null) }, 5000)
  }

  const startUpdate = async () => {
    if (!updateInfo.availableVersion) return
    if (!confirm(`Update to v${updateInfo.availableVersion}? The server will restart and the page will briefly become unresponsive.`)) return
    setUpdateRunning(true)
    setUpdateError(null)
    try {
      await api.post('/update/run')
      // Server is going down; nothing more to do here. The page will naturally
      // reconnect once the new container comes up.
    } catch (e) {
      setUpdateError(e.message || 'Update failed to start')
      setUpdateRunning(false)
    }
  }

  // v1.1.1.3 — tier code submission. POSTs the 4-digit code to
  // the server, which validates against the manifest's hashed
  // codes and sets the new tier. The server refuses downgrades
  // (you can't enter a lower-tier code from a higher tier) — the
  // user must hit "Reset to demo" first.
  const submitCode = async () => {
    const code = String(codeInput || '').trim()
    if (!/^\d{4}$/.test(code)) {
      setCodeError('Enter a 4-digit code')
      return
    }
    setCodeBusy(true)
    setCodeError(null)
    try {
      const r = await api.post('/update/tier/code', { code })
      // Refresh tier info, close the modal, clear the input.
      const fresh = await api.get('/update/tier')
      setTierInfo(fresh)
      setShowCodeModal(false)
      setCodeInput('')
      setCodeError(null)
    } catch (e) {
      setCodeError(e?.body?.error || e.message || 'Code rejected')
    } finally {
      setCodeBusy(false)
    }
  }

  const resetTier = async () => {
    if (!confirm('Reset to Stable? This drops any higher tier and switches the update channel back to Stable. Core features stay unlocked.')) return
    setChannelBusy(true)
    try {
      await api.post('/update/tier/reset')
      const fresh = await api.get('/update/tier')
      setTierInfo(fresh)
    } catch (e) {
      // Surface as updateError so the user sees something
      setUpdateError(e.message || 'Reset failed')
    } finally {
      setChannelBusy(false)
    }
  }

  const switchChannel = async (channel) => {
    if (!tierInfo || tierInfo.channel === channel) return
    setChannelBusy(true)
    try {
      await api.post('/update/channel', { channel })
      const fresh = await api.get('/update/tier')
      setTierInfo(fresh)
      // Trigger an immediate update check on the new channel so the
      // "available version" line refreshes.
      checkForUpdate().catch(() => {})
    } catch (e) {
      setUpdateError(e.message || 'Channel switch failed')
    } finally {
      setChannelBusy(false)
    }
  }

  if (!settings) return <div style={s.loadWrap}><div style={s.spinner} /></div>

  const pct = progress.total > 0 ? (progress.processed / progress.total) * 100 : 0
  const lpct = logoProgress.total > 0 ? (logoProgress.processed / logoProgress.total) * 100 : 0
  const mpct = matchProgress.total > 0 ? (matchProgress.processed / matchProgress.total) * 100 : 0

  // Section metadata. id matches what setSettingsSubSection holds.
  // title and icon used by both the index card and the sub-page header.
  // Order matches the visual order on the index list (#30.18):
  // Library → Volume Levelling → DSP → AutoEQ → Metadata Refresh →
  // Scrobbling → Backup → Software Update.
  const SECTIONS = [
    { id: 'library',    title: 'Library',          icon: <Folder size={14} style={{ marginRight: 8 }} /> },
    // v1.1.20.0 — Home Screen took the slot Tags used to hold. Tags is now a
    // side-menu entry; what remains here is what the Home screen may fetch.
    { id: 'home',       title: 'Home Screen',      icon: <Home size={14} style={{ marginRight: 8 }} /> },
    { id: 'audio',      title: 'Audio Devices',    icon: <Cable size={14} style={{ marginRight: 8 }} /> },
    { id: 'dsp',        title: 'DSP',              icon: <Sliders size={14} style={{ marginRight: 8 }} /> },
    { id: 'autoeq',     title: 'AutoEQ',           icon: <Headphones size={14} style={{ marginRight: 8 }} /> },
    { id: 'metadata',   title: 'Metadata',         icon: <User size={14} style={{ marginRight: 8 }} /> },
    { id: 'scrobbling', title: 'LastFM Scrobbler', icon: <Radio size={14} style={{ marginRight: 8 }} /> },
    { id: 'backup',     title: 'Backup',           icon: <Save size={14} style={{ marginRight: 8 }} /> },
    { id: 'update',     title: 'Update',           icon: <Download size={14} style={{ marginRight: 8 }} /> },
    // v1.1.3.5 — CPU Tweaks. Sits at the bottom because most users
    // never need it; auto-detection picks reasonable defaults. Only
    // surfaces here if the user actively wants to tune things.
    { id: 'cpu',        title: 'CPU Tweaks',       icon: <Cpu size={14} style={{ marginRight: 8 }} /> },
    // 'vl' (Volume Levelling) and 'api' sections retired in #v1.1.0.27.
    // VL settings moved to top of DSP; VL scanner moved to Metadata.
    // API screen had only MB contact (now at top of Metadata) and the
    // service health list (now at bottom of Metadata).
  ]
  const activeSection = SECTIONS.find(sec => sec.id === openSection)

  return (
    <div style={s.page}>
      {/* INDEX VIEW (#30.26). When no sub-section is open, render the
          MusicD brand header and a list of tappable section cards.
          As of #v1.1.0.13: the "MusicD" wordmark text was removed --
          the MD logo on its own is recognisable enough as a brand
          mark, and the wordmark crowded the header on small screens.
          The "Settings" heading shifts up slightly to centre vertically
          against the icon. */}
      {!openSection && (
        <>
          {/* v1.1.3.4: when restart is being confirmed, the prompt
              takes over the full row (the icon+title+button bar
              becomes too narrow on phones for the "Are you sure?"
              prompt to fit alongside it). When the restart is in
              flight, we keep the icon+title visible and swap the
              button for a spinner so the user can still see they're
              on the Settings screen. */}
          {restartFlow.phase === 'confirming' ? (
            <div style={s.brandHeader}>
              <RestartConfirmRow
                onYes={restartFlow.fire}
                onNo={restartFlow.cancel}
              />
            </div>
          ) : (
            <div style={s.brandHeader}>
              <h1 style={s.heading}>Settings</h1>
              <div style={s.brandSpacer} />
              {restartFlow.phase === 'restarting'
                ? <RestartBusy />
                : <RestartButton onConfirm={restartFlow.begin} />}
            </div>
          )}
          <div style={s.sectionList}>
            {SECTIONS.map(sec => (
              <SectionCard key={sec.id} id={sec.id} title={sec.title} icon={sec.icon} onOpen={setOpenSection} />
            ))}
          </div>
        </>
      )}

      {/* SUB-SECTION VIEW (#30.26). When a section is active, the
          SectionPage wraps its content with a header + back chevron.
          Each section's content lives in its own conditional block
          below; only the matching one renders. */}
      {openSection && activeSection && (
        <SectionPage
          title={activeSection.title}
          icon={activeSection.icon}
          onBack={() => setOpenSection(null)}>

          {/* Each section's content is a sibling conditional below.
              Only the one matching openSection renders. They were
              previously wrapped in <Section id=...> JSX; now the
              matching block fires directly. */}
      <Section id="library" title="Library" icon={<Folder size={14} style={{ marginRight: 8 }} />} openSection={openSection} setOpenSection={setOpenSection}>
        <LibraryScopeSection />
        {/* Rescan pill (#30.16). Lives at the bottom of the Library
            section so it's visible right alongside the scope picker
            that determines what gets scanned. */}
        <div style={s.actionRow}>
          <button style={s.actionBtn} onClick={handleRescan} disabled={scanning}>
            <RefreshCw size={11} style={scanning ? { animation: 'spin 1s linear infinite' } : {}} />
            {scanning ? ' Rescanning…' : ' Rescan library'}
          </button>
        </div>
      </Section>

      {/* v1.1.20.0 — Tags moved to the side menu (it is a way through the
          library, not an admin screen). Home Screen takes its place: what the
          Home screen is allowed to fetch and show. */}
      <Section id="home" title="Home Screen" icon={<Home size={14} style={{ marginRight: 8 }} />} openSection={openSection} setOpenSection={setOpenSection}>
        <HomeScreenSection />
      </Section>

      <Section id="audio" title="Audio Devices" icon={<Cable size={14} style={{ marginRight: 8 }} />} openSection={openSection} setOpenSection={setOpenSection}>
        <AudioSection />
      </Section>

      <Section id="dsp" title="DSP" icon={<Sliders size={14} style={{ marginRight: 8 }} />} openSection={openSection} setOpenSection={setOpenSection}>

        {/* Volume-levelling settings (#v1.1.0.27). Moved here from the
            standalone Volume Levelling section, which has been retired.
            The scanner that processes track tags lives on the Metadata
            screen now -- it's a library operation. The toggle, mode,
            and target LUFS are signal-processing concerns, so they
            sit at the top of DSP, above the per-renderer DSP tab. */}
        <div style={s.subSectionTitle}>Volume levelling</div>
        <Row label="Enable">
          <Toggle on={settings.vl_enabled} onChange={v => update('vl_enabled', v)} />
        </Row>
        <Row label="Gain mode">
          <div style={s.segControl}>
            {['track', 'album'].map(m => (
              <button
                key={m}
                style={{ ...s.segBtn, ...(settings.vl_mode === m ? s.segBtnActive : {}) }}
                onClick={() => update('vl_mode', m)}
              >
                {m === 'track' ? 'Track' : 'Album'}
              </button>
            ))}
          </div>
        </Row>
        <Row label="Target LUFS">
          <div style={s.targetRow}>
            <input type="range" min="-23" max="-14" step="1" value={settings.vl_target_lufs}
              onChange={e => update('vl_target_lufs', parseInt(e.target.value))}
              style={s.slider} />
            <span style={s.valLabel}>{settings.vl_target_lufs} LUFS</span>
          </div>
        </Row>
        <div style={s.helpRow}>
          <HelpTooltip>
          Album mode preserves relative track dynamics within an album; Track mode normalises each track independently. To populate the database with loudness values, run the scan in <strong>Settings → Metadata</strong>.
          </HelpTooltip>
        </div>
        <div style={{ ...s.divider, margin: '14px 0 10px' }} />

        <DspTab />
      </Section>

      <Section id="autoeq" title="AutoEQ" icon={<Headphones size={14} style={{ marginRight: 8 }} />} openSection={openSection} setOpenSection={setOpenSection}>
        <AutoEqTab />
      </Section>

      <Section id="metadata" title="Metadata" icon={<User size={14} style={{ marginRight: 8 }} />} openSection={openSection} setOpenSection={setOpenSection}>

        {/* Restructured in #30.24 into clear sub-sections.
            User workflow: run the matcher first (it's the prerequisite
            for bios), then enrich with cover art, logos, and bios as
            wanted. Each sub-section is self-contained: its inputs, its
            action, its status, its help text -- in that order.
            #v1.1.0.27: MusicBrainz contact moved here from API screen
            (it's the input the matcher needs); volume-levelling scanner
            moved in below the bios section; service health indicators
            moved in below the scanner. */}

        {/* ── 0. MusicBrainz contact ───────────────────────────────────
            Sits above album matching because it's the prerequisite --
            the matcher won't start without it. */}
        <div style={s.subSectionTitle}>MusicBrainz contact</div>
        <Row label="URL or email">
          <input type="text" placeholder="https://yourdomain.example or you@example.com"
            value={settings.mb_contact || ''}
            onChange={e => update('mb_contact', e.target.value)}
            style={s.textInput} />
        </Row>
        <div style={s.helpRow}>
          <HelpTooltip>
          MusicBrainz requires identifying contact info in API requests so they can reach you if your client misbehaves. Provide a URL or email address. Without it, the album matcher and bio fetcher won't run. See{' '}
          <a href="https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting" target="_blank" rel="noopener noreferrer" style={s.link}>their rate-limiting policy</a>.
          </HelpTooltip>
        </div>

        {/* ── Metadata Scanning scheduler (#v1.1.0.28) ───────────────
            Mode picker + scheduled-window pickers + live status panel.
            Off / Automatic / Scheduled. Calls /api/scheduler/* */}
        <div style={{ ...s.divider, margin: '14px 0 10px' }} />
        <MetadataSchedulerSection />

        {/* ── 1. Album matching ───────────────────────────────────────
            The foundation. Without MBIDs nothing else here works
            properly (cover art benefits from MBID; bios require it). */}
        <div style={{ ...s.divider, margin: '14px 0 10px' }} />
        <div style={s.subSectionTitle}>Album matching</div>
        <div style={s.helpRow}>
          <HelpTooltip>
          Match each album in your library against MusicBrainz to find a canonical record. This is the prerequisite for accurate bios and improved cover art. Albums that don't match cleanly get listed on the <strong>Unmatched</strong> page for manual review.
          </HelpTooltip>
        </div>

        {!settings.mb_contact?.trim() && (
          <div style={s.matchError}>
            MusicBrainz contact not set. Fill in the field above before starting the matcher.
          </div>
        )}

        <div style={s.progressBlock}>
          <div style={s.progressTop}>
            <span style={s.progressLabel}>
              {matchProgress.running
                ? `Matching… ${matchProgress.processed} / ${matchProgress.total}`
                : matchProgress.pendingCount > 0
                  ? `${matchProgress.pendingCount} pending`
                  : matchProgress.processed > 0
                    ? `${matchProgress.processed} processed`
                    : 'Idle'}
              {matchProgress.processed > 0 && (
                <span style={{ marginLeft: 8, color: 'var(--text-tertiary)' }}>
                  · matched {matchProgress.matched}
                  · uncertain {matchProgress.uncertain}
                  · unmatched {matchProgress.unmatched}
                  {matchProgress.errored > 0 ? ` · errored ${matchProgress.errored}` : ''}
                </span>
              )}
            </span>
            {!matchProgress.running ? (
              <div style={{ display: 'flex', gap: 6 }}>
                <button style={s.actionBtn} onClick={startMatch}
                        disabled={!settings.mb_contact?.trim()}
                        title={!settings.mb_contact?.trim() ? 'Set a contact above first' : 'Start matcher'}>
                  <Play size={11} /> Start matching
                </button>
                {/* v1.1.0.77 — "Reset all" removed. The button cleared
                    every album's match status, forcing thousands of
                    fresh MB queries — too easy to fire by accident.
                    Stale unmatched/uncertain/errored albums now get
                    re-queued automatically once a day (see
                    maybeReQueueStaleUnmatched in metadataScheduler).
                    For a deliberate manual rematch of a small subset
                    use the "Rematch unmatched" diagnostic below. */}
              </div>
            ) : (
              <button style={s.abortBtn} onClick={stopMatch}><Square size={10} /> Stop</button>
            )}
          </div>
          {matchProgress.running && (
            <div style={s.progressTrack}><div style={{ ...s.progressFill, width: `${mpct}%` }} /></div>
          )}
        </div>

        {matchError && (
          <div style={s.matchError}>{matchError}</div>
        )}
        {matchProgress.lastError && !matchError && (
          <div style={s.matchError}>Last error: {matchProgress.lastError}</div>
        )}

        <div style={s.helpRow}>
          <HelpTooltip>
          Throttled to 1 request per second per MusicBrainz's rules. A library of 5,000 albums takes about 90 minutes the first time. Existing tags aren't modified -- this only stores the matched MusicBrainz ID for later use.
          </HelpTooltip>
        </div>

        {/* v1.1.0.66 introduced the cleaner; v1.1.0.78 reworked the UX:
            the Re-queue action is now primary and always available
            when there are albums to rescan. The diagnostic preview
            (which was the v66 entry-point) is now an optional
            "Show details" disclosure beneath the action.
            Pre-v78 the Re-queue button was conditional on the
            cleaner identifying albums it would query differently —
            users with no cleaner-changeable albums saw no button
            at all and reported the feature as broken. */}
        <div style={{ ...s.divider, margin: '14px 0 10px' }} />
        <div style={s.subSectionTitle}>Rescan Unmatched</div>
        <div style={s.helpRow}>
          <HelpTooltip>
            Re-queues every album that's currently unmatched, uncertain, or that errored during the last matcher run. After re-queue, hit <strong>Start matching</strong> at the top of this section to begin reprocessing. MusicBrainz adds new releases continually and transient errors during the original sweep can leave albums permanently flagged — re-queueing periodically recovers them. Albums you've manually confirmed or rejected, and those matched directly via embedded MBID tags, are always preserved.
          </HelpTooltip>
        </div>

        {/* Single status line — what the user sees at a glance.
            Three states:
            - Loading (no diagnostic yet) → "Checking…"
            - All matched (totalUnmatched === 0) → quiet "All clear"
            - Has work → count + per-status breakdown */}
        <div style={s.rescanStatus}>
          {!diagnostic && (
            <span style={{ color: 'var(--jp-text-3)' }}>Checking…</span>
          )}
          {diagnostic && diagnostic.totalUnmatched === 0 && (
            <span style={{ color: 'var(--jp-text-2)' }}>
              All albums matched. Nothing to rescan.
            </span>
          )}
          {diagnostic && diagnostic.totalUnmatched > 0 && (
            <>
              <strong style={{ color: 'var(--jp-text)' }}>
                {diagnostic.totalUnmatched}
              </strong>
              {' albums need rescanning'}
              {diagnostic.byStatus && (
                <span style={{ color: 'var(--jp-text-3)', marginLeft: 6 }}>
                  · {diagnostic.byStatus.unmatched} unmatched
                  {diagnostic.byStatus.uncertain > 0 && ` · ${diagnostic.byStatus.uncertain} uncertain`}
                  {diagnostic.byStatus.error > 0 && ` · ${diagnostic.byStatus.error} error`}
                </span>
              )}
            </>
          )}
        </div>

        <div style={s.actionRowEnd}>
          <button
            style={s.actionBtn}
            onClick={runRematch}
            disabled={
              !diagnostic ||
              diagnostic.totalUnmatched === 0 ||
              rematchBusy ||
              matchProgress.running
            }
            title={
              matchProgress.running
                ? 'Stop the running matcher first'
                : (diagnostic?.totalUnmatched === 0
                    ? 'Nothing to rescan'
                    : 'Re-queue all unmatched / uncertain / errored albums')
            }
          >
            {rematchBusy
              ? 'Queuing…'
              : (diagnostic && diagnostic.totalUnmatched > 0
                  ? `Rescan ${diagnostic.totalUnmatched} albums`
                  : 'Rescan unmatched')}
          </button>
        </div>

        {rematchResult && (
          <div style={{
            marginTop: 8, padding: '8px 12px',
            background: 'rgba(91,127,255,0.08)',
            border: '1px solid rgba(91,127,255,0.24)',
            borderRadius: 6,
            fontSize: 12, color: 'var(--jp-text)',
          }}>
            Queued {rematchResult.queuedCount} albums. Hit “Start matching” above to begin reprocessing.
          </div>
        )}

        {/* Optional diagnostic detail — what the cleaner would do
            differently this time, and which albums are likely to
            need manual attention. Hidden by default; revealed via
            <details> so it doesn't clutter the section. */}
        {diagnostic && diagnostic.totalUnmatched > 0 && (
          <details style={{ marginTop: 10 }}>
            <summary style={{ cursor: 'pointer', color: 'var(--jp-text-3)', fontSize: 11 }}>
              Show what the rescan would change
            </summary>
            <div style={{
              marginTop: 8, padding: '10px 12px',
              background: 'var(--jp-bg-elevated)',
              border: '1px solid var(--jp-border)',
              borderRadius: 6,
              fontSize: 12, color: 'var(--jp-text-2)',
              lineHeight: 1.5,
            }}>
              <div>
                <strong style={{ color: 'var(--jp-text)' }}>{diagnostic.wouldChangeQuery}</strong> would be queried with a cleaner string this time (titles like "(Deluxe Edition)" stripped before searching).
                {diagnostic.wouldNotChange > 0 && <> {diagnostic.wouldNotChange} would query the same string as before — likely genuine misses (try the manual matcher or fingerprint).</>}
                {diagnostic.missingTitleOrArtist > 0 && <> {diagnostic.missingTitleOrArtist} have no title or artist (can't be matched until tagged).</>}
              </div>
              {diagnostic.samples?.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <div style={{ fontSize: 11, color: 'var(--jp-text-3)', marginBottom: 4 }}>
                    Examples of cleaner changes ({diagnostic.samples.length}):
                  </div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                    {diagnostic.samples.map(sm => (
                      <div key={sm.id} style={{ padding: '4px 0', borderTop: '1px solid var(--jp-border)' }}>
                        <div style={{ color: 'var(--jp-text-3)' }}>was: {sm.album_artist} — {sm.title}</div>
                        <div>now: {sm.cleanedArtist} — {sm.cleanedTitle}</div>
                        {(sm.titleStripped.length > 0 || sm.artistStripped.length > 0) && (
                          <div style={{ color: 'var(--jp-text-3)', fontSize: 10 }}>
                            stripped: {[...sm.titleStripped, ...sm.artistStripped].join(' · ')}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </details>
        )}

        {/* ── 2. Cover art ─────────────────────────────────────────── */}
        <div style={{ ...s.divider, margin: '14px 0 10px' }} />
        <div style={s.subSectionTitle}>Cover art</div>
        <div style={s.helpRow}>
          <HelpTooltip>
          For albums missing artwork, fetch covers from MusicBrainz Cover Art Archive. Best results once albums have been matched.
          </HelpTooltip>
        </div>
        <div style={s.actionRowEnd}>
          <button style={s.actionBtn} onClick={handleArtworkRefresh} disabled={fetchingArt}>
            <ImageIcon size={11} style={fetchingArt ? { animation: 'pulse 1.5s ease-in-out infinite' } : {}} />
            {fetchingArt ? ' Searching artwork…' : ' Refresh missing artwork'}
          </button>
        </div>
        {artMessage && (
          <div style={s.artMessage}>{artMessage}</div>
        )}

        {/* ── 3. Artist logos ──────────────────────────────────────── */}
        <div style={{ ...s.divider, margin: '14px 0 10px' }} />
        <div style={s.subSectionTitle}>Artist logos</div>
        <div style={s.helpRow}>
          <HelpTooltip>
          Tries fanart.tv (best for rock/metal), then TheAudioDB, then a typographic fallback if neither has a logo. API keys for fanart.tv and TheAudioDB are built in — no setup required.
          </HelpTooltip>
        </div>

        <div style={s.progressBlock}>
          <div style={s.progressTop}>
            <span style={s.progressLabel}>
              {logoProgress.running
                ? `Fetching artist logos… ${logoProgress.processed} / ${logoProgress.total}`
                : `${logoProgress.processed} / ${logoProgress.total} artist logos processed`}
              {logoProgress.processed > 0 && (
                <span style={{ marginLeft: 8, color: 'var(--text-tertiary)' }}>
                  · fanart {logoProgress.sources?.fanart || 0}
                  · audiodb {logoProgress.sources?.audiodb || 0}
                  · typographic {logoProgress.sources?.typographic || 0}
                </span>
              )}
            </span>
            {!logoProgress.running ? (
              <div style={{ display: 'flex', gap: 6 }}>
                <button style={s.actionBtn} onClick={() => startLogos(false)}>
                  <Play size={11} /> Fetch missing logos
                </button>
                {/* v1.1.0.77 — "Refetch all" removed. Same reasoning
                    as the Album Matching "Reset all" — too easy to
                    fire accidentally; would re-fetch every artist
                    image and burn the fanart.tv quota. The "missing"
                    button picks up artists that didn't get one in a
                    previous pass, which is the only legitimate
                    reason to run this again. */}
              </div>
            ) : (
              <button style={s.abortBtn} onClick={abortLogos}><Square size={10} /> Stop</button>
            )}
          </div>
          {logoProgress.running && (
            <div style={s.progressTrack}><div style={{ ...s.progressFill, width: `${lpct}%` }} /></div>
          )}
        </div>

        {/* ── 4. Album & artist bios ───────────────────────────────── */}
        <div style={{ ...s.divider, margin: '14px 0 10px' }} />
        <div style={s.subSectionTitle}>Album & artist bios</div>
        <div style={s.helpRow}>
          <HelpTooltip>
          Bios load lazily on demand when you tap the <strong>About</strong> button on an album or artist. Sources are tried in order: Wikipedia (via the MBID), then Last.fm, then TheAudioDB, then MusicBrainz annotations. Albums must be matched first; without an MBID we can't reliably look up bios.
          </HelpTooltip>
        </div>

        {/* ── 5. Volume-levelling scanner ───────────────────────────────
            Moved here from the Volume Levelling section (#v1.1.0.27).
            The settings (Enable / Mode / Target LUFS) live at the top
            of DSP; the scanner is a metadata-class operation (read
            existing tags into the DB) and groups naturally with the
            other library scans on this screen. */}
        <div style={{ ...s.divider, margin: '14px 0 10px' }} />
        <div style={s.subSectionTitle}>Volume-levelling scan</div>
        <div style={s.helpRow}>
          <HelpTooltip>
          Reads ReplayGain / R128 tags written by r128gain into musicd's database. Run r128gain on your library files first, then scan here. The toggle and target LUFS controls live in <strong>Settings → DSP</strong>.
          </HelpTooltip>
        </div>
        <div style={s.progressBlock}>
          <div style={s.progressTop}>
            <span style={s.progressLabel}>
              {progress.running
                ? `Scanning… ${progress.processed} / ${progress.total}${progress.skipped > 0 ? ` (${progress.skipped} skipped)` : ''}`
                : `${progress.processed} of ${progress.total} tracks scanned`}
            </span>
            {!progress.running ? (
              <div style={{ display: 'flex', gap: 6 }}>
                {/* v1.1.0.77 — button changes by state.
                    - Library has unscanned tracks → "Scan N tracks"
                    - Library is fully scanned       → disabled
                                                       "All tracks scanned"
                    - Pre-scan / no library          → fall back to a
                                                       generic "Scan tracks"
                    The single button replaces v76's "Scan missing" +
                    "Rescan all" pair. The Rescan-all destructive
                    variant is gone (see changelog). */}
                {progress.missingCount > 0 ? (
                  <button style={s.actionBtn} onClick={() => startAnalysis(false)}>
                    <Play size={11} /> Scan {progress.missingCount} tracks
                  </button>
                ) : progress.processed > 0 ? (
                  <button style={{ ...s.actionBtn, ...s.actionBtnDisabled }} disabled>
                    All tracks scanned
                  </button>
                ) : (
                  <button style={s.actionBtn} onClick={() => startAnalysis(false)}>
                    <Play size={11} /> Scan tracks
                  </button>
                )}
              </div>
            ) : (
              <button style={s.abortBtn} onClick={abortAnalysis}><Square size={10} /> Stop</button>
            )}
          </div>
          {progress.running && (
            <div style={s.progressTrack}><div style={{ ...s.progressFill, width: `${pct}%` }} /></div>
          )}
        </div>

        {/* ── 6. Built-in services health ───────────────────────────────
            Moved here from the API section (#v1.1.0.27). The API
            section had nothing else in it (other than MB contact, now
            at the top of this screen) so this lives at the bottom of
            Metadata where it's grouped with the services it monitors. */}
        <div style={{ ...s.divider, margin: '14px 0 10px' }} />
        <div style={s.subSectionTitle}>Built-in services</div>
        <div style={s.helpRow}>
          <HelpTooltip>
          Last.fm, fanart.tv, TheAudioDB and AcoustID are built in — no key configuration required. Status indicators show whether each service has been responding to recent requests. A red light means the most recent call failed.
          </HelpTooltip>
        </div>
        <div style={s.healthList}>
          {SERVICE_DEFS.map(svc => (
            <ServiceHealthRow
              key={svc.id}
              def={svc}
              info={serviceHealth ? serviceHealth[svc.id] : null}
            />
          ))}
        </div>
      </Section>

      {/* Scrobbling section (#30.25). Sits between Metadata Refresh
          and Backup because it's another external-service integration.
          The Last.fm API key/secret needed for this also live in the
          Metadata Refresh section -- they're shared with the bio
          fetcher. The cross-section dependency is documented in both
          places so users aren't confused. */}
      <Section id="scrobbling" title="LastFM Scrobbler" icon={<Radio size={14} style={{ marginRight: 8 }} />} openSection={openSection} setOpenSection={setOpenSection}>

        <div style={s.helpRow}>
          <HelpTooltip>
          Scrobbling sends each track you play to Last.fm so they appear in your listening history. A track scrobbles once it's been played for at least 50% of its length or 4 minutes (whichever is sooner). Tracks under 30 seconds are skipped per Last.fm's rules.
          </HelpTooltip>
        </div>

        {!scrobbleStatus.connected && (
          <>
            <div style={s.helpRow}>
              <HelpTooltip>
              <strong>Don't have a Last.fm account?</strong> Sign up free at{' '}
              <a href="https://www.last.fm/join" target="_blank" rel="noopener noreferrer" style={s.link}>last.fm/join</a>. Then enter your username and password below.
              </HelpTooltip>
            </div>

            <Row label="Last.fm username">
              <input type="text" placeholder="username"
                value={scrobbleUsername}
                onChange={e => setScrobbleUsername(e.target.value)}
                autoComplete="username"
                style={s.textInput}
                disabled={scrobbleBusy} />
            </Row>
            <Row label="Last.fm password">
              <input type="password" placeholder="••••••••"
                value={scrobblePassword}
                onChange={e => setScrobblePassword(e.target.value)}
                autoComplete="current-password"
                style={s.textInput}
                disabled={scrobbleBusy} />
            </Row>

            <div style={s.actionRow}>
              <button
                style={s.actionBtn}
                onClick={scrobbleLogin}
                disabled={scrobbleBusy}>
                {scrobbleBusy ? 'Connecting…' : 'Connect to Last.fm'}
              </button>
            </div>

            {scrobbleError && (
              <div style={s.matchError}>{scrobbleError}</div>
            )}

            <div style={s.helpRow}>
              <HelpTooltip>
              Your password is sent once over HTTPS to Last.fm, exchanged for a session key, and then forgotten. musicd never stores it. The session key can be revoked any time from{' '}
              <a href="https://www.last.fm/settings/applications" target="_blank" rel="noopener noreferrer" style={s.link}>your Last.fm applications page</a>.
              </HelpTooltip>
            </div>
            <div style={s.helpRow}>
              <HelpTooltip>
              Honest caveat: Last.fm's username/password auth method is being deprecated in favour of a browser-based login flow. It still works today but may be removed in the future.
              </HelpTooltip>
            </div>
          </>
        )}

        {scrobbleStatus.connected && (
          <>
            <Row label="Connected as">
              <div style={s.connectedBadge}>
                <Radio size={11} style={{ color: 'var(--green)' }} />
                <strong>{scrobbleStatus.username}</strong>
              </div>
            </Row>

            {scrobbleStatus.queueDepth > 0 && (
              <div style={s.progressBlock}>
                <div style={s.progressTop}>
                  <span style={s.progressLabel}>
                    {scrobbleStatus.queueDepth} scrobble{scrobbleStatus.queueDepth === 1 ? '' : 's'} queued (retrying)
                  </span>
                  <button style={s.actionBtnGhost} onClick={scrobbleFlush}>
                    Retry now
                  </button>
                </div>
              </div>
            )}

            {scrobbleStatus.lastError && (
              <div style={s.matchError}>Last error: {scrobbleStatus.lastError}</div>
            )}
            {scrobbleError && (
              <div style={s.matchError}>{scrobbleError}</div>
            )}

            <div style={s.actionRow}>
              <button style={s.actionBtnGhost} onClick={scrobbleLogout}>
                <LogOut size={11} /> Disconnect
              </button>
            </div>

            <div style={s.helpRow}>
              <HelpTooltip>
              Tracks are scrobbled in the background as you play them. Your{' '}
              <a href={`https://www.last.fm/user/${encodeURIComponent(scrobbleStatus.username)}`}
                 target="_blank" rel="noopener noreferrer" style={s.link}>
                Last.fm profile
              </a>{' '}
              shows the live history.
              </HelpTooltip>
            </div>
          </>
        )}
      </Section>

      <Section id="backup" title="Backup" icon={<Save size={14} style={{ marginRight: 8 }} />} openSection={openSection} setOpenSection={setOpenSection}>
        <BackupSection />
      </Section>

      <Section id="update" title="Update" icon={<Download size={14} style={{ marginRight: 8 }} />} openSection={openSection} setOpenSection={setOpenSection}>

        <div style={s.row}>
          <div style={s.rowLabel}>Current version</div>
          <div style={s.rowControl}>
            <span style={s.versionTag}>v{updateInfo.currentVersion || '—'}</span>
          </div>
        </div>

        {/* v1.1.1.3 — Tier and channel panel.
            Shows the user's current tier (Demo / Stable / Early
            Access / Beta / Internal) and the selected update
            channel within that tier. Demo users see a banner
            explaining the demo limits and an Enter code button.
            Higher tiers see a channel picker. */}
        {tierInfo && (
          <div style={tierStyles.panel}>
            <div style={tierStyles.tierRow}>
              <span style={tierStyles.tierLabelSmall}>Tier</span>
              <span style={tierStyles.tierBadge(tierInfo.tier)}>{tierInfo.tierLabel}</span>
              {tierInfo.tier !== 'demo' && tierInfo.tier !== 'stable' && (
                <button
                  style={tierStyles.resetBtn}
                  onClick={resetTier}
                  disabled={channelBusy}
                  title="Drop back to the Stable tier"
                >Reset to Stable</button>
              )}
            </div>

            {tierInfo.tier === 'demo' && (
              <div style={tierStyles.demoBanner}>
                <div style={tierStyles.demoBannerTitle}>You're using MusicD in demo mode</div>
                <div style={tierStyles.demoBannerBody}>
                  Browse and play up to {tierInfo.featureFlags?.library_size_limit || 50} albums.
                  Settings, DSP, backup, scrobbling, and multi-zone playback are locked.
                  Enter your access code to unlock the full version.
                </div>
                <button
                  style={tierStyles.enterCodeBtn}
                  onClick={() => { setShowCodeModal(true); setCodeInput(''); setCodeError(null) }}
                >Enter access code</button>
              </div>
            )}

            {tierInfo.tier !== 'demo' && tierInfo.channels.length > 1 && (
              <div style={tierStyles.channelPicker}>
                <div style={tierStyles.channelPickerLabel}>Update channel</div>
                {tierInfo.channels.map(ch => {
                  const isCurrent = ch.name === tierInfo.channel
                  return (
                    <button
                      key={ch.name}
                      style={isCurrent ? tierStyles.channelRowActive : tierStyles.channelRow}
                      onClick={() => !channelBusy && switchChannel(ch.name)}
                      disabled={channelBusy || isCurrent}
                    >
                      <div style={tierStyles.channelRowLeft}>
                        <span style={tierStyles.channelRadio}>{isCurrent ? '●' : '○'}</span>
                        <span style={tierStyles.channelLabel}>{ch.label}</span>
                        {ch.stability && (
                          <span style={tierStyles.stabilityBadge(ch.stability)}>{ch.stability}</span>
                        )}
                      </div>
                      <div style={tierStyles.channelRowRight}>
                        {ch.version && <span style={tierStyles.channelVersion}>v{ch.version}</span>}
                      </div>
                      {ch.description && (
                        <div style={tierStyles.channelDescription}>{ch.description}</div>
                      )}
                    </button>
                  )
                })}
              </div>
            )}

            {tierInfo.tier !== 'demo' && tierInfo.channels.length === 1 && (
              <div style={tierStyles.singleChannelNote}>
                Channel: {tierInfo.channels[0].label} (only channel available on this tier)
              </div>
            )}

            {/* v1.1.3.8 — Stable is the baseline, so the demo block
                above never renders and took the only "Enter access
                code" button with it. This keeps the higher codes
                reachable. Hidden on alpha: nothing left to unlock. */}
            {tierInfo.tier !== 'demo' && tierInfo.tier !== 'alpha' && (
              <div style={tierStyles.upgradeRow}>
                <span style={tierStyles.upgradeText}>
                  Have an Early Access, Beta or Developer code?
                </span>
                <button
                  style={tierStyles.upgradeBtn}
                  onClick={() => { setShowCodeModal(true); setCodeInput(''); setCodeError(null) }}
                >Enter access code</button>
              </div>
            )}
          </div>
        )}

        <div style={s.updateBlock}>
          {updateInfo.availableVersion ? (
            <button
              style={updateRunning ? s.updateBtnDisabled : s.updateBtnAvailable}
              onClick={startUpdate}
              disabled={updateRunning}
            >
              <Download size={14} />
              {updateRunning
                ? 'Updating… server will restart'
                : `Update available — install v${updateInfo.availableVersion}`}
            </button>
          ) : (
            <button style={s.updateBtnIdle} onClick={checkForUpdate} disabled={updateChecking}>
              <RefreshCw size={13} style={updateChecking ? { animation: 'spin 1s linear infinite' } : {}} />
              {updateChecking ? 'Checking…' : 'Manual update check'}
            </button>
          )}
        </div>

        {updateError && (
          <div style={s.errorMsg}>⚠ {updateError}</div>
        )}

        {/* v1.1.0.74 — "What's new" is now a single tappable line
            that opens a full-screen reader. v25–v73 rendered the
            full release-notes markdown inline, which dominated the
            Update screen. The collapsed treatment lets users see
            the rest of the screen (Force re-check, Troubleshoot,
            etc.) without scrolling past the changelog. */}
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
          <ReleaseNotesPanel currentVersion={updateInfo.currentVersion} />
        </div>

        {/* Last-check status (#v1.1.0.25). Surfaced inline rather than
            attached to the URL input which is now baked-in. */}
        {remoteStatus?.lastCheck && (
          <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-tertiary)' }}>
            Last update check: {relTimeShort(remoteStatus.lastCheck)}
            {remoteStatus.lastResult?.error && (
              <span style={{ color: '#ff8888', marginLeft: 6 }}>
                — {remoteStatus.lastResult.error}
              </span>
            )}
          </div>
        )}

        {/* Changelog link (#v1.1.0.25). Opens the in-app changelog
            viewer with full version history. */}
        <div style={{ marginTop: 14 }}>
          <button onClick={() => setShowChangelog(true)} style={s.changelogLink}>
            Click here for MusicD Changelog
          </button>
        </div>

        {updateLog && updateLog.trim() && (
          <div style={{ marginTop: 14 }}>
            <button onClick={() => setShowLog(v => !v)} style={s.logToggle}>
              {showLog ? 'Hide' : 'Show'} last update log
            </button>
            {showLog && (
              <pre style={s.logBox}>{updateLog}</pre>
            )}
          </div>
        )}

        {/* v1.1.15.0 — "Clear stuck update files" removed.
            It existed for one failure: a stale tar in the local watch dir
            pinning findAvailableUpdate() on an old version. That was fixed
            twice over in the meantime and neither fix left it anything to do.
            v1.1.0.73 changed the rule to "highest version wins regardless of
            source", so a stale LOWER version can no longer pin anything; and
            v1.1.2.8 made the update check itself call
            clearPendingTars({ staleOnly: true }), so those files are now swept
            automatically on every check.

            What remained was a button whose only behaviour the automatic sweep
            does not already have is deleting tars at or NEWER than the running
            version — i.e. throwing away a download the user deliberately
            started. That is a footgun, not a recovery tool.

            Force re-check stays, and moves out of "Troubleshoot" because it is
            not troubleshooting: the manifest is polled on a schedule, and this
            is how you pick up a release the moment it is published rather than
            waiting for the next poll. */}
        <div style={{ marginTop: 14 }}>
          <div style={s.actionRow}>
            <button style={s.actionBtn} onClick={checkForUpdate} disabled={updateChecking}>
              <RefreshCw size={11} style={updateChecking ? { animation: 'spin 1s linear infinite' } : {}} />
              {updateChecking ? ' Checking…' : ' Check now'}
            </button>
          </div>
        </div>

        <div style={s.helpRow}>
          <HelpTooltip>
          Auto-update polls the release manifest once a day. New tars are downloaded on demand. On build failure, the previous version is restored automatically.
          </HelpTooltip>
        </div>

        {/* v1.1.0.60 — Report a bug. Opens an inline form. The server
            captures the description plus version, active renderer,
            current track, last update log, and a tail of the systemd
            journal, and writes them to <data>/bug-reports/. The user
            can then download that JSON and email it. SMTP/end-to-end
            send isn't wired yet. */}
        <BugReportPanel currentVersion={updateInfo.currentVersion} />
      </Section>

      <Section id="cpu" title="CPU Tweaks" icon={<Cpu size={14} style={{ marginRight: 8 }} />} openSection={openSection} setOpenSection={setOpenSection}>
        <CpuTweaksSection />
      </Section>

      {/* API section retired in #v1.1.0.27. Its only fields were:
            - MusicBrainz contact (now at top of Metadata)
            - Built-in services health (now at bottom of Metadata)
          Keys for Last.fm, fanart, audiodb, AcoustID were already
          baked in (#v1.1.0.23) so the section had been steadily
          shrinking. Removing the section card from SECTIONS too. */}
        </SectionPage>
      )}

      {/* Changelog modal (#v1.1.0.25). Rendered at the root so it
          overlays everything else when open. */}
      {showChangelog && (
        <ChangelogModal onClose={() => setShowChangelog(false)} />
      )}

      {/* v1.1.1.3 — Access code entry modal. Demo users tap
          "Enter access code" in the tier panel and this opens.
          Submitting the code sends it to /api/update/tier/code
          which validates against the manifest's hashed values
          and upgrades the tier on match. */}
      {showCodeModal && (
        <div style={tierStyles.modalBackdrop} onClick={() => !codeBusy && setShowCodeModal(false)}>
          <div style={tierStyles.modalPanel} onClick={e => e.stopPropagation()}>
            <div style={tierStyles.modalTitle}>Enter access code</div>
            <div style={tierStyles.modalBody}>
              4-digit code from your tester invitation or licence.
            </div>
            <input
              style={tierStyles.codeInput}
              type="tel"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={4}
              value={codeInput}
              onChange={e => {
                setCodeInput(e.target.value.replace(/\D/g, '').slice(0, 4))
                setCodeError(null)
              }}
              onKeyDown={e => { if (e.key === 'Enter' && codeInput.length === 4) submitCode() }}
              placeholder="0000"
              autoFocus
              disabled={codeBusy}
            />
            {codeError && <div style={tierStyles.codeError}>{codeError}</div>}
            <div style={tierStyles.modalActions}>
              <button
                style={tierStyles.modalCancel}
                onClick={() => setShowCodeModal(false)}
                disabled={codeBusy}
              >Cancel</button>
              <button
                style={codeInput.length === 4 ? tierStyles.modalSubmit : tierStyles.modalSubmitDisabled}
                onClick={submitCode}
                disabled={codeBusy || codeInput.length !== 4}
              >{codeBusy ? 'Checking…' : 'Submit'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// Compact relative-time formatter for the last-check timestamp.
// Same vocabulary as the recent-activity tiles, but more compact —
// "2m ago", "5h ago", "yesterday", "3d ago".
function relTimeShort(unix) {
  if (!unix) return ''
  const now = Math.floor(Date.now() / 1000)
  const delta = Math.max(0, now - unix)
  if (delta < 60) return 'just now'
  const m = Math.floor(delta / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(delta / 3600)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(delta / 86400)
  if (d === 1) return 'yesterday'
  return `${d}d ago`
}

function Row({ label, children }) {
  return (
    <div style={s.row}>
      <div style={s.rowLabel}>{label}</div>
      <div style={s.rowControl}>{children}</div>
    </div>
  )
}

function Toggle({ on, onChange }) {
  return (
    <button onClick={() => onChange(!on)} style={{ ...s.toggle, ...(on ? s.toggleOn : {}) }}>
      <span style={{ ...s.toggleKnob, ...(on ? s.toggleKnobOn : {}) }} />
    </button>
  )
}

// Metadata scanning scheduler section (#v1.1.0.28).
// =================================================
// Lives at the top of the Metadata screen. Three modes (Off /
// Automatic / Scheduled), with a scheduled-window time picker that
// only appears in Scheduled mode. Polls /api/scheduler/status every
// 5s while the section is mounted so the user sees live progress.
//
// All five jobs share this UI -- there's no per-job toggle. The user
// either enables the scheduler or doesn't. Per-job manual entry
// points still live in their own subsections below.
function MetadataSchedulerSection() {
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(true)
  const [savingMode, setSavingMode] = useState(false)
  const [windowDraft, setWindowDraft] = useState({ start: '01:00', end: '06:00' })
  const [windowSaving, setWindowSaving] = useState(false)
  const [windowError, setWindowError] = useState(null)
  const [windowSaved, setWindowSaved] = useState(false)

  // Poll /status every 5s. Faster while a job is running so the
  // progress field updates closer to real-time, but 5s is fine even
  // at idle and keeps server load minimal.
  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      try {
        const r = await api.get('/scheduler/status')
        if (!cancelled) {
          setStatus(r)
          // Initialise window draft on first load only -- don't
          // clobber the user's typing.
          setWindowDraft(prev =>
            prev.start === '01:00' && prev.end === '06:00' && r?.window
              ? { start: r.window.start, end: r.window.end }
              : prev
          )
        }
      } catch (e) {
        // Quiet fail -- the section just shows "loading" if /status is unavailable
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    poll()
    const interval = setInterval(poll, 5000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [])

  const setMode = async (mode) => {
    if (savingMode) return
    setSavingMode(true)
    try {
      const r = await api.patch('/scheduler/mode', { mode })
      if (r.status) setStatus(r.status)
    } catch (e) {
      alert('Failed to change mode: ' + (e.message || 'unknown'))
    } finally {
      setSavingMode(false)
    }
  }

  const saveWindow = async () => {
    setWindowSaving(true)
    setWindowError(null)
    try {
      const r = await api.patch('/scheduler/window', windowDraft)
      if (r.status) setStatus(r.status)
      setWindowSaved(true)
      setTimeout(() => setWindowSaved(false), 2000)
    } catch (e) {
      const msg = e.message || 'Save failed'
      setWindowError(msg)
    } finally {
      setWindowSaving(false)
    }
  }

  const runNow = async () => {
    try {
      await api.post('/scheduler/run-now', {})
      const r = await api.get('/scheduler/status')
      setStatus(r)
    } catch (e) {
      alert('Run-now failed: ' + (e.message || 'unknown'))
    }
  }

  const stopNow = async () => {
    try { await api.post('/scheduler/stop', {}) } catch {}
  }

  const mode = status?.mode || 'off'
  const isRunning = status?.runningCycle
  const counts = status?.pending || {}
  const totalPending = status?.totalPending || 0

  return (
    <div>
      <div style={s.subSectionTitle}>Metadata scanning</div>
      <div style={s.helpRow}>
        <HelpTooltip>
        Off by default. When enabled, the scheduler walks the priority list (MusicBrainz match → cover art → volume levelling → artist logos → bios), running each job until its queue is empty or 1 hour has passed, whichever comes first. Once a full cycle completes, the scheduler sleeps until new music is added.
        </HelpTooltip>
      </div>

      <div style={s.modePillRow}>
        {[
          { id: 'off',       label: 'Off' },
          { id: 'automatic', label: 'Automatic' },
          { id: 'scheduled', label: 'Scheduled' },
        ].map(m => (
          <button
            key={m.id}
            disabled={savingMode}
            onClick={() => setMode(m.id)}
            style={{
              ...s.modePill,
              ...(mode === m.id ? s.modePillActive : {}),
              ...(savingMode ? { opacity: 0.6 } : {}),
            }}
            aria-pressed={mode === m.id}
          >
            {m.label}
          </button>
        ))}
      </div>

      {mode === 'automatic' && (
        <div style={s.helpRow}>
          <HelpTooltip>
          Automatic mode: each job runs for up to 1 hour, with a 5-minute cooldown between jobs. After one full cycle, the scheduler stops. New albums detected by the file watcher trigger a fresh cycle on just those new items.
          </HelpTooltip>
        </div>
      )}
      {mode === 'scheduled' && (
        <div style={s.helpRow}>
          <HelpTooltip>
          Scheduled mode: jobs only run inside the time window below. No cooldown between jobs. If the window closes mid-job, the job pauses cleanly and resumes the next night. Window must be at least {status?.window?.minHours || 5} hours long.
          </HelpTooltip>
        </div>
      )}

      {mode === 'scheduled' && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>From</span>
              <input
                type="time"
                value={windowDraft.start}
                onChange={e => { setWindowDraft(d => ({ ...d, start: e.target.value })); setWindowSaved(false); setWindowError(null) }}
                style={s.timeInput}
              />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>to</span>
              <input
                type="time"
                value={windowDraft.end}
                onChange={e => { setWindowDraft(d => ({ ...d, end: e.target.value })); setWindowSaved(false); setWindowError(null) }}
                style={s.timeInput}
              />
            </label>
            <button onClick={saveWindow} disabled={windowSaving} style={s.actionBtn}>
              {windowSaving ? 'Saving…' : windowSaved ? 'Saved ✓' : 'Save window'}
            </button>
          </div>
          {windowError && <div style={s.matchError}>{windowError}</div>}
          <div style={{ ...s.help, marginTop: 6, fontSize: 11 }}>
            Times are in the container's local timezone. Set <code>TZ</code> env variable on the container if you want them in your local time (default is UTC).
          </div>
        </div>
      )}

      <div style={{ ...s.releaseNotesBox, marginTop: 14 }}>
        {loading && <div style={s.releaseNotesEmpty}>Loading status…</div>}
        {!loading && status && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
                  {schedulerStatusLabel(status)}
                </div>
                {/* v1.1.0.78 — suppress status.message when it
                    duplicates the status label. The server emits
                    "Paused — playback active" for the paused-playback
                    state, but schedulerStatusLabel already returns
                    "Paused: music is playing" for that state, so
                    rendering both produces two near-identical lines. */}
                {status.message && status.status !== 'paused-playback' && (
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>
                    {status.message}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                {!isRunning && totalPending > 0 && mode !== 'off' && (
                  <button onClick={runNow} style={s.actionBtnGhost}>Run cycle now</button>
                )}
                {isRunning && (
                  <button onClick={stopNow} style={s.abortBtn}>Stop</button>
                )}
              </div>
            </div>

            <div style={s.pendingGrid}>
              <PendingCell label="Match"   count={counts.match || 0} active={status.currentJob === 'match'} />
              <PendingCell label="Art"     count={counts.art   || 0} active={status.currentJob === 'art'} />
              <PendingCell label="Volume"  count={counts.vl    || 0} active={status.currentJob === 'vl'} />
              <PendingCell label="Logos"   count={counts.logos || 0} active={status.currentJob === 'logos'} />
              <PendingCell label="Bios"    count={counts.bios  || 0} active={status.currentJob === 'bios'} />
            </div>

            {status.thermalC != null && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10, paddingTop: 8, borderTop: '1px dashed var(--border)' }}>
                <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>CPU temperature</span>
                <span
                  style={{
                    fontSize: 12, fontWeight: 600,
                    color: status.thermalC >= status.thermalCeilingC ? '#ff8888'
                         : status.thermalC >= status.thermalCeilingC - 5 ? '#ffaa55'
                         : 'var(--text-secondary)',
                  }}
                  title={status.thermalSource ? `Sensor: ${status.thermalSource}` : undefined}
                >
                  {status.thermalC.toFixed(1)}°C
                  <span style={{ fontWeight: 400, color: 'var(--text-tertiary)', marginLeft: 6 }}>
                    (ceiling {status.thermalCeilingC}°C)
                  </span>
                </span>
              </div>
            )}

            {/* v1.1.0.77 — auto-retry visibility. Tells the user the
                scheduler is silently re-queuing previously-failed
                matches once a day. The block renders only when the
                scheduler has actually run a re-queue at least once
                (lastUnmatchedRequeueAt is null until then) — no
                "Never run yet" placeholder. Helps explain why an
                album that was unmatched yesterday now shows
                "pending" again without the user having done
                anything. */}
            {status.lastUnmatchedRequeueAt && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6, paddingTop: 8, borderTop: '1px dashed var(--border)' }}>
                <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                  Last auto-retry of failed matches
                </span>
                <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                  {relTimeShort(Math.floor(status.lastUnmatchedRequeueAt / 1000))}
                  {status.lastUnmatchedRequeueCount > 0 && (
                    <span style={{ color: 'var(--text-tertiary)', marginLeft: 6 }}>
                      · {status.lastUnmatchedRequeueCount} re-queued
                    </span>
                  )}
                </span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function PendingCell({ label, count, active }) {
  return (
    <div style={{
      ...s.pendingCell,
      ...(active ? s.pendingCellActive : {}),
      ...(count === 0 ? s.pendingCellDone : {}),
    }}>
      <div style={s.pendingCellLabel}>{label}</div>
      <div style={s.pendingCellCount}>{count === 0 ? '✓' : count}</div>
    </div>
  )
}

function schedulerStatusLabel(s_) {
  const mode = s_.mode
  if (mode === 'off') return 'Scheduler off'
  if (s_.currentJob) {
    const job = { match: 'Matching albums', art: 'Fetching cover art', vl: 'Scanning loudness', logos: 'Fetching logos', bios: 'Fetching bios' }[s_.currentJob] || s_.currentJob
    return job
  }
  if (s_.status === 'cooldown') return 'Cooling down between jobs'
  if (s_.status === 'paused-thermal') return 'Paused: CPU too hot'
  // v1.1.0.77 — when any zone is playing, the scheduler defers its
  // tick (and pauses an in-progress cycle between jobs) so background
  // metadata work doesn't compete with active streaming.
  if (s_.status === 'paused-playback') return 'Paused: music is playing'
  if (s_.status === 'waiting-window') return 'Waiting for scheduled window'
  if (s_.totalPending === 0) return mode === 'off' ? 'Scheduler off' : 'All caught up'
  if (mode === 'scheduled' && s_.window?.insideNow === false) return 'Outside scheduled window'
  return 'Idle'
}

// v1.1.0.60 — small in-app bug-reporting panel on the Update screen.
// User flow: tap "Report a bug" → text box reveals → type a brief
// description → tap "Send". The client POSTs { note } to
// /api/bugreport. The server saves a timestamped JSON report
// containing the note, version, and a tail of musicd's stderr log
// to /var/lib/musicd/bug-reports/. Once SMTP is configured the
// same payload will be emailed to the developer. For now the user
// gets a confirmation filename they can mention if they raise it
// manually.
// v1.1.0.78 — bug-report panel rewritten to actually deliver mail.
// Three-tier strategy:
//   1. **Web Share API** (preferred). iOS / Android / desktop Safari
//      support `navigator.share({ files: [...] })` — opens the system
//      share sheet, the user picks Mail (or Messages, or whatever),
//      and the full JSON is attached as a real file. This is by far
//      the cleanest path on the platforms most testers use.
//   2. **mailto:** (fallback). Older browsers / desktops without
//      Web Share support open a `mailto:` URL with To/Subject pre-
//      filled and a compact summary in the body. mailto can't do
//      attachments, so the body has the description + last 50
//      journal lines and points to the on-disk filename for the
//      full JSON if needed.
//   3. **Copy to clipboard** (always available). If neither of the
//      above worked, or the user just wants the text, they can copy
//      the email body and paste it themselves.
//
// In all cases the report is also written to disk on the server
// (existing v60 behaviour), retained for 90 days / last 50 reports
// (new v78 retention), and accessible at
// /api/bug-report/file/<filename> if the developer ever needs the
// full JSON.
const BUG_REPORT_RECIPIENT = 'lm1980@me.com';

function BugReportPanel({ currentVersion }) {
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [hasShared, setHasShared] = useState(false)
  const [copied, setCopied] = useState(false)
  const [downloaded, setDownloaded] = useState(false)

  // Can this page attach the report to a share sheet, and if not, why not?
  // See ../bugReportShare — the answer on a LAN install is almost always
  // "the origin is not secure", not "the browser cannot".
  const shareMode = (typeof navigator === 'undefined')
    ? SHARE_INSECURE
    : classifyShare(navigator, typeof window !== 'undefined' && window.isSecureContext, null)
  const canShareFiles = shareMode === SHARE_FILES

  const send = async () => {
    if (!note.trim()) return
    setSending(true)
    setError(null)
    setHasShared(false)
    try {
      // POST captures the full report and saves it on disk. Response
      // includes both a compact emailBody (for mailto:) and the full
      // fullJson (for Web Share file attachment).
      const r = await api.post('/bug-report', {
        description: note.trim(),
      })
      setResult(r)
      setNote('')
    } catch (e) {
      setError(e.message || 'Failed to capture report')
    } finally {
      setSending(false)
    }
  }

  const subject = `MusicD bug report v${result?.version || currentVersion || '?'} — ${result?.id || ''}`

  const shareViaWebShare = async () => {
    if (!result?.fullJson) return
    try {
      // v1.1.0.84: build the file as text/plain with a .txt extension.
      // The previous .json + application/json combination triggered
      // "permission denied" on iOS Safari when the actual share fired
      // even after canShare returned true at probe time. Sharing as
      // text keeps the JSON payload identical (ASCII text either way)
      // and works reliably across iOS, Android, and desktop.
      const filename = (result.filename || `musicd-bug-${result.id}`).replace(/\.json$/, '') + '.txt'
      const fileBody = JSON.stringify(result.fullJson, null, 2)
      const file = new File([fileBody], filename, { type: 'text/plain' })

      // Re-verify canShare on the actual file we're about to send.
      // Some browsers approve canShare for the probe but reject the
      // real file (size, type, count). If this fails we fall back to
      // a text-only share rather than throwing — at least the user
      // gets the share sheet open.
      let payload = { title: subject, text: `${subject}\n\n${note || result.fullJson.description || ''}`, files: [file] }
      if (navigator.canShare && !navigator.canShare(payload)) {
        console.warn('[bug-report] canShare rejected file payload; falling back to text-only share')
        payload = { title: subject, text: `${subject}\n\n${note || result.fullJson.description || ''}\n\n--- FULL REPORT ---\n${fileBody}` }
      }

      await navigator.share(payload)
      setHasShared(true)
    } catch (e) {
      // User dismissed the share sheet — that's not an error worth
      // surfacing. Real errors get logged for diagnostics.
      if (e?.name !== 'AbortError') {
        console.warn('[bug-report] Web Share failed:', e?.message || e)
        setError(`Couldn't open share sheet: ${e?.message || 'unknown'}`)
      }
    }
  }

  const shareViaMailto = () => {
    if (!result?.emailBody) return
    const url = 'mailto:' + encodeURIComponent(BUG_REPORT_RECIPIENT)
      + '?subject=' + encodeURIComponent(subject)
      + '&body=' + encodeURIComponent(result.emailBody)
    // Length warning: most mail clients cap at ~2000 chars; the
    // server-side buildEmailBody trims to a 50-line journal tail to
    // stay under that, but if the user's description is huge it's
    // still possible to overflow. We don't try to be clever here —
    // if the mail client refuses, the Copy button still works.
    window.location.href = url
    setHasShared(true)
  }

  // Put the real .json on the device.
  //
  // The server already saved it and already serves it back with
  // Content-Disposition: attachment, so this is a plain navigation: iOS puts
  // the file in Files → Downloads, where the mail app's attachment picker can
  // reach it. That is the difference between "attach the report" and "ask the
  // developer for 2026-08-19T20-38-09-129Z-m01rt8.json — it's saved on your
  // box", which is what this screen used to say.
  const downloadReport = () => {
    const url = reportDownloadUrl(result?.filename)
    if (!url) {
      setError('No saved report to download')
      return
    }
    setDownloaded(true)
    window.location.href = url
  }

  const copyBodyToClipboard = async () => {
    if (!result?.emailBody) return
    const text = `To: ${BUG_REPORT_RECIPIENT}\nSubject: ${subject}\n\n${result.emailBody}`
    try {
      if (hasAsyncClipboard(navigator)) {
        await navigator.clipboard.writeText(text)
      } else {
        // navigator.clipboard is secure-context-gated, so on a plain-HTTP LAN
        // install it is undefined and the old code threw "undefined is not an
        // object". execCommand is deprecated but is not gated, and is the only
        // thing that works on exactly the origins that need it.
        const ta = document.createElement('textarea')
        ta.value = text
        // Off-screen rather than hidden: a display:none textarea cannot be
        // selected, and iOS needs it focusable and non-zero-sized.
        ta.setAttribute('readonly', '')
        ta.style.position = 'fixed'
        ta.style.top = '0'
        ta.style.left = '-9999px'
        document.body.appendChild(ta)
        ta.select()
        ta.setSelectionRange(0, text.length)   // iOS ignores select() alone
        const ok = document.execCommand('copy')
        document.body.removeChild(ta)
        if (!ok) throw new Error('the browser refused the copy')
      }
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (e) {
      setError('Copy failed: ' + (e?.message || 'browser denied clipboard access'))
    }
  }

  return (
    <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border-faint)' }}>
      {!open ? (
        <button
          onClick={() => setOpen(true)}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '8px 14px',
            background: 'transparent',
            border: '1px solid var(--border-soft)',
            borderRadius: 6,
            color: 'var(--text-secondary)',
            fontSize: 12, fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          Report a bug
        </button>
      ) : (
        <div>
          {!result ? (
            <>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>
                Briefly describe what happened. Recent server logs and your version are included automatically.
              </div>
              <textarea
                value={note}
                onChange={e => setNote(e.target.value)}
                disabled={sending}
                placeholder="What were you doing when the bug appeared?"
                rows={4}
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  padding: 10,
                  background: 'var(--bg-input, rgba(255,255,255,0.04))',
                  border: '1px solid var(--border-soft)',
                  borderRadius: 6,
                  color: 'var(--text-primary)',
                  fontSize: 12,
                  fontFamily: 'inherit',
                  resize: 'vertical',
                }}
              />
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button
                  onClick={send}
                  disabled={sending || !note.trim()}
                  style={{
                    padding: '7px 14px',
                    background: 'var(--accent)',
                    border: 'none', borderRadius: 6,
                    color: '#fff',
                    fontSize: 12, fontWeight: 600,
                    cursor: sending ? 'default' : 'pointer',
                    opacity: (sending || !note.trim()) ? 0.5 : 1,
                  }}
                >
                  {sending ? 'Capturing…' : 'Continue'}
                </button>
                <button
                  onClick={() => { setOpen(false); setNote(''); setResult(null); setError(null) }}
                  disabled={sending}
                  style={{
                    padding: '7px 14px',
                    background: 'transparent',
                    border: '1px solid var(--border-soft)',
                    borderRadius: 6,
                    color: 'var(--text-secondary)',
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
              </div>
            </>
          ) : (
            // Capture succeeded — now offer share / mailto / copy
            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              <div style={{ marginBottom: 8 }}>
                Report captured ({result.id}). Send it to <code style={{ fontFamily: 'var(--font-mono)' }}>{BUG_REPORT_RECIPIENT}</code>:
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {canShareFiles && (
                  <button
                    onClick={shareViaWebShare}
                    style={{
                      padding: '7px 14px',
                      background: 'var(--accent)',
                      border: 'none', borderRadius: 6,
                      color: '#fff',
                      fontSize: 12, fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    Share with full attachment…
                  </button>
                )}
                {/* Without the direct-attach path this is the button that
                    actually gets the JSON to the user, so it leads. */}
                {!canShareFiles && (
                  <button
                    onClick={downloadReport}
                    style={{
                      padding: '7px 14px',
                      background: 'var(--accent)',
                      border: 'none', borderRadius: 6,
                      color: '#fff',
                      fontSize: 12, fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    {downloaded ? 'Saved ✓' : 'Save report file'}
                  </button>
                )}
                <button
                  onClick={shareViaMailto}
                  style={{
                    padding: '7px 14px',
                    background: 'transparent',
                    border: '1px solid var(--border-soft)',
                    borderRadius: 6,
                    color: 'var(--text-secondary)',
                    fontSize: 12, fontWeight: 500,
                    cursor: 'pointer',
                  }}
                >
                  Open email app
                </button>
                <button
                  onClick={copyBodyToClipboard}
                  style={{
                    padding: '7px 14px',
                    background: 'transparent',
                    border: '1px solid var(--border-soft)',
                    borderRadius: 6,
                    color: 'var(--text-secondary)',
                    fontSize: 12, fontWeight: 500,
                    cursor: 'pointer',
                  }}
                >
                  {copied ? 'Copied ✓' : 'Copy as text'}
                </button>
                <button
                  onClick={() => { setOpen(false); setNote(''); setResult(null); setError(null); setHasShared(false); setDownloaded(false) }}
                  style={{
                    padding: '7px 14px',
                    background: 'transparent',
                    border: '1px solid var(--border-soft)',
                    borderRadius: 6,
                    color: 'var(--text-tertiary)',
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                >
                  Done
                </button>
              </div>
              {hasShared && (
                <div style={{ marginTop: 10, fontSize: 11, color: '#3fd07a' }}>
                  {canShareFiles
                    ? 'Thanks — your mail app should be open with the report attached.'
                    : 'Thanks — your mail app should be open with a summary. Attach the saved report file to it if you have not already.'}
                </div>
              )}
              {!canShareFiles && (
                <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
                  {shareMode === SHARE_INSECURE ? (
                    <>
                      <b>Save report file</b> downloads <code style={{ fontFamily: 'var(--font-mono)' }}>{result.filename}</code>
                      {' '}to this device — on iOS it lands in Files → Downloads. Then tap <b>Open email app</b> and attach it from there.
                      <div style={{ marginTop: 6 }}>
                        Attaching it in one step needs the Web Share API, which browsers only
                        expose over HTTPS. MusicD is served over plain HTTP on your network, so
                        the browser withholds it — nothing to do with which browser you use.
                      </div>
                    </>
                  ) : (
                    <>
                      This browser can't attach files to a share sheet. <b>Save report file</b> downloads
                      {' '}<code style={{ fontFamily: 'var(--font-mono)' }}>{result.filename}</code> to this
                      device so you can attach it to the email yourself.
                    </>
                  )}
                </div>
              )}
            </div>
          )}
          {error && (
            <div style={{ marginTop: 10, fontSize: 11, color: 'var(--red, #e05555)' }}>
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// "What's in this version" panel (#v1.1.0.25, refactored v1.1.0.74).
// In v25–v73 this block rendered the running build's release notes
// inline as a markdown column. The release notes had grown long
// enough that the Update screen was dominated by them — you had
// to scroll past the whole block to reach anything else. v74
// compresses the inline block to a single tappable summary line
// ("What's new in v1.1.0.X →") that opens a full-screen modal
// reader with X-to-close at the top left.
//
// The current-version label is fetched from the same endpoint that
// returned the notes (which already includes a `version` field on
// the response), with a graceful fallback to the bundled VERSION
// string we already display elsewhere.
function ReleaseNotesPanel({ currentVersion }) {
  const [notes, setNotes] = useState(null)
  const [version, setVersion] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [showFull, setShowFull] = useState(false)

  useEffect(() => {
    let cancelled = false
    api.get('/update/release-notes')
      .then(r => {
        if (cancelled) return
        setNotes(r?.notes || null)
        setVersion(r?.version || null)
      })
      .catch(e => { if (!cancelled) setError(e.message || 'Failed') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  // Pick the best label for the modal trigger. Server-supplied
  // version wins (it matches whatever the server thinks it is);
  // fall back to the prop, which usually comes from the running
  // build's bundled VERSION file.
  const label = version || currentVersion || ''

  // No-notes states get a quiet inline message rather than a
  // tappable link — there's nothing to open. We deliberately don't
  // expose the "no notes bundled" state as a button, because tapping
  // it would open an empty modal.
  if (loading) {
    return <div style={s.releaseNotesEmpty}>Loading…</div>
  }
  if (error) {
    return <div style={s.releaseNotesEmpty}>Couldn't load notes: {error}</div>
  }
  if (!notes) {
    return <div style={s.releaseNotesEmpty}>No notes bundled with this build.</div>
  }

  return (
    <>
      <button
        onClick={() => setShowFull(true)}
        style={s.releaseNotesLink}
        aria-haspopup="dialog"
      >
        What's new in {label ? `v${label}` : 'this version'} →
      </button>
      {showFull && (
        <ReleaseNotesModal
          notes={notes}
          version={label}
          onClose={() => setShowFull(false)}
        />
      )}
    </>
  )
}

// v1.1.0.74 — full-screen reader for the running build's release
// notes. Same overlay/sheet pattern as the long-running
// ChangelogModal (so they feel like the same family of UI), with
// two intentional differences:
//   1. X close button sits at the TOP LEFT, not top right. The
//      user reported the right-side X was easy to miss after
//      scrolling; left-side feels more like a "back" gesture and
//      is what they asked for.
//   2. We render the bundled notes prop directly rather than
//      fetching the full CHANGELOG.md, so the modal opens
//      instantly with no second loading state.
function ReleaseNotesModal({ notes, version, onClose }) {
  return (
    <div style={s.clOverlay} onClick={onClose}>
      <div style={s.clSheet} onClick={e => e.stopPropagation()}>
        <div style={s.rnHeader}>
          <button style={s.rnCloseBtn} onClick={onClose} aria-label="Close">✕</button>
          <div style={s.rnTitle}>
            What's new{version ? ` in v${version}` : ''}
          </div>
        </div>
        <div style={s.clBody}>
          <SimpleMarkdown text={notes} />
        </div>
      </div>
    </div>
  )
}

// Full-screen changelog overlay (#v1.1.0.25). Loads CHANGELOG.md
// once on mount; rendering re-uses the same SimpleMarkdown component
// as the release-notes panel for consistent typography.
function ChangelogModal({ onClose }) {
  const [text, setText] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  useEffect(() => {
    let cancelled = false
    fetch('/api/update/changelog')
      .then(r => r.text())
      .then(t => { if (!cancelled) setText(t) })
      .catch(e => { if (!cancelled) setError(e.message || 'Failed') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  return (
    <div style={s.clOverlay} onClick={onClose}>
      <div style={s.clSheet} onClick={e => e.stopPropagation()}>
        <div style={s.clHeader}>
          <div style={s.clTitle}>MusicD Changelog</div>
          <button style={s.clCloseBtn} onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div style={s.clBody}>
          {loading && <div style={s.releaseNotesEmpty}>Loading…</div>}
          {error && <div style={s.releaseNotesEmpty}>Couldn't load changelog: {error}</div>}
          {text && <SimpleMarkdown text={text} />}
        </div>
      </div>
    </div>
  )
}

// Tiny markdown renderer for changelog content (#v1.1.0.25). We don't
// need full CommonMark support here -- just headings (## ###),
// bullet lists (- item), bold (**x**), inline code (`x`), em-dash
// horizontal rules (---). This avoids pulling in a 30 KB markdown
// library for what's effectively three syntactic features.
function SimpleMarkdown({ text }) {
  const lines = (text || '').split('\n')
  const blocks = []
  let listBuffer = null
  const flushList = () => {
    if (listBuffer && listBuffer.length) {
      blocks.push({ type: 'list', items: listBuffer })
      listBuffer = null
    }
  }
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (line.startsWith('## ')) {
      flushList()
      blocks.push({ type: 'h2', text: line.slice(3) })
    } else if (line.startsWith('### ')) {
      flushList()
      blocks.push({ type: 'h3', text: line.slice(4) })
    } else if (line.startsWith('# ')) {
      flushList()
      blocks.push({ type: 'h1', text: line.slice(2) })
    } else if (/^- /.test(line)) {
      if (!listBuffer) listBuffer = []
      listBuffer.push(line.slice(2))
    } else if (line === '---') {
      flushList()
      blocks.push({ type: 'hr' })
    } else if (line.trim() === '') {
      flushList()
      // Blank line just terminates a list / paragraph; no block emitted.
    } else {
      flushList()
      blocks.push({ type: 'p', text: line })
    }
  }
  flushList()

  return (
    <div style={s.mdRoot}>
      {blocks.map((b, i) => {
        if (b.type === 'h1') return <h1 key={i} style={s.mdH1}>{renderInline(b.text)}</h1>
        if (b.type === 'h2') return <h2 key={i} style={s.mdH2}>{renderInline(b.text)}</h2>
        if (b.type === 'h3') return <h3 key={i} style={s.mdH3}>{renderInline(b.text)}</h3>
        if (b.type === 'hr') return <hr key={i} style={s.mdHr} />
        if (b.type === 'list') {
          return (
            <ul key={i} style={s.mdUl}>
              {b.items.map((it, j) => <li key={j} style={s.mdLi}>{renderInline(it)}</li>)}
            </ul>
          )
        }
        return <p key={i} style={s.mdP}>{renderInline(b.text)}</p>
      })}
    </div>
  )
}

// Inline-markdown handling: **bold**, `code`, leave the rest as text.
// Returns an array of React nodes. We don't try to parse links --
// none of our changelog entries contain inline URLs.
function renderInline(s_) {
  if (!s_) return null
  const parts = []
  let i = 0
  let plain = ''
  const flush = () => { if (plain) { parts.push(plain); plain = '' } }
  while (i < s_.length) {
    if (s_[i] === '*' && s_[i+1] === '*') {
      const end = s_.indexOf('**', i + 2)
      if (end > 0) {
        flush()
        parts.push(<strong key={`b${i}`}>{s_.slice(i + 2, end)}</strong>)
        i = end + 2
        continue
      }
    }
    if (s_[i] === '`') {
      const end = s_.indexOf('`', i + 1)
      if (end > 0) {
        flush()
        parts.push(<code key={`c${i}`} style={s.mdCode}>{s_.slice(i + 1, end)}</code>)
        i = end + 1
        continue
      }
    }
    plain += s_[i]
    i++
  }
  flush()
  return parts
}

// Service health metadata (#v1.1.0.24). Display name + brief use
// description per service. The id matches what serviceHealth.js
// records under, so the live status object keys directly into this
// list.
const SERVICE_DEFS = [
  { id: 'lastfm',      name: 'Last.fm',      uses: 'scrobbling, bios' },
  { id: 'fanart',      name: 'fanart.tv',    uses: 'artist logos' },
  { id: 'audiodb',     name: 'TheAudioDB',   uses: 'artist logos, bios' },
  { id: 'acoustid',    name: 'AcoustID',     uses: 'fingerprint matching' },
  { id: 'musicbrainz', name: 'MusicBrainz',  uses: 'album matching, bios' },
]

// Single row of the service health list. Renders a coloured dot, the
// service name, what it's used for, and a small relative-time hint.
// On 'fail', the last error message gets revealed below the row.
function ServiceHealthRow({ def, info }) {
  // info shape: { status: 'ok'|'fail'|'idle',
  //               lastSuccessAt, lastFailureAt, lastError }
  // (or null if the API hasn't responded yet)
  const status = info?.status || 'idle'
  const dotStyle =
    status === 'ok'   ? s.healthDotOk :
    status === 'fail' ? s.healthDotFail :
                        s.healthDotIdle

  // Subtitle picks the most relevant timestamp for the current status.
  // For idle services we just show "no recent calls".
  let when = null
  if (status === 'ok' && info?.lastSuccessAt) {
    when = `last ok ${relTimeShortMs(info.lastSuccessAt)}`
  } else if (status === 'fail' && info?.lastFailureAt) {
    when = `last failed ${relTimeShortMs(info.lastFailureAt)}`
  } else {
    when = 'no recent calls'
  }

  return (
    <div style={s.healthRow}>
      <div style={s.healthMain}>
        <div style={dotStyle} />
        <div style={s.healthText}>
          <div style={s.healthName}>{def.name}</div>
          <div style={s.healthSub}>
            {def.uses} · {when}
          </div>
        </div>
      </div>
      {status === 'fail' && info?.lastError && (
        <div style={s.healthError} title={info.lastError}>
          {info.lastError.length > 80 ? info.lastError.slice(0, 80) + '…' : info.lastError}
        </div>
      )}
    </div>
  )
}

// Same vocabulary as relTimeShort but takes ms instead of unix seconds.
// serviceHealth records Date.now() so it stores ms.
function relTimeShortMs(ms) {
  if (!ms) return ''
  const delta = Math.max(0, Date.now() - ms)
  if (delta < 60_000) return 'just now'
  const m = Math.floor(delta / 60_000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(delta / 3_600_000)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(delta / 86_400_000)
  if (d === 1) return 'yesterday'
  return `${d}d ago`
}

// v1.1.1.3 — styles for the tier panel, channel picker, and
// code entry modal. Kept separate from the main `s` map so the
// tier UI can be visually iterated without disturbing existing
// layout.
const TIER_BADGE_COLORS = {
  demo:        { bg: '#3a2a1a', fg: '#ffb86b' },  // amber: demo / not-yet-paid
  stable:      { bg: '#1a3a26', fg: '#5fd97f' },  // green: production
  earlyAccess: { bg: '#1a2e3a', fg: '#5fb6d9' },  // teal: stable preview
  beta:        { bg: '#3a1a2a', fg: '#d97fb6' },  // pink: testing
  alpha:       { bg: '#3a1a1a', fg: '#d96b6b' },  // red: experimental / dev
}
const STABILITY_COLORS = {
  stable:           { bg: '#1a3a26', fg: '#5fd97f' },
  'stable-preview': { bg: '#1a2e3a', fg: '#5fb6d9' },
  testing:          { bg: '#3a1a2a', fg: '#d97fb6' },
  experimental:     { bg: '#3a1a1a', fg: '#d96b6b' },
}
const tierStyles = {
  panel: {
    marginTop: 12,
    marginBottom: 14,
    padding: '12px 14px',
    background: 'var(--bg-overlay)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
  },
  tierRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    marginBottom: 10,
  },
  tierLabelSmall: {
    fontSize: 11,
    color: 'var(--text-tertiary)',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
  },
  tierBadge: (tier) => ({
    fontSize: 11,
    fontWeight: 600,
    padding: '3px 8px',
    borderRadius: 4,
    background: TIER_BADGE_COLORS[tier]?.bg || '#222',
    color: TIER_BADGE_COLORS[tier]?.fg || '#999',
  }),
  resetBtn: {
    marginLeft: 'auto',
    fontSize: 11,
    padding: '4px 10px',
    background: 'none',
    border: '1px solid var(--border)',
    color: 'var(--text-secondary)',
    borderRadius: 4,
    cursor: 'pointer',
  },

  demoBanner: {
    padding: '12px 14px',
    background: 'rgba(255, 184, 107, 0.06)',
    border: '1px solid rgba(255, 184, 107, 0.18)',
    borderRadius: 'var(--radius-sm)',
    marginTop: 6,
  },
  demoBannerTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: '#ffb86b',
    marginBottom: 4,
  },
  demoBannerBody: {
    fontSize: 12,
    color: 'var(--text-secondary)',
    lineHeight: 1.5,
    marginBottom: 10,
  },
  enterCodeBtn: {
    fontSize: 12,
    padding: '8px 14px',
    background: '#ffb86b',
    color: '#1a1208',
    border: 'none',
    borderRadius: 4,
    fontWeight: 600,
    cursor: 'pointer',
  },

  // v1.1.3.8 — optional upgrade path shown at or above the baseline
  // tier. Neutral on purpose: demoBanner's amber reads as a warning,
  // and nothing here is a limitation.
  upgradeRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    flexWrap: 'wrap',
    marginTop: 10,
    paddingTop: 10,
    borderTop: '1px solid var(--border)',
  },
  upgradeText: {
    flex: 1,
    minWidth: 160,
    fontSize: 12,
    color: 'var(--text-secondary)',
    lineHeight: 1.5,
  },
  upgradeBtn: {
    flex: '0 0 auto',
    fontSize: 11,
    padding: '5px 12px',
    background: 'none',
    border: '1px solid var(--border)',
    color: 'var(--text-secondary)',
    borderRadius: 4,
    cursor: 'pointer',
  },

  channelPicker: {
    marginTop: 6,
  },
  channelPickerLabel: {
    fontSize: 11,
    color: 'var(--text-tertiary)',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    marginBottom: 6,
  },
  channelRow: {
    display: 'block',
    width: '100%',
    textAlign: 'left',
    padding: '10px 12px',
    marginBottom: 4,
    background: 'transparent',
    border: '1px solid var(--border)',
    borderRadius: 4,
    color: 'var(--text)',
    cursor: 'pointer',
  },
  channelRowActive: {
    display: 'block',
    width: '100%',
    textAlign: 'left',
    padding: '10px 12px',
    marginBottom: 4,
    background: 'rgba(95, 217, 127, 0.08)',
    border: '1px solid rgba(95, 217, 127, 0.3)',
    borderRadius: 4,
    color: 'var(--text)',
    cursor: 'default',
  },
  channelRowLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 2,
  },
  channelRowRight: {
    fontSize: 11,
    color: 'var(--text-tertiary)',
    fontFamily: 'var(--font-mono)',
    marginLeft: 'auto',
  },
  channelRadio: {
    fontSize: 14,
    color: 'var(--accent)',
    width: 14,
  },
  channelLabel: {
    fontSize: 13,
    fontWeight: 500,
  },
  channelVersion: {
    fontSize: 11,
    color: 'var(--text-tertiary)',
    fontFamily: 'var(--font-mono)',
    float: 'right',
  },
  channelDescription: {
    fontSize: 11,
    color: 'var(--text-tertiary)',
    marginTop: 4,
    paddingLeft: 22,
  },
  stabilityBadge: (stability) => ({
    fontSize: 10,
    fontWeight: 500,
    padding: '1px 6px',
    borderRadius: 3,
    background: STABILITY_COLORS[stability]?.bg || '#222',
    color: STABILITY_COLORS[stability]?.fg || '#888',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  }),
  singleChannelNote: {
    fontSize: 11,
    color: 'var(--text-tertiary)',
    fontStyle: 'italic',
  },

  // Modal styles for the code entry dialog.
  modalBackdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.5)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
    padding: 20,
  },
  modalPanel: {
    background: 'var(--bg)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    padding: '20px 22px',
    minWidth: 280,
    maxWidth: 360,
    width: '100%',
  },
  modalTitle: {
    fontSize: 15,
    fontWeight: 600,
    marginBottom: 6,
  },
  modalBody: {
    fontSize: 12,
    color: 'var(--text-secondary)',
    marginBottom: 14,
    lineHeight: 1.5,
  },
  codeInput: {
    width: '100%',
    padding: '12px 14px',
    fontSize: 22,
    fontFamily: 'var(--font-mono)',
    letterSpacing: '0.4em',
    textAlign: 'center',
    background: 'var(--bg-overlay)',
    border: '1px solid var(--border)',
    borderRadius: 4,
    color: 'var(--text)',
    boxSizing: 'border-box',
    marginBottom: 6,
  },
  codeError: {
    fontSize: 11,
    color: '#ff8888',
    marginBottom: 8,
  },
  modalActions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: 14,
  },
  modalCancel: {
    padding: '8px 14px',
    fontSize: 12,
    background: 'transparent',
    border: '1px solid var(--border)',
    color: 'var(--text-secondary)',
    borderRadius: 4,
    cursor: 'pointer',
  },
  modalSubmit: {
    padding: '8px 14px',
    fontSize: 12,
    fontWeight: 600,
    background: 'var(--accent)',
    border: 'none',
    color: 'var(--bg)',
    borderRadius: 4,
    cursor: 'pointer',
  },
  modalSubmitDisabled: {
    padding: '8px 14px',
    fontSize: 12,
    fontWeight: 600,
    background: 'var(--bg-overlay)',
    border: '1px solid var(--border)',
    color: 'var(--text-tertiary)',
    borderRadius: 4,
    cursor: 'not-allowed',
  },
}

const s = {
  page: { padding: '10px 14px 120px' },
  loadWrap: { display: 'flex', justifyContent: 'center', paddingTop: 60 },
  spinner: { width: 22, height: 22, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' },

  // Release notes panel on the Update screen (#v1.1.0.25). Quiet box,
  // inset slightly so it reads as a separate piece of content rather
  // than a bordered alert. Title is small and muted because the
  // content speaks for itself.
  releaseNotesBox: {
    background: 'var(--bg-overlay)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    padding: '12px 14px',
  },
  releaseNotesTitle: {
    fontSize: 11, fontWeight: 700, letterSpacing: '0.06em',
    textTransform: 'uppercase', color: 'var(--text-secondary)',
    marginBottom: 8,
  },
  releaseNotesEmpty: { fontSize: 12, color: 'var(--text-tertiary)' },

  // v1.1.0.74 — collapsed "What's new" trigger. Reads as a quiet
  // tappable link, not as a primary action button — the actual
  // primary action on this page is "Install" (when there's
  // something to install). Underline-on-hover and the trailing
  // arrow are the discoverability cues.
  releaseNotesLink: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    background: 'none', border: 'none', padding: 0,
    fontSize: 13, fontWeight: 500,
    color: 'var(--text-primary)',
    textDecoration: 'underline',
    textUnderlineOffset: 3,
    textDecorationColor: 'var(--border-bright, rgba(255,255,255,0.18))',
    cursor: 'pointer',
  },
  // Release-notes modal header. Shares the bottom-sheet body style
  // (s.clSheet / s.clBody) with the long-running ChangelogModal, but
  // its header puts the X on the LEFT — the user reported the
  // right-side X on the existing changelog modal was easy to miss
  // after a long scroll, and asked for left-side specifically here.
  // Keeping the changelog modal's right-side X unchanged so we don't
  // drag-along refactor something they didn't ask about.
  rnHeader: {
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '14px 18px',
    borderBottom: '1px solid var(--border)',
  },
  rnCloseBtn: {
    width: 30, height: 30, borderRadius: '50%',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--bg-elevated)',
    color: 'var(--text-tertiary)',
    border: '1px solid var(--border)',
    fontSize: 14,
    cursor: 'pointer',
    flexShrink: 0,
  },
  rnTitle: {
    fontSize: 16, fontWeight: 700,
    minWidth: 0,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },

  // Metadata scheduler section (#v1.1.0.28).
  // Time input -- the native <input type="time"> styled to match
  // textInput. Pickers on iOS/Android open the system time UI which
  // is a much better experience than a custom slider.
  timeInput: {
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    color: 'var(--text-primary)',
    padding: '6px 8px',
    fontSize: 13,
    fontFamily: 'inherit',
    minWidth: 80,
  },
  // Pending counts grid -- 5 cells in a row, equal width. On narrow
  // phones they wrap to two rows naturally.
  pendingGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6,
  },
  pendingCell: {
    padding: '8px 6px',
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    textAlign: 'center',
  },
  // Active = the job currently running. Highlight with the accent border.
  pendingCellActive: {
    borderColor: 'var(--accent)',
    background: 'rgba(91,127,255,0.10)',
  },
  // Done = no items pending. Quieter colour so the eye sees what
  // still has work in it.
  pendingCellDone: {
    opacity: 0.55,
  },
  pendingCellLabel: {
    fontSize: 10, fontWeight: 600,
    textTransform: 'uppercase', letterSpacing: '0.05em',
    color: 'var(--text-tertiary)',
    marginBottom: 3,
  },
  pendingCellCount: {
    fontSize: 14, fontWeight: 700, color: 'var(--text-primary)',
  },

  // Mode pills for the metadata scheduler (#v1.1.0.28). Themed to
  // match the Random / Favourites pills on the Albums screen for
  // visual consistency. Single-select: clicking one becomes active,
  // others become inactive. Same style as iconChip in AlbumGrid.jsx
  // (padding 8/14, font 13, radius 18) but with the accent colour
  // for the active state instead of the heart-red of Favourites.
  modePillRow: {
    display: 'flex', gap: 8,
    marginTop: 12, marginBottom: 4,
    flexWrap: 'wrap',
  },
  modePill: {
    display: 'inline-flex', alignItems: 'center', gap: 7,
    padding: '8px 16px', borderRadius: 18,
    fontSize: 13, fontWeight: 600,
    color: 'var(--text-secondary)',
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border)',
    cursor: 'pointer',
    transition: 'background 120ms, border-color 120ms, color 120ms',
  },
  modePillActive: {
    color: 'var(--accent)',
    background: 'rgba(91,127,255,0.10)',
    borderColor: 'rgba(91,127,255,0.45)',
  },

  // "Click here for MusicD Changelog" -- styled as a link, not a
  // button, so it reads as auxiliary nav rather than an action.
  changelogLink: {
    background: 'none', border: 'none', padding: 0,
    color: 'var(--accent)', textDecoration: 'underline',
    fontSize: 12, cursor: 'pointer',
  },

  // Changelog modal -- slides up like the album-candidates sheet
  // but slightly taller (90vh) since the changelog is the main
  // content. Same dark palette as the rest of Settings.
  clOverlay: { position: 'fixed', inset: 0, zIndex: 950, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'flex-end' },
  clSheet: { background: 'var(--bg-surface)', borderRadius: '16px 16px 0 0', width: '100%', maxHeight: '92vh', display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--border)' },
  clHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', borderBottom: '1px solid var(--border)' },
  clTitle: { fontSize: 16, fontWeight: 700 },
  clCloseBtn: { width: 30, height: 30, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-elevated)', color: 'var(--text-tertiary)', border: '1px solid var(--border)', fontSize: 14, cursor: 'pointer' },
  clBody: { flex: 1, overflowY: 'auto', padding: '12px 18px 24px' },

  // Tiny markdown renderer styles. Not full markdown -- just the few
  // bits we use in CHANGELOG.md and release-notes blocks.
  mdRoot: { color: 'var(--text-primary)', lineHeight: 1.5, fontSize: 13 },
  mdH1: { fontSize: 18, fontWeight: 700, margin: '12px 0 8px' },
  mdH2: { fontSize: 15, fontWeight: 700, margin: '14px 0 6px', color: 'var(--text-primary)' },
  mdH3: { fontSize: 12, fontWeight: 700, margin: '10px 0 4px', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-secondary)' },
  mdP:  { fontSize: 12, color: 'var(--text-secondary)', margin: '0 0 8px', lineHeight: 1.55 },
  mdUl: { margin: '4px 0 12px', paddingLeft: 18, color: 'var(--text-secondary)' },
  mdLi: { fontSize: 12, marginBottom: 4, lineHeight: 1.55 },
  mdHr: { border: 'none', borderTop: '1px solid var(--border)', margin: '14px 0' },
  mdCode: { fontFamily: 'var(--font-mono)', fontSize: 11, padding: '1px 5px', background: 'var(--bg-elevated)', borderRadius: 3 },

  // back: removed in #30.20 — Settings used to have an explicit text
  //   "Back" button, but the topbar chevron has been the canonical
  //   back affordance since #30.14. Style kept commented for context;
  //   safe to delete in a future cleanup.
  heading: { fontSize: 22, fontWeight: 700, letterSpacing: '-0.4px', margin: 0, color: 'var(--text-primary)' },
  brandHeader: { display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14 },
  brandSpacer: { flex: 1 },
  // v1.1.3.3 — restart button. Equal-sized to the brand icon (56×56)
  // so they read as a balanced pair on the same horizontal line. The
  // colour is muted-red because this action drops state; we want it
  // visually distinct from harmless actions.
  restartBtn: {
    width: 56, height: 56, borderRadius: 12,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--red, #d62828)',
    color: '#ffffff',
    border: 'none',
    cursor: 'pointer',
    flex: '0 0 auto',
  },
  restartBusy: {
    width: 56, height: 56, borderRadius: 12,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--bg-elevated)',
    color: 'var(--text-secondary)',
    flex: '0 0 auto',
  },
  // v1.1.3.4 — confirm prompt now takes over the full brand row
  // when active. Was previously sized to fit in the 56px right-edge
  // slot, which was way too narrow for the "Are you sure…?" string
  // on phone widths and clipped past the screen edge.
  // v1.1.3.5 — narrowed and balanced. The full-width row was wider
  // than the message needed; cap to a comfortable max and wrap the
  // text into two roughly equal lines via text-wrap: balance.
  restartConfirmRow: {
    flex: '0 1 auto',
    maxWidth: 'min(440px, 100%)',
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '10px 14px',
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border-bright)',
    borderRadius: 12,
    minHeight: 56,
  },
  restartConfirmText: {
    flex: 1,
    minWidth: 0,
    fontSize: 14,
    color: 'var(--text-primary)',
    textWrap: 'balance',
    lineHeight: 1.35,
  },
  restartConfirmActions: {
    display: 'flex',
    gap: 8,
    flex: '0 0 auto',
  },
  restartConfirmYes: {
    minWidth: 64,
    padding: '8px 16px',
    background: 'var(--red, #d62828)',
    color: '#ffffff',
    border: 'none',
    borderRadius: 8,
    fontSize: 13, fontWeight: 600,
    cursor: 'pointer',
  },
  restartConfirmNo: {
    minWidth: 64,
    padding: '8px 16px',
    background: 'transparent',
    color: 'var(--text-secondary)',
    border: '1px solid var(--border-bright)',
    borderRadius: 8,
    fontSize: 13, fontWeight: 600,
    cursor: 'pointer',
  },
  brandWordmark: { fontSize: 14, fontWeight: 800, letterSpacing: '-0.3px', display: 'inline-flex', marginBottom: 2 },
  brandMusic: { color: 'rgba(255,255,255,0.92)' },
  brandD: { color: '#5b7fff' },

  // Section list (#30.26). The Settings index is now a tappable
  // list of cards — each card opens its full-screen sub-page.
  sectionList: { display: 'flex', flexDirection: 'column', gap: 8 },
  sectionCard: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    width: '100%', padding: '14px 16px',
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-lg)',
    cursor: 'pointer', textAlign: 'left',
  },
  sectionCardTitle: {
    display: 'inline-flex', alignItems: 'center',
    fontSize: 14, fontWeight: 600, color: 'var(--text-primary)',
  },

  // Section sub-page (#30.26). A SectionPage occupies the full
  // Settings viewport when openSection is set. The header at the
  // top is itself a button — tapping the chevron OR the title
  // returns to the index. Slide-in animation is via CSS keyframe
  // on .settings-section-page so it kicks in once per mount.
  sectionPage: {
    animation: 'settings-slide-in 220ms ease-out',
  },
  sectionPageHeader: {
    display: 'flex', alignItems: 'center', gap: 8,
    width: '100%', padding: '4px 0 18px',
    background: 'transparent', border: 'none',
    cursor: 'pointer', textAlign: 'left',
    color: 'var(--text-primary)',
  },
  sectionPageTitle: {
    display: 'inline-flex', alignItems: 'center',
    fontSize: 18, fontWeight: 700, color: 'var(--text-primary)',
  },
  sectionPageBody: {},

  // Legacy accordion styles kept for any orphaned references; they
  // were used by the inline-accordion Section component before
  // #30.26. Safe to delete in a future cleanup.
  section: { background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', marginBottom: 8, overflow: 'hidden' },
  sectionOpen: {},
  sectionHeader: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    width: '100%', padding: '13px 16px',
    background: 'transparent', border: 'none',
    cursor: 'pointer', textAlign: 'left',
  },
  sectionTitle: { display: 'inline-flex', alignItems: 'center', fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' },
  sectionToggle: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 24, height: 24, color: 'var(--text-tertiary)',
  },
  sectionBody: { padding: '0 16px 14px', borderTop: '1px solid var(--border)' },
  sectionIcon: { width: 18, height: 18, borderRadius: 4, objectFit: 'contain', display: 'block' },
  help: { fontSize: 11, color: 'var(--text-tertiary)', marginTop: 12, lineHeight: 1.4 },
  // v52: helpRow is the host for a HelpTooltip when help text used
  // to live inline. Right-aligned with negative margin so it tucks
  // tight to the section title line above it.
  helpRow: { display: 'flex', justifyContent: 'flex-end', marginTop: -2, marginBottom: 4 },
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid var(--border)' },
  rowLabel: { fontSize: 13, color: 'var(--text-secondary)' },
  rowControl: {},
  targetRow: { display: 'flex', alignItems: 'center', gap: 10 },
  slider: { width: 120, accentColor: 'var(--accent)' },
  valLabel: { fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)', width: 60, textAlign: 'right' },
  toggle: { width: 38, height: 22, borderRadius: 11, background: 'var(--bg-overlay)', border: '1px solid var(--border)', position: 'relative', cursor: 'pointer', padding: 0 },
  toggleOn: { background: 'var(--accent)', borderColor: 'var(--accent)' },
  toggleKnob: { position: 'absolute', width: 16, height: 16, borderRadius: '50%', background: '#fff', top: 2, left: 2, transition: 'left 0.15s' },
  toggleKnobOn: { left: 19 },
  progressBlock: { marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' },
  progressTop: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6, gap: 8 },
  progressLabel: { fontSize: 11, color: 'var(--text-tertiary)' },
  progressTrack: { height: 3, background: 'var(--bg-overlay)', borderRadius: 1.5, overflow: 'hidden' },
  progressFill: { height: '100%', background: 'var(--accent)', transition: 'width 0.4s ease' },
  actionBtn: { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 10px', borderRadius: 14, fontSize: 11, color: 'var(--text-secondary)', background: 'var(--bg-overlay)', border: '1px solid var(--border)', cursor: 'pointer' },
  // v1.1.0.77 — disabled variant for "All tracks scanned" / "All
  // matched" idle states. Reads as informational rather than
  // actionable: muted text, no hover affordance, no border emphasis.
  actionBtnDisabled: {
    opacity: 0.55,
    cursor: 'default',
    color: 'var(--text-tertiary)',
  },
  // v1.1.0.78 — status line above the Rescan Unmatched button.
  // Quiet, single-line, reads as plain text rather than a banner so
  // the count is informational not alarming.
  rescanStatus: {
    marginTop: 6,
    fontSize: 12,
    color: 'var(--jp-text-2)',
    lineHeight: 1.4,
  },
  // Pill-button rows for admin actions like Rescan / Refresh artwork
  // (#30.16). Margin-top spaces them away from the section content
  // above; alignment to flex-start matches the rest of the section.
  actionRow: { display: 'flex', gap: 6, marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' },
  // v1.1.0.77 — right-aligned variant. Used on the Metadata page
  // sub-sections (Cover art, Rematch unmatched). The user asked for
  // a single consistent action edge on that page so each sub-section
  // has its action(s) on the right, matching where the buttons in
  // the Album Matching / Volume-Levelling progress blocks sit (those
  // use justifyContent: space-between which puts the buttons right).
  // Other screens (Scrobbling, Update, Library Rescan) keep the
  // original left-aligned actionRow — the user scoped this change
  // to the Metadata page specifically.
  actionRowEnd: { display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' },
  artMessage: { fontSize: 11, color: 'var(--text-tertiary)', padding: '6px 10px', marginTop: 6, background: 'var(--bg-overlay)', borderRadius: 'var(--radius-sm)' },
  // Match-error pills (#30.19) — used when the start request fails
  // (no contact set, etc) or when the running matcher logs a fault.
  matchError: { fontSize: 11, color: '#e85a7a', padding: '6px 10px', marginTop: 6, background: 'rgba(232,90,122,0.08)', border: '1px solid rgba(232,90,122,0.25)', borderRadius: 'var(--radius-sm)' },
  // Scrobble "connected as ..." badge (#30.25). Pill-shaped, green
  // dot to read as "all good, you're hooked up". Sits in the value
  // column of a Row so it lines up with the form fields above.
  connectedBadge: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '5px 10px',
    background: 'rgba(94,209,117,0.10)',
    border: '1px solid rgba(94,209,117,0.30)',
    borderRadius: 12,
    fontSize: 12,
    color: 'var(--text-primary)',
  },
  // Sub-section header (#30.19) inside the Metadata Refresh section.
  // The section already groups several related operations under one
  // accordion; this tiny header lets us divide them visually without
  // splitting into a new <Section>.
  divider: { height: 1, background: 'var(--border)' },
  subSectionTitle: { fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-secondary)', marginBottom: 6 },
  // Service health rows (#v1.1.0.24). Stacked vertically below the
  // "Built-in services" subsection title. Each row: dot + name +
  // subtitle, plus an indented error message on failure.
  healthList: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 },
  healthRow: {
    display: 'flex', flexDirection: 'column', gap: 4,
    padding: '10px 12px',
    background: 'var(--bg-overlay)', border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
  },
  healthMain: { display: 'flex', alignItems: 'center', gap: 10 },
  healthText: { flex: 1, minWidth: 0 },
  healthName: { fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' },
  healthSub: { fontSize: 10, color: 'var(--text-tertiary)', marginTop: 2 },
  // Coloured dots. ok = green, fail = red, idle = neutral grey. Width
  // and box-shadow chosen to read at small sizes on a phone.
  healthDotOk:   { width: 10, height: 10, borderRadius: '50%', flexShrink: 0, background: '#3dd066', boxShadow: '0 0 0 2px rgba(61, 208, 102, 0.18)' },
  healthDotFail: { width: 10, height: 10, borderRadius: '50%', flexShrink: 0, background: '#e85a7a', boxShadow: '0 0 0 2px rgba(232, 90, 122, 0.18)' },
  healthDotIdle: { width: 10, height: 10, borderRadius: '50%', flexShrink: 0, background: 'var(--text-tertiary)', opacity: 0.45 },
  // Error line shown only on fail. Truncated to 80 chars in JSX; the
  // full text is in the title attribute for desktop hover.
  healthError: { fontSize: 10, color: '#e85a7a', fontFamily: 'var(--font-mono)', marginLeft: 20, lineHeight: 1.4, wordBreak: 'break-word' },
  actionBtnGhost: { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 10px', borderRadius: 14, fontSize: 11, color: 'var(--text-tertiary)', background: 'transparent', border: '1px solid var(--border)', cursor: 'pointer' },
  abortBtn: { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 10px', borderRadius: 14, fontSize: 11, color: '#e85a7a', background: 'rgba(232,90,122,0.1)', border: '1px solid rgba(232,90,122,0.3)', cursor: 'pointer' },
  versionTag: { fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' },
  updateBlock: { marginTop: 12, marginBottom: 10 },
  updateBtnIdle: { width: '100%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '10px 14px', borderRadius: 8, fontSize: 13, fontWeight: 500, color: 'var(--text-secondary)', background: 'var(--bg-overlay)', border: '1px solid var(--border)', cursor: 'pointer' },
  updateBtnAvailable: { width: '100%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '12px 16px', borderRadius: 8, fontSize: 13, fontWeight: 700, color: '#fff', background: '#5b7fff', border: '1px solid #5b7fff', cursor: 'pointer', boxShadow: '0 2px 12px rgba(91,127,255,0.3)' },
  updateBtnDisabled: { width: '100%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '12px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.7)', background: 'rgba(91,127,255,0.4)', border: '1px solid rgba(91,127,255,0.4)', cursor: 'not-allowed' },
  errorMsg: { padding: '8px 10px', borderRadius: 6, background: 'rgba(232,90,122,0.1)', border: '1px solid rgba(232,90,122,0.3)', color: '#e85a7a', fontSize: 11, marginBottom: 10 },
  logToggle: { fontSize: 10, color: 'var(--text-tertiary)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0', textDecoration: 'underline', fontFamily: 'var(--font-mono)' },
  logBox: { marginTop: 6, padding: '8px 10px', background: 'rgba(0,0,0,0.5)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-secondary)', fontSize: 10, fontFamily: 'var(--font-mono)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 240, overflowY: 'auto', lineHeight: 1.4 },
  textInput: { background: 'var(--bg-overlay)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 8px', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontSize: 11, width: 180 },
  urlInput: { width: '100%', boxSizing: 'border-box', background: 'var(--bg-overlay)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontSize: 10, lineHeight: 1.4, outline: 'none' },
  link: { color: 'var(--accent)', textDecoration: 'none' },
  segControl: { display: 'flex', background: 'var(--bg-overlay)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', gap: 0 },
  segBtn: { padding: '5px 14px', fontSize: 12, fontWeight: 500, color: 'var(--text-tertiary)', background: 'transparent', border: 'none', cursor: 'pointer', borderRadius: 0 },
  segBtnActive: { background: 'var(--accent)', color: '#fff', fontWeight: 700 },
}
