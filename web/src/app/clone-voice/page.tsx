import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Voice Cloning Unavailable — ReadAloud AI',
  description: 'Instant voice cloning is no longer available. Custom voice creation through voice design and conversion is still offered.',
}

export default function CloneVoicePage() {
  return (
    <main className="ra-page">
      <div className="ra-wrap" style={{ maxWidth: 640 }}>
        <h1>Instant voice cloning is unavailable</h1>
        <p className="ra-lede" style={{ marginBottom: 24 }}>
          We have removed instant voice cloning from the service.
        </p>
        <p style={{ marginBottom: 16 }}>
          If you need a custom voice, you can still use{' '}
          <a href="/design-voice" style={{ textDecoration: 'underline' }}>voice design</a>{' '}
          (create a new voice from a text description) or{' '}
          <a href="/convert-voice" style={{ textDecoration: 'underline' }}>voice conversion</a>{' '}
          (make an existing recording sound like another speaker).
        </p>
        <p>
          For questions, contact{' '}
          <a href="mailto:support@readaloudai.org" style={{ textDecoration: 'underline' }}>
            support@readaloudai.org
          </a>.
        </p>
      </div>
    </main>
  )
}
