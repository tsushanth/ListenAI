// Headless OAuth integration test. Usage (from web/):  node test/oauth-integration.mjs
// Starts `next dev` on a local port with a TEST secret, OAUTH_TEST_MODE=1 (mock user verification and mock
// backend key issuing; refused when NODE_ENV=production) and a mock TTS gateway. MOCKED: Supabase user
// verification, backend key create/list/revoke, and the TTS gateway /tts/authorize. REAL: everything else.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const PORT = 3197, GW_PORT = 3198
const BASE = `http://localhost:${PORT}`
const ok = (m) => console.log('PASS', m)
const revokedIds = new Set()
const gw = createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    const { key = '' } = JSON.parse(b || '{}')
    const id = /^ra_test_(k\d+)_/.exec(key)?.[1]
    if (!id || revokedIds.has(id)) { res.writeHead(401).end('{}'); return }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ token: 't', url: 'ws://127.0.0.1:9/x' }))
  })
}).listen(GW_PORT)

const srv = spawn('npx', ['next', 'dev', '-p', String(PORT)], {
  env: { ...process.env, NODE_ENV: 'development', OAUTH_SIGNING_SECRET: randomBytes(48).toString('base64'), OAUTH_TEST_MODE: '1', OAUTH_PUBLIC_BASE_URL: BASE, TTS_GATEWAY_URL: `http://127.0.0.1:${GW_PORT}` },
  stdio: 'ignore',
})
const cleanup = () => { srv.kill('SIGTERM'); gw.close() }
process.on('exit', cleanup)
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/.well-known/oauth-authorization-server`)).ok) break } catch {} await new Promise((r) => setTimeout(r, 1000)) }

try {
  const j = async (path, init) => { const r = await fetch(BASE + path, { redirect: 'manual', ...init }); return r }
  const form = (o) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o) })
  const RU = 'https://claude.ai/api/mcp/auth_callback'

  // discovery
  const prm = await (await j('/.well-known/oauth-protected-resource/mcp')).json()
  assert.equal(prm.resource, `${BASE}/mcp`); assert.deepEqual(prm.authorization_servers, [BASE]); ok('protected resource metadata (path-suffixed)')
  assert.equal((await (await j('/.well-known/oauth-protected-resource')).json()).resource, `${BASE}/mcp`); ok('protected resource metadata (root)')
  const as = await (await j('/.well-known/oauth-authorization-server')).json()
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']); assert.deepEqual(as.token_endpoint_auth_methods_supported, ['none']); ok('authorization server metadata')

  // 401 challenge
  let r = await j('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' })
  assert.equal(r.status, 401); assert.match(r.headers.get('www-authenticate'), /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource\/mcp"/)
  assert.match(r.headers.get('access-control-expose-headers'), /WWW-Authenticate/); ok('no token -> 401 + resource_metadata + CORS expose')

  // register
  r = await j('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: [RU], token_endpoint_auth_method: 'none' }) })
  assert.equal(r.status, 201); const reg = await r.json(); assert.ok(reg.client_id && !reg.client_secret); ok('DCR')
  r = await j('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://evil.com/cb'] }) })
  assert.equal(r.status, 400); assert.equal((await r.json()).error, 'invalid_redirect_uri'); ok('DCR rejects http non-loopback')

  // authorize
  const verifier = randomBytes(32).toString('base64url'), challenge = createHash('sha256').update(verifier).digest('base64url')
  const q = new URLSearchParams({ client_id: reg.client_id, redirect_uri: RU, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'st8', resource: `${BASE}/mcp` })
  r = await j('/oauth/authorize?' + q)
  assert.equal(r.status, 302); const loc = new URL(r.headers.get('location'))
  assert.equal(loc.pathname, '/oauth/consent'); assert.equal(loc.searchParams.get('state'), 'st8'); ok('authorize -> consent redirect')
  for (const bad of [{ redirect_uri: 'https://evil.com/cb' }, { code_challenge_method: 'plain' }]) {
    r = await j('/oauth/authorize?' + new URLSearchParams({ ...Object.fromEntries(q), ...bad }))
    assert.equal(r.status, 400); assert.equal(r.headers.get('location'), null); assert.equal(r.headers.get('x-frame-options'), 'DENY')
  }
  ok('authorize errors render a page, never redirect')
  const consent = await j('/oauth/consent?' + loc.searchParams)
  assert.equal(consent.status, 200); assert.equal(consent.headers.get('x-frame-options'), 'DENY'); assert.match(consent.headers.get('content-security-policy'), /frame-ancestors 'none'/); ok('consent page renders with anti-framing headers')

  // approve (MOCKED user + key issuing)
  const approveReq = (tok, params) => j('/oauth/approve', { method: 'POST', headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: JSON.stringify({ params }) })
  assert.equal((await approveReq(null, q.toString())).status, 401)
  assert.equal((await approveReq('not-a-user-token', q.toString())).status, 401); ok('approve requires a valid user token header')
  r = await approveReq('test-user:alice', q.toString()); assert.equal(r.status, 200)
  const cb = new URL((await r.json()).redirect_url); assert.equal(cb.origin + cb.pathname, RU); assert.equal(cb.searchParams.get('state'), 'st8')
  const code = cb.searchParams.get('code'); ok('approve -> code redirect to registered URI')

  // token
  const tokReq = (o) => j('/oauth/token', form(o))
  const base = { grant_type: 'authorization_code', code, client_id: reg.client_id, redirect_uri: RU, code_verifier: verifier }
  r = await tokReq({ ...base, code_verifier: randomBytes(32).toString('base64url') }); assert.equal((await r.json()).error, 'invalid_grant'); ok('wrong verifier rejected')
  r = await tokReq({ ...base, redirect_uri: 'https://claude.ai/other' }); assert.equal((await r.json()).error, 'invalid_grant'); ok('wrong redirect_uri rejected')
  r = await tokReq(base); assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store'); assert.equal(r.headers.get('access-control-allow-origin'), '*')
  const tok = await r.json(); assert.equal(tok.token_type, 'Bearer'); assert.equal(tok.expires_in, 3600); ok('code exchange (form)')
  r = await j('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...base, code: 'x' }) }); assert.equal((await r.json()).error, 'invalid_grant'); ok('JSON body accepted')

  // /mcp with the OAuth access token via the SDK client
  const client = new Client({ name: 'oauth-test', version: '0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tok.access_token}` } } }))
  const tools = await client.listTools(); assert.ok(tools.tools.some((t) => t.name === 'text_to_speech')); await client.close(); ok('tools/list with OAuth access token')

  // refresh
  r = await tokReq({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: reg.client_id }); assert.equal(r.status, 200)
  const tok2 = await r.json(); assert.notEqual(tok2.access_token, tok.access_token); ok('refresh')
  r = await tokReq({ grant_type: 'refresh_token', refresh_token: tok.access_token }); assert.equal((await r.json()).error, 'invalid_grant'); ok('access token is not a refresh token')

  // bad tokens
  for (const bad of ['raa1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', tok.access_token.slice(0, -3) + 'AAA', tok.refresh_token]) {
    r = await j('/mcp', { method: 'POST', headers: { authorization: `Bearer ${bad}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' })
    assert.equal(r.status, 401); assert.match(r.headers.get('www-authenticate'), /error="invalid_token"/); assert.match(r.headers.get('www-authenticate'), /resource_metadata=/)
  }
  ok('bad/tampered/wrong-type token -> 401 + WWW-Authenticate')

  // revocation: gateway now rejects the key (as after revoking it in the console)
  revokedIds.add('k1')
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }
  r = await j('/mcp', { method: 'POST', headers: { authorization: `Bearer ${tok2.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(init) })
  assert.equal(r.status, 401); assert.match((await r.json()).error.message, /Reconnect/); ok('revoked connector key -> 401 asking to reconnect')
  r = await tokReq({ grant_type: 'refresh_token', refresh_token: tok2.refresh_token }); assert.equal((await r.json()).error, 'invalid_grant'); ok('refresh after revocation -> invalid_grant')
  revokedIds.clear()

  // API-key path unchanged
  r = await j('/mcp', { method: 'POST', headers: { authorization: 'Bearer ra_test_k99_' + 'x'.repeat(20), 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(init) })
  assert.equal(r.status, 200); ok('plain API key still works')
  r = await j('/mcp', { method: 'POST', headers: { authorization: 'Bearer definitely-not-a-key', 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(init) })
  assert.equal(r.status, 401); ok('bad API key -> 401')

  // SDK built-in OAuth client provider flow
  let saved, authUrl, verifierSaved, clientInfo
  const provider = {
    get redirectUrl() { return 'http://127.0.0.1:38999/callback' },
    get clientMetadata() { return { client_name: 'SDK Test', redirect_uris: ['http://127.0.0.1:38999/callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] } },
    clientInformation: () => clientInfo, saveClientInformation: (i) => { clientInfo = i },
    tokens: () => saved, saveTokens: (t) => { saved = t },
    redirectToAuthorization: (u) => { authUrl = u }, saveCodeVerifier: (v) => { verifierSaved = v }, codeVerifier: () => verifierSaved,
  }
  const t1 = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { authProvider: provider })
  const c1 = new Client({ name: 'sdk', version: '0' })
  await assert.rejects(() => c1.connect(t1), /Unauthorized/i)
  assert.ok(authUrl, 'SDK discovered metadata, registered, and produced an authorization URL')
  const a = await j(authUrl.pathname.replace(/^/, '') + authUrl.search); assert.equal(a.status, 302)
  const ap = await approveReq('test-user:bob', new URL(a.headers.get('location')).searchParams.toString()); assert.equal(ap.status, 200)
  const code2 = new URL((await ap.json()).redirect_url).searchParams.get('code')
  await t1.finishAuth(code2)
  const t2 = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { authProvider: provider })
  const c2 = new Client({ name: 'sdk', version: '0' }); await c2.connect(t2)
  assert.ok((await c2.listTools()).tools.length >= 3); await c2.close(); ok('SDK OAuthClientProvider flow: discovery, DCR, PKCE, token, tools/list')
  console.log('ALL PASS')
} catch (e) { console.error('FAIL', e); process.exitCode = 1 } finally { cleanup(); setTimeout(() => process.exit(process.exitCode || 0), 200) }
