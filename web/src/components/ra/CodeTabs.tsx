'use client'

import { useState } from 'react'

const JS = `// 1. Get a short-lived token (valid 60 s). engine: "piper" or "kokoro".
const { token, url } = await fetch("https://api.readaloudai.org/tts/authorize", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ key: "YOUR_API_KEY", engine: "piper" }),
}).then((r) => r.json())

// 2. Connect straight to the voice server.
const ws = new WebSocket(\`\${url}?token=\${token}\`)
ws.binaryType = "arraybuffer"

// 3. Ask for speech. Audio starts arriving as the first sentence is ready.
ws.onopen = () => ws.send(JSON.stringify({
  type: "synthesize", text: "Thanks for calling. How can I help?", voice: "default", speed: 1.0,
}))

ws.onmessage = (e) => {
  if (typeof e.data === "string") {
    const msg = JSON.parse(e.data)           // chunk_meta | done | cancelled | error
    if (msg.type === "done") console.log("finished")
  } else {
    play(e.data)                              // PCM16 little-endian, mono, 24 kHz
  }
}

// Caller interrupts? Stop mid-sentence:
// ws.send(JSON.stringify({ type: "stop" }))`

const PY = `# pip install requests websocket-client
import json, requests, websocket

auth = requests.post(
    "https://api.readaloudai.org/tts/authorize",
    json={"key": "YOUR_API_KEY", "engine": "piper"},
).json()

ws = websocket.create_connection(f"{auth['url']}?token={auth['token']}")
ws.send(json.dumps({
    "type": "synthesize",
    "text": "Thanks for calling. How can I help?",
    "voice": "default",
}))

pcm = bytearray()
while True:
    msg = ws.recv()
    if isinstance(msg, bytes):
        pcm += msg                      # PCM16 little-endian, mono, 24 kHz
    elif json.loads(msg)["type"] in ("done", "cancelled", "error"):
        break

open("out.pcm", "wb").write(pcm)
# play it: ffplay -f s16le -ar 24000 -ac 1 out.pcm`

export default function CodeTabs() {
  const [tab, setTab] = useState<'js' | 'py'>('js')
  const [copied, setCopied] = useState(false)
  const code = tab === 'js' ? JS : PY
  return (
    <div className="ra-code">
      <div className="ra-code-bar">
        <div className="ra-code-tabs" role="tablist" aria-label="Language">
          <button role="tab" aria-selected={tab === 'js'} onClick={() => setTab('js')}>JavaScript</button>
          <button role="tab" aria-selected={tab === 'py'} onClick={() => setTab('py')}>Python</button>
        </div>
        <button className="ra-copy" onClick={() => { navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500) }}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre><code>{code}</code></pre>
    </div>
  )
}
