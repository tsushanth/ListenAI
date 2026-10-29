// Run: npx tsx --test --experimental-test-module-mocks src/workers/ttsJobWorker.failureSignal.test.ts
// Drives the real worker (processJobById) with Supabase over a patched fetch, a fake ElevenLabs client, a fake
// pubsub (retry decision) and a recording failure reporter. Proves: success never reports; a retried failure does not
// report; a permanent failure and a STUCK_JOB each report exactly once, with the right class and no job content.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
process.env.SUPABASE_JWT_SECRET = 'test';
process.env.NODE_ENV = 'test';

type Report = { flow: string; err: Error; ctx: Record<string, string> };
const reports: Report[] = [];
let retry = false;
let jobChars = 300;
let synth: () => Promise<{ audioBuffer: Buffer; metrics: Record<string, number> }>;
const SECRET_TEXT = 'Chapter One of my diary for alice@example.com';
const USER_ID = 'user-1234-abcd';

mock.module('../lib/failureReporter.js', {
  namedExports: {
    reportFailure: (flow: string, err: Error, ctx: Record<string, string> = {}) => { reports.push({ flow, err, ctx }); },
    reportBackendError: () => {},
    reportCrash: async () => {},
  },
});
mock.module('../lib/pubsub.js', {
  namedExports: {
    republishForRetry: async () => retry,
    startSubscription: () => () => {},
  },
});
mock.module('../lib/elevenLabsClient.js', {
  namedExports: {
    isElevenLabsConfigured: () => true,
    getElevenLabsClient: () => ({ synthesizeWithMetrics: () => synth() }),
  },
});

const json = (body: unknown, status = 200) => new Response(body === undefined || body === null || status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const rpcCalls: Array<{ name: string; body: Record<string, unknown> }> = [];
let stuckRows: Array<Record<string, unknown>> = [];

function installFetch() {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = (init?.method || 'GET').toUpperCase();
    const accept = new Headers(init?.headers).get('accept') ?? '';
    const single = accept.includes('vnd.pgrst.object');
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      rpcCalls.push({ name: url.pathname.split('/').pop()!, body: JSON.parse(String(init?.body ?? '{}')) });
      return json(null, 204);
    }
    if (url.pathname.startsWith('/storage/v1/')) return json({ Key: 'x', Id: 'x' });
    if (url.pathname === '/rest/v1/tts_jobs' && method === 'GET') {
      if (url.searchParams.has('id')) {
        const row = { id: 'job-1', status: 'queued', voice_id: 'my-voice-name', model_id: 'eleven_multilingual_v2', input_char_count: jobChars, user_id: USER_ID, speed: 1, cache_key: 'ck', cloned_voice_id: null, cloning_model: null };
        return json(single ? row : [row]);
      }
      if (url.searchParams.get('status')?.includes('processing')) return json(stuckRows); // the stuck-job watchdog
      return json([]); // the queued-job poll loop: nothing to claim
    }
    if (url.pathname === '/rest/v1/tts_job_texts' && method === 'GET') return json(single ? { text: SECRET_TEXT } : [{ text: SECRET_TEXT }]);
    if (method === 'GET') return json(single ? null : [], single ? 406 : 200);
    return json(null, 204); // PATCH / DELETE / POST
  }) as typeof fetch;
  return () => { globalThis.fetch = orig; };
}

const workerP = import('./ttsJobWorker.js');

function reset() { jobChars = 300; reports.length = 0; rpcCalls.length = 0; stuckRows = []; retry = false; }
const failedWrites = () => rpcCalls.filter(c => c.name === 'update_job_progress' && c.body.p_status === 'failed');

test('success never reports', async () => {
  reset();
  const restore = installFetch();
  synth = async () => ({ audioBuffer: Buffer.alloc(32000), metrics: { ttfb_ms: 1, total_ms: 1, bytes_received: 32000, t_start: 0, t_first_byte: 1, t_done: 2 } });
  try {
    const { processJobById } = await workerP;
    await processJobById('job-1');
    assert.equal(rpcCalls.some(c => c.name === 'update_job_progress' && c.body.p_status === 'ready'), true, 'job should have been marked ready');
    assert.equal(failedWrites().length, 0);
    assert.equal(reports.length, 0);
  } finally { restore(); }
});

test('a failure that will be retried does not report', async () => {
  reset();
  const restore = installFetch();
  retry = true;
  synth = async () => { throw new Error('ElevenLabs: Rate limit exceeded - please try again later'); };
  try {
    const { processJobById } = await workerP;
    await assert.rejects(processJobById('job-1'));
    assert.equal(failedWrites().length, 0);
    assert.equal(reports.length, 0);
  } finally { restore(); }
});

test('a permanent failure writes failed and reports exactly once: class + safe context, no content', async () => {
  reset();
  const restore = installFetch();
  retry = false;
  synth = async () => { throw new Error(`TTS request timed out for ${SECRET_TEXT} ${USER_ID}`); };
  try {
    const { processJobById } = await workerP;
    await assert.rejects(processJobById('job-1'));
    assert.equal(failedWrites().length, 1);
    assert.equal(reports.length, 1);
    const r = reports[0];
    assert.equal(r.flow, 'tts_job_failed');
    assert.equal(r.err.message, 'TTS_TIMEOUT');
    assert.deepEqual(r.ctx, { provider: 'elevenlabs', attempts: '1', chars_bucket: '<500' });
    const sent = JSON.stringify([r.flow, r.err.message, r.err.stack, r.ctx]);
    for (const bit of [SECRET_TEXT, 'alice@example.com', USER_ID, 'my-voice-name', 'job-1']) assert.ok(!sent.includes(bit), `leaked: ${bit}`);
  } finally { restore(); }
});

test('the stuck-job watchdog reports STUCK_JOB once per job it fails', async () => {
  reset();
  const restore = installFetch();
  stuckRows = [{ id: 'job-s', started_at: '2020-01-01T00:00:00Z', retry_count: 2, status: 'processing', model_id: 'kokoro-82m', input_char_count: 70000, cloned_voice_id: null }];
  try {
    const { startWorker, stopWorker } = await workerP;
    mock.timers.enable({ apis: ['setInterval'] });
    startWorker({ maxRetries: 3 });
    mock.timers.tick(30_000); // fires checkForStuckJobs once (and the 3 s poll loop, which finds nothing for this fake)
    mock.timers.reset();
    await new Promise(r => setTimeout(r, 50));
    stopWorker();
    assert.equal(failedWrites().length, 1);
    assert.equal(failedWrites()[0].body.p_error_code, 'STUCK_JOB');
    const stuck = reports.filter(r => r.err.message === 'STUCK_JOB');
    assert.equal(stuck.length, 1);
    assert.deepEqual(stuck[0].ctx, { provider: 'selfhosted', attempts: '3', chars_bucket: '50k+' });
  } finally { restore(); }
});
