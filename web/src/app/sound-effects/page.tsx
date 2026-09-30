import ToolPageShell from '@/components/ra/ToolPageShell'
import SoundEffectMaker from '@/components/ra/SoundEffectMaker'

export const metadata = {
  title: 'Sound effects - ReadAloud AI',
  description: 'Generate short sound effects from a text description.',
  robots: { index: false },
}

export default function SoundEffectsPage() {
  return (
    <ToolPageShell
      eyebrow="Voice API · Sound effects"
      title="Generate a sound effect from a description"
      lede="Describe a sound, choose 1 to 12 seconds, and get a clip you can play and download."
    >
      <SoundEffectMaker />
    </ToolPageShell>
  )
}
