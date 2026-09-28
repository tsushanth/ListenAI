import type { Metadata } from 'next'
import VoiceCloner from '@/components/ra/VoiceCloner'

export const metadata: Metadata = {
  title: 'Clone a Voice — ReadAloud AI',
  description: 'Clone any voice from a 3–30 second audio sample using XTTS v2. No training required.',
}

export default function CloneVoicePage() {
  return (
    <main className="ra-page">
      <div className="ra-wrap">
        <h1>Clone a voice</h1>
        <p className="ra-lede" style={{ marginBottom: 24 }}>
          Upload a short audio clip to create an instant AI clone. Use it to hear articles,
          podcasts, or any text in that voice.
        </p>
        <VoiceCloner />
      </div>
    </main>
  )
}
