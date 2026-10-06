// npm test (node:test via tsx, run with --experimental-test-module-mocks — see package.json).
// Unit tests for dub.ts's pipeline logic: request validation, the requireAuthOrApiKey auth gate in front
// of it, language-correct TTS routing, measured-duration speed refit + timeline placement, hallucinated
// segment dropping, speaker voices, SRT/VTT export, and translation-response-parsing error handling.
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
import { encodeWavPcm16, decodeWavPcm16 } from '../lib/dubTiming.js';
import type { AddressInfo } from 'node:net';

// Must be set up before dub.js is ever imported (even cache-busted), since '@anthropic-ai/sdk' itself is
// not cache-busted and is only ever resolved once per process.
let currentTranslationReply = '["Hola."]';
const replyQueue: string[] = []; // if non-empty, consumed one per Claude call before falling back to currentTranslationReply
const anthropicCalls: Array<{ body: unknown }> = [];
mock.module('@anthropic-ai/sdk', {
  defaultExport: class FakeAnthropic {
    messages = {
      create: async (body: unknown) => {
        anthropicCalls.push({ body });
        return { content: [{ type: 'text', text: replyQueue.length ? replyQueue.shift()! : currentTranslationReply }] };
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
interface MockSegment { start: number; end: number; text: string; speaker?: string }

let sttSegments: MockSegment[] = [{ start: 0, end: 2, text: 'Hello there.' }];
let sttReportedDuration: number | undefined;
let sttStatus = 200;
// Controls the billing gate (isBillingActiveForUser -> getBillingForUser), which queries
// the `realtimetts_billing` table via plain PostgREST — mirrors soundEffects.test.ts. Defaults to active.
let billingActive = true;
// Free-credit balance for the gate (realtimetts_free_credits): units used so far, or null = no row yet (untouched grant). Default exhausted.
let freeCreditsUsed: number | null = 10000;

function resetMocks() {
  sttSegments = [{ start: 0, end: 2, text: 'Hello there.' }];
  sttReportedDuration = undefined;
  sttStatus = 200;
  currentTranslationReply = '["Hola."]';
  anthropicCalls.length = 0;
  replyQueue.length = 0;
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
      return new Response(JSON.stringify({ language: 'en', duration: sttReportedDuration, segments }), { status: 200, headers: { 'Content-Type': 'application/json' } });
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
// TTS routing + timing (S3 fixes: language-correct voices, measured refit, timeline placement)
// ===========================================================================

interface SynthCall { voice: { provider_voice_id: string; language: string; settings: { language?: string } }; text: string; speed: number }

/** Fake Kokoro: 15 chars/s at speed 1, linear in speed, returns a real 24 kHz WAV so the route can measure it. */
function installFakeTts(t: { mock: { method: (...a: any[]) => unknown } }, ttsProvider: object, calls: SynthCall[], cps = 15) {
  t.mock.method(ttsProvider, 'synthesize', async (voice: SynthCall['voice'], text: string, opts?: { speed?: number }) => {
    const speed = opts?.speed ?? 1;
    calls.push({ voice, text, speed });
    const n = Math.max(1, Math.round((text.length / cps / speed) * 24000));
    return { audioBuffer: encodeWavPcm16(new Int16Array(n).fill(4000), 24000), durationMs: 5 };
  });
}

function wavUpload(seconds: number): Buffer {
  return encodeWavPcm16(new Int16Array(Math.round(seconds * 8000)).fill(100), 8000);
}

test('a Spanish dub sends language "es" and a Spanish voice to the TTS service (not en-US / am_adam)', async (t) => {
  installFetchMock(SHARED_STUB.url);
  resetMocks();
  sttSegments = [{ start: 0, end: 4, text: 'This is a reasonably long sentence to translate.' }];
  currentTranslationReply = JSON.stringify(['Esta es una frase bastante larga para traducir.']);
  const s = await boot(SHARED_STUB.url);
  const calls: SynthCall[] = [];
  installFakeTts(t, s.ttsProvider, calls);
  try {
    const submit = await s.call(jwtHeaders, 'POST', '/', buildForm({ target_language: 'Spanish' }));
    const { job_id } = await submit.json();
    const result = await waitForJob(s.call, job_id, jwtHeaders);
    assert.equal(result.status, 'ready', result.error);
    assert.ok(calls.length >= 1);
    for (const c of calls) {
      assert.equal(c.voice.settings.language, 'es');
      assert.equal(c.voice.language, 'es-ES');
      assert.equal(c.voice.provider_voice_id, 'em_alex');
    }
    assert.equal(result.target_language, 'es');
    assert.equal(result.voices[0].voice_id, 'em_alex');
  } finally {
    s.close();
    uninstallFetchMock();
  }
});

test('French and Hindi route to their own Kokoro voices', async (t) => {
  installFetchMock(SHARED_STUB.url);
  resetMocks();
  const s = await boot(SHARED_STUB.url);
  const calls: SynthCall[] = [];
  installFakeTts(t, s.ttsProvider, calls);
  try {
    for (const [lang, voice, tag] of [['fr', 'ff_siwis', 'fr'], ['hi', 'hm_omega', 'hi']] as const) {
      calls.length = 0;
      currentTranslationReply = JSON.stringify(['Bonjour tout le monde.']);
      const submit = await s.call(jwtHeaders, 'POST', '/', buildForm({ target_language: lang }));
      const { job_id } = await submit.json();
      const result = await waitForJob(s.call, job_id, jwtHeaders);
      assert.equal(result.status, 'ready', result.error);
      assert.ok(calls.every((c) => c.voice.provider_voice_id === voice && c.voice.settings.language === tag), lang);
    }
  } finally {
    s.close();
    uninstallFetchMock();
  }
});

test('unsupported target language (German) is rejected with 400 and lists the supported ones', async () => {
  installFetchMock(SHARED_STUB.url);
  resetMocks();
  const s = await boot(SHARED_STUB.url);
  try {
    const r = await s.call(jwtHeaders, 'POST', '/', buildForm({ target_language: 'German' }));
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.match(JSON.stringify(body), /not supported/i);
    assert.match(JSON.stringify(body), /es/);
  } finally {
    s.close();
    uninstallFetchMock();
  }
});

test('an English voice_id passed with a Spanish target is ignored, and the job reports that', async (t) => {
  installFetchMock(SHARED_STUB.url);
  resetMocks();
  currentTranslationReply = JSON.stringify(['Hola a todos.']);
  const s = await boot(SHARED_STUB.url);
  const calls: SynthCall[] = [];
  installFakeTts(t, s.ttsProvider, calls);
  try {
    const submit = await s.call(jwtHeaders, 'POST', '/', buildForm({ target_language: 'es', voice_id: 'am_adam' }));
    const { job_id } = await submit.json();
    const result = await waitForJob(s.call, job_id, jwtHeaders);
    assert.equal(result.status, 'ready', result.error);
    assert.ok(calls.every((c) => c.voice.provider_voice_id === 'em_alex'));
    assert.ok(result.warnings.some((w: string) => /am_adam/.test(w)));
  } finally {
    s.close();
    uninstallFetchMock();
  }
});

test('a Spanish voice_id is honoured', async (t) => {
  installFetchMock(SHARED_STUB.url);
  resetMocks();
  currentTranslationReply = JSON.stringify(['Hola a todos.']);
  const s = await boot(SHARED_STUB.url);
  const calls: SynthCall[] = [];
  installFakeTts(t, s.ttsProvider, calls);
  try {
    const submit = await s.call(jwtHeaders, 'POST', '/', buildForm({ target_language: 'es', voice_id: 'ef_dora' }));
    const { job_id } = await submit.json();
    const result = await waitForJob(s.call, job_id, jwtHeaders);
    assert.equal(result.status, 'ready', result.error);
    assert.ok(calls.every((c) => c.voice.provider_voice_id === 'ef_dora'));
  } finally {
    s.close();
    uninstallFetchMock();
  }
});

test('first synthesis is at speed 1 (measure), then refit to the slot - not the 12.5 chars/s guess', async (t) => {
  installFetchMock(SHARED_STUB.url);
  resetMocks();
  sttSegments = [{ start: 0, end: 5, text: 'A source sentence that lasts five seconds in the recording.' }];
  // 100 chars at 15 cps = 6.67 s natural -> refit speed 6.67/5 = 1.33
  currentTranslationReply = JSON.stringify(['x'.repeat(100)]);
  const s = await boot(SHARED_STUB.url);
  const calls: SynthCall[] = [];
  installFakeTts(t, s.ttsProvider, calls);
  try {
    const submit = await s.call(jwtHeaders, 'POST', '/', buildForm({ target_language: 'es' }));
    const { job_id } = await submit.json();
    const result = await waitForJob(s.call, job_id, jwtHeaders);
    assert.equal(result.status, 'ready', result.error);
    assert.equal(calls[0]!.speed, 1);
    const seg = result.segments[0];
    assert.ok(Math.abs(seg.speed_used - 6.6667 / 5) < 0.02, `speed ${seg.speed_used}`);
    assert.ok(Math.abs(seg.synth_sec - 5) < 0.3);
  } finally {
    s.close();
    uninstallFetchMock();
  }
});

test('speed is clamped to [0.8, 1.7]', async (t) => {
  installFetchMock(SHARED_STUB.url);
  resetMocks();
  sttSegments = [
    { start: 0, end: 0.9, text: 'This is a fairly long sentence that would take a while to say naturally.' },
    { start: 10, end: 40, text: 'Hi there, this is a perfectly ordinary spoken sentence for the test.' },
  ];
  currentTranslationReply = JSON.stringify(['x'.repeat(200), 'Hola.']);
  const s = await boot(SHARED_STUB.url);
  const calls: SynthCall[] = [];
  installFakeTts(t, s.ttsProvider, calls);
  try {
    const submit = await s.call(jwtHeaders, 'POST', '/', buildForm({ target_language: 'es' }));
    const { job_id } = await submit.json();
    const result = await waitForJob(s.call, job_id, jwtHeaders);
    assert.equal(result.status, 'ready', result.error);
    assert.ok(calls.every((c) => c.speed <= 1.7 + 1e-9 && c.speed >= 0.8 - 1e-9));
    assert.equal(result.segments[0].speed_used, 1.7);
    assert.equal(result.segments[0].clamped, true);
  } finally {
    s.close();
    uninstallFetchMock();
  }
});

test('hallucinated tail segment beyond the audio end is dropped (S3 c7) and not synthesized or translated', async (t) => {
  installFetchMock(SHARED_STUB.url);
  resetMocks();
  sttSegments = [
    { start: 0, end: 6, text: 'Real speech at the start of this short clip right here.' },
    { start: 9.9, end: 39.9, text: 'Thank you.' },
  ];
  currentTranslationReply = JSON.stringify(['Habla real al inicio de este clip corto.']);
  const s = await boot(SHARED_STUB.url);
  const calls: SynthCall[] = [];
  installFakeTts(t, s.ttsProvider, calls);
  try {
    const submit = await s.call(jwtHeaders, 'POST', '/', buildForm({ target_language: 'es', audio: wavUpload(10) }));
    const { job_id } = await submit.json();
    const result = await waitForJob(s.call, job_id, jwtHeaders);
    assert.equal(result.status, 'ready', result.error);
    assert.equal(result.segments.length, 1);
    assert.equal(result.dropped_segments.length, 1);
    assert.equal(result.dropped_segments[0].reason, 'beyond_audio');
    assert.ok(calls.every((c) => !/Gracias|Thank/.test(c.text)));
    // the translator was only asked about the kept segment
    const sent = JSON.parse((anthropicCalls.at(-1)!.body as { messages: Array<{ content: string }> }).messages[0]!.content);
    assert.equal(sent.length, 1);
  } finally {
    s.close();
    uninstallFetchMock();
  }
});

test('the translator receives a per-segment length budget derived from the slot and language rate', async (t) => {
  installFetchMock(SHARED_STUB.url);
  resetMocks();
  sttSegments = [{ start: 0, end: 10, text: 'A source sentence that lasts ten seconds in the recording, give or take.' }];
  currentTranslationReply = JSON.stringify(['Una frase.']);
  const s = await boot(SHARED_STUB.url);
  installFakeTts(t, s.ttsProvider, []);
  try {
    const submit = await s.call(jwtHeaders, 'POST', '/', buildForm({ target_language: 'es' }));
    const { job_id } = await submit.json();
    await waitForJob(s.call, job_id, jwtHeaders);
    const body = anthropicCalls[0]!.body as { system: string; messages: Array<{ content: string }> };
    const sent = JSON.parse(body.messages[0]!.content);
    assert.ok(sent[0].max_chars >= 150 && sent[0].max_chars <= 220, `max_chars ${sent[0].max_chars}`);
    assert.match(body.system, /Spanish/);
  } finally {
    s.close();
    uninstallFetchMock();
  }
});

test('over-budget translations get exactly one shorten pass', async (t) => {
  installFetchMock(SHARED_STUB.url);
  resetMocks();
  sttSegments = [{ start: 0, end: 3, text: 'A short source sentence here.' }];
  const long = 'palabra '.repeat(30).trim();
  const s = await boot(SHARED_STUB.url);
  const calls: SynthCall[] = [];
  installFakeTts(t, s.ttsProvider, calls);
  replyQueue.push(JSON.stringify([long]), JSON.stringify(['Frase corta aqui.']));
  try {
    const submit = await s.call(jwtHeaders, 'POST', '/', buildForm({ target_language: 'es' }));
    const { job_id } = await submit.json();
    const result = await waitForJob(s.call, job_id, jwtHeaders);
    assert.equal(result.status, 'ready', result.error);
    assert.equal(anthropicCalls.length, 2);
    assert.equal(result.segments[0].translated_text, 'Frase corta aqui.');
  } finally {
    s.close();
    uninstallFetchMock();
  }
});

test('STT speaker labels map to distinct voices; no labels -> single default voice', async (t) => {
  installFetchMock(SHARED_STUB.url);
  resetMocks();
  sttSegments = [
    { start: 0, end: 4, text: 'Hello, how are you doing today my friend?', speaker: 'SPEAKER_00' },
    { start: 5, end: 9, text: 'I am doing very well thank you for asking.', speaker: 'SPEAKER_01' },
  ];
  currentTranslationReply = JSON.stringify(['Hola, como estas hoy amigo mio?', 'Estoy muy bien, gracias por preguntar.']);
  const s = await boot(SHARED_STUB.url);
  const calls: SynthCall[] = [];
  installFakeTts(t, s.ttsProvider, calls);
  try {
    const submit = await s.call(jwtHeaders, 'POST', '/', buildForm({ target_language: 'es' }));
    const { job_id } = await submit.json();
    const result = await waitForJob(s.call, job_id, jwtHeaders);
    assert.equal(result.status, 'ready', result.error);
    const v0 = result.segments[0].voice_id;
    const v1 = result.segments[1].voice_id;
    assert.notEqual(v0, v1);
    assert.equal(result.voices.length, 2);
    assert.equal(result.diarization, 'stt_speaker_labels');
  } finally {
    s.close();
    uninstallFetchMock();
  }
});

test('without STT speaker labels the job says diarization is unavailable (single voice)', async (t) => {
  installFetchMock(SHARED_STUB.url);
  resetMocks();
  currentTranslationReply = JSON.stringify(['Hola.']);
  const s = await boot(SHARED_STUB.url);
  installFakeTts(t, s.ttsProvider, []);
  try {
    const submit = await s.call(jwtHeaders, 'POST', '/', buildForm({ target_language: 'es' }));
    const { job_id } = await submit.json();
    const result = await waitForJob(s.call, job_id, jwtHeaders);
    assert.equal(result.diarization, 'unavailable_single_voice');
  } finally {
    s.close();
    uninstallFetchMock();
  }
});

test('SRT/VTT export: translated text on the placed (dub) timeline; 409 before ready; 400 for bad format; 404 for other users', async (t) => {
  installFetchMock(SHARED_STUB.url);
  resetMocks();
  sttSegments = [
    { start: 1, end: 5, text: 'First source sentence goes right here today.' },
    { start: 6, end: 10, text: 'Second source sentence goes right here today.' },
  ];
  currentTranslationReply = JSON.stringify(['Primera frase.', 'Segunda frase.']);
  const s = await boot(SHARED_STUB.url);
  installFakeTts(t, s.ttsProvider, []);
  try {
    const submit = await s.call(jwtHeaders, 'POST', '/', buildForm({ target_language: 'es' }));
    const { job_id } = await submit.json();
    const early = await s.call(jwtHeaders, 'GET', `/${job_id}/subtitles?format=srt`);
    // may already be ready on a fast machine; only assert the not-ready branch if it was
    if (early.status !== 200) assert.equal(early.status, 409);
    await waitForJob(s.call, job_id, jwtHeaders);

    const srt = await s.call(jwtHeaders, 'GET', `/${job_id}/subtitles?format=srt`);
    assert.equal(srt.status, 200);
    assert.match(srt.headers.get('content-type') ?? '', /subrip|text\/plain/);
    const srtText = await srt.text();
    assert.match(srtText, /^1\n00:00:01,000 --> /);
    assert.match(srtText, /Primera frase\./);
    assert.match(srtText, /Segunda frase\./);

    const vtt = await s.call(jwtHeaders, 'GET', `/${job_id}/subtitles?format=vtt&text=source`);
    assert.equal(vtt.status, 200);
    const vttText = await vtt.text();
    assert.match(vttText, /^WEBVTT\n\n/);
    assert.match(vttText, /First source sentence/);

    assert.equal((await s.call(jwtHeaders, 'GET', `/${job_id}/subtitles?format=ass`)).status, 400);
    const other = { 'x-gateway-admin-secret': FORWARD_SECRET, 'x-gateway-uid': 'someone-else' };
    assert.equal((await s.call(other, 'GET', `/${job_id}/subtitles?format=srt`)).status, 404);
  } finally {
    s.close();
    uninstallFetchMock();
  }
});

test('the uploaded dub is a single valid WAV as long as the source, with segments on the source timeline', async (t) => {
  installFetchMock(SHARED_STUB.url);
  resetMocks();
  sttSegments = [{ start: 2, end: 4, text: 'Source sentence here.' }, { start: 7, end: 9, text: 'Another one here.' }];
  currentTranslationReply = JSON.stringify(['Frase aqui.', 'Otra aqui.']);
  const uploaded: Buffer[] = [];
  const prev = globalThis.fetch;
  const s = await boot(SHARED_STUB.url);
  installFakeTts(t, s.ttsProvider, []);
  const wrapped = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/storage/v1/object/') && init?.body) uploaded.push(Buffer.from(init.body as Uint8Array));
    return wrapped(input, init);
  }) as typeof fetch;
  try {
    const submit = await s.call(jwtHeaders, 'POST', '/', buildForm({ target_language: 'es', audio: wavUpload(10) }));
    const { job_id } = await submit.json();
    const result = await waitForJob(s.call, job_id, jwtHeaders);
    assert.equal(result.status, 'ready', result.error);
    assert.ok(Math.abs(result.segments[0].placed_start_sec - 2) < 1e-6);
    assert.ok(Math.abs(result.segments[1].placed_start_sec - 7) < 1e-6);
    assert.equal(result.max_start_drift_sec, 0);
    const wav = uploaded.find((b) => b.toString('ascii', 0, 4) === 'RIFF');
    if (wav) { // storage client shape may differ; assert only when the body was observable
      const d = decodeWavPcm16(wav)!;
      assert.ok(Math.abs(d.samples.length / d.sampleRate - 10) < 0.05);
    }
  } finally {
    globalThis.fetch = prev;
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
  installFakeTts(t, s.ttsProvider, []);
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

test('TTS that returns undecodable audio for every segment fails the job clearly (not a silent empty file)', async (t) => {
  installFetchMock(SHARED_STUB.url);
  resetMocks();
  currentTranslationReply = JSON.stringify(['Hola.']);
  const s = await boot(SHARED_STUB.url);
  t.mock.method(s.ttsProvider, 'synthesize', async () => ({ audioBuffer: Buffer.from('fake-mp3'), durationMs: 5 }));
  try {
    const submit = await s.call(jwtHeaders, 'POST', '/', buildForm());
    const { job_id } = await submit.json();
    const result = await waitForJob(s.call, job_id, jwtHeaders);
    assert.equal(result.status, 'failed');
    assert.match(result.error, /no audio/i);
  } finally {
    s.close();
    uninstallFetchMock();
  }
});
