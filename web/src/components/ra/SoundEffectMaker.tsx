'use client'

import { useEffect, useRef, useState } from 'react'
import {
  soundEffectsApi, SFX_MAX_PROMPT, SFX_MAX_SEC, SFX_MIN_SEC, type SoundEffectStatus,
} from '@/lib/soundEffectsApi'
import { pollUntil, toObjectUrl } from '@/lib/toolsApiCommon'
import {
  ErrorNotice, LoadingCard, PriceNote, SignInGate, Working, toUiError, useSessionEmail, useUnmountFlag,
  type UiError,
} from './ToolShared'
import DeploymentPanel from './DeploymentPanel'

type Stage = 'idle' | 'submitting' | 'polling' | 'ready'

export default function SoundEffectMaker() {
  const email = useSessionEmail()
  const cancelled = useUnmountFlag()
  // Whether the user's own GPU worker is running (controlled by <DeploymentPanel/> below).
  const [deployReady, setDeployReady] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [duration, setDuration] = useState(4)
  const [stage, setStage] = useState<Stage>('idle')
  const [cacheHit, setCacheHit] = useState(false)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [error, setError] = useState<UiError | null>(null)
  const [lastPrompt, setLastPrompt] = useState('')
  const urlRef = useRef<string | null>(null)

  useEffect(() => () => { if (urlRef.current?.startsWith('blob:')) URL.revokeObjectURL(urlRef.current) }, [])

  const validate = (): string | null => {
    if (!deployReady) return 'Start your sound effects generator first.'
    const p = prompt.trim()
    if (!p) return 'Describe the sound you want.'
    if (p.length > SFX_MAX_PROMPT) return `Prompt is too long (${p.length}/${SFX_MAX_PROMPT} characters).`
    if (!Number.isFinite(duration) || duration < SFX_MIN_SEC || duration > SFX_MAX_SEC) {
      return `Duration must be between ${SFX_MIN_SEC} and ${SFX_MAX_SEC} seconds.`
    }
    return null
  }

  const submit = async () => {
    const problem = validate()
    if (problem) { setError({ message: problem, subscription: false }); return }
    setError(null); setAudioUrl(null); setStage('submitting')
    try {
      const p = prompt.trim()
      const job = await soundEffectsApi.create({ prompt: p, durationSec: duration })
      setCacheHit(job.cache_hit); setLastPrompt(p)

      let signedUrl = job.audio_url
      if (!signedUrl) {
        setStage('polling')
        const final = await pollUntil<SoundEffectStatus>(async () => {
          const s = await soundEffectsApi.get(job.job_id)
          return s.status === 'ready' || s.status === 'failed' ? s : undefined
        }, { intervalMs: 2000, maxMs: 5 * 60_000, isCancelled: cancelled })
        if (cancelled()) return
        if (!final) throw new Error('Generation timed out. Please try again.')
        if (final.status === 'failed') throw new Error(final.error?.message || 'Sound effect generation failed.')
        signedUrl = final.audio_url
      }
      if (!signedUrl) throw new Error('The sound effect finished but no audio link was returned.')

      const url = await toObjectUrl(signedUrl)
      urlRef.current = url
      setAudioUrl(url); setStage('ready')
    } catch (e) {
      setStage('idle')
      setError(toUiError(e, 'Sound effect generation failed.'))
    }
  }

  if (email === undefined) return <LoadingCard />
  if (!email) return <SignInGate title="Sign in to generate sound effects" />

  const busy = stage === 'submitting' || stage === 'polling'
  const slug = (lastPrompt || 'sound-effect').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'sound-effect'

  return (
    <div className="ra-vs">
      <ErrorNotice error={error} />

      <DeploymentPanel service="sound_effect" noun="sound effects generator" signedIn={!!email} onReadyChange={setDeployReady} />

      <div className="ra-vs-card">
        <div className="ra-vs-form">
          <label>
            Describe the sound
            <textarea
              value={prompt}
              rows={3}
              maxLength={SFX_MAX_PROMPT}
              placeholder="A wooden door creaking open in an empty stone hallway"
              disabled={busy}
              onChange={(e) => setPrompt(e.target.value)}
              style={{ font: 'inherit', fontWeight: 400, border: '1.5px solid var(--line)', borderRadius: 10, padding: '11px 13px', width: '100%' }}
            />
            <span className="ra-small" style={{ fontWeight: 400 }}>{prompt.length}/{SFX_MAX_PROMPT}</span>
          </label>
          <label style={{ maxWidth: 320 }}>
            Duration: {duration} s
            <input
              type="range"
              min={SFX_MIN_SEC}
              max={SFX_MAX_SEC}
              step={0.5}
              value={duration}
              disabled={busy}
              onChange={(e) => setDuration(Number(e.target.value))}
            />
          </label>
        </div>

        <p className="ra-small" style={{ marginTop: 12 }}>
          {SFX_MIN_SEC}-{SFX_MAX_SEC} seconds per clip. Repeating an earlier prompt and duration returns the stored clip instantly and is not billed again.
        </p>
        <PriceNote tool="soundEffects" />

        <div className="ra-cta" style={{ marginTop: 16 }}>
          <button className="ra-btn solid" onClick={submit} disabled={busy || !prompt.trim() || !deployReady}>
            {busy ? 'Generating...' : 'Generate sound effect'}
          </button>
        </div>

        {stage === 'polling' && <Working title="Generating">Usually takes a few seconds.</Working>}
      </div>

      {stage === 'ready' && audioUrl && (
        <div className="ra-vs-card" style={{ marginTop: 20 }}>
          {cacheHit && (
            <p style={{ marginBottom: 10 }}>
              <span className="ra-vs-pill deployed">Cache hit</span>{' '}
              <span className="ra-small">Served from a previous generation; you were not billed.</span>
            </p>
          )}
          <div className="ra-vs-samples">
            <div className="ra-vs-sample"><audio controls src={audioUrl} className="w-full" /></div>
          </div>
          <div className="ra-cta" style={{ marginTop: 12 }}>
            <a className="ra-btn ghost" href={audioUrl} download={`${slug}.wav`}>Download audio</a>
          </div>
        </div>
      )}
    </div>
  )
}
