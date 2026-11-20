// npm test (node:test via tsx). Contract test: the voice-convert routes against a shared converter endpoint
// (VOICE_SHARED_ENDPOINT=1 + VOICE_CONVERT_URL/SECRET) that speaks the converter HTTP contract. The stand-in below is a real
// local HTTP server, so the request shapes (multipart fields, bearer secret, status codes) are checked on the wire.
// No user has a per-user deployment in these tests.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';

const SECRET = 'shared-secret-for-test';
process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.GATEWAY_FORWARD_SECRET ??= 'test-forward-secret';
process.env.NODE_ENV = 'test';
process.env.VOICE_SHARED_ENDPOINT = '1';
process.env.VOICE_CONVERT_SECRET = SECRET;

type Job = { status: string; audio?: Buffer };
const jobs = new Map<string, Job>();
const seen: Array<{ method: string; path: string; auth: string; fields?: string[] }> = [];
let rejectNext: string | null = null;
let worker: http.Server;

before(async () => {
  worker = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString('latin1');
    const fields = [...body.matchAll(/name="([a-z_]+)"/g)].map((m) => m[1]);
    const auth = String(req.headers.authorization || '');
    seen.push({ method: req.method || '', path: req.url || '', auth, fields });
    const send = (code: number, obj: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (auth !== `Bearer ${SECRET}`) return send(401, { error: 'unauthorized' });
    if (req.method === 'POST' && req.url === '/convert') {
      if (rejectNext) { const e = rejectNext; rejectNext = null; return send(400, { job_id: 'rej1', status: 'rejected', error: e }); }
      const id = `job-${jobs.size + 1}`; jobs.set(id, { status: 'queued' });
      return send(202, { job_id: id, status: 'queued', source_seconds: 5.2, target_seconds: 15 });
    }
    const m = (req.url || '').match(/^\/convert\/([^/]+)(\/result)?$/);
    if (m) {
      const j = jobs.get(m[1]);
      if (!j) return send(404, { error: 'not found' });
      if (req.method === 'DELETE') { jobs.delete(m[1]); return send(200, { deleted: true }); }
      if (m[2]) {
        if (j.status !== 'done' || !j.audio) return send(409, { error: 'not ready' });
        res.writeHead(200, { 'content-type': 'audio/wav' }); return res.end(j.audio);
      }
      return send(200, { job_id: m[1], status: j.status });
    }
    send(404, { error: 'nope' });
  });
  await new Promise<void>((r) => worker.listen(0, '127.0.0.1', () => r()));
  process.env.VOICE_CONVERT_URL = `http://127.0.0.1:${(worker.address() as AddressInfo).port}`;
});
after(() => { worker.close(); });

const realFetch = globalThis.fetch;
function installSupabaseMock() {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
    if (url === 'http://localhost:54321/auth/v1/user') {
      const token = (init?.headers as Record<string, string>)?.['Authorization']?.replace(/^Bearer /, '') || '';
      return token === 'valid-token' ? json({ id: 'u1', aud: 'authenticated' }) : json({ message: 'Invalid token' }, 401);
    }
    if (url.includes('/realtimetts_free_credits')) return json([{ granted: 10000, used: 10000 }]);
    if (url.includes('/rest/v1/realtimetts_billing')) {
      return json([{ user_id: 'u1', stripe_customer_id: 'cus_u1', stripe_subscription_id: 'sub', stripe_subscription_item_id: 'si', active: true }]);
    }
    if (url.includes('/rest/v1/user_voice_convert_deployments')) return json(null);
    if (url.includes('/rest/v1/voice_conversions')) return json([{ id: 1 }]);
    return realFetch(input, init);
  };
}

async function boot() {
  const { voiceConvertRouter } = await import('./voiceConvert.js');
  const app = express();
  app.use(express.json());
  app.use('/api/voice-convert', voiceConvertRouter);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/voice-convert`;
  const call = (method: string, path: string, body?: FormData) => fetch(base + path, { method, headers: { Authorization: 'Bearer valid-token' }, body });
  return { call, close: () => server.close() };
}

const CONSENT =
  'I confirm that I have the legal right to use both the source audio and the target voice reference, ' +
  'and that this conversion does not impersonate any person without their consent.';
function form(): FormData {
  const f = new FormData();
  f.append('source', new Blob([Buffer.from('fake-source')], { type: 'audio/wav' }), 'source.wav');
  f.append('target', new Blob([Buffer.from('fake-target')], { type: 'audio/wav' }), 'target.wav');
  f.append('consent_statement', CONSENT);
  return f;
}

test('shared endpoint: deploy is a no-op that reports ready, and /deploy reports shared', async () => {
  installSupabaseMock();
  const s = await boot();
  const d = await s.call('POST', '/deploy');
  assert.equal(d.status, 200);
  assert.deepEqual(await d.json(), { status: 'ready', shared: true });
  const g = await s.call('GET', '/deploy');
  assert.equal(g.status, 200);
  assert.equal((await g.json()).shared, true);
  s.close(); globalThis.fetch = realFetch;
});

test('shared endpoint: create, poll, fetch and delete a conversion without a per-user deployment', async () => {
  installSupabaseMock(); jobs.clear(); seen.length = 0;
  const s = await boot();
  const c = await s.call('POST', '/conversions', form());
  assert.equal(c.status, 202);
  const { job_id, status } = await c.json();
  assert.equal(status, 'queued');
  const create = seen.find((x) => x.method === 'POST' && x.path === '/convert');
  assert.ok(create, 'the shared worker received POST /convert');
  assert.equal(create.auth, `Bearer ${SECRET}`);
  assert.ok(create.fields?.includes('source') && create.fields?.includes('target'), 'multipart carries source and target');

  const p1 = await s.call('GET', `/conversions/${job_id}`);
  assert.equal((await p1.json()).status, 'queued');
  jobs.set(job_id, { status: 'done', audio: Buffer.from('RIFFfake') });
  const p2 = await s.call('GET', `/conversions/${job_id}`);
  assert.equal((await p2.json()).status, 'done');
  const a = await s.call('GET', `/conversions/${job_id}/audio`);
  assert.equal(a.status, 200);
  assert.equal(Buffer.from(await a.arrayBuffer()).toString(), 'RIFFfake');
  const del = await s.call('DELETE', `/conversions/${job_id}`);
  assert.equal(del.status, 200);
  assert.equal(jobs.has(job_id), false);
  s.close(); globalThis.fetch = realFetch;
});

test('shared endpoint: audio the converter rejects comes back as a 400 with its message, not a 500', async () => {
  installSupabaseMock(); jobs.clear();
  const s = await boot();
  rejectNext = 'source audio is too short (0.2 s)';
  const c = await s.call('POST', '/conversions', form());
  assert.equal(c.status, 400);
  const b = await c.json();
  assert.equal(b.status, 'rejected');
  assert.match(b.error, /too short/);
  s.close(); globalThis.fetch = realFetch;
});

test('shared endpoint: a converter 401 is a server-side failure, not shown as the caller\'s fault', async () => {
  installSupabaseMock(); jobs.clear();
  const s = await boot();
  const saved = seen.length;
  // Break the secret the backend sends by having the stand-in refuse everything once.
  const orig = worker.listeners('request')[0] as (...a: unknown[]) => void;
  worker.removeAllListeners('request');
  worker.on('request', (_req: http.IncomingMessage, res: http.ServerResponse) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"unauthorized"}'); });
  const c = await s.call('POST', '/conversions', form());
  worker.removeAllListeners('request'); worker.on('request', orig as never);
  assert.ok(c.status >= 500, `expected a 5xx, got ${c.status}`);
  assert.ok(seen.length >= saved);
  s.close(); globalThis.fetch = realFetch;
});
