'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import {
  voiceConvertApi,
  type ConversionJob,
  type Deployment,
} from '@/lib/voiceConvertApi'

type Stage = 'idle' | 'uploading' | 'polling' | 'ready' | 'failed'

const ALLOWED_TYPES = ['audio/wav', 'audio/flac', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/m4a']
const ALLOWED_EXT = ['.wav', '.flac', '.ogg', '.mp3', '.m4a', '.mp4']

function isValidAudio(file: File): boolean {
  if (ALLOWED_TYPES.includes(file.type)) return true
  const name = file.name.toLowerCase()
  return ALLOWED_EXT.some((ext) => name.endsWith(ext))
}

function fmtSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function VoiceConverter() {
  const [sessionEmail, setSessionEmail] = useState<string | null>(null)

  // Deployment
  const [deployment, setDeployment] = useState<Deployment | null | undefined>(undefined)
  const [deploying, setDeploying] = useState(false)
  const [destroying, setDestroying] = useState(false)

  // Conversion
  const [sourceFile, setSourceFile] = useState<File | null>(null)
  const [targetFile, setTargetFile] = useState<File | null>(null)
  const [consent, setConsent] = useState(false)
  const [stage, setStage] = useState<Stage>('idle')
  const [jobId, setJobId] = useState<string | null>(null)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<string>('')
  const cancelled = useRef(false)

  useEffect(() => {
    cancelled.current = false
    supabase.auth.getSession().then(({ data }) => {
      setSessionEmail(data.session?.user.email ?? null)
    })
  }, [])

  const loadDeployment = useCallback(async () => {
    try {
      const dep = await voiceConvertApi.getDeployment()
      setDeployment(dep)
      if (dep?.status === 'deploying') {
        // Poll deployment status
        pollDeployment()
      }
    } catch {
      setDeployment(null)
    }
  }, [])

  useEffect(() => {
    if (sessionEmail) loadDeployment()
  }, [sessionEmail, loadDeployment])

  const pollDeployment = useCallback(async () => {
    let attempts = 0
    const interval = setInterval(async () => {
      if (cancelled.current) { clearInterval(interval); return }
      try {
        const dep = await voiceConvertApi.getDeployment()
        setDeployment(dep)
        if (dep?.status === 'ready' || dep?.status === 'failed' || dep == null) {
          clearInterval(interval)
          setDeploying(false)
        }
      } catch {
        // keep polling
      }
      attempts++
      if (attempts > 60) { clearInterval(interval); setDeploying(false) }
    }, 3000)
  }, [])

  const deploy = async () => {
    setError(null); setDeploying(true)
    try {
      const dep = await voiceConvertApi.deploy()
      setDeployment(dep)
      if (dep.status === 'deploying') {
        pollDeployment()
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not start deployment.')
      setDeploying(false)
    }
  }

  const destroy = async () => {
    setError(null); setDestroying(true)
    try {
      await voiceConvertApi.destroy()
      setDeployment(null)
      resetConversion()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not destroy deployment.')
    } finally { setDestroying(false) }
  }

  // ------------------------------------------------------------------------
  // Conversion
  // ------------------------------------------------------------------------

  const validate = useCallback((): string | null => {
    if (!deployment || deployment.status !== 'ready') return 'Deploy a converter first.'
    if (!sourceFile) return 'Choose a source audio file.'
    if (!targetFile) return 'Choose a target voice reference file.'
    if (!isValidAudio(sourceFile)) return `Source file type not supported: ${sourceFile.name}`
    if (!isValidAudio(targetFile)) return `Target file type not supported: ${targetFile.name}`
    if (sourceFile.size > 25 * 1024 * 1024) return `Source file too large: ${fmtSize(sourceFile.size)} (max 25 MB).`
    if (targetFile.size > 25 * 1024 * 1024) return `Target file too large: ${fmtSize(targetFile.size)} (max 25 MB).`
    if (!consent) return 'You must confirm the consent statement to continue.'
    return null
  }, [sourceFile, targetFile, consent, deployment])

  const submit = async () => {
    if (cancelled.current) return
    const validation = validate()
    if (validation) { setError(validation); return }
    setError(null); setStage('uploading'); setProgress('Sending files…')
    try {
      const { job_id } = await voiceConvertApi.create({
        source: sourceFile!,
        target: targetFile!,
      })
      setJobId(job_id); setStage('polling'); setProgress('Converting voice…')

      let ticks = 0
      const interval = setInterval(async () => {
        if (cancelled.current) { clearInterval(interval); return }
        try {
          const s = await voiceConvertApi.poll(job_id)
          if (s.status === 'done') {
            clearInterval(interval)
            const url = await voiceConvertApi.audio(job_id)
            setAudioUrl(url); setStage('ready')
          } else if (s.status === 'failed') {
            clearInterval(interval)
            setStage('failed')
            setError(s.stderr_tail || 'Conversion failed. Try different audio files.')
          } else {
            ticks++
            setProgress(`Converting voice… ${ticks * 2}s`)
          }
        } catch {
          // keep polling on transient errors
        }
      }, 2000)

      setTimeout(() => {
        clearInterval(interval)
        if (stage === 'polling') { setStage('failed'); setError('Conversion timed out. Please try again.') }
      }, 120000)
    } catch (e: unknown) {
      setStage('idle')
      setError(e instanceof Error ? e.message : 'Could not start conversion.')
    }
  }

  const resetConversion = () => {
    setSourceFile(null)
    setTargetFile(null)
    setConsent(false)
    setStage('idle')
    setJobId(null)
    setAudioUrl(null)
    setError(null)
    setProgress('')
  }

  if (!sessionEmail) {
    return (
      <div className="ra-vs-card" style={{ maxWidth: 460 }}>
        <h2>Sign in to convert voices</h2>
        <p className="ra-lede" style={{ fontSize: '1rem' }}>Use the same ReadAloud AI account as your API keys.</p>
        <a className="ra-btn solid" href="/app">Sign in</a>
      </div>
    )
  }

  return (
    <div className="ra-vs">
      {error && <p className="ra-err" role="alert">{error}</p>}

      {/* Deployment section */}
      <div className="ra-vs-card" style={{ marginBottom: 20 }}>
        <h3 style={{ marginBottom: 8 }}>Your voice converter</h3>
        {deployment === undefined ? (
          <p className="ra-small">Checking deployment…</p>
        ) : deployment === null ? (
          <>
            <p className="ra-lede" style={{ fontSize: '1rem' }}>
              Deploy your own GPU-powered voice converter. It runs on your own Modal account
              (free credits available) and shuts down when not in use. Audio never touches our servers.
            </p>
            <div className="ra-cta" style={{ marginTop: 12 }}>
              <button className="ra-btn solid" onClick={deploy} disabled={deploying}>
                {deploying ? 'Deploying…' : 'Deploy converter'}
              </button>
            </div>
          </>
        ) : deployment.status === 'deploying' ? (
          <div className="ra-vs-training" style={{ marginTop: 8 }}>
            <div className="ra-vs-spin" aria-hidden="true" />
            <div>
              <h3 style={{ margin: 0 }}>Deploying converter</h3>
              <p>Building your Seed-VC GPU container. This takes 1–2 minutes.</p>
            </div>
          </div>
        ) : deployment.status === 'ready' ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <span className="ra-vs-pill ready" style={{ fontSize: '.75rem' }}>
                Ready
              </span>
              <span className="ra-small">{deployment.modal_url}</span>
              <div style={{ marginLeft: 'auto' }} className="ra-cta">
                <button className="ra-btn ghost danger" onClick={destroy} disabled={destroying}>
                  {destroying ? 'Stopping…' : 'Stop converter'}
                </button>
              </div>
            </div>
            <p className="ra-small" style={{ marginTop: 8 }}>
              Your converter only costs money while processing audio. Keep it stopped when not in use.
            </p>
          </>
        ) : deployment.status === 'failed' ? (
          <>
            <p className="ra-vs-notice bad" role="alert">
              Deployment failed. Try again or contact support.
            </p>
            <div className="ra-cta">
              <button className="ra-btn solid" onClick={deploy} disabled={deploying}>
                Retry deployment
              </button>
            </div>
          </>
        ) : (
          <p className="ra-small">Status: {deployment.status}</p>
        )}
      </div>

      {/* Conversion form */}
      {deployment?.status === 'ready' && (
        <div className="ra-vs-card">
          <div className="ra-vs-form two" style={{ marginBottom: 20 }}>
            <div>
              <label>
                Source audio — the speech you want to convert
                <input
                  type="file"
                  accept=".wav,.flac,.ogg,.mp3,.m4a,.mp4"
                  onChange={(e) => { setSourceFile(e.target.files?.[0] ?? null); setError(null) }}
                  disabled={stage !== 'idle'}
                  style={{ marginTop: 6 }}
                />
              </label>
              {sourceFile && (
                <p className="ra-small" style={{ marginTop: 4 }}>
                  {sourceFile.name} · {fmtSize(sourceFile.size)}
                </p>
              )}
            </div>

            <div>
              <label>
                Target voice — the voice you want to sound like
                <input
                  type="file"
                  accept=".wav,.flac,.ogg,.mp3,.m4a,.mp4"
                  onChange={(e) => { setTargetFile(e.target.files?.[0] ?? null); setError(null) }}
                  disabled={stage !== 'idle'}
                  style={{ marginTop: 6 }}
                />
              </label>
              {targetFile && (
                <p className="ra-small" style={{ marginTop: 4 }}>
                  {targetFile.name} · {fmtSize(targetFile.size)}
                </p>
              )}
            </div>
          </div>

          <fieldset className="ra-vs-consent" style={{ marginTop: 8 }}>
            <label className="ra-vs-check">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                disabled={stage !== 'idle'}
              />
              <span>
                I confirm that I have the legal right to use both the source audio and the target voice reference,
                and that this conversion does not impersonate any person without their consent.
              </span>
            </label>
          </fieldset>

          <p className="ra-small" style={{ marginTop: 12 }}>
            Supported formats: WAV, FLAC, OGG, MP3, M4A. Max 25 MB each. Conversions are billed at $0.05 each.
          </p>

          <div className="ra-cta" style={{ marginTop: 16 }}>
            {stage === 'idle' && (
              <button className="ra-btn solid" disabled={!!validate()} onClick={submit}>
                Convert voice
              </button>
            )}
            {(stage === 'uploading' || stage === 'polling') && (
              <button className="ra-btn solid" disabled>
                {progress}
              </button>
            )}
            {(stage === 'ready' || stage === 'failed') && (
              <button className="ra-btn ghost" onClick={resetConversion}>
                Convert another
              </button>
            )}
          </div>

          {stage === 'polling' && (
            <div role="status" aria-live="polite" style={{ marginTop: 16 }}>
              <div className="ra-vs-training">
                <div className="ra-vs-spin" aria-hidden="true" />
                <div>
                  <h3 style={{ margin: 0 }}>Converting voice</h3>
                  <p>Seed-VC is processing your audio. This usually takes 20–30 seconds.</p>
                </div>
              </div>
            </div>
          )}

          {stage === 'ready' && audioUrl && (
            <div style={{ marginTop: 16 }}>
              <div className="ra-vs-samples">
                <div className="ra-vs-sample">
                  <audio controls src={audioUrl} className="w-full" />
                </div>
              </div>
              <div className="ra-cta" style={{ marginTop: 12 }}>
                <a className="ra-btn ghost" href={audioUrl} download={`converted-${jobId?.slice(0, 8)}.wav`}>
                  Download WAV
                </a>
              </div>
            </div>
          )}

          {stage === 'failed' && !error && (
            <p className="ra-vs-notice bad" role="alert" style={{ marginTop: 16 }}>
              Conversion failed. Try different audio files or check that both are clear speech recordings.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
