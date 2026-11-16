import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoutingServiceClient, createServiceClient, serviceClientFromEnv, ServiceUnavailableError } from './serviceClient.js';
import { asrFromEnv, createGatewayAsr } from './asrClient.js';

type Call = { url: string; init: RequestInit };
function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { impl, calls };
}
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });

test('serviceClientFromEnv is null (feature dark) unless both URL and secret are set', () => {
  assert.equal(serviceClientFromEnv({}), null);
  assert.equal(serviceClientFromEnv({ VOICE_CLONE_SERVICE_URL: 'https://x' }), null);
  assert.ok(serviceClientFromEnv({ VOICE_CLONE_SERVICE_URL: 'https://x', VOICE_CLONE_SERVICE_SECRET: 's' }));
});

test('analyze maps snake_case metrics and sends the bearer secret', async () => {
  const m = mockFetch(() => json({ duration_sec: 12.5, speech_sec: 10, snr_db: 22, clipping_ratio: 0, min_window_similarity: null, music_prob: 0.01 }));
  const c = createServiceClient({ baseUrl: 'https://svc.test/', secret: 'sek', fetchImpl: m.impl });
  const r = await c.analyze(Buffer.from('a'), 'ref.wav');
  assert.deepEqual(r, { durationSec: 12.5, speechSec: 10, snrDb: 22, clippingRatio: 0, minWindowSimilarity: null, musicProb: 0.01 });
  assert.equal(m.calls[0]!.url, 'https://svc.test/analyze');
  assert.equal((m.calls[0]!.init.headers as Record<string, string>).Authorization, 'Bearer sek');
});

test('analyze rejects malformed metrics rather than passing NaN into the gate', async () => {
  const m = mockFetch(() => json({ duration_sec: 'x' }));
  const c = createServiceClient({ baseUrl: 'https://svc.test', secret: 's', fetchImpl: m.impl });
  await assert.rejects(c.analyze(Buffer.from('a'), 'a'), ServiceUnavailableError);
});

test('similarity returns the cosine, errors on bad payload and on HTTP failure', async () => {
  const ok = createServiceClient({ baseUrl: 'https://svc.test', secret: 's', fetchImpl: mockFetch(() => json({ similarity: 0.61 })).impl });
  assert.equal(await ok.similarity(Buffer.from('a'), Buffer.from('b')), 0.61);
  const bad = createServiceClient({ baseUrl: 'https://svc.test', secret: 's', fetchImpl: mockFetch(() => json({})).impl });
  await assert.rejects(bad.similarity(Buffer.from('a'), Buffer.from('b')), ServiceUnavailableError);
  const down = createServiceClient({ baseUrl: 'https://svc.test', secret: 's', fetchImpl: mockFetch(() => new Response('no', { status: 500 })).impl });
  await assert.rejects(down.similarity(Buffer.from('a'), Buffer.from('b')), /HTTP 500/);
});

test('synthesize returns wav bytes plus watermark metadata from headers', async () => {
  const m = mockFetch(() => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'X-Watermark-Score': '0.97', 'X-Watermark-Scheme': 'perth', 'X-Sample-Rate': '24000', 'X-Model-Id': 'chatterbox-mtl-v3' } }));
  const c = createServiceClient({ baseUrl: 'https://svc.test', secret: 's', fetchImpl: m.impl });
  const r = await c.synthesize({ voiceId: 'v 1', text: 'hi', language: 'en', speed: 1.25 });
  assert.deepEqual([...r.audio], [1, 2, 3]);
  assert.equal(r.watermarkScore, 0.97);
  assert.equal(r.watermarkScheme, 'perth');
  assert.equal(m.calls[0]!.url, 'https://svc.test/voices/v%201/synthesize');
  assert.deepEqual(JSON.parse(m.calls[0]!.init.body as string), { text: 'hi', language: 'en', speed: 1.25 });
});

test('deleteVoice is idempotent on 404 but fails loudly on 5xx or network error', async () => {
  const gone = createServiceClient({ baseUrl: 'https://svc.test', secret: 's', fetchImpl: mockFetch(() => new Response('', { status: 404 })).impl });
  await gone.deleteVoice('v');
  const err = createServiceClient({ baseUrl: 'https://svc.test', secret: 's', fetchImpl: mockFetch(() => new Response('', { status: 500 })).impl });
  await assert.rejects(err.deleteVoice('v'), ServiceUnavailableError);
  const net = createServiceClient({ baseUrl: 'https://svc.test', secret: 's', fetchImpl: (async () => { throw new Error('ECONNRESET'); }) as typeof fetch });
  await assert.rejects(net.deleteVoice('v'), ServiceUnavailableError);
});

test('gateway ASR authorizes, posts audio, returns text (and joins segments if no text)', async () => {
  const m = mockFetch((url) => {
    if (url.endsWith('/stt/authorize')) return json({ token: 'tok', url: 'https://stt.test' });
    return json({ segments: [{ text: 'hello' }, { text: 'world' }] });
  });
  const asr = createGatewayAsr({ gatewayUrl: 'https://gw.test', apiKey: 'k', fetchImpl: m.impl });
  assert.equal(await asr.transcribe(Buffer.from('x'), 'audio/wav', 'en'), 'hello world');
  assert.equal(m.calls[1]!.url, 'https://stt.test/v1/stt?language=en');
  assert.equal((m.calls[1]!.init.headers as Record<string, string>).Authorization, 'Bearer tok');
  assert.equal(asrFromEnv({}), null);
});

test('gateway ASR: a token that expired during a cold start (401) is replaced and the call retried once; other errors are not retried; warm never throws', async () => {
  let stt = 0, auth = 0;
  const m = mockFetch((url) => {
    if (url.endsWith('/stt/authorize')) { auth++; return json({ token: 'tok' + auth, url: 'https://stt.test' }); }
    if (url.includes('/v1/stt')) { stt++; return stt === 1 ? new Response('{}', { status: 401 }) : json({ text: 'hello' }); }
    return json({});
  });
  const asr = createGatewayAsr({ gatewayUrl: 'https://gw.test', apiKey: 'k', fetchImpl: m.impl });
  assert.equal(await asr.transcribe(Buffer.from('x'), 'audio/wav', 'en'), 'hello');
  assert.equal(auth, 2); assert.equal(stt, 2);
  assert.equal((m.calls.filter((c) => c.url.includes('/v1/stt')).at(-1)!.init.headers as Record<string, string>).Authorization, 'Bearer tok2');
  const bad = createGatewayAsr({ gatewayUrl: 'https://gw.test', apiKey: 'k', fetchImpl: mockFetch((url) => (url.endsWith('/stt/authorize') ? json({ token: 't', url: 'https://stt.test' }) : new Response('', { status: 500 }))).impl });
  await assert.rejects(bad.transcribe(Buffer.from('x'), 'audio/wav', 'en'));
  const down = createGatewayAsr({ gatewayUrl: 'https://gw.test', apiKey: 'k', fetchImpl: (async () => { throw new Error('offline'); }) as typeof fetch });
  await down.warm!(); // swallowed
  const w = mockFetch((url) => (url.endsWith('/stt/authorize') ? json({ token: 't', url: 'https://stt.test' }) : json({ ok: true })));
  await createGatewayAsr({ gatewayUrl: 'https://gw.test', apiKey: 'k', fetchImpl: w.impl }).warm!();
  assert.ok(w.calls.some((c) => c.url === 'https://stt.test/health'));
});

test('routing client: ML languages go to the multilingual app, the rest stay on the primary (reference gate pinned to the primary here)', async () => {
  const wav = Buffer.alloc(100);
  const a = mockFetch((url) => (url.endsWith('/voices') ? json({ reference_sec: 9 }) : url.endsWith('/analyze') ? json({ duration_sec: 9, speech_sec: 8, snr_db: 30, clipping_ratio: 0, min_window_similarity: 0.9, music_prob: 0 }) : new Response(wav, { status: 200, headers: { 'X-Sample-Rate': '24000' } })));
  const b = mockFetch((url) => (url.endsWith('/voices') ? json({ reference_sec: 11 }) : new Response(wav, { status: 200, headers: { 'X-Sample-Rate': '24000', 'X-Model-Id': 'ml' } })));
  const env = { VOICE_CLONE_SERVICE_URL: 'https://primary.test', VOICE_CLONE_SERVICE_SECRET: 'p', VOICE_CLONE_ML_SERVICE_URL: 'https://ml.test', VOICE_CLONE_ML_SERVICE_SECRET: 'm' };
  const primary = createServiceClient({ baseUrl: env.VOICE_CLONE_SERVICE_URL, secret: 'p', fetchImpl: a.impl });
  const ml = createServiceClient({ baseUrl: env.VOICE_CLONE_ML_SERVICE_URL, secret: 'm', fetchImpl: b.impl });
  const c = createRoutingServiceClient({ primary, ml, mlLanguages: new Set(['de', 'fr']), analyzeOn: 'primary' });
  await c.analyze(Buffer.from('x'), 'r.wav');
  assert.equal(a.calls.length, 1); assert.equal(b.calls.length, 0);
  assert.equal((await c.createVoice({ voiceId: 'v1', audio: Buffer.from('x'), filename: 'r.wav', language: 'de' })).referenceSec, 11);
  assert.equal((await c.createVoice({ voiceId: 'v2', audio: Buffer.from('x'), filename: 'r.wav', language: 'en' })).referenceSec, 9);
  await c.synthesize({ voiceId: 'v1', text: 'Hallo', language: 'de' });
  assert.ok(b.calls.some((x) => x.url === 'https://ml.test/voices/v1/synthesize'));
  assert.ok(!a.calls.some((x) => x.url.includes('/voices/v1/')));
  await c.deleteVoice('v1', 'de');
  assert.equal(b.calls.at(-1)!.init.method, 'DELETE');
  assert.equal(a.calls.filter((x) => x.init.method === 'DELETE').length, 0);
});

test('routing client: unknown-language delete and takedown go to both apps, one app failing a takedown is tolerated, both failing is not', async () => {
  const ok = mockFetch(() => new Response('', { status: 200 }));
  const gone = mockFetch(() => new Response('', { status: 404 }));
  const down = mockFetch(() => new Response('x', { status: 500 }));
  const mk = (p: ReturnType<typeof mockFetch>, m: ReturnType<typeof mockFetch>) => createRoutingServiceClient({
    primary: createServiceClient({ baseUrl: 'https://p.test', secret: 's', fetchImpl: p.impl }),
    ml: createServiceClient({ baseUrl: 'https://m.test', secret: 's', fetchImpl: m.impl }), mlLanguages: new Set(['de']) });
  await mk(ok, gone).deleteVoice('v');   // 404 on the app that never held it is "already gone"
  assert.equal(ok.calls.length + gone.calls.length, 2);
  await mk(ok, down).disableVoice('v');  // takedown landed on one app
  await assert.rejects(mk(down, down).disableVoice('v'));
  await assert.rejects(mk(ok, down).deleteVoice('v'));  // a delete that failed on either app is reported
});

test('serviceClientFromEnv: only the multilingual app configured is used for everything; both configured routes by language', () => {
  assert.ok(serviceClientFromEnv({ VOICE_CLONE_ML_SERVICE_URL: 'https://m', VOICE_CLONE_ML_SERVICE_SECRET: 's' }));
  assert.ok(serviceClientFromEnv({ VOICE_CLONE_SERVICE_URL: 'https://p', VOICE_CLONE_SERVICE_SECRET: 's', VOICE_CLONE_ML_SERVICE_URL: 'https://m', VOICE_CLONE_ML_SERVICE_SECRET: 's' }));
  assert.equal(serviceClientFromEnv({ VOICE_CLONE_ML_SERVICE_URL: 'https://m' }), null);
});

const GATE_JSON = { duration_sec: 9, speech_sec: 8, snr_db: 30, clipping_ratio: 0, min_window_similarity: 0.9, music_prob: 0.01 };
const mkRouting = (p: ReturnType<typeof mockFetch>, m: ReturnType<typeof mockFetch>, extra: Record<string, unknown> = {}) => createRoutingServiceClient({
  primary: createServiceClient({ baseUrl: 'https://p.test', secret: 's', fetchImpl: p.impl }),
  ml: createServiceClient({ baseUrl: 'https://m.test', secret: 's', fetchImpl: m.impl }), mlLanguages: new Set(['de']), ...extra });

test('routing client: the reference gate and speaker similarity run on the multilingual app by default and never touch the primary', async () => {
  const p = mockFetch(() => new Response('x', { status: 500 }));
  const m = mockFetch((url) => (url.endsWith('/analyze') ? json(GATE_JSON) : json({ similarity: 0.71 })));
  const c = mkRouting(p, m);
  assert.equal((await c.analyze(Buffer.from('x'), 'r.wav')).durationSec, 9);
  assert.equal(await c.similarity(Buffer.from('a'), Buffer.from('b')), 0.71);
  assert.equal(p.calls.length, 0); assert.equal(m.calls.length, 2);
});

test('routing client: if the multilingual app is down the gate falls back to the primary; a plain error that is not "unavailable" is not swallowed', async () => {
  const p = mockFetch((url) => (url.endsWith('/analyze') ? json(GATE_JSON) : json({ similarity: 0.5 })));
  const down = mockFetch(() => new Response('x', { status: 503 }));
  const c = mkRouting(p, down);
  assert.equal((await c.analyze(Buffer.from('x'), 'r.wav')).speechSec, 8);
  assert.equal(await c.similarity(Buffer.from('a'), Buffer.from('b')), 0.5);
  assert.equal(down.calls.length, 2); assert.equal(p.calls.length, 2);
  const bad = mockFetch(() => json({ duration_sec: 'nope' })); // malformed answer is a ServiceUnavailableError too: falls back, the primary decides
  assert.equal((await mkRouting(p, bad).analyze(Buffer.from('x'), 'r.wav')).durationSec, 9);
});

test('routing client: analyzeOn primary keeps the gate on the primary (kill switch), and the env flag selects it', async () => {
  const p = mockFetch(() => json(GATE_JSON)); const m = mockFetch(() => json(GATE_JSON));
  await mkRouting(p, m, { analyzeOn: 'primary' }).analyze(Buffer.from('x'), 'r.wav');
  assert.equal(p.calls.length, 1); assert.equal(m.calls.length, 0);
  const env = { VOICE_CLONE_SERVICE_URL: 'https://p', VOICE_CLONE_SERVICE_SECRET: 's', VOICE_CLONE_ML_SERVICE_URL: 'https://m', VOICE_CLONE_ML_SERVICE_SECRET: 's' };
  assert.ok(serviceClientFromEnv({ ...env, VOICE_CLONE_ANALYZE_ON_PRIMARY: 'true' }));
});

test('routing client warm: wakes the app that will hold the voice (both when the language is unknown), at most once per 90 s and 20 times an hour', async () => {
  let t = 1_000_000;
  const p = mockFetch(() => new Response('', { status: 200 })); const m = mockFetch(() => new Response('', { status: 200 }));
  const c = mkRouting(p, m, { now: () => t });
  await c.warm!('de');
  assert.deepEqual(m.calls.map((x) => x.url), ['https://m.test/health']); assert.equal(p.calls.length, 0);
  await c.warm!('en');
  assert.deepEqual(p.calls.map((x) => x.url), ['https://p.test/health']);
  await c.warm!('de'); await c.warm!(); // inside the 90 s gap: nothing new
  assert.equal(m.calls.length, 1); assert.equal(p.calls.length, 1);
  t += 91_000; await c.warm!(); // unknown language wakes both
  assert.equal(m.calls.length, 2); assert.equal(p.calls.length, 2);
  for (let i = 0; i < 30; i++) { t += 91_000; await c.warm!('de'); } // 30 attempts spread over 45 minutes
  assert.equal(m.calls.length, 20, `ml warm calls ${m.calls.length}`); // hour cap per app
});

test('warm never throws or blocks even when the app is unreachable', async () => {
  const dead = mockFetch(() => { throw new Error('boom'); });
  const c = createServiceClient({ baseUrl: 'https://x.test', secret: 's', fetchImpl: dead.impl });
  await c.warm!();
});
