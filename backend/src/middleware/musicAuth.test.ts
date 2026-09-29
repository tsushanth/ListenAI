// Integration-style test against a real local Supabase instance (no module
// mocking) — creates a real API key via musicApiKeys.ts and exercises the
// middleware's two auth paths directly. Boots a real HTTP server + fetch,
// matching this repo's convention (see routes/textToMusic.test.ts) since
// supertest isn't a dependency here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { requireMusicAuth, MusicAuthedRequest } from './musicAuth.js';
import { createMusicApiKey, revokeMusicApiKey } from '../lib/musicApiKeys.js';

const testUserId = '00000000-0000-0000-0000-000000000099';

function boot() {
  const app = express();
  app.use(requireMusicAuth);
  app.get('/whoami', (req: MusicAuthedRequest, res) => {
    res.json({ userId: req.userId });
  });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    call: (headers?: Record<string, string>) => fetch(`${base}/whoami`, { headers }),
    close: () => server.close(),
  };
}

test('requireMusicAuth accepts a valid API key and resolves the correct user', async () => {
  const { rawKey } = await createMusicApiKey(testUserId);
  const s = boot();

  const res = await s.call({ Authorization: `Bearer ${rawKey}` });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.userId, testUserId);
  s.close();
});

test('requireMusicAuth rejects a revoked API key with 401', async () => {
  const { id, rawKey } = await createMusicApiKey(testUserId);
  await revokeMusicApiKey(testUserId, id);
  const s = boot();

  const res = await s.call({ Authorization: `Bearer ${rawKey}` });

  assert.equal(res.status, 401);
  s.close();
});

test('requireMusicAuth rejects a missing Authorization header with 401', async () => {
  const s = boot();

  const res = await s.call();

  assert.equal(res.status, 401);
  s.close();
});

test('requireMusicAuth rejects a garbage bearer token (neither API key nor valid session) with 401', async () => {
  const s = boot();

  const res = await s.call({ Authorization: 'Bearer not-a-real-token-or-key' });

  assert.equal(res.status, 401);
  s.close();
});
