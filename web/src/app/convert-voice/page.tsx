import RaHeader from '@/components/ra/RaHeader'
import RaFooter from '@/components/ra/RaFooter'
import VoiceConverter from '@/components/ra/VoiceConverter'

export const metadata = {
  title: 'Convert voice - ReadAloud AI',
  description: 'Convert speech from one voice to another with speech-to-speech AI.',
  robots: { index: false },
}

export default function ConvertVoicePage() {
  return (
    <div className="ra">
      <RaHeader />
      <main>
        <section className="ra-section" style={{ paddingTop: 48, minHeight: '70vh' }}>
          <div className="ra-wrap">
            <p className="ra-small" style={{ marginBottom: 8 }}>Voice API · Voice conversion</p>
            <h1 style={{ fontSize: 'clamp(2rem, 5vw, 3.2rem)', marginBottom: 12, maxWidth: '22ch' }}>Convert speech from one voice to another</h1>
            <p className="ra-lede" style={{ fontSize: '1.1rem', marginBottom: 28, maxWidth: '50ch' }}>
              Upload a source audio clip and a target voice reference. AI converts the speech — same words, new voice.
            </p>
            <VoiceConverter />
          </div>
        </section>
      </main>
      <RaFooter />
    </div>
  )
}
