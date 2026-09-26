'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { voiceDesignApi, type VoiceDesignPreset } from '@/lib/voiceDesignApi'

const SUGGESTED_DESCRIPTIONS = [
  'A warm, calm woman in her thirties with a slight British accent, professional and friendly',
  'A deep, authoritative male voice, middle-aged American news anchor, clear and measured',
  'A bright, youthful female voice, enthusiastic and energetic, confident millennial tone',
  'A gravelly, older man with a Southern drawl, wise and unhurried, like a beloved grandfather',
  'A crisp, neutral narrator, gender ambiguous, steady pace, ideal for instructional content',
]

const SUGGESTED_TEXTS = [
  'Thanks for calling. How can I help you today?',
  'Your order has been confirmed and will arrive within three to five business days.',
  'I understand your frustration, and I am going to do everything I can to make this right.',
  'The key to great customer service is listening carefully and responding with empathy.',
]

type Stage = 'idle' | 'submitting' | 'polling' | 'ready' | 'failed'

export default function VoiceDesigner() {
  const [sessionEmail, setSessionEmail] = useState<string | null>(null)
  const [description, setDescription] = useState('')
  const [text, setText] = useState('Thanks for calling. How can I help you today?')
  const [stage, setStage] = useState<Stage>('idle')
  const [jobId, setJobId] = useState<string | null>(null)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [presets, setPresets] = useState<VoiceDesignPreset[] | undefined>(undefined)
  const [presetName, setPresetName] = useState('')
  const [showSave, setShowSave] = useState(false)
  const cancelled = useRef(false)

  useEffect(() => {
    cancelled.current = false
    supabase.auth.getSession().then(({ data }) => setSessionEmail(data.session?.user.email ?? null))
  }, [])

  const loadPresets = useCallback(async () => {
    try { setPresets(await voiceDesignApi.presets()) } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    if (sessionEmail) loadPresets()
  }, [sessionEmail, loadPresets])

  const submit = async () => {
    if (cancelled.current) return
    setError(null); setStage('submitting')
    try {
      const { job_id } = await voiceDesignApi.create({ description: description.trim(), text: text.trim() })
      setJobId(job_id); setStage('polling')
      // start polling
      let ticks = 0
      const interval = setInterval(async () => {
        if (cancelled.current) { clearInterval(interval); return }
        try {
          const s = await voiceDesignApi.poll(job_id)
          if (s.status === 'ready' || s.status === 'failed') {
            clearInterval(interval)
            if (s.status === 'ready') {
              const url = await voiceDesignApi.audio(job_id)
              setAudioUrl(url); setStage('ready')
            } else {
              setStage('failed'); setError('Generation failed. Try a different description or text.')
            }
          }
        } catch (e) {
          // keep polling on transient errors
        }
      }, 2000)
      // timeout guard: 120s max
      setTimeout(() => {
        clearInterval(interval)
        if (stage === 'polling') { setStage('failed'); setError('Generation timed out. Please try again.') }
      }, 120000)
    } catch (e: unknown) {
      setStage('idle')
      setError(e instanceof Error ? e.message : 'Could not start generation.')
    }
  }

  const savePreset = async () => {
    try {
      await voiceDesignApi.savePreset({ name: presetName.trim(), description: description.trim() })
      setPresetName(''); setShowSave(false)
      loadPresets()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save preset.')
    }
  }

  const deletePreset = async (id: string) => {
    try { await voiceDesignApi.deletePreset(id); loadPresets() } catch { }
  }

  if (!sessionEmail) {
    return (
      <div className="ra-vs-card" style={{ maxWidth: 460 }}>
        <h2>Sign in to design voices</h2>
        <p className="ra-lede" style={{ fontSize: '1rem' }}>Use the same ReadAloud AI account as your API keys.</p>
        <a className="ra-btn solid" href="/app">Sign in</a>
      </div>
    )
  }

  return (
    <div className="ra-vs">
      {error && <p className="ra-err" role="alert">{error}</p>}

      <div className="ra-vs-card">
        <div className="ra-vs-form two" style={{ marginBottom: 20 }}>
          <div>
            <label>
              Voice description
              <textarea
                value={description}
                onChange={(e) => { setDescription(e.target.value); setShowSave(false) }}
                rows={5}
                maxLength={800}
                placeholder="e.g. A warm, calm woman in her thirties with a slight British accent, professional and friendly"
                disabled={stage !== 'idle'}
              />
              <small>{description.length} / 800</small>
            </label>
            <div style={{ marginTop: 8 }}>
              <p className="ra-small" style={{ marginBottom: 4 }}>Try one:</p>
              <div className="ra-vs-tags">
                {SUGGESTED_DESCRIPTIONS.map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => { setDescription(d); setShowSave(false) }}
                    className="ra-tag"
                    disabled={stage !== 'idle'}
                  >
                    {d.slice(0, 60)}…
                  </button>
                ))}
              </div>
            </div>
            {description.trim() && (
              <button type="button" className="ra-link" onClick={() => setShowSave(true)} style={{ marginTop: 8 }}>
                Save as preset…
              </button>
            )}
            {showSave && (
              <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                <input
                  value={presetName}
                  onChange={(e) => setPresetName(e.target.value)}
                  placeholder="Preset name"
                  maxLength={100}
                  style={{ flex: 1 }}
                />
                <button className="ra-btn solid" onClick={savePreset} disabled={!presetName.trim()}>Save</button>
                <button className="ra-btn ghost" onClick={() => setShowSave(false)}>Cancel</button>
              </div>
            )}
          </div>

          <div>
            <label>
              Sample text to speak
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={5}
                maxLength={500}
                placeholder="Any words you want to hear in this voice…"
                disabled={stage !== 'idle'}
              />
              <small>{text.length} / 500</small>
            </label>
            <div style={{ marginTop: 8 }}>
              <p className="ra-small" style={{ marginBottom: 4 }}>Try one:</p>
              <div className="ra-vs-tags">
                {SUGGESTED_TEXTS.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setText(t)}
                    className="ra-tag"
                    disabled={stage !== 'idle'}
                  >
                    {t.slice(0, 50)}…
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="ra-cta">
          <button
            className="ra-btn solid"
            disabled={stage !== 'idle' || description.trim().length < 10 || text.trim().length < 1 || !sessionEmail}
            onClick={submit}
          >
            {stage === 'submitting' ? 'Starting…' : stage === 'polling' ? 'Generating voice…' : 'Generate voice'}
          </button>
        </div>

        {stage === 'polling' && (
          <div role="status" aria-live="polite" style={{ marginTop: 16 }}>
            <div className="ra-vs-training">
              <div className="ra-vs-spin" aria-hidden="true" />
              <div>
                <h3 style={{ margin: 0 }}>Generating voice</h3>
                <p>Parler-TTS is creating your voice from the description. This usually takes 5–10 seconds.</p>
              </div>
            </div>
          </div>
        )}

        {(stage === 'ready' || stage === 'failed') && (
          <div style={{ marginTop: 16 }}>
            {audioUrl ? (
              <div className="ra-vs-samples">
                <div className="ra-vs-sample">
                  <audio controls src={audioUrl} className="w-full" />
                </div>
              </div>
            ) : (
              <p className="ra-vs-notice bad" role="alert">Generation failed. Try a different description or shorter text.</p>
            )}
            <div className="ra-cta" style={{ marginTop: 12 }}>
              <button className="ra-btn ghost" onClick={() => { setStage('idle'); setAudioUrl(null); setJobId(null) }}>
                Generate another
              </button>
            </div>
          </div>
        )}
      </div>

      {presets && presets.length > 0 && (
        <div className="ra-vs-card" style={{ marginTop: 20 }}>
          <h3 style={{ marginBottom: 8 }}>Your saved descriptions</h3>
          <p className="ra-lede" style={{ fontSize: '1rem', marginBottom: 12 }}>
            Reusing a description generates the same kind of voice, but not an identical copy — Parler-TTS sampling varies between runs.
          </p>
          <ul className="ra-vs-list">
            {presets.map((p) => (
              <li key={p.id}>
                <div className="ra-vs-row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div>
                    <b>{p.name}</b>
                    <p className="ra-small" style={{ marginTop: 2 }}>{p.description.slice(0, 100)}…</p>
                  </div>
                  <div className="ra-cta">
                    <button className="ra-btn solid" onClick={() => { setDescription(p.description); window.scrollTo({ top: 0, behavior: 'smooth' }) }}>Use</button>
                    <button className="ra-btn ghost danger" onClick={() => deletePreset(p.id)}>Delete</button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
