#!/usr/bin/env node
// One-time setup script: creates the Stripe Billing Meter for voice conversions.
// Run with: STRIPE_SECRET_KEY=sk_live_... node scripts/create-voice-convert-meter.mjs
//
// Assumes the same shared Stripe account as realtimeTtsBilling.ts.

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

  // Create a meter for voice conversions
  const meterName = 'realtimetts_voice_conversions';
  try {
    const meter = await stripe.billing.meters.create({
      display_name: 'Voice Conversions',
      event_name: meterName,
      default_aggregation: { formula: 'sum' },
    });
    console.log(`Created meter: ${meter.id} (event_name: ${meterName})`);

    // Create a price on the same product
    // Roughly $0.05 per conversion (~48 GPU-seconds at A10G rates)
    const price = await stripe.prices.create({
      product: prod.id,
      currency: 'usd',
      unit_amount: 5, // $0.05 per conversion = 5 cents
      billing_scheme: 'per_unit',
      recurring: { interval: 'month', usage_type: 'metered', meter: meter.id },
    });
    console.log(`Created price: ${price.id} ($0.05/conversion)`);
    console.log(`\nAdd to environment or realtimeTtsBilling.ts:`);
    console.log(`  VOICE_CONVERT_METER_EVENT_NAME=${meterName}`);
    console.log(`  VOICE_CONVERT_PRICE_ID=${price.id}`);
  } catch (err) {
    console.error('Failed to create meter/price:', err.message);
    process.exit(1);
  }
}

main();
