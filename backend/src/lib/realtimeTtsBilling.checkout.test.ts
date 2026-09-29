// Run: npx tsx --test src/lib/realtimeTtsBilling.checkout.test.ts
// Verifies buildCheckoutLineItems() attaches the music-generation price only
// when MUSIC_GENERATION_PRICE_ID is configured — this is the fix for the
// "usage tracked but billed $0" gap (the price never existed/was never
// attached to checkout). Each node:test file runs in its own process
// (--test-isolation=process), so setting env before this file's own import
// is safe and doesn't leak into other test files.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';
process.env.MUSIC_GENERATION_PRICE_ID = 'price_test_music_123';

test('buildCheckoutLineItems attaches the music price when MUSIC_GENERATION_PRICE_ID is set', async () => {
  const { buildCheckoutLineItems } = await import('./realtimeTtsBilling.js');
  const items = buildCheckoutLineItems();

  assert.equal(items.length, 2);
  assert.equal(items[1].price, 'price_test_music_123');
});

test('buildCheckoutLineItems always puts the TTS character price first', async () => {
  const { buildCheckoutLineItems } = await import('./realtimeTtsBilling.js');
  const items = buildCheckoutLineItems();

  assert.equal(items[0].price, 'price_1UCU4gKFBTQTkmztYE2RuWia');
});
