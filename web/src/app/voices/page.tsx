import RaHeader from '@/components/ra/RaHeader'
import RaFooter from '@/components/ra/RaFooter'
import VoiceStudio from '@/components/ra/VoiceStudio'

export const metadata = {
  title: 'Custom voice - ReadAloud AI',
  description: 'Create a custom voice from your own recordings and use it in the Voice API.',
  robots: { index: false },
}

export default function VoicesPage() {
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
