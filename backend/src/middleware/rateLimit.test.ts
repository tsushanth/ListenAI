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
