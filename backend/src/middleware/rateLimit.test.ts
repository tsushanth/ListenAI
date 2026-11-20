// npm test (node:test via tsx), same pattern as routes/realtimeTts.test.ts: boot a real express
// server with app.listen(0) and hit it over the network with fetch.
//
// This specifically proves the fix for the "open proxy" finding: requireAuth defaults callers with
// no/invalid bearer token to a shared "pro user" instead of rejecting them (see middleware/auth.ts),
// so /api/realtime-tts/authorize needs its own rate limit — beyond the general burstRateLimit — to
// stop an anonymous caller from cheaply running up billing against the shared REALTIME_TTS_API_KEY.
import test from 'node:test';
import assert from 'node:assert/strict';

// rateLimit.ts imports lib/config.js, which eagerly validates the full Supabase env at import time
// (see lib/realtimeTtsBilling.test.ts for the same pattern). ES module imports are hoisted above
// plain statements, so env vars must be set before a dynamic import(), not before a static one.
process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';

const modP = import('./rateLimit.js'); // after env is set; no top-level await (CJS build)

async function boot() {
  const [{ default: express }, { realtimeTtsAuthorizeRateLimit }] = await Promise.all([
    import('express'),
    modP,
  ]);
  const app = express();
  app.use(express.json());
  // Mirror the real mount order in index.ts (minus burstRateLimit/requireAuth, which aren't the
  // subject of this test) around a stub handler standing in for realtimeTtsRouter.
  app.use('/api/realtime-tts', realtimeTtsAuthorizeRateLimit, (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
    res.status(200).json({ token: 'stub', url: 'wss://example.test/tts' });
  });
  const server = app.listen(0);
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}/api/realtime-tts`;
  return { base, close: () => server.close() };
}

test('realtimeTtsAuthorizeRateLimit rate-limits repeated unauthenticated calls from the same IP', async () => {
  const { base, close } = await boot();
  try {
    const responses: number[] = [];
    // The limiter allows 10 requests per 5-minute window per IP; fire 12 rapid calls and confirm
    // at least one gets rejected with 429 before all quota is exhausted.
    for (let i = 0; i < 12; i++) {
      const res = await fetch(`${base}/authorize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ engine: 'piper' }),
      });
      responses.push(res.status);
    }

    const okCount = responses.filter((s) => s === 200).length;
    const limitedCount = responses.filter((s) => s === 429).length;

    assert.ok(okCount <= 10, `expected at most 10 successful calls, got ${okCount}`);
    assert.ok(limitedCount > 0, 'expected at least one 429 rate-limited response among 12 rapid calls');
    assert.equal(okCount + limitedCount, 12);
  } finally {
    close();
  }
});

test('realtimeTtsAuthorizeRateLimit: a well-formed X-Install-Id gets the looser per-IP ceiling; garbage ids stay at 10 per 5 min', async () => {
  const [{ default: express }, { realtimeTtsAuthorizeRateLimit }] = await Promise.all([import('express'), modP]);
  const app = express();
  app.set('trust proxy', 1); // distinct client IPs via X-Forwarded-For, so this test has its own limiter keys
  app.use('/api/realtime-tts', realtimeTtsAuthorizeRateLimit, (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
    res.status(200).json({ ok: true });
  });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/realtime-tts/authorize`;
  const hit = async (ip: string, installId?: string) =>
    (await fetch(base, { method: 'POST', headers: { 'x-forwarded-for': ip, ...(installId ? { 'x-install-id': installId } : {}) } })).status;
  try {
    const identified: number[] = [];
    for (let i = 0; i < 15; i++) identified.push(await hit('198.51.100.1', '0b6f2c7e-4a51-4d0e-9a3b-6f1d2c3e4a5b'));
    assert.ok(identified.every((s) => s === 200), `identified callers should pass 15 in a row: ${identified}`);

    const garbage: number[] = [];
    for (let i = 0; i < 12; i++) garbage.push(await hit('198.51.100.2', 'not-a-uuid'));
    assert.equal(garbage.filter((s) => s === 200).length, 10);
    assert.equal(garbage.filter((s) => s === 429).length, 2);
  } finally {
    server.close();
  }
});

test('tester bypass: the express limiters (burst 3/10 s and authorize 10/5 min) skip a request with the valid X-Tts-Test-Key, and only that one', async () => {
  const secret = 'limiter-test-secret-0123456789abcdef';
  process.env.TTS_TEST_BYPASS_KEY = secret;
  const [{ default: express }, { realtimeTtsAuthorizeRateLimit, burstRateLimit }] = await Promise.all([import('express'), modP]);
  const app = express();
  app.set('trust proxy', 1);
  app.use('/api/realtime-tts', burstRateLimit, realtimeTtsAuthorizeRateLimit, (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
    res.status(200).json({ ok: true });
  });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/realtime-tts/authorize`;
  const hit = async (ip: string, key?: string) =>
    (await fetch(base, { method: 'POST', headers: { 'x-forwarded-for': ip, ...(key ? { 'x-tts-test-key': key } : {}) } })).status;
  try {
    const withKey: number[] = [];
    for (let i = 0; i < 30; i++) withKey.push(await hit('203.0.113.1', secret));
    assert.ok(withKey.every((s) => s === 200), `valid key should pass 30 rapid calls: ${withKey}`);

    const wrong: number[] = [];
    for (let i = 0; i < 12; i++) wrong.push(await hit('203.0.113.2', 'wrong-wrong-wrong-wrong'));
    assert.ok(wrong.includes(429), 'a wrong key keeps the limits');

    // and while the secret is unset the right value is just an ordinary header
    delete process.env.TTS_TEST_BYPASS_KEY;
    const off: number[] = [];
    for (let i = 0; i < 12; i++) off.push(await hit('203.0.113.3', secret));
    assert.ok(off.includes(429), 'feature off when the secret is unset');
  } finally {
    delete process.env.TTS_TEST_BYPASS_KEY;
    server.close();
  }
});
