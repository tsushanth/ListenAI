// Run: npm test. Orchestration of account deletion: step order, auth user last, subscriptions are never cancelled,
// ownership, idempotency. The Supabase-backed store has its own test (accountDeletionStore.test.ts).
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';

import type { AccountStore, StorageGroup, SubscriptionFlags } from './accountDeletion.js';
import type { VoiceCloneRow } from './voiceCloning/types.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

const modP = import('./accountDeletion.js');
const dblP = import('./voiceCloning/testDoubles.js');
const polP = import('./voiceCloning/policy.js');

class FakeAccountStore implements AccountStore {
  calls: string[] = [];
  flags: Record<string, SubscriptionFlags> = {};
  gatewayKeys: Record<string, number> = {};
  storage: Record<string, StorageGroup[]> = {};
  rowsDeletedFor: string[] = [];
  authUsers = new Set<string>();
  failOn: string | null = null;
  private step(name: string) { this.calls.push(name); if (this.failOn === name) throw new Error(`${name} failed`); }
  async subscriptionFlags(u: string) { this.step('flags'); return this.flags[u] ?? { stripe: false, play: false }; }
  async revokeGatewayKeys(u: string) { this.step('keys'); const n = this.gatewayKeys[u] ?? 0; this.gatewayKeys[u] = 0; return n; }
  async collectStorage(u: string) { this.step('collect'); return this.storage[u] ?? []; }
  async removeStorage(g: StorageGroup) { this.step('remove'); for (const [u, groups] of Object.entries(this.storage)) this.storage[u] = groups.map((x) => (x.bucket === g.bucket ? { ...x, paths: x.paths.filter((p) => !g.paths.includes(p)) } : x)); }
  async deleteUserRows(u: string) { this.step('rows'); this.rowsDeletedFor.push(u); return { tablesTouched: 1, tablesSkipped: [] }; }
  async deleteAuthUser(u: string) { this.step('auth'); const had = this.authUsers.delete(u); return had ? 'deleted' as const : 'not_found' as const; }
}

async function setup(opts: { cloneDark?: boolean } = {}) {
  const [{ deleteAccount, AccountDeletionError }, dbl, pol] = await Promise.all([modP, dblP, polP]);
  const store = new FakeAccountStore();
  store.authUsers.add(A); store.authUsers.add(B);
  const cloneStore = new dbl.MemoryStore();
  const service = new dbl.FakeService();
  const cloneDeps = { store: cloneStore, blobs: new dbl.MemoryBlobs(), service, asr: new dbl.FakeAsr(), policy: pol.DEFAULT_POLICY };
  const deps = { store, cloneStore, cloneDeps: () => (opts.cloneDark ? null : cloneDeps) };
  const addVoice = (userId: string, id: string, status: VoiceCloneRow['status'] = 'active') => {
    cloneStore.voices.set(id, { id, userId, name: 'v', language: 'en', status, consentId: `c-${id}`, referenceSha256: 'x', referenceSec: 10, modelId: 'm', disabledReason: null, disabledAt: null, deletedAt: null, createdAt: '2026-01-01T00:00:00Z' });
    cloneStore.consents.set(`c-${id}`, { id: `c-${id}`, userId } as never);
    service.voices.add(id);
  };
  return { deleteAccount, AccountDeletionError, store, cloneStore, service, deps, addVoice };
}

test('deletes in order and removes the auth user LAST', async () => {
  const t = await setup();
  t.addVoice(A, 'va');
  t.store.gatewayKeys[A] = 2;
  t.store.storage[A] = [{ bucket: 'audio-files', paths: ['a/1.mp3', 'a/2.mp3'] }];
  const r = await t.deleteAccount(t.deps, A, { acknowledgeSubscriptions: false });
  assert.equal(r.status, 'deleted');
  if (r.status !== 'deleted') return;
  assert.deepEqual(t.store.calls, ['flags', 'keys', 'collect', 'remove', 'rows', 'auth']);
  assert.equal(t.store.calls.at(-1), 'auth');
  assert.equal(r.voicesDeleted, 1);
  assert.equal(r.gatewayKeysRevoked, 2);
  assert.equal(r.storageObjectsRemoved, 2);
  assert.equal(r.authUser, 'deleted');
  assert.equal(t.cloneStore.voices.get('va')!.status, 'deleted');
  assert.equal(t.service.voices.has('va'), false, 'reference audio removed on the serving app');
});

test('only the caller\'s data is touched: another user\'s voices, keys, objects and auth user survive', async () => {
  const t = await setup();
  t.addVoice(A, 'va'); t.addVoice(B, 'vb');
  t.store.gatewayKeys[B] = 3;
  t.store.storage[B] = [{ bucket: 'audio-files', paths: ['b/1.mp3'] }];
  await t.deleteAccount(t.deps, A, { acknowledgeSubscriptions: false });
  assert.equal(t.cloneStore.voices.get('vb')!.status, 'active');
  assert.equal(t.service.voices.has('vb'), true);
  assert.equal(t.store.gatewayKeys[B], 3);
  assert.deepEqual(t.store.storage[B], [{ bucket: 'audio-files', paths: ['b/1.mp3'] }]);
  assert.deepEqual(t.store.rowsDeletedFor, [A]);
  assert.equal(t.store.authUsers.has(B), true);
  assert.equal(t.store.authUsers.has(A), false);
});

test('an active subscription blocks deletion until acknowledged, and nothing is deleted or cancelled meanwhile', async () => {
  const t = await setup();
  t.addVoice(A, 'va');
  t.store.flags[A] = { stripe: true, play: false };
  const blocked = await t.deleteAccount(t.deps, A, { acknowledgeSubscriptions: false });
  assert.deepEqual(blocked, { status: 'blocked', subscriptions: { stripe: true, play: false } });
  assert.deepEqual(t.store.calls, ['flags']);
  assert.equal(t.cloneStore.voices.get('va')!.status, 'active');
  assert.equal(t.store.authUsers.has(A), true);

  const done = await t.deleteAccount(t.deps, A, { acknowledgeSubscriptions: true });
  assert.equal(done.status, 'deleted');
  assert.deepEqual(done.subscriptions, { stripe: true, play: false }, 'the response still tells the app a subscription was active');
});

test('a Play subscription known to the backend blocks the same way', async () => {
  const t = await setup();
  t.store.flags[A] = { stripe: false, play: true };
  assert.equal((await t.deleteAccount(t.deps, A, { acknowledgeSubscriptions: false })).status, 'blocked');
});

test('ids that are not a real account are refused before anything runs (shared default users, junk)', async () => {
  const t = await setup();
  for (const id of ['00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'not-a-uuid', '']) {
    await assert.rejects(t.deleteAccount(t.deps, id, { acknowledgeSubscriptions: true }), (e: { statusCode: number; code: string }) => e.statusCode === 403 && e.code === 'not_a_real_account');
  }
  assert.deepEqual(t.store.calls, []);
});

test('voice service unavailable while voices exist: 503, nothing else deleted, auth user kept so the user can retry', async () => {
  const t = await setup({ cloneDark: true });
  t.addVoice(A, 'va');
  await assert.rejects(t.deleteAccount(t.deps, A, { acknowledgeSubscriptions: false }), (e: { statusCode: number; code: string }) => e.statusCode === 503 && e.code === 'voice_service_unavailable');
  assert.deepEqual(t.store.calls, ['flags']);
  assert.equal(t.store.authUsers.has(A), true);
});

test('voice service dark but the user has no voices: deletion proceeds', async () => {
  const t = await setup({ cloneDark: true });
  assert.equal((await t.deleteAccount(t.deps, A, { acknowledgeSubscriptions: false })).status, 'deleted');
});

test('the serving app failing to delete a voice stops the run before any row or the auth user goes', async () => {
  const t = await setup();
  t.addVoice(A, 'va');
  t.service.failDelete = true;
  await assert.rejects(t.deleteAccount(t.deps, A, { acknowledgeSubscriptions: false }), (e: { code: string }) => e.code === 'deletion_pending');
  assert.deepEqual(t.store.calls, ['flags']);
  assert.equal(t.store.authUsers.has(A), true);
});

for (const failing of ['keys', 'collect', 'remove', 'rows']) {
  test(`a failure in "${failing}" never reaches the auth user step, and a retry finishes the job`, async () => {
    const t = await setup();
    t.store.gatewayKeys[A] = 1;
    t.store.storage[A] = [{ bucket: 'audio-files', paths: ['a/1.mp3'] }];
    t.store.failOn = failing;
    await assert.rejects(t.deleteAccount(t.deps, A, { acknowledgeSubscriptions: false }));
    assert.equal(t.store.calls.includes('auth'), false);
    assert.equal(t.store.authUsers.has(A), true);
    t.store.failOn = null;
    const r = await t.deleteAccount(t.deps, A, { acknowledgeSubscriptions: false });
    assert.equal(r.status, 'deleted');
    assert.equal(t.store.authUsers.has(A), false);
  });
}

test('idempotent: a second run after completion succeeds with nothing left to do (auth user already gone)', async () => {
  const t = await setup();
  t.addVoice(A, 'va');
  await t.deleteAccount(t.deps, A, { acknowledgeSubscriptions: false });
  const again = await t.deleteAccount(t.deps, A, { acknowledgeSubscriptions: false });
  assert.equal(again.status, 'deleted');
  if (again.status !== 'deleted') return;
  assert.equal(again.voicesDeleted, 0, 'the already-deleted voice is not touched again');
  assert.equal(again.authUser, 'not_found');
});

test('a half-deleted voice (status deleting) and a disabled voice are both finished off', async () => {
  const t = await setup();
  t.addVoice(A, 'v1', 'deleting'); t.addVoice(A, 'v2', 'disabled');
  const r = await t.deleteAccount(t.deps, A, { acknowledgeSubscriptions: false });
  assert.equal(r.status === 'deleted' && r.voicesDeleted, 2);
  assert.equal(t.cloneStore.voices.get('v1')!.status, 'deleted');
  assert.equal(t.cloneStore.voices.get('v2')!.status, 'deleted');
});
