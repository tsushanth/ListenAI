'use client'

// Web UI for Orpheus streaming voice cloning (backend/src/routes/orpheusVoiceStudio.ts), reusing the
// stage-machine shape and ra-vs-* / ra-btn / ra-card CSS classes from VoiceStudio.tsx (the ReadAloud Live cloning
// UI). The two backends differ, though: Orpheus's Modal service only exposes create / upload dataset zip /
// commit / status / synthesize / delete — no chunked part upload, no fixed sample sentences, no separate
// deploy step (a voice is usable for synthesis as soon as it is "ready"). So this component is a smaller,
// single-zip-upload flow rather than a line-for-line port of VoiceStudio.tsx.
//
// There is no "list my voices" endpoint on the Orpheus service (mirroring the API-key route, which has
// none either), so this component tracks the ids of voices created from this browser in localStorage and
// refreshes each one's status individually. That means voices created from another browser/device, or via
// the API/MCP path, will not show up here — a known limitation, not a bug: there is nowhere on the backend
// to ask "what voices does this user own" for Orpheus today.
import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { orpheusVoiceStudioApi, type OrpheusVoice } from '@/lib/orpheusVoiceStudioApi'

const LS_KEY = 'ra-orpheus-voice-ids'

function loadIds(): string[] {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]') } catch { return [] }
}
function saveIds(ids: string[]) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(ids)) } catch { /* private browsing etc: non-fatal */ }
}

const STATUS_LABEL: Record<string, string> = {
  awaiting_dataset: 'Waiting for recordings',
  training: 'Training',
  warming: 'Warming up',
  ready: 'Ready to try',
  failed: 'Failed',
}

function fmtDate(t: number | string | null | undefined) {
  if (!t) return ''
  const ms = typeof t === 'number' ? (t > 1e12 ? t : t * 1000) : Date.parse(t)
  return Number.isFinite(ms) ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : ''
}

function errorText(e: OrpheusVoice['error']): string {
  if (!e) return 'Training failed.'
  if (typeof e === 'string') return e
  return e.reason || e.code || 'Training failed.'
}

type Stage = 'list' | 'consent' | 'voice'

export default function OrpheusVoiceStudio() {
  const [sessionEmail, setSessionEmail] = useState<string | null>(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [voices, setVoices] = useState<OrpheusVoice[]>([])
  const [stage, setStage] = useState<Stage>('list')
  const [activeId, setActiveId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSessionEmail(data.session?.user.email ?? null); setAuthLoading(false) })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSessionEmail(s?.user.email ?? null))
    return () => sub.subscription.unsubscribe()
  }, [])

  const refresh = useCallback(async () => {
    const ids = loadIds()
    const results = await Promise.all(ids.map(async (id) => {
      try { return await orpheusVoiceStudioApi.status(id) } catch { return null }
    }))
    const alive: string[] = []
    const list: OrpheusVoice[] = []
    results.forEach((v, i) => { if (v) { alive.push(ids[i]); list.push(v) } })
    if (alive.length !== ids.length) saveIds(alive) // drop ids for voices that were deleted elsewhere
    setVoices(list)
  }, [])

  useEffect(() => { if (sessionEmail) refresh().catch((e) => setError(e instanceof Error ? e.message : 'Could not load your voices.')) }, [sessionEmail, refresh])

  const active = voices.find((v) => v.id === activeId) ?? null

  return (
    <div className="ra-vs">
      {authLoading ? <p className="ra-small">Loading…</p>
        : !sessionEmail ? (
          <div className="ra-vs-card"><h2>Sign in to create a voice</h2><p className="ra-lede" style={{ fontSize: '1rem' }}>Use the same account as your API keys.</p></div>
        ) : (
          <>
            <div className="ra-vs-user"><span>{sessionEmail}</span></div>
            {error && <p className="ra-err" role="alert">{error}</p>}
            {stage === 'list' && (
              <VoiceList voices={voices} onOpen={(id) => { setActiveId(id); setStage('voice'); setError(null) }}
                onNew={() => { setStage('consent'); setError(null) }} />
            )}
            {stage === 'consent' && (
              <Consent onCancel={() => setStage('list')}
                onCreated={async (id) => { saveIds([...loadIds(), id]); await refresh(); setActiveId(id); setStage('voice') }} />
            )}
            {stage === 'voice' && active && (
              <VoicePanel key={active.id} voice={active} onChanged={refresh}
                onBack={() => { setStage('list'); setActiveId(null); refresh() }}
                onDeleted={() => { saveIds(loadIds().filter((i) => i !== active.id)); setStage('list'); setActiveId(null); refresh() }} />
            )}
            {stage === 'voice' && !active && (
              <div className="ra-vs-card"><p>That voice no longer exists.</p><button className="ra-btn ghost" onClick={() => setStage('list')}>Back to your voices</button></div>
            )}
          </>
        )}
    </div>
  )
}

function VoiceList({ voices, onOpen, onNew }: { voices: OrpheusVoice[]; onOpen: (id: string) => void; onNew: () => void }) {
  return (
    <div>
      <div className="ra-vs-head">
        <div><h2>Your streaming (Orpheus) voices</h2>
          <p className="ra-lede" style={{ fontSize: '1.05rem' }}>Clone a voice for low-latency streaming synthesis.</p></div>
        <button className="ra-btn solid" onClick={onNew}>Create a voice</button>
      </div>
      {voices.length === 0 ? (
        <div className="ra-vs-card ra-vs-empty">
          <h3>No voices yet</h3>
          <p>You will need: the speaker&rsquo;s permission and a zip of clear recordings with a transcript for each clip.</p>
        </div>
      ) : (
        <ul className="ra-vs-list">
          {voices.map((v) => (
            <li key={v.id}>
              <button className="ra-vs-row" onClick={() => onOpen(v.id)}>
                <span><b>{v.speaker_name || v.id}</b><small>{fmtDate(v.created_at)}</small></span>
                <span className={`ra-vs-pill ${v.status}`}>{STATUS_LABEL[v.status] ?? v.status}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Consent({ onCancel, onCreated }: { onCancel: () => void; onCreated: (id: string) => void }) {
  const [speaker, setSpeaker] = useState('')
  const [checked, setChecked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ready = speaker.trim().length >= 2 && checked
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); if (!ready) return
    setBusy(true); setError(null)
    try {
      const out = await orpheusVoiceStudioApi.create({ speaker_name: speaker.trim(), consent: true })
      onCreated(out.id)
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not create the voice.'); setBusy(false) }
  }
  return (
    <form className="ra-vs-card" onSubmit={submit}>
      <h2>The speaker&rsquo;s permission</h2>
      <p className="ra-lede" style={{ fontSize: '1.05rem' }}>A voice can only be made from someone who agrees to it.</p>
      <div className="ra-vs-form">
        <label>Speaker&rsquo;s full name<input value={speaker} onChange={(e) => setSpeaker(e.target.value)} placeholder="The person whose voice it is" maxLength={100} /></label>
      </div>
      <fieldset className="ra-vs-consent">
        <legend>Please confirm</legend>
        <label className="ra-vs-check">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          <span>I am authorized to consent on behalf of the speaker named above, and that speaker has agreed to have their voice cloned and used to synthesize new speech through this service.</span>
        </label>
      </fieldset>
      {error && <p className="ra-err" role="alert">{error}</p>}
      <div className="ra-cta"><button className="ra-btn solid" disabled={!ready || busy}>{busy ? 'Saving…' : 'I agree, continue'}</button>
        <button type="button" className="ra-btn ghost" onClick={onCancel}>Cancel</button></div>
    </form>
  )
}

function VoicePanel({ voice, onChanged, onBack, onDeleted }: { voice: OrpheusVoice; onChanged: () => void; onBack: () => void; onDeleted: () => void }) {
  const [v, setV] = useState(voice)
  useEffect(() => setV(voice), [voice])
  const poll = v.status === 'training' || v.status === 'warming'
  useEffect(() => {
    if (!poll) return
    const t = setInterval(async () => {
      try { const n = await orpheusVoiceStudioApi.status(v.id); setV(n); if (n.status !== v.status) onChanged() } catch { /* transient */ }
    }, 5000)
    return () => clearInterval(t)
  }, [poll, v.id, v.status, onChanged])
  return (
    <div>
      <button className="ra-link" onClick={onBack}>← All voices</button>
      <div className="ra-vs-card">
        <h2 style={{ marginBottom: 4 }}>{v.speaker_name || v.id}</h2>
        {v.status === 'awaiting_dataset' && <Upload voice={v} onStarted={() => orpheusVoiceStudioApi.status(v.id).then(setV)} />}
        {(v.status === 'training' || v.status === 'warming') && <Training status={v.status} />}
        {v.status === 'failed' && <Failed voice={v} onDeleted={onDeleted} />}
        {v.status === 'ready' && <Synthesize voice={v} />}
        {v.status !== 'failed' && <DeleteBox voice={v} onDeleted={onDeleted} />}
      </div>
    </div>
  )
}

function Upload({ voice, onStarted }: { voice: OrpheusVoice; onStarted: () => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [phase, setPhase] = useState<'idle' | 'uploading' | 'committing'>('idle')
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const pick = (f: File | null) => {
    setError(null); setFile(null)
    if (!f) return
    if (!f.name.toLowerCase().endsWith('.zip')) return setError('Please choose a .zip file containing your recordings and transcripts.')
    setFile(f)
  }

  const start = async () => {
    if (!file) return
    setError(null); setPhase('uploading')
    try {
      await orpheusVoiceStudioApi.uploadDataset(voice.id, file)
      setPhase('committing')
      await orpheusVoiceStudioApi.commit(voice.id)
      onStarted()
    } catch (e) {
      setPhase('idle')
      setError(e instanceof Error ? e.message : 'The upload failed.')
    }
  }

  return (
    <div>
      <p className="ra-lede" style={{ fontSize: '1.05rem', marginTop: 0 }}>Upload a zip with the speaker&rsquo;s recordings and transcripts to start training.</p>
      <div className="ra-vs-drop" data-active={!!file}>
        <input ref={inputRef} type="file" accept=".zip,application/zip" hidden onChange={(e) => pick(e.target.files?.[0] ?? null)} />
        {phase === 'idle' && (
          <>
            {file ? <p><b>{file.name}</b> · {(file.size / 1048576).toFixed(1)} MB</p> : <p>Choose the zip with your clips and transcripts</p>}
            <div className="ra-cta">
              <button className="ra-btn ghost" onClick={() => inputRef.current?.click()}>{file ? 'Choose a different file' : 'Choose zip file'}</button>
              {file && <button className="ra-btn solid" onClick={start}>Upload and start training</button>}
            </div>
          </>
        )}
        {phase === 'uploading' && <p role="status"><b>Uploading…</b> Keep this page open.</p>}
        {phase === 'committing' && <p role="status"><b>Checking your recordings…</b> This takes a minute.</p>}
      </div>
      {error && <p className="ra-err" role="alert">{error}</p>}
    </div>
  )
}

function Training({ status }: { status: string }) {
  return (
    <div role="status" aria-live="polite" className="ra-vs-training">
      <div className="ra-vs-spin" aria-hidden="true" />
      <div>
        <h3 style={{ margin: 0 }}>{status === 'warming' ? 'Warming up your voice' : 'Training your voice'}</h3>
        <p>You can close this page: come back to &ldquo;Your voices&rdquo; and it will be waiting for you.</p>
        <p className="ra-small">This page checks every few seconds.</p>
      </div>
    </div>
  )
}

function Failed({ voice, onDeleted }: { voice: OrpheusVoice; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false)
  return (
    <div>
      <div className="ra-vs-notice bad" role="alert">
        <b>Training failed</b>
        <p>{errorText(voice.error)}</p>
      </div>
      <div className="ra-cta">
        <button className="ra-btn solid" disabled={busy} onClick={async () => { setBusy(true); try { await orpheusVoiceStudioApi.remove(voice.id) } finally { onDeleted() } }}>
          {busy ? 'Deleting…' : 'Delete and start again'}</button>
      </div>
    </div>
  )
}

function Synthesize({ voice }: { voice: OrpheusVoice }) {
  const [text, setText] = useState('Thanks for calling. Your appointment is confirmed for Tuesday at ten thirty.')
  const [state, setState] = useState<'idle' | 'loading' | 'playing'>('idle')
  const [error, setError] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const play = async () => {
    setError(null)
    if (state === 'playing') { audioRef.current?.pause(); setState('idle'); return }
    try {
      setState('loading')
      const url = await orpheusVoiceStudioApi.synthesize(voice.id, text.trim())
      const a = new Audio(url); audioRef.current = a
      a.onended = () => setState('idle'); a.onerror = () => { setState('idle'); setError('Could not play this.') }
      await a.play(); setState('playing')
    } catch (e) { setState('idle'); setError(e instanceof Error ? e.message : 'Could not synthesize this.') }
  }

  return (
    <div>
      <p className="ra-lede" style={{ fontSize: '1.05rem', marginTop: 0 }}>Your voice is ready. Try it below.</p>
      <div className="ra-vs-own">
        <textarea value={text} maxLength={300} onChange={(e) => setText(e.target.value)} rows={3} aria-label="Text to speak" />
        <div className="ra-vs-own-foot"><small>{text.length} / 300 characters</small>
          <button className="ra-btn solid" onClick={play} disabled={state === 'loading' || !text.trim()}>
            {state === 'loading' ? 'Generating…' : state === 'playing' ? 'Stop' : 'Play'}
          </button>
        </div>
      </div>
      {error && <p className="ra-err" role="alert">{error}</p>}
    </div>
  )
}

function DeleteBox({ voice, onDeleted }: { voice: OrpheusVoice; onDeleted: () => void }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (voice.status === 'training' || voice.status === 'warming') return null
  return (
    <div className="ra-vs-danger">
      {!open ? <button className="ra-link danger" onClick={() => setOpen(true)}>Delete this voice…</button> : (
        <div role="alertdialog" aria-label="Confirm delete">
          <p><b>Delete &ldquo;{voice.speaker_name || voice.id}&rdquo;?</b></p>
          <p>This permanently removes the recordings, the transcripts and the trained model. It cannot be undone.</p>
          <div className="ra-cta">
            <button className="ra-btn danger" disabled={busy} onClick={async () => { setBusy(true); setError(null); try { await orpheusVoiceStudioApi.remove(voice.id); onDeleted() } catch (e) { setError(e instanceof Error ? e.message : 'Could not delete.'); setBusy(false) } }}>{busy ? 'Deleting…' : 'Delete permanently'}</button>
            <button className="ra-btn ghost" onClick={() => setOpen(false)}>Keep it</button>
          </div>
          {error && <p className="ra-err" role="alert">{error}</p>}
        </div>
      )}
    </div>
  )
}
