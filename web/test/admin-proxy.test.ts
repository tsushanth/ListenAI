import { test } from 'node:test'
import assert from 'node:assert/strict'

const { forwardAdminDashboard } = await import('../src/lib/adminProxy.ts')

test('no Authorization header: 404 without calling the backend', async () => {
  let called = false
  const r = await forwardAdminDashboard({ backendBase: 'https://b.example.test', authorization: null, range: null, fetchImpl: (async () => { called = true; return new Response('x') }) as any })
  assert.equal(r.status, 404); assert.equal(r.body, 'Not found'); assert.equal(called, false)
})

test('forwards the bearer and a valid range to the backend and returns its status and body', async () => {
  let seen: { url: string; auth: string | null } | null = null
  const r = await forwardAdminDashboard({
    backendBase: 'https://b.example.test/', authorization: 'Bearer abc', range: '30d',
    fetchImpl: (async (url: any, init: any) => { seen = { url: String(url), auth: new Headers(init.headers).get('authorization') }; return new Response('{"ok":1}', { status: 200, headers: { 'content-type': 'application/json' } }) }) as any,
  })
  assert.equal(seen!.url, 'https://b.example.test/api/admin/dashboard?range=30d')
  assert.equal(seen!.auth, 'Bearer abc')
  assert.equal(r.status, 200); assert.equal(r.body, '{"ok":1}')
})

test('junk range is dropped, never forwarded', async () => {
  let url = ''
  await forwardAdminDashboard({ backendBase: 'https://b.example.test', authorization: 'Bearer abc', range: '../../x?y=1', fetchImpl: (async (u: any) => { url = String(u); return new Response('{}') }) as any })
  assert.equal(url, 'https://b.example.test/api/admin/dashboard')
})

test('backend 404 is passed through as 404', async () => {
  const r = await forwardAdminDashboard({ backendBase: 'https://b.example.test', authorization: 'Bearer abc', range: '7d', fetchImpl: (async () => new Response('Not found', { status: 404 })) as any })
  assert.equal(r.status, 404)
})

test('a network error is a 502 with a generic message (no internals leaked)', async () => {
  const r = await forwardAdminDashboard({ backendBase: 'https://b.example.test', authorization: 'Bearer abc', range: '7d', fetchImpl: (async () => { throw new Error('ECONNREFUSED 10.0.0.1') }) as any })
  assert.equal(r.status, 502); assert.doesNotMatch(r.body, /10\.0\.0\.1/)
})
