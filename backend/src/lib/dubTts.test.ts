import test from 'node:test';
import assert from 'node:assert/strict';
import { getDubTtsBackend, PiperWorkerClient, ModalPiperClient, createDubSynth } from './dubTts.js';
import { resolveDubLanguage } from './dubLanguages.js';
import { decodeWavPcm16, encodeWavPcm16 } from './dubTiming.js';

test('DUB_TTS_BACKEND defaults to modal-cpu (cheapest); gpu and gateway cpu are opt-in; garbage falls back to the default', () => {
  assert.equal(getDubTtsBackend({}), 'modal-cpu');
  assert.equal(getDubTtsBackend({ DUB_TTS_BACKEND: 'modal-cpu' }), 'modal-cpu');
  assert.equal(getDubTtsBackend({ DUB_TTS_BACKEND: 'gpu' }), 'gpu');
  assert.equal(getDubTtsBackend({ DUB_TTS_BACKEND: 'cpu' }), 'cpu');
  assert.equal(getDubTtsBackend({ DUB_TTS_BACKEND: ' CPU ' }), 'cpu');
  assert.equal(getDubTtsBackend({ DUB_TTS_BACKEND: 'tpu' }), 'modal-cpu');
});

function pcm(seconds: number, sr = 24000): Buffer {
  const b = Buffer.alloc(Math.round(seconds * sr) * 2);
  for (let i = 0; i < b.length / 2; i++) b.writeInt16LE(3000, i * 2);
  return b;
}

function fakeFetch(handlers: Array<(url: string, init: RequestInit) => Response>, log: Array<{ url: string; body: any; auth?: string }> = []) {
  let i = 0;
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let body: any;
    try { body = init?.body ? JSON.parse(String(init.body)) : undefined; } catch { body = undefined; }
    log.push({ url, body, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
    const h = handlers[Math.min(i++, handlers.length - 1)]!;
    return h(url, init ?? {});
  }) as typeof fetch;
  return { f, log };
}
const authOk = (u: string) => new Response(JSON.stringify({ token: 'tok1', http_url: 'https://piper.example/v1/tts/stream' }), { status: 200 });

test('PiperWorkerClient authorizes against the gateway with engine piper, then POSTs custom:<voice> with speed and pcm_24000', async () => {
  const { f, log } = fakeFetch([authOk, () => new Response(pcm(1.0), { status: 200 })]);
  const c = new PiperWorkerClient({ gatewayUrl: 'https://gw.example', apiKey: 'k', fetchImpl: f });
  const wav = await c.synth('hola', 'es-pilot-f', 1.25);
  assert.equal(log[0]!.url, 'https://gw.example/tts/authorize');
  assert.deepEqual(log[0]!.body, { key: 'k', engine: 'piper' });
  assert.equal(log[1]!.url, 'https://piper.example/v1/tts/stream');
  assert.deepEqual(log[1]!.body, { text: 'hola', voice: 'custom:es-pilot-f', speed: 1.25, format: 'pcm_24000' });
  assert.equal(log[1]!.auth, 'Bearer tok1');
  const d = decodeWavPcm16(wav)!;
  assert.equal(d.sampleRate, 24000);
  assert.ok(Math.abs(d.samples.length / 24000 - 1.0) < 1e-6);
});

test('PiperWorkerClient authorizes once and reuses the token across calls', async () => {
  const { f, log } = fakeFetch([authOk, () => new Response(pcm(0.5), { status: 200 })]);
  const c = new PiperWorkerClient({ gatewayUrl: 'https://gw.example', apiKey: 'k', fetchImpl: f });
  await c.synth('a', 'fr-fr-mls-f', 1);
  await c.synth('b', 'fr-fr-mls-f', 1);
  assert.equal(log.filter((l) => l.url.endsWith('/tts/authorize')).length, 1);
});

test('PiperWorkerClient re-authorizes once on 401 (expired session token)', async () => {
  const { f, log } = fakeFetch([authOk, () => new Response('no', { status: 401 }), authOk, () => new Response(pcm(0.5), { status: 200 })]);
  const c = new PiperWorkerClient({ gatewayUrl: 'https://gw.example', apiKey: 'k', fetchImpl: f });
  await c.synth('a', 'fr-fr-mls-f', 1);
  assert.equal(log.filter((l) => l.url.endsWith('/tts/authorize')).length, 2);
});

test('PiperWorkerClient retries 503 (at capacity) then succeeds; gives up with a clear error after retries', async () => {
  const busy = () => new Response('busy', { status: 503, headers: { 'Retry-After': '0' } });
  const ok = fakeFetch([authOk, busy, busy, () => new Response(pcm(0.5), { status: 200 })]);
  const c = new PiperWorkerClient({ gatewayUrl: 'https://gw.example', apiKey: 'k', fetchImpl: ok.f, retryDelayMs: 0 });
  assert.ok((await c.synth('a', 'fr-fr-mls-f', 1)).length > 44);
  const bad = fakeFetch([authOk, busy]);
  const c2 = new PiperWorkerClient({ gatewayUrl: 'https://gw.example', apiKey: 'k', fetchImpl: bad.f, retryDelayMs: 0, maxRetries: 2 });
  await assert.rejects(() => c2.synth('a', 'fr-fr-mls-f', 1), /capacity|503/i);
});

test('PiperWorkerClient surfaces unknown-voice (404) and gateway errors clearly, without retrying', async () => {
  const f404 = fakeFetch([authOk, () => new Response(JSON.stringify({ error: 'unknown voice' }), { status: 404 })]);
  await assert.rejects(() => new PiperWorkerClient({ gatewayUrl: 'https://gw', apiKey: 'k', fetchImpl: f404.f }).synth('a', 'es-pilot-f', 1), /unknown voice/);
  assert.equal(f404.log.length, 2);
  const f402 = fakeFetch([() => new Response(JSON.stringify({ error: 'Free tier exhausted' }), { status: 402 })]);
  await assert.rejects(() => new PiperWorkerClient({ gatewayUrl: 'https://gw', apiKey: 'k', fetchImpl: f402.f }).synth('a', 'es-pilot-f', 1), /402/);
});

test('createDubSynth: gpu backend sends everything through the provider callback (Piper voice ids included)', async () => {
  const calls: Array<{ lang: string; voice: string; speed: number }> = [];
  const synth = await createDubSynth(resolveDubLanguage('es')!, {
    env: { DUB_TTS_BACKEND: 'gpu' },
    providerSynth: async (lang, _t, voice, speed) => { calls.push({ lang: lang.code, voice, speed }); return Buffer.from('w'); },
  });
  await synth('hola', 'es-pilot-m', 1.1);
  assert.deepEqual(calls, [{ lang: 'es', voice: 'es-pilot-m', speed: 1.1 }]);
});

test('createDubSynth: cpu backend sends Piper languages to the Piper worker and English to the provider', async () => {
  const { f, log } = fakeFetch([authOk, () => new Response(pcm(0.5), { status: 200 })]);
  const prov: string[] = [];
  const env = { DUB_TTS_BACKEND: 'cpu', DUB_PIPER_API_KEY: 'k', DUB_PIPER_GATEWAY_URL: 'https://gw.example' };
  const deps = { env, fetchImpl: f, providerSynth: async (_l: unknown, _t: string, v: string) => { prov.push(v); return Buffer.from('w'); } };
  const es = await createDubSynth(resolveDubLanguage('es')!, deps as never);
  await es('hola', 'es-pilot-f', 1);
  assert.ok(log.some((l) => l.body?.voice === 'custom:es-pilot-f'));
  const en = await createDubSynth(resolveDubLanguage('en')!, deps as never);
  await en('hello', 'am_adam', 1);
  assert.deepEqual(prov, ['am_adam']);
});

test('createDubSynth: cpu backend without a gateway key fails up front with an actionable message', async () => {
  await assert.rejects(
    () => createDubSynth(resolveDubLanguage('fr')!, { env: { DUB_TTS_BACKEND: 'cpu' }, providerSynth: async () => Buffer.alloc(0) } as never),
    /DUB_PIPER_API_KEY|STT_API_KEY/
  );
});

// ---------------------------------------------------------------- modal-cpu (dedicated Piper function)
const wavResponse = (sec: number) => {
  const p = pcm(sec);
  const samples = new Int16Array(p.length / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = p.readInt16LE(i * 2);
  return new Response(encodeWavPcm16(samples, 24000), { status: 200, headers: { 'Content-Type': 'audio/wav' } });
};

test('ModalPiperClient POSTs the readaloud /synthesize contract with a Bearer secret and returns the WAV as-is', async () => {
  const { f, log } = fakeFetch([() => wavResponse(1.0)]);
  const c = new ModalPiperClient({ url: 'https://dub.example.modal.run/', secret: 's3', fetchImpl: f });
  const wav = await c.synth('hola', 'es-pilot-m', 1.1, 'es');
  assert.equal(log[0]!.url, 'https://dub.example.modal.run/synthesize');
  assert.deepEqual(log[0]!.body, { text: 'hola', voice_id: 'es-pilot-m', language: 'es', speed: 1.1 });
  assert.equal(log[0]!.auth, 'Bearer s3');
  assert.ok(Math.abs(decodeWavPcm16(wav)!.samples.length / 24000 - 1.0) < 1e-6);
});

test('ModalPiperClient retries transient 5xx/429 (cold start, scale-up) and fails clearly on 401/400/404 without retrying', async () => {
  const busy = () => new Response('cold', { status: 503 });
  const ok = fakeFetch([busy, () => new Response('x', { status: 502 }), () => wavResponse(0.5)]);
  const c = new ModalPiperClient({ url: 'https://d', secret: 's', fetchImpl: ok.f, retryDelayMs: 0 });
  assert.ok((await c.synth('a', 'es-pilot-m', 1, 'es')).length > 44);
  assert.equal(ok.log.length, 3);
  for (const status of [401, 400, 404]) {
    const r = fakeFetch([() => new Response(JSON.stringify({ detail: `bad ${status}` }), { status })]);
    await assert.rejects(() => new ModalPiperClient({ url: 'https://d', secret: 's', fetchImpl: r.f, retryDelayMs: 0 }).synth('a', 'es-pilot-m', 1, 'es'), new RegExp(`${status}`));
    assert.equal(r.log.length, 1);
  }
  const dead = fakeFetch([busy]);
  await assert.rejects(() => new ModalPiperClient({ url: 'https://d', secret: 's', fetchImpl: dead.f, retryDelayMs: 0, maxRetries: 2 }).synth('a', 'es-pilot-m', 1, 'es'), /503/);
  assert.equal(dead.log.length, 3);
});

test('createDubSynth: modal-cpu (the default) sends Piper languages to the dedicated function and English to the provider', async () => {
  const { f, log } = fakeFetch([() => wavResponse(0.5)]);
  const prov: string[] = [];
  const env = { DUB_PIPER_MODAL_URL: 'https://dub.example.modal.run', DUB_PIPER_MODAL_SECRET: 'sec' };
  const deps = { env, fetchImpl: f, providerSynth: async (_l: unknown, _t: string, v: string) => { prov.push(v); return Buffer.from('w'); } };
  const es = await createDubSynth(resolveDubLanguage('es')!, deps as never);
  await es('hola', 'es-pilot-f', 1);
  assert.equal(log[0]!.url, 'https://dub.example.modal.run/synthesize');
  assert.equal(log[0]!.auth, 'Bearer sec');
  const en = await createDubSynth(resolveDubLanguage('en')!, deps as never);
  await en('hello', 'am_adam', 1);
  assert.deepEqual(prov, ['am_adam']);
});

test('createDubSynth: modal-cpu without URL/secret fails up front naming the env vars (and English still works unconfigured)', async () => {
  await assert.rejects(
    () => createDubSynth(resolveDubLanguage('es')!, { env: {}, providerSynth: async () => Buffer.alloc(0) } as never),
    /DUB_PIPER_MODAL_URL.*DUB_PIPER_MODAL_SECRET/s
  );
  await assert.rejects(
    () => createDubSynth(resolveDubLanguage('es')!, { env: { DUB_PIPER_MODAL_URL: 'https://d' }, providerSynth: async () => Buffer.alloc(0) } as never),
    /DUB_PIPER_MODAL_SECRET/
  );
  const en = await createDubSynth(resolveDubLanguage('en')!, { env: {}, providerSynth: async () => Buffer.from('w') } as never);
  assert.ok((await en('hi', 'am_adam', 1)).length > 0);
});

test('modal-cpu needs no gateway key (the point of the dedicated function)', async () => {
  const env = { DUB_PIPER_MODAL_URL: 'https://d', DUB_PIPER_MODAL_SECRET: 's' }; // no DUB_PIPER_API_KEY / STT key
  const s = await createDubSynth(resolveDubLanguage('es')!, { env, fetchImpl: fakeFetch([() => wavResponse(0.2)]).f, providerSynth: async () => Buffer.alloc(0), fallbackApiKey: undefined } as never);
  assert.ok((await s('a', 'es-pilot-m', 1)).length > 44);
});
