import RaHeader from '@/components/ra/RaHeader'
import RaFooter from '@/components/ra/RaFooter'
import VoiceCloneStudio from '@/components/ra/VoiceCloneStudio'

export const metadata = {
  title: 'Clone your voice - ReadAloud AI',
  description: 'Create a speech voice from your own recording. Consent is verified live, in your browser, before any voice is created.',
  robots: { index: false },
}

export default function CloneVoicePage() {
  return (
    <div className="ra">
      <RaHeader />
      <main>
        <section className="ra-section" style={{ paddingTop: 48, minHeight: '70vh' }}>
          <div className="ra-wrap">
            <p className="ra-small" style={{ marginBottom: 8 }}>Voice API · Voice cloning</p>
            <h1 style={{ fontSize: 'clamp(2rem, 5vw, 3.2rem)', marginBottom: 12, maxWidth: '22ch' }}>Clone your own voice</h1>
            <p className="ra-lede" style={{ fontSize: '1.1rem', marginBottom: 28, maxWidth: '54ch' }}>
              Your own voice only. You read a random phrase aloud, live, to prove consent, then add a reference recording of yourself. Requires a verified email and a paid or comped account.
            </p>
            <VoiceCloneStudio />
          </div>
        </section>
      </main>
      <RaFooter />
    </div>
  )
}
