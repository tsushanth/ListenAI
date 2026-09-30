'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { voiceIsolateApi, type IsolateDeployment, type IsolateJobStatus, type Stem } from '@/lib/voiceIsolateApi'
import { AUDIO_RULES, acceptAttr, fmtSize, validateAudio } from '@/lib/audioFiles'
import { pollUntil } from '@/lib/toolsApiCommon'
import {
  ErrorNotice, LoadingCard, PriceNote, SignInGate, Working, toUiError, useSessionEmail, useUnmountFlag,
  type UiError,
} from './ToolShared'

type Stage = 'idle' | 'uploading' | 'polling' | 'ready' | 'failed'

export default function VoiceIsolator() {
  const email = useSessionEmail()
  const cancelled = useUnmountFlag()

  // Deployment (same per-user Modal model as VoiceConverter)
  const [deployment, setDeployment] = useState<IsolateDeployment | null | undefined>(undefined)
  const [deploying, setDeploying] = useState(false)
  const [destroying, setDestroying] = useState(false)

  // Isolation
  const [file, setFile] = useState<File | null>(null)
  const [wantInstrumental, setWantInstrumental] = useState(false)
  const [consent, setConsent] = useState(false)
  const [stage, setStage] = useState<Stage>('idle')
  const [jobId, setJobId] = useState<string | null>(null)
  const [stems, setStems] = useState<Partial<Record<Stem, string>>>({})
  const [error, setError] = useState<UiError | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const stemsRef = useRef<Partial<Record<Stem, string>>>({})
  const deployPolling = useRef(false)

  const revokeStems = () => {
    Object.values(stemsRef.current).forEach((u) => { if (u) URL.revokeObjectURL(u) })
    stemsRef.current = {}
  }
  useEffect(() => () => revokeStems(), [])

  useEffect(() => {
    if (stage !== 'uploading' && stage !== 'polling') return
    const t0 = Date.now()
    setElapsed(0)
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000)
    return () => clearInterval(id)
  }, [stage])

  const pollDeployment = useCallback(async () => {
    if (deployPolling.current) return
    deployPolling.current = true
    try {
      const dep = await pollUntil<IsolateDeployment | null>(async () => {
        const d = await voiceIsolateApi.getDeployment()
        setDeployment(d)
        return d == null || d.status !== 'deploying' ? d : undefined
      }, { intervalMs: 3000, maxMs: 4 * 60_000, isCancelled: cancelled })
      if (dep === undefined && !cancelled()) {
        setError({ message: 'Deployment is taking longer than expected. Refresh the page to check its status.', subscription: false })
      }
    } catch (e) {
      setError(toUiError(e, 'Could not check deployment status.'))
    } finally {
      deployPolling.current = false
      setDeploying(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!email) return
    voiceIsolateApi.getDeployment()
      .then((dep) => {
        setDeployment(dep)
        if (dep?.status === 'deploying') void pollDeployment()
      })
      .catch((e) => { setDeployment(null); setError(toUiError(e, 'Could not load your isolator.')) })
  }, [email, pollDeployment])

  const deploy = async () => {
    setError(null); setDeploying(true)
    try {
      const dep = await voiceIsolateApi.deploy()
      setDeployment(dep)
      if (dep.status === 'deploying') void pollDeployment()
      else setDeploying(false)
    } catch (e) {
      setError(toUiError(e, 'Could not start deployment.'))
      setDeploying(false)
    }
  }

  const destroy = async () => {
    setError(null); setDestroying(true)
    try {
      await voiceIsolateApi.destroy()
      setDeployment(null)
      reset()
    } catch (e) {
      setError(toUiError(e, 'Could not stop the isolator.'))
    } finally { setDestroying(false) }
  }

  const validate = useCallback((): string | null => {
    if (!deployment || deployment.status !== 'ready') return 'Deploy an isolator first.'
    if (!file) return 'Choose an audio file.'
    const fileErr = validateAudio(file, AUDIO_RULES.isolate)
    if (fileErr) return fileErr
    if (!consent) return 'You must confirm the consent statement to continue.'
    return null
  }, [deployment, file, consent])

  const submit = async () => {
    const problem = validate()
    if (problem) { setError({ message: problem, subscription: false }); return }
    setError(null); revokeStems(); setStems({}); setStage('uploading')
    try {
      const job = await voiceIsolateApi.create({ input: file!, wantInstrumental })
      setJobId(job.job_id); setStage('polling')

      const final = await pollUntil<IsolateJobStatus>(async () => {
        const s = await voiceIsolateApi.poll(job.job_id)
        return s.status === 'done' || s.status === 'failed' ? s : undefined
      }, { intervalMs: 2000, maxMs: 10 * 60_000, isCancelled: cancelled })

      if (cancelled()) return
      if (!final) throw new Error('Isolation timed out. Please try again with a shorter clip.')
      if (final.status === 'failed') {
        setStage('failed')
        setError({ message: final.stderr_tail || 'Isolation failed. Try a different audio file.', subscription: false })
        return
      }

      const next: Partial<Record<Stem, string>> = {}
      next.vocals = await voiceIsolateApi.audio(job.job_id, 'vocals')
      if (wantInstrumental) next.instrumental = await voiceIsolateApi.audio(job.job_id, 'instrumental')
      stemsRef.current = next
      setStems(next); setStage('ready')
    } catch (e) {
      const ui = toUiError(e, 'Could not start isolation.')
      setStage('idle')
      setError(ui)
    }
  }

  const reset = () => {
    revokeStems()
    setStems({}); setFile(null); setConsent(false); setWantInstrumental(false)
    setStage('idle'); setJobId(null); setError(null)
  }

  if (email === undefined) return <LoadingCard />
  if (!email) return <SignInGate title="Sign in to isolate voices" />

  const busy = stage === 'uploading' || stage === 'polling'
  const stemLabels: Array<[Stem, string]> = [['vocals', 'Vocals'], ['instrumental', 'Instrumental']]

  return (
    <div className="ra-vs">
      <ErrorNotice error={error} />

      {/* Deployment */}
      <div className="ra-vs-card" style={{ marginBottom: 20 }}>
        <h3 style={{ marginBottom: 8 }}>Your voice isolator</h3>
        {deployment === undefined ? (
          <p className="ra-small">Checking deployment...</p>
        ) : deployment === null ? (
          <>
            <p className="ra-lede" style={{ fontSize: '1rem' }}>
              Deploy your own GPU-powered vocal isolator (Demucs). It runs on your own Modal account and
              shuts down when not in use.
            </p>
            <div className="ra-cta" style={{ marginTop: 12 }}>
              <button className="ra-btn solid" onClick={deploy} disabled={deploying}>
                {deploying ? 'Deploying...' : 'Deploy isolator'}
              </button>
            </div>
          </>
        ) : deployment.status === 'deploying' ? (
          <div className="ra-vs-training" style={{ marginTop: 8 }}>
            <div className="ra-vs-spin" aria-hidden="true" />
            <div>
              <h3 style={{ margin: 0 }}>Deploying isolator</h3>
              <p>Building your Demucs GPU container. This takes 1-2 minutes.</p>
            </div>
          </div>
        ) : deployment.status === 'ready' ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <span className="ra-vs-pill ready" style={{ fontSize: '.75rem' }}>Ready</span>
              <span className="ra-small">{deployment.modal_url}</span>
              <div style={{ marginLeft: 'auto' }} className="ra-cta">
                <button className="ra-btn ghost danger" onClick={destroy} disabled={destroying || busy}>
                  {destroying ? 'Stopping...' : 'Stop isolator'}
                </button>
              </div>
            </div>
            <p className="ra-small" style={{ marginTop: 8 }}>
              Your isolator only costs money while processing audio. Keep it stopped when not in use.
            </p>
          </>
        ) : deployment.status === 'failed' ? (
          <>
            <p className="ra-vs-notice bad" role="alert">Deployment failed. Try again or contact support.</p>
            <div className="ra-cta">
              <button className="ra-btn solid" onClick={deploy} disabled={deploying}>Retry deployment</button>
            </div>
          </>
        ) : (
          <p className="ra-small">Status: {deployment.status}</p>
        )}
      </div>

      {deployment?.status === 'ready' && (
        <div className="ra-vs-card">
          <div className="ra-vs-form" style={{ marginTop: 0 }}>
            <label>
              Audio to split (speech or music with vocals)
              <input
                type="file"
                accept={acceptAttr(AUDIO_RULES.isolate)}
                disabled={stage !== 'idle'}
                onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(null) }}
              />
            </label>
            {file && <p className="ra-small">{file.name} · {fmtSize(file.size)}</p>}
          </div>

          <label className="ra-vs-check" style={{ marginTop: 14 }}>
            <input
              type="checkbox"
              checked={wantInstrumental}
              disabled={stage !== 'idle'}
              onChange={(e) => setWantInstrumental(e.target.checked)}
            />
            <span>Also return the instrumental (everything except the vocals)</span>
          </label>

          <fieldset className="ra-vs-consent" style={{ marginTop: 14 }}>
            <label className="ra-vs-check">
              <input
                type="checkbox"
                checked={consent}
                disabled={stage !== 'idle'}
                onChange={(e) => setConsent(e.target.checked)}
              />
              <span>{voiceIsolateApi.getConsentText()}</span>
            </label>
          </fieldset>

          <p className="ra-small" style={{ marginTop: 12 }}>
            Supported formats: {AUDIO_RULES.isolate.label}. Max {AUDIO_RULES.isolate.maxMb} MB. Limit: 10 clips per hour.
          </p>
          <PriceNote tool="voiceIsolate" />

          <div className="ra-cta" style={{ marginTop: 16 }}>
            {stage === 'idle' && (
              <button className="ra-btn solid" disabled={!!validate()} onClick={submit}>Isolate voice</button>
            )}
            {busy && (
              <button className="ra-btn solid" disabled>
                {stage === 'uploading' ? 'Sending file...' : `Isolating... ${elapsed}s`}
              </button>
            )}
            {(stage === 'ready' || stage === 'failed') && (
              <button className="ra-btn ghost" onClick={reset}>Isolate another</button>
            )}
          </div>

          {stage === 'polling' && <Working title="Isolating vocals">Demucs is separating your audio. This usually takes under a minute.</Working>}

          {stage === 'ready' && (
            <div style={{ marginTop: 16, display: 'grid', gap: 16 }}>
              {stemLabels.map(([stem, label]) => stems[stem] && (
                <div key={stem}>
                  <p className="ra-small" style={{ fontWeight: 600, marginBottom: 6 }}>{label}</p>
                  <div className="ra-vs-samples">
                    <div className="ra-vs-sample"><audio controls src={stems[stem]} className="w-full" /></div>
                  </div>
                  <div className="ra-cta" style={{ marginTop: 8 }}>
                    <a className="ra-btn ghost" href={stems[stem]} download={`${stem}-${jobId?.slice(0, 8)}.wav`}>
                      Download {label.toLowerCase()} WAV
                    </a>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
