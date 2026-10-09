import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';

const modP = import('./adminBearer.js');
const ok = { id: 'u', email: 'Boss@Example.test', email_confirmed_at: '2026-01-01T00:00:00Z', identities: [{ provider: 'google' }] };
const deps = (user: any, emails = ['boss@example.test']) => ({ getUser: async () => user, adminEmails: emails });

test('valid Google, confirmed, allowlisted (case-insensitive) is admin', async () => {
  const { isAdminBearer } = await modP;
  assert.equal(await isAdminBearer('Bearer t', deps(ok)), true);
});

test('missing or malformed header is not admin', async () => {
  const { isAdminBearer } = await modP;
  for (const h of [undefined, '', 'Basic abc', 'Bearer', 'Bearer ']) assert.equal(await isAdminBearer(h as any, deps(ok)), false);
});

test('email/password login of the admin address is not admin', async () => {
  const { isAdminBearer } = await modP;
  assert.equal(await isAdminBearer('Bearer t', deps({ ...ok, identities: [{ provider: 'email' }] })), false);
  assert.equal(await isAdminBearer('Bearer t', deps({ ...ok, identities: null })), false);
});

test('unconfirmed email, other address, no user are not admin', async () => {
  const { isAdminBearer } = await modP;
  assert.equal(await isAdminBearer('Bearer t', deps({ ...ok, email_confirmed_at: null })), false);
  assert.equal(await isAdminBearer('Bearer t', deps({ ...ok, email: 'other@example.test' })), false);
  assert.equal(await isAdminBearer('Bearer t', deps(null)), false);
});

test('an empty allowlist fails closed', async () => {
  const { isAdminBearer } = await modP;
  assert.equal(await isAdminBearer('Bearer t', deps(ok, [])), false);
});

test('a token-verification error (Supabase down) is not admin and never throws', async () => {
  const { isAdminBearer } = await modP;
  assert.equal(await isAdminBearer('Bearer t', { getUser: async () => { throw new Error('down'); }, adminEmails: ['boss@example.test'] }), false);
});

test('adminEmailsFromEnv has no default and normalizes', async () => {
  const { adminEmailsFromEnv } = await modP;
  assert.deepEqual(adminEmailsFromEnv({} as any), []);
  assert.deepEqual(adminEmailsFromEnv({ ADMIN_EMAILS: ' A@x.test, ,b@X.test' } as any), ['a@x.test', 'b@x.test']);
});
