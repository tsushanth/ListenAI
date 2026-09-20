'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Play, Square } from 'lucide-react'

const PRESETS = [
  'Thanks for calling, I can help you with that. Let me pull up your account details right now.',
  'Your order should arrive within three to five business days, and I will send a confirmation email shortly.',
  'I understand your frustration, let me see what I can do to make this right.',
  'Is there anything else I can help you with today?',
  'Your extension is six six three five.',
]
const MAX_CHARS = 200
const SR = 24000

type Phase = 'idle' | 'connecting' | 'waiting' | 'playing' | 'error'

export default function LiveDemo() {
  const [text, setText] = useState(PRESETS[0])
  const [phase, setPhase] = useState<Phase>('idle')
  const [firstMs, setFirstMs] = useState<number | null>(null)
  const [tick, setTick] = useState(0)
  const [message, setMessage] = useState('')

  const wsRef = useRef<WebSocket | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const audioElRef = useRef<HTMLAudioElement | null>(null)
  const nextRef = useRef(0)
  const t0Ref = useRef(0)
  const rafRef = useRef(0)
  const barsRef = useRef<number[]>([])
  const startRef = useRef(0)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const gotFirstRef = useRef(false)
  const endTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const draw = useCallback(() => {
    const cv = canvasRef.current
    if (!cv) return
    const dpr = window.devicePixelRatio || 1
    const w = cv.clientWidth, h = cv.clientHeight
    if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr }
    const g = cv.getContext('2d')!
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, w, h)
    const bars = barsRef.current
    const ctx = ctxRef.current
    const played = ctx ? Math.max(0, (ctx.currentTime - startRef.current) / 0.04) : 0
    const step = 4, bw = 2
    if (bars.length === 0) {
      g.fillStyle = '#E3E5E9'
      for (let x = 0; x < w; x += step) g.fillRect(x, h / 2 - 1, bw, 2)
      return
    }
    const maxBars = Math.floor(w / step)
    const offset = Math.max(0, bars.length - maxBars)
    for (let i = 0; i < Math.min(bars.length, maxBars); i++) {
      const v = bars[i + offset]
      const bh = Math.max(2, v * (h - 12))
      g.fillStyle = i + offset < played ? '#F2C500' : '#0D0E11'
      g.fillRect(i * step, (h - bh) / 2, bw, bh)
    }
  }, [])

  const stopAll = useCallback(() => {
    cancelAnimationFrame(rafRef.current)
    if (endTimerRef.current) clearTimeout(endTimerRef.current)
    try { wsRef.current?.send(JSON.stringify({ type: 'stop' })) } catch {}
    try { wsRef.current?.close() } catch {}
    wsRef.current = null
    ctxRef.current?.close().catch(() => {})
    ctxRef.current = null
    audioElRef.current?.pause()
    audioElRef.current = null
  }, [])

  useEffect(() => () => stopAll(), [stopAll])
  useEffect(() => { draw() }, [draw])

  const loop = useCallback(() => {
    if (!gotFirstRef.current) setTick(performance.now() - t0Ref.current)
    draw()
    rafRef.current = requestAnimationFrame(loop)
  }, [draw])

  const finishSoon = () => {
    const ctx = ctxRef.current
    if (!ctx) return
    const ms = Math.max(0, (nextRef.current - ctx.currentTime) * 1000) + 250
    endTimerRef.current = setTimeout(() => { setPhase('idle'); cancelAnimationFrame(rafRef.current); draw() }, ms)
  }

  const playSample = (idx: number) => {
    const a = new Audio(`/samples/sample_${idx}.wav`)
    audioElRef.current = a
    a.onended = () => setPhase('idle')
    setPhase('playing')
    a.play().catch(() => { setPhase('error'); setMessage('Your browser blocked audio. Click play again.') })
  }

  const start = async () => {
    stopAll()
    setMessage(''); setFirstMs(null); setTick(0)
    barsRef.current = []; gotFirstRef.current = false
    const clean = text.trim().slice(0, MAX_CHARS)
    if (!clean) { setMessage('Type something to hear it.'); return }

    const AC = window.AudioContext || (window as any).webkitAudioContext
    const ctx: AudioContext = new AC({ sampleRate: SR })
    ctxRef.current = ctx
    await ctx.resume().catch(() => {})
    setPhase('connecting')

    let auth: { token: string; url: string } | null = null
    try {
      const r = await fetch('/api/demo-token', { method: 'POST' })
      if (r.ok) auth = await r.json()
    } catch {}
    if (!auth) {
      const idx = PRESETS.indexOf(clean)
      if (idx >= 0) { playSample(idx); setMessage('The live demo is offline right now, so this is a recorded sample.'); return }
      setPhase('error'); setMessage('The live demo is offline right now. Pick one of the example sentences to hear a recorded sample.')
      return
    }

    const ws = new WebSocket(`${auth.url}?token=${auth.token}`)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws
    ws.onopen = () => {
      setPhase('waiting')
      t0Ref.current = performance.now()
      ws.send(JSON.stringify({ type: 'synthesize', text: clean, voice: 'default', speed: 1.0 }))
      rafRef.current = requestAnimationFrame(loop)
    }
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        const m = JSON.parse(e.data)
        if (m.type === 'done' || m.type === 'cancelled') finishSoon()
        if (m.type === 'error') {
          setPhase('error')
          setMessage(/capacity/i.test(m.message) ? 'The demo is busy. Try again in a few seconds.' : 'Something went wrong. Try again.')
          cancelAnimationFrame(rafRef.current)
        }
        return
      }
      const c = ctxRef.current
      if (!c) return
      if (!gotFirstRef.current) {
        gotFirstRef.current = true
        setFirstMs(Math.round(performance.now() - t0Ref.current))
        setPhase('playing')
        nextRef.current = c.currentTime + 0.03
        startRef.current = nextRef.current
      }
      const i16 = new Int16Array(e.data as ArrayBuffer)
      const f32 = new Float32Array(i16.length)
      for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768
      const buf = c.createBuffer(1, f32.length, SR)
      buf.copyToChannel(f32, 0)
      const src = c.createBufferSource()
      src.buffer = buf; src.connect(c.destination)
      const at = Math.max(nextRef.current, c.currentTime + 0.01)
      src.start(at); nextRef.current = at + buf.duration
      const win = Math.floor(SR * 0.04)
      for (let s = 0; s + win <= f32.length; s += win) {
        let sum = 0
        for (let k = 0; k < win; k++) sum += f32[s + k] * f32[s + k]
        barsRef.current.push(Math.min(1, Math.sqrt(sum / win) * 4.5))
      }
    }
    ws.onerror = () => { setPhase('error'); setMessage('Could not reach the voice server. Try again.') }
  }

  const busy = phase === 'connecting' || phase === 'waiting' || phase === 'playing'
  const clock = firstMs ?? Math.round(tick)
  const showClock = firstMs !== null || phase === 'waiting'

  return (
    <div className="ra-demo">
      <div className="ra-demo-body">
        <label htmlFor="ra-demo-text" className="sr-only" style={{ position: 'absolute', left: -9999 }}>Text to speak</label>
        <textarea
          id="ra-demo-text"
          value={text}
          maxLength={MAX_CHARS}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
        />
        <div className="ra-demo-side">
          <div>
            <div className="ra-clock" aria-live="polite">
              {showClock ? <>{clock}<small>ms</small></> : <span style={{ color: '#B8BCC5' }}>&mdash;<small>ms</small></span>}
            </div>
            <div className="ra-clock-label">
              {phase === 'waiting' ? 'Waiting for first audio' : firstMs !== null ? 'From request sent to first audio, measured in your browser' : 'Time to first audio appears here'}
            </div>
          </div>
          <div>
            <button className="ra-btn solid" style={{ width: '100%' }} onClick={busy ? () => { stopAll(); setPhase('idle') } : start}>
              {busy ? <><Square size={16} /> Stop</> : <><Play size={16} /> Play</>}
            </button>
            <p className="ra-small" style={{ marginTop: 10 }}>{text.length}/{MAX_CHARS} characters. One voice, English.</p>
          </div>
        </div>
      </div>
      <canvas ref={canvasRef} className="ra-wave" aria-hidden="true" />
      <div className="ra-presets" role="group" aria-label="Example sentences">
        {PRESETS.map((p, i) => (
          <button key={i} className="ra-chip" aria-pressed={text === p} onClick={() => setText(p)}>
            {['Greeting', 'Order status', 'De-escalation', 'Follow-up', 'Digits'][i]}
          </button>
        ))}
      </div>
      <div className="ra-note">
        {message ? <span className={phase === 'error' ? 'ra-err' : ''}>{message}</span> : 'Connection setup is not included in the number. It is one authorize call, then a reused connection.'}
      </div>
    </div>
  )
}
