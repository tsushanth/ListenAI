// npm test (node:test via tsx). Improved-worker routing + fallback + pre-warm for the STT routes (routes/stt.ts).
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

type WorkerOk = { text: string; language: string; duration: number };
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

test('percent 0 (default off): production path, no improved call, header prod', async () => {
  await withBoot({ improvedPercent: 0, rng: () => 0 }, async (s) => {
    const r = await s.transcribe();
    assert.equal(r.status, 201);
    assert.equal(r.headers.get('x-stt-worker'), 'prod');
    assert.equal((await r.json() as { text: string }).text, 'prod transcript hello');
    assert.equal(improvedCalls.length, 0);
    assert.equal(authorizeCalls.count, 1);
    assert.deepEqual(usageCalls, [{ userId: 'u1', seconds: 3.5 }]);
  });
});

test('percent 100: improved worker, bearer token, no gateway authorize, contract query params', async () => {
  await withBoot({ rng: () => 0.999999 }, async (s) => {
    const f = s.legacyForm([['language', 'en'], ['word_timestamps', 'true'], ['keyterm', 'Zorblax'], ['keyterm', 'Quuxington']]);
    const r = await fetch(`${s.origin}/api/stt/transcriptions`, { method: 'POST', body: f, headers: { Authorization: 'Bearer valid-token' } });
    assert.equal(r.status, 201);
    assert.equal(r.headers.get('x-stt-worker'), 'improved');
    const body = await r.json() as { text: string; duration: number };
    assert.equal(body.text, 'improved transcript hello');
    assert.equal(authorizeCalls.count, 0);
    assert.equal(prodCalls.length, 0);
    assert.equal(improvedCalls.length, 1);
    assert.equal(improvedCalls[0]!.auth, `Bearer ${IMPROVED_TOKEN}`);
    assert.equal(improvedCalls[0]!.bytes, 2048);
    const q = new URL(improvedCalls[0]!.url).searchParams;
    assert.equal(q.get('language'), 'en');
    assert.equal(q.get('word_timestamps'), 'true');
    assert.deepEqual(q.getAll('keyterm'), ['Zorblax', 'Quuxington']);
    assert.deepEqual(usageCalls, [{ userId: 'u1', seconds: 4.5 }]);
  });
});

test('percent 50 with injected RNG: below threshold -> improved, at/above -> prod', async () => {
  await withBoot({ improvedPercent: 50, rng: () => 0.49 }, async (s) => {
    assert.equal((await s.transcribe()).headers.get('x-stt-worker'), 'improved');
  });
  await withBoot({ improvedPercent: 50, rng: () => 0.5 }, async (s) => {
    assert.equal((await s.transcribe()).headers.get('x-stt-worker'), 'prod');
  });
  const seq = [0.1, 0.9, 0.2, 0.7];
  let i = 0;
  await withBoot({ improvedPercent: 30, rng: () => seq[i++ % seq.length]! }, async (s) => {
    const seen: string[] = [];
    for (let n = 0; n < 4; n++) seen.push((await s.transcribe()).headers.get('x-stt-worker') ?? '');
    assert.deepEqual(seen, ['improved', 'prod', 'improved', 'prod']);
  });
});

test('percent > 0 but url or token missing: stays off (prod), warns', async () => {
  await withBoot({ improvedToken: undefined, rng: () => 0 }, async (s) => {
    assert.equal((await s.transcribe()).headers.get('x-stt-worker'), 'prod');
    assert.equal(improvedCalls.length, 0);
    assert.ok(s.cap.lines.some((l) => l.includes('improved worker disabled')));
  });
});

test('percent is clamped and floored (150 -> 100, 12.9 -> 12, NaN -> off)', async () => {
  await withBoot({ improvedPercent: 150, rng: () => 0.99 }, async (s) => {
    assert.equal((await s.transcribe()).headers.get('x-stt-worker'), 'improved');
  });
  await withBoot({ improvedPercent: 12.9, rng: () => 0.119 }, async (s) => {
    assert.equal((await s.transcribe()).headers.get('x-stt-worker'), 'improved');
  });
  await withBoot({ improvedPercent: 12.9, rng: () => 0.12 }, async (s) => {
    assert.equal((await s.transcribe()).headers.get('x-stt-worker'), 'prod');
  });
  await withBoot({ improvedPercent: NaN, rng: () => 0 }, async (s) => {
    assert.equal((await s.transcribe()).headers.get('x-stt-worker'), 'prod');
  });
});

test('all three surfaces share the routing and set X-STT-Worker', async () => {
  await withBoot({ rng: () => 0 }, async (s) => {
    const auth = { Authorization: 'Bearer valid-token' };
    const dg = await fetch(`${s.origin}/v1/listen`, { method: 'POST', headers: { ...auth, 'Content-Type': 'audio/wav' }, body: wavBytes() });
    assert.equal(dg.status, 200);
    assert.equal(dg.headers.get('x-stt-worker'), 'improved');
    const f = new FormData();
    f.append('file', new Blob([wavBytes()], { type: 'audio/wav' }), 'a.wav');
    const oa = await fetch(`${s.origin}/v1/audio/transcriptions`, { method: 'POST', headers: auth, body: f });
    assert.equal(oa.status, 200);
    assert.equal(oa.headers.get('x-stt-worker'), 'improved');
    assert.equal(improvedCalls.length, 2);
    assert.equal(usageCalls.length, 2);
  });
  await withBoot({ improvedPercent: 0 }, async (s) => {
    const dg = await fetch(`${s.origin}/v1/listen`, { method: 'POST', headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'audio/wav' }, body: wavBytes() });
    assert.equal(dg.headers.get('x-stt-worker'), 'prod');
  });
});

// ---------------------------------------------------------------------------
// Fallback
// ---------------------------------------------------------------------------

for (const status of [500, 502, 503, 429]) {
  test(`improved ${status} -> falls back to prod, billed once for prod duration`, async () => {
    await withBoot({}, async (s) => {
      improvedMode = { status };
      const r = await s.transcribe();
      assert.equal(r.status, 201);
      assert.equal(r.headers.get('x-stt-worker'), 'prod');
      assert.equal((await r.json() as { text: string }).text, 'prod transcript hello');
      assert.equal(improvedCalls.length, 1);
      assert.equal(prodCalls.length, 1);
      assert.equal(prodCalls[0]!.auth, `Bearer ${PROD_TOKEN}`);
      assert.deepEqual(usageCalls, [{ userId: 'u1', seconds: 3.5 }]);
      const fb = s.cap.parsed().find((l) => l.msg === 'STT improved worker failed, falling back to prod');
      assert.ok(fb);
      assert.equal(fb.status, status);
    });
  });
}

test('improved timeout and network error -> fall back to prod', async () => {
  for (const throws of ['timeout', 'network'] as const) {
    await withBoot({}, async (s) => {
      improvedMode = { throws };
      const r = await s.transcribe();
      assert.equal(r.status, 201);
      assert.equal(r.headers.get('x-stt-worker'), 'prod');
      assert.equal(usageCalls.length, 1);
      const fb = s.cap.parsed().find((l) => l.msg === 'STT improved worker failed, falling back to prod');
      assert.equal(fb?.reason, throws);
    });
  }
});

test('improved 200 with a malformed body -> falls back to prod', async () => {
  await withBoot({}, async (s) => {
    improvedMode = { ok: { text: 5, language: 'en', duration: 1 } as unknown as WorkerOk };
    const r = await s.transcribe();
    assert.equal(r.status, 201);
    assert.equal(r.headers.get('x-stt-worker'), 'prod');
    assert.equal(usageCalls.length, 1);
  });
});

test('fallback disabled: improved 503 -> 502, nothing billed, prod never called', async () => {
  await withBoot({ improvedFallback: false }, async (s) => {
    improvedMode = { status: 503 };
    const r = await s.transcribe();
    assert.equal(r.status, 502);
    assert.equal(r.headers.get('x-stt-worker'), 'improved');
    assert.equal(prodCalls.length, 0);
    assert.equal(authorizeCalls.count, 0);
    assert.equal(usageCalls.length, 0);
  });
});

test('improved fails AND prod fails -> 502, never billed', async () => {
  await withBoot({}, async (s) => {
    improvedMode = { status: 503 };
    prodMode = { status: 500 };
    const r = await s.transcribe();
    assert.equal(r.status, 502);
    assert.equal(usageCalls.length, 0);
    const row = [...rows.values()][0]!;
    assert.equal(row.status, 'failed');
  });
});

test('improved 400 and 413 are returned to the client, no fallback, no billing', async () => {
  for (const status of [400, 413]) {
    await withBoot({}, async (s) => {
      improvedMode = { status, body: 'secret-detail-from-worker' };
      const r = await s.transcribe();
      assert.equal(r.status, status);
      assert.equal(r.headers.get('x-stt-worker'), 'improved');
      const text = await r.text();
      assert.ok(!text.includes('secret-detail-from-worker'), 'worker error body is not echoed');
      assert.equal(prodCalls.length, 0);
      assert.equal(authorizeCalls.count, 0);
      assert.equal(usageCalls.length, 0);
      assert.equal([...rows.values()][0]!.status, 'failed');
    });
  }
});

test('client error shape follows the surface (Deepgram err_code, OpenAI error.type)', async () => {
  await withBoot({}, async (s) => {
    improvedMode = { status: 400 };
    const dg = await fetch(`${s.origin}/v1/listen`, { method: 'POST', headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'audio/wav' }, body: wavBytes() });
    assert.equal(dg.status, 400);
    assert.equal((await dg.json() as { err_code: string }).err_code, 'BAD_AUDIO');
    assert.equal(prodCalls.length, 0);
  });
});

test('improved 401 (bad token) -> fallback to prod AND an error-level log; no token in the log', async () => {
  await withBoot({}, async (s) => {
    improvedMode = { status: 401 };
    const r = await s.transcribe();
    assert.equal(r.status, 201);
    assert.equal(r.headers.get('x-stt-worker'), 'prod');
    assert.equal(usageCalls.length, 1);
    const errs = s.cap.parsed().filter((l) => l.level === 50);
    assert.ok(errs.some((l) => String(l.msg).includes('401')), 'error log for 401');
    assert.ok(!s.cap.lines.join('\n').includes(IMPROVED_TOKEN));
  });
});

test('no double billing and exactly one billing call per successful request across paths', async () => {
  await withBoot({}, async (s) => {
    await s.transcribe(); // improved ok
    improvedMode = { status: 500 };
    await s.transcribe(); // fallback ok
    assert.deepEqual(usageCalls.map((u) => u.seconds), [4.5, 3.5]);
  });
});

test('logs: scalars only, never token, transcript text, keyterms or gateway key', async () => {
  await withBoot({}, async (s) => {
    const mk = () => s.legacyForm([['keyterm', 'Zorblax-secret-term']]);
    const post = () => fetch(`${s.origin}/api/stt/transcriptions`, { method: 'POST', body: mk(), headers: { Authorization: 'Bearer valid-token' } });
    await post();                       // improved ok
    improvedMode = { status: 503 };
    await post();                       // fallback
    improvedMode = { status: 401 };
    await post();                       // 401 -> fallback
    improvedMode = { status: 400 };
    await post();                       // client error
    const all = s.cap.lines.join('\n');
    for (const secret of [IMPROVED_TOKEN, PROD_TOKEN, 'house-stt-key', 'Zorblax-secret-term', 'improved transcript hello', 'prod transcript hello', 'valid-token']) {
      assert.ok(!all.includes(secret), `log leaked ${secret}`);
    }
    const served = s.cap.parsed().filter((l) => l.msg === 'STT served');
    assert.deepEqual(served.map((l) => [l.worker, l.fallback_reason]), [['improved', null], ['prod', 'http_5xx'], ['prod', 'unauthorized']]);
    for (const l of served) assert.equal(typeof l.audio_seconds, 'number');
  });
});

// ---------------------------------------------------------------------------
// Warm
// ---------------------------------------------------------------------------

const settle = () => new Promise((r) => setTimeout(r, 30));

test('warm: auth required (401 without a token, no upstream call)', async () => {
  await withBoot({}, async (s) => {
    const r = await s.warm(false);
    assert.equal(r.status, 401);
    await settle();
    assert.equal(healthCalls.length, 0);
  }, { noAuth: true });
});

test('warm disabled (percent 0, or url/token missing): 202 warming:false, no upstream call', async () => {
  for (const over of [{ improvedPercent: 0 }, { improvedUrl: undefined }, { improvedToken: undefined }]) {
    await withBoot(over, async (s) => {
      const r = await s.warm();
      assert.equal(r.status, 202);
      assert.deepEqual(await r.json(), { warming: false });
      await settle();
      assert.equal(healthCalls.length, 0);
    });
  }
});

test('warm enabled: 202 warming:true, fires GET {url}/health without credentials', async () => {
  let seenInit: RequestInit | undefined;
  await withBoot({}, async (s) => {
    const inner = globalThis.fetch;
    globalThis.fetch = async (i: RequestInfo | URL, init?: RequestInit) => { if (String(i).endsWith('/health')) seenInit = init; return inner(i, init); };
    const r = await s.warm();
    assert.equal(r.status, 202);
    assert.deepEqual(await r.json(), { warming: true });
    await settle();
    assert.equal(healthCalls.length, 1);
    assert.equal(seenInit?.method, 'GET');
    assert.ok(!JSON.stringify(seenInit?.headers ?? {}).includes(IMPROVED_TOKEN));
  });
});

test('warm dedupe: one upstream call per 60 s window per instance, still 202 true', async () => {
  let t = 1_000_000;
  await withBoot({ now: () => t }, async (s) => {
    for (let i = 0; i < 3; i++) { const r = await s.warm(); assert.equal(r.status, 202); assert.deepEqual(await r.json(), { warming: true }); }
    await settle();
    assert.equal(healthCalls.length, 1);
    t += 59_000;
    await s.warm();
    await settle();
    assert.equal(healthCalls.length, 1);
    t += 2_000; // 61 s since the last upstream call
    await s.warm();
    await settle();
    assert.equal(healthCalls.length, 2);
  });
});

test('warm per-user limit: 6 per minute, 7th is 429 with Retry-After; window slides', async () => {
  let t = 5_000_000;
  await withBoot({ now: () => t }, async (s) => {
    for (let i = 0; i < 6; i++) assert.equal((await s.warm()).status, 202);
    const over = await s.warm();
    assert.equal(over.status, 429);
    assert.ok(Number(over.headers.get('retry-after')) >= 1);
    t += 61_000;
    assert.equal((await s.warm()).status, 202);
  });
});

test('warm: upstream failure (network error or HTTP 500) is swallowed; client still gets 202', async () => {
  for (const mode of ['throws', 'hang-status-500'] as const) {
    await withBoot({}, async (s) => {
      healthMode = mode;
      const r = await s.warm();
      assert.equal(r.status, 202);
      assert.deepEqual(await r.json(), { warming: true });
      await settle();
      assert.equal(healthCalls.length, 1);
    });
  }
});

test('warm: a synchronous throw from fetch is swallowed too', async () => {
  await withBoot({}, async (s) => {
    const inner = globalThis.fetch;
    globalThis.fetch = ((i: RequestInfo | URL, init?: RequestInit) => {
      if (String(i).endsWith('/health')) throw new Error('sync boom');
      return inner(i, init);
    }) as typeof fetch;
    const r = await s.warm();
    assert.equal(r.status, 202);
  });
});
