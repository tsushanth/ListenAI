import { notFound } from 'next/navigation'
import ToolPageShell from '@/components/ra/ToolPageShell'
import SoundEffectMaker from '@/components/ra/SoundEffectMaker'

export const metadata = {
  title: 'Sound effects - ReadAloud AI',
  description: 'Generate short sound effects from a text description.',
  robots: { index: false },
}

// Hidden while the feature is unprofitable and its worker is not deployed; set SOUND_EFFECTS_PUBLIC=true to show it.
export const dynamic = 'force-dynamic'

export default function SoundEffectsPage() {
  if (process.env.SOUND_EFFECTS_PUBLIC !== 'true') notFound()
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
