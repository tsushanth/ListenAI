import { test } from 'node:test'
import assert from 'node:assert/strict'

const { sendGaugemint, gaugemintConfig, optedOut, clientIp } = await import('../src/lib/gaugemint.ts')
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
const h = (o: Record<string, string>) => ({ get: (k: string) => o[k.toLowerCase()] ?? null })

function mockFetch(status = 202) {
  const calls: { url: string; init: any }[] = []
  const f = (async (url: string, init: any) => { calls.push({ url, init }); return { status } }) as unknown as typeof fetch
  return { f, calls }
}
const cfg = { url: 'https://guagemint.example', domain: 'readaloudai.org', disabled: false }

test('config defaults, overrides, trailing slash and kill switch', () => {
  assert.deepEqual(gaugemintConfig({}), { url: 'https://guagemint.com', domain: 'readaloudai.org', disabled: false })
  assert.deepEqual(gaugemintConfig({ GAUGEMINT_URL: 'http://127.0.0.1:9/', GAUGEMINT_DOMAIN: 'x.test' }), { url: 'http://127.0.0.1:9', domain: 'x.test', disabled: false })
  assert.equal(gaugemintConfig({ ANALYTICS_DISABLED: '1' }).disabled, true)
  assert.equal(gaugemintConfig({ ANALYTICS_DISABLED: '0' }).disabled, false)
  assert.equal(gaugemintConfig({ ANALYTICS_DISABLED: '' }).disabled, false)
})

test('posts one pageview to /api/event with domain, name, url and referrer', async () => {
  const { f, calls } = mockFetch()
  const ok = await sendGaugemint({ name: 'pageview', pathname: '/pricing', referrerHost: 'google.com', ip: '203.0.113.7', userAgent: CHROME }, cfg, f)
  assert.equal(ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://guagemint.example/api/event')
  assert.equal(calls[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].init.body), { domain: 'readaloudai.org', name: 'pageview', url: 'https://readaloudai.org/pricing', referrer: 'https://google.com/' })
})

test('forwards the visitor address in X-Forwarded-For and the browser user-agent', async () => {
  const { f, calls } = mockFetch()
  await sendGaugemint({ name: 'pageview', pathname: '/', ip: '203.0.113.7', userAgent: CHROME }, cfg, f)
  assert.equal(calls[0].init.headers['X-Forwarded-For'], '203.0.113.7')
  assert.equal(calls[0].init.headers['User-Agent'], CHROME)
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json')
})

test('never sends a query string or fragment, and no referrer field when there is none', async () => {
  const { f, calls } = mockFetch()
  await sendGaugemint({ name: 'pageview', pathname: '/read?text=secret&utm_source=x#frag', ip: null, userAgent: CHROME }, cfg, f)
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.url, 'https://readaloudai.org/read')
  assert.ok(!calls[0].init.body.includes('secret'))
  assert.ok(!('referrer' in body))
  assert.ok(!('X-Forwarded-For' in calls[0].init.headers))
})

test('custom events carry flat props, with nulls left out', async () => {
  const { f, calls } = mockFetch()
  await sendGaugemint({ name: 'demo_done', pathname: '/', props: { preset: 2, custom_text: false, chars: 80, first_audio_ms: 640, audio_ms: null, reason: undefined }, ip: '203.0.113.7', userAgent: CHROME }, cfg, f)
  assert.deepEqual(JSON.parse(calls[0].init.body).props, { preset: 2, custom_text: false, chars: 80, first_audio_ms: 640 })
})

test('kill switch sends nothing', async () => {
  const { f, calls } = mockFetch()
  assert.equal(await sendGaugemint({ name: 'pageview', pathname: '/', ip: '1.2.3.4', userAgent: CHROME }, { ...cfg, disabled: true }, f), false)
  assert.equal(calls.length, 0)
})

test('Do Not Track and Global Privacy Control are detected', () => {
  assert.equal(optedOut(h({ dnt: '1' })), true)
  assert.equal(optedOut(h({ 'sec-gpc': '1' })), true)
  assert.equal(optedOut(h({ dnt: '1', 'sec-gpc': '1' })), true)
  assert.equal(optedOut(h({ dnt: '0' })), false)
  assert.equal(optedOut(h({})), false)
})

test('client address: Fly header first, then first X-Forwarded-For entry', () => {
  assert.equal(clientIp(h({ 'fly-client-ip': '198.51.100.4', 'x-forwarded-for': '6.6.6.6' })), '198.51.100.4')
  assert.equal(clientIp(h({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' })), '203.0.113.7')
  assert.equal(clientIp(h({})), null)
})

test('failures are swallowed: network error, timeout, 5xx and a bad response', async () => {
  const boom = (async () => { throw new Error('network down') }) as unknown as typeof fetch
  assert.equal(await sendGaugemint({ name: 'pageview', pathname: '/', ip: '1.2.3.4', userAgent: CHROME }, cfg, boom), false)
  const abort = (async () => { throw new DOMException('timeout', 'TimeoutError') }) as unknown as typeof fetch
  assert.equal(await sendGaugemint({ name: 'pageview', pathname: '/', ip: '1.2.3.4', userAgent: CHROME }, cfg, abort), false)
  assert.equal(await sendGaugemint({ name: 'pageview', pathname: '/', ip: '1.2.3.4', userAgent: CHROME }, cfg, mockFetch(503).f), false)
  const weird = (async () => undefined) as unknown as typeof fetch
  assert.equal(await sendGaugemint({ name: 'pageview', pathname: '/', ip: '1.2.3.4', userAgent: CHROME }, cfg, weird), false)
})

test('a request signal is attached so a slow analytics server cannot hang the caller', async () => {
  const { f, calls } = mockFetch()
  await sendGaugemint({ name: 'pageview', pathname: '/', ip: '1.2.3.4', userAgent: CHROME }, cfg, f)
  assert.ok(calls[0].init.signal)
})
