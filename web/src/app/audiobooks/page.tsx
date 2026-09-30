import ToolPageShell from '@/components/ra/ToolPageShell'
import AudiobookMaker from '@/components/ra/AudiobookMaker'

export const metadata = {
  title: 'Audiobooks - ReadAloud AI',
  description: 'Turn text or an EPUB into a chaptered audiobook and export it as one MP3.',
  robots: { index: false },
}

export default function AudiobooksPage() {
  return (
    <ToolPageShell
      eyebrow="Voice API · Audiobooks"
      title="Turn a book into an audiobook"
      lede="Paste text or upload an EPUB. Chapters are detected and narrated one by one, then exported as a single MP3."
    >
      <AudiobookMaker />
    </ToolPageShell>
  )
}
