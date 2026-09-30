import ToolPageShell from '@/components/ra/ToolPageShell'
import Dubber from '@/components/ra/Dubber'

export const metadata = {
  title: 'Dub audio - ReadAloud AI',
  description: 'Translate spoken audio into another language and get a dubbed audio file back.',
  robots: { index: false },
}

export default function DubPage() {
  return (
    <ToolPageShell
      eyebrow="Voice API · Dubbing"
      title="Dub audio into another language"
      lede="Upload a recording and pick a target language. We transcribe, translate and re-voice it, matching the original timing as closely as we can."
    >
      <Dubber />
    </ToolPageShell>
  )
}
