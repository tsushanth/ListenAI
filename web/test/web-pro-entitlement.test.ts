import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const { getOrCreateCheckoutSession } = await import('../src/lib/checkoutSession.ts')
const { bearerToken, verifySupabaseUser } = await import('../src/lib/checkoutAuth.ts')
const { startWebCheckout } = await import('../src/lib/checkoutClient.ts')
const { parseEntitlement, fetchEntitlement, waitForEntitlement } = await import('../src/lib/entitlementApi.ts')
const { entitlementCopy, WEB_PRO_CHECKOUT_ENABLED } = await import('../src/lib/webPro.ts')

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const h = (o: Record<string, string>) => ({ get: (n: string) => o[n.toLowerCase()] ?? null })

const USER = { id: '11111111-1111-4111-8111-111111111111', email: 'buyer@example.com' }

// ---- the flag stays off in this PR ----------------------------------------------------------------------------------

test('the web checkout flag is still off: this PR only adds the plumbing', () => {
  assert.equal(WEB_PRO_CHECKOUT_ENABLED, false)
})

// ---- checkout session carries the account ----------------------------------------------------------------------------

function fakeStripe() {
  const created: any[] = []
  return {
    created,
    stripe: { checkout: { sessions: {
      async retrieve(id: string): Promise<any> { return { id } },
      async create(params: any, options?: any) { created.push({ params, options }); return { id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' } },
    } } },
  }
}
const base = { plan: 'pro_weekly' as const, priceId: 'price_w', appUrl: 'https://readaloudai.org', visitorId: 'v1', nowSeconds: 1_800_000_000 }

test('a signed-in checkout passes client_reference_id, customer_email and the user id on the session and the subscription', async () => {
  const f = fakeStripe()
  await getOrCreateCheckoutSession({ ...base, stripe: f.stripe, user: USER })
  const p = f.created[0].params
  assert.equal(p.client_reference_id, USER.id)
  assert.equal(p.customer_email, USER.email)
  assert.equal(p.metadata.user_id, USER.id)
  assert.equal(p.metadata.source, 'readaloud_web_pricing')
  // subscription.* webhooks carry only the subscription object, so it needs the same tags
  assert.deepEqual(p.subscription_data, { trial_period_days: 7, metadata: { source: 'readaloud_web_pricing', plan: 'pro_weekly', user_id: USER.id } })
  // price and options are unchanged
  assert.deepEqual(p.line_items, [{ price: 'price_w', quantity: 1 }])
})

test('without an email the session still carries the user id and omits customer_email', async () => {
  const f = fakeStripe()
  await getOrCreateCheckoutSession({ ...base, stripe: f.stripe, user: { id: USER.id, email: null } })
  assert.equal(f.created[0].params.client_reference_id, USER.id)
  assert.equal('customer_email' in f.created[0].params, false)
})

test('an open session is reused only for the same user; another user gets their own', async () => {
  const open = { id: 'cs_live_abc', url: 'https://x', status: 'open', expires_at: base.nowSeconds + 7200, metadata: { visitor: 'v1', plan: 'pro_weekly', user_id: USER.id } }
  const mk = () => ({ checkout: { sessions: { async retrieve() { return open }, async create() { created++; return { id: 'cs_new', url: 'https://y' } } } } })
  let created = 0
  const same = await getOrCreateCheckoutSession({ ...base, stripe: mk(), user: USER, existingSessionId: 'cs_live_abc' })
  assert.equal(same.reused, true)
  const other = await getOrCreateCheckoutSession({ ...base, stripe: mk(), user: { id: '22222222-2222-4222-8222-222222222222', email: 'x@y.z' }, existingSessionId: 'cs_live_abc' })
  assert.equal(other.reused, false)
  assert.equal(created, 1)
})

test('the idempotency key is per user, so two accounts on one browser never share a session', async () => {
  const f = fakeStripe()
  await getOrCreateCheckoutSession({ ...base, stripe: f.stripe, user: USER })
  await getOrCreateCheckoutSession({ ...base, stripe: f.stripe, user: { id: '22222222-2222-4222-8222-222222222222', email: null } })
  assert.notEqual(f.created[0].options.idempotencyKey, f.created[1].options.idempotencyKey)
})

// ---- server-side sign-in check ------------------------------------------------------------------------------------------

test('bearerToken reads only a well-formed Authorization: Bearer header', () => {
  assert.equal(bearerToken(h({ authorization: 'Bearer abc.def' })), 'abc.def')
  assert.equal(bearerToken(h({ authorization: 'bearer abc' })), 'abc')
  for (const v of [undefined, '', 'Bearer', 'Bearer ', 'Basic abc', 'Bearer a b']) {
    assert.equal(bearerToken(h(v === undefined ? {} : { authorization: v })), null, String(v))
  }
})

test('verifySupabaseUser asks Supabase who the token belongs to; it never trusts the token contents', async () => {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return json(200, { id: USER.id, email: USER.email }) }) as unknown as typeof fetch
  const r = await verifySupabaseUser('tok', { supabaseUrl: 'https://p.supabase.co', anonKey: 'anon', fetchImpl })
  assert.deepEqual(r, { status: 'ok', user: USER })
  assert.equal(calls[0]!.url, 'https://p.supabase.co/auth/v1/user')
  assert.deepEqual(calls[0]!.init.headers, { Authorization: 'Bearer tok', apikey: 'anon' })
})

test('verifySupabaseUser: 401 is invalid, a network/5xx failure is unavailable (not a sign-in problem), junk ids are invalid', async () => {
  const o = { supabaseUrl: 'https://p.supabase.co', anonKey: 'anon' }
  assert.deepEqual(await verifySupabaseUser('t', { ...o, fetchImpl: (async () => json(401, { msg: 'bad' })) as unknown as typeof fetch }), { status: 'invalid' })
  assert.deepEqual(await verifySupabaseUser('t', { ...o, fetchImpl: (async () => { throw new Error('ECONNRESET') }) as unknown as typeof fetch }), { status: 'unavailable' })
  assert.deepEqual(await verifySupabaseUser('t', { ...o, fetchImpl: (async () => json(503, {})) as unknown as typeof fetch }), { status: 'unavailable' })
  assert.deepEqual(await verifySupabaseUser('t', { ...o, fetchImpl: (async () => json(200, { id: 'not-a-uuid' })) as unknown as typeof fetch }), { status: 'invalid' })
  assert.deepEqual(await verifySupabaseUser('', { ...o, fetchImpl: (async () => json(200, USER)) as unknown as typeof fetch }), { status: 'invalid' })
})

// ---- the browser side of starting checkout -------------------------------------------------------------------------------

test('startWebCheckout: no token means "sign in", with no request made', async () => {
  let called = 0
  const fetchImpl = (async () => { called++; return json(200, {}) }) as unknown as typeof fetch
  assert.deepEqual(await startWebCheckout({ plan: 'pro_weekly', token: null, fetchImpl }), { status: 'sign_in' })
  assert.deepEqual(await startWebCheckout({ plan: 'pro_weekly', token: '  ', fetchImpl }), { status: 'sign_in' })
  assert.equal(called, 0)
})

test('startWebCheckout posts the plan with the bearer token and returns the Stripe URL', async () => {
  const seen: { url: string; init: RequestInit }[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => { seen.push({ url, init }); return json(200, { url: 'https://checkout.stripe.com/c/pay/cs_test_1' }) }) as unknown as typeof fetch
  const r = await startWebCheckout({ plan: 'pro_yearly', token: 'tok', fetchImpl })
  assert.deepEqual(r, { status: 'redirect', url: 'https://checkout.stripe.com/c/pay/cs_test_1' })
  assert.equal(seen[0]!.url, '/api/checkout')
  assert.equal(seen[0]!.init.method, 'POST')
  assert.equal((seen[0]!.init.headers as Record<string, string>).Authorization, 'Bearer tok')
  assert.deepEqual(JSON.parse(String(seen[0]!.init.body)), { plan: 'pro_yearly' })
})

test('startWebCheckout: 401 -> sign in again; other failures -> a message; a non-Stripe URL is refused', async () => {
  const f = (status: number, body: unknown) => (async () => json(status, body)) as unknown as typeof fetch
  assert.deepEqual(await startWebCheckout({ plan: 'pro_weekly', token: 't', fetchImpl: f(401, { error: 'sign_in_required' }) }), { status: 'sign_in' })
  const e = await startWebCheckout({ plan: 'pro_weekly', token: 't', fetchImpl: f(500, {}) })
  assert.equal(e.status, 'error')
  const bad = await startWebCheckout({ plan: 'pro_weekly', token: 't', fetchImpl: f(200, { url: 'https://evil.example/pay' }) })
  assert.equal(bad.status, 'error')
  const down = await startWebCheckout({ plan: 'pro_weekly', token: 't', fetchImpl: (async () => { throw new Error('offline') }) as unknown as typeof fetch })
  assert.equal(down.status, 'error')
})

// ---- /success: polling the entitlement ---------------------------------------------------------------------------------------

const entitlementBody = (over: Record<string, unknown> = {}) => ({
  tier: 'pro', active: true, web_pro_enabled: true,
  sources: [{ source: 'stripe', tier: 'pro', status: 'trialing', active: true, current_period_end: '2026-11-10T00:00:00.000Z' }], ...over,
})

test('parseEntitlement accepts the backend shape and rejects anything else', () => {
  const e = parseEntitlement(entitlementBody())
  assert.equal(e?.tier, 'pro')
  assert.equal(e?.stripeActive, true)
  assert.equal(parseEntitlement(entitlementBody({ sources: [{ source: 'revenuecat', tier: 'pro', status: 'active', active: true, current_period_end: null }] }))?.stripeActive, false)
  for (const bad of [null, 'x', {}, { tier: 'pro' }, { tier: 7, active: true, sources: [] }, { tier: 'pro', active: 'yes', sources: [] }]) assert.equal(parseEntitlement(bad), null)
})

test('fetchEntitlement never calls the API without a token (the API would not give a useful answer)', async () => {
  let called = 0
  const fetchImpl = (async () => { called++; return json(200, entitlementBody()) }) as unknown as typeof fetch
  assert.deepEqual(await fetchEntitlement({ apiUrl: 'https://api', token: '', fetchImpl }), { status: 'anonymous' })
  assert.equal(called, 0)
  const ok = await fetchEntitlement({ apiUrl: 'https://api', token: 't', fetchImpl })
  assert.equal(ok.status, 'ok')
  assert.deepEqual(await fetchEntitlement({ apiUrl: 'https://api', token: 't', fetchImpl: (async () => json(401, {})) as unknown as typeof fetch }), { status: 'unauthorized' })
  assert.equal((await fetchEntitlement({ apiUrl: 'https://api', token: 't', fetchImpl: (async () => json(200, { nope: 1 })) as unknown as typeof fetch })).status, 'error')
})

const noSleep = async () => {}

test('waitForEntitlement: reports active only after the backend shows an active Stripe entitlement', async () => {
  let n = 0
  const fetchImpl = (async () => json(200, ++n < 3 ? entitlementBody({ tier: 'free', active: false, sources: [] }) : entitlementBody())) as unknown as typeof fetch
  const r = await waitForEntitlement({ apiUrl: 'https://api', getToken: async () => 't', fetchImpl, sleep: noSleep, attempts: 10, intervalMs: 1, isCancelled: () => false })
  assert.equal(r, 'active')
  assert.equal(n, 3)
})

test('waitForEntitlement: never says active when it is not (free, or Pro from another source only)', async () => {
  const free = (async () => json(200, entitlementBody({ tier: 'free', active: false, sources: [] }))) as unknown as typeof fetch
  assert.equal(await waitForEntitlement({ apiUrl: 'x', getToken: async () => 't', fetchImpl: free, sleep: noSleep, attempts: 4, intervalMs: 1, isCancelled: () => false }), 'not_confirmed')
  const other = (async () => json(200, entitlementBody({ sources: [{ source: 'revenuecat', tier: 'pro', status: 'active', active: true, current_period_end: null }] }))) as unknown as typeof fetch
  assert.equal(await waitForEntitlement({ apiUrl: 'x', getToken: async () => 't', fetchImpl: other, sleep: noSleep, attempts: 3, intervalMs: 1, isCancelled: () => false }), 'not_confirmed')
})

test('waitForEntitlement: signed out, API errors, and cancellation', async () => {
  const opts = { apiUrl: 'x', sleep: noSleep, attempts: 3, intervalMs: 1 }
  assert.equal(await waitForEntitlement({ ...opts, getToken: async () => null, fetchImpl: (async () => json(200, {})) as unknown as typeof fetch, isCancelled: () => false }), 'signed_out')
  assert.equal(await waitForEntitlement({ ...opts, getToken: async () => 't', fetchImpl: (async () => json(401, {})) as unknown as typeof fetch, isCancelled: () => false }), 'signed_out')
  assert.equal(await waitForEntitlement({ ...opts, getToken: async () => 't', fetchImpl: (async () => json(500, {})) as unknown as typeof fetch, isCancelled: () => false }), 'error')
  let calls = 0
  const f = (async () => { calls++; return json(200, entitlementBody({ active: false, tier: 'free', sources: [] })) }) as unknown as typeof fetch
  assert.equal(await waitForEntitlement({ ...opts, getToken: async () => 't', fetchImpl: f, isCancelled: () => true }), 'cancelled')
  assert.equal(calls, 0)
})

test('only the verified state may say the plan is active', () => {
  for (const s of ['checking', 'not_confirmed', 'signed_out', 'error'] as const) {
    const c = entitlementCopy(s)
    assert.doesNotMatch(`${c.title} ${c.body}`, /\bis active\b|now active|activated|unlocked|successful/i, s)
  }
  assert.match(entitlementCopy('active').title, /active/i)
})

test('the active copy does not promise features this PR does not map to the plan', () => {
  const c = entitlementCopy('active')
  assert.doesNotMatch(`${c.title} ${c.body}`, /voice clon|unlimited|HD|PDF|no ads|Android app (will|now) (unlock|show)/i)
})

// ---- wiring ---------------------------------------------------------------------------------------------------------------

test('the checkout route requires a verified user before it can reach Stripe, and answers JSON for the browser', () => {
  const src = read('../src/app/api/checkout/route.ts')
  const start = src.indexOf('async function startCheckout')
  const gate = src.indexOf('checkoutAccess(', start)
  const verify = src.indexOf('verifySupabaseUser(', start)
  const create = src.indexOf('getOrCreateCheckoutSession(', start)
  assert.ok(gate > start && verify > gate && create > verify, 'order must be: flag gate, verify user, create session')
  assert.match(src, /sign_in_required/)
  assert.match(src, /user:/)
})

test('legacy GET links can never start a signed-in checkout (a navigation carries no bearer token)', () => {
  const src = read('../src/app/api/checkout/route.ts')
  const getFn = src.slice(src.indexOf('export async function GET'))
  assert.doesNotMatch(getFn, /startCheckout\(/)
})

test('the web webhook stub is not mistaken for the entitlement handler', () => {
  const src = read('../src/app/api/webhook/route.ts')
  assert.match(src, /NOT the ReadAloud entitlement handler/)
})

test('Pricing renders the checkout button only when the flag is on, and that button reuses startWebCheckout', () => {
  const pricing = read('../src/components/Pricing.tsx')
  assert.match(pricing, /ProCheckoutButton/)
  const button = read('../src/components/ProCheckoutButton.tsx')
  assert.match(button, /startWebCheckout\(/)
  assert.match(button, /Sign in to continue/)
})

test('the success page polls the entitlement when the flag is on and keeps the honest static copy when it is off', () => {
  const src = read('../src/app/success/page.tsx')
  assert.match(src, /waitForEntitlement\(/)
  assert.match(src, /entitlementCopy\(/)
  assert.match(src, /successCopy\(/)
})
