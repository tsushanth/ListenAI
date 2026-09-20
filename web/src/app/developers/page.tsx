import Link from 'next/link'
import RaHeader from '@/components/ra/RaHeader'
import RaFooter from '@/components/ra/RaFooter'
import CodeTabs from '@/components/ra/CodeTabs'
import DeveloperApiSection from '@/components/DeveloperApiSection'

export const metadata = {
  title: 'Voice API - ReadAloud AI',
  description: 'Streaming text-to-speech over WebSocket. Get a key, connect, and stream 24 kHz PCM as each sentence is ready.',
}

export default function DevelopersPage() {
  return (
    <div className="ra">
      <RaHeader />
      <main>
        <section className="ra-hero" style={{ paddingBottom: 32 }}>
          <div className="ra-wrap">
            <h1 style={{ maxWidth: '16ch' }}>Voice API</h1>
            <p className="ra-lede">
              Stream speech over a WebSocket. Get a key below, then follow the three calls. New keys include 10,000 free characters.
            </p>
          </div>
        </section>

        <section className="ra-section" id="get-started" style={{ paddingTop: 40 }}>
          <div className="ra-wrap ra-narrow" style={{ maxWidth: 760 }}>
            <h2>Get your API key</h2>
            <p className="ra-lede" style={{ marginBottom: 24 }}>Sign in, create a key, and it works straight away.</p>
            <div className="ra-dark-panel"><DeveloperApiSection /></div>
          </div>
        </section>

        <section className="ra-section" id="reference">
          <div className="ra-wrap">
            <h2>Reference</h2>
            <div className="ra-two" style={{ marginTop: 24 }}>
              <div className="ra-ref">
                <h3 style={{ marginTop: 0 }}>Authorize</h3>
                <p><code>POST https://api.readaloudai.org/tts/authorize</code> with JSON <code>{'{ "key", "engine" }'}</code>. <code>engine</code> is <code>&quot;piper&quot;</code> or <code>&quot;kokoro&quot;</code> and defaults to Kokoro. Returns <code>{'{ token, url }'}</code>. The token lasts 60 seconds, so authorize again for each new connection.</p>
                <ul>
                  <li><code>401</code> the key is invalid or revoked.</li>
                  <li><code>402</code> the free characters are used up. Add a payment method in your dashboard.</li>
                  <li><code>400</code> unknown engine.</li>
                </ul>

                <h3>Connect</h3>
                <p>Open <code>{'wss://…/tts?token=<token>'}</code> at the URL from authorize. Keep the connection open across requests. Audio is PCM16 little-endian, mono, 24 kHz.</p>

                <h3>Messages you send</h3>
                <ul>
                  <li><code>{'{ "type": "synthesize", "text": "…", "voice": "default", "speed": 1.0 }'}</code> speaks the text. Piper accepts up to 5,000 characters per request.</li>
                  <li><code>{'{ "type": "stop" }'}</code> ends the current speech at once. Use it when the caller interrupts.</li>
                </ul>

                <h3>Messages you receive</h3>
                <ul>
                  <li><code>chunk_meta</code> a JSON frame, immediately followed by one binary audio frame, once per sentence.</li>
                  <li><code>done</code> the request finished. <code>cancelled</code> you stopped it. Only finished requests are billed.</li>
                  <li><code>error</code> with a <code>message</code>. The connection stays usable unless it is closed.</li>
                </ul>

                <h3>Capacity and errors</h3>
                <p>Piper serves up to 4 simultaneous streams per server. Beyond that you get <code>{'{ "type": "error", "message": "at capacity, retry shortly" }'}</code> and the socket closes with code <code>1013</code>. Retry with a short backoff.</p>

                <h3>Custom voices (early access)</h3>
                <p>Trained voices are used with <code>{'"voice": "custom:<id>"'}</code>. Any other voice value uses the default voice. A voice can only be used by the API keys it was created for; anything else returns <code>unknown voice</code>. <a href="mailto:support@readaloudai.org?subject=Custom%20voice%20early%20access" style={{ textDecoration: 'underline' }}>Email us</a> to get started.</p>

                <h3>Pricing and benchmarks</h3>
                <p>Piper $0.004 and Kokoro $0.01 per 1,000 characters. See <Link href="/#engines" style={{ textDecoration: 'underline' }}>engines and benchmarks</Link> for how we measured latency against ElevenLabs.</p>
              </div>
              <div><CodeTabs /></div>
            </div>
          </div>
        </section>
      </main>
      <RaFooter />
    </div>
  )
}
