'use client'

import { useState } from 'react'

const BASH = `API_KEY="YOUR_API_KEY"
BASE="https://api.readaloudai.org"

# 1. Create a voice
curl -X POST "$BASE/v1/orpheus-voices" \\
  -H "Authorization: Bearer $API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "speaker_name": "Jane Doe",
    "attested_by": "Jane Doe",
    "consent": true,
    "consent_text_version": "2026-09-v1",
    "consent_statement": "I am authorized to consent on behalf of the speaker named in this request, and that speaker has agreed to have their voice cloned and used to synthesize new speech through this service."
  }'
# -> {"id": "v-a1b2c3d4e5", "status": "awaiting_dataset"}

# 2. Upload recordings (8-20 minutes recommended, single speaker)
curl -X PUT "$BASE/v1/orpheus-voices/v-a1b2c3d4e5/dataset" \\
  -H "Authorization: Bearer $API_KEY" \\
  -H "Content-Type: application/zip" \\
  --data-binary @recordings.zip

# 3. Commit -- starts training
curl -X POST "$BASE/v1/orpheus-voices/v-a1b2c3d4e5/dataset/commit" \\
  -H "Authorization: Bearer $API_KEY"
# -> {"id": "v-a1b2c3d4e5", "status": "training"}`

const POLL = `API_KEY="YOUR_API_KEY"
BASE="https://api.readaloudai.org"

# 4. Poll status until ready
curl -s "$BASE/v1/orpheus-voices/v-a1b2c3d4e5" \\
  -H "Authorization: Bearer $API_KEY"
# -> {"id":"v-a1b2c3d4e5","status":"ready", "clip_count": 42}`

const SYNTHESIZE = `API_KEY="YOUR_API_KEY"
BASE="https://api.readaloudai.org"

# 5. Synthesize with your custom-fast voice
curl -X POST "$BASE/v1/orpheus-tts" \\
  -H "Authorization: Bearer $API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "text": "This sentence is spoken in my cloned voice.",
    "voice": "custom-fast:v-a1b2c3d4e5"
  }' \\
  --output cloned.pcm

# Delete a voice
curl -X DELETE "$BASE/v1/orpheus-voices/v-a1b2c3d4e5" \\
  -H "Authorization: Bearer $API_KEY"`

export default function OrpheusCloningDocs() {
  const [tab, setTab] = useState<'upload' | 'poll' | 'synthesize'>('upload')
  const [copied, setCopied] = useState(false)

  const code = tab === 'upload' ? BASH : tab === 'poll' ? POLL : SYNTHESIZE

  return (
    <div>
      <div className="ra-code" style={{ marginTop: 28 }}>
        <div className="ra-code-bar">
          <div className="ra-code-tabs" role="tablist" aria-label="Step">
            <button role="tab" aria-selected={tab === 'upload'} onClick={() => setTab('upload')}>1-3. Create & upload</button>
            <button role="tab" aria-selected={tab === 'poll'} onClick={() => setTab('poll')}>4. Poll status</button>
            <button role="tab" aria-selected={tab === 'synthesize'} onClick={() => setTab('synthesize')}>5+. Synthesize</button>
          </div>
          <button className="ra-copy" onClick={() => { navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500) }}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <pre><code>{code}</code></pre>
      </div>
    </div>
  )
}
