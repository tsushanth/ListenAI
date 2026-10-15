import { test } from 'node:test'
import assert from 'node:assert/strict'

const { buildServerCard } = await import('../src/lib/mcp/serverCard.ts')

test('server card: serverInfo, auth and a real tool list built from the live server definition', async () => {
  const card = await buildServerCard()
  assert.equal(card.serverInfo.name, 'readaloud-ai')
  assert.match(card.serverInfo.version, /^\d+\.\d+\.\d+/)
  assert.deepEqual(card.authentication, { required: true, schemes: ['oauth2'] })
  assert.ok(card.tools.length >= 8, `expected the full tool list, got ${card.tools.length}`)
  const names = (card.tools as { name: string }[]).map((t) => t.name)
  for (const n of ['text_to_speech', 'speech_to_text', 'list_voices']) assert.ok(names.includes(n), `${n} missing`)
  assert.equal(new Set(names).size, names.length, 'tool names must be unique')
  for (const t of card.tools as { name: string; description?: string; inputSchema?: { type?: string } }[]) {
    assert.ok(t.description && t.description.length > 20, `${t.name} needs a description`)
    assert.equal(t.inputSchema?.type, 'object', `${t.name} needs an object input schema`)
  }
  assert.deepEqual(card.resources, [])
  assert.deepEqual(card.prompts, [])
})

test('server card: contains no credentials and serializes to JSON', async () => {
  const text = JSON.stringify(await buildServerCard())
  assert.doesNotMatch(text, /rtts_[A-Za-z0-9]{8,}|Bearer [A-Za-z0-9]|sk-[A-Za-z0-9]{10,}/)
  JSON.parse(text)
})

test('server card route: JSON, public CORS, cacheable, OPTIONS ok', async () => {
  const route = await import('../src/app/.well-known/mcp/server-card.json/route.ts')
  const res = await route.GET()
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('access-control-allow-origin'), '*')
  assert.match(res.headers.get('content-type') ?? '', /json/)
  assert.match(res.headers.get('cache-control') ?? '', /public/)
  const body = await res.json()
  assert.ok(Array.isArray(body.tools) && body.tools.length > 0)
  assert.equal(route.OPTIONS().status, 204)
})
