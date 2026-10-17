// npm test (node:test via tsx). diarize=true (speaker labels) pass-through for the STT routes (routes/stt.ts); harness copied from sttImproved.test.ts.
// Everything external (Supabase, the STT gateway's /stt/authorize, the production worker, the improved worker) is
// intercepted via a patched global.fetch. Nothing real is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import pino from 'pino';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.STT_API_KEY ??= 'house-stt-key';
process.env.STT_GATEWAY_URL ??= 'https://gateway.test';
process.env.NODE_ENV = 'test';

const IMPROVED = 'https://improved.test';
const IMPROVED_TOKEN = 'improved-secret-token-xyz';
const PROD_TOKEN = 'session-token';

type WorkerOk = Record<string, unknown>;
type Mode = { ok: WorkerOk } | { status: number; body?: string } | { throws: 'timeout' | 'network' };
let prodMode: Mode = { ok: { text: 'prod transcript hello', language: 'en', duration: 3.5 } };
let improvedMode: Mode = { ok: { text: 'improved transcript hello', language: 'en', duration: 4.5 } };
let healthMode: 'ok' | 'throws' | 'hang-status-500' = 'ok';

const prodCalls: Array<{ auth: string; url: string }> = [];
const improvedCalls: Array<{ auth: string; url: string; bytes: number }> = [];
const healthCalls: string[] = [];
const authorizeCalls = { count: 0 };
const usageCalls: Array<{ userId: string; seconds: number }> = [];
const rows = new Map<string, Record<string, unknown>>();
let idCounter = 0;
let originalFetch: typeof globalThis.fetch;

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });

function respond(mode: Mode): Response {
  if ('throws' in mode) {
    if (mode.throws === 'timeout') throw new DOMException('The operation timed out.', 'TimeoutError');
    throw new TypeError('fetch failed');
  }
  if ('status' in mode) return new Response(mode.body ?? 'worker error', { status: mode.status });
  return json(mode.ok);
}

function installFetchMock() {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === 'http://localhost:54321/auth/v1/user') {
      const token = (init?.headers as Record<string, string>)?.['Authorization']?.replace(/^Bearer /, '') || '';
      return token === 'valid-token' ? json({ id: 'u1', aud: 'authenticated' }) : json({ message: 'Invalid token' }, 401);
    }
    if (url.includes('/realtimetts_free_credits')) return json([{ granted: 10000, used: 10000 }]);
    if (url.includes('/rest/v1/realtimetts_billing')) {
      const uid = new URL(url).searchParams.get('user_id')?.replace(/^eq\./, '');
      return json([{ user_id: uid, stripe_customer_id: 'cus', stripe_subscription_id: 'sub', stripe_subscription_item_id: 'si', active: true }]);
    }
    if (url.includes('/rest/v1/stt_key_settings')) return json([]);
    if (url.includes('/rest/v1/stt_transcriptions')) {
      const method = (init?.method || 'GET').toUpperCase();
      if (method === 'POST') {
        const id = `txn-${++idCounter}`;
        const row = { id, ...JSON.parse((init?.body as string) || '{}') };
        rows.set(id, row);
        return json(row, 201);
      }
      if (method === 'PATCH') {
        const id = new URL(url).searchParams.get('id')?.replace(/^eq\./, '') ?? '';
        const body = JSON.parse((init?.body as string) || '{}');
        rows.set(id, { ...(rows.get(id) ?? {}), ...body });
        return json([rows.get(id)]);
      }
      return json([]);
    }
    if (url === 'https://gateway.test/stt/authorize') {
      authorizeCalls.count += 1;
      return json({ token: PROD_TOKEN, url: 'https://worker.test' });
    }
    if (url.startsWith('https://worker.test/v1/stt')) {
      prodCalls.push({ auth: (init?.headers as Record<string, string>)?.['Authorization'] ?? '', url });
      if (init?.body) await new Response(init.body as BodyInit).arrayBuffer();
      return respond(prodMode);
    }
    if (url.startsWith(`${IMPROVED}/v1/stt`)) {
      const bytes = init?.body ? (await new Response(init.body as BodyInit).arrayBuffer()).byteLength : 0;
      improvedCalls.push({ auth: (init?.headers as Record<string, string>)?.['Authorization'] ?? '', url, bytes });
      return respond(improvedMode);
    }
    if (url === `${IMPROVED}/health`) {
      healthCalls.push(url);
      if (healthMode === 'throws') throw new TypeError('fetch failed');
      return healthMode === 'hang-status-500' ? new Response('boom', { status: 500 }) : json({ ok: true });
    }
    return originalFetch(input, init);
  };
}
const uninstallFetchMock = () => { globalThis.fetch = originalFetch; };

function reset() {
  prodMode = { ok: { text: 'prod transcript hello', language: 'en', duration: 3.5 } };
  improvedMode = { ok: { text: 'improved transcript hello', language: 'en', duration: 4.5 } };
  healthMode = 'ok';
  prodCalls.length = 0; improvedCalls.length = 0; healthCalls.length = 0; usageCalls.length = 0;
  authorizeCalls.count = 0; rows.clear(); idCounter = 0;
}

const tmpDirs: string[] = [];
function wavBytes(n = 2048): Buffer {
  const b = Buffer.alloc(n, 1);
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(n - 8, 4); b.write('WAVE', 8, 'ascii'); b.write('fmt ', 12, 'ascii');
  return b;
}

function captureLogger() {
  const lines: string[] = [];
  const logger = pino({ level: 'debug' }, { write: (s: string) => { lines.push(s); } });
  return { logger, lines, parsed: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

async function boot(over: Record<string, unknown> = {}, opts: { user?: string; noAuth?: boolean } = {}) {
  const { createSttRouters } = await import('./stt.js');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-imp-test-'));
  tmpDirs.push(tmpDir);
  const cap = captureLogger();
  const { sttRouter, sttCompatRouter } = createSttRouters({
    tmpDir,
    reportUsage: async (userId: string, seconds: number) => { usageCalls.push({ userId, seconds }); },
    settingsTtlMs: 0,
    logger: cap.logger,
    improvedUrl: IMPROVED,
    improvedToken: IMPROVED_TOKEN,
    improvedPercent: 100,
    improvedTimeoutMs: 120_000,
    improvedFallback: true,
    ...over,
  });
  const app = express();
  app.use(express.json());
  if (!opts.noAuth) {
    app.use((req, _res, next) => { (req as express.Request & { userId?: string }).userId = opts.user ?? 'u1'; next(); });
  }
  app.use('/api/stt', sttRouter);
  app.use('/v1', sttCompatRouter);
  const server = app.listen(0);
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const legacyForm = (extra: Array<[string, string]> = []) => {
    const f = new FormData();
    f.append('audio', new Blob([wavBytes()], { type: 'audio/wav' }), 'a.wav');
    for (const [k, v] of extra) f.append(k, v);
    return f;
  };
  const transcribe = () => fetch(`${origin}/api/stt/transcriptions`, { method: 'POST', body: legacyForm(), headers: { Authorization: 'Bearer valid-token' } });
  const warm = (auth = true) => fetch(`${origin}/api/stt/warm`, { method: 'POST', headers: auth ? { Authorization: 'Bearer valid-token' } : {} });
  return { origin, server, cap, legacyForm, transcribe, warm, close: () => server.close() };
}

async function withBoot<T>(over: Record<string, unknown>, fn: (s: Awaited<ReturnType<typeof boot>>) => Promise<T>, opts: { user?: string; noAuth?: boolean } = {}) {
  installFetchMock();
  reset();
  const s = await boot(over, opts);
  try { return await fn(s); } finally { s.close(); uninstallFetchMock(); }
}

test.after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
// Routing

// ---------------------------------------------------------------------------
// diarize=true
// ---------------------------------------------------------------------------

const DIAR_OK: WorkerOk = {
  text: 'Hello there. Hi back.', language: 'en', duration: 4.0,
  words: [
    { word: 'Hello', start: 0, end: 0.4, probability: 0.9, speaker: 0 }, { word: 'there.', start: 0.4, end: 0.8, probability: 0.9, speaker: 0 },
    { word: 'Hi', start: 1.0, end: 1.3, probability: 0.8, speaker: 1 }, { word: 'back.', start: 1.3, end: 1.7, probability: 0.8, speaker: 1 },
  ],
  speakers: {
    count: 2, warnings: [], engine: 'nemotron-3-diarization',
    utterances: [
      { speaker: 0, start: 0, end: 0.8, text: 'Hello there.', first_word: 0, last_word: 1, confidence: 0.9 },
      { speaker: 1, start: 1.0, end: 1.7, text: 'Hi back.', first_word: 2, last_word: 3, confidence: 0.8 },
    ],
  },
};
const auth = { Authorization: 'Bearer valid-token' };
const oaForm = (extra: Array<[string, string]> = []) => {
  const f = new FormData();
  f.append('file', new Blob([wavBytes()], { type: 'audio/wav' }), 'a.wav');
  for (const [k, v] of extra) f.append(k, v);
  return f;
};

test('legacy diarize=true: forwarded to the improved worker (even when the RNG would pick prod), speakers + word speaker returned', async () => {
  await withBoot({ improvedPercent: 1, rng: () => 0.99 }, async (s) => {
    improvedMode = { ok: DIAR_OK };
    const r = await fetch(`${s.origin}/api/stt/transcriptions`, { method: 'POST', body: s.legacyForm([['diarize', 'true'], ['word_timestamps', 'true']]), headers: auth });
    assert.equal(r.status, 201);
    assert.equal(r.headers.get('x-stt-worker'), 'improved');
    const b = await r.json() as { words: Array<{ speaker: number }>; speakers: { count: number } };
    assert.deepEqual(b.words.map((w) => w.speaker), [0, 0, 1, 1]);
    assert.equal(b.speakers.count, 2);
    assert.equal(new URL(improvedCalls[0]!.url).searchParams.get('diarize'), 'true');
    assert.equal(prodCalls.length, 0);
    assert.deepEqual(usageCalls, [{ userId: 'u1', seconds: 4.0 }]);
  });
});

test('without diarize: no diarize param is sent and no speakers field comes back (request to the worker unchanged)', async () => {
  await withBoot({}, async (s) => {
    const r = await s.transcribe();
    assert.equal(r.status, 201);
    assert.equal(new URL(improvedCalls[0]!.url).searchParams.has('diarize'), false);
    assert.equal('speakers' in (await r.json() as object), false);
  });
});

test('diarize + improved worker down: 502, prod worker NEVER used (it cannot label speakers), nothing billed', async () => {
  for (const mode of [{ status: 503 }, { throws: 'network' }, { throws: 'timeout' }] as Mode[]) {
    await withBoot({ improvedFallback: true }, async (s) => {
      improvedMode = mode;
      const r = await fetch(`${s.origin}/api/stt/transcriptions`, { method: 'POST', body: s.legacyForm([['diarize', 'true']]), headers: auth });
      assert.equal(r.status, 502);
      assert.equal(prodCalls.length, 0);
      assert.equal(authorizeCalls.count, 0);
      assert.equal(usageCalls.length, 0);
    });
  }
});

test('diarize + improved worker answers 200 WITHOUT speakers (old container): 502, never an unlabeled transcript, nothing billed', async () => {
  await withBoot({}, async (s) => {
    improvedMode = { ok: { text: 'plain', language: 'en', duration: 2 } };
    const r = await fetch(`${s.origin}/api/stt/transcriptions`, { method: 'POST', body: s.legacyForm([['diarize', 'true']]), headers: auth });
    assert.equal(r.status, 502);
    assert.equal(prodCalls.length, 0);
    assert.equal(usageCalls.length, 0);
  });
});

test('diarize when the improved worker is not enabled: 400 diarize_unavailable on every surface, no worker call, nothing billed', async () => {
  await withBoot({ improvedPercent: 0 }, async (s) => {
    const l = await fetch(`${s.origin}/api/stt/transcriptions`, { method: 'POST', body: s.legacyForm([['diarize', 'true']]), headers: auth });
    assert.equal(l.status, 400);
    const d = await fetch(`${s.origin}/v1/listen?diarize=true`, { method: 'POST', headers: { ...auth, 'Content-Type': 'audio/wav' }, body: wavBytes() });
    assert.equal(d.status, 400);
    assert.equal((await d.json() as { err_code: string }).err_code, 'DIARIZE_UNAVAILABLE');
    const o = await fetch(`${s.origin}/v1/audio/transcriptions`, { method: 'POST', headers: auth, body: oaForm([['diarize', 'true']]) });
    assert.equal(o.status, 400);
    assert.equal((await o.json() as { error: { code: string } }).error.code, 'diarize_unavailable');
    assert.equal(improvedCalls.length + prodCalls.length, 0);
    assert.equal(usageCalls.length, 0);
  });
});

test('/v1/listen diarize=true: words[].speaker, results.utterances (with word slices), metadata.stt_ext.speakers', async () => {
  await withBoot({}, async (s) => {
    improvedMode = { ok: DIAR_OK };
    const r = await fetch(`${s.origin}/v1/listen?diarize=true`, { method: 'POST', headers: { ...auth, 'Content-Type': 'audio/wav' }, body: wavBytes() });
    assert.equal(r.status, 200);
    const j = await r.json() as { results: { channels: Array<{ alternatives: Array<{ words: Array<{ speaker?: number }> }> }>; utterances: Array<{ speaker: number; transcript: string; words: unknown[]; confidence: number }> }; metadata: { stt_ext: { speakers: { count: number } } } };
    assert.deepEqual(j.results.channels[0]!.alternatives[0]!.words.map((w) => w.speaker), [0, 0, 1, 1]);
    assert.deepEqual(j.results.utterances.map((u) => [u.speaker, u.transcript, u.words.length]), [[0, 'Hello there.', 2], [1, 'Hi back.', 2]]);
    assert.equal(j.metadata.stt_ext.speakers.count, 2);
  });
  await withBoot({}, async (s) => {
    const j = await (await fetch(`${s.origin}/v1/listen`, { method: 'POST', headers: { ...auth, 'Content-Type': 'audio/wav' }, body: wavBytes() })).json() as { results: { utterances?: unknown } };
    assert.equal(j.results.utterances, undefined);
  });
});

test('/v1/audio/transcriptions diarize=true: verbose_json carries x_speakers', async () => {
  await withBoot({}, async (s) => {
    improvedMode = { ok: DIAR_OK };
    const r = await fetch(`${s.origin}/v1/audio/transcriptions`, { method: 'POST', headers: auth, body: oaForm([['diarize', 'true'], ['response_format', 'verbose_json']]) });
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as { x_speakers: { count: number } }).x_speakers.count, 2);
  });
});

test('invalid diarize value -> 400 bad_param on every surface, no worker call', async () => {
  await withBoot({}, async (s) => {
    assert.equal((await fetch(`${s.origin}/api/stt/transcriptions`, { method: 'POST', body: s.legacyForm([['diarize', 'maybe']]), headers: auth })).status, 400);
    assert.equal((await fetch(`${s.origin}/v1/listen?diarize=maybe`, { method: 'POST', headers: { ...auth, 'Content-Type': 'audio/wav' }, body: wavBytes() })).status, 400);
    assert.equal((await fetch(`${s.origin}/v1/audio/transcriptions`, { method: 'POST', headers: auth, body: oaForm([['diarize', 'maybe']]) })).status, 400);
    assert.equal(improvedCalls.length, 0);
  });
});
