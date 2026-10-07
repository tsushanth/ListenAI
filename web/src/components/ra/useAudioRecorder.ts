'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { pickRecorderMime } from '@/lib/voiceCloneErrors'

export type RecState = 'idle' | 'requesting' | 'recording' | 'done'

export interface Recording { blob: Blob; url: string; seconds: number }

/**
 * MediaRecorder wrapper with a live elapsed timer, an input level (0..1) and an automatic stop at `maxSec`.
 * Duration comes from the wall clock: webm blobs from MediaRecorder carry no duration metadata.
 */
export function useAudioRecorder(maxSec: number) {
  const [state, setState] = useState<RecState>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [level, setLevel] = useState(0)
  const [recording, setRecording] = useState<Recording | null>(null)
  const [error, setError] = useState<string | null>(null)

  const rec = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const ctx = useRef<AudioContext | null>(null)
  const raf = useRef(0)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  const chunks = useRef<Blob[]>([])
  const startedAt = useRef(0)
  const urlRef = useRef<string | null>(null)

  const teardown = useCallback(() => {
    if (timer.current) clearInterval(timer.current)
    timer.current = null
    cancelAnimationFrame(raf.current)
    stream.current?.getTracks().forEach((t) => t.stop())
    stream.current = null
    ctx.current?.close().catch(() => {})
    ctx.current = null
    setLevel(0)
  }, [])

  const revoke = () => { if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null } }

  useEffect(() => () => { teardown(); revoke(); if (rec.current && rec.current.state !== 'inactive') { rec.current.onstop = null; rec.current.stop() } }, [teardown])

  const stop = useCallback(() => {
    if (rec.current && rec.current.state !== 'inactive') rec.current.stop()
  }, [])

  const start = useCallback(async () => {
    setError(null)
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setError('This browser cannot record audio. Use a current Chrome, Edge, Firefox or Safari, or upload a file instead.')
      return
    }
    setState('requesting')
    let s: MediaStream
    try {
      s = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (e) {
      const name = (e as DOMException)?.name
      setState(recording ? 'done' : 'idle')
      setError(name === 'NotAllowedError' || name === 'SecurityError'
        ? 'Microphone access was blocked. Allow the microphone for this site in your browser settings, then try again.'
        : name === 'NotFoundError' ? 'No microphone was found. Connect one and try again.'
        : 'Could not start the microphone. Close other apps that use it and try again.')
      return
    }
    stream.current = s
    revoke()
    setRecording(null)
    setElapsed(0)
    chunks.current = []

    const mime = pickRecorderMime((t) => MediaRecorder.isTypeSupported(t))
    const mr = new MediaRecorder(s, mime ? { mimeType: mime } : undefined)
    rec.current = mr
    mr.ondataavailable = (ev) => { if (ev.data.size) chunks.current.push(ev.data) }
    mr.onstop = () => {
      const seconds = Math.min(maxSec, (Date.now() - startedAt.current) / 1000)
      const blob = new Blob(chunks.current, { type: mr.mimeType || mime || 'audio/webm' })
      teardown()
      if (blob.size < 1024) { setState('idle'); setError('Nothing was recorded. Check your microphone and try again.'); return }
      const url = URL.createObjectURL(blob)
      urlRef.current = url
      setRecording({ blob, url, seconds })
      setElapsed(seconds)
      setState('done')
    }

    // Level meter
    try {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      const ac = new AC()
      ctx.current = ac
      const an = ac.createAnalyser()
      an.fftSize = 1024
      ac.createMediaStreamSource(s).connect(an)
      const buf = new Uint8Array(an.fftSize)
      const tick = () => {
        an.getByteTimeDomainData(buf)
        let peak = 0
        for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128) / 128)
        setLevel(peak)
        raf.current = requestAnimationFrame(tick)
      }
      tick()
    } catch { /* meter is cosmetic */ }

    startedAt.current = Date.now()
    mr.start(250)
    setState('recording')
    timer.current = setInterval(() => {
      const sec = (Date.now() - startedAt.current) / 1000
      setElapsed(sec)
      if (sec >= maxSec) stop()
    }, 100)
  }, [maxSec, recording, stop, teardown])

  const reset = useCallback(() => {
    if (rec.current && rec.current.state !== 'inactive') { rec.current.onstop = null; rec.current.stop() }
    teardown()
    revoke()
    setRecording(null)
    setElapsed(0)
    setError(null)
    setState('idle')
  }, [teardown])

  return { state, elapsed, level, recording, error, start, stop, reset }
}
