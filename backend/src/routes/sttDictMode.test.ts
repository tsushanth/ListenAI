// npm test (node:test via tsx). dict_mode=shortlist / keyterms_json pass-through for the STT routes (routes/stt.ts); harness copied from sttDiarize.test.ts.
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

const terms = (n: number) => Array.from({ length: n }, (_, i) => `term${String(i).padStart(5, '0')}`);
type S = { origin: string; legacyForm: (e?: Array<[string, string]>) => FormData };
const post = (s: S, extra: Array<[string, string]>) => fetch(`${s.origin}/api/stt/transcriptions`, { method: 'POST', body: s.legacyForm(extra), headers: auth });

test('dict_mode=shortlist + keyterms_json are forwarded to the improved worker (even when the RNG would pick prod); prod never used', async () => {
  await withBoot({ improvedPercent: 1, rng: () => 0.99 }, async (s) => {
    const json = JSON.stringify([{ term: 'Zorblax', tier: 1, alternatives: ['zorb lax'] }, 'Quillon']);
    const r = await post(s, [['dict_mode', 'shortlist'], ['keyterm', 'Acme'], ['keyterms_json', json]]);
    assert.equal(r.status, 201);
    assert.equal(r.headers.get('x-stt-worker'), 'improved');
    const u = new URL(improvedCalls[0]!.url);
    assert.equal(u.searchParams.get('dict_mode'), 'shortlist');
    assert.deepEqual(u.searchParams.getAll('keyterm'), ['Acme']);
    assert.equal(u.searchParams.get('keyterms_json'), json);
    assert.equal(prodCalls.length, 0);
  });
});

test('without dict_mode nothing new is sent to the worker and the old term limit still applies', async () => {
  await withBoot({ maxKeyterms: 5 }, async (s) => {
    const ok = await post(s, [['keyterm', 'a'], ['keyterm', 'b']]);
    assert.equal(ok.status, 201);
    const u = new URL(improvedCalls[0]!.url);
    assert.equal(u.searchParams.has('dict_mode'), false);
    assert.equal(u.searchParams.has('keyterms_json'), false);
    const many = await post(s, terms(6).map((t) => ['keyterm', t] as [string, string]));
    assert.equal(many.status, 400);
  });
});

test('dict_mode=shortlist raises the limit (1500 terms in one `keyterms` JSON field accepted; the same list without it is 400)', async () => {
  await withBoot({ maxKeyterms: 1000 }, async (s) => {
    const list: Array<[string, string]> = [['keyterms', JSON.stringify(terms(1500))]];
    assert.equal((await post(s, list)).status, 400);
    const r = await post(s, [['dict_mode', 'shortlist'], ...list]);
    assert.equal(r.status, 201);
    assert.equal(new URL(improvedCalls[0]!.url).searchParams.getAll('keyterm').length, 1500);
  });
});

test('shortlist limits: too many terms (plain + json) and too many bytes -> 400, no worker call', async () => {
  await withBoot({ maxKeytermsShortlist: 10, keytermsShortlistMaxQueryBytes: 400 }, async (s) => {
    const over = await post(s, [['dict_mode', 'shortlist'], ['keyterms', JSON.stringify(terms(8))], ['keyterms_json', JSON.stringify(terms(5).map((t) => `${t}x`))]]);
    assert.equal(over.status, 400);
    const long = Array.from({ length: 9 }, (_, i) => `${i}`.repeat(90));
    const big = await post(s, [['dict_mode', 'shortlist'], ['keyterms', JSON.stringify(long)]]);
    assert.equal(big.status, 400);
    assert.equal(improvedCalls.length + prodCalls.length, 0);
  });
});

test('invalid dict_mode, keyterms_json without dict_mode, malformed or bad-tier json -> 400 on every surface, no worker call', async () => {
  await withBoot({}, async (s) => {
    const bad: Array<Array<[string, string]>> = [
      [['dict_mode', 'full']],
      [['keyterms_json', '["a"]']],
      [['dict_mode', 'shortlist'], ['keyterms_json', '{not json']],
      [['dict_mode', 'shortlist'], ['keyterms_json', '{"term":"a"}']],
      [['dict_mode', 'shortlist'], ['keyterms_json', JSON.stringify([{ term: 'a', tier: 4 }])]],
      [['dict_mode', 'shortlist'], ['keyterms_json', JSON.stringify([{ term: 'a', alternatives: Array(9).fill('b') }])]],
    ];
    for (const extra of bad) {
      assert.equal((await post(s, extra)).status, 400, JSON.stringify(extra));
      assert.equal((await fetch(`${s.origin}/v1/audio/transcriptions`, { method: 'POST', headers: auth, body: oaForm(extra) })).status, 400);
      const q = new URLSearchParams(extra).toString();
      assert.equal((await fetch(`${s.origin}/v1/listen?${q}`, { method: 'POST', headers: { ...auth, 'Content-Type': 'audio/wav' }, body: wavBytes() })).status, 400);
    }
    assert.equal(improvedCalls.length + prodCalls.length, 0);
  });
});

test('dict_mode=shortlist works on /v1/listen and /v1/audio/transcriptions too', async () => {
  await withBoot({}, async (s) => {
    const l = await fetch(`${s.origin}/v1/listen?dict_mode=shortlist&keyterm=Acme`, { method: 'POST', headers: { ...auth, 'Content-Type': 'audio/wav' }, body: wavBytes() });
    assert.equal(l.status, 200);
    const o = await fetch(`${s.origin}/v1/audio/transcriptions`, { method: 'POST', headers: auth, body: oaForm([['dict_mode', 'shortlist'], ['keyterm', 'Acme']]) });
    assert.equal(o.status, 200);
    assert.deepEqual(improvedCalls.map((c) => new URL(c.url).searchParams.get('dict_mode')), ['shortlist', 'shortlist']);
    assert.equal(prodCalls.length, 0);
  });
});

test('dict_mode=shortlist when the improved worker is not enabled: 400, no worker call, nothing billed', async () => {
  await withBoot({ improvedPercent: 0 }, async (s) => {
    const r = await post(s, [['dict_mode', 'shortlist'], ['keyterm', 'Acme']]);
    assert.equal(r.status, 400);
    assert.equal(improvedCalls.length + prodCalls.length, 0);
    assert.equal(usageCalls.length, 0);
  });
});

test('dict_mode=shortlist + improved worker down: 502, the production worker is NEVER used (it would drop the dictionary), nothing billed', async () => {
  for (const mode of [{ status: 503 }, { throws: 'network' }, { throws: 'timeout' }] as Mode[]) {
    await withBoot({ improvedFallback: true }, async (s) => {
      improvedMode = mode;
      const r = await post(s, [['dict_mode', 'shortlist'], ['keyterm', 'Acme']]);
      assert.equal(r.status, 502);
      assert.equal(prodCalls.length, 0);
      assert.equal(usageCalls.length, 0);
    });
  }
});

test('worker 400 for dict_mode (flag off on the worker) -> clear 400 mentioning dict_mode, not "bad audio", nothing billed', async () => {
  await withBoot({}, async (s) => {
    improvedMode = { status: 400, body: '{"err_code":"DICT_MODE_UNAVAILABLE"}' };
    const r = await post(s, [['dict_mode', 'shortlist'], ['keyterm', 'Acme']]);
    assert.equal(r.status, 400);
    assert.match(JSON.stringify(await r.json()), /dict_mode/);
    assert.equal(usageCalls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Auto-shortlist: plain `keyterm`s above STT_AUTO_SHORTLIST_ABOVE (default 500) are served as dict_mode=shortlist
// ---------------------------------------------------------------------------

// One JSON `keyterms` field (multipart has a field-count limit); these are still plain terms for the backend.
const plain = (n: number): Array<[string, string]> => [['keyterms', JSON.stringify(terms(n))]];

test('auto-shortlist: 500 plain terms unchanged (no dict_mode sent, no marker); 501 and 1000 become dict_mode=shortlist on the improved worker only', async () => {
  await withBoot({ improvedPercent: 1, rng: () => 0.99, keytermsMaxQueryBytes: 1_000_000 }, async (s) => {
    const at = await post(s, plain(500));
    assert.equal(at.status, 201);
    const u0 = new URL(improvedCalls[0] ? improvedCalls[0].url : prodCalls[0]!.url);
    assert.equal(u0.searchParams.has('dict_mode'), false);
    assert.equal(u0.searchParams.getAll('keyterm').length, 500);
    assert.equal(at.headers.get('x-stt-dict-mode'), null);
    assert.equal(((await at.json()) as { dictionary?: unknown }).dictionary, undefined);
    improvedCalls.length = 0; prodCalls.length = 0;

    for (const n of [501, 1000]) {
      const r = await post(s, plain(n));
      assert.equal(r.status, 201, `n=${n}`);
      assert.equal(r.headers.get('x-stt-worker'), 'improved');
      assert.equal(r.headers.get('x-stt-dict-mode'), 'shortlist-auto');
      const u = new URL(improvedCalls.at(-1)!.url);
      assert.equal(u.searchParams.get('dict_mode'), 'shortlist');
      assert.equal(u.searchParams.has('keyterms_json'), false);
      assert.deepEqual(u.searchParams.getAll('keyterm'), terms(n)); // order preserved
      const body = (await r.json()) as { dictionary?: { auto_shortlist?: boolean } };
      assert.equal(body.dictionary?.auto_shortlist, true);
    }
    assert.equal(prodCalls.length, 0);
  });
});

test('auto-shortlist: 1001 plain terms keep the existing "Too many keyterms" 400 (no worker call)', async () => {
  await withBoot({ maxKeyterms: 1000 }, async (s) => {
    const r = await post(s, plain(1001));
    assert.equal(r.status, 400);
    assert.match(JSON.stringify(await r.json()), /Too many keyterms \(max 1000\)/);
    assert.equal(improvedCalls.length + prodCalls.length, 0);
  });
});

test('auto-shortlist: explicit dict_mode=off above the threshold is a clear 400, never a worker call; 500 with dict_mode=off still works', async () => {
  await withBoot({ keytermsMaxQueryBytes: 1_000_000 }, async (s) => {
    const r = await post(s, [['dict_mode', 'off'], ...plain(501)]);
    assert.equal(r.status, 400);
    assert.match(JSON.stringify(await r.json()), /dict_mode=off supports at most 500/);
    assert.equal(improvedCalls.length + prodCalls.length, 0);
    assert.equal(usageCalls.length, 0);
    const ok = await post(s, [['dict_mode', 'off'], ...plain(500)]);
    assert.equal(ok.status, 201);
    assert.equal(new URL(improvedCalls[0]!.url).searchParams.has('dict_mode'), false);
  });
});

test('auto-shortlist: explicit dict_mode=shortlist is untouched (not marked auto)', async () => {
  await withBoot({}, async (s) => {
    const r = await post(s, [['dict_mode', 'shortlist'], ...plain(600)]);
    assert.equal(r.status, 201);
    assert.equal(r.headers.get('x-stt-dict-mode'), null);
    assert.equal(new URL(improvedCalls[0]!.url).searchParams.get('dict_mode'), 'shortlist');
  });
});

test('auto-shortlist: STT_AUTO_SHORTLIST_ABOVE=0 disables it (501 plain terms pass as plain, as before); a custom threshold is honoured', async () => {
  await withBoot({ autoShortlistAbove: 0, keytermsMaxQueryBytes: 1_000_000 }, async (s) => {
    const r = await post(s, plain(501));
    assert.equal(r.status, 201);
    assert.equal(new URL(improvedCalls[0]!.url).searchParams.has('dict_mode'), false);
    assert.equal(r.headers.get('x-stt-dict-mode'), null);
  });
  await withBoot({ autoShortlistAbove: 3 }, async (s) => {
    assert.equal((await post(s, plain(3))).status, 201);
    assert.equal(new URL(improvedCalls[0]!.url).searchParams.has('dict_mode'), false);
    assert.equal((await post(s, plain(4))).status, 201);
    assert.equal(new URL(improvedCalls[1]!.url).searchParams.get('dict_mode'), 'shortlist');
  });
});

test('auto-shortlist: over-threshold uses the shortlist byte budget, and the shortlist byte limit still applies', async () => {
  await withBoot({ keytermsMaxQueryBytes: 7000, keytermsShortlistMaxQueryBytes: 48000 }, async (s) => {
    const r = await post(s, plain(900)); // ~ 900 * 18 bytes encoded, far over the 7000 plain budget
    assert.equal(r.status, 201);
  });
  await withBoot({ keytermsShortlistMaxQueryBytes: 2000 }, async (s) => {
    const r = await post(s, plain(600));
    assert.equal(r.status, 400);
    assert.equal(improvedCalls.length + prodCalls.length, 0);
  });
});

test('auto-shortlist: improved worker disabled -> clear 400, no worker call, nothing billed; improved down -> 502 with no prod fallback', async () => {
  await withBoot({ improvedPercent: 0, keytermsMaxQueryBytes: 1_000_000 }, async (s) => {
    const r = await post(s, plain(501));
    assert.equal(r.status, 400);
    assert.equal(improvedCalls.length + prodCalls.length, 0);
    assert.equal(usageCalls.length, 0);
    const ok = await post(s, plain(500)); // <= 500 still served by the production worker
    assert.equal(ok.status, 201);
    assert.equal(prodCalls.length, 1);
  });
  await withBoot({ improvedFallback: true }, async (s) => {
    improvedMode = { status: 503 };
    const r = await post(s, plain(501));
    assert.equal(r.status, 502);
    assert.equal(prodCalls.length, 0);
    assert.equal(usageCalls.length, 0);
  });
});

test('auto-shortlist works on /v1/listen and /v1/audio/transcriptions (header set; openai verbose carries x_dictionary.auto_shortlist)', async () => {
  await withBoot({}, async (s) => {
    // A single JSON-array `keyterm` value: >20 repeated query params are collapsed to an object by express's qs parser (pre-existing, separate issue).
    const qs = `keyterm=${encodeURIComponent(JSON.stringify(terms(501)))}`;
    const l = await fetch(`${s.origin}/v1/listen?${qs}`, { method: 'POST', headers: { ...auth, 'Content-Type': 'audio/wav' }, body: wavBytes() });
    assert.equal(l.status, 200);
    assert.equal(l.headers.get('x-stt-dict-mode'), 'shortlist-auto');
    const o = await fetch(`${s.origin}/v1/audio/transcriptions`, { method: 'POST', headers: auth, body: oaForm([['response_format', 'verbose_json'], ...plain(501)]) });
    assert.equal(o.status, 200);
    assert.equal(o.headers.get('x-stt-dict-mode'), 'shortlist-auto');
    assert.equal(((await o.json()) as { x_dictionary?: { auto_shortlist?: boolean } }).x_dictionary?.auto_shortlist, true);
    assert.deepEqual(improvedCalls.map((c) => new URL(c.url).searchParams.get('dict_mode')), ['shortlist', 'shortlist']);
  });
});
