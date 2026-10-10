import Link from 'next/link'
import RaHeader from '@/components/ra/RaHeader'
import RaFooter from '@/components/ra/RaFooter'

const URL = 'https://readaloudai.org/developers/migrate-from-elevenlabs'
const TITLE = 'Migrate from ElevenLabs - ReadAloud AI'
const DESCRIPTION =
  'Point your ElevenLabs text-to-speech code at ReadAloud by changing the base URL, the API key and the voice id. What we tested against the live API, and what is different or not supported.'

export const metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: URL },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: URL,
    siteName: 'ReadAloud AI',
    type: 'article',
  },
  twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION },
}

const ul = { textDecoration: 'underline' } as const
const pre = { overflowX: 'auto' } as const

const CURL = `# before
curl -X POST "https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM?output_format=mp3_44100_128" \\
  -H "xi-api-key: $ELEVENLABS_API_KEY" -H "Content-Type: application/json" \\
  -d '{"text":"Thanks for calling.","model_id":"eleven_flash_v2_5"}' -o out.mp3

# after: new host, new key, new voice id
curl -X POST "https://api.readaloudai.org/v1/text-to-speech/piper-default?output_format=mp3_44100_128" \\
  -H "xi-api-key: $READALOUD_API_KEY" -H "Content-Type: application/json" \\
  -d '{"text":"Thanks for calling.","model_id":"eleven_flash_v2_5"}' -o out.mp3`

const PY = `# pip install elevenlabs   (tested with 2.71.0)
import os
from elevenlabs.client import ElevenLabs

# before
client = ElevenLabs(api_key=os.environ["ELEVENLABS_API_KEY"])

# after: new key and one extra argument, base_url
client = ElevenLabs(
    api_key=os.environ["READALOUD_API_KEY"],
    base_url="https://api.readaloudai.org",
)

audio = client.text_to_speech.convert(
    voice_id="piper-default",          # was an ElevenLabs voice id
    text="Thanks for calling.",
    model_id="eleven_multilingual_v2",  # accepted; the voice decides how audio is made
    output_format="mp3_44100_128",
)
with open("out.mp3", "wb") as f:
    for chunk in audio:
        f.write(chunk)`

const JS = `// npm i @elevenlabs/elevenlabs-js   (tested with 2.71.0)
import fs from "node:fs";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";

// before
// const client = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });

// after: new key and one extra option, baseUrl
const client = new ElevenLabsClient({
  apiKey: process.env.READALOUD_API_KEY,
  baseUrl: "https://api.readaloudai.org",
});

const audio = await client.textToSpeech.convert("piper-default", {
  text: "Thanks for calling.",
  modelId: "eleven_flash_v2_5",
  outputFormat: "pcm_16000",
});
const chunks = [];
for await (const chunk of audio) chunks.push(chunk);
fs.writeFileSync("out.pcm", Buffer.concat(chunks)); // raw 16-bit mono, 16 kHz`

const WS = `# Python SDK, WebSocket (stream-input). Needs wss://, which api.readaloudai.org serves.
def text_chunks():
    yield "Thanks for calling. "
    yield "How can I help you today?"

with open("out.mp3", "wb") as f:
    for chunk in client.text_to_speech.convert_realtime(
        voice_id="piper-default",
        text=text_chunks(),
        model_id="eleven_flash_v2_5",
        output_format="mp3_44100_128",
    ):
        f.write(chunk)`

const WSRAW = `wss://api.readaloudai.org/v1/text-to-speech/piper-default/stream-input?output_format=mp3_44100_128

header:   xi-api-key: <your ReadAloud key>      (or send "xi_api_key" in the first message)
send:     {"text": " "}                          first message
send:     {"text": "Thanks for calling. "}       then text, as it arrives
send:     {"text": ""}                           end of input
receive:  {"audio": "<base64>", ...}  ...        then {"isFinal": true} and a normal close`

const ERR = `# 404, unknown voice id (an ElevenLabs voice id)
{"detail":{"status":"voice_not_found","message":"Voice 21m00Tcm4TlvDq8ikWAM not found. ..."}}

# 401, missing or revoked key
{"detail":{"status":"invalid_api_key","message":"Invalid API key"}}

# 400, text over 5,000 characters
{"detail":{"status":"max_character_limit_exceeded","message":"text too long (max 5000 characters per request)"}}

# 422, empty text. Validation errors are a list, as in ElevenLabs' own API
{"detail":[{"loc":["body","text"],"msg":"text must be a non-empty string","type":"value_error"}]}`

export default function MigrateFromElevenLabsPage() {
  return (
    <div className="ra">
      <RaHeader />
      <main>
        <section className="ra-hero" style={{ paddingBottom: 32 }}>
          <div className="ra-wrap">
            <h1 style={{ maxWidth: '20ch' }}>Migrate from ElevenLabs</h1>
            <p className="ra-lede">
              The ReadAloud API serves the ElevenLabs text-to-speech routes, so code written for the ElevenLabs SDKs runs against <code className="inl">https://api.readaloudai.org</code> after you change three values. This page lists what we ran against the live service, what behaves differently, and what is not supported.
            </p>
            <p style={{ marginTop: 12 }}>
              <Link href="/developers#get-started" style={ul}>Get an API key</Link> &middot; <Link href="/developers" style={ul}>Voice API reference</Link>
            </p>
            <nav aria-label="On this page" style={{ marginTop: 20 }}>
              <ul className="ra-small" style={{ listStyle: 'none', padding: 0, display: 'flex', flexWrap: 'wrap', gap: '8px 18px' }}>
                <li><a href="#three-changes" style={ul}>Three changes</a></li>
                <li><a href="#before-after" style={ul}>Before and after</a></li>
                <li><a href="#verified" style={ul}>What we tested</a></li>
                <li><a href="#differences" style={ul}>Differences and unsupported</a></li>
                <li><a href="#errors" style={ul}>Errors</a></li>
                <li><a href="#limits" style={ul}>Limits and credits</a></li>
                <li><a href="#faq" style={ul}>FAQ</a></li>
              </ul>
            </nav>
          </div>
        </section>

        <section className="ra-section" id="three-changes" style={{ paddingTop: 40 }}>
          <div className="ra-wrap ra-narrow ra-ref" style={{ maxWidth: 820 }}>
            <h2>Three things to change</h2>
            <ol style={{ paddingLeft: 24, listStyle: 'decimal', display: 'grid', gap: 10, color: 'var(--ink2)' }}>
              <li><b>Base URL:</b> <code>https://api.readaloudai.org</code> instead of <code>https://api.elevenlabs.io</code>.</li>
              <li><b>API key:</b> your ReadAloud key (it starts with <code>rtts_</code>). Send it as <code>xi-api-key</code> or as <code>Authorization: Bearer</code>; both work.</li>
              <li><b>Voice id:</b> use <code>piper-default</code>. ElevenLabs voice ids, for example <code>21m00Tcm4TlvDq8ikWAM</code>, do not exist here and return <code>404 voice_not_found</code>. We do not substitute a voice for you, and there is deliberately no table mapping ElevenLabs voices to ours.</li>
            </ol>
            <p style={{ marginTop: 16 }}>
              Everything else in a typical text-to-speech call, such as <code>model_id</code>, <code>output_format</code> and <code>voice_settings.speed</code>, can stay as it is. <code>piper-default</code> is the only voice this guide covers. It does not sound like any ElevenLabs voice, and we make no claim that it matches ElevenLabs quality. Listen to it on your own text before you switch.
            </p>
          </div>
        </section>

        <section className="ra-section" id="before-after">
          <div className="ra-wrap ra-narrow ra-ref" style={{ maxWidth: 820 }}>
            <h2>Before and after</h2>
            <h3>curl</h3>
            <pre style={pre} tabIndex={0}><code>{CURL}</code></pre>
            <h3>Python</h3>
            <pre style={pre} tabIndex={0}><code>{PY}</code></pre>
            <h3>JavaScript</h3>
            <pre style={pre} tabIndex={0}><code>{JS}</code></pre>
            <h3>WebSocket</h3>
            <p>
              The Python SDK&rsquo;s <code>convert_realtime</code> works against the live API. The current JavaScript SDK has no text-to-speech WebSocket client, so there is no JavaScript SDK result for this route; the raw protocol below was exercised with a plain WebSocket client.
            </p>
            <pre style={pre} tabIndex={0}><code>{WS}</code></pre>
            <pre style={{ ...pre, marginTop: 12 }} tabIndex={0}><code>{WSRAW}</code></pre>
            <p>
              Text is buffered and spoken at sentence boundaries, on <code>flush</code>, and at end of input. The <code>multi-stream-input</code> route (several contexts on one socket) also worked in our run. <code>opus_*</code> output is rejected on WebSocket routes. Word-level timing is not provided.
            </p>
          </div>
        </section>

        <section className="ra-section" id="verified">
          <div className="ra-wrap ra-narrow ra-ref" style={{ maxWidth: 820 }}>
            <h2>What we tested</h2>
            <p className="ra-lede" style={{ marginBottom: 16 }}>
              On 10 October 2026 we ran each item below against the live API at <code>api.readaloudai.org</code>, with the official SDKs and with plain HTTP and WebSocket clients, using a temporary key that has since been revoked. Only items that worked are in this table. Differences are listed in the next section.
            </p>
            <p className="ra-small" style={{ marginBottom: 12 }}>
              SDKs: <code>elevenlabs</code> (Python) 2.71.0 on Python 3.14, and <code>@elevenlabs/elevenlabs-js</code> 2.71.0 on Node 26. Only the base URL, the key and the voice id were changed from the ElevenLabs code.
            </p>
            <div className="ra-table-wrap">
              <table className="ra-table">
                <caption style={{ textAlign: 'left', position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>Compatibility results from the 10 October 2026 live run</caption>
                <thead><tr><th scope="col">Route or call</th><th scope="col">Result in our run</th></tr></thead>
                <tbody>
                  <tr><td><code>POST /v1/text-to-speech/&#123;voice_id&#125;</code></td><td>curl, Python <code>text_to_speech.convert</code> and JavaScript <code>textToSpeech.convert</code> all returned audio for <code>mp3_44100_128</code>, <code>pcm_16000</code> and <code>ulaw_8000</code>. Checked with ffprobe: the MP3 was 44.1 kHz mono. Also returned audio for <code>wav_24000</code> (a valid RIFF/WAVE file) and <code>opus_48000_64</code> (Ogg Opus, 48 kHz).</td></tr>
                  <tr><td><code>POST .../&#123;voice_id&#125;/stream</code></td><td>Python <code>text_to_speech.stream</code> and JavaScript <code>textToSpeech.stream</code> returned audio in many chunks.</td></tr>
                  <tr><td><code>POST .../with-timestamps</code></td><td>Returns JSON with base64 audio. <code>alignment</code> and <code>normalized_alignment</code> are always <code>null</code>.</td></tr>
                  <tr><td><code>WS .../stream-input</code></td><td>Python <code>convert_realtime</code> over <code>wss://</code> returned a playable MP3. A plain client also worked with the key in the header and with the key in the first message.</td></tr>
                  <tr><td><code>WS .../multi-stream-input</code></td><td>Plain client only: one context with <code>flush</code>, <code>close_context</code> and <code>close_socket</code> worked.</td></tr>
                  <tr><td><code>GET /v1/voices</code>, <code>/v2/voices</code>, <code>/v1/voices/&#123;id&#125;</code></td><td>Python <code>voices.get_all</code>, <code>voices.search</code>, <code>voices.get</code> and the JavaScript equivalents worked with the ElevenLabs response shape. These routes use the ElevenLabs shape when the key is sent as <code>xi-api-key</code>.</td></tr>
                  <tr><td><code>GET /v1/models</code></td><td>Both SDKs listed three model ids: <code>eleven_flash_v2_5</code>, <code>eleven_turbo_v2_5</code>, <code>eleven_multilingual_v2</code>.</td></tr>
                  <tr><td><code>GET /v1/user/subscription</code></td><td>Both SDKs parsed the response. For a pay-as-you-go key <code>character_limit</code> is a very large placeholder number, not a real cap.</td></tr>
                  <tr><td><code>voice_settings.speed</code></td><td>Changes the length of the audio: the same sentence came out about 3.3 s at 0.7, 2.7 s at 1.0 and 2.1 s at 1.5. Speed 0 is rejected with <code>422</code>.</td></tr>
                  <tr><td>Error classes</td><td>Both SDKs raised their API error with status 404 (unknown voice), 401 (bad key), 400 (text too long) and 422 (empty text).</td></tr>
                  <tr><td>Auth headers</td><td><code>xi-api-key</code> and <code>Authorization: Bearer</code> both worked on text to speech.</td></tr>
                </tbody>
              </table>
            </div>
            <p className="ra-small" style={{ marginTop: 12 }}>
              Not tested against the live service: the other <code>output_format</code> names beyond those listed above (an unknown name returns a <code>422</code> that lists the names the API accepts, which follow the ElevenLabs list), the ElevenLabs deprecated npm package, voice-agent framework plugins for ElevenLabs (LiveKit, Pipecat), non-English text, and the <code>402</code> response when free credits run out. For LiveKit and Pipecat, use the <Link href="/developers#integrations" style={ul}>ReadAloud plugins</Link>.
            </p>
          </div>
        </section>

        <section className="ra-section" id="differences">
          <div className="ra-wrap ra-narrow ra-ref" style={{ maxWidth: 820 }}>
            <h2>What is different or not supported</h2>
            <h3>Different</h3>
            <ul>
              <li><b>Voices.</b> ElevenLabs voice ids return <code>404</code>. Use <code>piper-default</code>. Your own ElevenLabs voice clones and Voice Library voices cannot be used here.</li>
              <li><b>Sound.</b> The voice is not the same as any ElevenLabs voice and we do not claim equal quality. We publish no side-by-side audio on this page.</li>
              <li><b><code>model_id</code> does not choose the voice.</b> Any string is accepted, including ids we do not list such as <code>eleven_v3</code>; the voice you pass decides how the audio is made. The response header <code>X-Model-Mapped</code> reports how the id was treated.</li>
              <li><b>Voice settings.</b> Only <code>speed</code> has an effect. <code>stability</code>, <code>similarity_boost</code>, <code>style</code> and <code>use_speaker_boost</code> are accepted and ignored, as are <code>seed</code>, <code>language_code</code>, <code>previous_text</code>, <code>next_text</code> and a few other request fields. The ones you sent are echoed in the <code>x-compat-ignored</code> response header, so nothing is dropped silently.</li>
              <li><b>Language.</b> <code>language_code</code> does not select a language. <code>piper-default</code> is an American English voice. We did not test other languages through this route.</li>
              <li><b>Sample rates above 24 kHz are upsampled.</b> The audio is made at 24 kHz. Formats such as <code>mp3_44100_128</code> have the sample rate you asked for but no content above 12 kHz. Response headers <code>X-Sample-Rate</code>, <code>X-Audio-Format</code> and <code>X-Source-Sample-Rate</code> say so.</li>
              <li><b><code>wav_*</code> formats</b> work only on the non-streaming endpoint (the streaming endpoint returns <code>422</code>), as in ElevenLabs.</li>
              <li><b>Timestamps.</b> <code>/with-timestamps</code> works but returns <code>null</code> alignment. We do not compute character timings.</li>
              <li><b>Markup.</b> No SSML and no v3 audio tags. According to the gateway code, text is passed through as written, so a tag such as <code>[laughs]</code> may be read aloud. We did not test that live.</li>
              <li><b>Quota status code.</b> When free credits run out the API returns <code>402</code>, not the <code>401</code> ElevenLabs uses. We did not trigger this in the live run.</li>
            </ul>
            <h3>Not supported on the ElevenLabs paths</h3>
            <p>
              These paths returned <code>404</code> in our run (or, for voice creation, a ReadAloud error rather than an ElevenLabs-style result), so do not expect the ElevenLabs SDK methods for them to work against ReadAloud:
            </p>
            <ul>
              <li>Speech to text (Scribe), <code>/v1/speech-to-text</code>. ReadAloud has its own transcription API with a different interface; see the <Link href="/developers#speech-to-text" style={ul}>Voice API page</Link>.</li>
              <li>Dubbing, <code>/v1/dubbing</code>. ReadAloud&rsquo;s dubbing is a separate API, not this one.</li>
              <li>The Agents platform (Conversational AI), <code>/v1/convai/...</code>.</li>
              <li>Voice cloning with ElevenLabs semantics, <code>POST /v1/voices/add</code> (instant and professional voice clones). Sending it with an <code>xi-api-key</code> header returned a ReadAloud authentication error, not a clone. ReadAloud cloning has its own API and needs a payment method.</li>
              <li>Speech to speech, text to voice (voice design), audio isolation, sound generation, history, pronunciation dictionaries and projects.</li>
              <li>Not tested: the deprecated ElevenLabs npm package and the ElevenLabs plugins for voice-agent frameworks, see above.</li>
            </ul>
            <p>
              We checked a list of common ElevenLabs paths, not every path in their API. Anything not in the table above is not verified.
            </p>
          </div>
        </section>

        <section className="ra-section" id="errors">
          <div className="ra-wrap ra-narrow ra-ref" style={{ maxWidth: 820 }}>
            <h2>Error handling</h2>
            <p className="ra-lede" style={{ marginBottom: 16 }}>
              Errors use the ElevenLabs shape, so the SDK error classes work unchanged. These are real responses from our run.
            </p>
            <pre style={pre} tabIndex={0}><code>{ERR}</code></pre>
            <div className="ra-table-wrap" style={{ marginTop: 16 }}>
              <table className="ra-table">
                <thead><tr><th scope="col">Status</th><th scope="col"><code>detail.status</code></th><th scope="col">Meaning</th></tr></thead>
                <tbody>
                  <tr><td>401</td><td><code>invalid_api_key</code></td><td>Missing or revoked key. Seen live.</td></tr>
                  <tr><td>402</td><td><code>quota_exceeded</code></td><td>Free credits used up, or the request is larger than what remains. Add a payment method. Not triggered in our run.</td></tr>
                  <tr><td>404</td><td><code>voice_not_found</code></td><td>Unknown voice id. Seen live.</td></tr>
                  <tr><td>400</td><td><code>max_character_limit_exceeded</code></td><td>More than 5,000 characters. Seen live.</td></tr>
                  <tr><td>422</td><td>(a list)</td><td>Validation: empty or missing <code>text</code>, malformed JSON, an unknown <code>output_format</code>, <code>speed</code> of 0 or less. Seen live.</td></tr>
                  <tr><td>429</td><td><code>too_many_concurrent_requests</code></td><td>The service is at capacity. A <code>Retry-After</code> header is set. We saw this once during the run, on a different voice, and the retry a few seconds later succeeded.</td></tr>
                  <tr><td>405</td><td><code>method_not_allowed</code></td><td>A GET on a text-to-speech path. Use POST.</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section className="ra-section" id="limits">
          <div className="ra-wrap ra-narrow ra-ref" style={{ maxWidth: 820 }}>
            <h2>Limits and credits</h2>
            <ul>
              <li><b>5,000 characters per request.</b> A 5,000-character request succeeded; 5,001 returned <code>400</code>. According to the gateway code the same limit applies to each generation on a WebSocket; we did not test that live.</li>
              <li><b>Long text takes time to finish.</b> In our run a 5,000-character request returned its first byte in about 0.2 s and the last byte after about 36 s (roughly 5.7 minutes of audio). Split long text into several requests, or use the streaming endpoint and play as you receive.</li>
              <li><b>Concurrency.</b> Six simultaneous requests all succeeded. We do not publish a concurrency number on this page; the service returns <code>429</code> with <code>Retry-After</code> when it is full.</li>
              <li><b>Free credits.</b> Every account gets a one-time grant of free credits (worth $0.10, about 10,000 characters of speech), shared across all of your keys. When they run out, requests return <code>402</code> until you add a payment method; after that you pay as you go. See <Link href="/developers#free-credits" style={ul}>free credits</Link> and the pricing on the <Link href="/developers" style={ul}>Voice API page</Link>.</li>
            </ul>
          </div>
        </section>

        <section className="ra-section" id="faq">
          <div className="ra-wrap ra-narrow ra-ref" style={{ maxWidth: 820 }}>
            <h2>FAQ</h2>
            <h3>Do I only need to change the base URL?</h3>
            <p>No, three values: the base URL, the key and the voice id. Without a ReadAloud voice id the call returns <code>404</code>.</p>
            <h3>Can I reuse my ElevenLabs voices?</h3>
            <p>No. ElevenLabs voice ids, including your own clones, do not exist here. We do not map them to ReadAloud voices.</p>
            <h3>Will it sound the same?</h3>
            <p>No. It is a different voice. We do not claim parity, so judge it on your own text.</p>
            <h3>Do I need to remove <code>stability</code> and <code>similarity_boost</code>?</h3>
            <p>No. They are accepted and ignored, and the <code>x-compat-ignored</code> response header tells you which ones were ignored. Only <code>speed</code> has an effect.</p>
            <h3>Does streaming work?</h3>
            <p>Yes: the <code>/stream</code> endpoint and the <code>stream-input</code> WebSocket both worked in our run.</p>
            <h3>Can I use ElevenLabs speech to text, dubbing or agents through this API?</h3>
            <p>No. Only text to speech is covered. See the list above.</p>
            <h3>What does it cost?</h3>
            <p>New accounts get a one-time grant of free credits; after that you pay as you go. Current prices are on the <Link href="/developers" style={ul}>Voice API page</Link>.</p>
            <h3>Something here does not match what I see.</h3>
            <p>Tell us at <a href="mailto:support@readaloudai.org" style={ul}>support@readaloudai.org</a>. This page records one dated test run, not a guarantee, and we will correct it.</p>
            <p className="ra-small" style={{ marginTop: 24 }}>
              ReadAloud AI is not affiliated with ElevenLabs. ElevenLabs and its product names belong to their owner and are used here only to describe compatibility.
            </p>
          </div>
        </section>
      </main>
      <RaFooter />
    </div>
  )
}
