import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';

const modP = import('./adminDashboard.js');
const NOW = new Date('2026-10-08T12:00:00Z');
const deps = {
  now: () => NOW, listUsers: async () => [{ id: 'a', email: 'a@example.test', created_at: '2026-09-01T00:00:00Z' }],
  listKeys: async () => [{ user_id: 'a', gateway_key_id: 'k1', created_at: '2026-09-02T00:00:00Z', revoked_at: null }],
  listUsage: async () => [], listFreeCredits: async () => [], listBilling: async () => [], listRecentStt: async () => [], probes: async () => [],
  firstUsageDay: async () => null,
};

async function serve(isAdmin: (a?: string) => Promise<boolean>, extra: Record<string, unknown> = {}) {
  const { createAdminDashboardRouter } = await modP;
  const app = express();
  app.use('/api/admin/dashboard', createAdminDashboardRouter({ isAdmin, deps: deps as any, excludeEmails: () => new Set(), ...extra }));
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/admin/dashboard`;
  return { base, close: () => srv.close() };
}

test('non-admin (anonymous, wrong account, anything) gets 404 "Not found" with no data', async () => {
  const s = await serve(async () => false);
  try {
    for (const h of [{}, { Authorization: 'Bearer nope' }]) {
      const r = await fetch(s.base, { headers: h });
      assert.equal(r.status, 404);
      assert.equal(await r.text(), 'Not found');
    }
  } finally { s.close(); }
});

test('admin gets 200 JSON with every section, no-store, and the default range is 7d', async () => {
  const s = await serve(async (a) => a === 'Bearer good');
  try {
    const r = await fetch(s.base, { headers: { Authorization: 'Bearer good' } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const j: any = await r.json();
    assert.equal(j.range, '7d');
    for (const k of ['attention', 'health', 'totals', 'funnel', 'customers', 'series']) assert.ok(k in j, k);
    assert.equal(j.totals.data.accounts, 1);
  } finally { s.close(); }
});

test('range query: valid is honored, junk falls back to 7d', async () => {
  const s = await serve(async () => true);
  try {
    assert.equal(((await (await fetch(`${s.base}?range=30d`)).json()) as any).range, '30d');
    assert.equal(((await (await fetch(`${s.base}?range=999d`)).json()) as any).range, '7d');
    assert.equal(((await (await fetch(`${s.base}?range=24h&range=30d`)).json()) as any).range, '7d');
  } finally { s.close(); }
});

test('the admin check throwing is a 404, not a 500', async () => {
  const s = await serve(async () => { throw new Error('supabase down'); });
  try { assert.equal((await fetch(s.base, { headers: { Authorization: 'Bearer x' } })).status, 404); } finally { s.close(); }
});

test('only GET is allowed', async () => {
  const s = await serve(async () => true);
  try { assert.equal((await fetch(s.base, { method: 'POST' })).status, 404); } finally { s.close(); }
});

test('one failing data source still returns 200 with that section marked failed', async () => {
  const s = await serve(async () => true, { deps: { ...deps, listUsage: async () => { throw new Error('usage table missing'); } } });
  try {
    const j: any = await (await fetch(s.base)).json();
    assert.equal(j.totals.ok, false);
    assert.equal(j.health.ok, true);
  } finally { s.close(); }
});

test('index.ts mounts the dashboard before the generic admin router', () => {
  const src = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
  const dash = src.indexOf("app.use('/api/admin/dashboard', adminDashboardRouter)");
  const generic = src.indexOf("app.use('/api/admin', adminRouter)");
  assert.ok(dash > 0 && generic > 0 && dash < generic);
});
