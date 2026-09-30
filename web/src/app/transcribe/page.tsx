import ToolPageShell from '@/components/ra/ToolPageShell'
import Transcriber from '@/components/ra/Transcriber'

export const metadata = {
  title: 'Transcribe audio - ReadAloud AI',
  description: 'Turn recordings into text with word timestamps. Download TXT, SRT or VTT.',
  robots: { index: false },
}

export default function TranscribePage() {
  return (
    <ToolPageShell
      eyebrow="Voice API · Speech to text"
      title="Turn a recording into a transcript"
      lede="Upload audio, get the text with word timestamps. Copy it or download it as TXT, SRT or VTT."
    >
      <Transcriber />
    </ToolPageShell>
  )
}
