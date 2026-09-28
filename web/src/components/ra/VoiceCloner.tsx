'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { voiceCloneApi, type ClonedVoice } from '@/lib/voiceCloneApi'

const ALLOWED_TYPES = ['audio/wav', 'audio/flac', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/mp3']
const ALLOWED_EXT = ['.wav', '.flac', '.ogg', '.mp3', '.m4a', '.mp4']

const SUPPORTED_LANGS: Record<string, string> = {
  en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian',
  pt: 'Portuguese', pl: 'Polish', tr: 'Turkish', ru: 'Russian', nl: 'Dutch',
  cs: 'Czech', ar: 'Arabic', zh: 'Chinese', ja: 'Japanese', hu: 'Hungarian',
  ko: 'Korean',
}

function isValidAudio(file: File): boolean {
  if (ALLOWED_TYPES.includes(file.type)) return true
  const name = file.name.toLowerCase()
  return ALLOWED_EXT.some((ext) => name.endsWith(ext))
}

function fmtSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

type Stage = 'idle' | 'uploading' | 'ready' | 'failed'
type Tab = 'create' | 'voices'

const CONSENT_TEXT =
  'I confirm that I have the legal right to clone this voice and agree to the Terms of Use. I will not use this feature to impersonate any person without their consent.'

export default function VoiceCloner() {
  const [sessionEmail, setSessionEmail] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('create')

  // Create voice form
  const [audioFile, setAudioFile] = useState<File | null>(null)
  const [voiceName, setVoiceName] = useState('')
  const [language, setLanguage] = useState('en')
  const [consent, setConsent] = useState(false)
  const [stage, setStage] = useState<Stage>('idle')
  const [error, setError] = useState<string | null>(null)
  const [voices, setVoices] = useState<ClonedVoice[] | undefined>(undefined)

  // Synthesize
  const [synthText, setSynthText] = useState('Hello! This is a preview of my cloned voice.')
  const [synthLang, setSynthLang] = useState('en')
  const [synthAudio, setSynthAudio] = useState<string | null>(null)
  const [synthLoading, setSynthLoading] = useState(false)
  const [synthError, setSynthError] = useState<string | null>(null)
  const [activeVoiceId, setActiveVoiceId] = useState<string | null>(null)
  const [refAudio, setRefAudio] = useState<string | null>(null)

  const cancelled = useRef(false)

  useEffect(() => {
    cancelled.current = false
    supabase.auth.getSession().then(({ data }) => {
      setSessionEmail(data.session?.user.email ?? null)
    })
  }, [])

  const loadVoices = useCallback(async () => {
    try {
      const list = await voiceCloneApi.list()
      setVoices(list)
    } catch {
      setVoices([])
    }
  }, [])

  useEffect(() => {
    if (sessionEmail) loadVoices()
  }, [sessionEmail, loadVoices])

  const validateCreate = (): string | null => {
    if (!audioFile) return 'Choose a reference audio file (3–30 seconds).'
    if (!isValidAudio(audioFile)) return `Unsupported file type: ${audioFile.name}`
    if (audioFile.size > 25 * 1024 * 1024) return `File too large: ${fmtSize(audioFile.size)} (max 25 MB).`
    if (!voiceName.trim()) return 'Give your voice a name.'
    if (!consent) return 'You must confirm the consent statement to continue.'
    return null
  }

  const submitCreate = async () => {
    if (cancelled.current) return
    const v = validateCreate()
    if (v) { setError(v); return }
    setError(null); setStage('uploading')
    try {
      await voiceCloneApi.create({
        name: voiceName.trim(),
        language,
        audioFile: audioFile!,
      })
      setStage('ready')
      setAudioFile(null)
      setVoiceName('')
      setConsent(false)
      setTab('voices')
      loadVoices()
    } catch (e: unknown) {
      setStage('failed')
      setError(e instanceof Error ? e.message : 'Could not clone voice.')
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this cloned voice permanently?')) return
    try {
      await voiceCloneApi.delete(id)
      setVoices((prev) => prev?.filter((v) => v.id !== id))
      if (activeVoiceId === id) {
        setActiveVoiceId(null)
        setSynthAudio(null)
        setRefAudio(null)
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Delete failed.')
    }
  }

  const handleSynthesize = async (voiceId: string) => {
    setSynthError(null)
    setSynthAudio(null)
    setSynthLoading(true)
    setActiveVoiceId(voiceId)
    try {
      const url = await voiceCloneApi.synthesize(voiceId, synthText.trim(), synthLang)
      setSynthAudio(url)
    } catch (e: unknown) {
      setSynthError(e instanceof Error ? e.message : 'Synthesis failed.')
    } finally {
      setSynthLoading(false)
    }
  }

  const loadRefAudio = async (voice: ClonedVoice) => {
    setRefAudio(null)
    try {
      const url = await voiceCloneApi.referenceAudio(voice.id)
      setRefAudio(url)
    } catch {
      setRefAudio('')
    }
  }

  if (!sessionEmail) {
    return (
      <div className="ra-vs-card" style={{ maxWidth: 460 }}>
        <h2>Sign in to clone voices</h2>
        <p className="ra-lede" style={{ fontSize: '1rem' }}>Use the same ReadAloud AI account as your API keys.</p>
        <a className="ra-btn solid" href="/app">Sign in</a>
      </div>
    )
  }

  return (
    <div className="ra-vs">
      {error && <p className="ra-err" role="alert">{error}</p>}

      <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
        <button className={`ra-btn ${tab === 'create' ? 'solid' : 'ghost'}`} onClick={() => setTab('create')}>
          Clone a voice
        </button>
        <button className={`ra-btn ${tab === 'voices' ? 'solid' : 'ghost'}`} onClick={() => { setTab('voices'); loadVoices() }}>
          My cloned voices
        </button>
      </div>

      {/* Create tab */}
      {tab === 'create' && (
        <div className="ra-vs-card">
          <p className="ra-lede" style={{ fontSize: '1rem', marginBottom: 16 }}>
            Upload 3–30 seconds of clear speech to instantly clone a voice. No training required.
          </p>

          <div style={{ marginBottom: 16 }}>
            <label>
              Reference audio
              <input
                type="file"
                accept=".wav,.flac,.ogg,.mp3,.m4a,.mp4"
                onChange={(e) => { setAudioFile(e.target.files?.[0] ?? null); setError(null) }}
                disabled={stage === 'uploading'}
              />
            </label>
            {audioFile && (
              <p className="ra-small" style={{ marginTop: 4 }}>
                {audioFile.name} · {fmtSize(audioFile.size)}
              </p>
            )}
          </div>

          <div style={{ marginBottom: 16 }}>
            <label>
              Voice name
              <input
                type="text"
                value={voiceName}
                onChange={(e) => setVoiceName(e.target.value)}
                placeholder="e.g. My Voice"
                maxLength={100}
                disabled={stage === 'uploading'}
              />
            </label>
          </div>

          <div style={{ marginBottom: 16 }}>
            <label>
              Language
              <select value={language} onChange={(e) => setLanguage(e.target.value)} disabled={stage === 'uploading'}>
                {Object.entries(SUPPORTED_LANGS).map(([code, label]) => (
                  <option key={code} value={code}>{label}</option>
                ))}
              </select>
            </label>
          </div>

          <fieldset className="ra-vs-consent" style={{ marginTop: 8, marginBottom: 16 }}>
            <label className="ra-vs-check">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                disabled={stage === 'uploading'}
              />
              <span>{CONSENT_TEXT}</span>
            </label>
          </fieldset>

          <div className="ra-cta">
            <button
              className="ra-btn solid"
              disabled={stage === 'uploading' || !!validateCreate()}
              onClick={submitCreate}
            >
              {stage === 'uploading' ? 'Cloning voice…' : 'Clone voice'}
            </button>
          </div>

          {stage === 'ready' && (
            <p className="ra-vs-notice" role="status" style={{ marginTop: 16 }}>
              Voice cloned successfully! Switch to <b>My cloned voices</b> to use it.
            </p>
          )}
        </div>
      )}

      {/* Voices tab */}
      {tab === 'voices' && (
        <>
          {voices === undefined && <p className="ra-small">Loading voices…</p>}
          {voices && voices.length === 0 && (
            <div className="ra-vs-card">
              <p className="ra-lede" style={{ fontSize: '1rem' }}>You haven’t cloned any voices yet.</p>
              <div className="ra-cta" style={{ marginTop: 12 }}>
                <button className="ra-btn solid" onClick={() => setTab('create')}>Clone your first voice</button>
              </div>
            </div>
          )}
          {voices && voices.map((voice) => (
            <div className="ra-vs-card" key={voice.id} style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                <div>
                  <b>{voice.name}</b>
                  <p className="ra-small" style={{ marginTop: 2 }}>
                    {SUPPORTED_LANGS[voice.language] || voice.language}
                    {voice.reference_seconds != null && ` · ${voice.reference_seconds.toFixed(1)}s reference`}
                  </p>
                </div>
                <div className="ra-cta" style={{ display: 'flex', gap: 8 }}>
                  <button className="ra-btn ghost" onClick={() => loadRefAudio(voice)}>
                    Play reference
                  </button>
                  <button className="ra-btn ghost danger" onClick={() => handleDelete(voice.id)}>
                    Delete
                  </button>
                </div>
              </div>

              {activeVoiceId === voice.id && refAudio && (
                <div style={{ marginTop: 12 }}>
                  <audio controls src={refAudio} className="w-full" />
                </div>
              )}

              {/* Synthesize section */}
              <div style={{ marginTop: 16, borderTop: '1px solid var(--ra-border)', paddingTop: 16 }}>
                <label>
                  Text to synthesize
                  <textarea
                    value={synthText}
                    onChange={(e) => setSynthText(e.target.value)}
                    rows={3}
                    maxLength={5000}
                    disabled={synthLoading}
                  />
                  <small>{synthText.length} / 5000</small>
                </label>

                <div style={{ display: 'flex', gap: 12, marginTop: 8, alignItems: 'flex-end' }}>
                  <label style={{ flex: '0 0 auto' }}>
                    Language
                    <select value={synthLang} onChange={(e) => setSynthLang(e.target.value)} disabled={synthLoading}>
                      {Object.entries(SUPPORTED_LANGS).map(([code, label]) => (
                        <option key={code} value={code}>{label}</option>
                      ))}
                    </select>
                  </label>
                  <div className="ra-cta" style={{ flex: 1 }}>
                    <button
                      className="ra-btn solid"
                      disabled={synthLoading || !synthText.trim()}
                      onClick={() => handleSynthesize(voice.id)}
                    >
                      {synthLoading && activeVoiceId === voice.id ? 'Synthesizing…' : 'Synthesize'}
                    </button>
                  </div>
                </div>

                {synthError && activeVoiceId === voice.id && (
                  <p className="ra-err" role="alert" style={{ marginTop: 8 }}>{synthError}</p>
                )}
                {synthAudio && activeVoiceId === voice.id && (
                  <div style={{ marginTop: 12 }}>
                    <audio controls src={synthAudio} className="w-full" />
                    <div className="ra-cta" style={{ marginTop: 8 }}>
                      <a className="ra-btn ghost" href={synthAudio} download={`synth-${voice.name.replace(/\s+/g, '-').toLowerCase()}.wav`}>
                        Download WAV
                      </a>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  )
}
