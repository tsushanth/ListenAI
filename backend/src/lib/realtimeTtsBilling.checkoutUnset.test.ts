// Run: npx tsx --test src/lib/realtimeTtsBilling.checkoutUnset.test.ts
// Companion to realtimeTtsBilling.checkout.test.ts — verifies the OTHER
// branch (MUSIC_GENERATION_PRICE_ID unset) in its own process, since the
// price-id env var is read once at module load and can't be toggled
// mid-process. Deliberately does NOT set MUSIC_GENERATION_PRICE_ID.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';
delete process.env.MUSIC_GENERATION_PRICE_ID;

test('buildCheckoutLineItems omits the music price when MUSIC_GENERATION_PRICE_ID is unset', async () => {
  const { buildCheckoutLineItems } = await import('./realtimeTtsBilling.js');
  const items = buildCheckoutLineItems();

  assert.equal(items.length, 1);
  assert.equal(items[0].price, 'price_1UCU4gKFBTQTkmztYE2RuWia');
});
