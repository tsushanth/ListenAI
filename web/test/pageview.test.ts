import { test } from 'node:test'
import assert from 'node:assert/strict'

const { shouldTrack, referrerHost, visitorId, toPostHog } = await import('../src/lib/pageview.ts')
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
const base = { method: 'GET', pathname: '/developers', accept: 'text/html,application/xhtml+xml', userAgent: CHROME }

test('tracks a human page load', () => assert.equal(shouldTrack(base), true))

test('ignores non-GET, non-HTML, assets, API and prefetches', () => {
  assert.equal(shouldTrack({ ...base, method: 'POST' }), false)
  assert.equal(shouldTrack({ ...base, accept: 'application/json' }), false)
  assert.equal(shouldTrack({ ...base, pathname: '/_next/static/chunks/a.js' }), false)
  assert.equal(shouldTrack({ ...base, pathname: '/samples/sample_0.wav' }), false)
  assert.equal(shouldTrack({ ...base, pathname: '/api/demo-token' }), false)
  assert.equal(shouldTrack({ ...base, purpose: 'prefetch' }), false)
})

test('ignores bots, health checks and empty user agents', () => {
  for (const ua of ['Googlebot/2.1', 'Mozilla/5.0 (compatible; AhrefsBot/7.0)', 'curl/8.4', 'Fly.io health check/1.0 healthcheck', 'UptimeRobot/2.0', 'HeadlessChrome/120', null, '']) {
    assert.equal(shouldTrack({ ...base, userAgent: ua as never }), false, String(ua))
  }
})

test('keeps only the referring host, never its path or query, and drops our own host', () => {
  assert.equal(referrerHost('https://www.google.com/search?q=secret', 'readaloudai.org'), 'google.com')
  assert.equal(referrerHost('https://readaloudai.org/developers', 'readaloudai.org'), null)
  assert.equal(referrerHost('not a url', 'readaloudai.org'), null)
  assert.equal(referrerHost(null, 'readaloudai.org'), null)
})

test('visitor id is stable within a day and changes across days, IPs and browsers', async () => {
  const d = async (s: string) => (await import('node:crypto')).createHash('sha256').update(s).digest('hex')
  const a = await visitorId('1.2.3.4', CHROME, '2026-10-06', d)
  assert.equal(a, await visitorId('1.2.3.4', CHROME, '2026-10-06', d))
  assert.notEqual(a, await visitorId('1.2.3.4', CHROME, '2026-10-07', d))
  assert.notEqual(a, await visitorId('1.2.3.5', CHROME, '2026-10-06', d))
  assert.equal(a.length, 16)
})

test('PostHog payload carries no person profile and no raw cookie-like identifiers', () => {
  const p = toPostHog({ distinctId: 'abc', url: 'https://readaloudai.org/pricing', pathname: '/pricing', referrer: null, ua: 'x' }, 'phc_k', '9.9.9.9')
  assert.equal(p.event, '$pageview')
  assert.equal(p.properties.$process_person_profile, false)
  assert.equal(p.properties.$referrer, '$direct')
  assert.equal(p.distinct_id, 'ra-pv-abc')
})
