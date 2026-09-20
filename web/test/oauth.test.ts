import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, createHash } from 'node:crypto'

process.env.OAUTH_SIGNING_SECRET = randomBytes(48).toString('base64')
process.env.OAUTH_PUBLIC_BASE_URL = 'https://readaloudai.org'

const { verifyPkce, pkceS256, seal, open, oauthConfigured } = await import('../src/lib/oauth/crypto.ts')
const { redirectUriProblem, validateRegistration } = await import('../src/lib/oauth/redirect.ts')
const T = await import('../src/lib/oauth/tokens.ts')
const { validateAuthorize } = await import('../src/lib/oauth/authorize.ts')
const { approve, ApproveError } = await import('../src/lib/oauth/approve.ts')

const verifier = randomBytes(32).toString('base64url')
const challenge = pkceS256(verifier)
const RU = 'https://claude.ai/api/mcp/auth_callback'
const clientId = T.mintClientId({ redirect_uris: [RU, 'http://127.0.0.1:33333/cb'], client_name: 'Claude' })

test('PKCE: S256 verifies, wrong verifier / plain / malformed rejected', () => {
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'))
  assert.ok(verifyPkce(verifier, challenge))
  assert.equal(verifyPkce(randomBytes(32).toString('base64url'), challenge), false)
  assert.equal(verifyPkce(verifier, verifier, 'plain'), false)
  assert.equal(verifyPkce('short', 'short'), false)
  assert.equal(verifyPkce(verifier, ''), false)
})

test('redirect URI validation', () => {
  for (const ok of [RU, 'http://localhost:8080/cb', 'http://127.0.0.1:1/x', 'cursor://anysphere.cursor-retrieval/oauth/x', 'vscode://a/b']) assert.equal(redirectUriProblem(ok), null, ok)
  for (const bad of [
    'http://evil.com/cb', 'https://claude.ai/cb#frag', 'https://*.claude.ai/cb', 'https://claude.ai/*', 'javascript:alert(1)', 'data:text/html,x',
    'file:///etc/passwd', 'https://user:pw@claude.ai/cb', 'https://claude.ai/cb b', '/relative', '', 'https://claude.ai\\@evil.com', 'myapp://x', 'http://localhost.evil.com/cb',
    'http://127.0.0.1.evil.com/', 'https://' + 'a'.repeat(400),
  ]) assert.notEqual(redirectUriProblem(bad), null, bad)
  assert.notEqual(redirectUriProblem(42), null)
})

test('DCR validation', () => {
  const ok = validateRegistration({ redirect_uris: [RU], client_name: '<b>Claude</b>\n', token_endpoint_auth_method: 'none' })
  assert.ok(ok.ok && ok.meta.client_name === 'bClaude/b')
  for (const b of [null, [], {}, { redirect_uris: [] }, { redirect_uris: 'x' }, { redirect_uris: ['http://evil.com'] }, { redirect_uris: [RU], token_endpoint_auth_method: 'client_secret_basic' },
    { redirect_uris: [RU], grant_types: ['implicit'] }, { redirect_uris: [RU], response_types: ['token'] }, { redirect_uris: Array(6).fill(RU).map((u, i) => u + i) }, { redirect_uris: [RU], client_name: 5 }]) {
    assert.equal(validateRegistration(b).ok, false, JSON.stringify(b))
  }
  const long = validateRegistration({ redirect_uris: [RU], client_name: 'x'.repeat(500) })
  assert.ok(long.ok && long.meta.client_name.length === 80)
})

test('client_id: verifies, tampering fails, other secret fails', () => {
  assert.equal(T.readClientId(clientId)?.client_name, 'Claude')
  const [p, body, mac] = clientId.split('.')
  const forged = Buffer.from(JSON.stringify({ u: ['https://evil.com/cb'], n: 'Claude', iat: 1 })).toString('base64url')
  assert.equal(T.readClientId(`${p}.${forged}.${mac}`), null)
  assert.equal(T.readClientId(`${p}.${body}.${mac.slice(0, -2)}AA`), null)
  assert.equal(T.readClientId('garbage'), null)
})

test('authorize validation: exact redirect match, S256 required, resource, no open redirect', () => {
  const base = { client_id: clientId, redirect_uri: RU, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 's1' }
  const q = (o: Record<string, string | undefined>) => new URLSearchParams(Object.entries({ ...base, ...o }).filter(([, v]) => v !== undefined) as [string, string][])
  assert.ok(validateAuthorize(q({})).ok)
  assert.ok(validateAuthorize(q({ resource: 'https://readaloudai.org/mcp' })).ok)
  for (const o of [
    { redirect_uri: 'https://evil.com/cb' }, { redirect_uri: RU + '/' }, { redirect_uri: RU + '?x=1' }, { redirect_uri: 'https://claude.ai.evil.com/api/mcp/auth_callback' },
    { code_challenge_method: 'plain' }, { code_challenge_method: undefined }, { code_challenge: undefined }, { code_challenge: 'short' },
    { response_type: 'token' }, { client_id: 'nope' }, { resource: 'https://other.example/mcp' },
  ]) assert.equal(validateAuthorize(q(o as Record<string, string | undefined>)).ok, false, JSON.stringify(o))
})

const mkCode = (now?: number) => T.mintCode({ sub: 'u1', clientId, redirectUri: RU, codeChallenge: challenge, resource: 'https://readaloudai.org/mcp', apiKey: 'ra_secretkey_123456' }, now)
const good = { clientId, redirectUri: RU, verifier }

test('code: redeems; wrong verifier / redirect / client / resource / expiry / tamper / type-confusion fail', () => {
  const c = T.redeemCode(mkCode(), good)
  assert.ok(!T.isGrantError(c) && c.sub === 'u1' && c.k === 'ra_secretkey_123456')
  const err = (r: unknown) => T.isGrantError(r as never)
  assert.ok(err(T.redeemCode(mkCode(), { ...good, verifier: randomBytes(32).toString('base64url') })))
  assert.ok(err(T.redeemCode(mkCode(), { ...good, redirectUri: 'http://127.0.0.1:33333/cb' })))
  assert.ok(err(T.redeemCode(mkCode(), { ...good, clientId: T.mintClientId({ redirect_uris: [RU], client_name: 'Other' }) })))
  assert.ok(err(T.redeemCode(mkCode(), { ...good, resource: 'https://other.example/mcp' })))
  assert.ok(err(T.redeemCode(mkCode(1000), good)), 'expired (minted in 1970)')
  const code = mkCode()
  assert.ok(err(T.redeemCode(code.slice(0, -3) + (code.endsWith('AAA') ? 'BBB' : 'AAA'), good)))
  assert.ok(err(T.redeemCode(T.issueTokenPair({ sub: 'u1', cidHash: 'x', apiKey: 'k' }).access_token, good)))
  assert.ok(!code.includes('ra_secretkey'), 'key not visible in code')
})

test('access/refresh tokens: verify, expiry, audience, tamper, type confusion, key hidden', () => {
  const pair = T.issueTokenPair({ sub: 'u1', cidHash: 'abc', apiKey: 'ra_secretkey_123456' })
  assert.equal(pair.token_type, 'Bearer'); assert.equal(pair.expires_in, 3600)
  assert.ok(T.looksLikeOAuthToken(pair.access_token) && !T.looksLikeOAuthToken(pair.refresh_token))
  const v = T.verifyAccessToken(pair.access_token)
  assert.ok(v.ok && v.apiKey === 'ra_secretkey_123456' && v.sub === 'u1')
  assert.ok(!Buffer.from(pair.access_token.split('.')[1], 'base64url').toString('latin1').includes('ra_secretkey'))
  const now = Math.floor(Date.now() / 1000)
  assert.deepEqual(T.verifyAccessToken(pair.access_token, now + 3601), { ok: false, reason: 'expired' })
  assert.ok(T.verifyRefreshToken(pair.refresh_token, now + 29 * 86400).ok)
  assert.equal(T.verifyRefreshToken(pair.refresh_token, now + 31 * 86400).ok, false)
  assert.equal(T.verifyAccessToken(pair.refresh_token).ok, false)
  assert.equal(T.verifyRefreshToken(pair.access_token).ok, false)
  assert.equal(T.verifyAccessToken(pair.access_token.slice(0, -2) + 'zz').ok, false)
  // wrong audience: same secret, but a token minted for another resource
  const other = seal('raa1', { t: 'at', sub: 'u1', aud: 'https://evil.example/mcp', cid: 'x', k: 'k', iat: now, exp: now + 100 })
  assert.deepEqual(T.verifyAccessToken(other), { ok: false, reason: 'audience' })
  assert.equal(open('rac1', pair.access_token), null, 'AAD binds token type')
})

test('a different secret cannot read tokens (rotation invalidates)', async () => {
  const pair = T.issueTokenPair({ sub: 'u1', cidHash: 'abc', apiKey: 'k1234567' })
  const old = process.env.OAUTH_SIGNING_SECRET
  process.env.OAUTH_SIGNING_SECRET = randomBytes(48).toString('base64')
  assert.equal(T.verifyAccessToken(pair.access_token).ok, false)
  assert.equal(T.readClientId(clientId), null)
  process.env.OAUTH_SIGNING_SECRET = 'tooshort'
  assert.equal(oauthConfigured(), false)
  process.env.OAUTH_SIGNING_SECRET = old
})

test('approve: revokes same-label keys, creates one, returns code redirect; bad token / params refused', async () => {
  const revoked: string[] = []; const created: string[] = []
  const deps = {
    verifyUser: async (t: string) => (t === 'good' ? 'u1' : null),
    listKeys: async () => [{ id: 'a', label: 'MCP connector (Claude)', revoked: false }, { id: 'b', label: 'MCP connector (Claude)', revoked: true }, { id: 'c', label: 'mine', revoked: false }],
    revokeKey: async (_t: string, id: string) => { revoked.push(id) },
    createKey: async (_t: string, label: string) => { created.push(label); return { key: 'ra_newkey_1234567' } },
  }
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: RU, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz' })
  const out = await approve(deps, 'good', q)
  assert.deepEqual(revoked, ['a']); assert.deepEqual(created, ['MCP connector (Claude)'])
  const u = new URL(out.redirect_url)
  assert.equal(u.origin + u.pathname, RU); assert.equal(u.searchParams.get('state'), 'xyz')
  const c = T.redeemCode(u.searchParams.get('code')!, good)
  assert.ok(!T.isGrantError(c) && c.k === 'ra_newkey_1234567')
  await assert.rejects(() => approve(deps, 'bad', q), (e: unknown) => e instanceof ApproveError && e.status === 401)
  const q2 = new URLSearchParams(q); q2.set('redirect_uri', 'https://evil.com/')
  await assert.rejects(() => approve(deps, 'good', q2), (e: unknown) => e instanceof ApproveError && e.status === 400)
  const q3 = new URLSearchParams(q); q3.set('code_challenge_method', 'plain')
  await assert.rejects(() => approve(deps, 'good', q3), (e: unknown) => e instanceof ApproveError && e.status === 400)
})
