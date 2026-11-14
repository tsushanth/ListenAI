// npm test (node:test via tsx, run with --experimental-test-module-mocks - see package.json).
//
// GUARD: the public API and web app may show a voice name, language and dialect (plus the Live / Studio tier) and nothing
// that names a model, engine implementation, dataset or vendor. This file keeps it that way two ways.
//
//   A. STATIC: scans the string literals that sit on response-facing lines (res.json / res.send / res.setHeader / res.set /
//      res.status, `new ...Error(`, and `error:` `message:` `detail:` `reason:` `warning:` `note:` `description:` keys) of the
//      PUBLIC route files for denylisted terms. Route path literals are scanned too. Anything that matches must be in
//      ALLOW below with a reason, so a new leak fails the build and an intentional internal use is documented.
//      The term list is lib/publicText.ts (a mirror of registry/public-policy.json). When TTS_REGISTRY_DIR is set (the
//      directory that holds public-policy.json, e.g. .../rt-registry/registry) the same scan also runs with the policy file's
//      own terms and fails if the policy has a term the mirror lacks; unset, that part is skipped with a message.
//   B. BEHAVIOURAL: boots real routers through their existing harness patterns and asserts the actual response bodies and
//      headers contain no denylisted term (voice studio error paths and relay, streaming-clone alias, cloned-voice TTS
//      errors and headers). The dub status and voice-isolate status checks live in dub.test.ts / voiceIsolate.test.ts
//      because they need those files' heavier harnesses.
//
// Matching is registry/build.mjs publicLeak(): case-insensitive, word-boundary (see lib/publicText.ts).
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { NextFunction, Request, Response } from 'express';
import { PUBLIC_DENY_TERMS, publicLeakTerm, publicMessage, scrubPublic, publicRelayBody, publicWorkerStatus } from './publicText.js';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.GATEWAY_FORWARD_SECRET = 'test-forward-secret';
process.env.ORPHEUS_CLONE_SERVICE_URL = 'https://studio-clone.example.test';
process.env.ORPHEUS_CLONE_SECRET = 'test-clone-secret';
process.env.NODE_ENV = 'test';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..');

// ---------------------------------------------------------------------------
// A. Static scan
// ---------------------------------------------------------------------------

/** Public, customer-reachable route files (API key or end-user session). Admin, webhook, health and billing files are not here. */
const PUBLIC_ROUTE_FILES = [
  'tts', 'orpheusVoiceStudio', 'orpheusVoiceStudioApiKey', 'dub', 'voiceStudioRouter', 'voiceStudio', 'voiceStudioApiKey',
  'voiceIsolate', 'voiceConvert', 'voiceDesign', 'stt', 'voiceClones', 'voiceCloneApiKey', 'voices', 'usage', 'realtimeTts',
  'audiobooks', 'stories', 'soundEffects', 'textToMusic', 'clonedVoices', 'voiceMarketplace', 'audio', 'extract', 'ai', 'latency',
  'ttsApiKeys', 'subscription',
].map((f) => `routes/${f}.ts`);

/** Library files whose strings reach clients (language notes and clone error messages). */
const PUBLIC_LIB_FILES = ['lib/dubLanguages.ts', 'lib/voiceCloning/service.ts', 'lib/voiceCloning/consent.ts', 'lib/voiceCloning/consentPhrase.ts',
  'lib/voiceCloning/policy.ts', 'lib/voiceCloning/referenceGate.ts', 'lib/voiceMapping.ts'];

/**
 * Allowed matches. `includes` is a substring of the source line (so a line move does not break it). Every entry is INTERNAL: it
 * is never sent to a client, or it is the legacy input value that is still accepted. Add an entry only with a reason.
 */
const ALLOW: Array<{ file: string; includes: string; reason: string }> = [
  { file: 'routes/tts.ts', includes: "description: 'Kokoro voice'", reason: 'in-memory voice object handed to the synthesis client; never serialised to a response' },
  { file: 'routes/dub.ts', includes: "description: 'Kokoro voice (dubbing)'", reason: 'in-memory voice object handed to the synthesis client; never serialised to a response' },
  { file: 'routes/tts.ts', includes: "v === 'chatterbox'", reason: 'legacy `model` input value older clients still send; accepted, never echoed (the error text is the neutral "Unsupported model")' },
  { file: 'routes/voiceIsolate.ts', includes: 'Modal ', reason: 'thrown into the router error handler, which answers a fixed "Something went wrong."; logged only' },
  { file: 'routes/voiceConvert.ts', includes: 'Modal ', reason: 'thrown into the router error handler, which answers a fixed "Something went wrong."; logged only' },
  { file: 'routes/voiceDesign.ts', includes: 'Modal ', reason: 'thrown into the router error handler, which answers a fixed "Something went wrong."; logged only' },
  { file: 'lib/voiceCloning/serviceClient.ts', includes: "'perth'", reason: 'default for the upstream header; stored internally, routes publish PUBLIC_WATERMARK' },
  { file: 'lib/voiceCloning/serviceClient.ts', includes: "'chatterbox-mtl-v3'", reason: 'default for the upstream header; stored internally, routes publish PUBLIC_CLONE_MODEL' },
];

/** Route path literals that name a model and are kept ON PURPOSE for existing clients; each must have a neutral alias. */
const LEGACY_MODEL_PATHS = ['/api/orpheus-voice-studio', '/internal/orpheus-clone-api'];

const LITERAL = /'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|`((?:\\.|[^`\\])*)`/g;
const SINK = /\.(json|send|setHeader|header)\(|\.set\(|res\.status\(|new \w*Error\(|\b(error|message|detail|reason|warning|note|description)\s*:|'X-[A-Za-z-]+'/;
const SKIP_LINE = /^\s*(\/\/|\*|\/\*)|^\s*import\b|\bfrom '|\b(log|logger|\w*Logger|\w*log)\.(info|warn|error|debug|child)\(/;

interface Hit { file: string; line: number; term: string; text: string }

function scanFile(rel: string, leakTerm: (s: string) => string | null): Hit[] {
  const hits: Hit[] = [];
  readFileSync(join(SRC, rel), 'utf8').split('\n').forEach((raw, i) => {
    if (SKIP_LINE.test(raw) || !SINK.test(raw)) return;
    for (const m of raw.matchAll(LITERAL)) {
      const term = leakTerm(m[1] ?? m[2] ?? m[3] ?? '');
      if (term) hits.push({ file: rel, line: i + 1, term, text: raw.trim() });
    }
  });
  return hits;
}

const allowed = (h: Hit) => ALLOW.some((a) => a.file === h.file && h.text.includes(a.includes));
const fmt = (hs: Hit[]) => hs.map((h) => `  ${h.file}:${h.line} [${h.term}] ${h.text.slice(0, 140)}`).join('\n');

/** Mount path literals (`router.get('/x'`, `app.use('/x'`) that carry a denylisted term. */
function scanPaths(rel: string, leakTerm: (s: string) => string | null): Hit[] {
  const hits: Hit[] = [];
  readFileSync(join(SRC, rel), 'utf8').split('\n').forEach((raw, i) => {
    if (/^\s*(\/\/|\*)/.test(raw)) return;
    const m = raw.match(/\b(?:app|router|r|compat|legacy)\.(?:get|post|put|delete|patch|use)\(\s*'(\/[^']*)'/);
    const term = m ? leakTerm(m[1]!) : null;
    if (m && term) hits.push({ file: rel, line: i + 1, term, text: m[1]! });
  });
  return hits;
}

test('static: no denylisted term in response-facing string literals of the public route files', () => {
  const hits = [...PUBLIC_ROUTE_FILES, ...PUBLIC_LIB_FILES, 'lib/voiceCloning/serviceClient.ts'].flatMap((f) => scanFile(f, publicLeakTerm)).filter((h) => !allowed(h));
  assert.equal(hits.length, 0, `A model/engine/dataset/vendor name reaches a response-facing line. Neutralise it (lib/publicText.ts) or, if it is internal-only, add it to ALLOW with a reason:\n${fmt(hits)}`);
});

test('static: ALLOW entries are all still needed (no stale allow-list lines)', () => {
  const hits = [...PUBLIC_ROUTE_FILES, ...PUBLIC_LIB_FILES, 'lib/voiceCloning/serviceClient.ts'].flatMap((f) => scanFile(f, publicLeakTerm));
  const stale = ALLOW.filter((a) => !hits.some((h) => h.file === a.file && h.text.includes(a.includes)));
  assert.deepEqual(stale, [], 'allow-list entries that no longer match anything: remove them');
});

test('static: route paths that name a model are only the documented legacy ones, and each has a neutral alias', () => {
  const found = ['index.ts', ...PUBLIC_ROUTE_FILES].flatMap((f) => scanPaths(f, publicLeakTerm));
  // index.ts mounts use `app.use('/path'`; only the two legacy mounts may carry a model name.
  const unexpected = found.filter((h) => !LEGACY_MODEL_PATHS.includes(h.text));
  assert.deepEqual(unexpected, [], `route path names a model: ${JSON.stringify(unexpected)}`);
  const studio = readFileSync(join(SRC, 'routes/voiceStudio.ts'), 'utf8');
  const studioKey = readFileSync(join(SRC, 'routes/voiceStudioApiKey.ts'), 'utf8');
  assert.match(studio, /voiceStudioRouter\.use\('\/streaming', orpheusVoiceStudioRouter\)/, '/api/voice-studio/streaming alias missing');
  assert.match(studioKey, /voiceStudioApiKeyRouter\.use\('\/streaming', orpheusVoiceStudioApiKeyRouter\)/, '/internal/voice-studio-api/streaming alias missing');
});

// Policy file (rt-registry). Skipped with a message when TTS_REGISTRY_DIR is not set.
function policyTerms(): string[] | null {
  const dir = process.env.TTS_REGISTRY_DIR;
  if (!dir) return null;
  for (const p of [join(dir, 'public-policy.json'), join(dir, 'registry', 'public-policy.json')]) {
    if (existsSync(p)) return (JSON.parse(readFileSync(p, 'utf8')) as { denylist: string[] }).denylist;
  }
  throw new Error(`TTS_REGISTRY_DIR=${dir} has no public-policy.json`);
}
const policyReason = policyTerms() === null ? 'TTS_REGISTRY_DIR is not set; point it at rt-registry/registry (the folder with public-policy.json) to run the registry-policy checks' : false;

test('policy: the mirrored denylist in lib/publicText.ts has every term of registry/public-policy.json', { skip: policyReason }, () => {
  const missing = policyTerms()!.filter((t) => !PUBLIC_DENY_TERMS.includes(t));
  assert.deepEqual(missing, [], `public-policy.json gained terms that lib/publicText.ts does not mirror: ${missing.join(', ')}`);
});

test('policy: the scan with the registry policy terms (same matching as build.mjs) finds nothing outside ALLOW', { skip: policyReason }, () => {
  const res = policyTerms()!.map((t) => ({ t, re: new RegExp('(^|[^a-z0-9])' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '[ -]?') + '($|[^a-z0-9])', 'i') }));
  const leak = (s: string) => res.find(({ re }) => re.test(s))?.t ?? null;
  const hits = [...PUBLIC_ROUTE_FILES, ...PUBLIC_LIB_FILES].flatMap((f) => scanFile(f, leak)).filter((h) => !allowed(h));
  assert.equal(hits.length, 0, `policy term reaches a response-facing line:\n${fmt(hits)}`);
});

test('matching: word-boundary semantics identical to registry/build.mjs publicLeak()', () => {
  assert.equal(publicLeakTerm('Piper voice'), 'piper');
  assert.equal(publicLeakTerm('piper_voice_1'), 'piper');
  assert.equal(publicLeakTerm('KOKORO-82M'), 'kokoro');
  assert.equal(publicLeakTerm('Fish Speech'), 'fish speech');
  assert.equal(publicLeakTerm('fish-speech'), 'fish speech');
  assert.equal(publicLeakTerm('sniper'), null);
  assert.equal(publicLeakTerm('A natural American voice'), null);
  for (const t of PUBLIC_DENY_TERMS) assert.ok(publicLeakTerm(`x ${t} y`), `term not matched: ${t}`);
});

// ---------------------------------------------------------------------------
// B. Behavioural
// ---------------------------------------------------------------------------
const assertClean = (what: string, text: string) => {
  const t = publicLeakTerm(text);
  assert.equal(t, null, `${what} leaks "${t}": ${text.slice(0, 300)}`);
};
const headersText = (r: globalThis.Response) => [...r.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n');

test('helpers: publicMessage / scrubPublic / publicWorkerStatus / publicRelayBody neutralise what the routes pass through', () => {
  assert.equal(publicMessage('Piper worker at capacity', 'x'), 'x');
  assert.equal(publicMessage('Voice not found.', 'x'), 'Voice not found.');
  assert.deepEqual(scrubPublic({ count: 2, engine: 'pyannote-x', model: 'whisper', note: 'Whisper tail', ok: 'fine' }), { count: 2, ok: 'fine' });
  const st = publicWorkerStatus({ status: 'failed', stderr_tail: 'htdemucs crashed', stdout_tail: 'x', input_seconds: 3 } as { status: string; [k: string]: unknown }, 'Failed.');
  assert.deepEqual(st, { status: 'failed', input_seconds: 3, error: 'Failed.', stderr_tail: 'Failed.' });
  assert.deepEqual(publicRelayBody(Buffer.from('RIFFxxxx'), 'audio/wav').toString(), 'RIFFxxxx');
  assertClean('relayed JSON', publicRelayBody(Buffer.from(JSON.stringify({ status: 'ready', model: 'orpheus-3b', detail: 'trained with Orpheus' })), 'application/json').toString());
});

test('voice studio router: intake errors, warnings and failure reasons never reach the client with a model name', async () => {
  const { default: express } = await import('express');
  const { createVoiceStudioRouter } = await import('../routes/voiceStudioRouter.js');
  const { IntakeError } = await import('./voiceIntakeClient.js');
  const voice = { voice_id: 'v-0123456789', status: 'rejected', owner_user_id: 'user-1', speaker_name: 'A', created_at: 1,
    manifest: { warnings: ['Piper training clips were short', 'Audio is a little quiet.'] },
    error: { code: 'rejected', reason: 'Kokoro alignment failed on clip 3' } };
  let nextError: Error | null = null;
  const intake = {
    list: async () => ({ voices: [voice] }),
    get: async () => voice,
    preview: async () => { throw nextError!; },
    deploy: async () => ({ voice_id: 'v-0123456789', voice: 'custom:v-0123456789' }),
  } as unknown as import('./voiceIntakeClient.js').IntakeClient;
  const app = express();
  app.use('/vs', createVoiceStudioRouter({
    authenticate: async () => 'user-1', intake, enabledUsers: () => '*', maxVoicesPerUser: 3, maxZipBytes: 1000, backfillKeyOwners: async () => {},
  }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/vs`;
  try {
    const list = await fetch(`${base}/`, { headers: { authorization: 'Bearer user-1' } });
    const listText = await list.text();
    assertClean('GET /voices body', listText);
    assert.match(listText, /Audio is a little quiet/, 'harmless warnings are kept');
    assert.match(listText, /The recordings could not be used/, 'leaking failure reason replaced');
    voice.status = 'ready';
    for (const [status, detail] of [[400, 'Piper rejected the text'], [409, 'Kokoro busy'], [413, 'too big for Orpheus']] as const) {
      nextError = new IntakeError(status, detail);
      const r = await fetch(`${base}/v-0123456789/preview`, { method: 'POST', headers: { authorization: 'Bearer user-1', 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hi' }) });
      assert.equal(r.status, status, 'status codes are preserved');
      assertClean(`preview ${status} body`, await r.text());
      assertClean(`preview ${status} headers`, headersText(r));
    }
    nextError = new IntakeError(500, 'piper worker crashed');
    const r5 = await fetch(`${base}/v-0123456789/preview`, { method: 'POST', headers: { authorization: 'Bearer user-1', 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hi' }) });
    assert.equal(r5.status, 502);
    assertClean('preview 502 body', await r5.text());
    const dep = await fetch(`${base}/v-0123456789/deploy`, { method: 'POST', headers: { authorization: 'Bearer user-1' } });
    assertClean('deploy body', await dep.text());
  } finally { server.close(); }
});

test('streaming clone (gateway-trusted router): upstream failure and leaking upstream JSON are neutral, on the legacy path AND the /streaming alias', async () => {
  const { default: express } = await import('express');
  const { voiceStudioApiKeyRouter } = await import('../routes/voiceStudioApiKey.js');
  const { orpheusVoiceStudioApiKeyRouter } = await import('../routes/orpheusVoiceStudioApiKey.js');
  const app = express();
  app.use(express.json());
  app.use('/internal/orpheus-clone-api', orpheusVoiceStudioApiKeyRouter); // legacy mount, as in index.ts
  app.use('/internal/voice-studio-api', voiceStudioApiKeyRouter); // neutral alias lives under it
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  const realFetch = globalThis.fetch;
  let mode: 'down' | 'leaky' = 'down';
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (!url.startsWith('https://studio-clone.example.test')) return realFetch(input, init);
    if (mode === 'down') throw new Error('connect ECONNREFUSED');
    return new Response(JSON.stringify({ id: 'v-0123456789', status: 'training', model: 'orpheus-3b', detail: 'Orpheus fine-tune queued' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const auth = { 'x-gateway-admin-secret': 'test-forward-secret', 'x-gateway-uid': 'user-1', 'content-type': 'application/json' };
  try {
    const results: Array<[string, number, string]> = [];
    for (const m of ['down', 'leaky'] as const) {
      mode = m;
      for (const prefix of ['/internal/orpheus-clone-api', '/internal/voice-studio-api/streaming']) {
        const r = await realFetch(`http://127.0.0.1:${port}${prefix}/`, { method: 'POST', headers: auth, body: '{}' });
        const text = await r.text();
        assertClean(`${prefix} (${m}) body`, text);
        assertClean(`${prefix} (${m}) headers`, headersText(r));
        results.push([`${m} ${prefix}`, r.status, text]);
      }
    }
    // identical behaviour on both paths
    assert.equal(results[0]![1], 502); assert.equal(results[0]![2], results[1]![2]);
    assert.equal(results[2]![1], 200); assert.equal(results[2]![2], results[3]![2]);
    assert.equal(JSON.parse(results[2]![2]).status, 'training', 'non-leaking fields still pass through');
    const unauth = await realFetch(`http://127.0.0.1:${port}/internal/voice-studio-api/streaming/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(unauth.status, 401, 'the alias keeps the shared-secret gate');
  } finally { globalThis.fetch = realFetch; server.close(); }
});

// tts.ts cloned-voice routes: same double pattern as ttsCloned.test.ts
const cloneState: { deps: unknown } = { deps: null };
mock.module('./voiceCloning/runtime.js', {
  namedExports: {
    getCloneDeps: () => cloneState.deps,
    eligibilityForSynthesis: async (userId: string) => ({ userId, emailVerified: true, plan: 'paid' as const }),
  },
});

test('tts /cloned: validation errors and success headers name no model; legacy `model` input still accepted', async () => {
  const [{ default: express }, { ttsRouter }, { errorHandler }, dbl, pol] = await Promise.all([
    import('express'), import('../routes/tts.js'), import('../middleware/errorHandler.js'),
    import('./voiceCloning/testDoubles.js'), import('./voiceCloning/policy.js'),
  ]);
  const store = new dbl.MemoryStore();
  cloneState.deps = { store, blobs: new dbl.MemoryBlobs(), service: new dbl.FakeService(), asr: new dbl.FakeAsr(), policy: pol.DEFAULT_POLICY };
  const VID = '11111111-1111-4111-8111-111111111111';
  await store.insertVoice({ id: VID, userId: 'user-1', name: 'v', language: 'es', status: 'active', consentId: 'c', referenceSha256: 'x', referenceSec: 10, modelId: 'chatterbox-mtl-v3', disableReason: null } as never);
  const app = express();
  app.use(express.json());
  app.use('/api/tts', (req: Request, _res: Response, next: NextFunction) => { (req as Request & { user: { id: string } }).user = { id: 'user-1' }; next(); }, ttsRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tts`;
  const post = (body: unknown) => fetch(`${base}/cloned`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const bad = await post({ text: 'Hola', voice_id: VID, model: 'something-else' });
    assert.equal(bad.status, 400, 'still a validation error');
    const badText = await bad.text();
    assertClean('/cloned bad model body', badText);
    assert.match(badText, /Unsupported model/);
    const badJob = await fetch(`${base}/job-cloned`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Hola', voice_id: VID, model: 'nope' }) });
    assert.equal(badJob.status, 400);
    assertClean('/job-cloned bad model body', await badJob.text());

    for (const model of [undefined, 'studio', 'chatterbox']) {
      const ok = await post({ text: 'Hola mundo', voice_id: VID, ...(model ? { model } : {}) });
      assert.equal(ok.status, 200, `model=${model} accepted`);
      assertClean(`/cloned headers (model=${model})`, headersText(ok));
      assert.equal(ok.headers.get('x-model'), 'studio');
      assert.equal(ok.headers.get('x-watermark'), 'applied');
    }
  } finally { server.close(); }
});

// ---------------------------------------------------------------------------
// Prove the guard bites: a reintroduced term in a response-facing literal is reported
// ---------------------------------------------------------------------------
test('guard self-check: a leaking response literal is detected by the scanner and not allow-listed', () => {
  const leaky = "res.status(502).json({ error: 'orpheus clone service unavailable' });";
  const hit = [leaky].flatMap((raw) => (SINK.test(raw) ? [...raw.matchAll(LITERAL)].map((m) => publicLeakTerm(m[1] ?? m[2] ?? m[3] ?? '')) : [])).filter(Boolean);
  assert.deepEqual(hit, ['orpheus']);
  assert.equal(allowed({ file: 'routes/orpheusVoiceStudio.ts', line: 1, term: 'orpheus', text: leaky }), false);
});
