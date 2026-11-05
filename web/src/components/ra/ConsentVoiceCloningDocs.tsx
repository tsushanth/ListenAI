// Docs for the consent-gated instant voice cloning API (REST + MCP). Contract: docs/VOICE_CLONING_CONSENT.md, "API-key access".
// Static server component: no state, nothing to hydrate.
const STEP1 = `API_KEY="YOUR_API_KEY"
BASE="https://readaloudai.org/api/v1"

curl -X POST "$BASE/voice-clones/consent-phrase" \\
  -H "Authorization: Bearer $API_KEY"
# 201
# {
#   "challenge_id": "5f0c9a1e-6a3e-4f43-9d54-0a1d3c2b7e11",
#   "phrase": "I agree that ReadAloud may create a synthetic copy of my voice. My code words are amber, falcon, river, quartz.",
#   "expires_at": "2026-11-04T18:05:00.000Z"
# }`

const STEP2 = `# The speaker reads the phrase aloud and records it (consent.wav). A second clip of the
# same speaker, 8-120 seconds of clean speech, is the reference (reference.wav).

# Multipart:
curl -X POST "$BASE/voice-clones" \\
  -H "Authorization: Bearer $API_KEY" \\
  -F challenge_id=5f0c9a1e-6a3e-4f43-9d54-0a1d3c2b7e11 \\
  -F name="My narrator voice" -F language=en \\
  -F consent=@consent.wav -F reference=@reference.wav

# Or JSON, with base64 audio or a public https URL for each recording:
curl -X POST "$BASE/voice-clones" \\
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \\
  -d '{
    "challenge_id": "5f0c9a1e-6a3e-4f43-9d54-0a1d3c2b7e11",
    "name": "My narrator voice", "language": "en",
    "consent_audio_base64": "UklGRi...",
    "reference_audio_url": "https://example.com/reference.wav"
  }'
# 201
# {
#   "id": "8b1d2c34-9e57-4a0b-b6f1-2f6c7d0e9a42",
#   "name": "My narrator voice", "language": "en", "status": "active",
#   "reference_seconds": 31.4, "model": "chatterbox-mtl-v3",
#   "created_at": "2026-11-04T18:02:11.000Z"
# }`

const STEP3 = `# Speak with the cloned voice (WAV, 24 kHz, up to 1,500 characters per call)
curl -X POST "$BASE/voice-clones/8b1d2c34-9e57-4a0b-b6f1-2f6c7d0e9a42/speech" \\
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \\
  -d '{"text": "This sentence is spoken in my cloned voice.", "speed": 1.0}' \\
  --output cloned.wav
# Response headers: X-Watermark: perth, X-Voice-ID, X-Characters-Used, X-Synthesis-Time-Ms

# List your cloned voices (yours only; never returns audio)
curl -s "$BASE/voice-clones" -H "Authorization: Bearer $API_KEY"
# {"voices":[{"id":"8b1d2c34-...","name":"My narrator voice","language":"en","status":"active","created_at":"..."}]}

# Delete a cloned voice (removes the reference audio and embeddings)
curl -X DELETE "$BASE/voice-clones/8b1d2c34-9e57-4a0b-b6f1-2f6c7d0e9a42" \\
  -H "Authorization: Bearer $API_KEY"
# {"deleted":true,"alreadyDeleted":false}`

const ERROR = `{"error":"The voice in the consent recording does not match the reference audio. You can only clone your own voice.","code":"speaker_mismatch","details":{"attemptsLeft":2}}`

const ERRORS: Array<[string, string, string]> = [
  ['401', 'unauthenticated', 'Missing, invalid or revoked API key.'],
  ['402', 'payment_required', 'The account has no paid or complimentary plan. Voice cloning needs a payment method; free credits do not cover it.'],
  ['403', 'email_unverified, account_required', 'Verify the account email first, or use a key created while signed in (a key that is not tied to an account cannot clone).'],
  ['422', 'phrase_mismatch', 'The recording does not match the issued phrase (or the code words were not said in order). Record again; details.attemptsLeft says how many tries are left on this phrase (3 in total).'],
  ['422', 'speaker_mismatch', 'The voice in the consent recording is not the voice in the reference. You can only clone your own voice, or one whose speaker records the consent phrase themselves.'],
  ['503', 'asr_unavailable', 'Consent verification (speech recognition) is temporarily unavailable. Retry later; the attempt is not lost.'],
  ['422', 'reference_rejected, consent_clip_rejected', 'The recording is too short or long, too noisy, clipped, contains music or more than one speaker. details.failures lists why.'],
  ['400', 'audio_required, validation, unsupported_language', 'A required recording or field is missing or invalid.'],
  ['404, 409, 410, 429', 'challenge_not_found, challenge_used, challenge_expired, challenge_attempts_exhausted', 'The phrase is single use and valid for about 5 minutes. Request a new one.'],
  ['422', 'attestation_required', 'Attestation mode only (see below): send attested=true.'],
  ['429', 'rate_limited, daily_limit, creation_in_progress', 'Per-account hourly cap on cloning calls (5 creations per hour), the daily creation limit (3 per 24 hours for paid accounts, 10 for complimentary; deleted voices still count), or a creation already running for this account. Retry-After is sent for rate_limited.'],
  ['404', 'voice_not_found', 'No such cloned voice for this account. Someone else’s voice looks exactly like a missing one.'],
  ['403, 409', 'voice_disabled, voice_unavailable', 'The voice was disabled after an abuse report, or is being deleted.'],
  ['502, 503', 'deletion_pending, service_unavailable, unavailable', 'Deletion was not confirmed yet (retry the DELETE), the cloning service is down, or cloning is switched off.'],
]

export default function ConsentVoiceCloningDocs() {
  return (
    <div>
      <div className="ra-dark-panel" style={{ padding: '16px 20px', margin: '16px 0' }}>
        <p style={{ margin: 0 }}>
          <b>Only clone your own voice, or the voice of a person whose recorded consent you have.</b> Every clone needs a recording
          of the speaker reading a phrase we issue, and we check that the voice in it matches the reference clip. Do not generate,
          synthesize or edit the consent recording, and do not clone a third party from audio you found. Cloning someone without
          their consent is against our terms and the law in many places, and we disable voices after abuse reports.
        </p>
      </div>
      <p>
        Instant cloning from a short recording, in three steps. It is separate from the trained custom voices above: no dataset ZIP
        and no training wait, and the voice is ready as soon as the call returns. Base URL <code className="inl">https://readaloudai.org/api/v1</code>,
        auth <code className="inl">Authorization: Bearer &lt;your API key&gt;</code>. The key must belong to an account with a verified email and a paid or
        complimentary plan (the same gate as the website). Cloned voices are private to the account, and the speech they produce carries
        an inaudible watermark identifying it as synthetic.
      </p>

      <h4 style={{ marginTop: 24, fontSize: '1.05rem' }}>Step 1. Issue a consent phrase</h4>
      <p>Returns a single-use phrase with four random code words. It expires after about 5 minutes and allows 3 attempts. The speaker records themselves reading it aloud.</p>
      <pre style={{ overflowX: 'auto' }}><code>{STEP1}</code></pre>

      <h4 style={{ marginTop: 24, fontSize: '1.05rem' }}>Step 2. Create the clone</h4>
      <p>
        Send the consent recording (the speaker reading the phrase) and a reference recording of the same speaker. We transcribe the consent
        recording and check that it matches the phrase, then check that the speaker in it matches the reference. Recordings can be WAV, FLAC,
        OGG, MP3, M4A or WebM, up to 25&nbsp;MB each. The reference should be 8 to 120 seconds of clean speech by one person.
        In JSON, use <code>reference_audio_base64</code> or <code>reference_audio_url</code> and <code>consent_audio_base64</code> or <code>consent_audio_url</code>;
        URLs must be public https addresses. Creation can take up to a few minutes when the GPU app is waking up.
      </p>
      <pre style={{ overflowX: 'auto' }}><code>{STEP2}</code></pre>

      <h4 style={{ marginTop: 24, fontSize: '1.05rem' }}>Step 3. Use it</h4>
      <pre style={{ overflowX: 'auto' }}><code>{STEP3}</code></pre>
      <p>
        Through the MCP server, pass <code>clone:&lt;id&gt;</code> as the <code>voice</code> of <code>text_to_speech</code>. The ids from this API are accepted only by the
        account that created them, on the routes above and in <code>text_to_speech</code>. They are not yet accepted by <code>/v1/audio/speech</code> or the WebSocket
        endpoint.
      </p>

      <h4 style={{ marginTop: 24, fontSize: '1.05rem' }}>Errors</h4>
      <p>Errors are JSON, <code>{'{ "error", "code", "details"? }'}</code>:</p>
      <pre style={{ overflowX: 'auto' }}><code>{ERROR}</code></pre>
      <div className="ra-table-wrap" style={{ marginTop: 8 }}>
        <table className="ra-table">
          <thead><tr><th>HTTP</th><th><code>code</code></th><th>Meaning</th></tr></thead>
          <tbody>{ERRORS.map(([s, c, m]) => <tr key={c}><td>{s}</td><td><code>{c}</code></td><td>{m}</td></tr>)}</tbody>
        </table>
      </div>

      <h4 style={{ marginTop: 24, fontSize: '1.05rem' }}>Deleting, retention and limits</h4>
      <ul>
        <li><code>DELETE /voice-clones/&#123;id&#125;</code> removes the reference audio, voice embeddings and cached prompts, and the voice stops working immediately. The record that consent was given (the phrase, its transcript and the match scores) is kept for 12 months after deletion for abuse handling, then removed. Audio you already generated is not recalled. A deleted voice still counts toward the daily creation limit.</li>
        <li>Speech: up to 1,500 characters per call and 60 calls per hour per account. We keep a hash of each output (not the audio) for 90 days.</li>
        <li>Customer audio is never used to train models.</li>
        <li>
          <b>Attestation mode.</b> The operator can replace the spoken phrase with a confirmation. <code>GET /voice-clones/config</code> returns <code>{'{ "consent_required": false }'}</code>,
          step 1 returns <code>{'{ "consent_required": false }'}</code> and creation takes only <code>reference</code> plus <code>attested=true</code> (<code>&quot;attested&quot;: true</code> in JSON).
          This is a confirmation, not a check: you are still responsible for cloning only your own voice or one you have the speaker&rsquo;s recorded consent for.
        </li>
      </ul>
    </div>
  )
}
