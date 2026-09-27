'use client'

import { useState } from 'react'

const BASH = `API_KEY="YOUR_API_KEY"
BASE="https://api.readaloudai.org"

# 1. Get the current consent text
curl -s "$BASE/v1/voices/enabled" \\
  -H "Authorization: Bearer $API_KEY"

# 2. Create a voice
curl -X POST "$BASE/v1/voices" \\
  -H "Authorization: Bearer $API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "speaker_name": "Jane Doe",
    "attested_by": "Jane Doe",
    "consent": true,
    "consent_text_version": "2026-09-v1",
    "consent_statement": "I am authorized to consent on behalf of the speaker named in this request, and that speaker has agreed to have their voice cloned and used to synthesize new speech through this service."
  }'
# -> {"id": "v-a1b2c3d4e5"}

# 3. Upload recordings (single-shot zip)
curl -X PUT "$BASE/v1/voices/v-a1b2c3d4e5/dataset" \\
  -H "Authorization: Bearer $API_KEY" \\
  -H "Content-Type: application/zip" \\
  --data-binary @recordings.zip

# 4. Commit — starts training
curl -X POST "$BASE/v1/voices/v-a1b2c3d4e5/dataset/commit" \\
  -H "Authorization: Bearer $API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"parts": 1}'
# -> {"id": "v-a1b2c3d4e5", "status": "training", "clips": 42}`

const POLL = `API_KEY="YOUR_API_KEY"
BASE="https://api.readaloudai.org"

# 5. Poll status until ready (~30-60 min)
curl -s "$BASE/v1/voices/v-a1b2c3d4e5" \\
  -H "Authorization: Bearer $API_KEY"
# -> {"id":"v-a1b2c3d4e5","status":"ready", ...}

# 6. Preview
curl -X POST "$BASE/v1/voices/v-a1b2c3d4e5/preview" \\
  -H "Authorization: Bearer $API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"text": "Hello, this is a test of my cloned voice."}' \\
  --output preview.wav

# 7. Deploy
curl -X POST "$BASE/v1/voices/v-a1b2c3d4e5/deploy" \\
  -H "Authorization: Bearer $API_KEY"
# -> {"id": "v-a1b2c3d4e5", "voice": "custom:v-a1b2c3d4e5"}`

const SYNTHESIZE = `API_KEY="YOUR_API_KEY"
BASE="https://api.readaloudai.org"

# 8. Synthesize with your custom voice
curl -X POST "$BASE/v1/text-to-speech" \\
  -H "Authorization: Bearer $API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "text": "This sentence is spoken in my cloned voice.",
    "voice": "custom:v-a1b2c3d4e5",
    "speed": 1.0
  }' \\
  --output cloned.pcm

# List your voices
curl -s "$BASE/v1/voices" -H "Authorization: Bearer $API_KEY"

# Delete a voice
curl -X DELETE "$BASE/v1/voices/v-a1b2c3d4e5" \\
  -H "Authorization: Bearer $API_KEY"`

export default function VoiceCloningDocs() {
  const [tab, setTab] = useState<'upload' | 'poll' | 'synthesize'>('upload')
  const [copied, setCopied] = useState(false)

  const code = tab === 'upload' ? BASH : tab === 'poll' ? POLL : SYNTHESIZE

  return (
    <div>
      <div className="ra-price" style={{ margin: '28px 0' }}>
        <div>
          <div style={{ fontSize: '.9rem', color: 'var(--mute)' }}>Voice creation</div>
          <div className="big">$2.50</div>
          <div style={{ color: 'var(--ink2)', fontSize: '.95rem' }}>Per voice, billed on your next invoice</div>
          <ul>
            <li>One-time charge per voice</li>
            <li>No extra cost to synthesize with it</li>
            <li>Same per-character rate as built-in voices</li>
          </ul>
        </div>
        <div>
          <div style={{ fontSize: '.9rem', color: 'var(--mute)' }}>Active voices</div>
          <div className="big">3</div>
          <div style={{ color: 'var(--ink2)', fontSize: '.95rem' }}>Per API key</div>
          <ul>
            <li>Delete old ones to make room</li>
            <li>Rejected voices do not count</li>
          </ul>
        </div>
        <div>
          <div style={{ fontSize: '.9rem', color: 'var(--mute)' }}>Training time</div>
          <div className="big">~30–60 <small>min</small></div>
          <div style={{ color: 'var(--ink2)', fontSize: '.95rem' }}>On GPU, automatic</div>
          <ul>
            <li>10–60 minutes of audio recommended</li>
            <li>Single speaker, clean recordings</li>
            <li>WAV, FLAC, or MP3 inside the zip</li>
          </ul>
        </div>
      </div>

      <p style={{ color: 'var(--ink2)', fontSize: '.95rem', maxWidth: '70ch' }}>
        Requires a <strong>billing-enabled API key</strong>. Free-tier keys receive <code className="inl">402 Payment Required</code>.
        The charge is created when you commit a dataset (step 4 below). Training starts automatically
        and you can poll until the voice is ready.
      </p>

      <div className="ra-code" style={{ marginTop: 28 }}>
        <div className="ra-code-bar">
          <div className="ra-code-tabs" role="tablist" aria-label="Step">
            <button role="tab" aria-selected={tab === 'upload'} onClick={() => setTab('upload')}>1–4. Create & upload</button>
            <button role="tab" aria-selected={tab === 'poll'} onClick={() => setTab('poll')}>5–7. Train & deploy</button>
            <button role="tab" aria-selected={tab === 'synthesize'} onClick={() => setTab('synthesize')}>8+. Synthesize</button>
          </div>
          <button className="ra-copy" onClick={() => { navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500) }}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <pre><code>{code}</code></pre>
      </div>

      <h4 style={{ marginTop: 24, fontSize: '1.05rem' }}>Dataset guidelines</h4>
      <ul style={{ color: 'var(--ink2)', fontSize: '.95rem', paddingLeft: 20, display: 'grid', gap: 6 }}>
        <li><strong>One speaker only.</strong> Multiple speakers confuse the model.</li>
        <li><strong>10–60 minutes</strong> of audio is the sweet spot. More does not always help.</li>
        <li><strong>Clean audio:</strong> minimal background noise, no music, no reverb.</li>
        <li><strong>Natural speech:</strong> read or conversational, not whispered or shouted.</li>
        <li><strong>Format:</strong> Pack WAV, FLAC, or MP3 files into a single zip. No nested folders needed.</li>
        <li><strong>Consent required:</strong> You must have legal right to clone the voice. We record speaker name, attested-by, and a consent statement for every voice.</li>
      </ul>
    </div>
  )
}
