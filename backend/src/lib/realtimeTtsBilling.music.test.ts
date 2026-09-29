// Run: npx tsx --test src/lib/realtimeTtsBilling.music.test.ts
// reportMusicGenerationUsage follows the same (non-injectable) best-effort shape as
// reportVoiceDesignUsage/reportVoiceConvertUsage in realtimeTtsBilling.ts — it talks
// to the real `stripe` client and `getBillingForUser` directly, so there's no seam to
// mock the Stripe call itself. What we can and must verify is the contract that matters
// to callers (Task 10's musicJobWorker): it never throws, even when nothing behind it
// (Supabase lookup, Stripe) is reachable.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test'; // logger only loads pino-pretty in development

const modP = import('./realtimeTtsBilling.js'); // after env is set; no top-level await (CJS build)

test('reportMusicGenerationUsage does not throw when the Stripe call fails (best-effort)', async () => {
  const { reportMusicGenerationUsage } = await modP;
  await assert.doesNotReject(() => reportMusicGenerationUsage('00000000-0000-0000-0000-000000000001'));
});

test('MUSIC_GENERATION_METER_EVENT_NAME is exported and set', async () => {
  const { MUSIC_GENERATION_METER_EVENT_NAME } = await modP;
  assert.equal(MUSIC_GENERATION_METER_EVENT_NAME, 'realtimetts_music_generations');
});
