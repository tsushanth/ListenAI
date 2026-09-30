'use client'

import { useEffect, useRef, useState } from 'react'
import { dubApi, type DubResult } from '@/lib/dubApi'
import { AUDIO_RULES, acceptAttr, fmtSize, validateAudio } from '@/lib/audioFiles'
import { ApiError, pollUntil, toObjectUrl } from '@/lib/toolsApiCommon'
import {
  ErrorNotice, LoadingCard, PriceNote, SignInGate, Working, toUiError, useSessionEmail, useUnmountFlag,
  type UiError,
} from './ToolShared'

type Stage = 'idle' | 'uploading' | 'processing' | 'ready'

// The backend accepts any 2-40 char language name/code and hands it to a translation model.
const LANGUAGES = [
  'Spanish', 'French', 'German', 'Italian', 'Portuguese', 'Dutch', 'Polish', 'Russian', 'Ukrainian',
  'Turkish', 'Arabic', 'Hindi', 'Bengali', 'Japanese', 'Korean', 'Chinese', 'Vietnamese', 'Indonesian',
  'Swedish', 'Norwegian', 'Danish', 'Finnish', 'Greek', 'Hebrew', 'Thai', 'English',
]

export default function Dubber() {
  const email = useSessionEmail()
  const cancelled = useUnmountFlag()
  const [file, setFile] = useState<File | null>(null)
  const [target, setTarget] = useState('Spanish')
  const [source, setSource] = useState('')
  const [stage, setStage] = useState<Stage>('idle')
  const [jobId, setJobId] = useState<string | null>(null)
  const [result, setResult] = useState<DubResult | null>(null)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [error, setError] = useState<UiError | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const urlRef = useRef<string | null>(null)

  useEffect(() => () => { if (urlRef.current?.startsWith('blob:')) URL.revokeObjectURL(urlRef.current) }, [])

  useEffect(() => {
    if (stage !== 'uploading' && stage !== 'processing') return
    const t0 = Date.now()
    setElapsed(0)
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000)
    return () => clearInterval(id)
  }, [stage])

  const validate = (): string | null => {
    if (!file) return 'Choose an audio file.'
    const fileErr = validateAudio(file, AUDIO_RULES.dub)
    if (fileErr) return fileErr
    if (target.trim().length < 2) return 'Choose a target language.'
    const src = source.trim()
    if (src && (src.length < 2 || src.length > 10)) return 'Source language must be 2-10 characters (for example "en"), or empty for auto-detect.'
    return null
  }

  const submit = async () => {
    const problem = validate()
    if (problem) { setError({ message: problem, subscription: false }); return }
    setError(null); setResult(null); setAudioUrl(null); setStage('uploading')
    let submitted = false
    try {
      const job = await dubApi.create({
        audio: file!,
        targetLanguage: target.trim(),
        sourceLanguage: source.trim() || undefined,
      })
      submitted = true
      setJobId(job.job_id); setStage('processing')

      // Dubbing = transcribe + translate + synthesize each segment; allow up to 20 minutes.
      const final = await pollUntil<DubResult>(async () => {
        const r = await dubApi.get(job.job_id)
        return r.status === 'processing' ? undefined : r
      }, { intervalMs: 3000, maxMs: 20 * 60_000, isCancelled: cancelled })

      if (cancelled()) return
      if (!final) throw new Error('Dubbing is taking longer than expected. Try a shorter file.')
      if (final.status === 'failed') throw new Error(final.error || 'Dubbing failed. Try a different file.')

      setResult(final)
      if (final.audio_url) {
        const url = await toObjectUrl(final.audio_url)
        urlRef.current = url
        setAudioUrl(url)
      }
      setStage('ready')
    } catch (e) {
      const ui = toUiError(e, 'Dubbing failed.')
      // dub jobs live in server memory; a 404 while polling means the server restarted.
      if (e instanceof ApiError && e.status === 404 && submitted) {
        ui.message = 'The dubbing job was lost (the server may have restarted). Please submit the file again.'
      }
      setStage('idle')
      setError(ui)
    }
  }

  const reset = () => {
    setFile(null); setResult(null); setAudioUrl(null); setJobId(null); setError(null); setStage('idle')
  }

  if (email === undefined) return <LoadingCard />
  if (!email) return <SignInGate title="Sign in to dub audio" />

  const busy = stage === 'uploading' || stage === 'processing'

  return (
    <div className="ra-vs">
      <ErrorNotice error={error} />

      <div className="ra-vs-card">
        <div className="ra-vs-form two" style={{ marginTop: 0 }}>
          <div>
            <label>
              Source audio
              <input
                type="file"
                accept={acceptAttr(AUDIO_RULES.dub)}
                disabled={busy}
                onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(null) }}
              />
            </label>
            {file && <p className="ra-small" style={{ marginTop: 4 }}>{file.name} · {fmtSize(file.size)}</p>}
          </div>
          <div>
            <label>
              Target language
              <select
                value={target}
                disabled={busy}
                onChange={(e) => setTarget(e.target.value)}
                style={{ font: 'inherit', padding: '11px 13px', borderRadius: 10, border: '1.5px solid var(--line)', background: '#fff' }}
              >
                {LANGUAGES.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </label>
          </div>
        </div>
        <div className="ra-vs-form" style={{ marginTop: 14, maxWidth: 320 }}>
          <label>
            Source language (optional)
            <input
              type="text"
              value={source}
              maxLength={10}
              placeholder="auto-detect, or e.g. en"
              disabled={busy}
              onChange={(e) => setSource(e.target.value)}
            />
          </label>
        </div>

        <p className="ra-small" style={{ marginTop: 12 }}>
          Supported formats: {AUDIO_RULES.dub.label}. Max {AUDIO_RULES.dub.maxMb} MB. Audio in, audio out: the source is
          transcribed, translated, and re-voiced segment by segment with a default English text-to-speech voice, so
          treat the result as a draft rather than a studio dub.
        </p>
        <PriceNote tool="dubbing" />

        <div className="ra-cta" style={{ marginTop: 16 }}>
          {stage === 'idle' && <button className="ra-btn solid" onClick={submit} disabled={!file}>Dub audio</button>}
          {busy && <button className="ra-btn solid" disabled>{stage === 'uploading' ? 'Uploading...' : `Dubbing... ${elapsed}s`}</button>}
          {stage === 'ready' && <button className="ra-btn ghost" onClick={reset}>Dub another</button>}
        </div>

        {stage === 'processing' && (
          <Working title="Dubbing in progress">
            Transcribing, translating, and synthesizing. This usually takes a few minutes for a few minutes of audio.
          </Working>
        )}
      </div>

      {stage === 'ready' && result && (
        <div className="ra-vs-card" style={{ marginTop: 20 }}>
          {audioUrl ? (
            <>
              <div className="ra-vs-samples">
                <div className="ra-vs-sample"><audio controls src={audioUrl} className="w-full" /></div>
              </div>
              <div className="ra-cta" style={{ marginTop: 12 }}>
                <a className="ra-btn ghost" href={audioUrl} download={`dubbed-${target.toLowerCase()}-${jobId?.slice(0, 8)}.wav`}>
                  Download WAV
                </a>
              </div>
              <p className="ra-small" style={{ marginTop: 8 }}>The result link is temporary; download it now.</p>
            </>
          ) : (
            <p className="ra-vs-notice bad" role="alert">The dub finished but no audio link was returned. Please try again.</p>
          )}

          {result.segments && result.segments.length > 0 && (
            <details style={{ marginTop: 16 }}>
              <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Translated segments ({result.segments.length})</summary>
              <div style={{ maxHeight: 360, overflow: 'auto', marginTop: 8 }} className="ra-table-wrap">
                <table className="ra-table">
                  <thead><tr><th>Time</th><th>Original</th><th>Translation</th></tr></thead>
                  <tbody>
                    {result.segments.map((s) => (
                      <tr key={s.index}>
                        <td>{s.start_sec.toFixed(1)}-{s.end_sec.toFixed(1)}s</td>
                        <td>{s.source_text}</td>
                        <td>{s.translated_text}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  )
}
