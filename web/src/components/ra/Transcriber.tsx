'use client'

import { useMemo, useState } from 'react'
import { sttApi, buildCues, toSrt, toVtt, fmtClock, type Transcription } from '@/lib/sttApi'
import { AUDIO_RULES, acceptAttr, fmtSize, validateAudio } from '@/lib/audioFiles'
import {
  ErrorNotice, LoadingCard, PriceNote, SignInGate, Working, downloadText, toUiError, useSessionEmail,
  type UiError,
} from './ToolShared'

type Stage = 'idle' | 'working' | 'done'

export default function Transcriber() {
  const email = useSessionEmail()
  const [file, setFile] = useState<File | null>(null)
  const [language, setLanguage] = useState('')
  const [wordTimestamps, setWordTimestamps] = useState(true)
  const [stage, setStage] = useState<Stage>('idle')
  const [result, setResult] = useState<Transcription | null>(null)
  const [error, setError] = useState<UiError | null>(null)
  const [copied, setCopied] = useState(false)

  const cues = useMemo(() => (result ? buildCues(result) : []), [result])

  const validate = (): string | null => {
    if (!file) return 'Choose an audio file.'
    const fileErr = validateAudio(file, AUDIO_RULES.stt)
    if (fileErr) return fileErr
    const lang = language.trim().toLowerCase()
    if (lang && !/^[a-z]{2}$/.test(lang)) return 'Language hint must be a two-letter ISO code such as "en", or empty for auto-detect.'
    return null
  }

  const submit = async () => {
    const problem = validate()
    if (problem) { setError({ message: problem, subscription: false }); return }
    setError(null); setStage('working'); setResult(null)
    try {
      const r = await sttApi.transcribe({
        audio: file!,
        language: language.trim().toLowerCase() || undefined,
        wordTimestamps,
      })
      setResult(r); setStage('done')
    } catch (e) {
      setStage('idle')
      setError(toUiError(e, 'Transcription failed.'))
    }
  }

  const reset = () => {
    setFile(null); setLanguage(''); setResult(null); setError(null); setStage('idle'); setCopied(false)
  }

  const copy = async () => {
    if (!result) return
    try {
      await navigator.clipboard.writeText(result.text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError({ message: 'Could not copy. Select the text and copy it manually.', subscription: false })
    }
  }

  const baseName = (file?.name ?? 'transcript').replace(/\.[^.]+$/, '')

  if (email === undefined) return <LoadingCard />
  if (!email) return <SignInGate title="Sign in to transcribe audio" />

  return (
    <div className="ra-vs">
      <ErrorNotice error={error} />

      <div className="ra-vs-card">
        <div className="ra-vs-form two" style={{ marginTop: 0 }}>
          <div>
            <label>
              Audio file
              <input
                type="file"
                accept={acceptAttr(AUDIO_RULES.stt)}
                disabled={stage === 'working'}
                onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(null) }}
              />
            </label>
            {file && <p className="ra-small" style={{ marginTop: 4 }}>{file.name} · {fmtSize(file.size)}</p>}
          </div>
          <div>
            <label>
              Language (optional)
              <input
                type="text"
                value={language}
                maxLength={2}
                placeholder="auto-detect, or e.g. en"
                disabled={stage === 'working'}
                onChange={(e) => setLanguage(e.target.value)}
              />
            </label>
          </div>
        </div>

        <label className="ra-vs-check" style={{ marginTop: 14 }}>
          <input
            type="checkbox"
            checked={wordTimestamps}
            disabled={stage === 'working'}
            onChange={(e) => setWordTimestamps(e.target.checked)}
          />
          <span>Include word timestamps (needed for SRT/VTT subtitles when the server does not return segments)</span>
        </label>

        <p className="ra-small" style={{ marginTop: 12 }}>
          Supported formats: {AUDIO_RULES.stt.label}. Max {AUDIO_RULES.stt.maxMb} MB. Limit: 20 transcriptions per hour.
        </p>
        <PriceNote tool="speechToText" />

        <div className="ra-cta" style={{ marginTop: 16 }}>
          {stage === 'idle' && (
            <button className="ra-btn solid" onClick={submit} disabled={!file}>Transcribe</button>
          )}
          {stage === 'working' && <button className="ra-btn solid" disabled>Transcribing...</button>}
          {stage === 'done' && <button className="ra-btn ghost" onClick={reset}>Transcribe another</button>}
        </div>

        {stage === 'working' && (
          <Working title="Transcribing">
            Keep this tab open. Long files can take several minutes, and the first request after a quiet period
            can take about ten extra seconds while a GPU starts.
          </Working>
        )}
      </div>

      {stage === 'done' && result && (
        <div className="ra-vs-card" style={{ marginTop: 20 }}>
          <p className="ra-small">
            Language: {result.language}
            {result.language_probability != null && ` (${Math.round(result.language_probability * 100)}% confidence)`}
            {' · '}Duration: {fmtClock(result.duration)}
          </p>

          <label htmlFor="ra-transcript" className="ra-small" style={{ display: 'block', marginTop: 12, fontWeight: 600 }}>
            Transcript
          </label>
          <textarea
            id="ra-transcript"
            readOnly
            value={result.text}
            rows={12}
            style={{ width: '100%', marginTop: 6, font: 'inherit', padding: 12, borderRadius: 10, border: '1.5px solid var(--line)' }}
          />

          <div className="ra-cta" style={{ marginTop: 12, flexWrap: 'wrap' }}>
            <button className="ra-btn ghost" onClick={copy}>{copied ? 'Copied' : 'Copy text'}</button>
            <button className="ra-btn ghost" onClick={() => downloadText(`${baseName}.txt`, result.text)}>Download .txt</button>
            <button
              className="ra-btn ghost"
              disabled={cues.length === 0}
              onClick={() => downloadText(`${baseName}.srt`, toSrt(cues), 'application/x-subrip')}
            >
              Download .srt
            </button>
            <button
              className="ra-btn ghost"
              disabled={cues.length === 0}
              onClick={() => downloadText(`${baseName}.vtt`, toVtt(cues), 'text/vtt')}
            >
              Download .vtt
            </button>
          </div>
          {cues.length === 0 && (
            <p className="ra-small" style={{ marginTop: 8 }}>
              No timing data came back, so subtitle files are unavailable. Run again with word timestamps on.
            </p>
          )}

          {result.words && result.words.length > 0 && (
            <details style={{ marginTop: 16 }}>
              <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Word timestamps ({result.words.length} words)</summary>
              <div style={{ maxHeight: 320, overflow: 'auto', marginTop: 8 }} className="ra-table-wrap">
                <table className="ra-table">
                  <thead><tr><th>Word</th><th>Start (s)</th><th>End (s)</th></tr></thead>
                  <tbody>
                    {result.words.map((w, i) => (
                      <tr key={i}><td>{w.word}</td><td>{w.start.toFixed(2)}</td><td>{w.end.toFixed(2)}</td></tr>
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
