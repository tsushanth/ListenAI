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
  description: 'Text-to-speech API with an OpenAI-compatible endpoint, WebSocket streaming, and Pipecat and LiveKit plugins. Get a key and start in minutes.',
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
              Use the <a href="#openai-compatible" style={{ textDecoration: 'underline' }}>OpenAI-compatible endpoint</a> with any OpenAI SDK, add speech to a <a href="#integrations" style={{ textDecoration: 'underline' }}>Pipecat or LiveKit</a> voice agent, stream over a WebSocket, or transcribe recordings with batch <a href="#speech-to-text" style={{ textDecoration: 'underline' }}>speech to text</a>. Get a key below, then follow the calls. Every account starts with free credits.
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
              <b>Free credits.</b> Every account gets a one-time grant of free credits (worth $0.10, about 10,000 characters of speech), shared across speech, transcription, dubbing, voice isolation, voice conversion and voice design. Long jobs use more credits than short ones. When they run out those tools return <code>402</code> until you add a payment method; after that you pay as you go. Accounts without a payment method can hold one active API key. The free credits are one capped pool per account, shared across all of your keys (creating or revoking a key does not reset it), and they are used up first. Voice cloning and music generation always need a payment method.
            </p>
          </div>
        </section>

        <section className="ra-section" id="openai-compatible">
          <div className="ra-wrap ra-narrow ra-ref" style={{ maxWidth: 820 }}>
            <h2>OpenAI-compatible API</h2>
            <p className="ra-lede" style={{ marginBottom: 16 }}>
              <code>POST https://api.readaloudai.org/v1/audio/speech</code> accepts the OpenAI <code>audio.speech.create</code> request. OpenAI SDKs, Open WebUI, LiteLLM and other tools that take an OpenAI base URL work by changing only the base URL and the key. Auth is <code>Authorization: Bearer &lt;your key&gt;</code>, the same <code>rtts_</code> key as the rest of this page.
            </p>

            <p className="ra-small" style={{ marginBottom: 16 }}>The earlier names piper-default, piper and kokoro keep working as aliases.</p>

            <h3>Python (openai)</h3>
            <pre style={{ overflowX: 'auto' }}><code>{`# pip install openai
import os
from openai import OpenAI

client = OpenAI(
    base_url="https://api.readaloudai.org/v1",
    api_key=os.environ["READALOUD_API_KEY"],
)

with client.audio.speech.with_streaming_response.create(
    model="tts-1",             # accepted and ignored; the voice decides
    voice="readaloud-default",     # OpenAI names such as "alloy" map to this
    input="Hello from ReadAloud.",
    response_format="mp3",
) as response:
    response.stream_to_file("hello.mp3")`}</code></pre>

            <h3>JavaScript / TypeScript (openai)</h3>
            <pre style={{ overflowX: 'auto' }}><code>{`// npm install openai
import fs from 'node:fs'
import OpenAI from 'openai'

const client = new OpenAI({
  baseURL: 'https://api.readaloudai.org/v1',
  apiKey: process.env.READALOUD_API_KEY,
})

const res = await client.audio.speech.create({
  model: 'tts-1',              // accepted and ignored; the voice decides
  voice: 'readaloud-default',      // OpenAI names such as 'alloy' map to this
  input: 'Hello from ReadAloud.',
  response_format: 'mp3',
})
fs.writeFileSync('hello.mp3', Buffer.from(await res.arrayBuffer()))`}</code></pre>

            <h3>curl</h3>
            <pre style={{ overflowX: 'auto' }}><code>{`curl https://api.readaloudai.org/v1/audio/speech \\
  -H "Authorization: Bearer $READALOUD_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"tts-1","voice":"readaloud-default","input":"Hello from ReadAloud.","response_format":"mp3"}' \\
  --output hello.mp3`}</code></pre>

            <h3>Supported fields</h3>
            <div className="ra-table-wrap" style={{ marginTop: 8 }}>
              <table className="ra-table">
                <thead><tr><th>Field</th><th>Behaviour</th></tr></thead>
                <tbody>
                  <tr><td><code>input</code></td><td>Required, up to 5,000 characters.</td></tr>
                  <tr><td><code>voice</code></td><td>Use <code>readaloud-default</code>. The OpenAI stock names (<code>alloy</code>, <code>ash</code>, <code>ballad</code>, <code>coral</code>, <code>echo</code>, <code>fable</code>, <code>nova</code>, <code>onyx</code>, <code>sage</code>, <code>shimmer</code>, <code>verse</code>, <code>marin</code>, <code>cedar</code>) all map to <code>readaloud-default</code>, so they sound the same. Any other value is a ReadAloud voice id from <code>GET /v1/voices</code>, or <code>custom:&lt;id&gt;</code> for a voice you cloned. An unknown voice returns <code>404</code>.</td></tr>
                  <tr><td><code>model</code></td><td>Accepted and ignored. The voice decides how the audio is made.</td></tr>
                  <tr><td><code>response_format</code></td><td><code>mp3</code> (default, 24 kHz), <code>opus</code> (48 kHz, Ogg), <code>wav</code> (24 kHz) or <code>pcm</code> (24 kHz, 16-bit, mono). <code>aac</code> and <code>flac</code> return <code>400</code>.</td></tr>
                  <tr><td><code>speed</code></td><td>0.25 to 4.0.</td></tr>
                  <tr><td><code>instructions</code>, <code>stream_format</code></td><td>Accepted and ignored.</td></tr>
                </tbody>
              </table>
            </div>
            <p style={{ marginTop: 12 }}>Audio is streamed as it is produced, except <code>wav</code>, which is returned whole.</p>

            <h3>Not supported</h3>
            <ul>
              <li><code>aac</code> and <code>flac</code> output (<code>400</code>).</li>
              <li><code>instructions</code> (voice style prompts) is ignored.</li>
              <li>The OpenAI Realtime API.</li>
              <li><code>GET /v1/models</code> in OpenAI&rsquo;s shape. It returns a different list, so do not rely on it to discover models.</li>
            </ul>

            <h3>Errors, billing and limits</h3>
            <p>Errors use the OpenAI shape, so SDK error handling works unchanged:</p>
            <pre style={{ overflowX: 'auto' }}><code>{`{"error":{"message":"response_format must be one of: mp3, opus, wav, pcm (aac and flac are not supported)","type":"invalid_request_error","param":"response_format","code":"invalid_value"}}`}</code></pre>
            <ul style={{ marginTop: 12 }}>
              <li><code>400</code> a missing or invalid field, an unsupported <code>response_format</code>, a <code>speed</code> outside 0.25 to 4.0, or input over 5,000 characters.</li>
              <li><code>401</code> the key is missing, invalid or revoked.</li>
              <li><code>402</code> the free allowance is used up. Add a payment method.</li>
              <li><code>404</code> unknown voice.</li>
              <li><code>429</code> the service is at capacity. Retry with a short backoff.</li>
            </ul>
            <p style={{ marginTop: 12 }}>Billing, the free allowance and concurrency limits are the same as for every other text-to-speech route on this page.</p>
          </div>
        </section>

        <section className="ra-section" id="integrations">
          <div className="ra-wrap ra-narrow ra-ref" style={{ maxWidth: 820 }}>
            <h2>Integrations</h2>
            <p className="ra-lede" style={{ marginBottom: 16 }}>
              Plugins for voice-agent frameworks. Both are written and maintained by ReadAloud, are MIT licensed, and read your key from <code>READALOUD_API_KEY</code>. They can output 8&nbsp;kHz audio for phone calls, and interrupting the agent stops generation.
            </p>

            <h3 id="pipecat">Pipecat</h3>
            <p>Package <a href="https://pypi.org/project/pipecat-readaloud/" style={{ textDecoration: 'underline' }}><code>pipecat-readaloud</code></a> (<a href="https://github.com/tsushanth/pipecat-readaloud" style={{ textDecoration: 'underline' }}>source</a>). Requires <code>pipecat-ai</code> 1.12 or newer and Python 3.10+.</p>
            <pre style={{ overflowX: 'auto' }}><code>{`pip install pipecat-readaloud
export READALOUD_API_KEY=rtts_...`}</code></pre>
            <pre style={{ overflowX: 'auto' }}><code>{`import os
from pipecat_readaloud import ReadAloudHttpTTSService

tts = ReadAloudHttpTTSService(
    api_key=os.environ["READALOUD_API_KEY"],
    sample_rate=8000,   # 8000 for Twilio / Telnyx, 24000 native, 16000 also works
    settings=ReadAloudHttpTTSService.Settings(voice="readaloud-default", speed=1.0),
)
# then use it in your Pipeline: [..., llm, tts, transport.output(), ...]`}</code></pre>

            <h3 id="livekit">LiveKit Agents</h3>
            <p>Package <a href="https://pypi.org/project/livekit-plugins-readaloud/" style={{ textDecoration: 'underline' }}><code>livekit-plugins-readaloud</code></a> (<a href="https://github.com/tsushanth/livekit-plugins-readaloud" style={{ textDecoration: 'underline' }}>source</a>). Requires <code>livekit-agents</code> 1.8 or newer and Python 3.10+.</p>
            <pre style={{ overflowX: 'auto' }}><code>{`pip install livekit-plugins-readaloud
export READALOUD_API_KEY=rtts_...`}</code></pre>
            <pre style={{ overflowX: 'auto' }}><code>{`from livekit.agents import AgentSession
from livekit.plugins import readaloud

session = AgentSession(
    # stt=..., llm=...,
    tts=readaloud.TTS(voice="readaloud-default", sample_rate=24000),   # 24000 | 16000 | 8000
)`}</code></pre>

            <h3 id="vapi">Vapi</h3>
            <p>Vapi can call ReadAloud as a custom voice at <code>POST https://api.readaloudai.org/v1/vapi/custom-voice</code>. We have verified the endpoint directly: it returns raw 16-bit mono PCM (<code>application/octet-stream</code>) at 8000, 16000 and 24000 Hz and accepts your key as the <code>x-vapi-secret</code> header. We have <b>not</b> yet tested it from a real Vapi assistant, so treat the Vapi setup as unverified.</p>
            <pre style={{ overflowX: 'auto' }}><code>{`curl -X POST 'https://api.readaloudai.org/v1/vapi/custom-voice?voice=readaloud-default' \\
  -H "x-vapi-secret: $READALOUD_API_KEY" -H 'Content-Type: application/json' \\
  -d '{"message":{"type":"voice-request","text":"Hello from ReadAloud.","sampleRate":16000,"timestamp":1}}' \\
  -o out.pcm`}</code></pre>
          </div>
        </section>

        <section className="ra-section" id="reference">
          <div className="ra-wrap">
            <h2>Reference</h2>
            <div className="ra-two" style={{ marginTop: 24 }}>
              <div className="ra-ref">
                <h3 style={{ marginTop: 0 }}>Authorize</h3>
                <p><code>POST https://api.readaloudai.org/tts/authorize</code> with JSON <code>{'{ "key", "engine" }'}</code>. <code>engine</code> is <code>&quot;live&quot;</code> (ReadAloud Live) or <code>&quot;studio&quot;</code> (ReadAloud Studio) and defaults to ReadAloud Studio. Returns <code>{'{ token, url }'}</code>. The token lasts 60 seconds, so authorize again for each new connection.</p>
                <ul>
                  <li><code>401</code> the key is invalid or revoked.</li>
                  <li><code>402</code> the free characters are used up. Add a payment method in your dashboard.</li>
                  <li><code>400</code> unknown engine.</li>
                </ul>

                <h3>Connect</h3>
                <p>Open <code>{'wss://…/tts?token=<token>'}</code> at the URL from authorize. Keep the connection open across requests. Audio is PCM16 little-endian, mono, 24 kHz.</p>

                <h3>Messages you send</h3>
                <ul>
                  <li><code>{'{ "type": "synthesize", "text": "…", "voice": "default", "speed": 1.0 }'}</code> speaks the text. ReadAloud Live accepts up to 5,000 characters per request.</li>
                  <li><code>{'{ "type": "stop" }'}</code> ends the current speech at once. Use it when the caller interrupts.</li>
                </ul>

                <h3>Messages you receive</h3>
                <ul>
                  <li><code>chunk_meta</code> a JSON frame, immediately followed by one binary audio frame, once per sentence. With the default ReadAloud Live setting below, the first sentence of a request may arrive as two chunks.</li>
                  <li><code>done</code> the request finished. <code>cancelled</code> you stopped it. Only finished requests are billed.</li>
                  <li><code>error</code> with a <code>message</code>. The connection stays usable unless it is closed.</li>
                </ul>

                <h3>Audio formats</h3>
                <p>Add <code>{'"format": "…"'}</code> to a synthesize message (ReadAloud Live engine). <code>pcm_24000</code> is the default. For phone lines use <code>mulaw_8000</code> or <code>alaw_8000</code> (G.711, 8 kHz); <code>pcm_8000</code> is also available. Each <code>chunk_meta</code> reports the <code>format</code> and <code>sample_rate</code> of the audio that follows. An unknown format returns an error and the connection stays open.</p>

                <h3>Faster first audio (ReadAloud Live)</h3>
                <p>ReadAloud Live cuts the first sentence at its first clause (comma, semicolon, colon or dash) and streams the first half sooner, so audio starts roughly 40&ndash;55% faster on longer first sentences. It is on by default. Add <code>{'"first_chunk_split": false'}</code> to a synthesize message or HTTP body to turn it off for that request. Only <code>true</code> and <code>false</code> are accepted, anything else is ignored. The SDKs expose this as <code>firstChunkSplit</code> (JavaScript) and <code>first_chunk_split</code> (Python).</p>

                <h3>HTTP streaming (ReadAloud Live)</h3>
                <p><code>POST</code> to the <code>http_url</code> returned by authorize with <code>Authorization: Bearer &lt;token&gt;</code> and JSON <code>{'{ "text", "voice", "speed", "format" }'}</code>. The response streams raw audio as each sentence is ready, with <code>X-Sample-Rate</code> and <code>X-Audio-Format</code> headers. At capacity you get <code>503</code> with <code>Retry-After</code>.</p>

                <h3>SDKs and MCP</h3>
                <p>The API is plain WebSocket and HTTP, so any client works; official client libraries are on PyPI and npm: <code>pip install readaloud</code> and <code>npm install readaloud</code>. Because a client takes your API key, use it from a server, not a browser. To use the voices from an AI assistant, see the <Link href="/developers/mcp" style={{ textDecoration: 'underline' }}>MCP server</Link>.</p>

                <h3>Capacity and errors</h3>
                <p>Each ReadAloud Live server handles up to 12 simultaneous streams, and a second server starts automatically under load. Beyond that you get <code>{'{ "type": "error", "message": "at capacity, retry shortly" }'}</code> and the socket closes with code <code>1013</code>. Retry with a short backoff.</p>

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
                <p>ReadAloud Live $0.004 and ReadAloud Studio $0.01 per 1,000 characters; speech to text $0.11 per hour of audio; dubbing $0.15 per audio minute, voice conversion $0.10 per audio minute, and voice isolation $0.05 per audio minute, each billed by the second rounded up (with the minimums above); audiobooks bill per character like regular text-to-speech. Cloning a voice through the API costs $2.50 per voice when you commit the dataset. Audio-based usage appears on your invoice as character equivalents on the text-to-speech meter ($0.01 per 1,000). See <Link href="/#engines" style={{ textDecoration: 'underline' }}>engines and benchmarks</Link> for how we measured latency against ElevenLabs.</p>
                <h4 id="vs-elevenlabs">ReadAloud and ElevenLabs, as of 2026-10-10</h4>
                <p>Prices are ElevenLabs&rsquo; published pay-as-you-go API list prices for text to speech, read from its pricing page on 2026-10-10. Time to first audio is the median (p50) and 95th percentile (p95) in milliseconds, measured in San Jose with short call-centre sentences.</p>
                <div className="ra-table-wrap" style={{ marginTop: 8 }}>
                  <table className="ra-table">
                    <thead><tr><th>Service</th><th>Per 1,000 characters</th><th>Per 1M characters</th><th>Warm connection, p50 / p95</th><th>New connection, p50 / p95</th></tr></thead>
                    <tbody>
                      <tr><td>ReadAloud, default voice (<code>readaloud-default</code>)</td><td>$0.004</td><td>$4</td><td>about 250 / 340-360 ms</td><td>about 290 / 370-440 ms</td></tr>
                      <tr><td>ElevenLabs Flash v2.5</td><td>$0.04</td><td>$40</td><td>166-174 / 190-220 ms</td><td>200-280 / 410-490 ms</td></tr>
                      <tr><td>ElevenLabs v4 Turbo</td><td>$0.04 list ($0.011 promotional until 2026-10-12)</td><td>$40 list ($11 promotional)</td><td>187-196 / 290-460 ms</td><td>about 222 / 250-370 ms</td></tr>
                      <tr><td>ElevenLabs v2 Multilingual</td><td>$0.08</td><td>$80</td><td>about 1,040 / 1,140 ms</td><td>about 1,090 / 1,220 ms</td></tr>
                      <tr><td>ElevenLabs v3</td><td>$0.08</td><td>$80</td><td colSpan={2}>not measured</td></tr>
                      <tr><td>ElevenLabs v3 Conversational</td><td>$0.04</td><td>$40</td><td colSpan={2}>not measured</td></tr>
                      <tr><td>ElevenLabs v4</td><td>$0.08 list ($0.022 promotional until 2026-10-12)</td><td>$80 list ($22 promotional)</td><td colSpan={2}>not measured</td></tr>
                    </tbody>
                  </table>
                </div>
                <ul>
                  <li><b>Price:</b> at list prices ReadAloud is one tenth of ElevenLabs Flash and v4 Turbo ($4 against $40 per million characters) and one twentieth of v2 Multilingual, v3 and v4 ($4 against $80). During ElevenLabs&rsquo; promotion, which ends 2026-10-12, v4 Turbo is $11 and v4 is $22 per million characters, so the gap is smaller until then. ElevenLabs conversational agents list at $0.08 per call minute with the language model billed separately; ReadAloud bills text to speech by character only.</li>
                  <li><b>Speed:</b> ElevenLabs Flash was faster than ReadAloud in our runs, by roughly 80 ms at the median on a warm connection. We do not claim ReadAloud is faster than Flash. It was about four times faster than v2 Multilingual, the model most often chosen for quality.</li>
                  <li><b>Quality:</b> we do not claim the same voice quality as ElevenLabs, which has far more voices and languages. ReadAloud offers one voice. We do not publish side-by-side audio; try the default voice on your own text.</li>
                  <li><b>Capacity:</b> each server accepts a limited number of simultaneous streams and more servers start under load. Past capacity you get the <code>at capacity</code> error described above; retry with backoff.</li>
                </ul>
                <p className="ra-small">Method: two runs on 2026-10-10, 08:11 to 08:16 UTC (about 1 a.m. in San Jose, a quiet hour), from a throwaway machine in the Fly.io San Jose region, requests interleaved between services. Each run had 40 requests per service on a reused connection and 20 on a new connection, rotating through six sentences of 35 to 60 characters. Time is from sending the request to the first audio byte. ReadAloud was reached the way a customer reaches it: authorize (about 15 ms), then a direct WebSocket; the new-connection figure includes the connection handshake but not the authorize call. ElevenLabs was reached over its streaming HTTP API, <code>pcm_24000</code> output, default settings, with our own account; its new-connection figure includes TCP and TLS setup. v2 Multilingual was measured in one run only. With 20 to 40 samples the 95th percentile is rough, and results change with the hour, the sentence and the connection. Prices exclude taxes and ElevenLabs plan allowances. Re-check ElevenLabs&rsquo; pricing page before you rely on these figures; ElevenLabs advertises lower model latency than the end-to-end figures here, which include the network.</p>
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
