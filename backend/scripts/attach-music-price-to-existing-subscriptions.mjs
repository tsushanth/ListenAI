#!/usr/bin/env node
// One-time backfill: the music-generation Stripe price only gets attached to
// NEW checkout sessions (see createCheckoutSession in realtimeTtsBilling.ts).
// Existing subscribers who checked out before that price existed have an
// active subscription with no music-generation line item, so usage reported
// via reportMusicGenerationUsage tracks correctly but bills $0 for them.
// This script adds the price as a new subscription item to every active
// realtimetts_billing subscription that doesn't already have it. Idempotent —
// safe to re-run; skips subscriptions that already have the item.
//
// Run with:
//   STRIPE_SECRET_KEY=sk_live_... \
//   MUSIC_GENERATION_PRICE_ID=price_... \
//   SUPABASE_URL=https://... SUPABASE_SERVICE_ROLE_KEY=... \
//   node scripts/attach-music-price-to-existing-subscriptions.mjs

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripeKey = process.env.STRIPE_SECRET_KEY;
const musicPriceId = process.env.MUSIC_GENERATION_PRICE_ID;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!stripeKey || !musicPriceId || !supabaseUrl || !supabaseKey) {
  console.error('STRIPE_SECRET_KEY, MUSIC_GENERATION_PRICE_ID, SUPABASE_URL, and SUPABASE_SERVICE_ROLE_KEY are all required');
  process.exit(1);
}

const stripe = new Stripe(stripeKey, { apiVersion: '2023-10-16' });
const supabase = createClient(supabaseUrl, supabaseKey);

async function main() {
  const { data: rows, error } = await supabase
    .from('realtimetts_billing')
    .select('user_id, stripe_subscription_id')
    .eq('active', true);
  if (error) throw error;

  console.log(`Found ${rows.length} active subscriptions to check.`);

  let attached = 0;
  let alreadyHad = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const subscription = await stripe.subscriptions.retrieve(row.stripe_subscription_id);
      const alreadyAttached = subscription.items.data.some((item) => item.price.id === musicPriceId);
      if (alreadyAttached) {
        alreadyHad++;
        continue;
      }
      await stripe.subscriptionItems.create({
        subscription: row.stripe_subscription_id,
        price: musicPriceId,
      });
      attached++;
      console.log(`Attached music price to subscription ${row.stripe_subscription_id} (user ${row.user_id})`);
    } catch (err) {
      failed++;
      console.error(`Failed for subscription ${row.stripe_subscription_id} (user ${row.user_id}):`, err.message);
    }
  }

  console.log(`\nDone. Attached: ${attached}, already had it: ${alreadyHad}, failed: ${failed}.`);
}

main();
