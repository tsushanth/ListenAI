import { test } from 'node:test'
import assert from 'node:assert/strict'

const { createGaugemintReader, gaugemintReadConfig, monthlySeries, GAUGEMINT_CACHE_MS, GAUGEMINT_TIMEOUT_MS } = await import('../src/lib/gaugemintRead.ts')
const { fmtDuration, isGaugemintResult, parseGaugemintPeriod } = await import('../src/lib/gaugemintTypes.ts')

const KEY = 'pr_FAKE_READ_KEY_FOR_TESTS'
const ENV = { GAUGEMINT_URL: 'https://guagemint.example', GAUGEMINT_DOMAIN: 'readaloudai.org', GAUGEMINT_READ_KEY: KEY }

type Call = { url: URL; headers: Record<string, string> }
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

/** A Gaugemint that answers the five stats calls with a small fixed dataset. Override one path with `respond`. */
function fakeGaugemint(opts: { respond?: (u: URL) => Response | Promise<Response> | undefined } = {}) {
  const calls: Call[] = []
  const f = (async (input: any, init: any) => {
    const url = new URL(String(input))
    calls.push({ url, headers: init?.headers ?? {} })
    const custom = opts.respond?.(url)
    if (custom) return custom
    const p = url.pathname
    if (p === '/api/v1/stats/aggregate') {
      return json({ results: { visitors: { value: 120 }, pageviews: { value: 340 }, visits: { value: 150 }, bounce_rate: { value: 61 }, visit_duration: { value: 95 } } })
    }
    if (p === '/api/v1/stats/timeseries') {
      return json({ results: [{ date: '2026-11-19', visitors: 10, pageviews: 20 }, { date: '2026-11-20', visitors: 30, pageviews: 50 }] })
    }
    if (p === '/api/v1/stats/breakdown') {
      const prop = url.searchParams.get('property')
      if (prop === 'event:page') return json({ results: [{ page: '/', visitors: 80, pageviews: 100 }, { page: '/pricing', visitors: 20, pageviews: 25 }] })
      if (prop === 'visit:source') return json({ results: [{ source: '', visitors: 50 }, { source: 'Google', visitors: 70 }] })
      if (prop === 'visit:country') return json({ results: [{ country: 'US', visitors: 90 }, { country: '', visitors: 4 }] })
      if (prop === 'visit:device') return json({ results: [{ device: 'Desktop', visitors: 100 }, { device: 'Mobile', visitors: 20 }] })
    }
    return json({ error: 'not found' }, 404)
  }) as unknown as typeof fetch
  return { f, calls }
}

function reader(over: Record<string, unknown> = {}) {
  const g = fakeGaugemint(over as any)
  let t = 1_000_000
  const clock = { advance: (ms: number) => { t += ms } }
  const get = createGaugemintReader({ env: ENV, fetchImpl: g.f, now: () => t, timeoutMs: 50, ...over })
  return { get, calls: g.calls, clock }
}

// ---------- config ----------

test('config: default url and domain come from the sender config; the key is trimmed', () => {
  const c = gaugemintReadConfig({ GAUGEMINT_READ_KEY: ` ${KEY} ` })
  assert.deepEqual(c, { url: 'https://guagemint.com', domain: 'readaloudai.org', key: KEY })
  assert.equal(gaugemintReadConfig({ ...ENV, GAUGEMINT_DOMAIN: 'x.test', GAUGEMINT_URL: 'http://localhost:3000/' }).url, 'http://localhost:3000')
})

test('config: no key, a pa_ full-access key, any other prefix, and a non-https address are all not_configured (never used)', async () => {
  const bad: Array<Record<string, string>> = [
    {},
    { GAUGEMINT_READ_KEY: '   ' },
    { GAUGEMINT_READ_KEY: 'pa_FAKE_FULL_ACCESS_KEY' },
    { GAUGEMINT_READ_KEY: 'sk_FAKE_OTHER_KEY' },
    { GAUGEMINT_READ_KEY: KEY, GAUGEMINT_URL: 'http://guagemint.example' },
  ]
  for (const env of bad) {
    const g = fakeGaugemint()
    const r = await createGaugemintReader({ env, fetchImpl: g.f })('30d')
    assert.equal(r.ok, false)
    assert.equal((r as any).error.kind, 'not_configured')
    assert.equal(g.calls.length, 0, 'nothing is sent with an unusable key')
    assert.doesNotMatch(JSON.stringify(r), /pa_FAKE|sk_FAKE|pr_FAKE/)
  }
})

test('the sender token is never used as a read key', async () => {
  const g = fakeGaugemint()
  const r = await createGaugemintReader({ env: { GAUGEMINT_SENDER_TOKEN: 'pr_FAKE_SENDER' }, fetchImpl: g.f })('30d')
  assert.equal((r as any).error.kind, 'not_configured')
  assert.equal(g.calls.length, 0)
})

// ---------- happy path ----------

test('reads aggregate, timeseries and four breakdowns with the bearer key and the server-fixed domain', async () => {
  const { get, calls } = reader()
  const r = await get('7d')
  assert.equal(r.ok, true)
  assert.equal(calls.length, 6)
  for (const c of calls) {
    assert.equal(c.url.origin, 'https://guagemint.example')
    assert.equal(c.headers.Authorization, `Bearer ${KEY}`)
    assert.equal(c.url.searchParams.get('site_id'), 'readaloudai.org')
    assert.equal(c.url.searchParams.get('period'), '7d')
    assert.doesNotMatch(c.url.toString(), /pr_FAKE/, 'the key travels in the header only')
  }
  const props = calls.filter((c) => c.url.pathname.endsWith('/breakdown')).map((c) => c.url.searchParams.get('property')).sort()
  assert.deepEqual(props, ['event:page', 'visit:country', 'visit:device', 'visit:source'])
  const agg = calls.find((c) => c.url.pathname.endsWith('/aggregate'))!
  assert.equal(agg.url.searchParams.get('metrics'), 'visitors,pageviews,visits,bounce_rate,visit_duration')
})

test('maps the answers: totals, daily series, top pages, sources, countries, devices (empty names get a label, rows sorted)', async () => {
  const { get } = reader()
  const r: any = await get('30d')
  assert.equal(r.ok, true)
  assert.deepEqual(r.stats.totals, { visitors: 120, pageviews: 340, visits: 150, bounce_rate: 61, visit_duration: 95 })
  assert.equal(r.stats.site, 'readaloudai.org')
  assert.equal(r.stats.granularity, 'day')
  assert.deepEqual(r.stats.series, [{ day: '2026-11-19', visitors: 10, pageviews: 20 }, { day: '2026-11-20', visitors: 30, pageviews: 50 }])
  assert.deepEqual(r.stats.pages, [{ name: '/', visitors: 80, pageviews: 100 }, { name: '/pricing', visitors: 20, pageviews: 25 }])
  assert.deepEqual(r.stats.sources, [{ name: 'Google', visitors: 70 }, { name: 'Direct / None', visitors: 50 }])
  assert.deepEqual(r.stats.countries, [{ name: 'US', visitors: 90 }, { name: 'Unknown', visitors: 4 }])
  assert.deepEqual(r.stats.devices, [{ name: 'Desktop', visitors: 100 }, { name: 'Mobile', visitors: 20 }])
  assert.equal(isGaugemintResult(JSON.parse(JSON.stringify(r))), true)
  assert.doesNotMatch(JSON.stringify(r), /pr_FAKE/)
})

test('only the top 8 rows of a breakdown are kept; junk numbers become 0', async () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ page: `/p${i}`, visitors: i, pageviews: 'x' }))
  const { get } = reader({ respond: (u: URL) => (u.searchParams.get('property') === 'event:page' ? json({ results: many }) : undefined) })
  const r: any = await get('30d')
  assert.equal(r.stats.pages.length, 8)
  assert.equal(r.stats.pages[0].name, '/p11')
  assert.equal(r.stats.pages[0].pageviews, 0)
})

test('12mo: daily rows become one bar per month', async () => {
  const days = [
    { date: '2026-10-30', visitors: 1, pageviews: 2 }, { date: '2026-10-31', visitors: 2, pageviews: 3 },
    { date: '2026-11-01', visitors: 4, pageviews: 5 },
  ]
  const { get, calls } = reader({ respond: (u: URL) => (u.pathname.endsWith('/timeseries') ? json({ results: days }) : undefined) })
  const r: any = await get('12mo')
  assert.equal(calls[0].url.searchParams.get('period'), '12mo')
  assert.equal(r.stats.granularity, 'month')
  assert.deepEqual(r.stats.series, [{ day: '2026-10', visitors: 3, pageviews: 5 }, { day: '2026-11', visitors: 4, pageviews: 5 }])
  assert.deepEqual(monthlySeries([]), [])
})

test('an unknown period falls back to 30d (the period is never forwarded as is)', async () => {
  const { get, calls } = reader()
  await get('../../x' as any)
  assert.equal(calls[0].url.searchParams.get('period'), '30d')
  assert.equal(parseGaugemintPeriod('12mo'), '12mo')
  assert.equal(parseGaugemintPeriod('90d'), '30d')
  assert.equal(parseGaugemintPeriod(null), '30d')
})

// ---------- typed errors ----------

test('HTTP statuses map to typed errors, none containing the key or the upstream body', async () => {
  const cases: Array<[number, string, Record<string, string>?]> = [
    [401, 'unauthorized'], [403, 'unauthorized'], [404, 'not_found'], [429, 'rate_limited', { 'retry-after': '17' }], [500, 'bad_response'], [502, 'bad_response'],
  ]
  for (const [status, kind, headers] of cases) {
    const { get } = reader({ respond: (u: URL) => (u.pathname.endsWith('/aggregate') ? json({ error: `secret upstream text ${KEY}` }, status, headers) : undefined) })
    const r: any = await get('30d')
    assert.equal(r.ok, false, String(status))
    assert.equal(r.error.kind, kind, String(status))
    assert.doesNotMatch(JSON.stringify(r), /pr_FAKE|secret upstream text/, String(status))
    if (status === 429) assert.equal(r.error.retryAfter, 17)
  }
})

test('429 without Retry-After defaults to 60 s', async () => {
  const { get } = reader({ respond: () => json({}, 429) })
  assert.equal(((await get('30d')) as any).error.retryAfter, 60)
})

test('a network error is unreachable', async () => {
  const f = (async () => { throw new Error(`ECONNREFUSED 10.0.0.1 ${KEY}`) }) as unknown as typeof fetch
  const r: any = await createGaugemintReader({ env: ENV, fetchImpl: f })('30d')
  assert.equal(r.error.kind, 'unreachable')
  assert.doesNotMatch(JSON.stringify(r), /10\.0\.0\.1|pr_FAKE/)
})

test('a hung Gaugemint times out (the request carries an abort signal) and is unreachable', async () => {
  let signalSeen = false
  const f = ((_u: any, init: any) => new Promise((_res, rej) => {
    signalSeen = !!init.signal
    init.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'TimeoutError')))
  })) as unknown as typeof fetch
  const t0 = Date.now()
  const r: any = await createGaugemintReader({ env: ENV, fetchImpl: f, timeoutMs: 30 })('30d')
  assert.equal(signalSeen, true)
  assert.equal(r.error.kind, 'unreachable')
  assert.ok(Date.now() - t0 < 2000)
})

test('the default timeout is 5 s and the cache is 60 s', () => {
  assert.equal(GAUGEMINT_TIMEOUT_MS, 5000)
  assert.equal(GAUGEMINT_CACHE_MS, 60000)
})

test('non-JSON and unexpected shapes are bad_response', async () => {
  const notJson = reader({ respond: () => new Response('<html>oops</html>', { status: 200 }) })
  assert.equal(((await notJson.get('30d')) as any).error.kind, 'bad_response')
  const wrong = reader({ respond: (u: URL) => (u.pathname.endsWith('/aggregate') ? json({ results: null }) : undefined) })
  assert.equal(((await wrong.get('30d')) as any).error.kind, 'bad_response')
  const noSeries = reader({ respond: (u: URL) => (u.pathname.endsWith('/timeseries') ? json({ nope: 1 }) : undefined) })
  assert.equal(((await noSeries.get('30d')) as any).error.kind, 'bad_response')
})

test('it never throws, even when the fetch implementation does something odd', async () => {
  const f = (() => { throw new TypeError('sync throw') }) as unknown as typeof fetch
  const r: any = await createGaugemintReader({ env: ENV, fetchImpl: f })('30d')
  assert.equal(r.ok, false)
})

// ---------- cache ----------

test('cache: a second call within 60 s makes no upstream request, after 60 s it does', async () => {
  const { get, calls, clock } = reader()
  const a: any = await get('30d')
  assert.equal(calls.length, 6)
  clock.advance(59_000)
  const b: any = await get('30d')
  assert.equal(calls.length, 6)
  assert.equal(b.fetchedAt, a.fetchedAt)
  clock.advance(1_001)
  await get('30d')
  assert.equal(calls.length, 12)
})

test('cache is per period', async () => {
  const { get, calls } = reader()
  await get('7d'); await get('30d'); await get('7d')
  assert.equal(calls.length, 12)
})

test('errors are not cached: the next call asks again', async () => {
  let fail = true
  const g = fakeGaugemint({ respond: () => (fail ? json({}, 500) : undefined) })
  const get = createGaugemintReader({ env: ENV, fetchImpl: g.f })
  assert.equal(((await get('30d')) as any).ok, false)
  fail = false
  assert.equal(((await get('30d')) as any).ok, true)
})

test('concurrent calls for one period share one upstream round', async () => {
  const { get, calls } = reader()
  const rs = await Promise.all([get('30d'), get('30d'), get('30d')])
  assert.equal(calls.length, 6)
  assert.ok(rs.every((r: any) => r.ok))
})

test('a removed key is noticed at once, not after the cache expires', async () => {
  const env: Record<string, string> = { ...ENV }
  const g = fakeGaugemint()
  const get = createGaugemintReader({ env, fetchImpl: g.f })
  assert.equal(((await get('30d')) as any).ok, true)
  delete env.GAUGEMINT_READ_KEY
  assert.equal(((await get('30d')) as any).error.kind, 'not_configured')
})

// ---------- small helpers ----------

test('fmtDuration', () => {
  assert.equal(fmtDuration(0), '0:00')
  assert.equal(fmtDuration(95), '1:35')
  assert.equal(fmtDuration(3725), '1:02:05')
  assert.equal(fmtDuration(NaN), '0:00')
})

test('isGaugemintResult rejects junk', () => {
  assert.equal(isGaugemintResult(null), false)
  assert.equal(isGaugemintResult({ ok: true }), false)
  assert.equal(isGaugemintResult({ ok: false, error: { kind: 'not_configured', message: 'x' } }), true)
  assert.equal(isGaugemintResult({ ok: false, error: {} }), false)
})
