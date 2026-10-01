// node --test: the deployments client and the view logic behind the deploy panel.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createDeploymentsClient, DeploymentError, isLive, isReady, SERVICE_PATHS, type Deployment } from '../src/lib/deploymentsApi.ts'
import { endedNote, formatRemaining, secondsUntilTeardown, viewOf } from '../src/lib/deploymentView.ts'

const dep = (over: Partial<Deployment> = {}): Deployment => ({
  id: 'd1', service: 'convert', status: 'ready', app_name: 'a', modal_url: 'https://x', error: null, job_count: 0,
  created_at: '2026-10-01T00:00:00Z', ready_at: '2026-10-01T00:00:10Z', last_used_at: '2026-10-01T00:00:10Z',
  expires_at: '2026-10-01T04:00:10Z', stop_reason: null, auto_teardown_at: '2026-10-01T00:30:10Z', seconds_until_auto_teardown: 1800,
  ...over,
})

function client(handler: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; method: string; auth: string }> = []
  const c = createDeploymentsClient(
    async () => ({ Authorization: 'Bearer tok' }),
    (async (url: string, init: RequestInit = {}) => {
      calls.push({ url, method: init.method ?? 'GET', auth: String((init.headers as Record<string, string>)?.Authorization) })
      return handler(url, init)
    }) as unknown as typeof fetch,
    'https://api.test',
  )
  return { c, calls }
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

test('each tool uses its own path, with the user\'s token', async () => {
  const { c, calls } = client(() => json(dep()))
  for (const svc of Object.keys(SERVICE_PATHS) as Array<keyof typeof SERVICE_PATHS>) await c.get(svc)
  assert.deepEqual(calls.map((x) => x.url), [
    'https://api.test/api/voice-convert/deploy', 'https://api.test/api/voice-isolate/deploy', 'https://api.test/api/sound-effects/deploy',
    'https://api.test/api/music/deploy', 'https://api.test/api/dub/deploy',
  ])
  assert.ok(calls.every((x) => x.auth === 'Bearer tok'))
})

test('get: 404 means "never deployed"; other failures throw with the server\'s message and code', async () => {
  assert.equal(await client(() => json({ error: 'No deployment found.' }, 404)).c.get('dub'), null)
  await assert.rejects(
    () => client(() => json({ error: 'Deployments are temporarily disabled.', code: 'deployments_disabled' }, 503)).c.get('dub'),
    (e: DeploymentError) => e.status === 503 && e.code === 'deployments_disabled' && /temporarily disabled/.test(e.message),
  )
})

test('deploy: 202 returns the deployment; 409 (already has one) returns that one instead of an error', async () => {
  const started = await client(() => json(dep({ status: 'requested' }), 202)).c.deploy('convert')
  assert.equal(started.status, 'requested')
  const existing = await client(() => json({ error: 'You already have an active deployment.', deployment: dep() }, 409)).c.deploy('convert')
  assert.equal(existing.status, 'ready')
})

test('deploy: a refusal carries a readable message and lets the page branch on payment', async () => {
  const pay = await client(() => json({ error: 'Add a payment method to deploy.', code: 'payment_required' }, 402)).c.deploy('music').catch((e) => e as DeploymentError)
  assert.ok(pay instanceof DeploymentError)
  assert.equal((pay as DeploymentError).paymentRequired, true)
  assert.match((pay as DeploymentError).message, /payment method/)
  const cap = await client(() => json({ error: 'Daily deployment limit reached.', code: 'daily_cap' }, 429)).c.deploy('music').catch((e) => e as DeploymentError)
  assert.equal((cap as DeploymentError).paymentRequired, false)
})

test('an error body that is not JSON still produces a usable message', async () => {
  const e = await client(() => new Response('upstream exploded', { status: 502 })).c.deploy('dub').catch((x) => x as DeploymentError)
  assert.match((e as DeploymentError).message, /HTTP 502/)
})

test('teardown calls DELETE and returns the result', async () => {
  const { c, calls } = client(() => json({ deleted: true, status: 'stopped', message: 'done' }))
  const r = await c.teardown('isolate')
  assert.equal(r.deleted, true)
  assert.equal(calls[0].method, 'DELETE')
})

test('isReady / isLive', () => {
  assert.equal(isReady(dep()), true)
  assert.equal(isReady(dep({ status: 'deploying' })), false)
  assert.equal(isLive(dep({ status: 'deploying' })), true)
  assert.equal(isLive(dep({ status: 'stopped' })), false)
  assert.equal(isLive(null), false)
})

test('formatRemaining reads naturally and never goes negative', () => {
  assert.equal(formatRemaining(-5), 'under a minute')
  assert.equal(formatRemaining(0), 'under a minute')
  assert.equal(formatRemaining(59), 'under a minute')
  assert.equal(formatRemaining(60), '1 min')
  assert.equal(formatRemaining(61), '2 min')
  assert.equal(formatRemaining(27 * 60), '27 min')
  assert.equal(formatRemaining(3600), '1 h')
  assert.equal(formatRemaining(3600 + 5 * 60), '1 h 5 min')
})

test('the countdown ticks from the browser clock between refreshes, falling back to the server\'s figure', () => {
  const d = dep({ auto_teardown_at: '2026-10-01T00:30:00Z', seconds_until_auto_teardown: 1800 })
  assert.equal(secondsUntilTeardown(d, Date.parse('2026-10-01T00:20:00Z')), 600)
  assert.equal(secondsUntilTeardown(d, Date.parse('2026-10-01T00:40:00Z')), 0)
  assert.equal(secondsUntilTeardown(dep({ auto_teardown_at: null, seconds_until_auto_teardown: 90 }), 0), 90)
})

test('viewOf maps each status to what the panel shows', () => {
  const now = Date.parse('2026-10-01T00:20:00Z')
  assert.deepEqual(viewOf(null, now), { kind: 'none' })
  assert.equal(viewOf(dep({ status: 'requested' }), now).kind, 'starting')
  assert.equal(viewOf(dep({ status: 'deploying' }), now).kind, 'starting')
  assert.equal(viewOf(dep({ status: 'stopping' }), now).kind, 'stopping')
  assert.equal(viewOf(dep({ status: 'failed' }), now).kind, 'failed')
  const ready = viewOf(dep({ auto_teardown_at: '2026-10-01T00:30:00Z' }), now)
  assert.deepEqual([ready.kind, ready.remaining], ['ready', '10 min'])
})

test('a stopped deployment reads as "none", with a note only when the system (not the user) stopped it', () => {
  assert.equal(viewOf(dep({ status: 'stopped', stop_reason: 'user' }), 0).note, undefined)
  assert.match(viewOf(dep({ status: 'stopped', stop_reason: 'idle' }), 0).note ?? '', /inactivity/)
  assert.match(endedNote('max_age') ?? '', /maximum running time/)
  assert.match(endedNote('teardown_failed') ?? '', /contact support/)
  assert.equal(endedNote(null), undefined)
})
