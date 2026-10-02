#!/usr/bin/env node
// READ-ONLY money-path check for one ReadAloud API account. Never writes to Stripe or Supabase.
//
//   cd backend
//   STRIPE_SECRET_KEY=sk_live_... SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=... \
//     node scripts/verify-money-path.mjs <email | user-uuid> [--json]
//
// (Run from backend/ so `stripe` and `@supabase/supabase-js` resolve from backend/node_modules.)
//
// Prints, in order:
//   1. the realtimetts_billing row (active / comped / Stripe ids)
//   2. the Stripe customer and subscription (status, default payment method present?)
//   3. meter event summaries per subscribed meter for the current billing period
//   4. an upcoming-invoice preview (what the next invoice would charge)
//   5. the free-credit balance (realtimetts_free_credits)
// and a PASS/WARN/FAIL verdict list at the end. Exit code 0 unless a FAIL is found.
//
// Units: 1 meter unit = $0.00001 (the character meter's $0.01 per 1,000 characters), so
// 1,000 units = $0.01 and the invoice "quantity" is in character-equivalents.

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const [, , rawId, ...flags] = process.argv;
const asJson = flags.includes('--json');
const need = (name) => {
  if (!process.env[name]) {
    console.error(`${name} is required (see header of this script)`);
    process.exit(2);
  }
  return process.env[name];
};
if (!rawId || rawId.startsWith('--')) {
  console.error('usage: node scripts/verify-money-path.mjs <email | user-uuid> [--json]');
  process.exit(2);
}

const stripeKey = need('STRIPE_SECRET_KEY');
const stripe = new Stripe(stripeKey, { apiVersion: '2023-10-16' });
const supabase = createClient(need('SUPABASE_URL'), need('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false },
});

const FREE_CREDIT_UNITS = 10000; // keep in sync with realtimeTtsBilling.ts
const USD_PER_UNIT = 0.00001;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const verdicts = [];
const verdict = (level, msg) => verdicts.push({ level, msg });
const out = {};
const say = (s = '') => { if (!asJson) console.log(s); };
const money = (cents) => (cents == null ? 'n/a' : `$${(cents / 100).toFixed(4)}`);

async function resolveUser(id) {
  if (UUID_RE.test(id)) {
    const { data, error } = await supabase.auth.admin.getUserById(id);
    if (error) throw new Error(`auth lookup failed: ${error.message}`);
    return data.user;
  }
  const email = id.toLowerCase();
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`auth listUsers failed: ${error.message}`);
    const hit = data.users.find((u) => (u.email || '').toLowerCase() === email);
    if (hit) return hit;
    if (data.users.length < 200) break;
  }
  return null;
}

const user = await resolveUser(rawId);
if (!user) {
  console.error(`No Supabase auth user found for ${rawId}`);
  process.exit(1);
}
out.user = { id: user.id, email: user.email, created_at: user.created_at };
say(`USER            ${user.email}  (${user.id})`);

// 1. billing row ------------------------------------------------------------------------------
const { data: billing, error: bErr } = await supabase
  .from('realtimetts_billing').select('*').eq('user_id', user.id).maybeSingle();
if (bErr) throw new Error(`realtimetts_billing read failed: ${bErr.message}`);
out.billing = billing;
say('\n1. BILLING ROW (realtimetts_billing)');
if (!billing) {
  say('   none (user has never completed checkout; usage draws on free credits only)');
  verdict('WARN', 'no realtimetts_billing row: checkout has not completed (or webhook not delivered)');
} else {
  say(`   active=${billing.active}  comped=${billing.comped ?? false}`);
  say(`   stripe_customer_id=${billing.stripe_customer_id}`);
  say(`   stripe_subscription_id=${billing.stripe_subscription_id}`);
  say(`   stripe_subscription_item_id=${billing.stripe_subscription_item_id}`);
  if (billing.comped) verdict('WARN', 'account is COMPED: usage is never sent to Stripe, so this is NOT a valid money-path test account');
  else if (!billing.active) verdict('FAIL', 'billing row exists but active=false (webhook deactivated it, or no payment method)');
  else verdict('PASS', 'billing row active and not comped');
  if (!billing.comped && !billing.stripe_customer_id) verdict('FAIL', 'non-comped active row has no stripe_customer_id');
}

// 5 (read early). free credits --------------------------------------------------------------
const { data: fc, error: fcErr } = await supabase
  .from('realtimetts_free_credits').select('granted, used').eq('user_id', user.id).maybeSingle();
if (fcErr) throw new Error(`realtimetts_free_credits read failed: ${fcErr.message}`);
const granted = fc ? Number(fc.granted) : FREE_CREDIT_UNITS;
const used = fc ? Number(fc.used) : 0;
out.free_credits = { granted, used, remaining: Math.max(0, granted - used), row_exists: !!fc };

// 2. Stripe customer / subscription -------------------------------------------------------------
say('\n2. STRIPE');
let sub = null;
let customerId = billing?.stripe_customer_id || null;
if (billing?.comped) {
  say('   comped: no Stripe objects expected');
} else if (!customerId) {
  say('   no customer id on the billing row; nothing to check in Stripe');
} else {
  const customer = await stripe.customers.retrieve(customerId, { expand: ['invoice_settings.default_payment_method'] });
  if (customer.deleted) {
    verdict('FAIL', `Stripe customer ${customerId} is deleted`);
  } else {
    out.customer = { id: customer.id, email: customer.email, livemode: customer.livemode, balance: customer.balance };
    say(`   customer ${customer.id}  email=${customer.email}  livemode=${customer.livemode}  balance=${money(customer.balance)}`);
  }
  const subId = billing.stripe_subscription_id;
  sub = subId ? await stripe.subscriptions.retrieve(subId, { expand: ['default_payment_method'] }) : null;
  if (!sub) {
    verdict('FAIL', 'no stripe_subscription_id on the billing row');
  } else {
    // A payment method can live on the subscription OR the customer's invoice settings.
    const custPm = customer.deleted ? null : customer.invoice_settings?.default_payment_method;
    const hasPm = !!(sub.default_payment_method || custPm);
    out.subscription = {
      id: sub.id, status: sub.status, collection_method: sub.collection_method,
      current_period_start: sub.current_period_start, current_period_end: sub.current_period_end,
      cancel_at_period_end: sub.cancel_at_period_end, default_payment_method_present: hasPm,
      latest_invoice: typeof sub.latest_invoice === 'string' ? sub.latest_invoice : sub.latest_invoice?.id ?? null,
    };
    say(`   subscription ${sub.id}  status=${sub.status}  collection=${sub.collection_method}  cancel_at_period_end=${sub.cancel_at_period_end}`);
    say(`   period ${new Date(sub.current_period_start * 1000).toISOString()} -> ${new Date(sub.current_period_end * 1000).toISOString()}`);
    say(`   default payment method present: ${hasPm}`);
    say(`   items: ${sub.items.data.map((i) => `${i.id} price=${i.price.id} meter=${i.price.recurring?.meter ?? '-'}`).join('; ')}`);
    if (sub.status !== 'active' && sub.status !== 'trialing') verdict('FAIL', `subscription status is ${sub.status}`);
    else verdict('PASS', `subscription ${sub.status}`);
    verdict(hasPm ? 'PASS' : 'FAIL', hasPm ? 'default payment method present' : 'NO default payment method (invoice would not be collectable)');
    if (sub.collection_method !== 'charge_automatically') verdict('WARN', `collection_method=${sub.collection_method}: invoices are emailed, not auto-charged`);
    if (billing.stripe_subscription_item_id && !sub.items.data.some((i) => i.id === billing.stripe_subscription_item_id)) {
      verdict('WARN', 'billing row stripe_subscription_item_id is not an item of the subscription');
    }
  }
}

// 3. meter event summaries -----------------------------------------------------------------------
say('\n3. METER EVENT SUMMARIES (current billing period)');
out.meters = [];
if (sub && customerId) {
  // Stripe wants minute-aligned bounds; summaries also lag the events by up to a few minutes.
  const start = Math.floor(sub.current_period_start / 60) * 60;
  const end = Math.floor(Date.now() / 1000 / 60) * 60 + 60;
  const meterIds = [...new Set(sub.items.data.map((i) => i.price.recurring?.meter).filter(Boolean))];
  if (meterIds.length === 0) verdict('FAIL', 'subscription has no metered prices');
  for (const meterId of meterIds) {
    const meter = await stripe.billing.meters.retrieve(meterId);
    const sums = await stripe.billing.meters.listEventSummaries(meterId, {
      customer: customerId, start_time: start, end_time: end,
    });
    const total = sums.data.reduce((a, s) => a + Number(s.aggregated_value || 0), 0);
    const row = { meter: meterId, event_name: meter.event_name, status: meter.status, total_units: total, approx_usd: total * USD_PER_UNIT };
    out.meters.push(row);
    say(`   ${meterId}  event=${meter.event_name}  status=${meter.status}  total=${total} units  (~$${(total * USD_PER_UNIT).toFixed(5)})`);
  }
  const charMeter = out.meters.find((m) => m.event_name === 'realtimetts_characters');
  if (!charMeter) verdict('FAIL', 'subscription is not attached to the realtimetts_characters meter');
  else if (charMeter.total_units === 0) verdict('WARN', 'character meter has 0 units this period: no usage drained yet (wait 5 min after the jobs, or the drain is failing)');
  else verdict('PASS', `character meter received ${charMeter.total_units} units this period`);
} else {
  say('   n/a (no subscription)');
}

// 4. upcoming invoice -----------------------------------------------------------------------------
say('\n4. UPCOMING INVOICE PREVIEW');
if (sub && customerId) {
  try {
    const inv = await stripe.invoices.retrieveUpcoming({ customer: customerId, subscription: sub.id });
    out.upcoming_invoice = {
      amount_due: inv.amount_due, total: inv.total, currency: inv.currency,
      lines: inv.lines.data.map((l) => ({ description: l.description, quantity: l.quantity, amount: l.amount })),
    };
    say(`   total ${money(inv.total)}  amount_due ${money(inv.amount_due)}`);
    for (const l of inv.lines.data) say(`   - ${l.description ?? l.price?.id}  qty=${l.quantity}  ${money(l.amount)}`);
    const lineUnits = inv.lines.data.reduce((a, l) => a + (l.quantity || 0), 0);
    const meterUnits = out.meters.reduce((a, m) => a + m.total_units, 0);
    if (meterUnits > 0 && lineUnits === 0) verdict('WARN', 'meter has units but invoice preview shows quantity 0 (summaries/preview can lag a few minutes; re-run)');
    // price is $0.001 per unit-of-1 => decimal 0.001 cents/unit; sanity check total vs units
    const expectedCents = meterUnits * USD_PER_UNIT * 100;
    if (meterUnits > 0 && Math.abs(inv.total - expectedCents) > Math.max(1, expectedCents * 0.05)) {
      verdict('WARN', `invoice total ${inv.total}c differs from meter-derived ${expectedCents.toFixed(3)}c (>5%); Stripe rounds a metered line to a whole cent`);
    }
  } catch (e) {
    say(`   preview unavailable: ${e.message}`);
    verdict('WARN', `upcoming invoice preview failed: ${e.message}`);
  }
} else {
  say('   n/a (no subscription)');
}

// 5. free credits -----------------------------------------------------------------------------------
say('\n5. FREE CREDITS (realtimetts_free_credits)');
say(`   granted=${granted}  used=${used}  remaining=${out.free_credits.remaining}  (~$${(out.free_credits.remaining * USD_PER_UNIT).toFixed(4)}; row ${fc ? 'exists' : 'not created yet = untouched full grant'})`);
if (billing && !billing.comped && billing.active && used > 0) {
  verdict('PASS', `free credits were consumed before payment (${used} units used)`);
}

// verdicts ------------------------------------------------------------------------------------------
say('\nVERDICTS');
for (const v of verdicts) say(`   [${v.level}] ${v.msg}`);
out.verdicts = verdicts;
if (asJson) console.log(JSON.stringify(out, null, 2));
process.exit(verdicts.some((v) => v.level === 'FAIL') ? 1 : 0);
