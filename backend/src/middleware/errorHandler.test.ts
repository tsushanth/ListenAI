// npm test (node:test via tsx): boot a real express app with app.listen(0), same pattern as rateLimit.test.ts.
// Proves every client-facing error body carries a stable `code` next to the unchanged English `error` / `message`,
// and that Accept-Language is parsed.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';

const modP = Promise.all([
  import('./errorHandler.js'),
  import('./errorCodeNet.js'),
  import('../types/index.js'),
  import('../lib/errorCodes.js'),
]);

async function boot() {
  const [{ default: express }, [eh, net, types]] = await Promise.all([import('express'), modP]);
  const app = express();
  app.use(express.json());
  app.use(net.errorCodeNet());
  app.get('/lang', (_req, res) => { res.json({ lang: res.locals.lang }); });
  app.get('/validation', () => { throw new types.ValidationError('This voice is already shared to the marketplace'); });
  app.get('/validation-generic', () => { throw new types.ValidationError('Invalid request body', { errors: { text: ['Required'] } }); });
  app.get('/too-long', () => { throw new types.ValidationError('Text too long. Maximum 4,000 characters per job for free tier. Upgrade for higher limits.'); });
  app.get('/notfound', () => { throw new types.NotFoundError('Shared voice'); });
  app.get('/forbidden', () => { throw new types.AuthorizationError('This voice requires a higher subscription tier', { required_tier: 'pro' }); });
  app.get('/unauth', () => { throw new types.AuthenticationError('Token expired'); });
  app.get('/quota', () => {
    throw new types.QuotaExceededError('Daily limit reached', { daily_used: 5, daily_limit: 5 } as never);
  });
  app.get('/explicit', () => { throw new types.AppError(409, 'CONFLICT', 'Whatever English', undefined, 'voice_already_revoked'); });
  // A PostgREST-style plain object (not an Error) thrown by a handler.
  app.get('/plain-object', () => { throw { code: '22P02', message: 'invalid input syntax for type uuid: "abc"', details: null, hint: null }; });
  app.get('/boom', () => { throw new Error('db exploded: secret stuff'); });
  app.get('/cloning', () => { throw new types.AppError(503, 'CLONING_UNAVAILABLE', 'Voice cloning is not available.'); });
  // Handlers that answer themselves instead of calling next(err):
  app.get('/direct', (_req, res) => { res.status(400).json({ error: 'X-Device-ID header is required' }); });
  app.get('/direct-ratelimit', (_req, res) => { res.status(429).json({ error: 'RATE_LIMITED', message: 'Too many requests, please try again later' }); });
  app.get('/direct-with-code', (_req, res) => { res.status(400).json({ error: 'x', code: 'insufficient_credit' }); });
  app.get('/ok', (_req, res) => { res.status(200).json({ error: 'not an error body' }); });
  // A streamed response that fails after the headers went out (SSE, audio): the handler must not try to write a body.
  app.get('/stream-fail', (_req, res) => { res.write('data: 1\n\n'); throw new Error('mid-stream failure'); });
  app.use(eh.notFoundHandler);
  app.use(eh.errorHandler);
  const server = app.listen(0);
  const { port } = server.address() as { port: number };
  const get = async (path: string, headers: Record<string, string> = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
    return { status: r.status, body: (await r.json()) as Record<string, unknown>, headers: r.headers };
  };
  return { get, port, close: () => server.close() };
}

test('errorHandler keeps the English error/message and adds a specific code', async () => {
  const { get, close } = await boot();
  try {
    let r = await get('/validation');
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'VALIDATION_ERROR');
    assert.equal(r.body.message, 'This voice is already shared to the marketplace');
    assert.equal(r.body.code, 'voice_already_shared');
    assert.equal(r.headers.get('content-language'), 'en');

    r = await get('/validation-generic');
    assert.equal(r.body.code, 'invalid_request');
    assert.deepEqual(r.body.details, { errors: { text: ['Required'] } });

    r = await get('/too-long');
    assert.equal(r.body.code, 'text_too_long');

    r = await get('/notfound');
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'NOT_FOUND');
    assert.equal(r.body.message, 'Shared voice not found');
    assert.equal(r.body.code, 'shared_voice_not_found');

    r = await get('/forbidden');
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'tier_required');

    r = await get('/unauth');
    assert.equal(r.status, 401);
    assert.equal(r.body.code, 'token_expired');

    r = await get('/quota');
    assert.equal(r.status, 402);
    assert.equal(r.body.error, 'QUOTA_EXCEEDED');
    assert.equal(r.body.code, 'quota_daily_exceeded');
    assert.equal((r.body.details as Record<string, unknown>).daily_limit, 5);

    r = await get('/cloning');
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'cloning_unavailable');

    r = await get('/explicit');
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'voice_already_revoked');
  } finally {
    close();
  }
});

test('unexpected errors answer 500 with internal_error and never leak the internal message', async () => {
  const { get, close } = await boot();
  try {
    const r = await get('/boom');
    assert.equal(r.status, 500);
    assert.equal(r.body.error, 'INTERNAL_ERROR');
    assert.equal(r.body.message, 'An unexpected error occurred');
    assert.equal(r.body.code, 'internal_error');
  } finally {
    close();
  }
});

test('unknown route and malformed JSON get codes', async () => {
  const { get, close, port } = await boot();
  try {
    const r = await get('/nope');
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 'not_found');
    const bad = await fetch(`http://127.0.0.1:${port}/ok`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' });
    assert.equal(bad.status, 400);
    const body = (await bad.json()) as Record<string, unknown>;
    assert.equal(body.error, 'INVALID_JSON');
    assert.equal(body.code, 'invalid_json');
  } finally {
    close();
  }
});

test('errorCodeNet adds a code to bodies the handler wrote itself, and leaves success bodies and set codes alone', async () => {
  const { get, close } = await boot();
  try {
    let r = await get('/direct');
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'X-Device-ID header is required'); // old clients still read this
    assert.equal(r.body.code, 'device_id_required');

    r = await get('/direct-ratelimit');
    assert.equal(r.body.error, 'RATE_LIMITED');
    assert.equal(r.body.code, 'rate_limited');

    r = await get('/direct-with-code');
    assert.equal(r.body.code, 'insufficient_credit');

    r = await get('/ok');
    assert.equal(r.status, 200);
    assert.equal(r.body.code, undefined);
    assert.equal(r.headers.get('content-language'), null);
  } finally {
    close();
  }
});

test('Accept-Language is read into res.locals.lang', async () => {
  const { get, close } = await boot();
  try {
    assert.equal((await get('/lang', { 'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.5' })).body.lang, 'fr');
    assert.equal((await get('/lang', { 'Accept-Language': 'pt-PT,pt;q=0.9' })).body.lang, 'pt-BR');
    assert.equal((await get('/lang')).body.lang, 'en');
  } finally {
    close();
  }
});

test('pickLanguage: weights, regions, legacy tags, junk', async () => {
  const [, , , { pickLanguage }] = await modP;
  assert.equal(pickLanguage('de'), 'de');
  assert.equal(pickLanguage('xx, de;q=0.4'), 'de');
  assert.equal(pickLanguage('en;q=0.2, ja;q=0.8'), 'ja');
  assert.equal(pickLanguage('zh-Hans-CN'), 'zh-CN');
  assert.equal(pickLanguage('zh'), 'zh-CN');
  assert.equal(pickLanguage('zh-SG'), 'zh-CN');
  assert.equal(pickLanguage('zh-Hans'), 'zh-CN');
  assert.equal(pickLanguage('zh-TW'), 'zh-TW');
  assert.equal(pickLanguage('zh-Hant-TW, zh;q=0.9, en;q=0.5'), 'zh-TW');
  assert.equal(pickLanguage('zh-Hant'), 'zh-TW');
  assert.equal(pickLanguage('zh-HK, zh;q=0.9'), 'zh-HK');
  assert.equal(pickLanguage('zh-Hant-HK'), 'zh-HK');
  assert.equal(pickLanguage('zh-MO'), 'zh-HK');
  assert.equal(pickLanguage('constructor'), 'en');
  assert.equal(pickLanguage('__proto__'), 'en');
  assert.equal(pickLanguage('in-ID'), 'id');
  assert.equal(pickLanguage('tl'), 'fil');
  assert.equal(pickLanguage('pt-BR'), 'pt-BR');
  assert.equal(pickLanguage('he, ja;q=0'), 'en');
  assert.equal(pickLanguage('*'), 'en');
  assert.equal(pickLanguage(''), 'en');
  assert.equal(pickLanguage(undefined), 'en');
  assert.equal(pickLanguage('x'.repeat(600)), 'en');
  assert.equal(pickLanguage(';;;,,,q=='), 'en');
});

test('resolveErrorCode falls back to the HTTP status', async () => {
  const [, , , { resolveErrorCode }] = await modP;
  assert.equal(resolveErrorCode(401, 'whatever'), 'unauthenticated');
  assert.equal(resolveErrorCode(402, undefined), 'quota_exceeded');
  assert.equal(resolveErrorCode(413, 'big'), 'payload_too_large');
  assert.equal(resolveErrorCode(502, 'x'), 'provider_error');
  assert.equal(resolveErrorCode(504, 'x'), 'timeout');
  assert.equal(resolveErrorCode(500, 'x'), 'internal_error');
  assert.equal(resolveErrorCode(418, 'x'), 'unknown_error');
});

test('an error after the headers were sent does not crash the handler or the server', async () => {
  const { get, close, port } = await boot();
  try {
    await fetch(`http://127.0.0.1:${port}/stream-fail`).then((r) => r.text()).catch(() => undefined);
    const r = await get('/direct');
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'device_id_required');
  } finally {
    close();
  }
});

test('a thrown plain object (PostgREST error) is a 500 with the stable code and none of its text in the body', async () => {
  const { get, close } = await boot();
  try {
    const r = await get('/plain-object');
    assert.equal(r.status, 500);
    assert.equal(r.body.error, 'INTERNAL_ERROR');
    assert.equal(r.body.message, 'An unexpected error occurred');
    assert.equal(typeof r.body.code, 'string');
    assert.ok(!JSON.stringify(r.body).includes('uuid'));
  } finally { close(); }
});
