'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { isMockMode, voiceStudioApi, type StudioConfig, type StudioVoice, type VoiceWarning } from '@/lib/voiceStudioApi'

// The five fixed sentences every trained voice is asked to say (same order as voice-pipeline/train_job.py).
const SAMPLE_SENTENCES = [
  'Thanks for calling, I can help you with that. Let me pull up your account details right now.',
  'Your order should arrive within three to five business days, and I will send a confirmation email shortly.',
  'I understand your frustration, let me see what I can do to make this right.',
  'Is there anything else I can help you with today?',
  'Your extension is six six three five.',
]

const CONSENT_LINES = [
  'I am the person whose voice is in these recordings, or I have that person’s written permission to create an AI voice from them.',
  'I understand the voice will be used to generate speech for my organisation through the ReadAloud AI Voice API.',
  'I understand that I can delete the voice, the recordings and the trained model at any time, and that deleting stops the voice working immediately.',
]

const FIX_TIPS: Record<string, string> = {
  noisy_audio: 'Record again in a quiet room with the microphone close to your mouth. Turn off fans, music and open windows.',
  multiple_speakers: 'Keep only the clips of one speaker. If you cannot tell them apart, record the speaker again alone.',
  transcript_mismatch: 'Open your metadata.csv and check that each line has the exact words spoken in that clip, with the right file name.',
  too_little_audio: 'Add more recordings. You need at least 20 minutes in total, in clips of 1 to 15 seconds.',
  missing_consent: 'Delete this voice and start again from the consent step.',
  training_failed: 'This was on our side. Delete the voice and try again, or contact support.',
}

const TEMPLATE_CSV =
  'clip_001.wav|Thanks for calling, how can I help you today?\n' +
  'clip_002.wav|Let me look that up for you, one moment please.\n' +
  'clip_003.wav|Your reference number is four seven two nine.\n'

type Stage = 'list' | 'consent' | 'voice'

function warningText(w: VoiceWarning | string): string {
  return typeof w === 'string' ? w.replace(/^[a-z_]+:\s*/, '') : w.message
}

function fmtDate(t: number | null) {
  return t ? new Date(t * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : ''
}

const STATUS_LABEL: Record<StudioVoice['status'], string> = {
  created: 'Waiting for recordings', training: 'Training', ready: 'Ready to try', rejected: 'Needs new recordings', deployed: 'Live',
}

export default function VoiceStudio() {
  const mock = isMockMode()
  const [sessionEmail, setSessionEmail] = useState<string | null>(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [cfg, setCfg] = useState<StudioConfig | null | undefined>(undefined)
  const [voices, setVoices] = useState<StudioVoice[]>([])
  const [stage, setStage] = useState<Stage>('list')
  const [activeId, setActiveId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (mock) { setSessionEmail('admin@example-callcenter.com'); setAuthLoading(false); return }
    supabase.auth.getSession().then(({ data }) => { setSessionEmail(data.session?.user.email ?? null); setAuthLoading(false) })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSessionEmail(s?.user.email ?? null))
    return () => sub.subscription.unsubscribe()
  }, [mock])

  const refresh = useCallback(async () => {
    try { setVoices(await voiceStudioApi.list()) } catch (e) { setError(e instanceof Error ? e.message : 'Could not load your voices.') }
  }, [])

  useEffect(() => {
    if (!sessionEmail) return
    voiceStudioApi.config().then(async (c) => {
      setCfg(c)
      if (!c) return
      await refresh()
      // deep links: /voices?voice=<id> reopens a voice (e.g. from an email), /voices?new=1 starts the consent step
      const q = new URLSearchParams(window.location.search)
      if (q.get('voice')) { setActiveId(q.get('voice')); setStage('voice') } else if (q.get('new')) setStage('consent')
    })
  }, [sessionEmail, refresh])

  const active = voices.find((v) => v.id === activeId) ?? null

  return (
    <div className="ra-vs">
      {authLoading ? <p className="ra-small">Loading…</p>
        : !sessionEmail ? <SignIn />
        : cfg === undefined ? <p className="ra-small">Loading…</p>
        : cfg === null ? (
          <div className="ra-vs-card"><h2>Custom voices are not available on your account yet</h2>
            <p className="ra-lede">This feature is being rolled out to selected customers. Ask your ReadAloud AI contact to switch it on.</p></div>
        ) : (
          <>
            <div className="ra-vs-user"><span>{sessionEmail}</span>
              {!mock && <button className="ra-link" onClick={() => supabase.auth.signOut()}>Sign out</button>}</div>
            {error && <p className="ra-err" role="alert">{error}</p>}
            {stage === 'list' && (
              <VoiceList voices={voices} onOpen={(id) => { setActiveId(id); setStage('voice'); setError(null) }}
                onNew={() => { setStage('consent'); setError(null) }} />
            )}
            {stage === 'consent' && (
              <Consent cfg={cfg} onCancel={() => setStage('list')}
                onCreated={async (id) => { await refresh(); setActiveId(id); setStage('voice') }} />
            )}
            {stage === 'voice' && active && (
              <VoicePanel key={active.id} voice={active} cfg={cfg} onChanged={refresh}
                onBack={() => { setStage('list'); setActiveId(null); refresh() }} />
            )}
            {stage === 'voice' && !active && (
              <div className="ra-vs-card"><p>That voice no longer exists.</p><button className="ra-btn ghost" onClick={() => setStage('list')}>Back to your voices</button></div>
            )}
          </>
        )}
    </div>
  )
}

function SignIn() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null); setNotice(null)
    try {
      if (mode === 'signup') {
        const { data, error: err } = await supabase.auth.signUp({ email, password })
        if (err) throw err
        if (!data.session) { setNotice('Check your email to confirm your account, then sign in.'); setMode('signin') }
      } else {
        const { error: err } = await supabase.auth.signInWithPassword({ email, password })
        if (err) throw err
      }
    } catch (err) { setError(err instanceof Error ? err.message : 'Sign in failed') } finally { setBusy(false) }
  }
  return (
    <div className="ra-vs-card" style={{ maxWidth: 460 }}>
      <h2>Sign in to create a voice</h2>
      <p className="ra-lede" style={{ fontSize: '1rem' }}>Use the same account as your API keys.</p>
      {notice && <p className="ra-vs-notice ok">{notice}</p>}
      <form onSubmit={submit} className="ra-vs-form">
        <label>Email<input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></label>
        <label>Password<input type="password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} /></label>
        {error && <p className="ra-err" role="alert">{error}</p>}
        <div className="ra-cta">
          <button className="ra-btn solid" disabled={busy}>{mode === 'signup' ? 'Create account' : 'Sign in'}</button>
          <button type="button" className="ra-link" onClick={() => { setMode(mode === 'signup' ? 'signin' : 'signup'); setError(null) }}>
            {mode === 'signup' ? 'I already have an account' : 'Create an account'}</button>
        </div>
      </form>
    </div>
  )
}

function VoiceList({ voices, onOpen, onNew }: { voices: StudioVoice[]; onOpen: (id: string) => void; onNew: () => void }) {
  return (
    <div>
      <div className="ra-vs-head">
        <div><h2>Your voices</h2>
          <p className="ra-lede" style={{ fontSize: '1.05rem' }}>Turn about 20 minutes of one person’s recordings into a voice your agents can speak with.</p></div>
        <button className="ra-btn solid" onClick={onNew}>Create a voice</button>
      </div>
      {voices.length === 0 ? (
        <div className="ra-vs-card ra-vs-empty">
          <h3>No voices yet</h3>
          <p>You will need: the speaker’s permission, about 20 minutes of clear recordings, and the exact words said in each clip. The steps take about 20 minutes of your time, plus training time.</p>
        </div>
      ) : (
        <ul className="ra-vs-list">
          {voices.map((v) => (
            <li key={v.id}>
              <button className="ra-vs-row" onClick={() => onOpen(v.id)}>
                <span><b>{v.speaker_name ?? 'Untitled voice'}</b><small>{fmtDate(v.created_at)}</small></span>
                <span className={`ra-vs-pill ${v.status}`}>{STATUS_LABEL[v.status]}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Consent({ cfg, onCancel, onCreated }: { cfg: StudioConfig; onCancel: () => void; onCreated: (id: string) => void }) {
  const [speaker, setSpeaker] = useState('')
  const [by, setBy] = useState('')
  const [checks, setChecks] = useState([false, false, false])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ready = speaker.trim().length >= 2 && by.trim().length >= 2 && checks.every(Boolean)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); if (!ready) return
    setBusy(true); setError(null)
    try {
      const { id } = await voiceStudioApi.create({ speaker_name: speaker.trim(), attested_by: by.trim(), consent_text_version: cfg.consent_text_version })
      onCreated(id)
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not create the voice.'); setBusy(false) }
  }
  return (
    <form className="ra-vs-card" onSubmit={submit}>
      <Steps current={1} />
      <h2>The speaker’s permission</h2>
      <p className="ra-lede" style={{ fontSize: '1.05rem' }}>A voice can only be made from someone who agrees to it. This takes a minute and we keep a record of it.</p>
      <div className="ra-vs-form two">
        <label>Speaker’s full name<input value={speaker} onChange={(e) => setSpeaker(e.target.value)} placeholder="The person whose voice it is" maxLength={100} /></label>
        <label>Confirmed by<input value={by} onChange={(e) => setBy(e.target.value)} placeholder="Your name (can be the same person)" maxLength={100} /></label>
      </div>
      <fieldset className="ra-vs-consent">
        <legend>Please confirm each statement</legend>
        {CONSENT_LINES.map((t, i) => (
          <label key={i} className="ra-vs-check"><input type="checkbox" checked={checks[i]} onChange={(e) => setChecks(checks.map((c, j) => (j === i ? e.target.checked : c)))} /><span>{t}</span></label>
        ))}
      </fieldset>
      <div className="ra-vs-store">
        <b>What we keep</b>
        <p>Your recordings and transcripts, the trained voice model, and this permission record (names, date and time, and network address). Nothing is shared or used to train voices for anyone else. Deleting a voice removes the recordings, the transcripts and the model.</p>
      </div>
      {error && <p className="ra-err" role="alert">{error}</p>}
      <div className="ra-cta"><button className="ra-btn solid" disabled={!ready || busy}>{busy ? 'Saving…' : 'I agree, continue'}</button>
        <button type="button" className="ra-btn ghost" onClick={onCancel}>Cancel</button></div>
    </form>
  )
}

function Steps({ current }: { current: number }) {
  const names = ['Permission', 'Recordings', 'Training', 'Listen', 'Go live']
  return (
    <ol className="ra-vs-steps" aria-label="Progress">
      {names.map((n, i) => (
        <li key={n} className={i + 1 < current ? 'done' : i + 1 === current ? 'now' : ''} aria-current={i + 1 === current ? 'step' : undefined}>
          <span>{i + 1 < current ? '✓' : i + 1}</span>{n}
        </li>
      ))}
    </ol>
  )
}

function VoicePanel({ voice, cfg, onChanged, onBack }: { voice: StudioVoice; cfg: StudioConfig; onChanged: () => void; onBack: () => void }) {
  const [v, setV] = useState(voice)
  useEffect(() => setV(voice), [voice])
  const poll = v.status === 'training'
  useEffect(() => {
    if (!poll) return
    const t = setInterval(async () => {
      try { const n = await voiceStudioApi.get(v.id); setV(n); if (n.status !== 'training') onChanged() } catch { /* transient: keep polling */ }
    }, 5000)
    return () => clearInterval(t)
  }, [poll, v.id, onChanged])
  const reload = async () => { const n = await voiceStudioApi.get(v.id); setV(n); onChanged() }
  const step = v.status === 'created' ? 2 : v.status === 'training' ? 3 : v.status === 'ready' ? 4 : v.status === 'deployed' ? 6 : 2
  return (
    <div>
      <button className="ra-link" onClick={onBack}>← All voices</button>
      <div className="ra-vs-card">
        <Steps current={step} />
        <h2 style={{ marginBottom: 4 }}>{v.speaker_name ?? 'Voice'}</h2>
        {v.status === 'created' && <Upload voice={v} cfg={cfg} onStarted={reload} />}
        {v.status === 'training' && <Training />}
        {v.status === 'rejected' && <Rejected voice={v} onDeleted={onBack} />}
        {(v.status === 'ready' || v.status === 'deployed') && <Listen voice={v} onDeployed={reload} />}
        {v.status === 'deployed' && <Live voice={v} />}
        {v.status !== 'rejected' && <DeleteBox voice={v} onDeleted={onBack} />}
      </div>
    </div>
  )
}

const CHECKLIST = [
  'One speaker only, in every clip.',
  'A quiet room, microphone close to the mouth, no music or fans.',
  'A calm, steady, neutral speaking style, like a good phone agent. Avoid acting, shouting or whispering.',
  '20 minutes or more in total: about 200 to 300 clips of 1 to 15 seconds each.',
  'Each clip has its exact words written down. Transcripts are required.',
  'Save clips as WAV, FLAC or MP3 (16 kHz or better). Not phone recordings: the voice would sound just as narrow.',
]

function Upload({ voice, cfg, onStarted }: { voice: StudioVoice; cfg: StudioConfig; onStarted: () => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [sent, setSent] = useState(0)
  const [phase, setPhase] = useState<'idle' | 'sending' | 'processing'>('idle')
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const cancelled = useRef(false)
  useEffect(() => () => { cancelled.current = true }, [])

  const pick = (f: File | null) => {
    setError(null); setFile(null)
    if (!f) return
    if (!f.name.toLowerCase().endsWith('.zip')) return setError('Please choose a .zip file containing your recordings and metadata.csv.')
    if (f.size > cfg.max_zip_bytes) return setError(`That file is ${Math.round(f.size / 1048576)} MB and the limit is ${Math.round(cfg.max_zip_bytes / 1048576)} MB. Save the clips as FLAC or MP3 to make the zip smaller.`)
    setFile(f)
  }

  const start = async () => {
    if (!file) return
    setError(null); setPhase('sending'); setSent(0)
    const size = cfg.part_bytes
    const total = Math.ceil(file.size / size)
    try {
      let have = new Map<number, number>()
      try { (await voiceStudioApi.listParts(voice.id)).parts.forEach((p) => have.set(p.part, p.bytes)) } catch { have = new Map() }
      let done = 0
      for (let n = 0; n < total; n++) {
        const blob = file.slice(n * size, Math.min(file.size, (n + 1) * size))
        if (have.get(n) === blob.size) { done += blob.size; setSent(done); continue } // resume: already stored
        for (let attempt = 1; ; attempt++) {
          try { await voiceStudioApi.putPart(voice.id, n, blob, (l) => setSent(done + l)); break }
          catch (e) {
            const st = (e as { status?: number }).status
            if (attempt >= 4 || (st && st < 500 && st !== 429)) throw e
            await new Promise((r) => setTimeout(r, 1000 * attempt))
          }
        }
        done += blob.size; setSent(done)
      }
      setPhase('processing')
      await voiceStudioApi.commit(voice.id, total)
      onStarted()
    } catch (e) {
      setPhase('idle')
      setError((e instanceof Error ? e.message : 'The upload failed.') + ' Nothing is lost: choose the same file and press Upload again to continue where it stopped.')
    }
  }

  const download = () => {
    const url = URL.createObjectURL(new Blob([TEMPLATE_CSV], { type: 'text/csv' }))
    const a = document.createElement('a'); a.href = url; a.download = 'metadata.csv'; a.click(); URL.revokeObjectURL(url)
  }
  const pct = file ? Math.min(100, Math.round((sent / file.size) * 100)) : 0

  return (
    <div>
      <p className="ra-lede" style={{ fontSize: '1.05rem', marginTop: 0 }}>Now the recordings. Better recordings make a better voice, so it is worth a few minutes of preparation.</p>
      <div className="ra-vs-two">
        <div>
          <h3>Before you record</h3>
          <ul className="ra-vs-checklist">{CHECKLIST.map((c) => <li key={c}>{c}</li>)}</ul>
        </div>
        <div>
          <h3>Transcripts</h3>
          <p>Put a text file named <code className="inl">metadata.csv</code> in the zip next to your clips. One line per clip: the file name, a vertical bar, then exactly what is said.</p>
          <pre className="ra-vs-pre">{TEMPLATE_CSV}</pre>
          <button className="ra-btn ghost" onClick={download}>Download the template</button>
          <p className="ra-small" style={{ marginTop: 10 }}>Replace the example lines with yours. Then select all clips and metadata.csv, and compress them into one zip.</p>
        </div>
      </div>

      <div className="ra-vs-drop" data-active={!!file}>
        <input ref={inputRef} type="file" accept=".zip,application/zip" hidden onChange={(e) => pick(e.target.files?.[0] ?? null)} />
        {phase === 'idle' && (
          <>
            {file ? <p><b>{file.name}</b> · {(file.size / 1048576).toFixed(1)} MB</p> : <p>Choose the zip with your clips and metadata.csv</p>}
            <div className="ra-cta">
              <button className="ra-btn ghost" onClick={() => inputRef.current?.click()}>{file ? 'Choose a different file' : 'Choose zip file'}</button>
              {file && <button className="ra-btn solid" onClick={start}>Upload and start training</button>}
            </div>
          </>
        )}
        {phase === 'sending' && (
          <div role="status" aria-live="polite">
            <p><b>Uploading… {pct}%</b> ({(sent / 1048576).toFixed(0)} of {file ? (file.size / 1048576).toFixed(0) : 0} MB)</p>
            <div className="ra-vs-bar"><i style={{ width: `${pct}%` }} /></div>
            <p className="ra-small">Keep this page open. If your connection drops, upload again and it continues where it stopped.</p>
          </div>
        )}
        {phase === 'processing' && <p role="status"><b>Checking your recordings…</b> This takes a minute.</p>}
      </div>
      {error && <p className="ra-err" role="alert">{error}</p>}
    </div>
  )
}

function Training() {
  return (
    <div role="status" aria-live="polite" className="ra-vs-training">
      <div className="ra-vs-spin" aria-hidden="true" />
      <div>
        <h3 style={{ margin: 0 }}>Training your voice</h3>
        <p>We checked your recordings and started training. This usually takes 20 to 40 minutes. You can close this page: come back to “Your voices” and it will be waiting for you.</p>
        <p className="ra-small">This page checks every few seconds.</p>
      </div>
    </div>
  )
}

function Rejected({ voice, onDeleted }: { voice: StudioVoice; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false)
  const code = voice.error?.code ?? 'rejected'
  return (
    <div>
      <div className="ra-vs-notice bad" role="alert">
        <b>We could not make a voice from these recordings</b>
        <p>{voice.error?.reason ?? 'The recordings could not be used.'}</p>
        {FIX_TIPS[code] && <p><b>What to do:</b> {FIX_TIPS[code]}</p>}
      </div>
      <p className="ra-small">Nothing was charged. Your uploaded files are kept until you delete this voice.</p>
      <div className="ra-cta">
        <button className="ra-btn solid" disabled={busy} onClick={async () => { setBusy(true); try { await voiceStudioApi.remove(voice.id) } finally { onDeleted() } }}>
          {busy ? 'Deleting…' : 'Delete these recordings and start again'}</button>
      </div>
    </div>
  )
}

function Player({ getUrl, label, sub, cacheKey }: { getUrl: () => Promise<string>; label: string; sub?: string; cacheKey?: string }) {
  const [state, setState] = useState<'idle' | 'loading' | 'playing'>('idle')
  const [err, setErr] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const urlRef = useRef<string | null>(null)
  const keyRef = useRef(cacheKey)
  if (keyRef.current !== cacheKey) { keyRef.current = cacheKey; urlRef.current = null } // new text: fetch fresh audio
  const play = async () => {
    setErr(null)
    if (state === 'playing') { audioRef.current?.pause(); setState('idle'); return }
    try {
      setState('loading')
      if (!urlRef.current) urlRef.current = await getUrl()
      const a = new Audio(urlRef.current); audioRef.current = a
      a.onended = () => setState('idle'); a.onerror = () => { setState('idle'); setErr('Could not play this.') }
      await a.play(); setState('playing')
    } catch (e) { setState('idle'); setErr(e instanceof Error ? e.message : 'Could not play this.') }
  }
  return (
    <div className="ra-vs-sample">
      <button className="ra-vs-play" onClick={play} aria-label={`${state === 'playing' ? 'Stop' : 'Play'}: ${label}`} disabled={state === 'loading'}>
        {state === 'loading' ? '…' : state === 'playing' ? '■' : '▶'}
      </button>
      <div><p>{label}</p>{sub && <small>{sub}</small>}{err && <small className="ra-err"> {err}</small>}</div>
    </div>
  )
}

function Listen({ voice, onDeployed }: { voice: StudioVoice; onDeployed: () => void }) {
  const [text, setText] = useState('Thanks for calling. Your appointment is confirmed for Tuesday at ten thirty.')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const live = voice.status === 'deployed'
  const deploy = async () => {
    setBusy(true); setError(null)
    try { await voiceStudioApi.deploy(voice.id); onDeployed() } catch (e) { setError(e instanceof Error ? e.message : 'Could not go live.'); setBusy(false) }
  }
  return (
    <div>
      <p className="ra-lede" style={{ fontSize: '1.05rem', marginTop: 0 }}>
        {live ? 'Your voice is live. You can keep listening to it here.' : 'Your voice is trained. Listen before you put it in front of callers.'}
        {voice.stats?.minutes ? <> Built from {voice.stats.minutes} minutes of audio.</> : null}</p>
      {voice.warnings.length > 0 && (
        <div className="ra-vs-notice warn" role="note">
          <b>Things to know before you go live</b>
          <ul>{voice.warnings.map((w, i) => <li key={i}>{warningText(w)}</li>)}</ul>
        </div>
      )}
      <h3>Five test sentences</h3>
      <div className="ra-vs-samples">
        {SAMPLE_SENTENCES.map((s, i) => <Player key={i} label={s} getUrl={() => voiceStudioApi.sample(voice.id, i)} />)}
      </div>
      <h3>Try your own words</h3>
      <div className="ra-vs-own">
        <textarea value={text} maxLength={300} onChange={(e) => setText(e.target.value)} rows={3} aria-label="Text to speak" />
        <div className="ra-vs-own-foot"><small>{text.length} / 300 characters</small>
          <Player label="Play this text" cacheKey={text} getUrl={() => voiceStudioApi.preview(voice.id, text.trim())} /></div>
      </div>
      {!live && (
        <div className="ra-vs-golive">
          <h3>Go live</h3>
          {!confirm ? (
            <>
              <p>Going live makes this voice available to your API keys. Only your account can use it. You can remove it at any time.</p>
              <button className="ra-btn solid" onClick={() => setConfirm(true)}>Put this voice live</button>
            </>
          ) : (
            <>
              <p><b>Ready?</b> Requests that ask for this voice will start speaking with it straight away.</p>
              <div className="ra-cta"><button className="ra-btn solid" disabled={busy} onClick={deploy}>{busy ? 'Going live…' : 'Yes, go live'}</button>
                <button className="ra-btn ghost" onClick={() => setConfirm(false)}>Not yet</button></div>
            </>
          )}
          {error && <p className="ra-err" role="alert">{error}</p>}
        </div>
      )}
    </div>
  )
}

function Live({ voice }: { voice: StudioVoice }) {
  const [copied, setCopied] = useState(false)
  const id = voice.voice ?? `custom:${voice.id}`
  const snippet = `{ "type": "synthesize", "text": "Thanks for calling.", "voice": "${id}" }`
  const authSnippet = `curl -X POST https://api.readaloudai.org/tts/authorize \\\n  -H "Content-Type: application/json" \\\n  -d '{"key": "YOUR_API_KEY", "engine": "piper"}'`
  return (
    <div className="ra-vs-live">
      <h3>Use it</h3>
      <p>Send this voice name with any request made with one of your API keys, on the <b>Piper</b> engine. Keys created before today work too.</p>
      <div className="ra-code"><pre>{`# 1. get a token for the Piper engine\n${authSnippet}\n\n# 2. connect to the URL it returns, then send\n${snippet}`}</pre></div>
      <div className="ra-cta" style={{ marginTop: 12 }}>
        <button className="ra-btn ghost" onClick={() => { navigator.clipboard?.writeText(id); setCopied(true); setTimeout(() => setCopied(false), 1800) }}>{copied ? 'Copied' : `Copy “${id}”`}</button>
        <a className="ra-btn ghost" href="/developers#reference">API reference</a>
      </div>
    </div>
  )
}

function DeleteBox({ voice, onDeleted }: { voice: StudioVoice; onDeleted: () => void }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (voice.status === 'training') return null
  return (
    <div className="ra-vs-danger">
      {!open ? <button className="ra-link danger" onClick={() => setOpen(true)}>Delete this voice…</button> : (
        <div role="alertdialog" aria-label="Confirm delete">
          <p><b>Delete “{voice.speaker_name}”?</b></p>
          <p>This permanently removes the recordings, the transcripts and the trained model.{voice.status === 'deployed' ? ' The voice stops working for your API keys immediately.' : ''} It cannot be undone.</p>
          <div className="ra-cta">
            <button className="ra-btn danger" disabled={busy} onClick={async () => { setBusy(true); setError(null); try { await voiceStudioApi.remove(voice.id); onDeleted() } catch (e) { setError(e instanceof Error ? e.message : 'Could not delete.'); setBusy(false) } }}>{busy ? 'Deleting…' : 'Delete permanently'}</button>
            <button className="ra-btn ghost" onClick={() => setOpen(false)}>Keep it</button>
          </div>
          {error && <p className="ra-err" role="alert">{error}</p>}
        </div>
      )}
    </div>
  )
}
