import { test } from 'node:test'
import assert from 'node:assert/strict'

const {
  getOrCreateCheckoutSession,
  isPrefetchRequest,
  isUserInitiatedNavigation,
  parsePlan,
  MIN_REMAINING_SECONDS,
} = await import('../src/lib/checkoutSession.ts')

const h = (o: Record<string, string>) => ({ get: (n: string) => o[n.toLowerCase()] ?? null })

function fakeStripe(opts: { existing?: Record<string, any>; retrieveThrows?: boolean } = {}) {
  const calls = { create: [] as any[], retrieve: [] as string[] }
  let n = 0
  const seenKeys = new Map<string, any>()
  return {
    calls,
    stripe: {
      checkout: {
        sessions: {
          async retrieve(id: string) {
            calls.retrieve.push(id)
            if (opts.retrieveThrows) throw new Error('No such checkout.session')
            return opts.existing?.[id]
          },
          async create(params: any, options?: { idempotencyKey?: string }) {
            const k = options?.idempotencyKey
            if (k && seenKeys.has(k)) return seenKeys.get(k)
            calls.create.push({ params, options })
            const s = { id: `cs_live_new${++n}`, url: `https://checkout.stripe.com/c/pay/cs_live_new${n}` }
            if (k) seenKeys.set(k, s)
            return s
          },
        },
      },
    },
  }
}

const NOW = 1_800_000_000
const base = { plan: 'pro_weekly' as const, priceId: 'price_weekly', appUrl: 'https://readaloudai.org', visitorId: 'v1', nowSeconds: NOW }

test('parsePlan accepts only the two plans', () => {
  assert.equal(parsePlan('pro_weekly'), 'pro_weekly')
  assert.equal(parsePlan('pro_yearly'), 'pro_yearly')
  assert.equal(parsePlan('pro_monthly'), null)
  assert.equal(parsePlan(null), null)
  assert.equal(parsePlan(undefined), null)
})

test('prefetches, RSC fetches and crawlers are not user navigations', () => {
  const nav = { 'sec-fetch-user': '?1', 'sec-fetch-mode': 'navigate' }
  assert.equal(isUserInitiatedNavigation(h(nav)), true)
  assert.equal(isUserInitiatedNavigation(h({ ...nav, rsc: '1' })), false)
  assert.equal(isUserInitiatedNavigation(h({ ...nav, 'next-router-prefetch': '1' })), false)
  assert.equal(isUserInitiatedNavigation(h({ ...nav, purpose: 'prefetch' })), false)
  assert.equal(isUserInitiatedNavigation(h({ ...nav, 'sec-purpose': 'prefetch;anonymous-client-ip' })), false)
  assert.equal(isUserInitiatedNavigation(h({})), false) // curl, bots, unfurlers: no Sec-Fetch headers
  assert.equal(isUserInitiatedNavigation(h({ 'sec-fetch-mode': 'cors' })), false) // fetch()-based prefetch
  assert.equal(isPrefetchRequest(h({ rsc: '1' })), true)
  assert.equal(isPrefetchRequest(h({})), false)
})

test('creates exactly one session with the unchanged price, trial and options', async () => {
  const f = fakeStripe()
  const r = await getOrCreateCheckoutSession({ ...base, stripe: f.stripe })
  assert.equal(r.reused, false)
  assert.equal(f.calls.create.length, 1)
  const p = f.calls.create[0].params
  assert.equal(p.mode, 'subscription')
  assert.deepEqual(p.payment_method_types, ['card'])
  assert.deepEqual(p.line_items, [{ price: 'price_weekly', quantity: 1 }])
  assert.deepEqual(p.subscription_data, { trial_period_days: 7 })
  assert.equal(p.allow_promotion_codes, true)
  assert.equal(p.billing_address_collection, 'auto')
  assert.equal(p.success_url, 'https://readaloudai.org/success?session_id={CHECKOUT_SESSION_ID}')
  assert.equal(p.cancel_url, 'https://readaloudai.org/reader#pricing')
  assert.equal(p.customer, undefined) // never creates a customer up front
  assert.equal(p.metadata.plan, 'pro_weekly')
})

test('reuses a still-open session for the same visitor and plan', async () => {
  const f = fakeStripe({
    existing: {
      cs_live_abc: { id: 'cs_live_abc', url: 'https://checkout.stripe.com/c/pay/cs_live_abc', status: 'open', expires_at: NOW + 3600 * 12, metadata: { visitor: 'v1', plan: 'pro_weekly' } },
    },
  })
  const r = await getOrCreateCheckoutSession({ ...base, stripe: f.stripe, existingSessionId: 'cs_live_abc' })
  assert.equal(r.reused, true)
  assert.equal(r.sessionId, 'cs_live_abc')
  assert.equal(f.calls.create.length, 0)
})

test('does not reuse an expired, completed, nearly-expired, other-visitor or other-plan session', async () => {
  const mk = (over: Record<string, unknown>) => ({
    cs_live_abc: { id: 'cs_live_abc', url: 'https://x', status: 'open', expires_at: NOW + 3600 * 12, metadata: { visitor: 'v1', plan: 'pro_weekly' }, ...over },
  })
  const cases: Record<string, unknown>[] = [
    { status: 'expired' },
    { status: 'complete' },
    { expires_at: NOW + MIN_REMAINING_SECONDS - 1 },
    { metadata: { visitor: 'someone-else', plan: 'pro_weekly' } },
    { metadata: { visitor: 'v1', plan: 'pro_yearly' } },
    { url: null },
  ]
  for (const over of cases) {
    const f = fakeStripe({ existing: mk(over) })
    const r = await getOrCreateCheckoutSession({ ...base, stripe: f.stripe, existingSessionId: 'cs_live_abc' })
    assert.equal(r.reused, false, JSON.stringify(over))
    assert.equal(f.calls.create.length, 1, JSON.stringify(over))
  }
})

test('a Stripe error or junk cookie on retrieve falls back to creating a session', async () => {
  const f = fakeStripe({ retrieveThrows: true })
  const r = await getOrCreateCheckoutSession({ ...base, stripe: f.stripe, existingSessionId: 'cs_live_gone' })
  assert.equal(r.reused, false)
  const g = fakeStripe()
  await getOrCreateCheckoutSession({ ...base, stripe: g.stripe, existingSessionId: '../../etc' })
  assert.equal(g.calls.retrieve.length, 0) // malformed ids never reach Stripe
  assert.equal(g.calls.create.length, 1)
})

test('rapid repeat requests (double-click, no cookie yet) collapse to one session via the idempotency key', async () => {
  const f = fakeStripe()
  const a = await getOrCreateCheckoutSession({ ...base, stripe: f.stripe })
  const b = await getOrCreateCheckoutSession({ ...base, stripe: f.stripe, nowSeconds: NOW + 20 })
  assert.equal(a.sessionId, b.sessionId)
  assert.equal(f.calls.create.length, 1)
  // different plan or visitor is a different key
  await getOrCreateCheckoutSession({ ...base, plan: 'pro_yearly', priceId: 'price_yearly', stripe: f.stripe })
  await getOrCreateCheckoutSession({ ...base, visitorId: 'v2', stripe: f.stripe })
  assert.equal(f.calls.create.length, 3)
})

test('throws when Stripe returns no url', async () => {
  const stripe = { checkout: { sessions: { retrieve: async () => ({ id: 'x' }), create: async () => ({ id: 'cs_x', url: null }) } } }
  await assert.rejects(() => getOrCreateCheckoutSession({ ...base, stripe }), /checkout URL/)
})
