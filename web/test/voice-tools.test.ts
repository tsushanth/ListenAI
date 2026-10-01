import { test } from 'node:test'
import assert from 'node:assert/strict'

// gatewayIdentityHeaders reads this at module load, so set it before importing anything from lib/mcp.
process.env.MCP_GATEWAY_FORWARD_SECRET = 'test-forward-secret'
process.env.NEXT_PUBLIC_API_URL = 'https://backend.test'
process.env.TTS_GATEWAY_URL = 'https://gateway.test'

const vt = await import('../src/lib/mcp/voiceTools.ts')
const { createMcpServer } = await import('../src/lib/mcp/server.ts')
const { UpstreamError } = await import('../src/lib/mcp/upstream.ts')

const realFetch = globalThis.fetch
interface Call { url: string; method: string; headers: Record<string, string>; body?: unknown }
let calls: Call[] = []
let handler: (c: Call) => Response | undefined = () => undefined

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function install() {
  calls = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v })
    const call: Call = { url, method: (init?.method || 'GET').toUpperCase(), headers, body: init?.body }
    calls.push(call)
    if (url === 'https://gateway.test/tts/authorize') return json(200, { token: 'e30.sig', url: 'wss://gateway.test/ws' })
    return handler(call) ?? json(500, { error: `unhandled ${call.method} ${url}` })
  }) as typeof fetch
}
function restore() { globalThis.fetch = realFetch }

const ctx = { apiKey: 'sk_test_key_12345', keyId: 'abcd1234abcd1234' }
const CONSENT = 'I am authorized to consent on behalf of the speaker named in this request, and that speaker has agreed to have their voice cloned and used to synthesize new speech through this service.'

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

test('design_voice schema enforces description/text bounds', () => {
  assert.ok(vt.designVoiceSchema.parse({ description: 'A warm narrator voice', text: 'hi' }))
  assert.throws(() => vt.designVoiceSchema.parse({ description: 'short', text: 'hi' }))
  assert.throws(() => vt.designVoiceSchema.parse({ description: 'A warm narrator voice', text: '' }))
  assert.throws(() => vt.designVoiceSchema.parse({ description: 'x'.repeat(801), text: 'hi' }))
  assert.throws(() => vt.designVoiceSchema.parse({ description: 'A warm narrator voice', text: 'x'.repeat(501) }))
})

test('convert_voice schema requires confirms_rights literally true and a known MIME type', () => {
  const ok = { source_audio_base64: 'QUJD', target_audio_base64: 'QUJD', confirms_rights: true }
  assert.equal(vt.convertVoiceSchema.parse(ok).source_mime_type, 'audio/wav')
  assert.throws(() => vt.convertVoiceSchema.parse({ ...ok, confirms_rights: false }))
  assert.throws(() => vt.convertVoiceSchema.parse({ source_audio_base64: 'QUJD', target_audio_base64: 'QUJD' }))
  assert.throws(() => vt.convertVoiceSchema.parse({ ...ok, source_mime_type: 'image/png' }))
})

test('voice clone schemas: consent, id format, charge confirmation', () => {
  const base = { speaker_name: 'Jane Doe', attested_by: 'Jane Doe', consent_statement: CONSENT }
  assert.ok(vt.createVoiceCloneSchema.parse({ ...base, consent: true }))
  assert.throws(() => vt.createVoiceCloneSchema.parse({ ...base, consent: false }))
  assert.throws(() => vt.createVoiceCloneSchema.parse({ ...base, consent: true, speaker_name: 'J' }))
  assert.ok(vt.voiceCloneIdSchema.parse({ voice_id: 'v-a1b2c3d4e5' }))
  assert.throws(() => vt.voiceCloneIdSchema.parse({ voice_id: '../../etc' }))
  assert.throws(() => vt.voiceCloneIdSchema.parse({ voice_id: 'v-XYZ' }))
  assert.ok(vt.commitVoiceCloneDatasetSchema.parse({ voice_id: 'v-a1b2c3d4e5', confirms_charge: true }))
  assert.throws(() => vt.commitVoiceCloneDatasetSchema.parse({ voice_id: 'v-a1b2c3d4e5' }))
  assert.throws(() => vt.commitVoiceCloneDatasetSchema.parse({ voice_id: 'v-a1b2c3d4e5', confirms_charge: false }))
})

// ---------------------------------------------------------------------------
// SSRF guard + zip sniffing
// ---------------------------------------------------------------------------

test('isPrivateAddress blocks internal ranges and allows public ones', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', 'not-an-ip']) {
    assert.equal(vt.isPrivateAddress(ip), true, ip)
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111']) {
    assert.equal(vt.isPrivateAddress(ip), false, ip)
  }
})

test('downloadZip refuses http, credentials and literal private IPs before any request', async () => {
  install()
  try {
    await assert.rejects(vt.downloadZip('http://example.com/a.zip'), /https/)
    await assert.rejects(vt.downloadZip('https://user:pw@example.com/a.zip'), /credentials/)
    await assert.rejects(vt.downloadZip('https://127.0.0.1/a.zip'), /public host/)
    await assert.rejects(vt.downloadZip('https://169.254.169.254/latest/meta-data'), /public host/)
    await assert.rejects(vt.downloadZip('https://[::1]/a.zip'), /public host/)
    assert.equal(calls.length, 0)
  } finally { restore() }
})

test('looksLikeZip checks the magic bytes', () => {
  assert.equal(vt.looksLikeZip(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0])), true)
  assert.equal(vt.looksLikeZip(Buffer.from('RIFF....WAVE')), false)
  assert.equal(vt.looksLikeZip(Buffer.alloc(2)), false)
})

// ---------------------------------------------------------------------------
// Voice design / conversion clients (backend, gateway-forwarded identity)
// ---------------------------------------------------------------------------

test('submitVoiceDesign forwards the gateway identity headers, never the raw API key', async () => {
  install()
  handler = (c) => c.url === 'https://backend.test/api/voice-design/designs' ? json(201, { job_id: 'j1', status: 'queued' }) : undefined
  try {
    const r = await vt.submitVoiceDesign({ ...ctx, description: 'A warm narrator voice', text: 'hello' })
    assert.deepEqual(r, { job_id: 'j1', status: 'queued' })
    const post = calls.find((c) => c.url.endsWith('/api/voice-design/designs'))!
    assert.equal(post.headers['x-gateway-admin-secret'], 'test-forward-secret')
    assert.equal(post.headers['x-gateway-key-id'], ctx.keyId)
    assert.equal(post.headers['authorization'], undefined)
    assert.equal(JSON.stringify(post.headers).includes(ctx.apiKey), false)
  } finally { restore() }
})

test('backend status codes map onto the shared ErrorCode scheme', async () => {
  install()
  try {
    const cases: Array<[number, string, boolean]> = [[401, 'unauthorized', false], [402, 'payment_required', false], [429, 'rate_limited', true], [400, 'invalid_input', false], [503, 'upstream', true]]
    for (const [status, code, retryable] of cases) {
      handler = (c) => c.url.includes('/api/voice-design/designs') ? json(status, { error: 'nope' }) : undefined
      await assert.rejects(
        vt.submitVoiceDesign({ ...ctx, description: 'A warm narrator voice', text: 'hello' }),
        (e: unknown) => e instanceof UpstreamError && e.code === code && e.retryable === retryable,
        `status ${status}`,
      )
    }
  } finally { restore() }
})

const dm = await import('../src/lib/mcp/deployments.ts')
const up = await import('../src/lib/mcp/upstream.ts')

function isDeployRequired(service: string) {
  return (e: unknown) => e instanceof UpstreamError && e.code === 'invalid_input' && e.retryable === false &&
    new RegExp(`service "${service}" and action "deploy"`).test(e.message)
}

test('convert_voice without a deployment tells the caller to deploy explicitly and never starts one', async () => {
  install()
  handler = (c) => c.url.endsWith('/conversions') ? json(400, { error: 'not configured', code: 'deployment_required' }) : undefined
  try {
    await assert.rejects(
      vt.submitVoiceConversion({ ...ctx, source: Buffer.from('a'), sourceMime: 'audio/wav', target: Buffer.from('b'), targetMime: 'audio/wav' }),
      isDeployRequired('convert'),
    )
    assert.equal(calls.some((c) => c.url.endsWith('/deploy')), false)
  } finally { restore() }
})

test('isolate, dub and sound effects also report deployment_required without deploying', async () => {
  install()
  handler = () => json(400, { error: 'x', code: 'deployment_required' })
  try {
    await assert.rejects(up.isolateVoice({ apiKey: ctx.apiKey, keyId: ctx.keyId, buffer: Buffer.from('a'), mimeType: 'audio/wav', wantInstrumental: false, timeoutMs: 5000 }), isDeployRequired('isolate'))
    await assert.rejects(up.submitDub({ key: ctx.apiKey, keyId: ctx.keyId, audioBase64: 'QUJD', filename: 'a.wav', targetLanguage: 'es' }), isDeployRequired('dub'))
    await assert.rejects(up.submitSoundEffectJob({ 'x-gateway-admin-secret': 's', 'x-gateway-key-id': 'k' }, 'rain', 3), isDeployRequired('sound_effect'))
    assert.equal(calls.some((c) => c.url.endsWith('/deploy')), false)
  } finally { restore() }
})

test('a 400 without deployment_required stays a plain invalid_input', async () => {
  install()
  handler = () => json(400, { error: 'bad audio' })
  try {
    await assert.rejects(up.submitDub({ key: ctx.apiKey, keyId: ctx.keyId, audioBase64: 'QUJD', filename: 'a.wav', targetLanguage: 'es' }),
      (e: unknown) => e instanceof UpstreamError && e.code === 'invalid_input' && /bad audio/.test(e.message))
  } finally { restore() }
})

const H = { 'x-gateway-admin-secret': 's', 'x-gateway-key-id': 'k' }
const DEPLOY_PATHS: Record<string, string> = {
  convert: '/api/voice-convert/deploy', isolate: '/api/voice-isolate/deploy', sound_effect: '/api/sound-effects/deploy', dub: '/api/dub/deploy',
}

test('manage_deployment hits each service path and hides the Modal app name and url', async () => {
  for (const [service, path] of Object.entries(DEPLOY_PATHS)) {
    install()
    handler = () => json(202, { status: 'deploying', app_name: 'secret-app', modal_url: 'https://modal.test/x' })
    try {
      const r = await dm.manageDeployment(service as 'convert', 'deploy', H)
      assert.equal(calls[0].url, `https://backend.test${path}`)
      assert.equal(calls[0].method, 'POST')
      assert.equal(calls[0].headers['x-gateway-key-id'], 'k')
      assert.equal(r.data.status, 'deploying')
      assert.equal(JSON.stringify(r).includes('secret-app'), false)
      assert.equal(JSON.stringify(r).includes('modal.test'), false)
    } finally { restore() }
  }
})

test('manage_deployment status: none, ready with auto-teardown, and teardown', async () => {
  install()
  handler = () => json(404, { error: 'No deployment found.' })
  try { assert.equal((await dm.manageDeployment('dub', 'status', H)).data.status, 'none') } finally { restore() }

  install()
  handler = () => json(200, { status: 'ready', seconds_until_auto_teardown: 600 })
  try {
    const r = await dm.manageDeployment('dub', 'status', H)
    assert.equal(r.data.status, 'ready')
    assert.match(r.text, /10 min/)
  } finally { restore() }

  install()
  handler = (c) => c.method === 'DELETE' ? json(200, { deleted: true, status: 'stopped', message: 'torn down' }) : undefined
  try {
    const r = await dm.manageDeployment('dub', 'teardown', H)
    assert.equal(calls[0].method, 'DELETE')
    assert.equal(r.data.status, 'stopped')
  } finally { restore() }
})

test('manage_deployment deploy: existing live deployment is reported, failed one is cleared and redeployed once', async () => {
  install()
  handler = () => json(409, { deployment: { status: 'ready' } })
  try {
    const r = await dm.manageDeployment('isolate', 'deploy', H)
    assert.equal(r.data.status, 'ready')
    assert.equal(calls.length, 1)
  } finally { restore() }

  install()
  let posts = 0
  handler = (c) => {
    if (c.method === 'POST') { posts++; return posts === 1 ? json(409, { deployment: { status: 'failed' } }) : json(202, { status: 'deploying' }) }
    return json(200, { deleted: true })
  }
  try {
    const r = await dm.manageDeployment('isolate', 'deploy', H)
    assert.deepEqual(calls.map((c) => c.method), ['POST', 'DELETE', 'POST'])
    assert.equal(r.data.status, 'deploying')
  } finally { restore() }
})

test('manage_deployment maps refusals to error codes', async () => {
  const cases: Array<[number, string]> = [[402, 'payment_required'], [403, 'unauthorized'], [429, 'rate_limited'], [503, 'capacity'], [401, 'unauthorized']]
  for (const [status, code] of cases) {
    install()
    handler = () => json(status, { error: 'nope', code: 'x' })
    try {
      await assert.rejects(dm.manageDeployment('convert', 'deploy', H), (e: unknown) => e instanceof UpstreamError && e.code === code, `status ${status}`)
    } finally { restore() }
  }
})

test('convert_voice: a normal submit returns the job', async () => {
  install()
  handler = (c) => c.url.endsWith('/conversions') ? json(202, { job_id: 'c1', status: 'queued' }) : undefined
  try {
    const r = await vt.submitVoiceConversion({ ...ctx, source: Buffer.from('a'), sourceMime: 'audio/wav', target: Buffer.from('b'), targetMime: 'audio/wav' })
    assert.deepEqual(r, { job_id: 'c1', status: 'queued' })
    assert.equal(calls.some((c) => c.url.endsWith('/deploy')), false)
  } finally { restore() }
})

// ---------------------------------------------------------------------------
// Cloning client (gateway /v1/voices, raw key as bearer)
// ---------------------------------------------------------------------------

test('createVoiceClone rejects a wrong consent wording locally with the current text, before creating anything', async () => {
  install()
  handler = (c) => c.url.endsWith('/v1/voices/enabled') ? json(200, { enabled: true, consent_text_version: '2026-09-v1', consent_statement: CONSENT }) : undefined
  try {
    await assert.rejects(
      vt.createVoiceClone({ apiKey: ctx.apiKey, speakerName: 'Jane Doe', attestedBy: 'Jane Doe', consentStatement: 'I consent.' }),
      (e: unknown) => e instanceof UpstreamError && e.code === 'invalid_input' && e.message.includes(CONSENT),
    )
    assert.equal(calls.some((c) => c.method === 'POST'), false)
  } finally { restore() }
})

test('createVoiceClone posts the consent record with the service-provided version', async () => {
  install()
  handler = (c) => {
    if (c.url.endsWith('/v1/voices/enabled')) return json(200, { consent_text_version: '2026-09-v1', consent_statement: CONSENT })
    if (c.url.endsWith('/v1/voices') && c.method === 'POST') return json(201, { id: 'v-a1b2c3d4e5' })
    return undefined
  }
  try {
    const r = await vt.createVoiceClone({ apiKey: ctx.apiKey, speakerName: 'Jane Doe', attestedBy: 'Jane Doe', consentStatement: CONSENT })
    assert.equal(r.id, 'v-a1b2c3d4e5')
    const post = calls.find((c) => c.method === 'POST')!
    assert.equal(post.headers['authorization'], `Bearer ${ctx.apiKey}`)
    assert.deepEqual(JSON.parse(String(post.body)), {
      speaker_name: 'Jane Doe', attested_by: 'Jane Doe', consent: true, consent_text_version: '2026-09-v1', consent_statement: CONSENT,
    })
  } finally { restore() }
})

test('uploadVoiceCloneDataset splits into 8 MB parts', async () => {
  install()
  handler = (c) => c.method === 'PUT' ? json(200, { ok: true }) : undefined
  try {
    const zip = Buffer.alloc(vt.CLONE_PART_BYTES * 2 + 10)
    const r = await vt.uploadVoiceCloneDataset({ apiKey: ctx.apiKey, voiceId: 'v-a1b2c3d4e5', zip })
    assert.deepEqual(r, { parts: 3, bytes: zip.length })
    assert.deepEqual(calls.map((c) => c.url.split('/').pop()), ['0', '1', '2'])
  } finally { restore() }
})

test('commitVoiceCloneDataset derives the part count from the service and refuses gaps or empty uploads', async () => {
  install()
  let parts: Array<{ part: number }> = [{ part: 0 }, { part: 1 }]
  handler = (c) => {
    if (c.url.endsWith('/dataset/parts')) return json(200, { parts })
    if (c.url.endsWith('/dataset/commit')) return json(202, { id: 'v-a1b2c3d4e5', status: 'training', clips: 42 })
    return undefined
  }
  try {
    const r = await vt.commitVoiceCloneDataset({ apiKey: ctx.apiKey, voiceId: 'v-a1b2c3d4e5' })
    assert.deepEqual(r, { id: 'v-a1b2c3d4e5', status: 'training', clips: 42, parts: 2 })
    assert.deepEqual(JSON.parse(String(calls.find((c) => c.url.endsWith('/commit'))!.body)), { parts: 2 })

    parts = []
    await assert.rejects(vt.commitVoiceCloneDataset({ apiKey: ctx.apiKey, voiceId: 'v-a1b2c3d4e5' }), /upload_voice_clone_dataset first/)
    parts = [{ part: 0 }, { part: 2 }]
    await assert.rejects(vt.commitVoiceCloneDataset({ apiKey: ctx.apiKey, voiceId: 'v-a1b2c3d4e5' }), /part 1 is missing/)
  } finally { restore() }
})

test('clone client maps 404 to invalid_input and 402 to payment_required', async () => {
  install()
  try {
    handler = () => json(404, { error: 'Voice not found.' })
    await assert.rejects(vt.getVoiceCloneStatus({ apiKey: ctx.apiKey, voiceId: 'v-a1b2c3d4e5' }), (e: unknown) => e instanceof UpstreamError && e.code === 'invalid_input')
    handler = () => json(402, { error: 'Voice cloning requires a billing-enabled API key' })
    await assert.rejects(vt.deleteVoiceClone({ apiKey: ctx.apiKey, voiceId: 'v-a1b2c3d4e5' }), (e: unknown) => e instanceof UpstreamError && e.code === 'payment_required')
  } finally { restore() }
})

// ---------------------------------------------------------------------------
// Server registration
// ---------------------------------------------------------------------------

test('all new tools are registered with correct read/destructive annotations', async () => {
  const server = createMcpServer({ apiKey: ctx.apiKey, keyId: ctx.keyId }) as unknown as {
    _registeredTools: Record<string, { annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }>
  }
  const tools = server._registeredTools
  const expected: Record<string, { readOnly: boolean; destructive: boolean }> = {
    design_voice: { readOnly: false, destructive: false },
    get_voice_design: { readOnly: true, destructive: false },
    convert_voice: { readOnly: false, destructive: false },
    manage_deployment: { readOnly: false, destructive: false },
    get_voice_conversion: { readOnly: true, destructive: false },
    create_voice_clone: { readOnly: false, destructive: false },
    upload_voice_clone_dataset: { readOnly: false, destructive: false },
    commit_voice_clone_dataset: { readOnly: false, destructive: false },
    get_voice_clone_status: { readOnly: true, destructive: false },
    deploy_voice_clone: { readOnly: false, destructive: false },
    delete_voice_clone: { readOnly: false, destructive: true },
  }
  for (const [name, want] of Object.entries(expected)) {
    const t = tools[name]
    assert.ok(t, `${name} registered`)
    assert.equal(t.annotations?.readOnlyHint, want.readOnly, `${name} readOnlyHint`)
    assert.equal(t.annotations?.destructiveHint, want.destructive, `${name} destructiveHint`)
  }
})
