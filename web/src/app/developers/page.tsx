import Link from 'next/link'
import RaHeader from '@/components/ra/RaHeader'
import RaFooter from '@/components/ra/RaFooter'
import CodeTabs from '@/components/ra/CodeTabs'
import DeveloperApiSection from '@/components/DeveloperApiSection'
import VoiceStudioLink from '@/components/ra/VoiceStudioLink'
import VoiceCloningDocs from '@/components/ra/VoiceCloningDocs'
import OrpheusCloningDocs from '@/components/ra/OrpheusCloningDocs'

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
              Stream speech over a WebSocket, or transcribe recordings with batch <a href="#speech-to-text" style={{ textDecoration: 'underline' }}>speech to text</a>. Get a key below, then follow the three calls. Every account starts with free credits.
            </p>
            <p style={{ marginTop: 12 }}>Using Claude, Cursor or VS Code? <Link href="/developers/mcp" style={{ textDecoration: 'underline' }}>Connect our MCP server</Link> with one URL instead.</p>
            <VoiceStudioLink />
          </div>
        </section>

        <section className="ra-section" id="get-started" style={{ paddingTop: 40 }}>
          <div className="ra-wrap ra-narrow" style={{ maxWidth: 760 }}>
            <h2>Get your API key</h2>
            <p className="ra-lede" style={{ marginBottom: 24 }}>Sign in, create a key, and it works straight away.</p>
            <div className="ra-dark-panel"><DeveloperApiSection /></div>
            <p className="ra-small" id="free-credits" style={{ marginTop: 16 }}>
              <b>Free credits.</b> Every account gets a one-time grant of free credits (worth $0.10, about 10,000 characters of speech), shared across speech, transcription, dubbing, voice isolation, voice conversion and voice design. Long jobs use more credits than short ones. When they run out those tools return <code>402</code> until you add a payment method; after that you pay as you go. Accounts without a payment method can hold one active API key, and text to speech through a key has its own 10,000 character allowance per key. Voice cloning and music generation always need a payment method.
            </p>
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
                <p>The API is plain WebSocket and HTTP, so any client works; official client libraries are on PyPI and npm: <code>pip install readaloud</code> and <code>npm install readaloud</code>. Because a client takes your API key, use it from a server, not a browser. To use the voices from an AI assistant, see the <Link href="/developers/mcp" style={{ textDecoration: 'underline' }}>MCP server</Link>.</p>

                <h3>Capacity and errors</h3>
                <p>Each Piper server handles up to 12 simultaneous streams, and a second server starts automatically under load. Beyond that you get <code>{'{ "type": "error", "message": "at capacity, retry shortly" }'}</code> and the socket closes with code <code>1013</code>. Retry with a short backoff.</p>

                <h3 id="voice-cloning">Voice cloning</h3>
                <p>Create a custom voice from your own recordings and use it with <code className="inl">custom:&lt;id&gt;</code>. Training runs automatically on GPU and takes about 30–60 minutes.</p>
                <VoiceCloningDocs />

                <h3 id="streaming-cloning">Low-latency streaming clone</h3>
                <p>
                  A second, faster cloning path on a different model (Orpheus, a neural codec language
                  model), aimed at conversational agents that need speech to start well under a second
                  after the request. Self-serve, the same shape as regular voice cloning:{' '}
                  <code className="inl">custom-fast:&lt;id&gt;</code> voices, 8&ndash;20 minutes of your
                  own recordings, synthesized as PCM16, 24&nbsp;kHz, mono (matching the rest of this
                  API), gated behind a billing-enabled API key (the gateway returns <code>402</code>{' '}
                  otherwise). Training takes roughly 10&ndash;90 minutes; we use that wait to warm the
                  serving container too, so a voice is only reported <code>ready</code> once it can
                  actually serve a fast request &mdash; you should not see a cold-start delay on your
                  first synthesis call for a newly trained voice.
                </p>
                <p><b>What we measured, warm.</b> A pilot voice reached a median time-to-first-audio-chunk
                  of about 550&ndash;580&nbsp;ms once warm, against a 500&nbsp;ms target &mdash; close,
                  not there yet. Two open issues we're still tuning: generation currently runs at
                  roughly 1.6&ndash;2.7&times; real time, and utterance length is not yet reliably
                  controlled &mdash; the same prompt can produce anywhere from a third of a second to
                  several seconds of audio. Both point to needing a larger training run per voice, not
                  a serving-side fix, but we haven't verified that yet. Responses are also buffered
                  end-to-end through this proxy chain rather than truly streamed &mdash; a known,
                  separately tracked limitation, so what you actually wait for today is closer to full
                  generation time (utterance length &times; the real-time factor above) than the
                  time-to-first-chunk number by itself.
                </p>
                <OrpheusCloningDocs />

                <h3 id="speech-to-text">Speech to text (batch)</h3>
                <p>Transcribe a finished recording with Whisper large-v3-turbo. Try it in the browser at <Link href="/transcribe" style={{ textDecoration: 'underline' }}>/transcribe</Link>, or with an API key through the MCP tool <code>speech_to_text</code> (up to 25&nbsp;MB per call). This is batch only: you upload a file and get the whole transcript back. There is no live streaming transcription yet, no speaker labels (diarization) and no entity detection.</p>
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
                <p><b>Price:</b> $0.11 per hour of audio, billed by the second on the audio&rsquo;s full length (silence included) once the transcript is returned, with a 10 second minimum per request (so a 3 second clip is billed as 10 seconds, $0.0003). The minimum is billing only: the transcript and the returned duration are unchanged. Failed requests, and requests with no audio, are not billed. That is half of ElevenLabs Scribe&rsquo;s batch list price of $0.22 per hour (as of 2026-09; its realtime price is $0.39 per hour). It uses the same free allowance as the voice API: 10,000 free characters is about 54 minutes of audio. On your invoice it appears as character equivalents on the same meter (about 3 per second of audio).</p>
                <p><b>What we measured.</b> On 100 short clips of read English speech (LibriTTS-R, about 9 minutes, roughly 1,500 words) word error rate was 2.6% on clean audio and 2.8% on the same clips simulated as 8 kHz telephone audio. That is studio-quality read speech with no background noise or real codec damage, so expect worse on real calls, accents, crosstalk and noisy rooms, and expect the usual Whisper habit of occasionally inventing text over silence or noise. We have not yet measured other languages. Scribe&rsquo;s accuracy was not part of this comparison, only its price. The first request after a quiet period can take about ten extra seconds while a GPU starts.</p>
                <p><b>Cold starts and timeouts.</b> The first request after a quiet period can take 10 to 18 seconds while the GPU starts. Use a request timeout of at least 60 seconds, and retry once on a timeout or a 5xx response. After that, a short clip takes about a second. The web transcribe page pre-warms the worker when you open it; pre-warming for MCP sessions is planned but not live yet, so MCP clients should apply the same timeout and one retry.</p>

                <h3 id="dubbing">Dubbing</h3>
                <p>
                  Upload a recording in one language and get back a version spoken in another,
                  with each translated segment timed to roughly match the original. Pipeline:
                  transcribe (Whisper) &rarr; translate segment-by-segment (Claude) &rarr;
                  resynthesize each segment, speeding up or slowing down (0.5&times;&ndash;2&times;)
                  so it fits the original segment&rsquo;s timing. Try it in the browser at{' '}
                  <Link href="/dub" style={{ textDecoration: 'underline' }}>/dub</Link>.
                </p>
                <p><b>Credentials.</b> The REST endpoints below (dubbing, voice
                  isolation, voice conversion, voice design and audiobooks) accept either a signed-in{' '}
                  <b>session token</b> (<code>Authorization: Bearer &lt;session token&gt;</code>) or an
                  API key that our own <Link href="/developers/mcp" style={{ textDecoration: 'underline' }}>MCP server</Link>{' '}
                  passes on for you. They do <b>not</b> accept your <code>rtts_</code> key
                  directly: the <code>key</code>/<code>authorize</code> flow used elsewhere on this page
                  does not apply here, and there is no way to send the key straight to these paths. To
                  use an API key, call the matching MCP tool (<code>dub_audio</code>,{' '}
                  <code>isolate_voice</code>,{' '}
                  <code>convert_voice</code>, <code>design_voice</code>, the audiobook tools).
                  Through MCP, the work is billed to the account the key belongs to. Keys you create
                  in the console above belong to your account; a key that is not tied to an account
                  gets <code>402</code> from dubbing, voice design and voice conversion. Free credits are per account, so they follow the account, not the key.
                  Speech to text and voice cloning have their own key-based routes, described in their
                  sections.
                </p>
                <p><b>1. Submit.</b> <code>POST https://api.readaloudai.org/api/dub</code>,
                  <code>Authorization: Bearer &lt;your session token&gt;</code> (or use the MCP tool <code>dub_audio</code> with an API key; the tool takes clips up to 25&nbsp;MB),
                  <code>multipart/form-data</code> with an <code>audio</code> file (wav, flac, ogg,
                  mp3, mp4, m4a or webm, up to 50&nbsp;MB) and body fields <code>target_language</code>{' '}
                  (required), <code>source_language</code> (optional, auto-detected otherwise) and{' '}
                  <code>voice_id</code> (optional). Returns <code>202</code> with{' '}
                  <code>{'{ job_id, status: "processing" }'}</code>.
                </p>
                <p><b>2. Poll.</b> <code>GET /api/dub/:job_id</code> returns{' '}
                  <code>{'{ status, audio_url, segments: [{ source_text, translated_text, start_sec, end_sec, speed_used }], error }'}</code>{' '}
                  once <code>status</code> is <code>ready</code> or <code>failed</code>. The result is a
                  single WAV file. The MCP equivalent is <code>get_dub_status</code>.
                </p>
                <ul>
                  <li><code>400</code> missing/oversized/unsupported audio, or a missing <code>target_language</code>.</li>
                  <li><code>402</code> your free credits are used up. Add a payment method.</li>
                  <li><code>404</code> unknown job, or a job that belongs to someone else.</li>
                </ul>
                <p><b>Price:</b> $0.15 per minute of source audio, billed by the second rounded up, with a 30 second minimum ($0.075), once the job completes. Failed jobs are not billed. On your invoice it appears as character equivalents on the same meter as text-to-speech (250 per second of audio; 15,000 per minute).</p>
                <p><b>Known limitations.</b> Audio only &mdash; no video muxing or subtitle burn-in. Segment timing is a v1 approximation (whole-segment speed scaling, not real phoneme-level alignment), so lip-sync-grade timing shouldn&rsquo;t be expected. Jobs run in-memory on a single instance rather than a durable queue, so a deploy or restart while a job is in flight will lose it &mdash; resubmit if that happens. Each segment over 2,000 characters is truncated.</p>

                <h3 id="sound-effects">Sound effects</h3>
                <p>Sound effect generation is temporarily unavailable while we rework its cost. It will return here when it is ready.</p>

                <h3 id="voice-isolate-convert">Voice isolation &amp; voice conversion</h3>
                <p>
                  Two related tools, each spinning up your own on-demand GPU container so your
                  audio never sits on a shared server: <b>voice isolation</b> strips background
                  noise/music from a recording (optionally also returning the isolated
                  instrumental), and <b>voice conversion</b> re-sings/re-speaks a source
                  recording in a target voice. Try isolation in the browser at{' '}
                  <Link href="/isolate-voice" style={{ textDecoration: 'underline' }}>/isolate-voice</Link>. Both accept a session
                  token, or an API key through the MCP tools <code>isolate_voice</code> and{' '}
                  <code>convert_voice</code> (see Credentials under dubbing above). Not every
                  container step is automatic for API-key callers: <code>convert_voice</code> sets up
                  your private converter on the first call (about 3 minutes, and it returns a
                  temporary error until it is ready, so call it again), but <code>isolate_voice</code> does
                  not deploy for you. Deploy isolation first, from{' '}
                  <Link href="/isolate-voice" style={{ textDecoration: 'underline' }}>/isolate-voice</Link> while signed in
                  to the same account; until then isolation requests fail with <code>400</code>.
                </p>
                <p><b>Known limitation.</b> Isolation is Demucs, which was built for music. On real speech
                  recordings (room noise, crosstalk, reverb) it removes less noise than dedicated speech
                  enhancement models, so treat it as vocal/instrumental separation rather than a
                  studio-grade noise remover, and listen to the result before relying on it.
                </p>
                <p><b>Voice design.</b> <code>POST /api/voice-design</code> generates a synthetic voice from a
                  text description and a sample sentence (session token, or the MCP tools{' '}
                  <code>design_voice</code> and <code>get_voice_design</code>). Try it at{' '}
                  <Link href="/design-voice" style={{ textDecoration: 'underline' }}>/design-voice</Link>. It uses your free
                  credits, then needs a payment method. Voice conversion also has a browser page at{' '}
                  <Link href="/convert-voice" style={{ textDecoration: 'underline' }}>/convert-voice</Link>.
                </p>
                <p><b>1. Deploy your container.</b> <code>POST /api/voice-isolate/deploy</code> or{' '}
                  <code>POST /api/voice-convert/deploy</code> (same session-token auth). Check status with{' '}
                  <code>GET .../deploy</code>, tear down with <code>DELETE .../deploy</code> when you&rsquo;re done
                  &mdash; you aren&rsquo;t billed for idle deploy time, only completed jobs (see pricing below).
                </p>
                <p><b>2. Submit a job.</b> <code>POST /api/voice-isolate/isolations</code> (multipart{' '}
                  <code>input</code> file) or <code>POST /api/voice-convert/conversions</code> (multipart{' '}
                  <code>source</code> + <code>target</code> files) &mdash; wav, flac, ogg, mp3, mp4 or m4a, up to
                  50&nbsp;MB (isolate) or 25&nbsp;MB (convert). Both require an exact{' '}
                  <code>consent_statement</code> field confirming you have rights to the audio. Isolation also
                  takes an optional <code>want_instrumental</code> boolean.
                </p>
                <p><b>3. Poll and fetch.</b> <code>GET .../isolations/:id</code> or{' '}
                  <code>.../conversions/:id</code> for status, then <code>GET .../:id/audio</code> for the
                  result (raw WAV bytes).
                </p>
                <ul>
                  <li><code>400</code> no deployment, missing/bad file, or missing/wrong <code>consent_statement</code>.</li>
                  <li><code>400</code> with <code>code: "deployment_required"</code> (conversion): no converter yet. <code>POST /api/voice-convert/deploy</code>, poll <code>GET</code> until <code>status: "ready"</code> (about 3 minutes), then retry.</li>
                  <li><code>401</code> not signed in. <code>402</code> your free credits are used up. Add a payment method.</li>
                  <li><code>409</code> a deployment already exists. <code>429</code> over 10 requests/hour.</li>
                  <li><code>503</code> the GPU backend isn&rsquo;t configured in this environment.</li>
                </ul>
                <p><b>Price:</b> voice isolation is $0.05 per minute of input audio, with a 45 second minimum ($0.0375). Voice conversion is $0.10 per minute of source audio, with a 45 second minimum ($0.075). Both are billed by the second rounded up, only for completed jobs. On your invoice they appear as character equivalents on the same meter as text-to-speech (isolation 5,000 per minute, conversion 10,000 per minute). Voice design is billed per generated voice on its own meter.</p>

                <h3 id="audiobooks">Audiobooks</h3>
                <p>
                  Turn a block of text or an EPUB into a chaptered audiobook: each chapter is
                  synthesized as its own long-form job, then all chapters can be exported as one
                  MP3 with embedded chapter markers. Try it in the browser at{' '}
                  <Link href="/audiobooks" style={{ textDecoration: 'underline' }}>/audiobooks</Link>. Accepts a session token, or an
                  API key through the MCP tools <code>create_audiobook</code>,{' '}
                  <code>get_audiobook_status</code> and <code>export_audiobook</code>.
                </p>
                <p><b>1. Create.</b> <code>POST /api/audiobooks</code> with{' '}
                  <code>{'{ title, voice_id, speed?, source_type: "text" | "epub", text? | epub_base64? }'}</code>.
                  Chapters are detected automatically and queued as individual TTS jobs.
                </p>
                <p><b>2. Poll.</b> <code>GET /api/audiobooks/:id/status</code> for per-chapter status
                  and duration.
                </p>
                <p><b>3. Export.</b> Once every chapter is <code>ready</code>,{' '}
                  <code>POST /api/audiobooks/:id/export</code> concatenates them into one MP3 with ID3
                  chapter markers and returns a signed download URL.
                </p>
                <ul>
                  <li><code>400</code> a chapter isn&rsquo;t ready yet, no chapters detected, or a chapter over
                    your plan&rsquo;s per-job character limit.</li>
                  <li><code>404</code> unknown audiobook, or one that belongs to someone else.</li>
                </ul>
                <p><b>Price:</b> billed the same way as regular long-form text-to-speech &mdash; per
                  character on the standard meter, once per chapter. There is no separate
                  audiobook charge.</p>
                <p><b>Known limitation.</b> The export step is newly enabled and has been reviewed
                  but not yet exercised against a real multi-chapter book end-to-end in production
                  &mdash; if a chapter-marker or concatenation edge case turns up, <Link href="mailto:support@readaloudai.org" style={{ textDecoration: 'underline' }}>let us know</Link>.</p>

                <h3>Pricing and benchmarks</h3>
                <p>Piper $0.004 and Kokoro $0.01 per 1,000 characters; speech to text $0.11 per hour of audio; dubbing $0.15 per audio minute, voice conversion $0.10 per audio minute, and voice isolation $0.05 per audio minute, each billed by the second rounded up (with the minimums above); audiobooks bill per character like regular text-to-speech. Cloning a voice through the API costs $2.50 per voice when you commit the dataset. Audio-based usage appears on your invoice as character equivalents on the text-to-speech meter ($0.01 per 1,000). See <Link href="/#engines" style={{ textDecoration: 'underline' }}>engines and benchmarks</Link> for how we measured latency against ElevenLabs.</p>
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
