// npm test (node:test via tsx). Supabase projects now sign user tokens with an asymmetric key (ES256, published at
// /auth/v1/.well-known/jwks.json). verifyAuthToken only knew HS256, so every real token failed and requireAuth silently
// treated the caller as the shared default user.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as jose from 'jose';
import { randomBytes } from 'node:crypto';

process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET = randomBytes(32).toString('hex'); // generated per run: no secret-looking literal in source
process.env.NODE_ENV = 'test';

const ISS = 'http://localhost:54321/auth/v1';
const load = () => import('./auth.js');

async function es256() {
  const { publicKey, privateKey } = await jose.generateKeyPair('ES256');
  const jwk = { ...(await jose.exportJWK(publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
  return { privateKey, jwks: jose.createLocalJWKSet({ keys: [jwk] }) };
}
const sign = (key: jose.KeyLike | Uint8Array, alg: string, extra: Record<string, unknown> = {}, exp = '1h') =>
  new jose.SignJWT({ role: 'authenticated', ...extra })
    .setProtectedHeader({ alg, kid: alg === 'ES256' ? 'k1' : undefined })
    .setSubject('11111111-2222-3333-4444-555555555555').setIssuer(ISS).setAudience('authenticated')
    .setIssuedAt().setExpirationTime(exp).sign(key);

test('an ES256 token signed by the project key verifies and yields the real user id', async () => {
  const { verifyAuthToken, __setJwksForTests } = await load();
  const { privateKey, jwks } = await es256();
  __setJwksForTests(jwks);
  const token = await sign(privateKey, 'ES256');
  assert.deepEqual(await verifyAuthToken(token), { userId: '11111111-2222-3333-4444-555555555555' });
});

test('an ES256 token signed by a different key is rejected', async () => {
  const { verifyAuthToken, __setJwksForTests } = await load();
  const trusted = await es256();
  const attacker = await es256();
  __setJwksForTests(trusted.jwks);
  await assert.rejects(verifyAuthToken(await sign(attacker.privateKey, 'ES256')));
});

test('expired and wrong-audience ES256 tokens are rejected', async () => {
  const { verifyAuthToken, __setJwksForTests } = await load();
  const { privateKey, jwks } = await es256();
  __setJwksForTests(jwks);
  await assert.rejects(verifyAuthToken(await sign(privateKey, 'ES256', {}, '-1m')), /expired/i);
  const bad = await new jose.SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: 'k1' }).setSubject('u').setIssuer(ISS)
    .setAudience('someone-else').setExpirationTime('1h').sign(privateKey);
  await assert.rejects(verifyAuthToken(bad));
});

test('legacy HS256 tokens still verify with the shared secret', async () => {
  const { verifyAuthToken, __setJwksForTests } = await load();
  __setJwksForTests(null);
  const token = await sign(new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET!), 'HS256');
  assert.equal((await verifyAuthToken(token)).userId, '11111111-2222-3333-4444-555555555555');
});

test('an HS256 token cannot be passed off against the asymmetric path, and "alg: none"/garbage is rejected', async () => {
  const { verifyAuthToken, __setJwksForTests } = await load();
  const { jwks } = await es256();
  __setJwksForTests(jwks);
  // signed with a guessed secret, claims ES256 in the header? not possible: header alg selects the verifier; HS256 uses only the real secret
  const forged = await sign(new TextEncoder().encode('not-the-secret-not-the-secret-not-the-secret'), 'HS256');
  await assert.rejects(verifyAuthToken(forged));
  await assert.rejects(verifyAuthToken('not.a.jwt'));
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  await assert.rejects(verifyAuthToken(`${b64({ alg: 'none' })}.${b64({ sub: 'x' })}.`)); // built at runtime: no JWT literal in source
});
