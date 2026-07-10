'use client'

import { useState, useRef, useEffect } from 'react'
import { Play, Pause, RotateCcw, Loader2, Volume2, Settings2 } from 'lucide-react'

// Default voices available
const defaultVoices = [
  { id: 'nova', name: 'Nova', description: 'Warm & Conversational' },
  { id: 'alloy', name: 'Alloy', description: 'Balanced & Natural' },
  { id: 'echo', name: 'Echo', description: 'Clear & Professional' },
  { id: 'fable', name: 'Fable', description: 'Expressive & British' },
  { id: 'onyx', name: 'Onyx', description: 'Deep & Authoritative' },
  { id: 'shimmer', name: 'Shimmer', description: 'Light & Friendly' },
]

const speeds = [0.5, 0.75, 1, 1.25, 1.5, 2]

export default function ReaderPage() {
  const [text, setText] = useState('')
  const [selectedVoice, setSelectedVoice] = useState('nova')
  const [speed, setSpeed] = useState(1)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isSynthesizing, setIsSynthesizing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const audioUrlRef = useRef<string | null>(null)

  // Cleanup audio URL on unmount
  useEffect(() => {
    return () => {
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current)
      }
    }
  }, [])

  const synthesize = async () => {
    if (!text.trim()) {
      setError('Please enter some text to read')
      return
    }

    setIsSynthesizing(true)
    setError(null)

    try {
      const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://listenai-backend.fly.dev'
      const deviceId = localStorage.getItem('deviceId') || crypto.randomUUID()
      localStorage.setItem('deviceId', deviceId)

      const response = await fetch(`${API_URL}/api/synthesize`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Device-ID': deviceId,
        },
        body: JSON.stringify({
          text: text.trim(),
          voice_id: selectedVoice,
          speed,
          format: 'mp3',
        }),
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.error || 'Synthesis failed')
      }

      const blob = await response.blob()

      // Cleanup previous audio
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current)
      }
      if (audioRef.current) {
        audioRef.current.pause()
      }

      // Create new audio
      const url = URL.createObjectURL(blob)
      audioUrlRef.current = url

      const audio = new Audio(url)
      audioRef.current = audio

      audio.onended = () => setIsPlaying(false)
      audio.onerror = () => {
        setError('Failed to play audio')
        setIsPlaying(false)
      }

      await audio.play()
      setIsPlaying(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to synthesize')
    } finally {
      setIsSynthesizing(false)
    }
  }

  const togglePlay = () => {
    if (!audioRef.current) return

    if (isPlaying) {
      audioRef.current.pause()
      setIsPlaying(false)
    } else {
      audioRef.current.play()
      setIsPlaying(true)
    }
  }

  const reset = () => {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.currentTime = 0
    }
    setIsPlaying(false)
  }

  const charCount = text.length
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length
  const estimatedMinutes = Math.ceil(wordCount / 150)

  return (
    <div className="max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">Reader</h1>
        <p className="text-white/60">
          Convert any text to natural-sounding speech.
        </p>
      </div>

      {/* Main content */}
      <div className="glass rounded-xl p-6">
        {/* Text input */}
        <div className="mb-4">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste or type your text here..."
            className="w-full h-64 bg-dark-tertiary border border-white/10 rounded-lg p-4 text-white placeholder:text-white/40 focus:outline-none focus:border-primary resize-none"
          />
          <div className="flex items-center justify-between mt-2 text-sm text-white/50">
            <span>{charCount.toLocaleString()} characters • {wordCount} words</span>
            <span>~{estimatedMinutes} min</span>
          </div>
        </div>

        {/* Voice & Settings */}
        <div className="flex flex-wrap items-center gap-4 mb-6">
          {/* Voice selector */}
          <div className="flex-1 min-w-[200px]">
            <label className="block text-sm text-white/60 mb-2">Voice</label>
            <select
              value={selectedVoice}
              onChange={(e) => setSelectedVoice(e.target.value)}
              className="w-full bg-dark-tertiary border border-white/10 rounded-lg px-4 py-3 text-white focus:outline-none focus:border-primary appearance-none cursor-pointer"
            >
              {defaultVoices.map((voice) => (
                <option key={voice.id} value={voice.id}>
                  {voice.name} - {voice.description}
                </option>
              ))}
            </select>
          </div>

          {/* Speed selector */}
          <div className="w-32">
            <label className="block text-sm text-white/60 mb-2">Speed</label>
            <select
              value={speed}
              onChange={(e) => setSpeed(Number(e.target.value))}
              className="w-full bg-dark-tertiary border border-white/10 rounded-lg px-4 py-3 text-white focus:outline-none focus:border-primary appearance-none cursor-pointer"
            >
              {speeds.map((s) => (
                <option key={s} value={s}>
                  {s}x
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Error message */}
        {error && (
          <div className="mb-4 p-4 bg-red-500/20 border border-red-500/30 rounded-lg text-red-400">
            {error}
          </div>
        )}

        {/* Controls */}
        <div className="flex items-center gap-4">
          {/* Main play/synthesize button */}
          {!audioRef.current ? (
            <button
              onClick={synthesize}
              disabled={isSynthesizing || !text.trim()}
              className="flex-1 flex items-center justify-center gap-2 bg-primary text-black font-semibold py-4 rounded-lg hover:bg-primary-dark transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSynthesizing ? (
                <>
                  <Loader2 className="animate-spin" size={20} />
                  Generating...
                </>
              ) : (
                <>
                  <Volume2 size={20} />
                  Generate Speech
                </>
              )}
            </button>
          ) : (
            <>
              <button
                onClick={togglePlay}
                className="flex-1 flex items-center justify-center gap-2 bg-primary text-black font-semibold py-4 rounded-lg hover:bg-primary-dark transition-colors"
              >
                {isPlaying ? (
                  <>
                    <Pause size={20} />
                    Pause
                  </>
                ) : (
                  <>
                    <Play size={20} />
                    Play
                  </>
                )}
              </button>

              <button
                onClick={reset}
                className="p-4 bg-dark-tertiary rounded-lg text-white/70 hover:bg-white/10 transition-colors"
                title="Reset"
              >
                <RotateCcw size={20} />
              </button>

              <button
                onClick={() => {
                  if (audioUrlRef.current) {
                    URL.revokeObjectURL(audioUrlRef.current)
                    audioUrlRef.current = null
                  }
                  audioRef.current = null
                  setIsPlaying(false)
                }}
                className="p-4 bg-dark-tertiary rounded-lg text-white/70 hover:bg-white/10 transition-colors"
                title="New synthesis"
              >
                <Settings2 size={20} />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Tips */}
      <div className="mt-8 glass rounded-xl p-6">
        <h2 className="text-lg font-semibold mb-4">Tips</h2>
        <ul className="space-y-2 text-sm text-white/60">
          <li>• For best results, use proper punctuation</li>
          <li>• Longer texts may take more time to synthesize</li>
          <li>• Try different voices to find what works best for your content</li>
          <li>• Adjust speed based on your listening preference</li>
        </ul>
      </div>
    </div>
  )
}
