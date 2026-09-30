import Link from 'next/link'
import RaHeader from '@/components/ra/RaHeader'
import RaFooter from '@/components/ra/RaFooter'
import McpInstallTabs from '@/components/ra/McpInstallTabs'

export const metadata = {
  title: 'Connect the MCP server - ReadAloud AI',
  description: 'Add one URL to Claude, Cursor, VS Code or any MCP client and let your AI assistant turn text into speech.',
}

const tools = [
  ['text_to_speech', 'Speaks up to 1,000 characters and returns a WAV clip (24 kHz, mono) plus the duration and time to first audio. Inputs: text, engine (piper or kokoro), voice, speed (0.5 to 2).'],
  ['list_voices', 'Lists the voices you can use for each engine. Input: engine (optional).'],
  ['get_api_status', 'Shows whether the Piper engine is up and how many of its simultaneous streams are in use. Useful after a capacity error.'],
  ['speech_to_text', 'Transcribes spoken audio with Whisper large-v3-turbo. Inputs: audio_base64 (up to 25 MB decoded; WAV, FLAC, OGG, MP3, M4A or WEBM), language (optional), word_timestamps (optional). Returns the transcript, detected language and duration. Batch only.'],
  ['generate_sound_effect', 'Generates a short sound effect from a text description and returns a WAV clip. Inputs: prompt, duration_sec (1 to 12, default 3). Repeat requests for the same prompt and duration are cached and not billed again. Uses your free credits, then needs a payment method. Not for music.'],
  ['dub_audio', 'Re-voices a spoken audio clip into another language: transcribe, translate, then resynthesize each segment with approximate timing. Audio in, audio out only (no video, no subtitles), and the timing is an approximation, not true alignment. Returns a job_id. Inputs: audio_base64 (up to 25 MB), target_language, source_language (optional). Uses your free credits, then needs a payment method.'],
  ['get_dub_status', 'Polls a dub_audio job. Returns processing, ready (with an audio_url) or failed. Input: job_id.'],
  ['isolate_voice', 'Separates vocals from the rest of a clip (Demucs) and can also return the instrumental. Returns a job_id. Inputs: audio_base64 (up to 8 MB decoded), confirms_rights (must be true), want_instrumental (optional). Uses your free credits, then needs a payment method, and needs an isolation container deployed for your account first (deploy it at /isolate-voice while signed in). Quality on noisy real-world speech is limited: it is music-oriented separation, not a speech denoiser.'],
  ['get_voice_isolation', 'Polls an isolate_voice job. Returns the status, and the separated WAV once it is done. Inputs: job_id, stem (vocals or instrumental).'],
  ['create_audiobook', 'Turns long text or an ePub into a chaptered audiobook. Returns an audiobook_id right away; chapters are synthesized in the background.'],
  ['get_audiobook_status', 'Shows the status and duration of each chapter of an audiobook. Input: audiobook_id.'],
  ['export_audiobook', 'Joins the finished chapters into one MP3 with chapter markers and returns a download URL. Every chapter must be ready. Input: audiobook_id.'],
  ['design_voice', 'Generates a new synthetic voice from a text description and a sample sentence. Returns a job_id. Inputs: description (10 to 800 characters), text (up to 500 characters). Uses your free credits, then needs a payment method.'],
  ['get_voice_design', 'Polls a design_voice job. Returns the status, and the WAV sample once it is ready. Input: job_id.'],
  ['convert_voice', 'Speech-to-speech conversion: re-speaks a source clip in the voice of a target reference clip. Returns a job_id. Inputs: source_audio_base64, target_audio_base64 (up to 4 MB each), MIME types, confirms_rights (must be true). The first call on an account sets up a private converter (about 3 minutes) and returns a temporary capacity error; call again afterwards.'],
  ['get_voice_conversion', 'Polls a convert_voice job. Returns the status, and the converted WAV once it is done. Input: job_id.'],
  ['create_voice_clone', 'Starts a custom cloned voice (Piper fine-tune) and records the speaker’s consent. Returns a voice_id. Inputs: speaker_name, attested_by, consent (true), consent_statement (the exact wording). Needs a billing-enabled key.'],
  ['upload_voice_clone_dataset', 'Uploads the recordings for a voice as a ZIP. Inputs: voice_id, and either zip_base64 (up to 8 MB) or zip_url (public https, up to 48 MB). Does not start training or bill.'],
  ['commit_voice_clone_dataset', 'Starts training (30 to 60 minutes) and bills $2.50 per voice. Inputs: voice_id, confirms_charge (must be true).'],
  ['get_voice_clone_status', 'Shows a cloned voice’s status: created, training, ready or rejected. Input: voice_id.'],
  ['deploy_voice_clone', 'Makes a ready cloned voice usable. Returns the voice name to pass to text_to_speech, as custom:<voice_id>. Input: voice_id.'],
  ['delete_voice_clone', 'Permanently deletes a cloned voice and its recordings. Input: voice_id.'],
]

export default function McpDocsPage() {
  return (
    <div className="ra">
      <RaHeader />
      <main>
        <section className="ra-hero" style={{ paddingBottom: 32 }}>
          <div className="ra-wrap">
            <h1 style={{ maxWidth: '18ch' }}>Voice for your AI tools</h1>
            <p className="ra-lede">
              Add one URL to Claude, Cursor, VS Code or any other MCP client, and your assistant can turn text into speech with ReadAloud AI voices. Nothing to install or host.
            </p>
            <p style={{ marginTop: 20 }}><code className="inl" style={{ fontSize: '1.05rem' }}>https://readaloudai.org/mcp</code></p>
          </div>
        </section>

        <section className="ra-section" style={{ paddingTop: 40 }}>
          <div className="ra-wrap ra-narrow" style={{ maxWidth: 820 }}>
            <h2>1. Connect with a login (OAuth)</h2>
            <p className="ra-lede" style={{ marginBottom: 16 }}>
              The easiest way. Add the URL, sign in to your ReadAloud AI account in the browser, and approve. No key to copy or paste.
            </p>
            <ul style={{ marginBottom: 32 }}>
              <li><strong>claude.ai:</strong> Settings, then Connectors, then Add custom connector. Enter <code className="inl">https://readaloudai.org/mcp</code> and follow the sign-in window.</li>
              <li><strong>Claude Code:</strong> run <code className="inl">claude mcp add --transport http readaloud https://readaloudai.org/mcp</code>, then type <code className="inl">/mcp</code> and choose readaloud to sign in.</li>
              <li><strong>Cursor and VS Code:</strong> add the URL as a remote MCP server. The app opens a sign-in page when it first connects.</li>
            </ul>
            <p style={{ marginBottom: 32 }}>
              When you approve, we create an API key named &ldquo;MCP connector (app name)&rdquo; for that app and it uses your free or paid characters. To disconnect, revoke that key in the <Link href="/developers#get-started" style={{ textDecoration: 'underline' }}>developer console</Link>. The app&rsquo;s next request fails and asks you to reconnect. Access tokens last one hour and are renewed automatically for up to 30 days; reconnecting replaces the previous key for the same app.
            </p>

            <h2>2. Or use an API key header</h2>
            <p className="ra-lede" style={{ marginBottom: 24 }}>
              For scripts and clients without login support. Sign in on the <Link href="/developers#get-started" style={{ textDecoration: 'underline' }}>Voice API page</Link> and create a key (new keys include 10,000 free characters), then pick your client and replace <code className="inl">YOUR_API_KEY</code>. Your client sends the key with every request, so keep it out of chat messages and public repos.
            </p>
            <McpInstallTabs />
          </div>
        </section>

        <section className="ra-section">
          <div className="ra-wrap ra-narrow ra-ref" style={{ maxWidth: 820 }}>
            <h2>Try it</h2>
            <p>Ask your assistant something like:</p>
            <ul>
              <li>&ldquo;Say &lsquo;Your order has shipped&rsquo; using the Kokoro voice af_heart.&rdquo;</li>
              <li>&ldquo;What voices are available? Read each one a short greeting so I can compare.&rdquo;</li>
              <li>&ldquo;Turn this paragraph into audio at 1.2x speed.&rdquo;</li>
            </ul>
            <p>The audio comes back inside the tool result as a WAV clip. Whether you can hear it inline depends on the client; some only show a download or attachment.</p>

            <h2 style={{ marginTop: 48 }}>Tools</h2>
            <div className="ra-table-wrap" style={{ marginTop: 16 }}>
              <table className="ra-table">
                <thead><tr><th>Tool</th><th>What it does</th></tr></thead>
                <tbody>{tools.map(([n, d]) => <tr key={n}><td><code>{n}</code></td><td>{d}</td></tr>)}</tbody>
              </table>
            </div>
            <p style={{ marginTop: 16 }}>Voices: Piper has one voice, <code>default</code>. Kokoro has 28 English voices such as <code>af_heart</code>, <code>am_adam</code> and <code>bf_emma</code>; ask for <code>list_voices</code> for all of them. Custom trained voices use <code>custom:&lt;id&gt;</code>. </p>
            <p style={{ marginTop: 12 }}>Most tools return a job id or a URL rather than inline audio, and the longer ones (dubbing, isolation, conversion, audiobooks, cloning) are polled with a matching <code>get_…</code> tool. The tools that need an account (dubbing, sound effects, isolation, conversion, voice design, audiobooks) bill the account your key belongs to; a key that is not tied to an account gets a payment-required error. The REST endpoints behind them do not take your key directly. This server is the only place an API key works for them. Web versions: <Link href="/transcribe" style={{ textDecoration: 'underline' }}>transcribe</Link>, <Link href="/dub" style={{ textDecoration: 'underline' }}>dub</Link>, <Link href="/sound-effects" style={{ textDecoration: 'underline' }}>sound effects</Link>, <Link href="/isolate-voice" style={{ textDecoration: 'underline' }}>isolate voice</Link>, <Link href="/audiobooks" style={{ textDecoration: 'underline' }}>audiobooks</Link>, <Link href="/design-voice" style={{ textDecoration: 'underline' }}>design voice</Link>, <Link href="/convert-voice" style={{ textDecoration: 'underline' }}>convert voice</Link> and <Link href="/clone-voice" style={{ textDecoration: 'underline' }}>clone voice</Link>. Prices are on the <Link href="/developers#reference" style={{ textDecoration: 'underline' }}>Voice API page</Link>; audio-based usage shows on your invoice as character equivalents.</p>

            <h2 style={{ marginTop: 48 }}>Limits</h2>
            <ul>
              <li><code>text_to_speech</code>: up to 1,000 characters and about 20 seconds of audio per call. Longer audio is cut off, so split long text into several calls. Other tools have their own size limits, listed above.</li>
              <li>Each call times out after 30 seconds.</li>
              <li>15 speech calls per minute per key, and 120 requests per minute per IP address. Over the limit you get a retry message.</li>
              <li>Speech uses your key&rsquo;s characters and pricing, the same as the <Link href="/developers#reference" style={{ textDecoration: 'underline' }}>WebSocket API</Link>. When the free characters run out, tools return a &ldquo;payment required&rdquo; error.</li>
              <li>If the voice server is busy, the tool says so and tells the assistant to retry in a few seconds.</li>
            </ul>

            <h2 style={{ marginTop: 48 }}>Security</h2>
            <ul>
              <li>Keys belong to one person. Do not share yours or commit it. If it leaks, or you want to disconnect an app you connected with a login, revoke its key in the developer console.</li>
              <li>Our server uses your key only to authorize each request and to work out which account it belongs to. We do not log or store it.</li>
              <li><code>text_to_speech</code> returns audio inline and we do not save it or keep the text you send. Tools that run jobs (dubbing, sound effects, isolation, conversion, audiobooks, voice design, cloning) necessarily store your input and results on our servers while the job runs and so you can fetch it.</li>
              <li>The text you ask to speak is sent to the voice engine that generates it.</li>
            </ul>

            <p>Prefer the raw API? See the <Link href="/developers#reference" style={{ textDecoration: 'underline' }}>WebSocket reference</Link> for streaming and lower latency.</p>
          </div>
        </section>
      </main>
      <RaFooter />
    </div>
  )
}
