'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import {
  voiceConvertApi,
  type ConversionJob,
  type UserConfig,
} from '@/lib/voiceConvertApi'

type Stage = 'idle' | 'config' | 'uploading' | 'polling' | 'ready' | 'failed'

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

  // Config
  const [config, setConfig] = useState<UserConfig | null | undefined>(undefined)
  const [showConfig, setShowConfig] = useState(false)
  const [modalUrl, setModalUrl] = useState('')
  const [modalSecret, setModalSecret] = useState('')
  const [configSaving, setConfigSaving] = useState(false)

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

  const loadConfig = useCallback(async () => {
    try {
      const cfg = await voiceConvertApi.getConfig()
      setConfig(cfg)
      if (cfg) { setModalUrl(cfg.modal_url); setShowConfig(false) }
    } catch {
      setConfig(null)
    }
  }, [])

  useEffect(() => {
    if (sessionEmail) loadConfig()
  }, [sessionEmail, loadConfig])

  const saveConfig = async () => {
    setConfigSaving(true); setError(null)
    try {
      const cfg = await voiceConvertApi.saveConfig({
        modal_url: modalUrl.trim(),
        modal_secret: modalSecret.trim(),
      })
      setConfig(cfg)
      setModalSecret('')
      setShowConfig(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save configuration.')
    } finally { setConfigSaving(false) }
  }

  const deleteConfig = async () => {
    try { await voiceConvertApi.removeConfig(); setConfig(null); setModalUrl('') } catch {}
  }

  const validate = useCallback((): string | null => {
    if (!config) return 'Configure your Modal app first.'
    if (!sourceFile) return 'Choose a source audio file.'
    if (!targetFile) return 'Choose a target voice reference file.'
    if (!isValidAudio(sourceFile)) return `Source file type not supported: ${sourceFile.name}`
    if (!isValidAudio(targetFile)) return `Target file type not supported: ${targetFile.name}`
    if (sourceFile.size > 25 * 1024 * 1024) return `Source file too large: ${fmtSize(sourceFile.size)} (max 25 MB).`
    if (targetFile.size > 25 * 1024 * 1024) return `Target file too large: ${fmtSize(targetFile.size)} (max 25 MB).`
    if (!consent) return 'You must confirm the consent statement to continue.'
    return null
  }, [sourceFile, targetFile, consent, config])

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

  const reset = () => {
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

      {/* Config banner */}
      {config === undefined ? (
        <p className="ra-small">Loading configuration…</p>
      ) : config === null ? (
        <div className="ra-vs-card" style={{ marginBottom: 20 }}>
          <h3>Voice conversion not set up</h3>
          <p className="ra-lede" style={{ fontSize: '1rem' }}>
            ReadAloud AI does not run a shared conversion server. You deploy your own Modal app
            (free GPU credits available) and we proxy requests to it. Your audio never touches our servers.
          </p>
          {!showConfig ? (
            <div className="ra-cta">
              <button className="ra-btn solid" onClick={() => setShowConfig(true)}>
                Configure my Modal app
              </button>
            </div>
          ) : (
            <ConfigForm
              modalUrl={modalUrl}
              setModalUrl={setModalUrl}
              modalSecret={modalSecret}
              setModalSecret={setModalSecret}
              saving={configSaving}
              onSave={saveConfig}
              onCancel={() => setShowConfig(false)}
            />
          )}
        </div>
      ) : (
        <div className="ra-vs-card" style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span className="ra-vs-pill ready" style={{ fontSize: '.75rem' }}>
              Configured
            </span>
            <span className="ra-small">{config.modal_url}</span>
            <div style={{ marginLeft: 'auto' }} className="ra-cta">
              <button className="ra-btn ghost" onClick={() => setShowConfig(true)}>Update</button>
              <button className="ra-btn ghost danger" onClick={deleteConfig}>Remove</button>
            </div>
          </div>
          {showConfig && (
            <div style={{ marginTop: 12, borderTop: '1px solid var(--hair)' }}>
              <ConfigForm
                modalUrl={modalUrl}
                setModalUrl={setModalUrl}
                modalSecret={modalSecret}
                setModalSecret={setModalSecret}
                saving={configSaving}
                onSave={saveConfig}
                onCancel={() => setShowConfig(false)}
              />
            </div>
          )}
        </div>
      )}

      {/* Conversion form */}
      {config && !showConfig && (
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
              <button className="ra-btn ghost" onClick={reset}>
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
                  <p>Seed-VC is processing your audio on your Modal app. This usually takes 20–30 seconds.</p>
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

function ConfigForm({
  modalUrl,
  setModalUrl,
  modalSecret,
  setModalSecret,
  saving,
  onSave,
  onCancel,
}: {
  modalUrl: string
  setModalUrl: (v: string) => void
  modalSecret: string
  setModalSecret: (v: string) => void
  saving: boolean
  onSave: () => void
  onCancel: () => void
}) {
  return (
    <div style={{ marginTop: 12 }}>
      <div className="ra-vs-form two">
        <label>
          Modal app URL
          <input
            type="url"
            value={modalUrl}
            onChange={(e) => setModalUrl(e.target.value)}
            placeholder="https://your-name--voice-convert-api.modal.run"
            disabled={saving}
          />
        </label>
        <label>
          Modal secret (Bearer token)
          <input
            type="password"
            value={modalSecret}
            onChange={(e) => setModalSecret(e.target.value)}
            placeholder="sk-..."
            disabled={saving}
          />
        </label>
      </div>
      <p className="ra-small" style={{ marginTop: 8 }}>
        To get these: run <code className="inl">modal deploy voice-pipeline/convert_job.py</code> in
        your own clone, then copy the URL and the <code className="inl">CONVERT_SECRET</code> you set
        in Modal secrets. Your audio runs on your Modal account, not ours.
      </p>
      <div className="ra-cta" style={{ marginTop: 12 }}>
        <button className="ra-btn solid" disabled={saving || !modalUrl.trim() || !modalSecret.trim()} onClick={onSave}>
          {saving ? 'Saving…' : 'Save configuration'}
        </button>
        <button className="ra-btn ghost" onClick={onCancel} disabled={saving}>Cancel</button>
      </div>
    </div>
  )
}
