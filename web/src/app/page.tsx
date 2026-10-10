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
              A streaming voice API for agents and apps. Audio starts in about 200 ms and costs from $4 per million characters.
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
              <b>About 200 ms</b>
              <span>To first audio, measured from a machine in San Jose. ElevenLabs Flash measured about 165 ms the same way, at ten times the price.</span>
            </div>
            <div className="ra-fact">
              <b>$4 per million characters</b>
              <span>ElevenLabs Flash lists at $40 and Multilingual v2 at $80 (list prices, as of 2026-09). You pay only for speech that finishes.</span>
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
                <thead><tr><th></th><th>ReadAloud Live</th><th>ReadAloud Studio</th></tr></thead>
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
                  <tr><td className="hl">ReadAloud Live</td><td className="hl">about 205 ms</td><td className="hl">$4</td></tr>
                  <tr><td>ElevenLabs Flash v2.5</td><td>about 165 ms</td><td>$40</td></tr>
                  <tr><td>ElevenLabs Multilingual v2</td><td>about 1.05 s</td><td>$80</td></tr>
                </tbody>
              </table>
            </div>
            <p className="ra-small" style={{ marginTop: 14 }}>
              Measured October 2026 from one machine in San Jose, interleaved over several minutes, in the same hour, on short call-center sentences, as time to the
              first audio byte on a warm streaming connection. ElevenLabs advertises 75 ms for Flash; that is model latency, while these figures are end to end, including the network. ElevenLabs Flash is about 40 ms faster than ReadAloud Live at the median (24 requests each); ReadAloud Live costs a tenth as much. Results vary by location and time of day. ElevenLabs prices are its published API list prices as of 2026-09; the latency and quality figures are from our own runs. Voice quality is subjective, and
              ElevenLabs offers far more voices and languages. We can share the benchmark scripts and raw results on request.
            </p>

            <h3 style={{ fontSize: '1.5rem', marginBottom: 12, marginTop: 40 }}>What you get for the price</h3>
            <div className="ra-table-wrap">
              <table className="ra-table">
                <thead><tr><th>Engine</th><th>Word error rate</th><th>Naturalness (proxy)</th><th>Price per 1M characters</th></tr></thead>
                <tbody>
                  <tr><td className="hl">ReadAloud Live</td><td className="hl">10.4%</td><td className="hl">4.44 / 5</td><td className="hl">$4</td></tr>
                  <tr><td>ReadAloud Studio</td><td>5.8% (English only)</td><td>4.25 / 5</td><td>$10</td></tr>
                  <tr><td>ElevenLabs Flash v2.5</td><td>6.2%</td><td>4.52 / 5</td><td>$40</td></tr>
                  <tr><td>ElevenLabs Multilingual v2</td><td>4.3%</td><td>4.46 / 5</td><td>$80</td></tr>
                </tbody>
              </table>
            </div>
            <p className="ra-small" style={{ marginTop: 14 }}>
              Word error rate: 21 short call-center sentences across English, Spanish, German and French, transcribed with an
              open-source speech recognizer and compared to the known input text &mdash; lower is better. Naturalness: an automated
              MOS predictor scored against a shared reference clip per language, not a human listener &mdash; useful for comparing
              engines to each other, not as an absolute quality score. On this sample, ReadAloud Live&rsquo;s error rate runs a bit higher than
              ElevenLabs&rsquo; and naturalness is essentially tied. We don&rsquo;t publish side-by-side audio samples; the sample size
              here (21 sentences) is small enough that we&rsquo;d rather you listen to ReadAloud Live on your own text and judge for yourself.
              We re-run this evaluation after any engine change. Full methodology, the per-language breakdown and the caveats are available on request.
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
                <h3 style={{ fontSize: '1.2rem' }}>ReadAloud Live</h3>
                <div className="big">$0.004 <small>per 1,000 characters</small></div>
                <ul><li>About 200 ms to first audio</li><li>Built for live calls</li><li>No minimums, no plan to manage</li></ul>
              </div>
              <div>
                <h3 style={{ fontSize: '1.2rem' }}>ReadAloud Studio</h3>
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
              <div className="ra-table-wrap" style={{ marginTop: 20 }}>
                <table className="ra-table">
                  <thead><tr><th>Batch speech to text</th><th>Price per hour of audio</th></tr></thead>
                  <tbody>
                    <tr><td className="hl">ReadAloud</td><td className="hl">$0.11</td></tr>
                    <tr><td>ElevenLabs Scribe (API list price, as of 2026-10)</td><td>$0.22</td></tr>
                  </tbody>
                </table>
              </div>
              <p className="ra-small" style={{ marginTop: 12 }}>
                Cold start: the first request after a quiet period takes about 10 seconds while our GPU starts. After that, a short clip typically
                comes back in about a second (our own measurement, October 2026, from one machine). Billed by the second of audio, 10 second minimum per request; failed requests are not billed.
              </p>
              <p style={{ marginTop: 16 }}><Link href="/developers#speech-to-text" style={{ textDecoration: 'underline' }}>Read the docs</Link></p>
            </div>
            <div className="ra-ref" style={{ marginTop: 0 }}>
              <ul>
                <li>That is half of ElevenLabs Scribe&rsquo;s batch API list price (its realtime price is $0.39 per hour). We have not compared accuracy with Scribe.</li>
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
              <details><summary>How many calls can it handle at once?</summary><p>Each ReadAloud Live server handles up to 12 simultaneous streams, and a second server starts automatically under load. Beyond that, new connections get an &ldquo;at capacity&rdquo; error and should retry shortly. If you need guaranteed capacity, email us.</p></details>
              <details><summary>Why is it so much cheaper than ElevenLabs?</summary><p>ReadAloud Live is a small model that runs on ordinary CPUs, so we do not pay for an always-on GPU. The trade-off is fewer voices and a less expressive read than the largest models.</p></details>
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
