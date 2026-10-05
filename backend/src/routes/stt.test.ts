// npm test (node:test via tsx). Unit tests for the customer-facing batch STT route
// (backend/src/routes/stt.ts): request validation, the auth gate, the billing gate,
// per-key rate/concurrency limits, magic-byte upload sniffing + temp-file cleanup, retention,
// keyterms, and the Deepgram-/OpenAI-shaped /v1 compat routes. All external calls (Supabase auth/REST, the STT gateway's
// /stt/authorize, and worker-stt-prod's /v1/stt) are intercepted via a patched
// global.fetch — nothing real is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
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

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------
let resolvedUserId = 'test-user-1';
let billingActive = true;
type WorkerOk = { text: string; language: string; duration: number; words?: unknown[]; segments?: unknown[]; quality?: unknown; dictionary?: unknown };
let sttWorkerResult: WorkerOk | { errorStatus: number; body?: string } =
  { text: 'hello world', language: 'en', duration: 3.5 };
// When set, the mocked worker waits on this before answering (to hold requests in flight).
let workerGate: Promise<void> | null = null;
// Per-key settings rows served from the mocked stt_key_settings table, keyed by subject.
const keySettings = new Map<string, Record<string, unknown>>();

const transcriptions = new Map<string, Record<string, unknown>>();
let idCounter = 0;
const workerCalls: Array<{ auth: string; url: string; contentType: string; bytes: number }> = [];
const usageCalls: Array<{ userId: string; seconds: number }> = [];
const deleteFilters: string[] = [];
const authorizeCalls: { count: number } = { count: 0 };

let originalFetch: typeof globalThis.fetch;

function installFetchMock() {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();

    // Supabase auth (JWT verification)
    if (url === 'http://localhost:54321/auth/v1/user') {
      const token = (init?.headers as Record<string, string>)?.['Authorization']?.replace(/^Bearer /, '') || '';
      if (token === 'valid-token') {
        return new Response(JSON.stringify({ id: resolvedUserId, aud: 'authenticated' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ message: 'Invalid token', error: 'invalid_token' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    // Supabase REST — billing check
    if (url.includes('/realtimetts_free_credits')) {
      // Free-credit gate (hasUsageAllowance): exhausted, so inactive-billing tests still 402 quickly.
      return new Response(JSON.stringify([{ granted: 10000, used: 10000 }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/rest/v1/realtimetts_billing')) {
      const u = new URL(url);
      const uid = u.searchParams.get('user_id')?.replace(/^eq\./, '');
      if (billingActive && uid === resolvedUserId) {
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

    // Supabase REST — stt_key_settings (per-key retention / limits)
    if (url.includes('/rest/v1/stt_key_settings')) {
      const subject = new URL(url).searchParams.get('subject')?.replace(/^eq\./, '') ?? '';
      const row = keySettings.get(subject);
      return new Response(JSON.stringify(row ? [row] : []), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Supabase REST — stt_transcriptions (insert/update/select/delete)
    if (url.includes('/rest/v1/stt_transcriptions')) {
      const method = (init?.method || 'GET').toUpperCase();
      const u = new URL(url);

      if (method === 'POST') {
        const body = JSON.parse((init?.body as string) || '{}');
        const id = `txn-${(++idCounter).toString().padStart(4, '0')}`;
        const row = { id, ...body };
        transcriptions.set(id, row);
        return new Response(JSON.stringify(row), { status: 201, headers: { 'Content-Type': 'application/json' } });
      }

      if (method === 'PATCH') {
        const idFilter = u.searchParams.get('id')?.replace(/^eq\./, '');
        const body = JSON.parse((init?.body as string) || '{}');
        const existing = idFilter ? transcriptions.get(idFilter) : undefined;
        if (existing) transcriptions.set(idFilter!, { ...existing, ...body });
        return new Response(JSON.stringify(existing ? [{ ...existing, ...body }] : []), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (method === 'DELETE') {
        deleteFilters.push(u.search);
        if (u.searchParams.get('expires_at')?.startsWith('lt.')) {
          return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json', 'Content-Range': '*/3' } });
        }
        const idFilter = u.searchParams.get('id')?.replace(/^eq\./, '');
        const uidFilter = u.searchParams.get('user_id')?.replace(/^eq\./, '');
        const existing = idFilter ? transcriptions.get(idFilter) : undefined;
        if (existing && existing.user_id === uidFilter) {
          transcriptions.delete(idFilter!);
          return new Response(JSON.stringify([existing]), { status: 200, headers: { 'Content-Type': 'application/json', 'Content-Range': '0-0/1' } });
        }
        return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json', 'Content-Range': '*/0' } });
      }

      // GET (list or single)
      const idFilter = u.searchParams.get('id')?.replace(/^eq\./, '');
      const uidFilter = u.searchParams.get('user_id')?.replace(/^eq\./, '');
      let rows = Array.from(transcriptions.values());
      if (idFilter) rows = rows.filter((r) => r.id === idFilter);
      if (uidFilter) rows = rows.filter((r) => r.user_id === uidFilter);
      return new Response(JSON.stringify(rows), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // STT gateway authorize hand-off (STT_API_KEY -> short-lived worker session token)
    if (url === 'https://gateway.test/stt/authorize') {
      authorizeCalls.count += 1;
      return new Response(JSON.stringify({ token: 'session-token', url: 'https://worker.test' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // worker-stt-prod
    if (url.startsWith('https://worker.test/v1/stt')) {
      const auth = (init?.headers as Record<string, string>)?.['Authorization'] || '';
      const hdrs = (init?.headers ?? {}) as Record<string, string>;
      const bodyBytes = init?.body ? (await new Response(init.body as BodyInit).arrayBuffer()).byteLength : 0;
      workerCalls.push({ auth, url, contentType: hdrs['Content-Type'] ?? '', bytes: bodyBytes });
      if (workerGate) await workerGate;
      if ('errorStatus' in sttWorkerResult) {
        return new Response(sttWorkerResult.body ?? 'worker error', { status: sttWorkerResult.errorStatus });
      }
      return new Response(JSON.stringify(sttWorkerResult), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    return originalFetch(input, init);
  };
}

function uninstallFetchMock() {
  globalThis.fetch = originalFetch;
}

// ---------------------------------------------------------------------------
// Boot helpers
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];
function freshTmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-test-'));
  tmpDirs.push(d);
  return d;
}

async function boot(opts: { presetUserId?: string; keyId?: string; limits?: Record<string, unknown> } = {}) {
  const { createSttRouters } = await import('./stt.js');
  const tmpDir = freshTmpDir();
  const { sttRouter, sttCompatRouter } = createSttRouters({
    tmpDir,
    reportUsage: async (userId: string, seconds: number) => { usageCalls.push({ userId, seconds }); },
    settingsTtlMs: 0,
    ...(opts.limits ?? {}),
  });

  const app = express();
  app.use(express.json());
  if (opts.presetUserId) {
    // Simulates requireAuthOrApiKey having already resolved an identity.
    app.use((req, _res, next) => {
      const r = req as express.Request & { userId?: string; authMethod?: string };
      r.userId = opts.presetUserId;
      if (opts.keyId) { r.authMethod = 'gateway-key'; req.headers['x-gateway-key-id'] = opts.keyId; }
      next();
    });
  }
  app.use('/api/stt', sttRouter);
  app.use('/v1', sttCompatRouter);
  const server = app.listen(0);
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const base = `${origin}/api/stt`;

  const call = (token: string | null, method: string, p: string, body?: FormData) =>
    fetch(base + p, {
      method,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body,
    });
  // Any path under the origin, arbitrary headers/body (raw audio, JSON, multipart).
  const raw = (token: string | null, method: string, p: string, body?: BodyInit, headers: Record<string, string> = {}) =>
    fetch(origin + p, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body });

  return { call, raw, tmpDir, server, close: () => { server.close(); } };
}

/** A buffer that starts with a valid RIFF/WAVE/fmt header (the rest is filler: the worker is mocked). */
function wavBytes(n = 2048): Buffer {
  const b = Buffer.alloc(n, 1);
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(n - 8, 4); b.write('WAVE', 8, 'ascii'); b.write('fmt ', 12, 'ascii');
  return b;
}
function pngBytes(n = 2048): Buffer {
  const b = Buffer.alloc(n, 1);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  return b;
}

function buildAudioForm(opts: { mimetype?: string; bytes?: Buffer; language?: string; wordTimestamps?: boolean; field?: string; extra?: Array<[string, string]> } = {}): FormData {
  const form = new FormData();
  const bytes = opts.bytes ?? wavBytes();
  form.append(opts.field ?? 'audio', new Blob([bytes], { type: opts.mimetype ?? 'audio/wav' }), 'audio.wav');
  if (opts.language) form.append('language', opts.language);
  if (opts.wordTimestamps) form.append('word_timestamps', 'true');
  for (const [k, v] of opts.extra ?? []) form.append(k, v);
  return form;
}
const fileForm = (extra: Array<[string, string]> = [], bytes?: Buffer) => buildAudioForm({ field: 'file', extra, bytes });

// ---------------------------------------------------------------------------
// Reset state before each test
// ---------------------------------------------------------------------------

function resetState() {
  transcriptions.clear();
  idCounter = 0;
  resolvedUserId = 'test-user-1';
  billingActive = true;
  sttWorkerResult = { text: 'hello world', language: 'en', duration: 3.5 };
  workerCalls.length = 0;
  authorizeCalls.count = 0;
  usageCalls.length = 0;
  deleteFilters.length = 0;
  keySettings.clear();
  workerGate = null;
}
const listTmp = (dir: string) => fs.readdirSync(dir);
// Cleanup is awaited before the response is sent, but give the event loop a turn anyway.
const settle = () => new Promise((r) => setTimeout(r, 20));

// ---------------------------------------------------------------------------
// Auth gate
// ---------------------------------------------------------------------------

test('no token -> 401', async () => {
  installFetchMock();
  resetState();
  const s = await boot();
  const r = await s.call(null, 'POST', '/transcriptions', buildAudioForm());
  assert.equal(r.status, 401);
  s.close();
  uninstallFetchMock();
});

test('pre-resolved identity (bridge) without an active subscription -> 402, not skipped', async () => {
  installFetchMock();
  resetState();
  billingActive = false;
  const s = await boot({ presetUserId: resolvedUserId });
  const r = await s.call(null, 'POST', '/transcriptions', buildAudioForm());
  assert.equal(r.status, 402);
  s.close();
  uninstallFetchMock();
});

test('invalid token -> 401', async () => {
  installFetchMock();
  resetState();
  const s = await boot();
  const r = await s.call('bad-token', 'POST', '/transcriptions', buildAudioForm());
  assert.equal(r.status, 401);
  s.close();
  uninstallFetchMock();
});

test('GET /transcriptions with no token -> 401', async () => {
  installFetchMock();
  resetState();
  const s = await boot();
  const r = await s.call(null, 'GET', '/transcriptions');
  assert.equal(r.status, 401);
  s.close();
  uninstallFetchMock();
});

// ---------------------------------------------------------------------------
// Billing gate
// ---------------------------------------------------------------------------

test('billing inactive -> 402, no transcription row created', async () => {
  installFetchMock();
  resetState();
  billingActive = false;
  const s = await boot();
  const r = await s.call('valid-token', 'POST', '/transcriptions', buildAudioForm());
  assert.equal(r.status, 402);
  assert.equal(transcriptions.size, 0);
  s.close();
  uninstallFetchMock();
});

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

test('missing audio file -> 400', async () => {
  installFetchMock();
  resetState();
  const s = await boot();
  const form = new FormData();
  const r = await s.call('valid-token', 'POST', '/transcriptions', form);
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.match(body.error, /Audio file is required/);
  s.close();
  uninstallFetchMock();
});

test('empty/near-empty audio file -> 400', async () => {
  installFetchMock();
  resetState();
  const s = await boot();
  const r = await s.call('valid-token', 'POST', '/transcriptions', buildAudioForm({ bytes: Buffer.alloc(10) }));
  assert.equal(r.status, 400);
  s.close();
  uninstallFetchMock();
});

test('unsupported file type -> 400', async () => {
  installFetchMock();
  resetState();
  const s = await boot();
  const r = await s.call('valid-token', 'POST', '/transcriptions', buildAudioForm({ mimetype: 'image/png', bytes: pngBytes() }));
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.match(body.error, /Unsupported audio format/);
  s.close();
  uninstallFetchMock();
});

test('invalid language hint -> 400', async () => {
  installFetchMock();
  resetState();
  const s = await boot();
  const r = await s.call('valid-token', 'POST', '/transcriptions', buildAudioForm({ language: 'english' }));
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.match(body.error, /Unsupported language hint/);
  s.close();
  uninstallFetchMock();
});

test('valid ISO-639-1 language hint is accepted', async () => {
  installFetchMock();
  resetState();
  const s = await boot();
  const r = await s.call('valid-token', 'POST', '/transcriptions', buildAudioForm({ language: 'en' }));
  assert.equal(r.status, 201);
  s.close();
  uninstallFetchMock();
});

// ---------------------------------------------------------------------------
// Happy path — submits, authorizes against the gateway, calls the worker,
// persists the result, and reports usage.
// ---------------------------------------------------------------------------

test('create transcription authorizes with STT_API_KEY and returns the transcript', async () => {
  installFetchMock();
  resetState();
  const s = await boot();
  const r = await s.call('valid-token', 'POST', '/transcriptions', buildAudioForm());
  assert.equal(r.status, 201);
  const body = await r.json();
  assert.equal(body.status, 'done');
  assert.equal(body.text, 'hello world');
  assert.equal(body.language, 'en');
  assert.equal(authorizeCalls.count, 1);
  assert.equal(workerCalls.length, 1);
  assert.equal(workerCalls[0].auth, 'Bearer session-token');
  s.close();
  uninstallFetchMock();
});

test('worker failure marks the row failed and returns 502', async () => {
  installFetchMock();
  resetState();
  sttWorkerResult = { errorStatus: 500, body: 'worker exploded' };
  const s = await boot();
  const r = await s.call('valid-token', 'POST', '/transcriptions', buildAudioForm());
  assert.equal(r.status, 502);
  const body = await r.json();
  assert.equal(body.status, 'failed');
  s.close();
  uninstallFetchMock();
});

test('GET /transcriptions lists only the caller\'s own rows', async () => {
  installFetchMock();
  resetState();
  const s = await boot();
  await s.call('valid-token', 'POST', '/transcriptions', buildAudioForm());

  resolvedUserId = 'test-user-2';
  const other = await boot();
  await other.call('valid-token', 'POST', '/transcriptions', buildAudioForm());

  const listRes = await s.call('valid-token', 'GET', '/transcriptions');
  const listBody = await listRes.json();
  assert.equal(listBody.transcriptions.length, 1);

  s.close();
  other.close();
  uninstallFetchMock();
});

test('GET /transcriptions/:id 404s for another user\'s row', async () => {
  installFetchMock();
  resetState();
  const s = await boot();
  const create = await s.call('valid-token', 'POST', '/transcriptions', buildAudioForm());
  const { id } = await create.json();

  resolvedUserId = 'test-user-2';
  const r = await s.call('valid-token', 'GET', `/transcriptions/${id}`);
  assert.equal(r.status, 404);
  s.close();
  uninstallFetchMock();
});

test('DELETE /transcriptions/:id removes the row for its owner', async () => {
  installFetchMock();
  resetState();
  const s = await boot();
  const create = await s.call('valid-token', 'POST', '/transcriptions', buildAudioForm());
  const { id } = await create.json();

  const del = await s.call('valid-token', 'DELETE', `/transcriptions/${id}`);
  assert.equal(del.status, 200);
  const body = await del.json();
  assert.equal(body.deleted, true);
  assert.equal(transcriptions.has(id), false);
  s.close();
  uninstallFetchMock();
});

test('DELETE /transcriptions/:id 404s for a non-existent id', async () => {
  installFetchMock();
  resetState();
  const s = await boot();
  const del = await s.call('valid-token', 'DELETE', '/transcriptions/does-not-exist');
  assert.equal(del.status, 404);
  s.close();
  uninstallFetchMock();
});

// ---------------------------------------------------------------------------
// Upload handling: magic-byte sniffing (client MIME is ignored), size cap, temp-file cleanup
// ---------------------------------------------------------------------------

test('client MIME is ignored: PNG bytes labelled audio/wav -> 400', async () => {
  installFetchMock(); resetState();
  const s = await boot();
  const r = await s.call('valid-token', 'POST', '/transcriptions', buildAudioForm({ mimetype: 'audio/wav', bytes: pngBytes() }));
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /Unsupported audio format/);
  assert.equal(workerCalls.length, 0);
  assert.equal(transcriptions.size, 0);
  await settle();
  assert.deepEqual(listTmp(s.tmpDir), []);
  s.close(); uninstallFetchMock();
});

test('client MIME is ignored: real WAV labelled text/plain is accepted and forwarded as audio/wav', async () => {
  installFetchMock(); resetState();
  const s = await boot();
  const r = await s.call('valid-token', 'POST', '/transcriptions', buildAudioForm({ mimetype: 'text/plain' }));
  assert.equal(r.status, 201);
  assert.equal(workerCalls[0]!.contentType, 'audio/wav');
  s.close(); uninstallFetchMock();
});

test('every supported container is recognised from its magic bytes', async () => {
  const { sniffAudio } = await import('../lib/sttUpload.js');
  const mk = (head: number[] | string, at = 0) => { const b = Buffer.alloc(256, 7); (typeof head === 'string' ? Buffer.from(head, 'latin1') : Buffer.from(head)).copy(b, at); return b; };
  const wav = wavBytes(256);
  assert.equal(sniffAudio(wav)?.mime, 'audio/wav');
  assert.equal(sniffAudio(mk('fLaC'))?.mime, 'audio/flac');
  assert.equal(sniffAudio(mk('OggS'))?.mime, 'audio/ogg');
  assert.equal(sniffAudio(mk('ID3'))?.mime, 'audio/mpeg');
  assert.equal(sniffAudio(mk([0xff, 0xfb, 0x90]))?.mime, 'audio/mpeg');
  assert.equal(sniffAudio(mk('ftypM4A ', 4))?.mime, 'audio/mp4');
  assert.equal(sniffAudio(mk([0x1a, 0x45, 0xdf, 0xa3]))?.mime, 'audio/webm');
  assert.equal(sniffAudio(pngBytes(256)), null);
  assert.equal(sniffAudio(Buffer.from('<html>not audio</html>')), null);
  const noFmt = Buffer.alloc(256, 1); noFmt.write('RIFF', 0, 'ascii'); noFmt.write('WAVE', 8, 'ascii');
  assert.equal(sniffAudio(noFmt), null, 'RIFF/WAVE without a fmt chunk is malformed');
  const avi = Buffer.alloc(256, 1); avi.write('RIFF', 0, 'ascii'); avi.write('AVI ', 8, 'ascii');
  assert.equal(sniffAudio(avi), null, 'RIFF but not WAVE');
});

test('oversized upload -> 413 and no temp file is left behind', async () => {
  installFetchMock(); resetState();
  const s = await boot({ limits: { maxUploadBytes: 4096 } });
  const r = await s.call('valid-token', 'POST', '/transcriptions', buildAudioForm({ bytes: wavBytes(64 * 1024) }));
  assert.equal(r.status, 413);
  assert.equal(workerCalls.length, 0);
  await settle();
  assert.deepEqual(listTmp(s.tmpDir), []);
  s.close(); uninstallFetchMock();
});

test('temp files are removed after success and after a worker failure', async () => {
  installFetchMock(); resetState();
  const s = await boot();
  assert.equal((await s.call('valid-token', 'POST', '/transcriptions', buildAudioForm())).status, 201);
  await settle();
  assert.deepEqual(listTmp(s.tmpDir), []);
  sttWorkerResult = { errorStatus: 500, body: 'boom' };
  assert.equal((await s.call('valid-token', 'POST', '/transcriptions', buildAudioForm())).status, 502);
  await settle();
  assert.deepEqual(listTmp(s.tmpDir), []);
  s.close(); uninstallFetchMock();
});

test('the whole file is streamed to the worker', async () => {
  installFetchMock(); resetState();
  const s = await boot();
  const bytes = wavBytes(300_000);
  assert.equal((await s.call('valid-token', 'POST', '/transcriptions', buildAudioForm({ bytes }))).status, 201);
  assert.equal(workerCalls[0]!.bytes, bytes.length);
  s.close(); uninstallFetchMock();
});

test('workerBody streams a temp file to a real HTTP server with a Content-Length', async () => {
  const { workerBody } = await import('../lib/sttUpload.js');
  const http = await import('node:http');
  const dir = freshTmpDir();
  const p = path.join(dir, 'a.bin');
  const data = Buffer.alloc(1_500_000, 9);
  fs.writeFileSync(p, data);
  let got = 0; let cl = '';
  const srv = http.createServer((req, res) => {
    cl = String(req.headers['content-length']);
    req.on('data', (c: Buffer) => { got += c.length; });
    req.on('end', () => { res.end('ok'); });
  }).listen(0);
  const port = (srv.address() as AddressInfo).port;
  const r = await fetch(`http://127.0.0.1:${port}/x`, { method: 'POST', ...workerBody(p, data.length, 'audio/wav') });
  assert.equal(await r.text(), 'ok');
  assert.equal(got, data.length);
  assert.equal(cl, String(data.length));
  srv.close();
});

// ---------------------------------------------------------------------------
// Keyterms / dictionary forwarding and W18 quality passthrough (legacy route)
// ---------------------------------------------------------------------------

test('keyterm, keyterms and dictionary fields are merged, deduped and forwarded as repeated keyterm params', async () => {
  installFetchMock(); resetState();
  const s = await boot();
  const r = await s.call('valid-token', 'POST', '/transcriptions', buildAudioForm({
    extra: [['keyterm', 'Kubernetes'], ['keyterm', 'Dr. Okonkwo'], ['keyterms', 'Kubernetes, Fly.io\nVoxKey'], ['dictionary', '["Piper","Nemotron"]']],
  }));
  assert.equal(r.status, 201);
  const u = new URL(workerCalls[0]!.url);
  assert.deepEqual(u.searchParams.getAll('keyterm'), ['Kubernetes', 'Dr. Okonkwo', 'Fly.io', 'VoxKey', 'Piper', 'Nemotron']);
  s.close(); uninstallFetchMock();
});

test('no keyterms -> no keyterm param is sent (request to the worker is unchanged)', async () => {
  installFetchMock(); resetState();
  const s = await boot();
  await s.call('valid-token', 'POST', '/transcriptions', buildAudioForm({ language: 'en' }));
  const u = new URL(workerCalls[0]!.url);
  assert.equal(u.searchParams.has('keyterm'), false);
  assert.equal(u.searchParams.get('language'), 'en');
  s.close(); uninstallFetchMock();
});

test('too many keyterms -> 400', async () => {
  installFetchMock(); resetState();
  const s = await boot({ limits: { maxKeyterms: 3 } });
  const r = await s.call('valid-token', 'POST', '/transcriptions', buildAudioForm({ extra: [['keyterms', 'a,b,c,d']] }));
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /keyterms/i);
  assert.equal(workerCalls.length, 0);
  s.close(); uninstallFetchMock();
});

test('keyterms that would overflow the worker query string -> 400', async () => {
  installFetchMock(); resetState();
  const s = await boot({ limits: { keytermsMaxQueryBytes: 60 } });
  const r = await s.call('valid-token', 'POST', '/transcriptions', buildAudioForm({ extra: [['keyterms', 'alpha,bravo,charlie,delta,echo,foxtrot,golf,hotel']] }));
  assert.equal(r.status, 400);
  s.close(); uninstallFetchMock();
});

test('worker quality / dictionary objects are passed through untouched', async () => {
  installFetchMock(); resetState();
  const quality = { snr_db_est: 9.5, low_quality: true, needs_confirmation: [{ kind: 'number', text: '555' }] };
  sttWorkerResult = { text: 'call 555', language: 'en', duration: 2, quality, dictionary: { truncated: false } };
  const s = await boot();
  const r = await s.call('valid-token', 'POST', '/transcriptions', buildAudioForm());
  const body = await r.json();
  assert.deepEqual(body.quality, quality);
  assert.deepEqual(body.dictionary, { truncated: false });
  s.close(); uninstallFetchMock();
});

// ---------------------------------------------------------------------------
// Retention: zero by default, per-key opt-in, delete, purge
// ---------------------------------------------------------------------------

test('default retention: transcript text is NOT stored, only metadata; response still carries the text', async () => {
  installFetchMock(); resetState();
  sttWorkerResult = { text: 'secret words', language: 'en', duration: 3.5, words: [{ word: 'secret', start: 0, end: 1 }], segments: [{ id: 0, start: 0, end: 1, text: 'secret' }] };
  const s = await boot();
  const r = await s.call('valid-token', 'POST', '/transcriptions', buildAudioForm());
  const body = await r.json();
  assert.equal(body.text, 'secret words');
  const row = transcriptions.get(body.id)!;
  assert.equal(row.status, 'done');
  assert.equal(row.duration_seconds, 3.5);
  assert.equal(row.text ?? null, null);
  assert.equal(row.words ?? null, null);
  assert.equal(row.segments ?? null, null);
  assert.equal(row.expires_at ?? null, null);
  assert.equal(row.retention_days, 0);
  assert.equal(JSON.stringify(row).includes('secret'), false, 'no transcript content anywhere in the stored row');
  s.close(); uninstallFetchMock();
});

test('per-key retention opt-in stores the text with an expires_at', async () => {
  installFetchMock(); resetState();
  keySettings.set('test-user-1', { subject: 'test-user-1', retention_days: 7 });
  const s = await boot();
  const before = Date.now();
  const body = await (await s.call('valid-token', 'POST', '/transcriptions', buildAudioForm())).json();
  const row = transcriptions.get(body.id)!;
  assert.equal(row.text, 'hello world');
  assert.equal(row.retention_days, 7);
  const exp = Date.parse(String(row.expires_at));
  assert.ok(Math.abs(exp - (before + 7 * 86400_000)) < 60_000);
  s.close(); uninstallFetchMock();
});

test('retention days are capped at the configured maximum', async () => {
  installFetchMock(); resetState();
  keySettings.set('test-user-1', { subject: 'test-user-1', retention_days: 365 });
  const s = await boot({ limits: { maxRetentionDays: 30 } });
  const body = await (await s.call('valid-token', 'POST', '/transcriptions', buildAudioForm())).json();
  assert.equal(transcriptions.get(body.id)!.retention_days, 30);
  s.close(); uninstallFetchMock();
});

test('a failed request never stores text, even with retention on', async () => {
  installFetchMock(); resetState();
  keySettings.set('test-user-1', { subject: 'test-user-1', retention_days: 7 });
  sttWorkerResult = { errorStatus: 500 };
  const s = await boot();
  const r = await s.call('valid-token', 'POST', '/transcriptions', buildAudioForm());
  assert.equal(r.status, 502);
  const row = Array.from(transcriptions.values())[0]!;
  assert.equal(row.status, 'failed');
  assert.equal(row.text ?? null, null);
  s.close(); uninstallFetchMock();
});

test('purgeExpiredSttTranscripts deletes rows whose expires_at is in the past', async () => {
  installFetchMock(); resetState();
  const { purgeExpiredSttTranscripts } = await import('./stt.js');
  const n = await purgeExpiredSttTranscripts(new Date('2026-10-04T00:00:00Z'));
  assert.equal(n, 3);
  assert.ok(deleteFilters.some((f) => f.includes('expires_at=lt.2026-10-04')));
  uninstallFetchMock();
});

// ---------------------------------------------------------------------------
// Per-key rate limit + concurrency cap (429 + Retry-After)
// ---------------------------------------------------------------------------

test('per-key rate limit: 429 with Retry-After after N requests/minute, other keys unaffected', async () => {
  installFetchMock(); resetState();
  const s = await boot({ limits: { ratePerMin: 3 } });
  for (let i = 0; i < 3; i++) assert.equal((await s.call('valid-token', 'POST', '/transcriptions', buildAudioForm())).status, 201);
  const limited = await s.call('valid-token', 'POST', '/transcriptions', buildAudioForm());
  assert.equal(limited.status, 429);
  const ra = Number(limited.headers.get('retry-after'));
  assert.ok(ra >= 1 && ra <= 60, `Retry-After ${ra}`);
  resolvedUserId = 'test-user-2';
  assert.equal((await s.call('valid-token', 'POST', '/transcriptions', buildAudioForm())).status, 201);
  s.close(); uninstallFetchMock();
});

test('rate limit is per gateway key id, not just per user', async () => {
  installFetchMock(); resetState();
  const a = await boot({ presetUserId: 'test-user-1', keyId: 'key-A', limits: { ratePerMin: 1 } });
  assert.equal((await a.call(null, 'POST', '/transcriptions', buildAudioForm())).status, 201);
  assert.equal((await a.call(null, 'POST', '/transcriptions', buildAudioForm())).status, 429);
  a.close();
  uninstallFetchMock();
});

test('per-key settings row overrides the default rate limit', async () => {
  installFetchMock(); resetState();
  keySettings.set('test-user-1', { subject: 'test-user-1', rate_per_min: 1 });
  const s = await boot({ limits: { ratePerMin: 100 } });
  assert.equal((await s.call('valid-token', 'POST', '/transcriptions', buildAudioForm())).status, 201);
  assert.equal((await s.call('valid-token', 'POST', '/transcriptions', buildAudioForm())).status, 429);
  s.close(); uninstallFetchMock();
});

test('concurrency cap: the 3rd in-flight request for a key gets 429 + Retry-After; capacity frees on completion', async () => {
  installFetchMock(); resetState();
  let open!: () => void;
  workerGate = new Promise<void>((r) => { open = r; });
  const s = await boot({ limits: { maxConcurrentPerKey: 2, ratePerMin: 1000 } });
  const p1 = s.call('valid-token', 'POST', '/transcriptions', buildAudioForm());
  const p2 = s.call('valid-token', 'POST', '/transcriptions', buildAudioForm());
  for (let i = 0; i < 100 && workerCalls.length < 2; i++) await settle();
  assert.equal(workerCalls.length, 2);
  const third = await s.call('valid-token', 'POST', '/transcriptions', buildAudioForm());
  assert.equal(third.status, 429);
  assert.ok(Number(third.headers.get('retry-after')) >= 1);
  assert.equal(workerCalls.length, 2, 'rejected request never reached the worker');
  open();
  assert.equal((await p1).status, 201);
  assert.equal((await p2).status, 201);
  await settle();
  workerGate = null;
  assert.equal((await s.call('valid-token', 'POST', '/transcriptions', buildAudioForm())).status, 201);
  s.close(); uninstallFetchMock();
});

test('global concurrency cap applies across keys', async () => {
  installFetchMock(); resetState();
  let open!: () => void;
  workerGate = new Promise<void>((r) => { open = r; });
  const s = await boot({ limits: { maxConcurrentGlobal: 1, maxConcurrentPerKey: 5, ratePerMin: 1000 } });
  const p1 = s.call('valid-token', 'POST', '/transcriptions', buildAudioForm());
  for (let i = 0; i < 100 && workerCalls.length < 1; i++) await settle();
  resolvedUserId = 'test-user-2';
  assert.equal((await s.call('valid-token', 'POST', '/transcriptions', buildAudioForm())).status, 429);
  open();
  await p1;
  s.close(); uninstallFetchMock();
});

// ---------------------------------------------------------------------------
// Billing: per-second metering via reportUsage, failures unbilled
// ---------------------------------------------------------------------------

test('successful request reports the decoded audio seconds exactly once', async () => {
  installFetchMock(); resetState();
  const s = await boot();
  await s.call('valid-token', 'POST', '/transcriptions', buildAudioForm());
  await settle();
  assert.deepEqual(usageCalls, [{ userId: 'test-user-1', seconds: 3.5 }]);
  s.close(); uninstallFetchMock();
});

test('failed requests (worker 500, 413, bad audio) are never billed', async () => {
  installFetchMock(); resetState();
  sttWorkerResult = { errorStatus: 500 };
  const s = await boot({ limits: { maxUploadBytes: 5000 } });
  await s.call('valid-token', 'POST', '/transcriptions', buildAudioForm());
  await s.call('valid-token', 'POST', '/transcriptions', buildAudioForm({ bytes: wavBytes(20_000) }));
  await s.call('valid-token', 'POST', '/transcriptions', buildAudioForm({ bytes: pngBytes() }));
  await settle();
  assert.deepEqual(usageCalls, []);
  s.close(); uninstallFetchMock();
});

// ---------------------------------------------------------------------------
// Deepgram-shaped POST /v1/listen
// ---------------------------------------------------------------------------

const WORDS = [{ word: 'hello', start: 0.1, end: 0.5 }, { word: 'world.', start: 0.6, end: 1.0, probability: 0.9 }];

test('/v1/listen requires auth', async () => {
  installFetchMock(); resetState();
  const s = await boot();
  const r = await s.raw(null, 'POST', '/v1/listen', wavBytes(), { 'Content-Type': 'audio/wav' });
  assert.equal(r.status, 401);
  s.close(); uninstallFetchMock();
});

test('/v1/listen returns the Deepgram prerecorded shape', async () => {
  installFetchMock(); resetState();
  sttWorkerResult = { text: 'hello world.', language: 'en', duration: 3.5, words: WORDS };
  const s = await boot();
  const r = await s.raw('valid-token', 'POST', '/v1/listen?model=nova-3&language=en&punctuate=true&smart_format=true&diarize=true&utterances=true', wavBytes(), { 'Content-Type': 'audio/wav' });
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(typeof b.metadata.request_id, 'string');
  assert.equal(b.metadata.duration, 3.5);
  assert.equal(b.metadata.channels, 1);
  assert.ok(Array.isArray(b.metadata.models));
  const alt = b.results.channels[0].alternatives[0];
  assert.equal(alt.transcript, 'hello world.');
  assert.equal(alt.words.length, 2);
  assert.deepEqual(Object.keys(alt.words[1]).sort(), ['confidence', 'end', 'punctuated_word', 'start', 'word']);
  assert.equal(alt.words[1].word, 'world');
  assert.equal(alt.words[1].punctuated_word, 'world.');
  assert.equal(alt.words[1].confidence, 0.9);
  assert.equal(alt.words[0].confidence, null, 'no fabricated confidence when the worker gives none');
  assert.equal(r.headers.get('x-request-id'), b.metadata.request_id);
  const u = new URL(workerCalls[0]!.url);
  assert.equal(u.searchParams.get('language'), 'en');
  assert.equal(u.searchParams.get('word_timestamps'), 'true');
  assert.equal(workerCalls[0]!.contentType, 'audio/wav');
  await settle();
  assert.deepEqual(usageCalls, [{ userId: 'test-user-1', seconds: 3.5 }]);
  s.close(); uninstallFetchMock();
});

test('/v1/listen: repeated keyterm params are forwarded; language variants normalised', async () => {
  installFetchMock(); resetState();
  const s = await boot();
  const r = await s.raw('valid-token', 'POST', '/v1/listen?language=en-US&keyterm=Kubernetes&keyterm=Fly.io&keyterm=Kubernetes', wavBytes(), { 'Content-Type': 'application/octet-stream' });
  assert.equal(r.status, 200);
  const u = new URL(workerCalls[0]!.url);
  assert.deepEqual(u.searchParams.getAll('keyterm'), ['Kubernetes', 'Fly.io']);
  assert.equal(u.searchParams.get('language'), 'en');
  s.close(); uninstallFetchMock();
});

test('/v1/listen: language=multi means auto-detect (no language sent)', async () => {
  installFetchMock(); resetState();
  const s = await boot();
  await s.raw('valid-token', 'POST', '/v1/listen?language=multi', wavBytes(), { 'Content-Type': 'audio/wav' });
  assert.equal(new URL(workerCalls[0]!.url).searchParams.has('language'), false);
  s.close(); uninstallFetchMock();
});

test('/v1/listen: punctuate=false strips punctuation from transcript and words', async () => {
  installFetchMock(); resetState();
  sttWorkerResult = { text: 'Hello, world.', language: 'en', duration: 2, words: [{ word: 'Hello,', start: 0, end: 1 }, { word: 'world.', start: 1, end: 2 }] };
  const s = await boot();
  const b = await (await s.raw('valid-token', 'POST', '/v1/listen?punctuate=false', wavBytes(), { 'Content-Type': 'audio/wav' })).json();
  const alt = b.results.channels[0].alternatives[0];
  assert.equal(alt.transcript, 'Hello world');
  assert.equal(alt.words[0].punctuated_word, 'Hello');
  s.close(); uninstallFetchMock();
});

test('/v1/listen: W18 quality object is surfaced as results.quality (passthrough)', async () => {
  installFetchMock(); resetState();
  const quality = { snr_db_est: 8, low_quality: true, risk: 0.7, needs_confirmation: [{ kind: 'number', text: '5' }] };
  sttWorkerResult = { text: 'x', language: 'en', duration: 2, words: WORDS, quality };
  const s = await boot();
  const b = await (await s.raw('valid-token', 'POST', '/v1/listen', wavBytes(), { 'Content-Type': 'audio/wav' })).json();
  assert.deepEqual(b.results.quality, quality);
  assert.deepEqual(b.results.channels[0].alternatives[0].needs_confirmation, quality.needs_confirmation);
  s.close(); uninstallFetchMock();
});

test('/v1/listen rejects JSON {url} bodies (no URL fetching) and multipart, with Deepgram-style errors', async () => {
  installFetchMock(); resetState();
  const s = await boot();
  const j = await s.raw('valid-token', 'POST', '/v1/listen', JSON.stringify({ url: 'http://169.254.169.254/latest' }), { 'Content-Type': 'application/json' });
  assert.equal(j.status, 400);
  const jb = await j.json();
  assert.equal(jb.err_code, 'URL_INPUT_UNSUPPORTED');
  assert.equal(typeof jb.err_msg, 'string');
  assert.equal(typeof jb.request_id, 'string');
  const m = await s.raw('valid-token', 'POST', '/v1/listen', buildAudioForm());
  assert.equal(m.status, 400);
  assert.equal(workerCalls.length, 0);
  s.close(); uninstallFetchMock();
});

test('/v1/listen: callback is rejected (async mode not supported)', async () => {
  installFetchMock(); resetState();
  const s = await boot();
  const r = await s.raw('valid-token', 'POST', '/v1/listen?callback=https://evil.example/', wavBytes(), { 'Content-Type': 'audio/wav' });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).err_code, 'CALLBACK_UNSUPPORTED');
  s.close(); uninstallFetchMock();
});

test('/v1/listen: bad bytes -> 400, empty body -> 400, oversize -> 413, all unbilled and no temp files', async () => {
  installFetchMock(); resetState();
  const s = await boot({ limits: { maxUploadBytes: 8192 } });
  const bad = await s.raw('valid-token', 'POST', '/v1/listen', pngBytes(), { 'Content-Type': 'audio/wav' });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).err_code, 'UNSUPPORTED_AUDIO');
  const empty = await s.raw('valid-token', 'POST', '/v1/listen', new Uint8Array(0), { 'Content-Type': 'audio/wav' });
  assert.equal(empty.status, 400);
  const big = await s.raw('valid-token', 'POST', '/v1/listen', wavBytes(100_000), { 'Content-Type': 'audio/wav' });
  assert.equal(big.status, 413);
  assert.equal((await big.json()).err_code, 'PAYLOAD_TOO_LARGE');
  await settle();
  assert.deepEqual(listTmp(s.tmpDir), []);
  assert.equal(workerCalls.length, 0);
  assert.deepEqual(usageCalls, []);
  s.close(); uninstallFetchMock();
});

test('/v1/listen: bad query values -> 400', async () => {
  installFetchMock(); resetState();
  const s = await boot();
  const r = await s.raw('valid-token', 'POST', '/v1/listen?punctuate=maybe', wavBytes(), { 'Content-Type': 'audio/wav' });
  assert.equal(r.status, 400);
  const r2 = await s.raw('valid-token', 'POST', '/v1/listen?language=klingon-ish', wavBytes(), { 'Content-Type': 'audio/wav' });
  assert.equal(r2.status, 400);
  s.close(); uninstallFetchMock();
});

test('/v1/listen: worker failure -> 502 Deepgram error, unbilled, temp cleaned', async () => {
  installFetchMock(); resetState();
  sttWorkerResult = { errorStatus: 500 };
  const s = await boot();
  const r = await s.raw('valid-token', 'POST', '/v1/listen', wavBytes(), { 'Content-Type': 'audio/wav' });
  assert.equal(r.status, 502);
  const b = await r.json();
  assert.equal(b.err_code, 'UPSTREAM_FAILED');
  await settle();
  assert.deepEqual(usageCalls, []);
  assert.deepEqual(listTmp(s.tmpDir), []);
  s.close(); uninstallFetchMock();
});

test('/v1/listen: billing gate 402 and rate limit 429 use the Deepgram error shape', async () => {
  installFetchMock(); resetState();
  billingActive = false;
  const s = await boot({ limits: { ratePerMin: 1 } });
  const r = await s.raw('valid-token', 'POST', '/v1/listen', wavBytes(), { 'Content-Type': 'audio/wav' });
  assert.equal(r.status, 402);
  assert.equal((await r.json()).err_code, 'INSUFFICIENT_CREDITS');
  billingActive = true;
  assert.equal((await s.raw('valid-token', 'POST', '/v1/listen', wavBytes(), { 'Content-Type': 'audio/wav' })).status, 200);
  const lim = await s.raw('valid-token', 'POST', '/v1/listen', wavBytes(), { 'Content-Type': 'audio/wav' });
  assert.equal(lim.status, 429);
  assert.ok(lim.headers.get('retry-after'));
  assert.equal((await lim.json()).err_code, 'RATE_LIMITED');
  s.close(); uninstallFetchMock();
});

test('/v1/listen stores no transcript by default', async () => {
  installFetchMock(); resetState();
  sttWorkerResult = { text: 'private words', language: 'en', duration: 2, words: WORDS };
  const s = await boot();
  const b = await (await s.raw('valid-token', 'POST', '/v1/listen', wavBytes(), { 'Content-Type': 'audio/wav' })).json();
  const row = transcriptions.get(b.metadata.request_id)!;
  assert.ok(row, 'request_id is the transcription row id (usable for DELETE)');
  assert.equal(JSON.stringify(row).includes('private'), false);
  s.close(); uninstallFetchMock();
});

// ---------------------------------------------------------------------------
// OpenAI-style POST /v1/audio/transcriptions
// ---------------------------------------------------------------------------

test('/v1/audio/transcriptions requires auth', async () => {
  installFetchMock(); resetState();
  const s = await boot();
  const r = await s.raw(null, 'POST', '/v1/audio/transcriptions', fileForm());
  assert.equal(r.status, 401);
  s.close(); uninstallFetchMock();
});

test('/v1/audio/transcriptions default response_format=json -> { text }', async () => {
  installFetchMock(); resetState();
  const s = await boot();
  const r = await s.raw('valid-token', 'POST', '/v1/audio/transcriptions', fileForm([['model', 'whisper-1'], ['language', 'en']]));
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { text: 'hello world' });
  assert.equal(new URL(workerCalls[0]!.url).searchParams.get('language'), 'en');
  assert.ok(r.headers.get('x-request-id'));
  s.close(); uninstallFetchMock();
});

test('/v1/audio/transcriptions response_format=text -> plain text', async () => {
  installFetchMock(); resetState();
  const s = await boot();
  const r = await s.raw('valid-token', 'POST', '/v1/audio/transcriptions', fileForm([['response_format', 'text']]));
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') ?? '', /text\/plain/);
  assert.equal((await r.text()).trim(), 'hello world');
  s.close(); uninstallFetchMock();
});

test('/v1/audio/transcriptions verbose_json: segments, word granularity, x_quality passthrough', async () => {
  installFetchMock(); resetState();
  const quality = { snr_db_est: 30, low_quality: false };
  sttWorkerResult = {
    text: 'hello world', language: 'en', duration: 3.5, words: WORDS, quality,
    segments: [{ id: 0, start: 0, end: 1, text: 'hello world', avg_logprob: -0.1, no_speech_prob: 0.01 }],
  };
  const s = await boot();
  const r = await s.raw('valid-token', 'POST', '/v1/audio/transcriptions', fileForm([['response_format', 'verbose_json'], ['timestamp_granularities[]', 'word'], ['keyterm', 'Kubernetes'], ['keyterms', 'A,B']]));
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(b.task, 'transcribe');
  assert.equal(b.language, 'en');
  assert.equal(b.duration, 3.5);
  assert.equal(b.text, 'hello world');
  assert.equal(b.segments[0].text, 'hello world');
  assert.equal(b.segments[0].start, 0);
  assert.equal(b.words.length, 2);
  assert.deepEqual(b.x_quality, quality);
  assert.deepEqual(new URL(workerCalls[0]!.url).searchParams.getAll('keyterm'), ['Kubernetes', 'A', 'B']);
  assert.equal(new URL(workerCalls[0]!.url).searchParams.get('word_timestamps'), 'true');
  s.close(); uninstallFetchMock();
});

test('/v1/audio/transcriptions: unsupported response_format (srt/vtt) -> 400 OpenAI error shape', async () => {
  installFetchMock(); resetState();
  const s = await boot();
  const r = await s.raw('valid-token', 'POST', '/v1/audio/transcriptions', fileForm([['response_format', 'srt']]));
  assert.equal(r.status, 400);
  const b = await r.json();
  assert.equal(typeof b.error.message, 'string');
  assert.equal(b.error.type, 'invalid_request_error');
  assert.equal(workerCalls.length, 0);
  s.close(); uninstallFetchMock();
});

test('/v1/audio/transcriptions: missing file, sniff failure, oversize, 429 all use the OpenAI error shape', async () => {
  installFetchMock(); resetState();
  const s = await boot({ limits: { maxUploadBytes: 8192, ratePerMin: 4 } });
  const none = await s.raw('valid-token', 'POST', '/v1/audio/transcriptions', (() => { const f = new FormData(); f.append('model', 'x'); return f; })());
  assert.equal(none.status, 400);
  assert.equal(typeof (await none.json()).error.message, 'string');
  const png = await s.raw('valid-token', 'POST', '/v1/audio/transcriptions', fileForm([], pngBytes()));
  assert.equal(png.status, 400);
  const big = await s.raw('valid-token', 'POST', '/v1/audio/transcriptions', fileForm([], wavBytes(100_000)));
  assert.equal(big.status, 413);
  assert.equal(typeof (await big.json()).error.message, 'string');
  const ok = await s.raw('valid-token', 'POST', '/v1/audio/transcriptions', fileForm());
  assert.equal(ok.status, 200);
  const lim = await s.raw('valid-token', 'POST', '/v1/audio/transcriptions', fileForm());
  assert.equal(lim.status, 429);
  assert.equal((await lim.json()).error.type, 'rate_limit_error');
  await settle();
  assert.deepEqual(listTmp(s.tmpDir), []);
  assert.deepEqual(usageCalls.length, 1);
  s.close(); uninstallFetchMock();
});

test('/v1/audio/transcriptions: Deepgram-only knobs and unsupported extras are accepted and ignored', async () => {
  installFetchMock(); resetState();
  const s = await boot();
  const r = await s.raw('valid-token', 'POST', '/v1/audio/transcriptions', fileForm([['prompt', 'Notes about X.'], ['temperature', '0'], ['diarize', 'true']]));
  assert.equal(r.status, 200);
  s.close(); uninstallFetchMock();
});

// ---------------------------------------------------------------------------
// Delete-my-transcript (compat surface) and no-config darkness
// ---------------------------------------------------------------------------

test('DELETE /v1/transcriptions/:id deletes the caller\'s own record and 404s otherwise', async () => {
  installFetchMock(); resetState();
  const s = await boot();
  const b = await (await s.raw('valid-token', 'POST', '/v1/listen', wavBytes(), { 'Content-Type': 'audio/wav' })).json();
  const id = b.metadata.request_id as string;
  resolvedUserId = 'test-user-2';
  assert.equal((await s.raw('valid-token', 'DELETE', `/v1/transcriptions/${id}`)).status, 404);
  assert.equal(transcriptions.has(id), true);
  resolvedUserId = 'test-user-1';
  const del = await s.raw('valid-token', 'DELETE', `/v1/transcriptions/${id}`);
  assert.equal(del.status, 200);
  assert.equal((await del.json()).deleted, true);
  assert.equal(transcriptions.has(id), false);
  s.close(); uninstallFetchMock();
});

test.after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });
