// Server-side failure reports for the web app's own routes: what is sent, what is never sent, and that each route is wired.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { reportServerFailure, sendServerReport, withFailureReport, type ServerReport } from '../src/lib/serverReport.ts'
import { reportToolFailures } from '../src/lib/mcp/toolFailures.ts'

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8')
const collect = () => { const sent: ServerReport[] = []; return { sent, send: (r: ServerReport) => { sent.push(r) } } }

test('wrapper: a 5xx answer is reported with its status and passed through unchanged', async () => {
  const c = collect()
  const res = new Response('x', { status: 503 })
  assert.equal(await withFailureReport('demo_token', async () => res, c.send)(), res)
  assert.deepEqual(c.sent, [{ flow: 'server_demo_token', code: 'WEB_DEMO_TOKEN_HTTP_503', context: { status: '503' } }])
})

test('wrapper: success, redirects and client errors are not reported', async () => {
  const c = collect()
  for (const status of [200, 302, 400, 401, 402, 404, 429]) await withFailureReport('x', () => new Response(null, { status }), c.send)()
  assert.deepEqual(c.sent, [])
})

test('wrapper: a thrown error is reported by class name only and rethrown', async () => {
  const c = collect()
  const boom = new TypeError('secret rtts_abc123 in message')
  await assert.rejects(withFailureReport('mcp', async () => { throw boom }, c.send)(), (e: unknown) => e === boom)
  assert.deepEqual(c.sent, [{ flow: 'server_mcp', code: 'WEB_MCP_CRASH', context: { error: 'TypeError' } }])
  assert.ok(!JSON.stringify(c.sent).includes('rtts_'))
})

test('a failing sender never breaks the response', async () => {
  const res = await withFailureReport('x', () => new Response(null, { status: 500 }), () => { throw new Error('down') })()
  assert.equal(res.status, 500)
  assert.doesNotThrow(() => reportServerFailure('x', 'y', {}, () => { throw new Error('down') }))
})

test('the real sender does nothing without a key and nothing under the test runner', async () => {
  const realFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => { calls++; return new Response('ok') }) as typeof fetch
  try {
    delete process.env.FAILURE_REPORTER_KEY
    sendServerReport({ flow: 'f', code: 'C', context: {} })
    process.env.FAILURE_REPORTER_KEY = 'test-key'
    sendServerReport({ flow: 'f', code: 'C', context: {} }) // NODE_TEST_CONTEXT is set by node --test
    assert.equal(calls, 0)
  } finally { globalThis.fetch = realFetch; delete process.env.FAILURE_REPORTER_KEY }
})

const toolCall = (name: string, id = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { text: 'private words' } } })
const answer = (code: string, retryable: boolean, id = 1) => ({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: 'private words' }], structuredContent: { error: { code, retryable, message: 'private words' } } } })

test('MCP: a tool that failed on our side is reported by tool name, without arguments or messages', async () => {
  const c = collect()
  await reportToolFailures(toolCall('text_to_speech'), Response.json(answer('upstream', true)), c.send)
  await reportToolFailures([toolCall('dub_audio', 7)], Response.json([answer('timeout', true, 7)]), c.send)
  await reportToolFailures(toolCall('list_voices'), Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'private words' } }), c.send)
  assert.deepEqual(c.sent.map((r) => [r.code, r.context.tool]), [['WEB_MCP_TOOL_UPSTREAM', 'text_to_speech'], ['WEB_MCP_TOOL_TIMEOUT', 'dub_audio'], ['WEB_MCP_TOOL_INTERNAL_ERROR', 'list_voices']])
  assert.ok(!JSON.stringify(c.sent).includes('private'))
})

test('MCP: caller mistakes, capacity, success and other methods are quiet', async () => {
  const c = collect()
  for (const [code, retryable] of [['invalid_input', false], ['rate_limited', true], ['payment_required', false], ['unauthorized', false], ['capacity', true], ['upstream', false]] as const) {
    await reportToolFailures(toolCall('text_to_speech'), Response.json(answer(code, retryable)), c.send)
  }
  await reportToolFailures(toolCall('text_to_speech'), Response.json({ jsonrpc: '2.0', id: 1, result: { content: [] } }), c.send)
  await reportToolFailures({ jsonrpc: '2.0', id: 1, method: 'initialize' }, Response.json(answer('upstream', true)), c.send)
  await reportToolFailures(toolCall('text_to_speech'), new Response('not json'), c.send)
  assert.deepEqual(c.sent, [])
})

test('every server route in scope is wired to the reporter', () => {
  const wired: Record<string, string> = {
    'src/app/mcp/route.ts': "export const POST = withFailureReport('mcp', handlePost)",
    'src/app/oauth/token/route.ts': "export const POST = withFailureReport('oauth_token', handlePost)",
    'src/app/oauth/register/route.ts': "export const POST = withFailureReport('oauth_register', handlePost)",
    'src/app/oauth/approve/route.ts': "export const POST = withFailureReport('oauth_approve', handlePost)",
    'src/app/oauth/authorize/route.ts': "export const GET = withFailureReport('oauth_authorize', handleGet)",
    'src/app/api/checkout/route.ts': "export const POST = withFailureReport('checkout', handlePost)",
    'src/app/api/webhook/route.ts': "export const POST = withFailureReport('stripe_webhook', handlePost)",
    'src/app/api/demo-token/route.ts': "export const POST = withFailureReport('demo_token', handlePost)",
    'src/lib/mcp/voiceCloneRest.ts': 'return withFailureReport(`voice_clone_${route.op}`, handle)(req, route)',
  }
  for (const [file, needle] of Object.entries(wired)) assert.ok(read(file).includes(needle), file)
  assert.ok(read('src/app/mcp/route.ts').includes('reportToolFailures(body, res.clone())'))
})
