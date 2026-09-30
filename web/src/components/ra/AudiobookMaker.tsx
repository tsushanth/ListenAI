'use client'

import { useEffect, useRef, useState } from 'react'
import {
  audiobooksApi, MAX_BODY_BYTES, MAX_EPUB_BYTES, MAX_SPEED, MAX_TITLE, MIN_SPEED,
  type AudiobookExport, type AudiobookProgress, type VoiceOption,
} from '@/lib/audiobooksApi'
import { fmtSize } from '@/lib/audioFiles'
import { pollUntil, toObjectUrl } from '@/lib/toolsApiCommon'
import {
  ErrorNotice, LoadingCard, PriceNote, SignInGate, Working, toUiError, useSessionEmail, useUnmountFlag,
  type UiError,
} from './ToolShared'

type Source = 'text' | 'epub'
type Stage = 'idle' | 'creating' | 'processing' | 'ready' | 'exporting' | 'exported'

const STATUS_LABEL: Record<string, string> = {
  pending: 'Waiting',
  queued: 'Queued',
  processing: 'Generating',
  ready: 'Ready',
  failed: 'Failed',
  canceled: 'Canceled',
}

function fmtDuration(sec: number | null | undefined): string {
  if (sec == null) return ''
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s % 60}s`
}

export default function AudiobookMaker() {
  const email = useSessionEmail()
  const cancelled = useUnmountFlag()

  const [voices, setVoices] = useState<VoiceOption[]>([])
  const [voicesError, setVoicesError] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [voiceId, setVoiceId] = useState('')
  const [speed, setSpeed] = useState(1)
  const [source, setSource] = useState<Source>('text')
  const [text, setText] = useState('')
  const [epub, setEpub] = useState<File | null>(null)

  const [stage, setStage] = useState<Stage>('idle')
  const [progress, setProgress] = useState<AudiobookProgress | null>(null)
  const [exported, setExported] = useState<AudiobookExport | null>(null)
  const [mp3Url, setMp3Url] = useState<string | null>(null)
  const [error, setError] = useState<UiError | null>(null)
  const urlRef = useRef<string | null>(null)

  useEffect(() => () => { if (urlRef.current?.startsWith('blob:')) URL.revokeObjectURL(urlRef.current) }, [])

  useEffect(() => {
    audiobooksApi.listVoices()
      .then((v) => {
        setVoices(v)
        setVoiceId((cur) => cur || v[0]?.id || '')
      })
      .catch((e) => setVoicesError(e instanceof Error ? e.message : 'Could not load voices.'))
  }, [])

  const validate = (): string | null => {
    if (!title.trim()) return 'Give your audiobook a title.'
    if (title.trim().length > MAX_TITLE) return `Title is too long (max ${MAX_TITLE} characters).`
    if (!voiceId) return 'Choose a voice.'
    if (!(speed >= MIN_SPEED && speed <= MAX_SPEED)) return `Speed must be between ${MIN_SPEED} and ${MAX_SPEED}.`
    if (source === 'text') {
      if (!text.trim()) return 'Paste the text of your book.'
      if (new Blob([text]).size > MAX_BODY_BYTES - 2_000) {
        return 'Text is too long for one submission (limit is about 1 MB). Split the book into parts.'
      }
    } else {
      if (!epub) return 'Choose an EPUB file.'
      if (!epub.name.toLowerCase().endsWith('.epub')) return `Not an EPUB file: ${epub.name}.`
      if (epub.size === 0) return 'The EPUB file is empty.'
      if (epub.size > MAX_EPUB_BYTES) {
        return `EPUB too large: ${fmtSize(epub.size)} (max ${fmtSize(MAX_EPUB_BYTES)} from the browser).`
      }
    }
    return null
  }

  const submit = async () => {
    const problem = validate()
    if (problem) { setError({ message: problem, subscription: false }); return }
    setError(null); setProgress(null); setExported(null); setMp3Url(null); setStage('creating')
    try {
      const created = await audiobooksApi.create({
        title: title.trim(),
        voiceId,
        speed,
        source: source === 'text' ? { type: 'text', text } : { type: 'epub', file: epub! },
      })
      if (created.status === 'failed') {
        throw new Error('Some chapters could not be queued. Please try again.')
      }
      setStage('processing')
      setProgress({
        audiobook_id: created.audiobook_id,
        status: 'processing',
        chapter_count: created.chapter_count,
        chapters_completed: 0,
        overall_percentage: 0,
        export_status: 'not_started',
        chapters: created.chapters.map((c) => ({
          id: c.id, sequence: c.sequence, title: c.title, status: 'queued', percentage: 0,
          duration_seconds: null, error_message: null,
        })),
      })

      const final = await pollUntil<AudiobookProgress>(async () => {
        const s = await audiobooksApi.status(created.audiobook_id)
        setProgress(s)
        return s.status === 'completed' || s.status === 'failed' ? s : undefined
      }, { intervalMs: 4000, maxMs: 2 * 60 * 60_000, isCancelled: cancelled })

      if (cancelled()) return
      if (!final) throw new Error('Still generating after a long time. Come back later; your audiobook keeps processing.')
      if (final.status === 'failed') {
        setStage('idle')
        setError({ message: 'One or more chapters failed. See the chapter list for details.', subscription: false })
        return
      }
      setStage('ready')
    } catch (e) {
      setStage('idle')
      setError(toUiError(e, 'Could not create the audiobook.'))
    }
  }

  const exportMp3 = async () => {
    if (!progress) return
    setError(null); setStage('exporting')
    try {
      const out = await audiobooksApi.export(progress.audiobook_id)
      setExported(out)
      if (out.audio_url) {
        const url = await toObjectUrl(out.audio_url)
        urlRef.current = url
        setMp3Url(url)
      }
      setStage('exported')
    } catch (e) {
      setStage('ready')
      setError(toUiError(e, 'Export failed.'))
    }
  }

  const reset = () => {
    setProgress(null); setExported(null); setMp3Url(null); setError(null); setStage('idle')
  }

  if (email === undefined) return <LoadingCard />
  if (!email) return <SignInGate title="Sign in to create audiobooks" />

  const locked = stage !== 'idle'
  const slug = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'audiobook'

  return (
    <div className="ra-vs">
      <ErrorNotice error={error} />

      <div className="ra-vs-card">
        <div className="ra-vs-form two" style={{ marginTop: 0 }}>
          <label>
            Title
            <input type="text" value={title} maxLength={MAX_TITLE} disabled={locked} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label>
            Voice
            <select
              value={voiceId}
              disabled={locked || voices.length === 0}
              onChange={(e) => setVoiceId(e.target.value)}
              style={{ font: 'inherit', padding: '11px 13px', borderRadius: 10, border: '1.5px solid var(--line)', background: '#fff' }}
            >
              {voices.length === 0 && <option value="">{voicesError ? 'Voices unavailable' : 'Loading voices...'}</option>}
              {voices.map((v) => (
                <option key={v.id} value={v.id}>{v.name}{v.hint ? ` - ${v.hint}` : ''}</option>
              ))}
            </select>
          </label>
        </div>
        {voicesError && <p className="ra-err" role="alert" style={{ marginTop: 8 }}>{voicesError}</p>}

        <div className="ra-vs-form" style={{ marginTop: 14, maxWidth: 320 }}>
          <label>
            Speed: {speed.toFixed(2)}x
            <input
              type="range" min={MIN_SPEED} max={MAX_SPEED} step={0.05} value={speed}
              disabled={locked} onChange={(e) => setSpeed(Number(e.target.value))}
            />
          </label>
        </div>

        <div role="tablist" aria-label="Book source" style={{ display: 'flex', gap: 8, marginTop: 18 }}>
          {(['text', 'epub'] as const).map((s) => (
            <button
              key={s}
              role="tab"
              aria-selected={source === s}
              className={`ra-btn ${source === s ? 'solid' : 'ghost'}`}
              disabled={locked}
              onClick={() => { setSource(s); setError(null) }}
            >
              {s === 'text' ? 'Paste text' : 'Upload EPUB'}
            </button>
          ))}
        </div>

        {source === 'text' ? (
          <div className="ra-vs-form" style={{ marginTop: 12 }}>
            <label>
              Book text
              <textarea
                value={text}
                rows={10}
                disabled={locked}
                placeholder="Paste your text. Chapters are detected automatically from headings."
                onChange={(e) => setText(e.target.value)}
                style={{ font: 'inherit', fontWeight: 400, border: '1.5px solid var(--line)', borderRadius: 10, padding: '11px 13px', width: '100%' }}
              />
              <span className="ra-small" style={{ fontWeight: 400 }}>{text.length.toLocaleString()} characters</span>
            </label>
          </div>
        ) : (
          <div className="ra-vs-form" style={{ marginTop: 12 }}>
            <label>
              EPUB file
              <input
                type="file" accept=".epub,application/epub+zip" disabled={locked}
                onChange={(e) => { setEpub(e.target.files?.[0] ?? null); setError(null) }}
              />
            </label>
            {epub && <p className="ra-small">{epub.name} · {fmtSize(epub.size)}</p>}
          </div>
        )}

        <p className="ra-small" style={{ marginTop: 12 }}>
          Each detected chapter becomes its own audio track, then you can export everything as one MP3 with chapter markers.
          Browser submissions are limited to about 1 MB of text or a {fmtSize(MAX_EPUB_BYTES)} EPUB, and each chapter must
          fit your plan&rsquo;s per-job character limit.
        </p>
        <PriceNote tool="audiobooks" />

        <div className="ra-cta" style={{ marginTop: 16 }}>
          {stage === 'idle' && <button className="ra-btn solid" onClick={submit}>Create audiobook</button>}
          {stage === 'creating' && <button className="ra-btn solid" disabled>Detecting chapters...</button>}
          {stage === 'processing' && <button className="ra-btn solid" disabled>Generating chapters...</button>}
          {stage === 'ready' && <button className="ra-btn solid" onClick={exportMp3}>Export MP3</button>}
          {stage === 'exporting' && <button className="ra-btn solid" disabled>Exporting...</button>}
          {(stage === 'ready' || stage === 'exported') && <button className="ra-btn ghost" onClick={reset}>Start over</button>}
        </div>

        {stage === 'creating' && <Working title="Preparing your book">Uploading and detecting chapters.</Working>}
        {stage === 'exporting' && <Working title="Exporting">Joining chapters into one MP3. This can take a minute.</Working>}
      </div>

      {progress && (
        <div className="ra-vs-card" style={{ marginTop: 20 }}>
          <h3 style={{ marginBottom: 4 }}>
            Chapters ({progress.chapters_completed}/{progress.chapter_count} ready · {progress.overall_percentage}%)
          </h3>
          <div className="ra-table-wrap" style={{ maxHeight: 420, overflow: 'auto', marginTop: 8 }}>
            <table className="ra-table">
              <thead><tr><th>#</th><th>Chapter</th><th>Status</th><th>Length</th></tr></thead>
              <tbody>
                {progress.chapters.map((c) => (
                  <tr key={c.id}>
                    <td>{c.sequence + 1}</td>
                    <td>
                      {c.title || `Chapter ${c.sequence + 1}`}
                      {c.error_message && <div className="ra-err">{c.error_message}</div>}
                    </td>
                    <td>
                      {STATUS_LABEL[c.status] ?? c.status}
                      {c.status === 'processing' && ` ${c.percentage}%`}
                    </td>
                    <td>{fmtDuration(c.duration_seconds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {stage === 'exported' && exported && (
        <div className="ra-vs-card" style={{ marginTop: 20 }}>
          <h3 style={{ marginBottom: 8 }}>Your audiobook is ready</h3>
          {mp3Url ? (
            <>
              <div className="ra-vs-samples">
                <div className="ra-vs-sample"><audio controls src={mp3Url} className="w-full" /></div>
              </div>
              <div className="ra-cta" style={{ marginTop: 12 }}>
                <a className="ra-btn solid" href={mp3Url} download={`${slug}.mp3`}>Download MP3</a>
              </div>
              <p className="ra-small" style={{ marginTop: 8 }}>
                Total length {fmtDuration(exported.duration_seconds)}. The link is temporary; download it now.
              </p>
            </>
          ) : (
            <p className="ra-vs-notice bad" role="alert">Export finished but no download link was returned. Try exporting again.</p>
          )}
        </div>
      )}
    </div>
  )
}
