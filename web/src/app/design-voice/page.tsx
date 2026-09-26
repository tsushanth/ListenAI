import RaHeader from '@/components/ra/RaHeader'
import RaFooter from '@/components/ra/RaFooter'
import VoiceDesigner from '@/components/ra/VoiceDesigner'

export const metadata = {
  title: 'Design a voice - ReadAloud AI',
  description: 'Describe a voice in words and generate speech from it instantly.',
  robots: { index: false },
}

export default function DesignVoicePage() {
  return (
    <div className="ra">
      <RaHeader />
      <main>
        <section className="ra-section" style={{ paddingTop: 48, minHeight: '70vh' }}>
          <div className="ra-wrap">
            <p className="ra-small" style={{ marginBottom: 8 }}>Voice API · Voice design</p>
            <h1 style={{ fontSize: 'clamp(2rem, 5vw, 3.2rem)', marginBottom: 12, maxWidth: '22ch' }}>Describe a voice, hear it speak</h1>
            <p className="ra-lede" style={{ fontSize: '1.1rem', marginBottom: 28, maxWidth: '50ch' }}>
              Type a description — age, gender, accent, personality — and any words you want spoken. Parler-TTS generates the voice on demand, no training required.
            </p>
            <VoiceDesigner />
          </div>
        </section>
      </main>
      <RaFooter />
    </div>
  )
}
