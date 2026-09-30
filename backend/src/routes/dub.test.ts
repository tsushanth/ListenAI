// npm test (node:test via tsx, run with --experimental-test-module-mocks — see package.json).
// Unit tests for dub.ts's pipeline logic: request validation, the requireAuthOrApiKey auth gate in front
// of it, segment-timing speed-clamping (0.5x-2.0x), and translation-response-parsing error handling.
//
// Pattern, matching voiceConvert.test.ts / apiKeyAuth.test.ts: boot a real express server with
// app.listen(0) and hit it over the network with fetch. Supabase auth and the STT worker are
// intercepted via a patched global.fetch — nothing real is ever called there. Anthropic/Claude is NOT
// reachable through global.fetch (the SDK's Node runtime shim uses `node-fetch` directly, not
// globalThis.fetch), so it's mocked at the module level instead via node:test's mock.module. TTS
// synthesis (ttsProvider.synthesize, axios-based) is mocked directly via t.mock.method, since it's a
// plain exported singleton method.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';

// Must be set up before dub.js is ever imported (even cache-busted), since '@anthropic-ai/sdk' itself is
// not cache-busted and is only ever resolved once per process.
let currentTranslationReply = '["Hola."]';
const anthropicCalls: Array<{ body: unknown }> = [];
mock.module('@anthropic-ai/sdk', {
  defaultExport: class FakeAnthropic {
    messages = {
      create: async (body: unknown) => {
        anthropicCalls.push({ body });
        return { content: [{ type: 'text', text: currentTranslationReply }] };
      },
    };
  },
});

const FORWARD_SECRET = 'test-forward-secret';
const VALID_JWT = 'valid-jwt-for-user-1';
const JWT_USER_ID = 'user-jwt-1';
const STT_URL = 'https://stt-worker.example.test';

process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';
process.env.STT_GATEWAY_URL = STT_URL;
process.env.STT_API_KEY = 'stt-secret';
process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
process.env.GATEWAY_FORWARD_SECRET = FORWARD_SECRET;

// ---------------------------------------------------------------------------
// Stub Supabase auth server (for requireAuthOrApiKey's JWT path)
// ---------------------------------------------------------------------------
function bootStubSupabase() {
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization ?? '';
    if (req.url === '/auth/v1/user' && auth === `Bearer ${VALID_JWT}`) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: JWT_USER_ID }));
      return;
    }
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid' }));
  });
  server.listen(0);
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

// A single shared stub Supabase server for the whole file: config.ts reads SUPABASE_URL once at first
// import and every boot() below imports dub.ts/apiKeyAuth.ts with a cache-busted specifier but not
// config.js itself, so config.js's SUPABASE_URL is fixed for the life of this process — recreating the
// stub per test (on a new random port) would leave later tests pointed at an already-closed server.
const SHARED_STUB = bootStubSupabase();
process.env.SUPABASE_URL = SHARED_STUB.url;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
test.after(() => SHARED_STUB.close());

// ---------------------------------------------------------------------------
// Mock state for STT + translation responses
// ---------------------------------------------------------------------------
interface MockSegment { start: number; end: number; text: string }

let sttSegments: MockSegment[] = [{ start: 0, end: 2, text: 'Hello there.' }];
let sttStatus = 200;
// Controls the billing gate (isBillingActiveForUser -> getBillingForUser), which queries
// the `realtimetts_billing` table via plain PostgREST — mirrors soundEffects.test.ts. Defaults to active.
let billingActive = true;
// Free-credit balance for the gate (realtimetts_free_credits): units used so far, or null = no row yet (untouched grant). Default exhausted.
let freeCreditsUsed: number | null = 10000;

function resetMocks() {
  sttSegments = [{ start: 0, end: 2, text: 'Hello there.' }];
  sttStatus = 200;
  currentTranslationReply = '["Hola."]';
  anthropicCalls.length = 0;
  billingActive = true;
  freeCreditsUsed = 10000;
}

let originalFetch: typeof globalThis.fetch;

function installFetchMock(supabaseUrl: string) {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();

    // Supabase auth
    if (url === `${supabaseUrl}/auth/v1/user`) {
      const auth = (init?.headers as Record<string, string>)?.['Authorization'] ?? '';
      if (auth === `Bearer ${VALID_JWT}`) {
        return new Response(JSON.stringify({ id: JWT_USER_ID }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: 'invalid' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    // Billing gate (isBillingActiveForUser -> getBillingForUser)
    if (url.startsWith(`${supabaseUrl}/rest/v1/realtimetts_billing`)) {
      const u = new URL(url);
      const uid = u.searchParams.get('user_id')?.replace(/^eq\./, '');
      if (billingActive && uid) {
        return new Response(JSON.stringify([{
          user_id: uid,
          stripe_customer_id: `cus_${uid}`,
          stripe_subscription_id: 'sub_test',
          stripe_subscription_item_id: 'si_test',
          active: true,
        }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Free-credit gate (hasUsageAllowance -> getFreeCredits)
    if (url.startsWith(`${supabaseUrl}/rest/v1/realtimetts_free_credits`)) {
      const rows = freeCreditsUsed === null ? [] : [{ granted: 10000, used: freeCreditsUsed }];
      return new Response(JSON.stringify(rows), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // STT gateway authorize hand-off (POST {key, mode} -> {token, url})
    if (url === `${STT_URL}/stt/authorize`) {
      return new Response(JSON.stringify({ token: 'stt-session-token', url: STT_URL }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // STT worker itself (raw audio bytes -> transcript+segments)
    if (url.startsWith(`${STT_URL}/v1/stt`)) {
      if (sttStatus !== 200) {
        return new Response('worker error', { status: sttStatus });
      }
      const segments = sttSegments.map((s, i) => ({ id: i, ...s }));
      return new Response(JSON.stringify({ language: 'en', segments }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Supabase storage (uploadAudioToCache / getSignedAudioUrl) and anything else Supabase-related.
    if (url.includes('/storage/v1/')) {
      if (url.includes('/sign/') || url.includes('createSignedUrl')) {
        return new Response(JSON.stringify({ signedURL: '/object/sign/audio-cache/fake?token=abc' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ Key: 'audio-cache/fake' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

function uninstallFetchMock() {
  globalThis.fetch = originalFetch;
}

// ---------------------------------------------------------------------------
// Boot helpers
// ---------------------------------------------------------------------------
async function boot(supabaseUrl: string) {
  process.env.SUPABASE_URL = supabaseUrl;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';

  // Fresh module graph per boot() so config.ts / dub.ts re-read env for this test run.
  const bust = `?t=${Date.now()}-${Math.random()}`;
  const [{ requireAuthOrApiKey }, { dubRouter }, ttsProviderModule, { errorHandler }] = await Promise.all([
    import(`../middleware/apiKeyAuth.js${bust}`),
    import(`./dub.js${bust}`),
    import(`../lib/ttsProviderClient.js${bust}`),
    import('../middleware/errorHandler.js'),
  ]);

  const app = express();
  app.use(express.json());
  app.use('/api/dub', requireAuthOrApiKey, dubRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/dub`;

  const call = (headers: Record<string, string>, method: string, path: string, body?: FormData | object) =>
    originalFetch(base + path, {
      method,
      headers,
      body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
    });

  return { call, close: () => server.close(), ttsProvider: ttsProviderModule.ttsProvider };
}

function buildForm(opts: { audio?: Buffer; mimetype?: string; target_language?: string; source_language?: string; voice_id?: string; filename?: string } = {}) {
  const form = new FormData();
  const audio = opts.audio ?? Buffer.alloc(2048, 1);
  if (opts.audio !== null) {
    form.append('audio', new Blob([audio], { type: opts.mimetype ?? 'audio/wav' }), opts.filename ?? 'source.wav');
  }
  if (opts.target_language !== null) form.append('target_language', opts.target_language ?? 'es');
  if (opts.source_language) form.append('source_language', opts.source_language);
  if (opts.voice_id) form.append('voice_id', opts.voice_id);
  return form;
}

const jwtHeaders = { authorization: `Bearer ${VALID_JWT}` };
const gatewayHeaders = { 'x-gateway-admin-secret': FORWARD_SECRET, 'x-gateway-uid': JWT_USER_ID };

async function waitForJob(call: ReturnType<typeof boot> extends Promise<infer T> ? T['call'] : never, jobId: string, headers: Record<string, string>, timeoutMs = 3000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await call(headers, 'GET', `/${jobId}`);
    const body = await r.json();
    if (body.status === 'ready' || body.status === 'failed') return body;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error('job did not settle in time');
}

// ===========================================================================
// Auth gate
// ===========================================================================

test('POST /api/dub with no credentials -> 401 (requireAuthOrApiKey gate)', async () => {
  installFetchMock(SHARED_STUB.url);
  resetMocks();
  const s = await boot(SHARED_STUB.url);
  try {
    const r = await s.call({}, 'POST', '/', buildForm());
    assert.equal(r.status, 401);
  } finally {
    s.close();
    uninstallFetchMock();
  }
});

test('POST /api/dub with no billing but free credits remaining -> accepted (202)', async () => {
  installFetchMock(SHARED_STUB.url);
  resetMocks();
  billingActive = false;
  freeCreditsUsed = null; // brand-new user: untouched grant
  const s = await boot(SHARED_STUB.url);
  try {
    const r = await s.call(jwtHeaders, 'POST', '/', buildForm());
    assert.equal(r.status, 202);
  } finally {
    s.close();
    uninstallFetchMock();
  }
});

test('POST /api/dub with an invalid JWT -> 401, not the default-user fallback', async () => {
  installFetchMock(SHARED_STUB.url);
  resetMocks();
  const s = await boot(SHARED_STUB.url);
  try {
    const r = await s.call({ authorization: 'Bearer garbage' }, 'POST', '/', buildForm());
    assert.equal(r.status, 401);
  } finally {
    s.close();
    uninstallFetchMock();
  }
});

test('POST /api/dub with gateway-forwarded API key identity is accepted (no JWT needed)', async () => {
  installFetchMock(SHARED_STUB.url);
  resetMocks();
  const s = await boot(SHARED_STUB.url);
  try {
    const r = await s.call(gatewayHeaders, 'POST', '/', buildForm());
    assert.equal(r.status, 202);
    const body = await r.json();
    assert.ok(body.job_id);
    assert.equal(body.status, 'processing');
  } finally {
    s.close();
    uninstallFetchMock();
  }
});

test('POST /api/dub with no active TTS subscription -> 402, job never created', async () => {
  installFetchMock(SHARED_STUB.url);
  resetMocks();
  billingActive = false;
  const s = await boot(SHARED_STUB.url);
  try {
    const r = await s.call(jwtHeaders, 'POST', '/', buildForm());
    assert.equal(r.status, 402);
    const body = await r.json();
    assert.match(body.error, /free credits are used up/i);
    assert.match(body.error, /readaloudai\.org\/developers#get-started/);
  } finally {
    s.close();
    uninstallFetchMock();
  }
});

// ===========================================================================
// Request validation
// ===========================================================================

test('missing audio file -> 400', async () => {
  installFetchMock(SHARED_STUB.url);
  resetMocks();
  const s = await boot(SHARED_STUB.url);
  try {
    const r = await s.call(jwtHeaders, 'POST', '/', buildForm({ audio: null as unknown as Buffer }));
    assert.equal(r.status, 400);
  } finally {
    s.close();
    uninstallFetchMock();
  }
});

test('audio file too small -> 400', async () => {
  installFetchMock(SHARED_STUB.url);
  resetMocks();
  const s = await boot(SHARED_STUB.url);
  try {
    const r = await s.call(jwtHeaders, 'POST', '/', buildForm({ audio: Buffer.alloc(10) }));
    assert.equal(r.status, 400);
  } finally {
    s.close();
    uninstallFetchMock();
  }
});

test('unsupported audio mimetype -> 400', async () => {
  installFetchMock(SHARED_STUB.url);
  resetMocks();
  const s = await boot(SHARED_STUB.url);
  try {
    const r = await s.call(jwtHeaders, 'POST', '/', buildForm({ mimetype: 'image/png' }));
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.match(body.message ?? body.error, /Unsupported audio format/);
  } finally {
    s.close();
    uninstallFetchMock();
  }
});

test('missing target_language -> 400', async () => {
  installFetchMock(SHARED_STUB.url);
  resetMocks();
  const s = await boot(SHARED_STUB.url);
  try {
    const r = await s.call(jwtHeaders, 'POST', '/', buildForm({ target_language: null as unknown as string }));
    assert.equal(r.status, 400);
  } finally {
    s.close();
    uninstallFetchMock();
  }
});

test('GET /api/dub/:jobId for a job owned by a different user -> 404', async () => {
  installFetchMock(SHARED_STUB.url);
  resetMocks();
  const s = await boot(SHARED_STUB.url);
  try {
    const submit = await s.call(jwtHeaders, 'POST', '/', buildForm());
    const { job_id } = await submit.json();
    const r = await s.call(gatewayHeaders, 'GET', `/${job_id}`); // gatewayHeaders resolves to the same uid on purpose below
    // Sanity: same uid as JWT_USER_ID, so this actually should succeed — assert that, then check a truly different id.
    assert.equal(r.status, 200);

    const otherHeaders = { 'x-gateway-admin-secret': FORWARD_SECRET, 'x-gateway-uid': 'someone-else' };
    const r2 = await s.call(otherHeaders, 'GET', `/${job_id}`);
    assert.equal(r2.status, 404);
  } finally {
    s.close();
    uninstallFetchMock();
  }
});

// ===========================================================================
// Segment-timing speed-clamping (0.5x - 2.0x)
// ===========================================================================

test('a segment that needs much faster speech than natural speed clamps at 2.0x, not higher', async (t) => {
  installFetchMock(SHARED_STUB.url);
  resetMocks();
  // A long segment of text crammed into a very short window forces the naive speed estimate
  // (naturalDuration / targetDuration) far above 2.0x; dub.ts must clamp it to MAX_SPEED (2.0).
  sttSegments = [{ start: 0, end: 0.2, text: 'This is a fairly long sentence that would take a while to say naturally.' }];
  currentTranslationReply = JSON.stringify(['Esta es una oracion bastante larga que tomaria un tiempo decir naturalmente.']);

  const s = await boot(SHARED_STUB.url);
  const speedsUsed: number[] = [];
  t.mock.method(s.ttsProvider, 'synthesize', async (_voice: unknown, _text?: unknown, opts?: { speed?: number }) => {
    // dub.ts's synthesizeSegment calls ttsProvider.synthesize(voice, text, { speed, format }).
    const speed = (opts as { speed?: number } | undefined)?.speed ?? 1;
    speedsUsed.push(speed);
    return { audioBuffer: Buffer.from('fake-mp3'), durationMs: 500 };
  });
  try {
    const submit = await s.call(jwtHeaders, 'POST', '/', buildForm());
    const { job_id } = await submit.json();
    const result = await waitForJob(s.call, job_id, jwtHeaders);
    assert.equal(result.status, 'ready');
    assert.equal(result.segments.length, 1);
    assert.equal(result.segments[0].speed_used, 2.0);
    assert.ok(speedsUsed.every((sp) => sp <= 2.0 && sp >= 0.5));
  } finally {
    s.close();
    uninstallFetchMock();
  }
});

test('a segment with a very long target window clamps speed at 0.5x, not lower', async (t) => {
  installFetchMock(SHARED_STUB.url);
  resetMocks();
  // A short segment of text stretched over a very long window forces the naive speed estimate
  // far below 0.5x; dub.ts must clamp it to MIN_SPEED (0.5).
  sttSegments = [{ start: 0, end: 30, text: 'Hi.' }];
  currentTranslationReply = JSON.stringify(['Hola.']);

  const s = await boot(SHARED_STUB.url);
  t.mock.method(s.ttsProvider, 'synthesize', async () => ({ audioBuffer: Buffer.from('fake-mp3'), durationMs: 200 }));
  try {
    const submit = await s.call(jwtHeaders, 'POST', '/', buildForm());
    const { job_id } = await submit.json();
    const result = await waitForJob(s.call, job_id, jwtHeaders);
    assert.equal(result.status, 'ready');
    assert.equal(result.segments[0].speed_used, 0.5);
  } finally {
    s.close();
    uninstallFetchMock();
  }
});

// ===========================================================================
// Translation-response parsing / error handling
// ===========================================================================

test('non-JSON translation response fails the job with a clear error, not a crash', async () => {
  installFetchMock(SHARED_STUB.url);
  resetMocks();
  currentTranslationReply = 'this is not json at all';

  const s = await boot(SHARED_STUB.url);
  try {
    const submit = await s.call(jwtHeaders, 'POST', '/', buildForm());
    const { job_id } = await submit.json();
    const result = await waitForJob(s.call, job_id, jwtHeaders);
    assert.equal(result.status, 'failed');
    assert.match(result.error, /not valid JSON/i);
  } finally {
    s.close();
    uninstallFetchMock();
  }
});

test('translation response with the wrong number of entries fails the job', async () => {
  installFetchMock(SHARED_STUB.url);
  resetMocks();
  sttSegments = [{ start: 0, end: 1, text: 'One.' }, { start: 1, end: 2, text: 'Two.' }];
  currentTranslationReply = JSON.stringify(['Uno.']); // only 1 entry for 2 segments

  const s = await boot(SHARED_STUB.url);
  try {
    const submit = await s.call(jwtHeaders, 'POST', '/', buildForm());
    const { job_id } = await submit.json();
    const result = await waitForJob(s.call, job_id, jwtHeaders);
    assert.equal(result.status, 'failed');
    assert.match(result.error, /expected 2/);
  } finally {
    s.close();
    uninstallFetchMock();
  }
});

test('a translation response fenced in a ```json code block is still parsed correctly', async (t) => {
  installFetchMock(SHARED_STUB.url);
  resetMocks();
  currentTranslationReply = '```json\n["Hola."]\n```';

  const s = await boot(SHARED_STUB.url);
  t.mock.method(s.ttsProvider, 'synthesize', async () => ({ audioBuffer: Buffer.from('fake-mp3'), durationMs: 200 }));
  try {
    const submit = await s.call(jwtHeaders, 'POST', '/', buildForm());
    const { job_id } = await submit.json();
    const result = await waitForJob(s.call, job_id, jwtHeaders);
    assert.equal(result.status, 'ready');
    assert.equal(result.segments[0].translated_text, 'Hola.');
  } finally {
    s.close();
    uninstallFetchMock();
  }
});

test('STT worker failure fails the job rather than throwing unhandled', async () => {
  installFetchMock(SHARED_STUB.url);
  resetMocks();
  sttStatus = 500;

  const s = await boot(SHARED_STUB.url);
  try {
    const submit = await s.call(jwtHeaders, 'POST', '/', buildForm());
    const { job_id } = await submit.json();
    const result = await waitForJob(s.call, job_id, jwtHeaders);
    assert.equal(result.status, 'failed');
    assert.match(result.error, /500/);
  } finally {
    s.close();
    uninstallFetchMock();
  }
});
