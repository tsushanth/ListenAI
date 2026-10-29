// Run: npx tsx --test --experimental-test-module-mocks src/routes/voiceConvertFailureSignal.test.ts
// Polling a voice conversion that the provider reports as failed signals the owner once (class only); done/running and
// a re-poll of an already-failed row do not.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';

process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
process.env.SUPABASE_JWT_SECRET = 'test';
process.env.GATEWAY_FORWARD_SECRET ??= 'test-forward-secret';
process.env.NODE_ENV = 'test';

const reports: Array<{ flow: string; msg: string; ctx: Record<string, string> }> = [];
mock.module('../lib/failureReporter.js', {
  namedExports: {
    reportFailure: (flow: string, err: Error, ctx: Record<string, string> = {}) => { reports.push({ flow, msg: err.message, ctx }); },
    reportBackendError: () => {},
    reportCrash: async () => {},
  },
});

const MODAL_BASE = 'https://user-modal-app.modal.run';
let modalStatus = 'failed';
let priorStatus = 'queued';
const rowPatches: Array<Record<string, unknown>> = [];
const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });

function installFetch() {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method || 'GET').toUpperCase();
    if (url === 'http://localhost:54321/auth/v1/user') return j({ id: 'u-1', aud: 'authenticated' });
    if (url.includes('/realtimetts_free_credits')) return j([{ granted: 10000, used: 10000 }]);
    if (url.includes('/rest/v1/realtimetts_billing')) {
      return j([{ user_id: 'u-1', stripe_customer_id: 'cus_u', stripe_subscription_id: 'sub', stripe_subscription_item_id: 'si', active: true }]);
    }
    if (url.includes('/rest/v1/user_voice_convert_deployments')) {
      return j({ user_id: 'u-1', modal_url: MODAL_BASE, modal_secret: 's', status: 'ready', app_name: 'a', job_count: 0 });
    }
    if (url.includes('/rest/v1/voice_conversions')) {
      if (method === 'PATCH') { rowPatches.push(JSON.parse(String(init?.body))); return j([{ id: 1 }]); }
      return j([{ status: priorStatus, source_seconds: 5 }]);
    }
    if (url.startsWith(MODAL_BASE)) return j({ job_id: 'job-1', status: modalStatus, stderr_tail: 'trace mentioning alice@example.com' });
    return orig(input, init);
  }) as typeof fetch;
  return () => { globalThis.fetch = orig; };
}

async function poll(): Promise<number> {
  const { voiceConvertRouter } = await import('./voiceConvert.js');
  const app = express();
  app.use('/api/voice-convert', voiceConvertRouter);
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/voice-convert`;
    const r = await fetch(`${base}/conversions/job-1`, { headers: { Authorization: 'Bearer valid-token' } });
    return r.status;
  } finally { server.close(); }
}

test('first poll that sees failed signals once: class only, no stderr or ids', async () => {
  reports.length = 0; rowPatches.length = 0; modalStatus = 'failed'; priorStatus = 'queued';
  const restore = installFetch();
  try {
    assert.equal(await poll(), 200);
    assert.equal(rowPatches[0]?.status, 'failed');
    assert.equal(reports.length, 1);
    assert.deepEqual(reports[0], { flow: 'voice_conversion_failed', msg: 'VOICE_CONVERSION_FAILED', ctx: {} });
    assert.ok(!JSON.stringify(reports).includes('alice@example.com'));
  } finally { restore(); }
});

test('re-polling an already-failed row does not signal again', async () => {
  reports.length = 0; modalStatus = 'failed'; priorStatus = 'failed';
  const restore = installFetch();
  try { assert.equal(await poll(), 200); assert.equal(reports.length, 0); } finally { restore(); }
});

test('done and still-running conversions never signal', async () => {
  const restore = installFetch();
  try {
    for (const s of ['done', 'processing', 'queued']) {
      reports.length = 0; modalStatus = s; priorStatus = 'queued';
      assert.equal(await poll(), 200);
      assert.equal(reports.length, 0, s);
    }
  } finally { restore(); }
});
