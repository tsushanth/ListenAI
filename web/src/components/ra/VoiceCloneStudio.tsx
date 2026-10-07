'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Loader2, Mic, Square, Trash2, Upload } from 'lucide-react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabaseClient'
import { voiceCloneApi, CloneApiError, type ClonedVoice, type ConsentChallenge } from '@/lib/voiceCloneApi'
import {
  LANGUAGES, LIMITS, SAMPLE_SENTENCES, checkDuration, formatClock, secondsLeft, mapCloneError,
  type CloneFlow, type MappedError,
} from '@/lib/voiceCloneErrors'
import { useAudioRecorder, type Recording } from './useAudioRecorder'

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

const field = { width: '100%', padding: '11px 13px', border: '1.5px solid var(--line)', borderRadius: 10, font: 'inherit', background: '#fff', color: 'var(--ink)' } as const

function toMapped(e: unknown): MappedError {
  if (e instanceof CloneApiError) return e.mapped
  return mapCloneError(0, null)
}

function ErrorBox({ err, onDismiss }: { err: MappedError | null; onDismiss?: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { if (err) ref.current?.focus() }, [err])
  // The live region itself stays mounted so screen readers announce content changes.
  return (
    <div role="alert" aria-live="assertive" ref={ref} tabIndex={-1} style={{ outline: 'none' }}>
      {err && (
        <div style={{ border: '1.5px solid #B3261E', background: '#FCE8E6', borderRadius: 12, padding: '14px 16px', margin: '16px 0' }}>
          <strong className="ra-err" style={{ display: 'block', fontSize: '1rem' }}>{err.title}</strong>
          <p style={{ margin: '6px 0 0' }}>{err.message}</p>
          {err.failures && err.failures.length > 0 && (
            <ul style={{ margin: '10px 0 0', paddingLeft: 20 }}>
              {err.failures.map((f) => <li key={f.code}>{f.advice}</li>)}
            </ul>
          )}
          {err.code === 'payment_required' && <p style={{ margin: '8px 0 0' }}><Link href="/#pricing" style={{ textDecoration: 'underline' }}>See pricing</Link></p>}
          {onDismiss && <button type="button" className="ra-btn ghost" style={{ marginTop: 10, padding: '6px 14px' }} onClick={onDismiss}>Dismiss</button>}
        </div>
      )}
    </div>
  )
}

function Meter({ level, active }: { level: number; active: boolean }) {
  // Cosmetic; the elapsed timer next to it carries the accessible information.
  const pct = Math.min(100, Math.round(Math.sqrt(level) * 100))
  return (
    <div aria-hidden="true" style={{ height: 10, borderRadius: 6, background: 'var(--panel)', border: '1px solid var(--line)', overflow: 'hidden', flex: 1, minWidth: 120 }}>
      <div style={{ height: '100%', width: `${active ? pct : 0}%`, background: pct > 92 ? '#B3261E' : 'var(--sun)', transition: 'width 60ms linear' }} />
    </div>
  )
}

interface Clip { blob: Blob; url: string; seconds: number | null; source: 'recorded' | 'upload' }

function probeDuration(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    const a = new Audio()
    const done = (v: number | null) => { a.removeAttribute('src'); resolve(v) }
    a.preload = 'metadata'
    a.onloadedmetadata = () => done(Number.isFinite(a.duration) && a.duration > 0 ? a.duration : null)
    a.onerror = () => done(null)
    setTimeout(() => done(null), 5000)
    a.src = url
  })
}

/** Record-or-upload control for one clip. Remount it (change `key`) to clear it. */
function ClipInput({ id, label, minSec, maxSec, allowUpload, value, onChange, hint }: {
  id: string; label: string; minSec: number; maxSec: number; allowUpload: boolean
  value: Clip | null; onChange: (c: Clip | null) => void; hint?: string
}) {
  const r = useAudioRecorder(maxSec)
  const [uploadErr, setUploadErr] = useState<string | null>(null)
  const [probing, setProbing] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const pushRecording = useCallback((rec: Recording | null) => {
    onChange(rec ? { blob: rec.blob, url: rec.url, seconds: rec.seconds, source: 'recorded' } : null)
  }, [onChange])
  // Report a finished recording upward exactly once per take.
  const lastUrl = useRef<string | null>(null)
  useEffect(() => {
    if (r.recording && r.recording.url !== lastUrl.current) { lastUrl.current = r.recording.url; pushRecording(r.recording) }
  }, [r.recording, pushRecording])

  const live = r.state === 'recording' ? r.elapsed : value?.seconds ?? 0
  const liveCheck = value?.seconds != null ? checkDuration(value.seconds, minSec, maxSec, 'recording') : null
  const progressPct = Math.min(100, (live / maxSec) * 100)
  const minPct = (minSec / maxSec) * 100

  const onFile = async (f: File | undefined) => {
    setUploadErr(null)
    if (!f) return
    if (f.size > LIMITS.maxUploadBytes) { setUploadErr(`That file is ${(f.size / 1048576).toFixed(1)} MB. The maximum is 25 MB.`); return }
    if (!/^audio\//.test(f.type) && !/\.(wav|flac|ogg|mp3|m4a|webm)$/i.test(f.name)) { setUploadErr('Use a WAV, FLAC, OGG, MP3, M4A or WebM audio file.'); return }
    r.reset(); lastUrl.current = null
    setProbing(true)
    const url = URL.createObjectURL(f)
    const seconds = await probeDuration(url)
    setProbing(false)
    onChange({ blob: f, url, seconds, source: 'upload' })
  }

  const discard = () => { r.reset(); lastUrl.current = null; if (fileRef.current) fileRef.current.value = ''; onChange(null) }

  return (
    <div>
      <p id={`${id}-label`} style={{ fontWeight: 600, marginBottom: 4 }}>{label}</p>
      {hint && <p className="ra-small" style={{ marginBottom: 10 }}>{hint}</p>}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }} role="group" aria-labelledby={`${id}-label`}>
        {r.state !== 'recording' ? (
          <button type="button" className="ra-btn solid" onClick={() => { onChange(null); lastUrl.current = null; r.start() }} disabled={r.state === 'requesting'}>
            {r.state === 'requesting' ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Mic size={16} aria-hidden="true" />}
            {value ? 'Re-record' : 'Record'}
          </button>
        ) : (
          <button type="button" className="ra-btn solid" onClick={r.stop} style={{ background: '#B3261E', borderColor: '#B3261E' }}>
            <Square size={16} aria-hidden="true" /> Stop
          </button>
        )}
        {allowUpload && r.state !== 'recording' && (
          <>
            <input id={`${id}-file`} ref={fileRef} type="file" accept="audio/*,.wav,.flac,.ogg,.mp3,.m4a,.webm" onChange={(e) => onFile(e.target.files?.[0])} style={{ position: 'absolute', width: 1, height: 1, opacity: 0, overflow: 'hidden' }} />
            <label htmlFor={`${id}-file`} className="ra-btn ghost" style={{ cursor: 'pointer' }}>
              <Upload size={16} aria-hidden="true" /> Upload a file
            </label>
          </>
        )}
        {value && r.state !== 'recording' && (
          <button type="button" className="ra-btn ghost" onClick={discard}>Discard</button>
        )}
        <Meter level={r.level} active={r.state === 'recording'} />
        <span aria-live="off" style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600, minWidth: 90 }}>
          {r.state === 'recording' ? 'Recording ' : ''}{formatClock(live)} / {formatClock(maxSec)}
        </span>
      </div>
      {/* Duration bar: tick marks the minimum */}
      <div aria-hidden="true" style={{ position: 'relative', height: 6, marginTop: 10, background: 'var(--panel)', borderRadius: 4 }}>
        <div style={{ height: '100%', width: `${progressPct}%`, background: live >= minSec ? '#2E7D32' : 'var(--sun)', borderRadius: 4 }} />
        <div style={{ position: 'absolute', left: `${minPct}%`, top: -3, bottom: -3, width: 2, background: 'var(--ink)' }} />
      </div>
      <p className="ra-small" style={{ marginTop: 6 }}>
        Required length: {minSec} to {maxSec} seconds.{r.state === 'recording' && live < minSec ? ` Keep going: ${Math.ceil(minSec - live)} s more.` : ''}
        {r.state === 'recording' ? ` Recording stops automatically at ${maxSec} s.` : ''}
      </p>
      <div aria-live="polite">
        {probing && <p className="ra-small">Reading the file length...</p>}
        {value && r.state !== 'recording' && (
          <div style={{ marginTop: 8 }}>
            <audio controls src={value.url} style={{ width: '100%', maxWidth: 420 }} aria-label={`${label} preview`} />
            <p className="ra-small">
              {value.source === 'upload' ? 'Uploaded file' : 'Recorded'}: {value.seconds != null ? `${value.seconds.toFixed(1)} s` : 'length unknown (the server will check it)'}
            </p>
            {liveCheck && !liveCheck.ok && <p className="ra-err" role="alert">{liveCheck.message} Record again{allowUpload ? ' or upload a different file' : ''}.</p>}
          </div>
        )}
        {(r.error || uploadErr) && <p className="ra-err" role="alert">{r.error || uploadErr}</p>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sign in gate (same Supabase project and methods as /developers: email+password and Google)
// ---------------------------------------------------------------------------

function SignInGate() {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true); setError(null); setNotice(null)
    try {
      if (mode === 'signup') {
        const { data, error: err } = await supabase.auth.signUp({ email, password })
        if (err) throw err
        if (!data.session) { setNotice('Check your email to confirm your account, then sign in here. Voice cloning requires a verified email.'); setMode('signin') }
      } else {
        const { error: err } = await supabase.auth.signInWithPassword({ email, password })
        if (err) throw err
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed')
    } finally { setBusy(false) }
  }

  const google = async () => {
    setError(null); setBusy(true)
    const { error: err } = await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: `${window.location.origin}/clone-voice` } })
    if (err) { setError(err.message); setBusy(false) }
  }

  return (
    <div className="ra-vs-card" style={{ maxWidth: 460 }}>
      <h2 style={{ fontSize: '1.4rem' }}>{mode === 'signin' ? 'Sign in to clone your voice' : 'Create an account'}</h2>
      <p className="ra-lede" style={{ fontSize: '1rem', marginBottom: 12 }}>Voice cloning is tied to your account: it needs a verified email and a paid or comped plan. Use the same account as your API keys.</p>
      <form onSubmit={submit} className="ra-vs-form">
        <label>Email
          <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>Password
          <input type="password" required minLength={mode === 'signup' ? 8 : undefined} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {notice && <p role="status">{notice}</p>}
        {error && <p className="ra-err" role="alert">{error}</p>}
        <button className="ra-btn solid" type="submit" disabled={busy}>{busy ? 'Working...' : mode === 'signin' ? 'Sign in' : 'Create account'}</button>
        <button className="ra-btn ghost" type="button" onClick={google} disabled={busy}>Continue with Google</button>
      </form>
      <p style={{ marginTop: 14, fontSize: '.9rem' }}>
        {mode === 'signin'
          ? <>No account? <button type="button" onClick={() => setMode('signup')} style={{ textDecoration: 'underline', background: 'none', border: 0, cursor: 'pointer', font: 'inherit' }}>Create one</button>. Forgotten password? Use the reset link on the <Link href="/developers#get-started" style={{ textDecoration: 'underline' }}>developer page</Link>.</>
          : <>Have an account? <button type="button" onClick={() => setMode('signin')} style={{ textDecoration: 'underline', background: 'none', border: 0, cursor: 'pointer', font: 'inherit' }}>Sign in</button></>}
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Try your voice
// ---------------------------------------------------------------------------

function TryPanel({ voices, selectedId, onSelect }: { voices: ClonedVoice[]; selectedId: string; onSelect: (id: string) => void }) {
  const active = voices.filter((v) => v.status === 'active')
  const [text, setText] = useState('')
  const [speed, setSpeed] = useState(1)
  const [busy, setBusy] = useState(false)
  const [waited, setWaited] = useState(0)
  const [err, setErr] = useState<MappedError | null>(null)
  const [out, setOut] = useState<{ url: string; bytes: number } | null>(null)
  const prev = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  const abort = useRef<AbortController | null>(null)

  useEffect(() => () => { if (prev.current) URL.revokeObjectURL(prev.current); if (timer.current) clearInterval(timer.current); abort.current?.abort() }, [])

  const run = async () => {
    if (!selectedId || !text.trim()) return
    setErr(null); setBusy(true); setWaited(0)
    timer.current = setInterval(() => setWaited((w) => w + 1), 1000)
    abort.current = new AbortController()
    try {
      const r = await voiceCloneApi.synthesize({ text: text.trim(), voiceId: selectedId, speed }, abort.current.signal)
      if (prev.current) URL.revokeObjectURL(prev.current)
      prev.current = r.url
      setOut(r)
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError') setErr(toMapped(e))
    } finally {
      if (timer.current) clearInterval(timer.current)
      setBusy(false)
    }
  }

  const over = text.length > LIMITS.maxTextChars
  return (
    <section className="ra-vs-card" aria-labelledby="try-h" style={{ marginTop: 28 }}>
      <h2 id="try-h" style={{ fontSize: '1.4rem' }}>Try your voice</h2>
      {active.length === 0 ? <p>You have no active voices yet. Create one above.</p> : (
        <div className="ra-vs-form">
          <label>Voice
            <select value={selectedId} onChange={(e) => onSelect(e.target.value)} style={field}>
              {active.map((v) => <option key={v.id} value={v.id}>{v.name} ({v.language})</option>)}
            </select>
          </label>
          <label htmlFor="try-text">Text to speak</label>
          <textarea id="try-text" value={text} onChange={(e) => setText(e.target.value)} rows={5} aria-describedby="try-count" style={{ ...field, resize: 'vertical' }} />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span id="try-count" className={over ? 'ra-err' : 'ra-small'} style={{ marginRight: 'auto' }}>{text.length} / {LIMITS.maxTextChars} characters</span>
            <button type="button" className="ra-chip" onClick={() => setText(SAMPLE_SENTENCES.en)}>English sample</button>
            <button type="button" className="ra-chip" onClick={() => setText(SAMPLE_SENTENCES.es)}>Spanish sample</button>
          </div>
          <label>Speed: {speed.toFixed(2)}x
            <input type="range" min={LIMITS.speedMin} max={LIMITS.speedMax} step={0.05} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} style={{ padding: 0 }} />
          </label>
          <p className="ra-small">The language of the text should match the language you chose when you created the voice. The first request after a quiet period can take up to 3 minutes while the GPU starts; later ones are quicker. Everything generated carries an inaudible watermark.</p>
          <button type="button" className="ra-btn solid" onClick={run} disabled={busy || !text.trim() || over || !selectedId}>
            {busy ? <><Loader2 size={16} className="animate-spin" aria-hidden="true" /> Generating... {waited}s</> : 'Generate speech'}
          </button>
          <div role="status" aria-live="polite" className="ra-small">{busy && waited > 20 ? 'Still working. This is normal on a cold start (up to 3 minutes). Keep this tab open.' : ''}</div>
          <ErrorBox err={err} onDismiss={() => setErr(null)} />
          {out && (
            <div>
              <audio controls autoPlay src={out.url} style={{ width: '100%' }} aria-label="Generated speech" />
              <p style={{ marginTop: 8 }}><a href={out.url} download="my-cloned-voice.wav" style={{ textDecoration: 'underline' }}>Download WAV</a> <span className="ra-small">({(out.bytes / 1024).toFixed(0)} KB)</span></p>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Create wizard
// ---------------------------------------------------------------------------

type Step = 1 | 2 | 3

function Wizard({ onCreated, onAuthLost }: { onCreated: (v: ClonedVoice) => void; onAuthLost: () => void }) {
  const [step, setStep] = useState<Step>(1)
  const [name, setName] = useState('My voice')
  const [language, setLanguage] = useState('en')
  const [own, setOwn] = useState(false)
  const [challenge, setChallenge] = useState<ConsentChallenge | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [consent, setConsent] = useState<Clip | null>(null)
  const [reference, setReference] = useState<Clip | null>(null)
  const [consentKey, setConsentKey] = useState(0)
  const [refKey, setRefKey] = useState(0)
  const [busy, setBusy] = useState<'challenge' | 'create' | null>(null)
  const [err, setErr] = useState<MappedError | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const stepHeading = useRef<HTMLHeadingElement>(null)
  // null while GET /config is in flight. Anything but an explicit consent_required:false resolves to 'strict'.
  const [flow, setFlow] = useState<CloneFlow | null>(null)
  useEffect(() => { let live = true; voiceCloneApi.flow().then((f) => { if (live) setFlow(f) }); return () => { live = false } }, [])
  const attest = flow === 'attest'
  const refStep: Step = attest ? 2 : 3

  useEffect(() => { stepHeading.current?.focus() }, [step])

  const left = challenge ? secondsLeft(challenge.expires_at, now) : 0
  const expired = !!challenge && left === 0
  useEffect(() => {
    if (!challenge) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [challenge])
  // When the phrase expires, the consent recording is no longer usable.
  useEffect(() => {
    if (expired && consent) { setConsent(null); setConsentKey((k) => k + 1); setInfo('The phrase expired, so the consent recording was discarded. Get a new phrase and record it again.') }
  }, [expired, consent])

  const handleError = (e: unknown) => {
    const m = toMapped(e)
    setErr(m)
    setInfo(null)
    switch (m.recovery) {
      case 'sign_in': onAuthLost(); break
      case 'new_challenge': setChallenge(null); setConsent(null); setConsentKey((k) => k + 1); setStep(2); break
      case 'rerecord_consent': setConsent(null); setConsentKey((k) => k + 1); setStep(2); break
      case 'fix_consent': setConsent(null); setConsentKey((k) => k + 1); setStep(2); break
      case 'fix_reference': setReference(null); setRefKey((k) => k + 1); setStep(refStep); break
      default: break
    }
  }

  const getChallenge = async () => {
    setErr(null); setInfo(null); setBusy('challenge')
    try {
      const c = await voiceCloneApi.challenge()
      setChallenge(c); setNow(Date.now()); setConsent(null); setConsentKey((k) => k + 1)
    } catch (e) { handleError(e) } finally { setBusy(null) }
  }

  const consentCheck = consent?.seconds != null ? checkDuration(consent.seconds, LIMITS.consentMinSec, LIMITS.consentMaxSec, 'consent recording') : null
  const consentOk = !!consent && !!challenge && !expired && (consentCheck?.ok ?? true)
  const refCheck = reference?.seconds != null ? checkDuration(reference.seconds, LIMITS.referenceMinSec, LIMITS.referenceMaxSec, 'reference') : null
  const refOk = !!reference && (refCheck?.ok ?? true)

  const submit = async () => {
    if (!reference) return
    if (attest ? !own : !challenge || !consent) return
    setErr(null); setInfo(null); setBusy('create')
    try {
      const v = attest
        ? await voiceCloneApi.createAttested({ name: name.trim() || 'My voice', language, reference: reference.blob })
        : await voiceCloneApi.create({ challengeId: challenge!.challenge_id, name: name.trim() || 'My voice', language, consent: consent!.blob, reference: reference.blob })
      onCreated(v)
      setStep(1); setChallenge(null); setConsent(null); setReference(null); setConsentKey((k) => k + 1); setRefKey((k) => k + 1); setOwn(false)
      setInfo(`Voice "${v.name}" is ready. Try it below.`)
    } catch (e) { handleError(e) } finally { setBusy(null) }
  }

  const stepItem = (n: Step, label: string) => (
    <li className={step === n ? 'now' : step > n ? 'done' : ''} aria-current={step === n ? 'step' : undefined}><span>{n}</span>{label}</li>
  )

  return (
    <section className="ra-vs-card" aria-labelledby="wiz-h">
      <h2 id="wiz-h" style={{ fontSize: '1.4rem' }}>Create a voice from your own recording</h2>
      {flow === null && <p role="status" style={{ marginTop: 14 }}><Loader2 size={16} className="animate-spin" aria-label="Loading" /></p>}
      {flow !== null && (
      <>
      <ol className="ra-vs-steps" style={{ marginTop: 14 }}>
        {attest
          ? <>{stepItem(1, 'Name, language and confirmation')}{stepItem(2, 'Reference recording')}</>
          : <>{stepItem(1, 'Name and language')}{stepItem(2, 'Say the consent phrase')}{stepItem(3, 'Reference recording')}</>}
      </ol>

      <div role="status" aria-live="polite">{info && <p style={{ background: '#E4F5E8', borderRadius: 10, padding: '10px 14px' }}>{info}</p>}</div>
      <ErrorBox err={err} onDismiss={() => setErr(null)} />

      {step === 1 && (
        <div>
          <h3 ref={stepHeading} tabIndex={-1} style={{ marginTop: 0, outline: 'none' }}>Step 1: name and language</h3>
          <div className="ra-vs-form two">
            <label>Voice name
              <input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
            </label>
            <label>Language you will speak
              <select value={language} onChange={(e) => setLanguage(e.target.value)} style={field}>
                {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
              </select>
            </label>
          </div>
          {attest ? (
          <div className="ra-vs-consent">
            <p style={{ margin: 0 }}><strong>Your own voice only.</strong> You may only clone your own voice. Cloning someone else&apos;s voice, even with a file they gave you, is not allowed.</p>
            <p className="ra-small" style={{ margin: 0 }}>
              What we keep: we keep a record that you confirmed the voice is yours. The reference recording is kept only while the voice exists and is never used for training. Generated audio carries an inaudible watermark, and you can delete your voice at any time. Details in the <Link href="/privacy" style={{ textDecoration: 'underline' }}>privacy policy</Link>. Your voice recording may count as biometric data under some laws.
            </p>
            <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontWeight: 400 }}>
              <input type="checkbox" checked={own} onChange={(e) => setOwn(e.target.checked)} style={{ width: 20, height: 20, marginTop: 2 }} />
              <span>This is my own voice, and I agree ReadAloud may create a synthetic copy of it.</span>
            </label>
          </div>
          ) : (
          <div className="ra-vs-consent">
              <p style={{ margin: 0 }}><strong>Your own voice only.</strong> You may only clone your own voice. Cloning someone else&apos;s voice, even with a file they gave you, is not allowed and is blocked by the next step: you must read a random phrase aloud, live, in this browser, and it has to sound like the reference.</p>
              <p className="ra-small" style={{ margin: 0 }}>
                What we keep: the consent recording is stored with its transcript, date and similarity score as evidence of your consent, for as long as the voice exists and 12 months after you delete it. The reference recording is kept only while the voice exists and is never used for training. Generated audio carries an inaudible watermark. Details in the <Link href="/privacy" style={{ textDecoration: 'underline' }}>privacy policy</Link>. Your voice recording may count as biometric data under some laws.
              </p>
              <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontWeight: 400 }}>
                <input type="checkbox" checked={own} onChange={(e) => setOwn(e.target.checked)} style={{ width: 20, height: 20, marginTop: 2 }} />
                <span>This is my own voice, and I will record the consent phrase myself, right now. I understand the consent recording is stored as described.</span>
              </label>
            </div>
          )}
          <button type="button" className="ra-btn solid" style={{ marginTop: 18 }} disabled={!own || !name.trim()} onClick={() => { setErr(null); setInfo(null); setStep(2) }}>Continue</button>
        </div>
      )}

      {step === 2 && !attest && (
        <div>
          <h3 ref={stepHeading} tabIndex={-1} style={{ marginTop: 0, outline: 'none' }}>Step 2: say the consent phrase</h3>
          <p className="ra-small" style={{ marginBottom: 10 }}>The consent recording must be recorded live in this browser. Uploading a file is not possible here: that is what stops someone from using a recording of another person. Read the phrase exactly as shown, including the code words, in a quiet room, with the same microphone you will use for the reference.</p>
          {!challenge ? (
            <button type="button" className="ra-btn solid" onClick={getChallenge} disabled={busy === 'challenge'}>
              {busy === 'challenge' && <Loader2 size={16} className="animate-spin" aria-hidden="true" />} Get my phrase
            </button>
          ) : (
            <>
              <blockquote style={{ margin: '8px 0 12px', padding: '14px 18px', borderLeft: '4px solid var(--sun)', background: 'var(--panel)', fontSize: '1.2rem', fontWeight: 600 }} aria-label="Phrase to read aloud">{challenge.phrase}</blockquote>
              <p style={{ margin: '0 0 14px' }} className={left <= 60 ? 'ra-err' : undefined}>
                {expired ? 'This phrase has expired.' : <>Time left on this phrase: <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{formatClock(left)}</strong> (valid for 5 minutes, single use, 3 attempts)</>}
                {' '}<button type="button" onClick={getChallenge} disabled={busy === 'challenge'} style={{ textDecoration: 'underline', background: 'none', border: 0, cursor: 'pointer', font: 'inherit' }}>Get a new phrase</button>
              </p>
              {!expired && (
                <ClipInput key={consentKey} id="consent" label="Record the phrase" minSec={LIMITS.consentMinSec} maxSec={LIMITS.consentMaxSec} allowUpload={false} value={consent} onChange={setConsent} />
              )}
            </>
          )}
          <div style={{ display: 'flex', gap: 12, marginTop: 20, flexWrap: 'wrap' }}>
            <button type="button" className="ra-btn ghost" onClick={() => setStep(1)}>Back</button>
            <button type="button" className="ra-btn solid" disabled={!consentOk} onClick={() => { setErr(null); setStep(3) }}>Continue</button>
          </div>
        </div>
      )}

      {step === refStep && (
        <div>
          <h3 ref={stepHeading} tabIndex={-1} style={{ marginTop: 0, outline: 'none' }}>Step {refStep}: reference recording</h3>
          <p className="ra-small" style={{ marginBottom: 10 }}>Record yourself talking naturally, or upload a clean recording of your voice. {LIMITS.referenceMinSec} to {LIMITS.referenceMaxSec} seconds; 30 to 60 seconds of continuous speech works best. Quiet room, no music, no other voices, not too loud.</p>
          <ClipInput key={refKey} id="reference" label="Reference recording" minSec={LIMITS.referenceMinSec} maxSec={LIMITS.referenceMaxSec} allowUpload value={reference} onChange={setReference} />
          {!attest && challenge && (
            <p className={left <= 60 ? 'ra-err' : 'ra-small'} style={{ marginTop: 14 }}>
              {expired ? 'Your consent phrase expired. Go back, get a new phrase and record it again; your reference is kept.' : `Consent phrase valid for ${formatClock(left)} more.`}
            </p>
          )}
          <div style={{ display: 'flex', gap: 12, marginTop: 20, flexWrap: 'wrap' }}>
            <button type="button" className="ra-btn ghost" onClick={() => setStep((refStep - 1) as Step)} disabled={busy === 'create'}>Back</button>
            <button type="button" className="ra-btn solid" disabled={!refOk || (attest ? !own : !consentOk) || busy === 'create'} onClick={submit}>
              {busy === 'create' ? <><Loader2 size={16} className="animate-spin" aria-hidden="true" /> Checking and creating...</> : 'Create my voice'}
            </button>
          </div>
          {busy === 'create' && <p className="ra-small" role="status" style={{ marginTop: 10 }}>This can take up to 3 minutes the first time while the GPU starts. Keep this tab open.</p>}
          {!attest && !consentOk && !expired && <p className="ra-small" style={{ marginTop: 8 }}>The consent recording is missing. Go back to step 2.</p>}
        </div>
      )}
      </>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Voice list
// ---------------------------------------------------------------------------

function VoiceList({ voices, loading, onDelete, err }: { voices: ClonedVoice[]; loading: boolean; onDelete: (v: ClonedVoice) => Promise<void>; err: MappedError | null }) {
  const [deleting, setDeleting] = useState<string | null>(null)
  return (
    <section className="ra-vs-card" aria-labelledby="list-h" style={{ marginTop: 28 }}>
      <h2 id="list-h" style={{ fontSize: '1.4rem' }}>Your voices</h2>
      <ErrorBox err={err} />
      {loading ? <p><Loader2 size={16} className="animate-spin" aria-label="Loading voices" /></p>
        : voices.length === 0 ? <p>No voices yet.</p> : (
          <ul className="ra-vs-list">
            {voices.map((v) => (
              <li key={v.id} className="ra-vs-row" style={{ cursor: 'default' }}>
                <div>{v.name}<small>{LANGUAGES.find((l) => l.code === v.language)?.label ?? v.language} · created {new Date(v.created_at).toLocaleDateString()}</small></div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <span className={`ra-vs-pill ${v.status === 'active' ? 'deployed' : 'rejected'}`}>{v.status}</span>
                  <button type="button" className="ra-btn ghost" style={{ padding: '6px 12px' }} disabled={deleting === v.id} aria-label={`Delete voice ${v.name}`}
                    onClick={async () => {
                      if (!window.confirm(`Delete "${v.name}"? Its reference audio and voice data are removed. Audio you already generated is not recalled, and the record of your confirmation or consent is kept as described in the privacy policy. This cannot be undone.`)) return
                      setDeleting(v.id); try { await onDelete(v) } finally { setDeleting(null) }
                    }}>
                    {deleting === v.id ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Trash2 size={14} aria-hidden="true" />} Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      <p className="ra-small" style={{ marginTop: 12 }}>Deleted voices still count toward your daily creation limit.</p>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Page body
// ---------------------------------------------------------------------------

export default function VoiceCloneStudio() {
  const [session, setSession] = useState<Session | null>(null)
  const [ready, setReady] = useState(false)
  const [voices, setVoices] = useState<ClonedVoice[]>([])
  const [loading, setLoading] = useState(false)
  const [listErr, setListErr] = useState<MappedError | null>(null)
  const [selected, setSelected] = useState('')

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true) })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true); setListErr(null)
    try {
      const vs = await voiceCloneApi.list()
      setVoices(vs)
      setSelected((cur) => (vs.some((v) => v.id === cur && v.status === 'active') ? cur : vs.find((v) => v.status === 'active')?.id ?? ''))
    } catch (e) { setListErr(toMapped(e)) } finally { setLoading(false) }
  }, [])

  useEffect(() => { if (session) refresh(); else setVoices([]) }, [session, refresh])

  if (!ready) return <p><Loader2 size={18} className="animate-spin" aria-label="Loading" /></p>
  if (!session) return <SignInGate />

  return (
    <div style={{ maxWidth: 820 }}>
      <p className="ra-vs-user" style={{ marginBottom: 0 }}>
        <span>Signed in as {session.user.email}</span>
        <button type="button" onClick={() => supabase.auth.signOut()} style={{ textDecoration: 'underline', background: 'none', border: 0, cursor: 'pointer', font: 'inherit' }}>Sign out</button>
      </p>
      <Wizard
        onAuthLost={() => supabase.auth.signOut()}
        onCreated={(v) => { setVoices((cur) => [v, ...cur.filter((x) => x.id !== v.id)]); setSelected(v.id); refresh() }}
      />
      <TryPanel voices={voices} selectedId={selected} onSelect={setSelected} />
      <VoiceList
        voices={voices} loading={loading} err={listErr}
        onDelete={async (v) => {
          setListErr(null)
          try { await voiceCloneApi.remove(v.id); await refresh() } catch (e) { setListErr(toMapped(e)); await refresh() }
        }}
      />
      <p className="ra-small" style={{ marginTop: 20 }}>Found a voice that imitates someone without their consent? Email <a href="mailto:abuse@readaloudai.org" style={{ textDecoration: 'underline' }}>abuse@readaloudai.org</a>.</p>
    </div>
  )
}
