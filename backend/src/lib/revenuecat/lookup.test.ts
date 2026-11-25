import test from 'node:test';
import assert from 'node:assert/strict';

import { createLiveLookup, lookupConfigFromEnv, NEGATIVE_TTL_MS, POSITIVE_TTL_MS } from './lookup.js';

const UID = '11111111-2222-4333-8444-555555555555';
const cfg = { apiKey: 'sk_test', projectId: 'proj_x', acceptSandbox: false };
const reply = (status: number, items?: unknown[]) => new Response(JSON.stringify(items ? { object: 'list', items } : {}), { status });

function setup(responses: Array<Response | Error>, over: Partial<typeof cfg> | null = {}) {
  const calls: Array<{ url: string; auth: string }> = [];
  const reported: number[] = [];
  let t = 1_000_000;
  const lookup = createLiveLookup({
    config: () => (over === null ? null : { ...cfg, ...over }),
    now: () => t,
    report: (s) => reported.push(s),
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ url, auth: (init.headers as Record<string, string>).Authorization! });
      const r = responses.shift()!;
      if (r instanceof Error) throw r;
      return r;
    }) as unknown as typeof fetch,
  });
  return { lookup, calls, reported, advance: (ms: number) => { t += ms; } };
}

test('config: off unless both the key and the project id are set', () => {
  assert.equal(lookupConfigFromEnv({}), null);
  assert.equal(lookupConfigFromEnv({ REVENUECAT_API_KEY: 'k' }), null);
  assert.equal(lookupConfigFromEnv({ REVENUECAT_PROJECT_ID: 'p' }), null);
  assert.deepEqual(lookupConfigFromEnv({ REVENUECAT_API_KEY: 'k', REVENUECAT_PROJECT_ID: 'p' }), { apiKey: 'k', projectId: 'p', acceptSandbox: false });
});

test('not configured or not an account id: false, and RevenueCat is never called', async () => {
  const off = setup([], null);
  assert.equal(await off.lookup(UID), false);
  const on = setup([]);
  assert.equal(await on.lookup('00000000-anonymous'), false);
  assert.equal(on.calls.length + off.calls.length, 0);
});

test('a production subscription that gives access counts', async () => {
  const s = setup([reply(200, [{ gives_access: false, environment: 'production' }, { gives_access: true, environment: 'production' }])]);
  assert.equal(await s.lookup(UID.toUpperCase()), true);
  assert.equal(s.calls[0]!.url, `https://api.revenuecat.com/v2/projects/proj_x/customers/${UID}/subscriptions?limit=50`);
  assert.equal(s.calls[0]!.auth, 'Bearer sk_test');
});

test('expired, empty, unknown customer and sandbox purchases do not count', async () => {
  for (const r of [reply(200, [{ gives_access: false, environment: 'production' }]), reply(200, []), reply(404), reply(200, [{ gives_access: true, environment: 'sandbox' }])]) {
    assert.equal(await setup([r]).lookup(UID), false);
  }
  assert.equal(await setup([reply(200, [{ gives_access: true, environment: 'sandbox' }])], { acceptSandbox: true }).lookup(UID), true);
});

test('answers are cached: a no for a minute, a yes for ten', async () => {
  const s = setup([reply(200, []), reply(200, [{ gives_access: true, environment: 'production' }]), reply(200, [])]);
  assert.equal(await s.lookup(UID), false);
  assert.equal(await s.lookup(UID), false);
  s.advance(NEGATIVE_TTL_MS + 1);
  assert.equal(await s.lookup(UID), true);
  s.advance(POSITIVE_TTL_MS - 1);
  assert.equal(await s.lookup(UID), true);
  s.advance(2);
  assert.equal(await s.lookup(UID), false);
  assert.equal(s.calls.length, 3);
});

test('errors throw (the caller fails closed), are reported by status, and are not cached', async () => {
  const s = setup([reply(401), new Error('network'), reply(200, [{ gives_access: true, environment: 'production' }])]);
  await assert.rejects(s.lookup(UID), /HTTP 401/);
  await assert.rejects(s.lookup(UID), /network/);
  assert.equal(await s.lookup(UID), true);
  assert.deepEqual(s.reported, [401]);
});
