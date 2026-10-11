// Claude spend accounting, enabled path: a (fake) ingest key is set, so rows are recorded and sent.
// The Anthropic SDK is real; only the network is faked. The SDK in this repo calls node-fetch (not globalThis.fetch), so
// node-fetch is mocked for api.anthropic.com and globalThis.fetch is faked for the usage Worker.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
process.env.LLM_USAGE_KEY = 'test-ingest-key';
process.env.LLM_USAGE_URL = 'https://usage.test/v1/llm';
process.env.FAILURE_REPORTER_KEY = 'must-not-be-used';

type Sent = { key: string; items: Array<Record<string, any>> };
const sent: Sent[] = [];
let usageStatus = 200;
let usageThrows = false;
let usageHangs = false;
let reply = JSON.stringify({ chapters: [] });
let anthropicStatus = 200;

mock.module('node-fetch', {
  defaultExport: async (input: unknown) => {
    const url = String(input);
    if (!url.includes('api.anthropic.com')) throw new Error(`Unexpected real network call to ${url}`);
    if (anthropicStatus !== 200) {
      return new Response('{"type":"error","error":{"type":"invalid_request_error","message":"bad"}}', { status: anthropicStatus, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', stop_reason: 'end_turn', stop_sequence: null,
      content: [{ type: 'text', text: reply }],
      usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 200, cache_creation_input_tokens: 0 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  },
});

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(typeof input === 'string' ? input : input.url);
  if (url.startsWith('https://usage.test')) {
    if (usageHangs) return new Promise<Response>(() => {});
    if (usageThrows) throw new Error('worker down');
    sent.push({ key: init.headers['X-Report-Key'], items: JSON.parse(init.body).items });
    return new Response('{}', { status: usageStatus });
  }
  return realFetch(input, init);
}) as typeof fetch;

async function flushed() {
  const { llm } = await import('./llm.js');
  sent.length = 0;
  await llm.flush();
  return sent.flatMap((s) => s.items);
}

async function withServer<T>(mount: (app: express.Express) => void, fn: (base: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.json());
  mount(app);
  app.use((err: any, _req: any, res: any, _next: any) => res.status(err?.statusCode || 500).json({ error: String(err?.message) }));
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  try { return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); } finally { server.close(); }
}

async function callStories(body = { theme: 'a sleepy fox' }) {
  const { storiesRouter } = await import('../routes/stories.js');
  return withServer((app) => app.use('/stories', storiesRouter), async (base) => {
    const r = await realFetch(`${base}/stories/generate`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-device-id': `dev-${Math.random()}` }, body: JSON.stringify(body) });
    return r.status;
  });
}

test('chapter detection is recorded under "chapter_detection" with tokens and cost, sent with the ingest key (not the reporter key)', async () => {
  const { detectChaptersFromText } = await import('./chapterDetection.js');
  await flushed();
  await detectChaptersFromText('word '.repeat(4000), 'SECRET-TITLE');
  const items = await flushed();
  assert.equal(sent[0].key, 'test-ingest-key');
  assert.equal(items.length, 1);
  assert.equal(items[0].feature, 'chapter_detection');
  assert.equal(items[0].model, 'claude-sonnet-4-6');
  assert.equal(items[0].calls, 1);
  assert.equal(items[0].input_tokens, 1000);
  assert.equal(items[0].output_tokens, 500);
  assert.equal(items[0].cache_read_tokens, 200);
  assert.ok(Math.abs(items[0].cost_usd - (1000 * 3 + 500 * 15 + 200 * 0.3) / 1e6) < 1e-9);
});

test('the stories route is recorded under "stories"', async () => {
  reply = JSON.stringify({ title: 't', summary: 's', body: 'one two three' });
  await flushed();
  assert.equal(await callStories(), 200);
  const items = await flushed();
  assert.deepEqual(items.map((i) => i.feature), ['stories']);
  assert.equal(items[0].input_tokens, 1000);
});

test('the ai summarize route is recorded under "ai"', async () => {
  reply = 'a summary';
  const { aiRouter } = await import('../routes/ai.js');
  await flushed();
  const status = await withServer(
    (app) => { app.use((req: any, _res, next) => { req.user = { id: 'u1' }; next(); }); app.use('/ai', aiRouter); },
    async (base) => (await realFetch(`${base}/ai/summarize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'SECRET-ARTICLE', action: 'summarize' }) })).status,
  );
  assert.equal(status, 200);
  const items = await flushed();
  assert.deepEqual(items.map((i) => i.feature), ['ai']);
});

test('rows hold only low-cardinality fields: no prompt, answer, title or id leaks into the report', async () => {
  reply = JSON.stringify({ title: 'SECRET-STORY', summary: 's', body: 'SECRET-BODY words' });
  await flushed();
  await callStories({ theme: 'SECRET-THEME' });
  const { detectChaptersFromText } = await import('./chapterDetection.js');
  await detectChaptersFromText('word '.repeat(4000), 'SECRET-TITLE');
  await flushed();
  const body = JSON.stringify(sent);
  assert.ok(!body.includes('SECRET'));
  assert.ok(sent.length > 0);
  for (const it of sent.flatMap((s) => s.items)) {
    assert.deepEqual(Object.keys(it).sort(), ['cache_read_tokens', 'cache_write_tokens', 'calls', 'cost_usd', 'day', 'errors', 'feature', 'input_tokens', 'model', 'output_tokens']);
  }
});

test('every Anthropic client is instrumented and every messages.create is labelled (guards future call sites)', () => {
  const root = path.join(__dirname, '..');
  const expected: Record<string, string[]> = {
    'lib/chapterDetection.ts': ['chapter_detection'],
    'routes/extract.ts': ['extract'],
    'routes/dub.ts': ['dubbing'],
    'routes/stories.ts': ['stories'],
    'routes/ai.ts': ['ai'],
  };
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : /\.(ts|js)$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [path.join(d, e.name)] : []);
  const seen = new Set<string>();
  for (const file of walk(root)) {
    const rel = path.relative(root, file);
    if (rel === 'lib/llm.ts' || rel === 'lib/llmUsage.js') continue;
    const src = fs.readFileSync(file, 'utf8');
    const creates = src.match(/\.messages\.(create|stream)\(/g) || [];
    const clients = src.match(/new (?:Anthropic|Anthropic\.default)\(/g) || [];
    const raw = src.match(/api\.anthropic\.com/g) || [];
    assert.equal(raw.length, 0, `${rel}: raw Anthropic HTTP call is not instrumented (use llm.record)`);
    if (!creates.length && !clients.length) continue;
    seen.add(rel);
    assert.ok(expected[rel], `${rel} uses Anthropic but is not in the instrumented list`);
    assert.equal((src.match(/instrumentAnthropic\(new Anthropic\(/g) || []).length, clients.length, `${rel}: un-instrumented client`);
    const labels = [...src.matchAll(/withFeature\('([a-z_]+)', \(\) => anthropic\.messages\.(?:create|stream)\(/g)].map((m) => m[1]);
    assert.deepEqual(labels, expected[rel], `${rel}: labels`);
    assert.equal(labels.length, creates.length, `${rel}: unlabelled call`);
  }
  assert.deepEqual([...seen].sort(), Object.keys(expected).sort());
});

test('the shared instance is app "readaloud", enabled only by LLM_USAGE_KEY', () => {
  const src = fs.readFileSync(path.join(__dirname, 'llm.ts'), 'utf8');
  assert.match(src, /app: 'readaloud',/);
  assert.match(src, /enabled: !!process\.env\.LLM_USAGE_KEY,/);
  assert.match(src, /key: process\.env\.LLM_USAGE_KEY,/);
});

test('shutdown flushes usage before exiting', () => {
  const src = fs.readFileSync(path.join(__dirname, '../index.ts'), 'utf8');
  assert.match(src, /flushLlmUsage\(2500\)\.finally\(\(\) => process\.exit\(0\)\)/);
});

test('a failing usage report (worker down, 500, rejected key) never throws into a request', async () => {
  const { llm } = await import('./llm.js');
  reply = JSON.stringify({ title: 't', summary: 's', body: 'one two' });
  for (const mode of ['throws', '500', '401']) {
    usageThrows = mode === 'throws';
    usageStatus = mode === '500' ? 500 : mode === '401' ? 401 : 200;
    assert.equal(await callStories(), 200);
    await assert.doesNotReject(llm.flush());
  }
  usageThrows = false; usageStatus = 200;
});

test('a failed Claude call is counted as an error and still fails the request as before', async () => {
  await flushed();
  anthropicStatus = 400;
  try { assert.equal(await callStories(), 500); } finally { anthropicStatus = 200; }
  const items = await flushed();
  assert.equal(items.length, 1);
  assert.equal(items[0].feature, 'stories');
  assert.equal(items[0].errors, 1);
  assert.equal(items[0].cost_usd, 0);
});

test('flushLlmUsage gives up after the cap even when the Worker hangs', async () => {
  const { flushLlmUsage, llm } = await import('./llm.js');
  reply = JSON.stringify({ title: 't', summary: 's', body: 'one two' });
  await flushed();
  await callStories();
  assert.ok(llm.pending() > 0, 'a row must be waiting so the flush really hangs');
  usageHangs = true;
  const t0 = Date.now();
  try { await flushLlmUsage(150); } finally { usageHangs = false; }
  assert.ok(Date.now() - t0 < 1000);
});
