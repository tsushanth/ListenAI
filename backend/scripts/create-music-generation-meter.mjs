#!/usr/bin/env node
// One-time setup script: creates the Stripe Billing Meter for music generations.
// Run with: STRIPE_SECRET_KEY=sk_live_... node scripts/create-music-generation-meter.mjs

import Stripe from 'stripe';

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error('STRIPE_SECRET_KEY required');
  process.exit(1);
}

const stripe = new Stripe(key, { apiVersion: '2023-10-16' });

async function main() {
  const products = await stripe.products.list({ limit: 10 });
  const prod = products.data.find((p) =>
    p.name.toLowerCase().includes('readaloud') ||
    p.name.toLowerCase().includes('realtime') ||
    p.name.toLowerCase().includes('tts')
  );
  if (!prod) {
    console.error('No ReadAloud/realtime-tts product found. Available:', products.data.map((p) => p.name));
    process.exit(1);
  }
  console.log(`Found product: ${prod.name} (${prod.id})`);

  const meterName = 'realtimetts_music_generations';
  try {
    const meter = await stripe.billing.meters.create({
      display_name: 'Music Generations',
      event_name: meterName,
      default_aggregation: { formula: 'sum' },
    });
    console.log(`Created meter: ${meter.id} (event_name: ${meterName})`);

    const price = await stripe.prices.create({
      product: prod.id,
      currency: 'usd',
      unit_amount: 5, // $0.05 per generation
      billing_scheme: 'per_unit',
      recurring: { interval: 'month', usage_type: 'metered', meter: meter.id },
    });
    console.log(`Created price: ${price.id} ($0.05/generation)`);
    console.log(`\nSet this env var on the backend deployment so createCheckoutSession actually`);
    console.log(`attaches this price to new subscriptions (see realtimeTtsBilling.ts):`);
    console.log(`  MUSIC_GENERATION_PRICE_ID=${price.id}`);
    console.log(`\n(MUSIC_GENERATION_METER_EVENT_NAME is already hardcoded to '${meterName}' in`);
    console.log(`realtimeTtsBilling.ts and doesn't need to be set — only the price id above does.)`);
  } catch (err) {
    console.error('Failed to create meter/price:', err.message);
    process.exit(1);
  }
}

main();
