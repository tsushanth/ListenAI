#!/usr/bin/env node
// One-time setup script: creates the Stripe Billing Meter for voice design generations.
// Run with: STRIPE_SECRET_KEY=sk_live_... node scripts/create-voice-design-meter.mjs
//
// Assumes the same shared Stripe account as realtimeTtsBilling.ts (price_1UCU4g... product).

import Stripe from 'stripe';

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error('STRIPE_SECRET_KEY required');
  process.exit(1);
}

const stripe = new Stripe(key, { apiVersion: '2023-10-16' });

async function main() {
  // Find the existing ReadAloud / realtime-tts product
  const products = await stripe.products.list({ limit: 10 });
  const prod = products.data.find((p) => p.name.toLowerCase().includes('readaloud') || p.name.toLowerCase().includes('realtime') || p.name.toLowerCase().includes('tts'));
  if (!prod) {
    console.error('No ReadAloud/realtime-tts product found. Available:', products.data.map((p) => p.name));
    process.exit(1);
  }
  console.log(`Found product: ${prod.name} (${prod.id})`);

  // Create a meter for voice design generations
  const meterName = 'realtimetts_voice_design_generations';
  try {
    const meter = await stripe.billing.meters.create({
      display_name: 'Voice Design Generations',
      event_name: meterName,
      default_aggregation: { formula: 'sum' },
      // Same product as the character meter so both line items live on one subscription
      ...(prod.id ? {} : {}),
    });
    console.log(`Created meter: ${meter.id} (event_name: ${meterName})`);

    // Create a price on the same product for $0.015 per generation (~cost+margin)
    const price = await stripe.prices.create({
      product: prod.id,
      currency: 'usd',
      unit_amount: 1.5, // $0.015 per generation = 1.5 cents
      billing_scheme: 'per_unit',
      // For metered prices, use recurring with usage_type: 'metered'
      recurring: { interval: 'month', usage_type: 'metered', meter: meter.id },
    });
    console.log(`Created price: ${price.id} ($0.015/generation)`);
    console.log(`\nAdd to realtimeTtsBilling.ts:`);
    console.log(`  const VOICE_DESIGN_METER_EVENT_NAME = '${meterName}';`);
    console.log(`  const VOICE_DESIGN_PRICE_ID = '${price.id}';`);
  } catch (err) {
    console.error('Failed to create meter/price:', err.message);
    process.exit(1);
  }
}

main();
