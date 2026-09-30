#!/usr/bin/env node
// One-time setup script: creates the Stripe Billing Meter for dubbing jobs.
// Run with: STRIPE_SECRET_KEY=sk_live_... node scripts/create-dubbing-meter.mjs
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
  const products = await stripe.products.list({ limit: 10 });
  const prod = products.data.find((p) => p.name.toLowerCase().includes('readaloud') || p.name.toLowerCase().includes('realtime') || p.name.toLowerCase().includes('tts'));
  if (!prod) {
    console.error('No ReadAloud/realtime-tts product found. Available:', products.data.map((p) => p.name));
    process.exit(1);
  }
  console.log(`Found product: ${prod.name} (${prod.id})`);

  const meterName = 'realtimetts_dubbing_jobs';
  try {
    const meter = await stripe.billing.meters.create({
      display_name: 'Dubbing Jobs',
      event_name: meterName,
      default_aggregation: { formula: 'sum' },
    });
    console.log(`Created meter: ${meter.id} (event_name: ${meterName})`);

    // $0.05 per completed dubbing job, matching sound-effects/voice-isolate/voice-convert's
    // flat per-generation rate (see create-voice-convert-meter.mjs) per this session's pricing decision.
    const price = await stripe.prices.create({
      product: prod.id,
      currency: 'usd',
      unit_amount: 5,
      billing_scheme: 'per_unit',
      recurring: { interval: 'month', usage_type: 'metered', meter: meter.id },
    });
    console.log(`Created price: ${price.id} ($0.05/job)`);
    console.log(`\nDUBBING_METER_EVENT_NAME=${meterName}`);
  } catch (err) {
    console.error('Failed to create meter/price:', err.message);
    process.exit(1);
  }
}

main();
