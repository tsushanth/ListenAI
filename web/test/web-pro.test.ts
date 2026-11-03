import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const { WEB_PRO_CHECKOUT_ENABLED, PLAY_STORE_URL, proCta, checkoutAccess, successCopy } = await import('../src/lib/webPro.ts')

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

test('web Pro checkout ships switched off', () => {
  assert.equal(WEB_PRO_CHECKOUT_ENABLED, false)
})

test('the Play link is the real applicationId from the Android build', () => {
  const gradle = read('../../android/app/build.gradle.kts')
  const id = /applicationId = "([^"]+)"/.exec(gradle)?.[1]
  assert.equal(id, 'com.listenai')
  assert.equal(PLAY_STORE_URL, `https://play.google.com/store/apps/details?id=${id}`)
})

test('while checkout is off, the Pro CTA is a Play link and never a checkout', () => {
  const cta = proCta('pro_weekly', false)
  assert.equal(cta.kind, 'android')
  assert.equal(cta.href, PLAY_STORE_URL)
  assert.match(cta.label, /android/i)
  assert.doesNotMatch(cta.label, /trial|checkout|subscribe now/i)
})

test('when checkout is on, the CTA is a checkout for that plan', () => {
  assert.deepEqual(proCta('pro_yearly', true), { kind: 'checkout', plan: 'pro_yearly', label: 'Start Free Trial' })
})

test('the checkout endpoint refuses to create a session while the flag is off, for POST and GET alike', () => {
  assert.equal(checkoutAccess(false), 'redirect_to_pricing')
  assert.equal(checkoutAccess(true), 'allowed')
})

test('the checkout route consults the gate before it touches Stripe', () => {
  const src = read('../src/app/api/checkout/route.ts')
  const start = src.indexOf('async function startCheckout')
  const gate = src.indexOf('checkoutAccess(', start)
  const stripeUse = src.indexOf('getOrCreateCheckoutSession(', start)
  assert.ok(start > 0 && gate > start, 'startCheckout must call checkoutAccess')
  assert.ok(gate < stripeUse, 'the gate must run before any Stripe session is created')
})

test('/success never claims activation without a verified entitlement', () => {
  for (const enabled of [false, true]) {
    const c = successCopy(enabled)
    const text = `${c.title} ${c.body}`
    assert.doesNotMatch(text, /is now active|now active|activated|unlocked|Payment Successful/i, `enabled=${enabled}`)
  }
  const off = successCopy(false)
  assert.equal(off.showPlayLink, true)
  assert.match(off.body, /support@readaloudai\.org/)
})

test('the success page source no longer hardcodes the activation claim or the unlock steps', () => {
  const src = read('../src/app/success/page.tsx')
  assert.doesNotMatch(src, /now active/i)
  assert.doesNotMatch(src, /automatically unlocked/i)
  assert.doesNotMatch(src, /Payment Successful/)
})

test('the Pricing component builds its Pro buttons from proCta; checkout can only start from the checkout branch', () => {
  const src = read('../src/components/Pricing.tsx')
  assert.match(src, /proCta\(/)
  // no raw (anonymous) form post to the checkout route any more: the only way in is the signed-in button
  assert.doesNotMatch(src, /action="\/api\/checkout"/)
  const branchAt = src.indexOf("cta.kind === 'checkout'")
  const buttonAt = src.indexOf('<ProCheckoutButton')
  assert.ok(branchAt > 0 && buttonAt > branchAt, 'ProCheckoutButton must sit inside the checkout branch')
})

test('the pricing section does not promise a trial or money-back guarantee that only checkout could honour', () => {
  const src = read('../src/components/Pricing.tsx')
  assert.doesNotMatch(src, /30-day money-back/i)
  const faq = read('../src/components/FAQ.tsx')
  assert.doesNotMatch(faq, /PRO subscriptions include a 7-day free trial/)
})
