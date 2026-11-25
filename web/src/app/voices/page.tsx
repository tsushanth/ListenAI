import RaHeader from '@/components/ra/RaHeader'
import RaFooter from '@/components/ra/RaFooter'
import VoiceStudio from '@/components/ra/VoiceStudio'
import FeatureUnavailable from '@/components/ra/FeatureUnavailable'
import { OFFERED_FEATURES, UNAVAILABLE_COPY } from '@/content/launchFlags'

export const metadata = {
  title: 'Custom voice - ReadAloud AI',
  description: 'Create a custom voice from your own recordings and use it in the Voice API.',
  robots: { index: false },
}

export default function VoicesPage() {
  if (!OFFERED_FEATURES.customVoiceStudio) {
    return <FeatureUnavailable title="Custom voice" message={UNAVAILABLE_COPY.customVoiceStudio} alternative={{ href: '/clone-voice', label: 'Clone a voice instantly from a short recording' }} />
  }
  return (
    <div className="ra">
      <RaHeader />
      <main>
        <section className="ra-section" style={{ paddingTop: 48, minHeight: '70vh' }}>
          <div className="ra-wrap">
            <p className="ra-small" style={{ marginBottom: 8 }}>Voice API · Custom voice</p>
            <h1 style={{ fontSize: 'clamp(2rem, 5vw, 3.2rem)', marginBottom: 28, maxWidth: '18ch' }}>Your own voice, from your own recordings</h1>
            <VoiceStudio />
          </div>
        </section>
      </main>
      <RaFooter />
    </div>
  )
}
