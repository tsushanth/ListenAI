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
            <p style={{ marginTop: 16 }}>Voices: Piper has one voice, <code>default</code>. Kokoro has 28 English voices such as <code>af_heart</code>, <code>am_adam</code> and <code>bf_emma</code>; ask for <code>list_voices</code> for all of them. Custom trained voices use <code>custom:&lt;id&gt;</code>. Speech to text is not part of this server.</p>

            <h2 style={{ marginTop: 48 }}>Limits</h2>
            <ul>
              <li>Up to 1,000 characters and about 20 seconds of audio per call. Longer audio is cut off, so split long text into several calls.</li>
              <li>Each call times out after 30 seconds.</li>
              <li>15 speech calls per minute per key, and 120 requests per minute per IP address. Over the limit you get a retry message.</li>
              <li>Speech uses your key&rsquo;s characters and pricing, the same as the <Link href="/developers#reference" style={{ textDecoration: 'underline' }}>WebSocket API</Link>. When the free characters run out, tools return a &ldquo;payment required&rdquo; error.</li>
              <li>If the voice server is busy, the tool says so and tells the assistant to retry in a few seconds.</li>
            </ul>

            <h2 style={{ marginTop: 48 }}>Security</h2>
            <ul>
              <li>Keys belong to one person. Do not share yours or commit it. If it leaks, or you want to disconnect an app you connected with a login, revoke its key in the developer console.</li>
              <li>Our server uses your key only to start each speech request. We do not log or store it.</li>
              <li>Audio is returned inline in the response. We do not save audio files or keep the text you send.</li>
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
