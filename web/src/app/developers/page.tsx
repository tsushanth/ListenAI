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
              Stream speech over a WebSocket, or transcribe recordings with batch <a href="#speech-to-text" style={{ textDecoration: 'underline' }}>speech to text</a>. Get a key below, then follow the three calls. New keys include 10,000 free characters.
            </p>
            <p style={{ marginTop: 12 }}>Using Claude, Cursor or VS Code? <Link href="/developers/mcp" style={{ textDecoration: 'underline' }}>Connect our MCP server</Link> with one URL instead.</p>
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

                <h3>Audio formats</h3>
                <p>Add <code>{'"format": "…"'}</code> to a synthesize message (Piper engine). <code>pcm_24000</code> is the default. For phone lines use <code>mulaw_8000</code> or <code>alaw_8000</code> (G.711, 8 kHz); <code>pcm_8000</code> is also available. Each <code>chunk_meta</code> reports the <code>format</code> and <code>sample_rate</code> of the audio that follows. An unknown format returns an error and the connection stays open.</p>

                <h3>HTTP streaming (Piper)</h3>
                <p><code>POST</code> to the <code>http_url</code> returned by authorize with <code>Authorization: Bearer &lt;token&gt;</code> and JSON <code>{'{ "text", "voice", "speed", "format" }'}</code>. The response streams raw audio as each sentence is ready, with <code>X-Sample-Rate</code> and <code>X-Audio-Format</code> headers. At capacity you get <code>503</code> with <code>Retry-After</code>.</p>

                <h3>SDKs and MCP</h3>
                <p>Python and JavaScript clients live in the <a href="https://github.com/tsushanth/realtime-tts/tree/main/sdk" style={{ textDecoration: 'underline' }}>sdk folder</a> of our repository. Because they take your API key, use them from a server, not a browser. To use the voices from an AI assistant, see the <Link href="/developers/mcp" style={{ textDecoration: 'underline' }}>MCP server</Link>.</p>

                <h3>Capacity and errors</h3>
                <p>Piper serves up to 4 simultaneous streams per server. Beyond that you get <code>{'{ "type": "error", "message": "at capacity, retry shortly" }'}</code> and the socket closes with code <code>1013</code>. Retry with a short backoff.</p>

                <h3>Custom voices (early access)</h3>
                <p>Trained voices are used with <code>{'"voice": "custom:<id>"'}</code>. Any other voice value uses the default voice. A voice can only be used by the API keys it was created for; anything else returns <code>unknown voice</code>. <a href="mailto:support@readaloudai.org?subject=Custom%20voice%20early%20access" style={{ textDecoration: 'underline' }}>Email us</a> to get started.</p>

                <h3 id="speech-to-text">Speech to text (batch)</h3>
                <p>Transcribe a finished recording with Whisper large-v3-turbo. This is batch only: you upload a file and get the whole transcript back. There is no live streaming transcription yet, no speaker labels (diarization) and no entity detection.</p>
                <p><b>1. Authorize.</b> <code>POST https://api.readaloudai.org/stt/authorize</code> with JSON <code>{'{ "key" }'}</code>. Returns <code>{'{ token, url }'}</code>. It uses the same key, the same <code>401</code> and <code>402</code> errors, and the same 60 second token as the voice API. Authorize again if the token has expired before you upload. It returns <code>501</code> if speech to text is not enabled.</p>
                <p><b>2. Upload.</b> <code>POST &lt;url&gt;/v1/stt</code> with <code>Authorization: Bearer &lt;token&gt;</code> and the audio as the raw request body, or as a <code>multipart/form-data</code> upload in a <code>file</code> field. Parameters go in the query string (or as form fields):</p>
                <ul>
                  <li><code>format</code> <code>auto</code> (default, detected from the file), <code>wav</code>, <code>flac</code>, <code>mp3</code>, <code>ogg</code> or <code>m4a</code>. For headerless phone audio use <code>mulaw_8000</code> or <code>alaw_8000</code> (G.711, 8 kHz mono) or <code>pcm_16000</code> (16-bit little-endian, 16 kHz mono).</li>
                  <li><code>language</code> <code>auto</code> (default) lets Whisper detect the language. Or pass a two-letter code such as <code>en</code>. Whisper supports many languages, but we have only measured accuracy on English.</li>
                  <li><code>word_timestamps</code> <code>true</code> (default) or <code>false</code>.</li>
                </ul>
                <p>The response is JSON: <code>{'{ text, language, language_probability, duration, words: [{ word, start, end }], segments: [{ id, start, end, text }] }'}</code>, with times in seconds. Long uploads may be answered with a <code>303</code> redirect while we work; your HTTP client has to follow it (<code>curl -L</code>; most libraries do).</p>
                <pre style={{ overflowX: 'auto' }}><code>{`TOKEN=$(curl -s https://api.readaloudai.org/stt/authorize \\
  -H 'content-type: application/json' -d '{"key":"rtts_..."}' | jq -r .token)
# the response also has "url": use it in place of <url> below
curl -L -X POST "<url>/v1/stt?language=auto" \\
  -H "Authorization: Bearer $TOKEN" --data-binary @call.wav`}</code></pre>
                <ul>
                  <li><code>400</code> unsupported or undecodable audio, an unknown <code>format</code> or <code>language</code>, or an empty body.</li>
                  <li><code>401</code> the token is missing, invalid or expired.</li>
                  <li><code>413</code> over the limits: 200 MB per upload and 3 hours of audio.</li>
                  <li><code>504</code> the request took longer than 15 minutes in total. Split the file and retry.</li>
                </ul>
                <p><b>Price:</b> $0.11 per hour of audio, billed by the second on the audio&rsquo;s full length (silence included) once the transcript is returned. Failed requests are not billed. That is half of ElevenLabs Scribe&rsquo;s list price of $0.22 per hour, when measured. It uses the same free allowance as the voice API: 10,000 free characters is about 54 minutes of audio. On your invoice it appears as character equivalents on the same meter (about 3 per second of audio).</p>
                <p><b>What we measured.</b> On 100 short clips of read English speech (LibriTTS-R, about 9 minutes, roughly 1,500 words) word error rate was 2.6% on clean audio and 2.8% on the same clips simulated as 8 kHz telephone audio. That is studio-quality read speech with no background noise or real codec damage, so expect worse on real calls, accents, crosstalk and noisy rooms, and expect the usual Whisper habit of occasionally inventing text over silence or noise. We have not yet measured other languages. Scribe&rsquo;s accuracy was not part of this comparison, only its price. The first request after a quiet period can take about ten extra seconds while a GPU starts.</p>

                <h3>Pricing and benchmarks</h3>
                <p>Piper $0.004 and Kokoro $0.01 per 1,000 characters; speech to text $0.11 per hour of audio. See <Link href="/#engines" style={{ textDecoration: 'underline' }}>engines and benchmarks</Link> for how we measured latency against ElevenLabs.</p>
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
