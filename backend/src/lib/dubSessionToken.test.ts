// npm test (node:test via tsx). The session token the dub STT worker (modal/dub_worker.py) verifies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mintDubSessionToken, DUB_TOKEN_TTL_MS } from './dubSessionToken.js';

const decode = (token: string) => {
  const [payload, sig] = token.split('.');
  return { payload, sig, claims: JSON.parse(Buffer.from(payload, 'base64url').toString()) as { id: string; exp: number } };
};

test('the token is base64url(JSON{id,exp}) "." base64url(HMAC-SHA256(secret, payload)), the format the worker verifies', () => {
  const now = 1_790_000_000_000;
  const { payload, sig, claims } = decode(mintDubSessionToken('s3cret', 'dub:u:j', now));
  assert.deepEqual(claims, { id: 'dub:u:j', exp: now + DUB_TOKEN_TTL_MS });
  assert.equal(sig, createHmac('sha256', 's3cret').update(payload).digest('base64url'));
  assert.doesNotMatch(payload + sig, /[=+/]/, 'url-safe, unpadded: the worker re-pads and decodes with the urlsafe alphabet');
});

test('expiry is in milliseconds, so the worker\'s `time.time() * 1000 > exp` check works', () => {
  const { claims } = decode(mintDubSessionToken('s3cret', 'id'));
  assert.ok(claims.exp > Date.now() && claims.exp < Date.now() + 60 * 60_000, 'a few minutes from now, in ms, not seconds');
});

test('a different secret yields a different signature (a token is only good for the deployment that issued it)', () => {
  const a = decode(mintDubSessionToken('secret-a', 'id', 1000));
  const b = decode(mintDubSessionToken('secret-b', 'id', 1000));
  assert.equal(a.payload, b.payload);
  assert.notEqual(a.sig, b.sig);
});

test('refuses to mint with an empty secret, which the worker would reject anyway', () => {
  assert.throws(() => mintDubSessionToken('', 'id'), /without a secret/);
});
