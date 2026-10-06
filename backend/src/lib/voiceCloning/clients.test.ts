import test from 'node:test';
import assert from 'node:assert/strict';
import { createServiceClient, serviceClientFromEnv, ServiceUnavailableError } from './serviceClient.js';
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
