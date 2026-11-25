import Link from 'next/link'
import RaHeader from '@/components/ra/RaHeader'
import RaFooter from '@/components/ra/RaFooter'
import LiveDemo from '@/components/ra/LiveDemo'
import CodeTabs from '@/components/ra/CodeTabs'
import { RA_LANGUAGES, RA_VOICES } from '@/content/readaloudFacts'
import { playUrl } from '@/lib/playLinks'
import { OFFERED_FEATURES } from '@/content/launchFlags'

export default function Home() {
  return (
    <div className="ra">
      <RaHeader />
      <main>
        <section className="ra-hero">
          <div className="ra-wrap">
            <h1>Text to speech that keeps up with a phone call</h1>
            <p className="ra-lede">
              A streaming voice API for agents and apps. Audio starts in about 250 ms and costs from $4 per million characters.
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
              <b>About 250 ms</b>
              <span>To first audio on a warm streaming connection, measured end to end from a machine in San Jose.</span>
            </div>
            <div className="ra-fact">
              <b>$4 per million characters</b>
              <span>ReadAloud Live is $0.004 per 1,000 characters. You pay only for speech that finishes, with no minimums and no plan to manage.</span>
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
                  <tr><td>Voices</td><td className="hl">{RA_VOICES.liveCell}</td><td>{RA_VOICES.studioCell}</td></tr>
                  <tr><td>Limits</td><td className="hl">5,000 characters per request. Limited capacity, so retry when you get an &ldquo;at capacity&rdquo; error.</td><td>See the docs</td></tr>
                </tbody>
              </table>
            </div>

            <h3 style={{ fontSize: '1.5rem', marginBottom: 12 }}>How we measure speed</h3>
            <p className="ra-small" style={{ marginTop: 0 }}>
              Time to first audio is about 250 ms for ReadAloud Live. We measured it in October 2026 from one machine in San Jose, over several minutes,
              on short call-center sentences, as time to the first audio byte on a warm streaming connection, so it includes the network. Results vary by
              location and time of day. We can share the benchmark scripts and raw results on request.
            </p>

            <h3 style={{ fontSize: '1.5rem', marginBottom: 12, marginTop: 40 }}>Quality and price by engine</h3>
            <div className="ra-table-wrap">
              <table className="ra-table">
                <thead><tr><th>Engine</th><th>Word error rate</th><th>Naturalness (proxy)</th><th>Price per 1M characters</th></tr></thead>
                <tbody>
                  <tr><td className="hl">ReadAloud Live</td><td className="hl">10.4%</td><td className="hl">4.44 / 5</td><td className="hl">$4</td></tr>
                  <tr><td>ReadAloud Studio</td><td>5.8% (English only)</td><td>4.25 / 5</td><td>$10</td></tr>
                </tbody>
              </table>
            </div>
            <p className="ra-small" style={{ marginTop: 14 }}>
              Word error rate: 21 short call-center sentences across English, Spanish, German and French, transcribed with an
              open-source speech recognizer and compared to the known input text &mdash; lower is better. Naturalness: an automated
              MOS predictor scored against a shared reference clip per language, not a human listener &mdash; useful for comparing
              our two engines to each other, not as an absolute quality score. ReadAloud Live trades a somewhat higher error rate for speed and price.
              We don&rsquo;t publish side-by-side audio samples; the sample size here (21 sentences) is small enough that we&rsquo;d rather you
              listen to ReadAloud Live on your own text and judge for yourself. We re-run this evaluation after any engine change. Full methodology,
              the per-language breakdown and the caveats are available on request.
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

        {OFFERED_FEATURES.customVoiceStudio && (
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
        )}

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
                <ul><li>About 250 ms to first audio</li><li>Built for live calls</li><li>No minimums, no plan to manage</li></ul>
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
                Upload a recording, get a transcript with word timestamps. ReadAloud speech to text, the same key, $0.11 per hour of audio.
              </p>
              <div className="ra-table-wrap" style={{ marginTop: 20 }}>
                <table className="ra-table">
                  <thead><tr><th>Batch speech to text</th><th>Price per hour of audio</th></tr></thead>
                  <tbody>
                    <tr><td className="hl">ReadAloud</td><td className="hl">$0.11</td></tr>
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
                <li>Billed by the second of audio, so a short clip costs a fraction of a cent. Batch transcription is the priced product; realtime transcription is early and has no published price yet.</li>
                {/* Accuracy: research/W32/data/results_w32gpu.md (the live guard; W31 test split, real 8 kHz 296 items, noisy 10 dB 578 items, no dictionary). */}
                <li>On 296 real 8 kHz phone-style recordings (English, role-played calls) the word error rate was 9.8% and 90.2% of spoken digit sequences came out exactly right. With 10 dB background noise added it was 17.8% and 84.6%, so noisy lines are our weaker case. One test set, so test on your own audio. <Link href="/developers#stt-how-we-measured" style={{ textDecoration: 'underline' }}>How we measured</Link>.</li>
                {/* Speaker labels: research/W43/REALCALL_VALIDATION.md; limits documented at /developers#speech-to-text. */}
                <li>Batch only for now: no live transcription or entity detection. Speaker labels (<code>diarize=true</code>) are available: 99.0% of words went to the right side on 78 real two-person calls, but the speaker count was exactly right on only 67% of them.</li>
                <li>Accepts wav, flac, mp3, ogg, m4a and raw mu-law or A-law phone audio. Up to 200 MB or 3 hours per file.</li>
              </ul>
            </div>
          </div>
        </section>

        <section className="ra-section">
          <div className="ra-wrap ra-two">
            <div><h2>Questions</h2></div>
            <div className="ra-faq">
              <details><summary>Which languages does it speak?</summary><p>{RA_LANGUAGES.faq}</p></details>
              <details><summary>How many calls can it handle at once?</summary><p>Each ReadAloud Live server handles up to 12 simultaneous streams, and a second server starts automatically under load. Beyond that, new connections get an &ldquo;at capacity&rdquo; error and should retry shortly. If you need guaranteed capacity, email us.</p></details>
              <details><summary>Why is it priced so low?</summary><p>ReadAloud Live is a small model that runs on ordinary CPUs, so we do not pay for an always-on GPU. The trade-off is fewer voices and a less expressive read than the largest models.</p></details>
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
              <Link href={playUrl('home_reader')} target="_blank" className="ra-btn ghost">Android app</Link>
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
