import { test } from 'node:test'
import assert from 'node:assert/strict'

const { fetchUsage, parseUsage, CHARS_PER_MINUTE } = await import('../src/lib/usageApi.ts')

const API = 'https://api.example'
const good = { current_month: '2026-11', char_used: 30000, char_limit: 135000 }

function mockFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = []
  const fn = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return respond(url, init) }) as unknown as typeof fetch
  return { fn, calls }
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

test('anonymous visitors never trigger a request (the API would answer with a shared account)', async () => {
  for (const token of [null, undefined, '', '   ']) {
    const m = mockFetch(() => json(200, good))
    assert.deepEqual(await fetchUsage({ apiUrl: API, token, fetchImpl: m.fn }), { status: 'anonymous' })
    assert.equal(m.calls.length, 0)
  }
})

test('a signed-in user gets their usage from GET /api/usage with a bearer token', async () => {
  const m = mockFetch(() => json(200, good))
  const r = await fetchUsage({ apiUrl: API, token: 'jwt-abc', fetchImpl: m.fn })
  assert.equal(m.calls.length, 1)
  assert.equal(m.calls[0]!.url, `${API}/api/usage`)
  assert.equal(m.calls[0]!.init.method, 'GET')
  assert.deepEqual(m.calls[0]!.init.headers, { Authorization: 'Bearer jwt-abc' })
  assert.deepEqual(r, {
    status: 'ok',
    usage: { month: '2026-11', used: 30000, limit: 135000, remaining: 105000, percent: 22, minutesRemaining: 140 },
  })
})

test('401 and 403 are reported as unauthorized (expired or rejected session)', async () => {
  for (const status of [401, 403]) {
    const r = await fetchUsage({ apiUrl: API, token: 't', fetchImpl: mockFetch(() => json(status, { error: 'nope' })).fn })
    assert.deepEqual(r, { status: 'unauthorized' })
  }
})

test('429, 5xx, network failure and bad payloads give a readable error and never throw', async () => {
  const cases: [string, () => Response | Promise<Response>, RegExp][] = [
    ['429', () => json(429, {}), /Too many requests/],
    ['500', () => json(500, { error: 'boom' }), /unavailable/],
    ['503', () => json(503, {}), /unavailable/],
    ['not json', () => new Response('<html>', { status: 200 }), /unavailable/],
    ['wrong shape', () => json(200, { used: 1 }), /unavailable/],
    ['network', () => { throw new TypeError('fetch failed') }, /Could not reach/],
  ]
  for (const [name, respond, re] of cases) {
    const r = await fetchUsage({ apiUrl: API, token: 't', fetchImpl: mockFetch(respond).fn })
    assert.equal(r.status, 'error', name)
    assert.match((r as { message: string }).message, re, name)
  }
})

test('an aborted request rethrows the AbortError so the caller can ignore it', async () => {
  const m = mockFetch(() => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }) })
  await assert.rejects(() => fetchUsage({ apiUrl: API, token: 't', fetchImpl: m.fn }), { name: 'AbortError' })
})

test('parseUsage handles edges: over limit, zero limit, strings, negatives, bad month', () => {
  assert.equal(parseUsage({ current_month: '2026-11', char_used: 200, char_limit: 100 })!.percent, 100)
  assert.equal(parseUsage({ current_month: '2026-11', char_used: 200, char_limit: 100 })!.remaining, 0)
  assert.equal(parseUsage({ current_month: '2026-11', char_used: 0, char_limit: 0 })!.percent, 100)
  assert.equal(parseUsage({ current_month: '2026-11', char_used: 0, char_limit: 135000 })!.percent, 0)
  assert.equal(parseUsage({ current_month: '2026-11', char_used: 1, char_limit: 1500 })!.minutesRemaining, 1)
  for (const bad of [null, 'x', 5, {}, { current_month: '2026-11', char_used: '1', char_limit: 2 }, { current_month: '2026-11', char_used: -1, char_limit: 2 },
    { current_month: 'November', char_used: 1, char_limit: 2 }, { current_month: '2026-11', char_used: NaN, char_limit: 2 }]) {
    assert.equal(parseUsage(bad), null, JSON.stringify(bad))
  }
  assert.equal(CHARS_PER_MINUTE, 750)
})
