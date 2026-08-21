import React, { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import { RefreshCw, LogOut, ExternalLink, Check, AlertCircle } from 'lucide-react'
import ServiceBadge from './ServiceBadge'

// Settings → Services (v1.1.33.0).
//
// Sign in to Qobuz and Tidal. Once signed in, that service's favourites
// become part of the one library — same wall, same Focus, same album
// page — and the side menu gains a row for browsing its catalogue.
//
// THE TWO SIGN-INS ARE GENUINELY DIFFERENT and are not forced into one
// shape here:
//
//   Qobuz is email + password, sent once and exchanged for a token. The
//   password is stored on the server, deliberately: Qobuz tokens go
//   inactive after a few weeks idle, and having the password is the
//   difference between the server quietly re-authenticating and the user
//   being signed out for no reason they can see. Said plainly on the
//   form rather than buried, because it is the user's call to make.
//
//   Tidal has no password to collect. It is an OAuth device-code flow:
//   ask for a code, show it with a link, and poll while the user
//   approves it on whatever device is convenient. The polling interval
//   comes from Tidal, and the poll stops on its own when the code
//   expires — a poll that runs forever against an expired code is how
//   you get rate-limited.
//
// After either, a favourites sync starts server-side. It runs in the
// background and is polled here, because a first sync of a few hundred
// albums is a few hundred sequential catalogue fetches and blocking the
// form on it would look like a hang.

const SERVICES = [
  { id: 'qobuz', label: 'Qobuz' },
  { id: 'tidal', label: 'Tidal' },
]

// Qobuz format ids, per their API. 27 is the ceiling and the default:
// this server plans its own per-renderer downsample from the source
// rate, so asking for the best available and letting that decide is how
// a hi-res album reaches a hi-res renderer intact.
const QOBUZ_FORMATS = [
  { id: 27, label: '24-bit / up to 192 kHz' },
  { id: 7,  label: '24-bit / up to 96 kHz' },
  { id: 6,  label: '16-bit / 44.1 kHz (CD)' },
  { id: 5,  label: 'MP3 320' },
]

const TIDAL_QUALITIES = [
  { id: 'HI_RES_LOSSLESS', label: 'Hi-Res lossless' },
  { id: 'LOSSLESS',        label: 'Lossless (CD)' },
  { id: 'HIGH',            label: 'High (AAC)' },
  { id: 'LOW',             label: 'Low (AAC)' },
]

export default function ServicesSection() {
  const { streamingServices, refreshStreamingServices } = useStore()
  const [busy, setBusy] = useState(null)     // service id currently working
  const [error, setError] = useState({})     // per-service error string

  useEffect(() => { refreshStreamingServices() }, [refreshStreamingServices])

  const setErr = (id, msg) => setError(prev => ({ ...prev, [id]: msg || null }))

  return (
    <div>
      <p style={s.blurb}>
        Sign in and that service's favourites join the library — the same
        album wall, the same Focus filters, the same album page. Nothing is
        kept in a separate list. Search reaches the full catalogue of
        whichever services are signed in, not just what you have already
        added.
      </p>

      {SERVICES.map(svc => (
        <ServiceCard
          key={svc.id}
          svc={svc}
          state={streamingServices?.[svc.id] || {}}
          busy={busy === svc.id}
          setBusy={setBusy}
          error={error[svc.id]}
          setErr={setErr}
          refresh={refreshStreamingServices}
        />
      ))}
    </div>
  )
}

function ServiceCard({ svc, state, busy, setBusy, error, setErr, refresh }) {
  const loggedIn = !!state.logged_in

  return (
    <div style={s.card}>
      <div style={s.cardHead}>
        <ServiceBadge service={svc.id} size={22} />
        <div style={s.cardHeadText}>
          <span style={s.cardTitle}>{svc.label}</span>
          <span style={s.cardSub}>
            {loggedIn
              ? `Signed in${state.user?.display ? ` as ${state.user.display}` : ''}`
              : 'Not signed in'}
          </span>
        </div>
        {loggedIn && <Check size={14} style={{ color: 'var(--green)', flexShrink: 0 }} />}
      </div>

      {error && (
        <div style={s.error}><AlertCircle size={12} /><span>{error}</span></div>
      )}

      {loggedIn
        ? <SignedIn svc={svc} state={state} busy={busy} setBusy={setBusy} setErr={setErr} refresh={refresh} />
        : svc.id === 'qobuz'
          ? <QobuzSignIn busy={busy} setBusy={setBusy} setErr={setErr} refresh={refresh} />
          : <TidalSignIn busy={busy} setBusy={setBusy} setErr={setErr} refresh={refresh} />}
    </div>
  )
}

// ---- Qobuz: email + password ---------------------------------------------

function QobuzSignIn({ busy, setBusy, setErr, refresh }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  const submit = async (e) => {
    e.preventDefault()
    if (!email.trim() || !password) return
    setBusy('qobuz'); setErr('qobuz', null)
    try {
      await api.post('/streaming/qobuz/login', { email: email.trim(), password })
      setPassword('')
      await refresh()
    } catch (err) {
      setErr('qobuz', err.message || 'Sign-in failed')
    } finally {
      setBusy(null)
    }
  }

  return (
    <form style={s.form} onSubmit={submit}>
      <input
        style={s.input}
        type="email"
        inputMode="email"
        autoComplete="username"
        placeholder="Qobuz email"
        value={email}
        onChange={e => setEmail(e.target.value)}
        disabled={busy}
      />
      <input
        style={s.input}
        type="password"
        autoComplete="current-password"
        placeholder="Password"
        value={password}
        onChange={e => setPassword(e.target.value)}
        disabled={busy}
      />
      <button style={s.primaryBtn} type="submit" disabled={busy || !email.trim() || !password}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
      <p style={s.note}>
        Your password is stored on this server so it can renew the Qobuz
        session on its own — their tokens go inactive after a few weeks
        idle, and without it you would be signed out for no visible reason.
        It is kept in the same database as the rest of your settings, on
        your own machine, and is never sent anywhere but Qobuz.
      </p>
    </form>
  )
}

// ---- Tidal: device code ---------------------------------------------------

function TidalSignIn({ busy, setBusy, setErr, refresh }) {
  const [code, setCode] = useState(null)     // { user_code, verification_uri, device_code, interval, expires_in }
  const [waiting, setWaiting] = useState(false)
  const pollRef = useRef(null)
  const deadlineRef = useRef(0)

  // Stop polling on unmount. Leaving an interval running against Tidal
  // after the user has navigated away is both pointless and a good way
  // to get the client id rate-limited.
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current) }, [])

  const begin = async () => {
    setBusy('tidal'); setErr('tidal', null)
    try {
      const r = await api.post('/streaming/tidal/auth/start', {})
      setCode(r)
      setWaiting(true)
      deadlineRef.current = Date.now() + (r.expires_in || 600) * 1000
      const everyMs = Math.max(2, r.interval || 2) * 1000
      pollRef.current = setInterval(async () => {
        // The code expires; stop rather than polling a dead code forever.
        if (Date.now() > deadlineRef.current) {
          clearInterval(pollRef.current); pollRef.current = null
          setWaiting(false); setCode(null)
          setErr('tidal', 'That code expired. Start again.')
          return
        }
        try {
          const p = await api.post('/streaming/tidal/auth/poll', { device_code: r.device_code })
          if (p.status === 'ok') {
            clearInterval(pollRef.current); pollRef.current = null
            setWaiting(false); setCode(null)
            await refresh()
          }
        } catch (err) {
          clearInterval(pollRef.current); pollRef.current = null
          setWaiting(false); setCode(null)
          setErr('tidal', err.message || 'Authorisation failed')
        }
      }, everyMs)
    } catch (err) {
      setErr('tidal', err.message || 'Could not start sign-in')
    } finally {
      setBusy(null)
    }
  }

  const cancel = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    setWaiting(false); setCode(null); setErr('tidal', null)
  }

  if (!code) {
    return (
      <div style={s.form}>
        <button style={s.primaryBtn} onClick={begin} disabled={busy}>
          {busy ? 'Starting…' : 'Sign in with Tidal'}
        </button>
        <p style={s.note}>
          Tidal signs in by code rather than password. You will get a short
          code to enter at their site on any device.
        </p>
      </div>
    )
  }

  return (
    <div style={s.form}>
      <div style={s.codeBox}>
        <span style={s.codeLabel}>Enter this code</span>
        <span style={s.code}>{code.user_code}</span>
      </div>
      <a
        style={s.linkBtn}
        href={code.verification_uri_complete || code.verification_uri}
        target="_blank"
        rel="noreferrer noopener">
        <ExternalLink size={12} />
        <span>{(code.verification_uri || '').replace(/^https?:\/\//, '')}</span>
      </a>
      <p style={s.note}>
        {waiting
          ? 'Waiting for you to approve it at Tidal — this page will finish on its own.'
          : 'Open the link, enter the code, and come back.'}
      </p>
      <button style={s.ghostBtn} onClick={cancel}>Cancel</button>
    </div>
  )
}

// ---- signed in ------------------------------------------------------------

function SignedIn({ svc, state, busy, setBusy, setErr, refresh }) {
  const [sync, setSync] = useState(state.sync || null)
  const pollRef = useRef(null)

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current) }, [])

  const startSync = async () => {
    setBusy(svc.id); setErr(svc.id, null)
    try {
      const r = await api.post(`/streaming/${svc.id}/favorites/sync`, {})
      setSync(r.sync)
      if (pollRef.current) clearInterval(pollRef.current)
      pollRef.current = setInterval(async () => {
        try {
          const st = await api.get(`/streaming/${svc.id}/favorites/sync/status`)
          setSync(st)
          if (!st.running) {
            clearInterval(pollRef.current); pollRef.current = null
            refresh()
          }
        } catch (err) {
          clearInterval(pollRef.current); pollRef.current = null
        }
      }, 1500)
    } catch (err) {
      setErr(svc.id, err.message || 'Sync could not start')
    } finally {
      setBusy(null)
    }
  }

  const signOut = async () => {
    setBusy(svc.id); setErr(svc.id, null)
    try {
      await api.post(`/streaming/${svc.id}/logout`, {})
      await refresh()
    } catch (err) {
      setErr(svc.id, err.message || 'Sign-out failed')
    } finally {
      setBusy(null)
    }
  }

  const changeQuality = async (value) => {
    setErr(svc.id, null)
    try {
      const body = svc.id === 'qobuz' ? { format: value } : { quality: value }
      await api.post(`/streaming/${svc.id}/settings`, body)
      await refresh()
    } catch (err) {
      setErr(svc.id, err.message || 'Could not save that')
    }
  }

  const options = svc.id === 'qobuz' ? QOBUZ_FORMATS : TIDAL_QUALITIES
  const current = svc.id === 'qobuz' ? Number(state.format ?? 27) : (state.quality || 'LOSSLESS')

  return (
    <div style={s.form}>
      <div style={s.rowLabel}>Stream quality</div>
      <div style={s.optionList}>
        {options.map(opt => (
          <button
            key={opt.id}
            style={{ ...s.option, ...(opt.id === current ? s.optionOn : {}) }}
            onClick={() => changeQuality(opt.id)}>
            <span>{opt.label}</span>
            {opt.id === current && <Check size={12} />}
          </button>
        ))}
      </div>
      <p style={s.note}>
        What to ask {svc.label} for. Anything a renderer cannot take is
        converted for that zone only, so picking the highest costs the
        others nothing.
      </p>

      <div style={s.rowLabel}>Favourites</div>
      <p style={s.note}>
        Your {svc.label} favourites are the part that appears in the library.
        They reconcile once a day and whenever you sign in; sync now if you
        have just added something in the {svc.label} app.
      </p>
      {sync && sync.running && (
        <div style={s.progress}>
          Syncing {sync.processed}/{sync.total || '…'}
          {sync.added ? ` · ${sync.added} in library` : ''}
        </div>
      )}
      {sync && !sync.running && sync.finishedAt && (
        <div style={s.progress}>
          Last sync: {sync.added} in library, {sync.removed} removed
          {sync.errors ? `, ${sync.errors} failed` : ''}
        </div>
      )}
      <div style={s.btnRow}>
        <button style={s.actionBtn} onClick={startSync} disabled={busy || (sync && sync.running)}>
          <RefreshCw size={11} style={(sync && sync.running) ? { animation: 'spin 1s linear infinite' } : {}} />
          <span>{(sync && sync.running) ? 'Syncing…' : 'Sync favourites'}</span>
        </button>
        <button style={s.dangerBtn} onClick={signOut} disabled={busy}>
          <LogOut size={11} /><span>Sign out</span>
        </button>
      </div>
      <p style={s.note}>
        Signing out removes {svc.label} albums from the library — leaving
        them would put things in the wall that cannot play. Nothing is
        deleted at {svc.label}, and signing back in restores them.
      </p>
    </div>
  )
}

const s = {
  blurb: { fontSize: 12, lineHeight: 1.6, color: 'var(--jp-text-2)', margin: '0 0 18px' },
  card: {
    border: '1px solid var(--jp-border)', borderRadius: 8,
    padding: 14, marginBottom: 14, background: 'transparent',
  },
  cardHead: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 },
  cardHeadText: { flex: 1, display: 'flex', flexDirection: 'column', gap: 2, overflow: 'hidden' },
  cardTitle: { fontSize: 14, fontWeight: 600, color: 'var(--jp-text)' },
  cardSub: { fontSize: 11, color: 'var(--jp-text-3)', fontFamily: 'var(--font-mono)' },
  form: { display: 'flex', flexDirection: 'column', gap: 10 },
  input: {
    width: '100%', padding: '10px 12px', borderRadius: 6, fontSize: 13,
    background: 'var(--jp-bg-surface)', color: 'var(--jp-text)',
    border: '1px solid var(--jp-border)', outline: 'none',
  },
  primaryBtn: {
    padding: '10px 14px', borderRadius: 6, fontSize: 13, fontWeight: 600,
    background: 'rgba(var(--tint-rgb), 0.14)', color: 'var(--jp-text)',
    border: '1px solid var(--jp-border)', cursor: 'pointer',
  },
  ghostBtn: {
    padding: '8px 12px', borderRadius: 6, fontSize: 12,
    background: 'transparent', color: 'var(--jp-text-2)',
    border: '1px solid var(--jp-border)', cursor: 'pointer',
  },
  linkBtn: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    padding: '10px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600,
    background: 'transparent', color: 'var(--jp-text)',
    border: '1px solid var(--jp-border)', textDecoration: 'none',
  },
  codeBox: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
    padding: '16px 12px', borderRadius: 8,
    background: 'var(--jp-bg-surface)', border: '1px solid var(--jp-border)',
  },
  codeLabel: {
    fontSize: 10, letterSpacing: '0.10em', textTransform: 'uppercase',
    color: 'var(--jp-text-3)', fontWeight: 600,
  },
  code: {
    fontSize: 26, fontWeight: 700, letterSpacing: '0.18em',
    fontFamily: 'var(--font-mono)', color: 'var(--jp-text)',
  },
  note: { fontSize: 11, lineHeight: 1.6, color: 'var(--jp-text-3)', margin: 0 },
  rowLabel: {
    fontSize: 10, fontWeight: 600, letterSpacing: '0.10em',
    textTransform: 'uppercase', color: 'var(--jp-text-3)', marginTop: 6,
  },
  optionList: { display: 'flex', flexDirection: 'column', gap: 6 },
  option: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '9px 12px', borderRadius: 6, fontSize: 12,
    background: 'transparent', color: 'var(--jp-text-2)',
    border: '1px solid var(--jp-border)', cursor: 'pointer', textAlign: 'left',
  },
  optionOn: { background: 'rgba(var(--tint-rgb), 0.08)', color: 'var(--jp-text)' },
  btnRow: { display: 'flex', gap: 8, flexWrap: 'wrap' },
  actionBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '8px 12px', borderRadius: 6, fontSize: 12,
    background: 'transparent', color: 'var(--jp-text-2)',
    border: '1px solid var(--jp-border)', cursor: 'pointer',
  },
  dangerBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '8px 12px', borderRadius: 6, fontSize: 12,
    background: 'transparent', color: 'var(--jp-hot)',
    border: '1px solid var(--jp-border)', cursor: 'pointer',
  },
  progress: {
    fontSize: 11, color: 'var(--jp-text-2)', fontFamily: 'var(--font-mono)',
    padding: '8px 10px', borderRadius: 6, background: 'var(--jp-bg-surface)',
  },
  error: {
    display: 'flex', alignItems: 'center', gap: 6,
    fontSize: 11, color: 'var(--jp-hot)', marginBottom: 10,
    padding: '8px 10px', borderRadius: 6,
    background: 'rgba(255,90,90,0.08)',
  },
}
