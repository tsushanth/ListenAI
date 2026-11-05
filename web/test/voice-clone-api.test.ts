// node --test. Consent-gated voice cloning through the MCP server and the public REST routes. Network is a stub: the gateway
// (/tts/authorize) and the backend (/internal/voice-clone-api/*) are faked, so these tests check what we send, what we refuse
// locally, and how every backend answer (consent failures, plan, rate limit, ownership) reaches the caller.
import { test } from 'node:test'
import assert from 'node:assert/strict'

// Read at module load by upstream.ts / cloneClient.ts, so set before importing anything from lib/mcp.
process.env.MCP_GATEWAY_FORWARD_SECRET = 'test-forward-secret'
process.env.NEXT_PUBLIC_API_URL = 'https://backend.test'
process.env.TTS_GATEWAY_URL = 'https://gateway.test'

const loadClient = () => import('../src/lib/mcp/cloneClient.ts')
const loadServer = () => import('../src/lib/mcp/server.ts')
const loadRest = () => import('../src/lib/mcp/voiceCloneRest.ts')
const loadCard = () => import('../src/lib/mcp/serverCard.ts')

const UID = '11111111-1111-4111-8111-111111111111'
const VOICE = '22222222-2222-4222-8222-222222222222'
const API = 'https://backend.test/internal/voice-clone-api'
const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const TOKEN_WITH_UID = `${b64url({ uid: UID })}.sig`
const TOKEN_NO_UID = 'e30.sig'
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(200, 1)])

const realFetch = globalThis.fetch
interface Call { url: string; method: string; headers: Record<string, string>; body?: unknown }
let calls: Call[] = []
let handler: (c: Call) => Response | undefined = () => undefined
let gatewayToken = TOKEN_WITH_UID
let gatewayStatus = 200

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

function install() {
  calls = []; handler = () => undefined; gatewayToken = TOKEN_WITH_UID; gatewayStatus = 200
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v })
    const call: Call = { url, method: (init?.method || 'GET').toUpperCase(), headers, body: init?.body }
    calls.push(call)
    if (url === 'https://gateway.test/tts/authorize') return gatewayStatus === 200 ? json(200, { token: gatewayToken, url: 'wss://gateway.test/ws' }) : json(gatewayStatus, {})
    return handler(call) ?? json(500, { error: `unhandled ${call.method} ${url}` })
  }) as typeof fetch
}
const restore = () => { globalThis.fetch = realFetch }
const backendCalls = () => calls.filter((c) => c.url.startsWith(API))

let seq = 0
async function connect() {
  const [{ Client }, { InMemoryTransport }, { createMcpServer }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'), import('@modelcontextprotocol/sdk/inMemory.js'), loadServer(),
  ])
  // A fresh key id per client keeps the per-key rate limiters of different tests independent.
  const ctx = { apiKey: 'sk_test_key_12345', keyId: `key${String(++seq).padStart(12, '0')}`, authFailed: undefined as boolean | undefined }
  const server = createMcpServer(ctx)
  const client = new Client({ name: 't', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ type: string; text?: string; data?: string }>; structuredContent?: Record<string, any> }
  return { call, ctx, client, close: async () => { await client.close().catch(() => {}); await server.close().catch(() => {}) } }
}

const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')

// ---------------------------------------------------------------------------
// Helpers and schemas
// ---------------------------------------------------------------------------

test('parseCloneVoiceId accepts clone:<uuid> and a bare uuid, and never matches built-in or custom voices', async () => {
  const { parseCloneVoiceId } = await loadClient()
  assert.equal(parseCloneVoiceId(`clone:${VOICE}`), VOICE)
  assert.equal(parseCloneVoiceId(VOICE.toUpperCase()), VOICE)
  for (const v of ['default', 'af_heart', 'custom:v-a1b2c3d4e5', 'clone:', 'clone:not-a-uuid', '', undefined, `custom:${VOICE}`]) {
    assert.equal(parseCloneVoiceId(v as string | undefined), null, String(v))
  }
})

test('sniffAudioMime recognises the containers the backend accepts', async () => {
  const { sniffAudioMime } = await loadClient()
  const pad = Buffer.alloc(16)
  assert.equal(sniffAudioMime(WAV), 'audio/wav')
  assert.equal(sniffAudioMime(Buffer.concat([Buffer.from('fLaC'), pad])), 'audio/flac')
  assert.equal(sniffAudioMime(Buffer.concat([Buffer.from('OggS'), pad])), 'audio/ogg')
  assert.equal(sniffAudioMime(Buffer.concat([Buffer.from('ID3'), pad])), 'audio/mpeg')
  assert.equal(sniffAudioMime(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypM4A '), pad])), 'audio/mp4')
  assert.equal(sniffAudioMime(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), pad])), 'audio/webm')
  assert.equal(sniffAudioMime(Buffer.from('%PDF-1.7 not audio at all')), null)
})

test('create schema: name/language bounds, challenge id must be a uuid, unknown mime refused', async () => {
  const { createClonedVoiceSchema: s } = await loadClient()
  assert.deepEqual({ name: s.parse({}).name, language: s.parse({}).language }, { name: 'My cloned voice', language: 'en' })
  assert.throws(() => s.parse({ name: '' }))
  assert.throws(() => s.parse({ language: 'x' }))
  assert.throws(() => s.parse({ challenge_id: 'nope' }))
  assert.throws(() => s.parse({ reference_mime_type: 'image/png' }))
  assert.throws(() => s.parse({ reference_audio_url: 'not a url' }))
})

test('resolveAudioInput: neither -> null, both -> error, oversize base64 -> error, URL is SSRF-guarded before any request', async () => {
  const { resolveAudioInput } = await loadClient()
  install()
  try {
    assert.equal(await resolveAudioInput({ label: 'reference', maxBase64Mb: 4 }), null)
    await assert.rejects(resolveAudioInput({ label: 'reference', base64: 'QUJD', url: 'https://8.8.8.8/a.wav', maxBase64Mb: 4 }), /only one/)
    await assert.rejects(resolveAudioInput({ label: 'reference', base64: 'A'.repeat(6 * 1024 * 1024), maxBase64Mb: 4 }), /exceeds 4 MB/)
    for (const u of ['http://8.8.8.8/a.wav', 'https://127.0.0.1/a.wav', 'https://169.254.169.254/latest/meta-data', 'https://user:pw@8.8.8.8/a.wav']) {
      await assert.rejects(resolveAudioInput({ label: 'consent', url: u, maxBase64Mb: 4 }), (e: Error) => e.name === 'Error' && /consent_audio_url/.test(e.message), u)
    }
    assert.equal(calls.length, 0)
    const ok = await resolveAudioInput({ label: 'reference', base64: WAV.toString('base64'), maxBase64Mb: 4 })
    assert.equal(ok!.mime, 'audio/wav')
    assert.equal(ok!.filename, 'reference.wav')
    await assert.rejects(resolveAudioInput({ label: 'reference', base64: Buffer.from('this is not audio, honestly').toString('base64'), maxBase64Mb: 4 }), /recognise the audio format/)
  } finally { restore() }
})

// ---------------------------------------------------------------------------
// MCP server: registration, consent wording, server card
// ---------------------------------------------------------------------------

test('new tools are registered with the right annotations and every cloning tool states the consent requirement', async () => {
  const { createMcpServer } = await loadServer()
  const tools = (createMcpServer({ apiKey: 'k', keyId: 'registration0001' }) as unknown as {
    _registeredTools: Record<string, { description?: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }>
  })._registeredTools
  const expected: Record<string, { readOnly: boolean; destructive: boolean }> = {
    readaloud_issue_consent_phrase: { readOnly: false, destructive: false },
    readaloud_create_voice_clone: { readOnly: false, destructive: false },
    readaloud_list_voices: { readOnly: true, destructive: false },
    readaloud_delete_voice_clone: { readOnly: false, destructive: true },
  }
  for (const [name, want] of Object.entries(expected)) {
    assert.ok(tools[name], `${name} registered`)
    assert.equal(tools[name].annotations?.readOnlyHint, want.readOnly, name)
    assert.equal(tools[name].annotations?.destructiveHint, want.destructive, name)
  }
  for (const name of ['readaloud_issue_consent_phrase', 'readaloud_create_voice_clone']) {
    assert.match(tools[name].description!, /only clone your own voice/i, name)
    assert.match(tools[name].description!, /consent/i, name)
    assert.match(tools[name].description!, /never (generate|use)/i, name)
  }
  assert.match(tools.text_to_speech.description!, /clone:<id>/)
  for (const code of ['phrase_mismatch', 'speaker_mismatch', 'asr_unavailable', 'payment_required', 'rate_limited']) {
    assert.match(tools.readaloud_create_voice_clone.description!, new RegExp(code), code)
  }
})

test('the MCP server card lists the new tools', async () => {
  const { buildServerCard } = await loadCard()
  const names = ((await buildServerCard()).tools as Array<{ name: string }>).map((t) => t.name)
  for (const n of ['readaloud_issue_consent_phrase', 'readaloud_create_voice_clone', 'readaloud_list_voices', 'readaloud_delete_voice_clone', 'text_to_speech']) {
    assert.ok(names.includes(n), n)
  }
})

// ---------------------------------------------------------------------------
// MCP tools
// ---------------------------------------------------------------------------

test('issue_consent_phrase forwards only the gateway identity (never the API key) and returns the phrase', async () => {
  install()
  handler = (c) => c.url === `${API}/consent-phrase` ? json(201, { challenge_id: VOICE, phrase: 'I agree ... My code words are amber, arrow, apple, anchor.', expires_at: '2030-01-01T00:05:00.000Z' }) : undefined
  const m = await connect()
  try {
    const r = await m.call('readaloud_issue_consent_phrase')
    assert.ok(!r.isError)
    assert.equal(r.structuredContent!.challenge_id, VOICE)
    assert.match(text(r), /amber, arrow, apple, anchor/)
    const c = backendCalls()[0]!
    assert.equal(c.method, 'POST')
    assert.equal(c.headers['x-gateway-admin-secret'], 'test-forward-secret')
    assert.equal(c.headers['x-gateway-uid'], UID)
    assert.ok(!JSON.stringify(c.headers).includes('sk_test_key_12345'), 'raw API key must not reach the backend')
    assert.equal(c.headers.authorization, undefined)
  } finally { restore(); await m.close() }
})

test('issue_consent_phrase in attestation mode says no phrase is needed', async () => {
  install()
  handler = (c) => c.url === `${API}/consent-phrase` ? json(200, { consent_required: false }) : undefined
  const m = await connect()
  try {
    const r = await m.call('readaloud_issue_consent_phrase')
    assert.equal(r.structuredContent!.consent_required, false)
    assert.match(text(r), /attestation mode/)
  } finally { restore(); await m.close() }
})

test('a key with no bound account is refused by the backend (403) and surfaced as forbidden', async () => {
  install()
  gatewayToken = TOKEN_NO_UID
  handler = (c) => c.url === `${API}/consent-phrase` ? (c.headers['x-gateway-uid'] ? undefined : json(403, { error: 'Voice cloning needs an API key that belongs to a ReadAloud account.', code: 'account_required' })) : undefined
  const m = await connect()
  try {
    const r = await m.call('readaloud_issue_consent_phrase')
    assert.equal(r.isError, true)
    assert.equal(r.structuredContent!.error.code, 'forbidden')
    assert.equal(r.structuredContent!.error.detail_code, 'account_required')
    assert.ok(backendCalls()[0]!.headers['x-gateway-key-id'], 'falls back to the key id header, which the backend rejects for cloning')
  } finally { restore(); await m.close() }
})

test('create_voice_clone sends reference + consent as multipart with the challenge, and returns the clone: voice string', async () => {
  install()
  handler = (c) => c.url === `${API}/` && c.method === 'POST'
    ? json(201, { id: VOICE, name: 'Narrator', language: 'en', status: 'active', reference_seconds: 12.5, model: 'chatterbox-mtl-v3', created_at: '2030-01-01T00:00:00.000Z' }) : undefined
  const m = await connect()
  try {
    const r = await m.call('readaloud_create_voice_clone', {
      name: 'Narrator', language: 'en', challenge_id: UID,
      reference_audio_base64: WAV.toString('base64'), consent_audio_base64: WAV.toString('base64'),
    })
    assert.ok(!r.isError, text(r))
    assert.equal(r.structuredContent!.voice, `clone:${VOICE}`)
    const c = backendCalls()[0]!
    assert.ok(c.body instanceof FormData)
    const fd = c.body as FormData
    assert.equal(fd.get('challenge_id'), UID)
    assert.equal(fd.get('name'), 'Narrator')
    assert.equal((fd.get('reference') as File).name, 'reference.wav')
    assert.equal((fd.get('consent') as File).name, 'consent.wav')
    assert.equal(fd.get('attested'), null, 'no attestation unless the caller sent it')
    assert.equal(c.headers['x-gateway-uid'], UID)
  } finally { restore(); await m.close() }
})

test('create_voice_clone downloads audio by https URL (public host) and forwards it', async () => {
  install()
  handler = (c) => {
    if (c.url === 'https://8.8.8.8/ref.wav') return new Response(new Uint8Array(WAV), { status: 200, headers: { 'Content-Type': 'audio/wav' } })
    if (c.url === `${API}/` && c.method === 'POST') return json(201, { id: VOICE, name: 'x', language: 'en', status: 'active' })
    return undefined
  }
  const m = await connect()
  try {
    const r = await m.call('readaloud_create_voice_clone', { attested: true, reference_audio_url: 'https://8.8.8.8/ref.wav' })
    assert.ok(!r.isError, text(r))
    const fd = backendCalls()[0]!.body as FormData
    assert.equal(fd.get('attested'), 'true')
    assert.equal(fd.get('consent'), null)
    assert.equal((fd.get('reference') as File).size, WAV.length)
  } finally { restore(); await m.close() }
})

test('create_voice_clone refuses an internal-address URL locally and without calling the backend', async () => {
  install()
  const m = await connect()
  try {
    const r = await m.call('readaloud_create_voice_clone', { reference_audio_url: 'https://169.254.169.254/latest/meta-data', consent_audio_base64: WAV.toString('base64'), challenge_id: UID })
    assert.equal(r.isError, true)
    assert.equal(r.structuredContent!.error.code, 'invalid_input')
    assert.equal(backendCalls().length, 0)
    const none = await m.call('readaloud_create_voice_clone', { challenge_id: UID })
    assert.equal(none.isError, true)
    assert.match(text(none), /reference_audio_base64 or reference_audio_url/)
    assert.equal(backendCalls().length, 0)
  } finally { restore(); await m.close() }
})

test('create_voice_clone: every backend failure keeps its specific code (phrase_mismatch, speaker_mismatch, asr_unavailable, plan, rate limit, daily limit, quality)', async () => {
  const cases: Array<{ status: number; body: Record<string, unknown>; code: string; detail: string; retryable: boolean }> = [
    { status: 422, body: { error: 'We could not match what you said to the phrase.', code: 'phrase_mismatch', details: { attemptsLeft: 2 } }, code: 'invalid_input', detail: 'phrase_mismatch', retryable: false },
    { status: 422, body: { error: 'The voice in the consent recording does not match the reference audio. You can only clone your own voice.', code: 'speaker_mismatch', details: { attemptsLeft: 1 } }, code: 'invalid_input', detail: 'speaker_mismatch', retryable: false },
    { status: 503, body: { error: 'Consent verification is temporarily unavailable.', code: 'asr_unavailable' }, code: 'upstream', detail: 'asr_unavailable', retryable: true },
    { status: 402, body: { error: 'Voice cloning requires an active paid plan with a payment method on file.', code: 'payment_required' }, code: 'payment_required', detail: 'payment_required', retryable: false },
    { status: 403, body: { error: 'Verify your email address before creating a cloned voice.', code: 'email_unverified' }, code: 'forbidden', detail: 'email_unverified', retryable: false },
    { status: 429, body: { error: 'Too many requests. Try again later.', code: 'rate_limited' }, code: 'rate_limited', detail: 'rate_limited', retryable: true },
    { status: 429, body: { error: 'You can create 3 cloned voices per 24 hours.', code: 'daily_limit', details: { limit: 3, used: 3 } }, code: 'rate_limited', detail: 'daily_limit', retryable: false },
    { status: 422, body: { error: 'The reference audio cannot be used.', code: 'reference_rejected', details: { failures: [{ code: 'too_noisy' }] } }, code: 'invalid_input', detail: 'reference_rejected', retryable: false },
    { status: 410, body: { error: 'The consent challenge expired.', code: 'challenge_expired' }, code: 'invalid_input', detail: 'challenge_expired', retryable: false },
    { status: 503, body: { error: 'Voice cloning is not available.', code: 'unavailable' }, code: 'upstream', detail: 'unavailable', retryable: false },
  ]
  for (const c of cases) {
    install()
    handler = (call) => call.url === `${API}/` ? json(c.status, c.body) : undefined
    const m = await connect()
    try {
      const r = await m.call('readaloud_create_voice_clone', { challenge_id: UID, reference_audio_base64: WAV.toString('base64'), consent_audio_base64: WAV.toString('base64') })
      assert.equal(r.isError, true, c.detail)
      const e = r.structuredContent!.error
      assert.equal(e.code, c.code, c.detail)
      assert.equal(e.detail_code, c.detail)
      assert.equal(e.retryable, c.retryable, c.detail)
      assert.match(text(r), new RegExp(c.detail))
      if (c.body.details) assert.deepEqual(e.details, c.body.details)
    } finally { restore(); await m.close() }
  }
})

test('create_voice_clone: a revoked key (401 from the gateway) is unauthorized and trips the connection-level auth failure', async () => {
  install()
  gatewayStatus = 401
  const m = await connect()
  try {
    const r = await m.call('readaloud_create_voice_clone', { reference_audio_base64: WAV.toString('base64'), attested: true })
    assert.equal(r.structuredContent!.error.code, 'unauthorized')
    assert.equal(m.ctx.authFailed, true)
    assert.equal(backendCalls().length, 0)
  } finally { restore(); await m.close() }
})

test('tools are rate limited per key before the backend is called', async () => {
  install()
  handler = (c) => c.url === `${API}/consent-phrase` ? json(201, { challenge_id: VOICE, phrase: 'p', expires_at: '2030-01-01T00:00:00.000Z' }) : undefined
  const m = await connect()
  try {
    for (let i = 0; i < 6; i++) assert.ok(!(await m.call('readaloud_issue_consent_phrase')).isError)
    const r = await m.call('readaloud_issue_consent_phrase')
    assert.equal(r.isError, true)
    assert.equal(r.structuredContent!.error.code, 'rate_limited')
    assert.equal(backendCalls().length, 6)
  } finally { restore(); await m.close() }
})

test('list_voices marks cloned voices and still lists built-ins when cloning is unavailable to this account', async () => {
  install()
  handler = (c) => c.url === `${API}/` && c.method === 'GET'
    ? json(200, { voices: [{ id: VOICE, name: 'Narrator', language: 'en', status: 'active', created_at: 'x' }, { id: UID, name: 'Old', language: 'es', status: 'disabled', created_at: 'y' }] }) : undefined
  const m = await connect()
  try {
    const r = await m.call('readaloud_list_voices', { engine: 'live' })
    const s = r.structuredContent!
    assert.deepEqual(s.live.voices, ['default'])
    assert.equal(s.studio, undefined)
    assert.equal(s.cloned_voices.length, 2)
    assert.deepEqual(s.cloned_voices[0], { voice: `clone:${VOICE}`, id: VOICE, name: 'Narrator', language: 'en', status: 'active', created_at: 'x', cloned: true, usable: true })
    assert.equal(s.cloned_voices[1].usable, false)
  } finally { restore(); await m.close() }

  install()
  handler = (c) => c.url === `${API}/` ? json(402, { error: 'Voice cloning requires an active paid plan.', code: 'payment_required' }) : undefined
  const m2 = await connect()
  try {
    const r = await m2.call('readaloud_list_voices')
    assert.ok(!r.isError)
    assert.deepEqual(r.structuredContent!.cloned_voices, [])
    assert.match(r.structuredContent!.cloned_voices_note, /paid plan/)
    assert.deepEqual(r.structuredContent!.studio.default, 'af_heart')
  } finally { restore(); await m2.close() }
})

test('delete_voice_clone deletes only by id for this account; someone else\'s voice is "not found"; bad ids never reach the backend', async () => {
  install()
  handler = (c) => {
    if (c.method === 'DELETE' && c.url === `${API}/${VOICE}`) return json(200, { deleted: true, alreadyDeleted: false })
    if (c.method === 'DELETE') return json(404, { error: 'Cloned voice not found.', code: 'voice_not_found' })
    return undefined
  }
  const m = await connect()
  try {
    const ok = await m.call('readaloud_delete_voice_clone', { voice_id: VOICE })
    assert.ok(!ok.isError)
    assert.equal(ok.structuredContent!.deleted, true)
    const foreign = await m.call('readaloud_delete_voice_clone', { voice_id: UID })
    assert.equal(foreign.isError, true)
    assert.equal(foreign.structuredContent!.error.detail_code, 'voice_not_found')
    await assert.rejects(m.call('readaloud_delete_voice_clone', { voice_id: '../../etc' }).then((r) => { if (r.isError) throw new Error('rejected') }))
    assert.equal(backendCalls().length, 2)
  } finally { restore(); await m.close() }
})

test('text_to_speech accepts clone:<id> and speaks through the cloning service; another account\'s voice is not found; built-in voices still use the engine path', async () => {
  install()
  handler = (c) => {
    if (c.url === `${API}/${VOICE}/speech`) return new Response(new Uint8Array(WAV), { status: 200, headers: { 'Content-Type': 'audio/wav', 'X-Watermark': 'perth', 'X-Synthesis-Time-Ms': '1234' } })
    if (c.url.endsWith('/speech')) return json(404, { error: 'Cloned voice not found.', code: 'voice_not_found' })
    return undefined
  }
  const m = await connect()
  try {
    const r = await m.call('text_to_speech', { text: 'Hello in my voice', voice: `clone:${VOICE}`, speed: 1.2 })
    assert.ok(!r.isError, text(r))
    assert.equal(r.content[0]!.type, 'audio')
    assert.equal(Buffer.from(r.content[0]!.data!, 'base64').equals(WAV), true)
    assert.equal(r.structuredContent!.watermark, 'perth')
    const c = backendCalls()[0]!
    assert.deepEqual(JSON.parse(c.body as string), { text: 'Hello in my voice', speed: 1.2 })
    assert.equal(c.headers['x-gateway-uid'], UID)

    const foreign = await m.call('text_to_speech', { text: 'steal', voice: `clone:${UID}` })
    assert.equal(foreign.isError, true)
    assert.equal(foreign.structuredContent!.error.detail_code, 'voice_not_found')

    // A built-in voice does not touch the cloning backend at all (it fails here only because the engine socket is not stubbed).
    const before = backendCalls().length
    await m.call('text_to_speech', { text: 'hi', voice: 'af_heart', engine: 'studio' }).catch(() => undefined)
    assert.equal(backendCalls().length, before)
  } finally { restore(); await m.close() }
})

test('text_to_speech with a cloned voice maps a cancelled plan to payment_required', async () => {
  install()
  handler = (c) => c.url.endsWith('/speech') ? json(402, { error: 'Voice cloning requires an active paid plan with a payment method on file.', code: 'payment_required' }) : undefined
  const m = await connect()
  try {
    const r = await m.call('text_to_speech', { text: 'hi', voice: `clone:${VOICE}` })
    assert.equal(r.structuredContent!.error.code, 'payment_required')
  } finally { restore(); await m.close() }
})

// ---------------------------------------------------------------------------
// REST routes
// ---------------------------------------------------------------------------

let restSeq = 0
const restReq = (path: string, init: RequestInit & { key?: string | null } = {}) => {
  const key = init.key === undefined ? `rtts_test_key_${++restSeq}_xxxxxxxx` : init.key
  const { key: _k, ...rest } = init
  return new Request(`https://readaloudai.org/api/v1/voice-clones${path}`, { ...rest, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(rest.headers as Record<string, string> | undefined) } })
}

test('REST: no key or a malformed key is 401 and nothing is called; a revoked key is 401', async () => {
  const { handleVoiceCloneRest } = await loadRest()
  install()
  try {
    assert.equal((await handleVoiceCloneRest(restReq('/', { key: null }), { op: 'list' })).status, 401)
    assert.equal((await handleVoiceCloneRest(restReq('/', { key: 'short' }), { op: 'list' })).status, 401)
    assert.equal(calls.length, 0)
    gatewayStatus = 401
    const r = await handleVoiceCloneRest(restReq('/'), { op: 'list' })
    assert.equal(r.status, 401)
    assert.equal(((await r.json()) as { code: string }).code, 'unauthenticated')
  } finally { restore() }
})

test('REST: consent-phrase, list and config relay the backend answer; the key never reaches the backend', async () => {
  const { handleVoiceCloneRest } = await loadRest()
  install()
  handler = (c) => {
    if (c.url === `${API}/consent-phrase`) return json(201, { challenge_id: VOICE, phrase: 'phrase', expires_at: '2030-01-01T00:00:00.000Z' })
    if (c.url === `${API}/`) return json(200, { voices: [] })
    if (c.url === `${API}/config`) return json(200, { consent_required: true })
    return undefined
  }
  try {
    const key = 'rtts_secret_value_abcdef'
    const p = await handleVoiceCloneRest(restReq('/consent-phrase', { method: 'POST', key }), { op: 'phrase' })
    assert.equal(p.status, 201)
    assert.equal(((await p.json()) as { challenge_id: string }).challenge_id, VOICE)
    assert.equal((await handleVoiceCloneRest(restReq('/', { key }), { op: 'list' })).status, 200)
    assert.deepEqual(await (await handleVoiceCloneRest(restReq('/config', { key }), { op: 'config' })).json(), { consent_required: true })
    for (const c of backendCalls()) {
      assert.equal(c.headers['x-gateway-uid'], UID)
      assert.ok(!JSON.stringify(c).includes(key), 'API key must not be forwarded')
    }
  } finally { restore() }
})

test('REST: multipart create is forwarded with both recordings; the consent failure answer (422 phrase_mismatch) is relayed as is', async () => {
  const { handleVoiceCloneRest } = await loadRest()
  install()
  handler = (c) => c.url === `${API}/` && c.method === 'POST'
    ? json(422, { error: 'We could not match what you said to the phrase.', code: 'phrase_mismatch', details: { attemptsLeft: 2 } }) : undefined
  try {
    const fd = new FormData()
    fd.append('challenge_id', UID); fd.append('name', 'Me'); fd.append('language', 'en')
    fd.append('consent', new Blob([new Uint8Array(WAV)], { type: 'audio/wav' }), 'c.wav')
    fd.append('reference', new Blob([new Uint8Array(WAV)], { type: 'audio/wav' }), 'r.wav')
    const r = await handleVoiceCloneRest(restReq('/', { method: 'POST', body: fd }), { op: 'create' })
    assert.equal(r.status, 422)
    const b = (await r.json()) as { code: string; details: { attemptsLeft: number } }
    assert.equal(b.code, 'phrase_mismatch')
    assert.equal(b.details.attemptsLeft, 2)
    const sent = backendCalls()[0]!.body as FormData
    assert.equal(sent.get('challenge_id'), UID)
    assert.equal((sent.get('consent') as File).size, WAV.length)
    assert.equal((sent.get('reference') as File).size, WAV.length)

    // reference without a consent recording is still forwarded as such: the backend (strict mode) is what refuses it
    const only = new FormData(); only.append('reference', new Blob([new Uint8Array(WAV)], { type: 'audio/wav' }), 'r.wav')
    handler = () => json(400, { error: 'Both a consent recording and a reference recording are required', code: 'audio_required' })
    const r2 = await handleVoiceCloneRest(restReq('/', { method: 'POST', body: only }), { op: 'create' })
    assert.equal(r2.status, 400)
    assert.equal(((await r2.json()) as { code: string }).code, 'audio_required')
    assert.equal((backendCalls()[1]!.body as FormData).get('consent'), null)
  } finally { restore() }
})

test('REST: JSON create with base64 audio and with an https URL; bad JSON and unsupported content type are rejected locally', async () => {
  const { handleVoiceCloneRest } = await loadRest()
  install()
  handler = (c) => {
    if (c.url === 'https://8.8.8.8/consent.wav') return new Response(new Uint8Array(WAV), { status: 200 })
    if (c.url === `${API}/` && c.method === 'POST') return json(201, { id: VOICE, name: 'Me', language: 'en', status: 'active' })
    return undefined
  }
  try {
    const body = { name: 'Me', challenge_id: UID, reference_audio_base64: WAV.toString('base64'), consent_audio_url: 'https://8.8.8.8/consent.wav' }
    const r = await handleVoiceCloneRest(restReq('/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), { op: 'create' })
    assert.equal(r.status, 201)
    const sent = backendCalls()[0]!.body as FormData
    assert.equal((sent.get('consent') as File).name, 'consent.wav')
    assert.equal((sent.get('reference') as File).name, 'reference.wav')

    const bad = await handleVoiceCloneRest(restReq('/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challenge_id: 'x' }) }), { op: 'create' })
    assert.equal(bad.status, 400)
    const ssrf = await handleVoiceCloneRest(restReq('/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reference_audio_url: 'https://127.0.0.1/a.wav' }) }), { op: 'create' })
    assert.equal(ssrf.status, 400)
    assert.equal(backendCalls().length, 1, 'neither rejected request reached the backend')
    const ct = await handleVoiceCloneRest(restReq('/', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' }), { op: 'create' })
    assert.equal(ct.status, 415)
  } finally { restore() }
})

test('REST: speech returns the WAV with watermark headers; validation, ids and ownership (404) behave; free plan is 402', async () => {
  const { handleVoiceCloneRest } = await loadRest()
  install()
  handler = (c) => {
    if (c.url === `${API}/${VOICE}/speech`) return new Response(new Uint8Array(WAV), { status: 200, headers: { 'Content-Type': 'audio/wav', 'X-Watermark': 'perth', 'X-Voice-ID': VOICE } })
    if (c.url === `${API}/${UID}/speech`) return json(404, { error: 'Cloned voice not found.', code: 'voice_not_found' })
    return json(402, { error: 'Voice cloning requires an active paid plan.', code: 'payment_required' })
  }
  try {
    const post = (id: string, body: unknown, key?: string) => handleVoiceCloneRest(restReq(`/${id}/speech`, { method: 'POST', key, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), { op: 'speech', id })
    const ok = await post(VOICE, { text: 'hello', speed: 1.5 })
    assert.equal(ok.status, 200)
    assert.equal(ok.headers.get('content-type'), 'audio/wav')
    assert.equal(ok.headers.get('x-watermark'), 'perth')
    assert.equal(Buffer.from(await ok.arrayBuffer()).equals(WAV), true)
    assert.equal((await post(UID, { text: 'x' })).status, 404)
    assert.equal((await post('not-a-uuid', { text: 'x' })).status, 400)
    assert.equal((await post(VOICE, { text: '' })).status, 400)
    assert.equal((await post(VOICE, { text: 'x'.repeat(1501) })).status, 400)
    assert.equal((await post(VOICE, { text: 'x', speed: 10 })).status, 400)
    const unpaid = await handleVoiceCloneRest(restReq(`/${'33333333-3333-4333-8333-333333333333'}/speech`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x' }) }), { op: 'speech', id: '33333333-3333-4333-8333-333333333333' })
    assert.equal(unpaid.status, 402)
  } finally { restore() }
})

test('REST: delete relays the backend (200 for the owner, 404 for anyone else); a malformed id is 400 without any call', async () => {
  const { handleVoiceCloneRest } = await loadRest()
  install()
  handler = (c) => c.url === `${API}/${VOICE}` ? json(200, { deleted: true, alreadyDeleted: false }) : json(404, { error: 'Cloned voice not found.', code: 'voice_not_found' })
  try {
    const del = (id: string) => handleVoiceCloneRest(restReq(`/${id}`, { method: 'DELETE' }), { op: 'delete', id })
    assert.equal((await del(VOICE)).status, 200)
    assert.equal((await del(UID)).status, 404)
    const before = calls.length
    assert.equal((await del('../admin')).status, 400)
    assert.equal(calls.length, before)
  } finally { restore() }
})

test('REST: a backend that rejects our forwarded identity (secret mismatch) is a 401, not a leaked 5xx; per-key rate limit answers 429 with Retry-After', async () => {
  const { handleVoiceCloneRest } = await loadRest()
  install()
  handler = () => json(401, { error: 'Invalid or missing API key.', code: 'unauthenticated' })
  try {
    const key = 'rtts_ratelimit_key_value_1'
    assert.equal((await handleVoiceCloneRest(restReq('/consent-phrase', { method: 'POST', key }), { op: 'phrase' })).status, 401)
    let last = 0
    for (let i = 0; i < 8; i++) {
      const r = await handleVoiceCloneRest(restReq('/consent-phrase', { method: 'POST', key }), { op: 'phrase' })
      last = r.status
      if (r.status === 429) { assert.ok(r.headers.get('retry-after')); assert.equal(((await r.json()) as { code: string }).code, 'rate_limited'); break }
    }
    assert.equal(last, 429)
  } finally { restore() }
})

test('REST: a gateway-side payment_required (no free characters, no plan) maps to 402', async () => {
  const { handleVoiceCloneRest } = await loadRest()
  install()
  gatewayStatus = 402
  try {
    const r = await handleVoiceCloneRest(restReq('/'), { op: 'list' })
    assert.equal(r.status, 402)
    assert.equal(((await r.json()) as { code: string }).code, 'payment_required')
  } finally { restore() }
})
