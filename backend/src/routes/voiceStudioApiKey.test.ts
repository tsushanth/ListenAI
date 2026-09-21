// npm test (node:test via tsx). Unit tests for the API-key front door's generalized bits added to
// voiceStudioRouter.ts (featureFlagId, requireConsentStatement) using the same fake-intake harness style
// as voiceStudioRouter.test.ts, but wired the way voiceStudioApiKey.ts wires them: identity comes from
// trusted headers (as if forwarded by the gateway), not a Supabase JWT, and the allowlist is checked
// against the key id, not the resolved owner identity.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Request } from 'express';
import { createVoiceStudioRouter, CONSENT_TEXT_VERSION, CONSENT_STATEMENT, VoiceStudioDeps } from './voiceStudioRouter.js';
import { IntakeClient, IntakeVoiceStatus } from '../lib/voiceIntakeClient.js';

const FORWARD_SECRET = 'test-forward-secret';

function fakeIntake() {
  const voices = new Map<string, IntakeVoiceStatus>();
  const ownerKeyIds = new Map<string, string[]>(); // what create() was actually sent, for the regression test below
  let n = 0;
  const intake: IntakeClient = {
    async create(b) {
      const id = `v-${(++n).toString(16).padStart(10, '0')}`;
      voices.set(id, { voice_id: id, status: 'created', owner_user_id: b.owner_user_id as string, speaker_name: b.speaker_name as string, created_at: 1 });
      if (Array.isArray(b.owner_key_ids)) ownerKeyIds.set(id, b.owner_key_ids as string[]);
      return { voice_id: id };
    },
    async list(u) { return { voices: [...voices.values()].filter((v) => v.owner_user_id === u) }; },
    async get(id) { const v = voices.get(id); if (!v) throw Object.assign(new Error('404'), { status: 404 }); return v; },
    async putPart() { throw new Error('not used'); },
    async listParts() { return { parts: [] }; },
    async commit() { throw new Error('not used'); },
    async sample() { throw new Error('not used'); },
    async preview() { throw new Error('not used'); },
    async deploy() { throw new Error('not used'); },
    async remove() { throw new Error('not used'); },
  };
  return { intake, voices, ownerKeyIds };
}

// Mirrors voiceStudioApiKey.ts's real authenticate()/featureFlagId(): trusts x-gateway-admin-secret,
// resolves identity from x-gateway-uid (falling back to x-gateway-key-id), gates the feature flag on the
// key id specifically.
function apiKeyDeps(intake: IntakeClient, enabled: string): VoiceStudioDeps {
  return {
    authenticate: async (req: Request) => {
      if (req.headers['x-gateway-admin-secret'] !== FORWARD_SECRET) return null;
      const uid = String(req.headers['x-gateway-uid'] ?? '').trim();
      const keyId = String(req.headers['x-gateway-key-id'] ?? '').trim();
      return uid || keyId || null;
    },
    featureFlagId: (req: Request) => String(req.headers['x-gateway-key-id'] ?? '').trim(),
    requireConsentStatement: true,
    intake,
    enabledUsers: () => enabled,
    maxVoicesPerUser: 3,
    maxZipBytes: 1024,
    backfillKeyOwners: async () => {},
    // Mirrors voiceStudioApiKey.ts's real ownerKeyIdsFor: a bare key (no bound uid) must also be sent as
    // owner_key_ids so Piper's registry can match it (see the regression test below for why).
    ownerKeyIdsFor: (req: Request) => {
      const uid = String(req.headers['x-gateway-uid'] ?? '').trim();
      const keyId = String(req.headers['x-gateway-key-id'] ?? '').trim();
      return uid ? undefined : (keyId ? [keyId] : undefined);
    },
  };
}

async function boot(enabled: string) {
  const f = fakeIntake();
  const app = express();
  app.use('/internal/voice-studio-api', createVoiceStudioRouter(apiKeyDeps(f.intake, enabled)));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/internal/voice-studio-api`;
  const call = (headers: Record<string, string>, method: string, path: string, body?: unknown) =>
    fetch(base + path, {
      method,
      headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  return { call, f, close: () => server.close() };
}

const fullConsent = {
  speaker_name: 'LibriTTS-R speaker 1089 (test fixture)',
  attested_by: 'CI test harness (test fixture)',
  consent: true,
  consent_text_version: CONSENT_TEXT_VERSION,
  consent_statement: CONSENT_STATEMENT,
};

test('wrong/missing forward secret -> 401 regardless of headers', async () => {
  const { call, close } = await boot('*');
  const noSecret = await call({ 'x-gateway-key-id': 'k1' }, 'GET', '/');
  assert.equal(noSecret.status, 401);
  const wrongSecret = await call({ 'x-gateway-admin-secret': 'nope', 'x-gateway-key-id': 'k1' }, 'GET', '/');
  assert.equal(wrongSecret.status, 401);
  await close();
});

test('feature flag is checked against the key id, not the resolved uid', async () => {
  // uid "user-1" is NOT allowlisted, but the key id "k-allowed" is -> must succeed.
  const { call, close } = await boot('k-allowed');
  const res = await call({ 'x-gateway-admin-secret': FORWARD_SECRET, 'x-gateway-key-id': 'k-allowed', 'x-gateway-uid': 'user-1' }, 'GET', '/');
  assert.equal(res.status, 200);
  // A different key id, even with the same uid, is not allowlisted -> 404 (dark by default per key).
  const res2 = await call({ 'x-gateway-admin-secret': FORWARD_SECRET, 'x-gateway-key-id': 'k-other', 'x-gateway-uid': 'user-1' }, 'GET', '/');
  assert.equal(res2.status, 404);
  await close();
});

test('create without consent_statement is rejected even with valid consent_text_version', async () => {
  const { call, close } = await boot('*');
  const headers = { 'x-gateway-admin-secret': FORWARD_SECRET, 'x-gateway-key-id': 'k1', 'x-gateway-uid': 'user-1' };
  const { consent_statement: _drop, ...noStatement } = fullConsent;
  const res = await call(headers, 'POST', '/', noStatement);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /consent_statement/);
  await close();
});

test('create with a paraphrased (non-verbatim) consent_statement is rejected', async () => {
  const { call, close } = await boot('*');
  const headers = { 'x-gateway-admin-secret': FORWARD_SECRET, 'x-gateway-key-id': 'k1', 'x-gateway-uid': 'user-1' };
  const res = await call(headers, 'POST', '/', { ...fullConsent, consent_statement: 'I consent to this.' });
  assert.equal(res.status, 400);
  await close();
});

test('create with correct verbatim consent_statement succeeds and voice is owned by the resolved uid', async () => {
  const { call, f, close } = await boot('*');
  const headers = { 'x-gateway-admin-secret': FORWARD_SECRET, 'x-gateway-key-id': 'k1', 'x-gateway-uid': 'user-1' };
  const res = await call(headers, 'POST', '/', fullConsent);
  assert.equal(res.status, 201);
  const { id } = await res.json();
  assert.equal(f.voices.get(id)?.owner_user_id, 'user-1');
  await close();
});

test('key with no bound uid: owner identity falls back to the key id itself', async () => {
  const { call, f, close } = await boot('*');
  const headers = { 'x-gateway-admin-secret': FORWARD_SECRET, 'x-gateway-key-id': 'k-bare' }; // no x-gateway-uid
  const res = await call(headers, 'POST', '/', fullConsent);
  assert.equal(res.status, 201);
  const { id } = await res.json();
  assert.equal(f.voices.get(id)?.owner_user_id, 'k-bare');
  await close();
});

// Regression test for a bug a LIVE e2e run against the deployed service found (not caught by review or
// the test above): a bare key's owner_user_id becomes the key id, which intake.py's deploy handler writes
// into Piper's owner.json as `user_ids` — but Piper only matches `user_ids` against a session token's
// `uid` claim, and a token for a key with no bound uid never has one, so the voice deployed fine but the
// creating key got "unknown voice" on every synthesize call. Fix: also send owner_key_ids so Piper's
// separate key_ids match rule (which DOES check the token's key id) covers it. See ownerKeyIdsFor in
// voiceStudioApiKey.ts and the intake.py deploy handler for the full chain this test is pinning down.
test('key with no bound uid: create() ALSO sends owner_key_ids so the deployed voice is usable by that key', async () => {
  const { call, f, close } = await boot('*');
  try {
    const headers = { 'x-gateway-admin-secret': FORWARD_SECRET, 'x-gateway-key-id': 'k-bare' }; // no x-gateway-uid
    const res = await call(headers, 'POST', '/', fullConsent);
    assert.equal(res.status, 201);
    const { id } = await res.json();
    assert.deepEqual(f.ownerKeyIds.get(id), ['k-bare']);
  } finally {
    await close();
  }
});

test('key WITH a bound uid: create() does NOT send owner_key_ids (uid alone is the correct, matchable owner)', async () => {
  const { call, f, close } = await boot('*');
  try {
    const headers = { 'x-gateway-admin-secret': FORWARD_SECRET, 'x-gateway-key-id': 'k1', 'x-gateway-uid': 'user-1' };
    const res = await call(headers, 'POST', '/', fullConsent);
    assert.equal(res.status, 201);
    const { id } = await res.json();
    assert.equal(f.ownerKeyIds.has(id), false);
  } finally {
    await close();
  }
});

test('a voice created under one key id is not visible/owned via a different key id with a different uid', async () => {
  const { call, close } = await boot('*');
  const headers1 = { 'x-gateway-admin-secret': FORWARD_SECRET, 'x-gateway-key-id': 'k1', 'x-gateway-uid': 'user-1' };
  const created = await call(headers1, 'POST', '/', fullConsent);
  const { id } = await created.json();
  const headers2 = { 'x-gateway-admin-secret': FORWARD_SECRET, 'x-gateway-key-id': 'k2', 'x-gateway-uid': 'user-2' };
  const res = await call(headers2, 'GET', `/${id}`);
  assert.equal(res.status, 404); // ownership mismatch looks identical to unknown id, same as the web flow
  await close();
});
