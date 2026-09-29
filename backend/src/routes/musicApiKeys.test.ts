// Requires a local Supabase instance with migration 020 applied.
// Auth is stubbed directly (req.userId), matching routes/textToMusic.test.ts's
// approach — requireRealAuth is applied at the mount site in index.ts, not
// baked into this router, and is tested separately.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express, { Request, Response, NextFunction } from 'express';
import type { AddressInfo } from 'node:net';
import { musicApiKeysRouter } from './musicApiKeys.js';
import { errorHandler } from '../middleware/errorHandler.js';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.NODE_ENV = 'test';

const testUserId = '00000000-0000-0000-0000-000000000097';

function boot(userId = testUserId) {
  const app = express();
  app.use(express.json());
  app.use((req: Request & { userId?: string }, _res: Response, next: NextFunction) => {
    req.userId = userId;
    next();
  });
  app.use('/api/music-api-keys', musicApiKeysRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/music-api-keys`;
  const call = (method: string, path: string) => fetch(base + path, { method });
  return { call, close: () => server.close() };
}

test('POST / creates a key and returns the raw key exactly once', async () => {
  const s = boot();
  const res = await s.call('POST', '/');
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.ok(body.id);
  assert.ok(body.key.startsWith('rlm_'));
  s.close();
});

test('GET / lists keys without ever including the raw key', async () => {
  const s = boot();
  await s.call('POST', '/');
  const res = await s.call('GET', '/');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.keys));
  assert.ok(body.keys.length > 0);
  for (const key of body.keys) {
    assert.ok(!('key' in key));
    assert.ok(!('key_hash' in key));
  }
  s.close();
});

test('DELETE /:id revokes a key, and a second revoke of the same id 404s', async () => {
  const s = boot();
  const createRes = await s.call('POST', '/');
  const { id } = await createRes.json();

  const deleteRes = await s.call('DELETE', `/${id}`);
  assert.equal(deleteRes.status, 204);

  const secondDeleteRes = await s.call('DELETE', `/${id}`);
  assert.equal(secondDeleteRes.status, 404);
  s.close();
});

test('DELETE /:id for a nonexistent id returns 404', async () => {
  const s = boot();
  const res = await s.call('DELETE', '/00000000-0000-0000-0000-000000000000');
  assert.equal(res.status, 404);
  s.close();
});

test('a key created by one user cannot be revoked by another user', async () => {
  const owner = boot('00000000-0000-0000-0000-000000000097');
  const createRes = await owner.call('POST', '/');
  const { id } = await createRes.json();
  owner.close();

  const attacker = boot('00000000-0000-0000-0000-000000000098');
  const res = await attacker.call('DELETE', `/${id}`);
  assert.equal(res.status, 404);
  attacker.close();
});
