import Link from 'next/link'
import RaHeader from '@/components/ra/RaHeader'
import RaFooter from '@/components/ra/RaFooter'
import LiveDemo from '@/components/ra/LiveDemo'
import CodeTabs from '@/components/ra/CodeTabs'

export default function Home() {
  return (
    <div className="ra">
      <RaHeader />
      <main>
        <section className="ra-hero">
          <div className="ra-wrap">
            <h1>Text to speech that keeps up with a phone call</h1>
            <p className="ra-lede">
              A streaming voice API for agents and apps. Audio starts in about 170 ms and costs from $4 per million characters.
            </p>
            <div className="ra-cta">
              <Link href="/developers#get-started" className="ra-btn solid">Get an API key</Link>
              <Link href="/developers#reference" className="ra-btn ghost">Read the docs</Link>
            </div>
            <LiveDemo />
          </div>
        </section>

        <section className="ra-wrap" aria-label="Key numbers">
          <div className="ra-facts">
            <div className="ra-fact">
              <b>About 170 ms</b>
              <span>To first audio, measured from a machine in San Jose. ElevenLabs Flash measured about 173 ms the same way.</span>
            </div>
            <div className="ra-fact">
              <b>$4 per million characters</b>
              <span>ElevenLabs Flash lists at $50 and Multilingual v2 at $100. You pay only for speech that finishes.</span>
            </div>
            <div className="ra-fact">
              <b>Interrupt mid-sentence</b>
              <span>Send stop and audio ends at once, so a caller who talks over the agent is heard without waiting.</span>
            </div>
          </div>
        </section>

        <section className="ra-section" id="engines">
          <div className="ra-wrap">
            <h2>Two engines, one API</h2>
            <p className="ra-lede" style={{ marginBottom: 32 }}>
              Choose per request with <code className="inl">engine</code> when you authorize. The protocol is identical, so switching is one field.
            </p>
            <div className="ra-table-wrap" style={{ marginBottom: 40 }}>
              <table className="ra-table">
                <thead><tr><th></th><th>Piper</th><th>Kokoro</th></tr></thead>
                <tbody>
                  <tr><td>Built for</td><td className="hl">Live calls and voice agents</td><td>The most natural read-aloud</td></tr>
                  <tr><td>Price</td><td className="hl">$0.004 per 1,000 characters</td><td>$0.01 per 1,000 characters</td></tr>
                  <tr><td>Voices</td><td className="hl">One American English voice</td><td>Multiple English voices</td></tr>
                  <tr><td>Limits</td><td className="hl">5,000 characters per request. Limited capacity, so retry when you get an &ldquo;at capacity&rdquo; error.</td><td>See the docs</td></tr>
                </tbody>
              </table>
            </div>

            <h3 style={{ fontSize: '1.5rem', marginBottom: 12 }}>How we compare with ElevenLabs</h3>
            <div className="ra-table-wrap">
              <table className="ra-table">
                <thead><tr><th>Service</th><th>Time to first audio (warm)</th><th>Price per 1M characters</th></tr></thead>
                <tbody>
                  <tr><td className="hl">ReadAloud Piper</td><td className="hl">168&ndash;171 ms</td><td className="hl">$4</td></tr>
                  <tr><td>ElevenLabs Flash v2.5</td><td>173&ndash;174 ms</td><td>$50</td></tr>
                  <tr><td>ElevenLabs Multilingual v2</td><td>about 1.0&ndash;1.1 s</td><td>$100</td></tr>
                </tbody>
              </table>
            </div>
            <p className="ra-small" style={{ marginTop: 14 }}>
              Measured September 2026 from one machine in San Jose, interleaved, in the same hour, on short call-center sentences, as time to the
              first audio byte on a warm streaming connection. ElevenLabs advertises 75 ms for Flash; that is model latency, while these figures are end to end, including the network. Piper and ElevenLabs Flash are within measurement noise, so we do not claim to be
              faster. Results vary by location and time of day. Prices are published list prices when measured. Voice quality is subjective, and
              ElevenLabs offers far more voices and languages. The scripts are in our{' '}
              <a href="https://github.com/tsushanth/realtime-tts/tree/main/benchmarks">public benchmarks folder</a>.
            </p>

            <h3 style={{ fontSize: '1.5rem', marginBottom: 12, marginTop: 40 }}>What you get for the price</h3>
            <div className="ra-table-wrap">
              <table className="ra-table">
                <thead><tr><th>Engine</th><th>Word error rate</th><th>Naturalness (proxy)</th><th>Price per 1M characters</th></tr></thead>
                <tbody>
                  <tr><td className="hl">ReadAloud Piper</td><td className="hl">10.4%</td><td className="hl">4.44 / 5</td><td className="hl">$4</td></tr>
                  <tr><td>ReadAloud Kokoro</td><td>5.8% (English only)</td><td>4.25 / 5</td><td>$10</td></tr>
                  <tr><td>ElevenLabs Flash v2.5</td><td>6.2%</td><td>4.52 / 5</td><td>$50</td></tr>
                  <tr><td>ElevenLabs Multilingual v2</td><td>4.3%</td><td>4.46 / 5</td><td>$100</td></tr>
                </tbody>
              </table>
            </div>
            <p className="ra-small" style={{ marginTop: 14 }}>
              Word error rate: 21 short call-center sentences across English, Spanish, German and French, transcribed with an
              open-source speech recognizer and compared to the known input text &mdash; lower is better. Naturalness: an automated
              MOS predictor scored against a shared reference clip per language, not a human listener &mdash; useful for comparing
              engines to each other, not as an absolute quality score. On this sample, Piper&rsquo;s error rate runs a bit higher than
              ElevenLabs&rsquo; and naturalness is essentially tied. We don&rsquo;t publish side-by-side audio samples; the sample size
              here (21 sentences) is small enough that we&rsquo;d rather you listen to Piper on your own text and judge for yourself.
              Full methodology, per-language breakdown, and caveats are in the{' '}
              <a href="https://github.com/tsushanth/realtime-tts/tree/main/eval">eval framework</a>, which we re-run after any engine change.
            </p>
          </div>
        </section>

        <section className="ra-section">
          <div className="ra-wrap ra-two">
            <div>
              <h2>From key to audio in three calls</h2>
              <p className="ra-lede">No SDK required. Audio arrives as raw PCM you can pipe to a phone line or a speaker.</p>
              <ol className="ra-steps">
                <li><span>1</span><div><b>Authorize</b><p>Trade your API key for a token that lasts 60 seconds. Your key never reaches the browser or the voice server.</p></div></li>
                <li><span>2</span><div><b>Connect</b><p>Open a WebSocket to the URL you were given. Keep it open across turns of a call.</p></div></li>
                <li><span>3</span><div><b>Synthesize</b><p>Send text, receive 24 kHz mono PCM as each sentence finishes, and send stop if the caller interrupts.</p></div></li>
              </ol>
              <p style={{ marginTop: 24 }}><Link href="/developers#reference" style={{ textDecoration: 'underline' }}>Full reference</Link></p>
            </div>
            <CodeTabs />
          </div>
        </section>

        <section className="ra-section">
          <div className="ra-wrap ra-two">
            <div>
              <h2>Your own voice, on the same API</h2>
              <p className="ra-lede">
                Give us about 20 minutes of clean recordings from someone who has agreed to it, and we train a voice for you and host it beside the built-in ones.
              </p>
            </div>
            <div className="ra-ref" style={{ marginTop: 0 }}>
              <ul>
                <li>The speaker&rsquo;s consent is recorded before anything is trained, and you can delete the voice and its training data at any time.</li>
                <li>You hear five preview samples, and can type your own text, before anything goes live.</li>
                <li>Once live, use it by sending <code>voice: &quot;custom:&lt;id&gt;&quot;</code>. Only your API keys can use it.</li>
                <li>Works best with steady, clear speech. Very theatrical delivery can sound unstable, and we warn you when we detect it.</li>
              </ul>
              <p style={{ marginTop: 20 }}>
                Early access. <a href="mailto:support@readaloudai.org?subject=Custom%20voice%20early%20access" style={{ textDecoration: 'underline' }}>Email us to get started</a>.
              </p>
            </div>
          </div>
        </section>

        <section className="ra-section" id="pricing">
          <div className="ra-wrap">
            <h2>Pay for what you stream</h2>
            <p className="ra-lede" style={{ marginBottom: 32 }}>Billed per character of speech that finishes. Cancelled requests are not billed.</p>
            <div className="ra-price">
              <div>
                <h3 style={{ fontSize: '1.2rem' }}>Free</h3>
                <div className="big">$0</div>
                <ul><li>10,000 characters to try it</li><li>No card required</li><li>Both engines</li></ul>
              </div>
              <div className="rec">
                <h3 style={{ fontSize: '1.2rem' }}>Piper</h3>
                <div className="big">$0.004 <small>per 1,000 characters</small></div>
                <ul><li>About 170 ms to first audio</li><li>Built for live calls</li><li>No minimums, no plan to manage</li></ul>
              </div>
              <div>
                <h3 style={{ fontSize: '1.2rem' }}>Kokoro</h3>
                <div className="big">$0.01 <small>per 1,000 characters</small></div>
                <ul><li>The most natural read-aloud</li><li>Multiple voices</li><li>Same API and keys</li></ul>
              </div>
            </div>
            <div className="ra-cta" style={{ marginTop: 28 }}>
              <Link href="/developers#get-started" className="ra-btn solid">Get an API key</Link>
            </div>
          </div>
        </section>

        <section className="ra-section" id="speech-to-text">
          <div className="ra-wrap ra-two">
            <div>
              <h2>Speech to text, too</h2>
              <p className="ra-lede">
                Upload a recording, get a transcript with word timestamps. Whisper large-v3-turbo, the same key, $0.11 per hour of audio.
              </p>
              <p style={{ marginTop: 16 }}><Link href="/developers#speech-to-text" style={{ textDecoration: 'underline' }}>Read the docs</Link></p>
            </div>
            <div className="ra-ref" style={{ marginTop: 0 }}>
              <ul>
                <li>That is half of ElevenLabs Scribe&rsquo;s list price of $0.22 per hour, when we measured. We have not compared accuracy with Scribe.</li>
                <li>Word error rate was 2.6% on clean read English and 2.8% on simulated phone audio. Real calls are noisier, so test on yours.</li>
                <li>Batch only for now: no live transcription, speaker labels or entity detection.</li>
                <li>Accepts wav, flac, mp3, ogg, m4a and raw mu-law or A-law phone audio. Up to 200 MB or 3 hours per file.</li>
              </ul>
            </div>
          </div>
        </section>

        <section className="ra-section">
          <div className="ra-wrap ra-two">
            <div><h2>Questions</h2></div>
            <div className="ra-faq">
              <details><summary>Which languages does it speak?</summary><p>English today. More languages are on the roadmap, and we would rather say so plainly than list languages we cannot yet do well.</p></details>
              <details><summary>How many calls can it handle at once?</summary><p>Piper is capped at 4 simultaneous streams per server for now, and rejects extra connections with a clear error instead of slowing everyone down. If you need more capacity, email us.</p></details>
              <details><summary>Why is it so much cheaper than ElevenLabs?</summary><p>Piper is a small model that runs on ordinary CPUs, so we do not pay for an always-on GPU. The trade-off is fewer voices and a less expressive read than the largest models.</p></details>
              <details><summary>Can I hear how it compares before I commit?</summary><p>Yes. Type your own text into the demo above, then use your free 10,000 characters to test it in your own app.</p></details>
            </div>
          </div>
        </section>

        <section className="ra-section">
          <div className="ra-wrap ra-strip">
            <div>
              <h3 style={{ fontSize: '1.5rem', marginBottom: 6 }}>Also: ReadAloud AI Reader</h3>
              <p className="ra-lede" style={{ fontSize: '1rem' }}>Listen to articles, PDFs and emails on your phone or in the browser.</p>
            </div>
            <div className="ra-cta">
              <Link href="https://play.google.com/store/apps/details?id=com.listenai" target="_blank" className="ra-btn ghost">Android app</Link>
              <Link href="/app" className="ra-btn ghost">Web app</Link>
              <Link href="/reader" className="ra-btn ghost">About the reader</Link>
            </div>
          </div>
        </section>
      </main>
      <RaFooter />
    </div>
  )
}
