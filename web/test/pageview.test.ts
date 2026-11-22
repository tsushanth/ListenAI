import { test } from 'node:test'
import assert from 'node:assert/strict'

const { shouldTrack, referrerHost, isBotUserAgent } = await import('../src/lib/pageview.ts')
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

test('isBotUserAgent agrees with shouldTrack and treats short or missing agents as bots', () => {
  assert.equal(isBotUserAgent(CHROME), false)
  assert.equal(isBotUserAgent('Googlebot/2.1'), true)
  assert.equal(isBotUserAgent('x'), true)
  assert.equal(isBotUserAgent(null), true)
  assert.equal(isBotUserAgent(undefined), true)
})

test('the page-view code no longer carries a daily visitor hash or any third-party payload', async () => {
  const mod = await import('../src/lib/pageview.ts')
  assert.equal('visitorId' in mod, false)
  assert.equal('toPostHog' in mod, false)
})
