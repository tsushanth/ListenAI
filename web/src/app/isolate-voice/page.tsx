import ToolPageShell from '@/components/ra/ToolPageShell'
import VoiceIsolator from '@/components/ra/VoiceIsolator'

export const metadata = {
  title: 'Isolate voice - ReadAloud AI',
  description: 'Separate vocals from background audio, with an optional instrumental track.',
  robots: { index: false },
}

export default function IsolateVoicePage() {
  return (
    <ToolPageShell
      eyebrow="Voice API · Voice isolation"
      title="Separate a voice from everything else"
      lede="Upload a clip and get the vocals on their own, plus the instrumental if you want it."
    >
      <VoiceIsolator />
    </ToolPageShell>
  )
}
