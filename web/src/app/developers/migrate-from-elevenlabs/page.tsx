import Link from 'next/link'
import RaHeader from '@/components/ra/RaHeader'
import RaFooter from '@/components/ra/RaFooter'
import MigrationCostCalculator from '@/components/ra/MigrationCostCalculator'
import { ELEVENLABS_PRICES, READALOUD_PRICES, CHARS_PER_SPOKEN_MINUTE, calculatorLists } from '@/content/migrationPrices'
import { PARITY_AS_OF, PARITY_ROWS, STATUS_LABEL, shownStatus } from '@/content/migrationParity'
import { LAUNCH_FLAGS, availabilityLabel, OFFERED_FEATURES } from '@/content/launchFlags'
import { RA_LATENCY, RA_LIVE, RA_STUDIO, RA_LIMITS, RA_FREE_CREDITS } from '@/content/readaloudFacts'
import { compareCosts, formatUsd } from '@/lib/migrationCalc'

const URL = 'https://readaloudai.org/developers/migrate-from-elevenlabs'
const TITLE = 'Migrate from ElevenLabs - ReadAloud AI'
const DESCRIPTION =
  'Point ElevenLabs SDK code at ReadAloud by changing the base URL, the API key and the voice id. Dated price comparison and cost calculator, what works today, what is partial or coming soon, and what is not supported yet. ElevenLabs is faster to first audio in our runs.'

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
curl -X POST "https://api.readaloudai.org/v1/text-to-speech/readaloud-default?output_format=mp3_44100_128" \\
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
    voice_id="readaloud-default",          # was an ElevenLabs voice id
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

const audio = await client.textToSpeech.convert("readaloud-default", {
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
        voice_id="readaloud-default",
        text=text_chunks(),
        model_id="eleven_flash_v2_5",
        output_format="mp3_44100_128",
    ):
        f.write(chunk)`

const WSRAW = `wss://api.readaloudai.org/v1/text-to-speech/readaloud-default/stream-input?output_format=mp3_44100_128

header:   xi-api-key: <your ReadAloud key>      (or send "xi_api_key" in the first message)
send:     {"text": " "}                          first message
send:     {"text": "Thanks for calling. "}       then text, as it arrives
send:     {"text": ""}                           end of input
receive:  {"audio": "<base64>", ...}  ...        then {"isFinal": true} and a normal close`

const CLONE_JS = `// npm i @elevenlabs/elevenlabs-js   (the voices.ivc.create call, run with 2.78.0)
import fs from "node:fs";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";

const client = new ElevenLabsClient({ apiKey: process.env.READALOUD_API_KEY, baseUrl: "https://api.readaloudai.org" });

// 1. A phrase for the speaker to read aloud as consent (the one step ElevenLabs does not have). Record it as consent.wav.
const { challenge_id, phrase } = await (await fetch("https://api.readaloudai.org/v1/voices/add/consent-phrase", {
  method: "POST", headers: { "xi-api-key": process.env.READALOUD_API_KEY } })).json();

// 2. The usual call: samples plus the consent recording (a file named consent.*), the challenge id as a query parameter.
const voice = await client.voices.ivc.create(
  { name: "My voice", files: [fs.createReadStream("sample.wav"), fs.createReadStream("consent.wav")] },
  { queryParams: { consent_challenge_id: challenge_id } },
);

// 3. Use the returned id in text to speech (up to 1,500 characters per request).
const audio = await client.textToSpeech.convert(voice.voiceId, { text: "Hello from my cloned voice.", outputFormat: "mp3_44100_128" });`

const CLONE_CURL = `API=https://api.readaloudai.org

# 1. the phrase to read aloud (record it as consent.wav). Optional: add ?language=de or ?language=es to the URL to read it in that language
curl -s -X POST $API/v1/voices/add/consent-phrase -H "xi-api-key: $READALOUD_API_KEY"

# 2. create the voice
curl -s -X POST $API/v1/voices/add -H "xi-api-key: $READALOUD_API_KEY" \\
  -F name="My voice" -F consent_challenge_id=<challenge_id> \\
  -F files=@sample.wav -F files=@consent.wav
# {"voice_id":"clone-...","requires_verification":false,"language":"en","consent":"verified",...}

# 3. speak with it
curl -s -X POST "$API/v1/text-to-speech/<voice_id>?output_format=mp3_44100_128" \\
  -H "xi-api-key: $READALOUD_API_KEY" -H "Content-Type: application/json" \\
  -d '{"text":"Hello from my cloned voice."}' -o out.mp3

# 4. delete it
curl -s -X DELETE $API/v1/voices/<voice_id> -H "xi-api-key: $READALOUD_API_KEY"`

const CLONE_ERR = `# 400, the plain ElevenLabs call has no consent step: the body says how to finish
{"detail":{"status":"consent_required","message":"Cloning a voice needs the speaker's recorded consent. ...",
  "consent":{"mode":"recorded_phrase","consent_phrase_url":"/v1/voices/add/consent-phrase","steps":["..."],
             "missing":["consent_challenge_id","consent"]}}}

# 422, an option we do not support
{"detail":[{"loc":["body","remove_background_noise"],"msg":"remove_background_noise=true is not supported: ...","type":"unsupported_parameter"}]}`

const STT_PY = `# Python SDK, same client as above (base_url + api_key)
result = client.speech_to_text.convert(
    file=open("call.mp3", "rb"),
    model_id="scribe_v3",        # scribe_v1, scribe_v2, scribe_v3 are accepted
    language_code="eng",         # optional; leave out to detect
)
print(result.text, result.words[0].start)`

const STT_JS = `// JavaScript SDK, same client as above (baseUrl + apiKey)
import fs from "node:fs";
const result = await client.speechToText.convert({
  file: new Blob([await fs.promises.readFile("call.mp3")]),
  modelId: "scribe_v3",
});
console.log(result.text, result.words[0].start);`

const STT_CURL = `# before
curl -X POST "https://api.elevenlabs.io/v1/speech-to-text" \\
  -H "xi-api-key: $ELEVENLABS_API_KEY" -F model_id=scribe_v3 -F file=@call.mp3

# after
curl -X POST "https://api.readaloudai.org/v1/speech-to-text" \\
  -H "xi-api-key: $READALOUD_API_KEY" -F model_id=scribe_v3 -F file=@call.mp3`

const STT_ERR = `# diarize=true: accepted, no effect. 200, words[].speaker_id is null, and the response header says so
x-compat-ignored: diarize

# keyterms, entity_detection with a value, webhook, use_multi_channel, additional_formats ...: 400, never dropped silently
{"detail":{"status":"unsupported_parameter","message":"Not supported on this API: keyterms. Remove them from the request."}}`

const KEY_CURL = `# one key, every REST family (shown for dubbing; the others work the same way)
curl -X POST https://api.readaloudai.org/api/dub \\
  -H "xi-api-key: $READALOUD_API_KEY" \\
  -F audio=@clip.wav -F target_language=es`

const LIVEKIT = `# LiveKit Agents (ElevenLabs plugin pointed at ReadAloud). Checked against a local copy of the API with plugin 1.8.4, not on production.
from livekit.plugins import elevenlabs
tts = elevenlabs.TTS(api_key=os.environ["READALOUD_API_KEY"], base_url="https://api.readaloudai.org/v1", voice_id="readaloud-default")`

const PIPECAT = `# Pipecat: the community service (uv add pipecat-readaloud), or the ElevenLabs HTTP service with base_url set to https://api.readaloudai.org
# (the WebSocket service is only partly verified)`

const ONE_KEY_ROWS: readonly [string, string][] = [
  ['Text to speech, voices, models, user (ElevenLabs routes)', 'Works today'],
  ['Speech to text (Scribe-shaped route)', 'Switched by the speech-to-text flag below'],
  ['Instant voice cloning (ElevenLabs path)', 'Switched by the cloning flag below'],
  [`Dubbing, voice conversion, ${OFFERED_FEATURES.voiceDesign ? 'voice design, ' : ''}audio isolation, audiobooks, sound effects`, 'Session token or MCP today; the rtts_ key directly once one-key access is on'],
]

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
              The ReadAloud API serves the ElevenLabs text-to-speech routes, so code written for the ElevenLabs SDKs runs against <code className="inl">https://api.readaloudai.org</code> after you change three values. This page lists what we ran against the live service, what is available and what is coming soon, a dated price comparison, where ElevenLabs is faster or ahead, and what is not supported yet. ElevenLabs is a strong product with far more voices, languages and features; this page is for teams for whom price per character is what matters.
            </p>
            <p style={{ marginTop: 12 }}>
              <Link href="/developers#get-started" style={ul}>Get an API key</Link> &middot; <Link href="/developers" style={ul}>Voice API reference</Link>
            </p>
            <nav aria-label="On this page" style={{ marginTop: 20 }}>
              <ul className="ra-small" style={{ listStyle: 'none', padding: 0, display: 'flex', flexWrap: 'wrap', gap: '8px 18px' }}>
                <li><a href="#three-changes" style={ul}>Three changes</a></li>
                <li><a href="#before-after" style={ul}>Before and after</a></li>
                <li><a href="#status" style={ul}>Works, partial, not yet</a></li>
                <li><a href="#speech-to-text" style={ul}>Speech to text</a></li>
                <li><a href="#one-key" style={ul}>One key</a></li>
                <li><a href="#price" style={ul}>Prices</a></li>
                <li><a href="#calculator" style={ul}>Cost calculator</a></li>
                <li><a href="#latency" style={ul}>Latency</a></li>
                <li><a href="#voice-cloning" style={ul}>Voice cloning</a></li>
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
            <p className="ra-small" style={{ marginTop: 0 }}>Earlier voice and engine names keep working as aliases.</p>
            <ol style={{ paddingLeft: 24, listStyle: 'decimal', display: 'grid', gap: 10, color: 'var(--ink2)' }}>
              <li><b>Base URL:</b> <code>https://api.readaloudai.org</code> instead of <code>https://api.elevenlabs.io</code>.</li>
              <li><b>API key:</b> your ReadAloud key (it starts with <code>rtts_</code>), from the <Link href="/developers#get-started" style={ul}>console</Link>, no card needed to start. Send it as <code>xi-api-key</code> or as <code>Authorization: Bearer</code>; both work.</li>
              <li><b>Voice id:</b> use <code>readaloud-default</code>, or any voice id from <code>GET /v1/voices</code> (each voice lists its name, language, dialect, gender and tier). ElevenLabs voice ids, for example <code>21m00Tcm4TlvDq8ikWAM</code>, do not exist here and return <code>404 voice_not_found</code>. We do not substitute a voice for you, and there is deliberately no table mapping ElevenLabs voices to ours.</li>
            </ol>
            <p style={{ marginTop: 16 }}>
              Everything else in a typical text-to-speech call, such as <code>model_id</code>, <code>output_format</code> and <code>voice_settings.speed</code>, can stay as it is. <code>readaloud-default</code> is the only voice this guide covers. It does not sound like any ElevenLabs voice, and we make no claim that it matches ElevenLabs quality. Listen to it on your own text before you switch.
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
            <h3>Voice-agent frameworks</h3>
            <p>
              If your agent already uses the ElevenLabs plugin, pointing it at ReadAloud is the same three-value change. The snippets below were checked against a local copy of the API, not production; the ReadAloud plugins are the tested route.
            </p>
            <pre style={pre} tabIndex={0}><code>{LIVEKIT}</code></pre>
            <pre style={{ ...pre, marginTop: 12 }} tabIndex={0}><code>{PIPECAT}</code></pre>
          </div>
        </section>

        <section className="ra-section" id="status">
          <div className="ra-wrap ra-narrow ra-ref" style={{ maxWidth: 820 }}>
            <h2>Works today, partial, not yet</h2>
            <p className="ra-lede" style={{ marginBottom: 16 }}>
              Where ReadAloud stands against the ElevenLabs API, row by row, as of {PARITY_AS_OF}. <b>Coming soon</b> means the feature is built but not switched on in production yet; we will change the label when it is, after a real call has passed. ElevenLabs is far ahead on voices, languages, expressive control, speech-to-text options and agents, and the table says so.
            </p>
            <div className="ra-table-wrap">
              <table className="ra-table">
                <caption style={{ textAlign: 'left', position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>ReadAloud against the ElevenLabs API, by feature</caption>
                <thead><tr><th scope="col">Feature</th><th scope="col">Status</th><th scope="col">Notes</th></tr></thead>
                <tbody>
                  {PARITY_ROWS.map((r) => {
                    const st = shownStatus(r)
                    return (
                      <tr key={`${r.area}-${r.feature}`} data-status={st}>
                        <td><span className="ra-small">{r.area}</span><br />{r.feature}</td>
                        <td><b>{STATUS_LABEL[st]}</b></td>
                        <td>{r.note}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section className="ra-section" id="speech-to-text">
          <div className="ra-wrap ra-narrow ra-ref" style={{ maxWidth: 820 }}>
            <h2>Speech to text (Scribe-shaped route) <span className="ra-small" data-flag="elevenLabsSpeechToText" style={{ fontWeight: 400 }}>&middot; {availabilityLabel('elevenLabsSpeechToText')}</span></h2>
            {LAUNCH_FLAGS.elevenLabsSpeechToText ? (
              <p>The ElevenLabs batch transcription call works with the same base URL and key change as text to speech.</p>
            ) : (
              <p><b>Coming soon.</b> The route is built, but it is switched off in production, so <code>POST /v1/speech-to-text</code> returns <code>404</code> today. Until it is on, use ReadAloud&rsquo;s own transcription API on the <Link href="/developers#speech-to-text" style={ul}>Voice API page</Link>. The snippets below show what will work.</p>
            )}
            <p>
              Request and response are the Scribe shape (<code>language_code</code>, <code>language_probability</code>, <code>text</code>, <code>words[]</code> with <code>start</code> and <code>end</code>, <code>audio_duration_secs</code>), so the official SDKs parse them. Batch only: upload up to 100&nbsp;MB, audio up to 3 hours, and nothing is stored. <code>model_id</code> values <code>scribe_v1</code>, <code>scribe_v2</code> and <code>scribe_v3</code> are accepted and served by one tier; <code>scribe_v2_medical</code> and anything else returns <code>400</code>. The first request after a quiet period can take 10 to 18 seconds while the transcription worker starts, so use a timeout of at least 60 seconds.
            </p>
            <h3>curl</h3>
            <pre style={pre} tabIndex={0}><code>{STT_CURL}</code></pre>
            <h3>Python</h3>
            <pre style={pre} tabIndex={0}><code>{STT_PY}</code></pre>
            <h3>JavaScript</h3>
            <pre style={pre} tabIndex={0}><code>{STT_JS}</code></pre>
            <h3>What is different</h3>
            <ul>
              <li><b>Speaker labels.</b> <code>diarize=true</code>, <code>num_speakers</code> and <code>detect_speaker_roles</code> are accepted and have no effect: <code>speaker_id</code> stays <code>null</code> and the <code>x-compat-ignored</code> response header names them. ReadAloud&rsquo;s own transcription route does label up to 8 speakers.</li>
              <li><b>Rejected with a 400, not silently dropped:</b> <code>keyterms</code>, <code>entity_detection</code> and <code>entity_redaction</code> with a value, <code>webhook</code>, <code>use_multi_channel</code>, <code>additional_formats</code>, <code>secondary_language_codes</code>, <code>numbers_format</code>, <code>no_verbatim</code> and <code>timestamps_granularity=character</code>. Setting them to their off or empty value is fine.</li>
              <li><b>Realtime transcription is early.</b> A WebSocket in the Scribe Live shape works for English, Spanish and German (see the status table above). <code>logprob</code> in <code>words[]</code> is not a measured value; do not filter on it.</li>
              <li><b>Price.</b> See the <a href="#price" style={ul}>price table</a>: batch speech to text is {formatUsd(READALOUD_PRICES.sttBatchPerHourUsd)} per hour of audio.</li>
            </ul>
            <pre style={pre} tabIndex={0}><code>{STT_ERR}</code></pre>
          </div>
        </section>

        <section className="ra-section" id="one-key">
          <div className="ra-wrap ra-narrow ra-ref" style={{ maxWidth: 820 }}>
            <h2>One key on every REST family <span className="ra-small" data-flag="oneKeyEverywhere" style={{ fontWeight: 400 }}>&middot; {availabilityLabel('oneKeyEverywhere')}</span></h2>
            {LAUNCH_FLAGS.oneKeyEverywhere ? (
              <p>The same <code>rtts_</code> key, sent as <code>Authorization: Bearer</code> or <code>xi-api-key</code>, works on text to speech, speech to text, voice cloning, dubbing, voice conversion, {OFFERED_FEATURES.voiceDesign ? 'voice design, ' : ''}audio isolation, audiobooks and sound effects. Work is billed to the account the key belongs to, and free credits follow the account.</p>
            ) : (
              <p><b>Coming soon.</b> Today the <code>rtts_</code> key works on the text-to-speech routes and the ReadAloud transcription route. Dubbing, voice conversion, {OFFERED_FEATURES.voiceDesign ? 'voice design, ' : ''}audio isolation and audiobooks take a signed-in session token, or the same key through the MCP tools. When one-key access is switched on, the key will work on all of them directly.</p>
            )}
            <div className="ra-table-wrap">
              <table className="ra-table">
                <thead><tr><th scope="col">Route family</th><th scope="col">Which credential</th></tr></thead>
                <tbody>
                  {ONE_KEY_ROWS.map(([a, b]) => <tr key={a}><td>{a}</td><td>{b}</td></tr>)}
                </tbody>
              </table>
            </div>
            <pre style={{ ...pre, marginTop: 12 }} tabIndex={0}><code>{KEY_CURL}</code></pre>
            <p className="ra-small">Errors: <code>401</code> unknown or revoked key, <code>403</code> a key that is not tied to an account, <code>402</code> free credits used up and no payment method, <code>429</code> with <code>Retry-After</code> when an account is over its rate limit. Creating and revoking keys stays in the console.</p>
          </div>
        </section>

        <section className="ra-section" id="price">
          <div className="ra-wrap ra-narrow ra-ref" style={{ maxWidth: 820 }}>
            <h2>Price comparison, read {ELEVENLABS_PRICES.retrievedOn}</h2>
            <p className="ra-lede" style={{ marginBottom: 16 }}>
              ElevenLabs figures are its {ELEVENLABS_PRICES.basis}, read by us from <a href={ELEVENLABS_PRICES.sourceUrl} style={ul}>elevenlabs.io/pricing/api</a> on {ELEVENLABS_PRICES.retrievedOn}; the page shows no date of its own. {ELEVENLABS_PRICES.promotionNote} ReadAloud figures are the list prices on the <Link href="/developers" style={ul}>Voice API page</Link>. ElevenLabs plans, enterprise terms and promotions can be lower than its list price, so check its page before you decide.
            </p>
            <div className="ra-table-wrap">
              <table className="ra-table">
                <caption style={{ textAlign: 'left', position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>List prices, text to speech and batch speech to text</caption>
                <thead><tr><th scope="col">Service</th><th scope="col">Per 1,000 characters</th><th scope="col">Per 1M characters</th></tr></thead>
                <tbody>
                  {READALOUD_PRICES.tts.map((t) => <tr key={t.id}><td className="hl">{t.name}</td><td className="hl">{formatUsd(t.per1kUsd)}</td><td className="hl">{formatUsd(t.per1MUsd)}</td></tr>)}
                  {ELEVENLABS_PRICES.tts.map((t) => <tr key={t.id}><td>ElevenLabs {t.name}</td><td>{formatUsd(t.per1kUsd)}</td><td>{formatUsd(t.per1MUsd)}</td></tr>)}
                </tbody>
              </table>
            </div>
            <div className="ra-table-wrap" style={{ marginTop: 16 }}>
              <table className="ra-table">
                <thead><tr><th scope="col">Speech to text</th><th scope="col">Per hour of audio</th></tr></thead>
                <tbody>
                  <tr><td className="hl">ReadAloud batch</td><td className="hl">{formatUsd(READALOUD_PRICES.sttBatchPerHourUsd)}</td></tr>
                  <tr><td>ElevenLabs {ELEVENLABS_PRICES.stt.batch.name}</td><td>{formatUsd(ELEVENLABS_PRICES.stt.batch.perHourUsd)}</td></tr>
                  <tr><td>ElevenLabs {ELEVENLABS_PRICES.stt.realtime.name}</td><td>{formatUsd(ELEVENLABS_PRICES.stt.realtime.perHourUsd)}</td></tr>
                  <tr><td>ReadAloud realtime</td><td>early, no price published yet</td></tr>
                </tbody>
              </table>
            </div>
            <h3>At three monthly volumes</h3>
            <p className="ra-small" style={{ marginTop: 0 }}>Text to speech only. At about {CHARS_PER_SPOKEN_MINUTE} characters per spoken minute (our assumption: 150 words a minute at 6 characters), one minute of speech costs {formatUsd((CHARS_PER_SPOKEN_MINUTE / 1_000_000) * RA_LIVE.per1MUsd)} on ReadAloud Live against {formatUsd((CHARS_PER_SPOKEN_MINUTE / 1_000_000) * ELEVENLABS_PRICES.tts[0].per1MUsd)} on ElevenLabs Flash.</p>
            <div className="ra-table-wrap">
              <table className="ra-table">
                <thead><tr><th scope="col">Characters per month</th><th scope="col">ReadAloud Live</th><th scope="col">ReadAloud Studio</th><th scope="col">ElevenLabs Flash / Turbo</th><th scope="col">ElevenLabs v4 / v3 / v2 Multilingual</th></tr></thead>
                <tbody>
                  {[1_000_000, 10_000_000, 100_000_000].map((n) => {
                    const c = (ra: number, el: number) => compareCosts({ characters: n, sttHours: 0, elTtsPer1MUsd: el, raTtsPer1MUsd: ra, elSttPerHourUsd: 0, raSttPerHourUsd: 0 })
                    return (
                      <tr key={n}>
                        <td>{n.toLocaleString('en-US')}</td>
                        <td>{formatUsd(c(RA_LIVE.per1MUsd, 0).raTotal)}</td>
                        <td>{formatUsd(c(RA_STUDIO.per1MUsd, 0).raTotal)}</td>
                        <td>{formatUsd(c(0, ELEVENLABS_PRICES.tts[0].per1MUsd).elTotal)}</td>
                        <td>{formatUsd(c(0, ELEVENLABS_PRICES.tts[3].per1MUsd).elTotal)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <h3 id="calculator">Cost calculator</h3>
            <p className="ra-small" style={{ marginTop: 0 }}>Put in your own volume. It uses only the two price lists above, runs in your browser and sends nothing.</p>
            <MigrationCostCalculator lists={calculatorLists()} />
            <p className="ra-small" style={{ marginTop: 12 }}>{RA_FREE_CREDITS.short} Price is only part of the decision: see <a href="#latency" style={ul}>latency</a>, <a href="#status" style={ul}>features</a> and the <a href="#differences" style={ul}>differences</a> below.</p>
          </div>
        </section>

        <section className="ra-section" id="latency">
          <div className="ra-wrap ra-narrow ra-ref" style={{ maxWidth: 820 }}>
            <h2>Latency: ElevenLabs Flash is faster</h2>
            <p>
              In our own runs on {RA_LATENCY.measuredOn}, ElevenLabs Flash v2.5 returned the first audio faster than ReadAloud Live: a median of about 166 to 174 ms on a warm connection against {RA_LATENCY.liveWarmLabel} for ReadAloud, and 200 to 280 ms against about 290 ms on a new connection. We do not claim ReadAloud is faster than Flash. ReadAloud Live was about four times faster than ElevenLabs v2 Multilingual in the same runs. If the first 80 ms matter more than price for your product, ElevenLabs Flash is the better choice.
            </p>
            <p className="ra-small">
              Method, all models and the 95th percentile are in the <Link href="/developers#vs-elevenlabs" style={ul}>latency table</Link>. These figures were measured before the ElevenLabs-compatible routes existed, from one machine in the Fly.io San Jose region over short sentences, so treat them as a guide and measure from your own region. ReadAloud runs from one hosting footprint, so we make no regional-latency or data-residency claim. Capacity: {RA_LIMITS.short}.
            </p>
          </div>
        </section>

        <section className="ra-section" id="voice-cloning">
          <div className="ra-wrap ra-narrow ra-ref" style={{ maxWidth: 820 }}>
            <h2>Instant voice cloning <span className="ra-small" data-flag="elevenLabsInstantClone" style={{ fontWeight: 400 }}>&middot; {availabilityLabel('elevenLabsInstantClone')}</span></h2>
            {!LAUNCH_FLAGS.elevenLabsInstantClone && (
              <p><b>Coming soon.</b> The ElevenLabs-path cloning route is built but not switched on in production, so <code>POST /v1/voices/add</code> returns <code>404</code> today. ReadAloud&rsquo;s own cloning API works now (see the <Link href="/developers" style={ul}>Voice API page</Link>). The steps below are what will work.</p>
            )}
            <p>
              <code>voices.ivc.create</code> (<code>POST /v1/voices/add</code>), <code>voices.get</code> and <code>voices.delete</code> work for cloned voices, and the returned <code>voice_id</code> works in the text-to-speech routes above. It needs an API key with billing enabled that belongs to your ReadAloud account. Cloned voices speak English, Spanish or German: another language returns a <code>422</code> that lists the supported ones. The first create after a long idle can take about a minute while the workers start.
            </p>
            <p>
              ElevenLabs has no consent step, so we add one. A plain <code>voices.ivc.create</code> call is answered with a <code>400</code> whose <code>detail.consent</code> object tells you what to send; the SDKs surface it as an API error. Clone your own voice, or one you have the speaker&rsquo;s recorded consent for. The phrase is in English by default. Add <code>?language=es</code> or <code>?language=de</code> to the <code>/v1/voices/add/consent-phrase</code> URL (or send <code>language</code> in a JSON body) to get it in Spanish or German; the recording is then checked in the same language.
            </p>
            <h3>JavaScript</h3>
            <pre style={pre} tabIndex={0}><code>{CLONE_JS}</code></pre>
            <h3>curl</h3>
            <pre style={pre} tabIndex={0}><code>{CLONE_CURL}</code></pre>
            <h3>What we do with the other parameters</h3>
            <ul>
              <li><b><code>files</code></b>: one or more recordings; only the largest one is used, and the response says so (<code>reference_files_used</code>).</li>
              <li><b><code>description</code>, <code>labels</code></b>: accepted, not stored, and listed in the response&rsquo;s <code>ignored</code> field.</li>
              <li><b><code>remove_background_noise=true</code></b>: <code>422</code>. We do not clean recordings; a recording that is too noisy, too short or has several speakers is rejected with the reason.</li>
              <li>Each request to speak with a cloned voice takes up to 1,500 characters. <code>with-timestamps</code> and the WebSocket routes are not available for cloned voices.</li>
              <li>The audio carries an inaudible watermark (response header <code>x-audio-watermarked: true</code>).</li>
            </ul>
            <pre style={pre} tabIndex={0}><code>{CLONE_ERR}</code></pre>
          </div>
        </section>

        <section className="ra-section" id="verified">
          <div className="ra-wrap ra-narrow ra-ref" style={{ maxWidth: 820 }}>
            <h2>What we tested</h2>
            <p className="ra-lede" style={{ marginBottom: 16 }}>
              On 10 October 2026 we ran each item below against the live API at <code>api.readaloudai.org</code>, with the official SDKs and with plain HTTP and WebSocket clients, using a temporary key that has since been revoked. This table is that dated run. The speech-to-text route, instant clone and one-key access were each checked with one real call on 14 November 2026 after they were switched on, and are not part of the 10 October run. Only items that worked are in it. Differences are listed in the next section.
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
              <li><b>Voices.</b> ElevenLabs voice ids return <code>404</code>. Use <code>readaloud-default</code>. Your own ElevenLabs voice clones and Voice Library voices cannot be used here.</li>
              <li><b>Sound.</b> The voice is not the same as any ElevenLabs voice and we do not claim equal quality. We publish no side-by-side audio on this page.</li>
              <li><b><code>model_id</code> does not choose the voice.</b> Any string is accepted, including ids we do not list such as <code>eleven_v3</code>; the voice you pass decides how the audio is made. The exception is <code>eleven_v3</code> and <code>eleven_v4</code> on the default voice, which reach the Expressive tier (see Markup below). The response header <code>X-Model-Mapped</code> reports how the id was treated.</li>
              <li><b>Voice settings.</b> Only <code>speed</code> has an effect. <code>stability</code>, <code>similarity_boost</code>, <code>style</code> and <code>use_speaker_boost</code> are accepted and ignored, as are <code>seed</code>, <code>language_code</code>, <code>previous_text</code>, <code>next_text</code> and a few other request fields. The ones you sent are echoed in the <code>x-compat-ignored</code> response header, so nothing is dropped silently.</li>
              <li><b>Language.</b> <code>language_code</code> does not select a language. <code>readaloud-default</code> is an American English voice. For other languages pick a beta voice by id (German, Spanish, French, Italian, Brazilian Portuguese; see <code>GET /v1/voices</code> and the Languages section of the developer docs). We did not test <code>language_code</code> against them.</li>
              <li><b>Sample rates above 24 kHz are upsampled.</b> The audio is made at 24 kHz. Formats such as <code>mp3_44100_128</code> have the sample rate you asked for but no content above 12 kHz. Response headers <code>X-Sample-Rate</code>, <code>X-Audio-Format</code> and <code>X-Source-Sample-Rate</code> say so.</li>
              <li><b><code>wav_*</code> formats</b> work only on the non-streaming endpoint (the streaming endpoint returns <code>422</code>), as in ElevenLabs.</li>
              <li><b>Timestamps.</b> The non-streaming <code>/with-timestamps</code> route returns alignment for the default voice. The streaming variant returns <code>null</code> alignment, and WebSocket streams carry no timing. Forced alignment of audio you already have is a separate route, <code>POST /v1/forced-alignment</code>.</li>
              <li><b>Markup.</b> No SSML. Audio tags act only in the Expressive tier, which <code>model_id</code> <code>eleven_v3</code> or <code>eleven_v4</code> reaches on the default voice (voice id <code>default</code>). Delivery tags <code>[whisper]</code>, <code>[sigh]</code> and <code>[excited]</code> change how the rest of the sentence is spoken; insertion tags <code>[chuckle]</code>, <code>[cough]</code> and <code>[gasp]</code> add the sound. English only. Laughs and emotion tags such as <code>[sad]</code> are removed and listed in the <code>x-compat-ignored</code> response header, so nothing is read aloud. Mixing a delivery tag with an insertion tag in one request drops the insertion tag. Expressive requests are generated whole rather than streamed, and the first request after a long idle can take 25 to 45 seconds.</li>
              <li><b>Speed varies by voice, and the first request after a long idle can be slow.</b> The default voice (voice id <code>default</code>) has the fastest first audio; some other voices are noticeably slower. The Expressive, clone and speech-to-text workers start on demand, so after a long idle expect tens of seconds on the first request. Past capacity the API answers <code>429</code> with a <code>Retry-After</code> header. We measured from one laptop, not from a co-located server, so treat these as a guide.</li>
              <li><b>Quota status code.</b> When free credits run out the API returns <code>402</code>, not the <code>401</code> ElevenLabs uses. We did not trigger this in the live run.</li>
            </ul>
            <h3>Not supported on the ElevenLabs paths</h3>
            <p>
              These ElevenLabs paths return <code>404</code> on ReadAloud, so do not expect the ElevenLabs SDK methods for them to work. The <a href="#status" style={ul}>status table</a> has the full list; the main ones:
            </p>
            <ul>
              <li>Dubbing, <code>/v1/dubbing</code>. ReadAloud&rsquo;s dubbing is a separate API with its own paths (the same <code>rtts_</code> key works on it once <a href="#one-key" style={ul}>one-key access</a> is on).</li>
              <li>The Agents platform (Conversational AI), <code>/v1/convai/...</code>, speech engine, realtime speech to speech and realtime translation.</li>
              <li>Professional voice cloning on the ElevenLabs path{OFFERED_FEATURES.customVoiceStudio ? <> (ReadAloud&rsquo;s own trained-voice API needs a payment method)</> : ''}.</li>
              <li>Text to voice (voice design), audio isolation, sound generation, music and projects on their ElevenLabs paths. Speech to speech, history, pronunciation dictionaries and text to dialogue are available; see the status table.</li>
              <li>Entity detection, keyterms and webhooks on the batch speech-to-text route.</li>
              <li>Not tested: the deprecated ElevenLabs npm package and the ElevenLabs plugins for voice-agent frameworks against production, see above.</li>
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
            <p>Text to speech and the voice routes work today, and so do the Scribe-shaped speech-to-text route (batch, plus an early realtime WebSocket for English, Spanish and German) and the ElevenLabs-path instant clone (with a consent step); see their sections for the limits. Dubbing and agents are not offered on ElevenLabs paths.</p>
            <h3>What does it cost?</h3>
            <p>At list price {RA_LIVE.name} is {formatUsd(RA_LIVE.per1MUsd)} and {RA_STUDIO.name} {formatUsd(RA_STUDIO.per1MUsd)} per million characters, against {formatUsd(ELEVENLABS_PRICES.tts[0].per1MUsd)} and {formatUsd(ELEVENLABS_PRICES.tts[3].per1MUsd)} on the ElevenLabs API list read on {ELEVENLABS_PRICES.retrievedOn}. See the <a href="#price" style={ul}>price table and calculator</a>. New accounts get a one-time grant of free credits; after that you pay as you go.</p>
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
