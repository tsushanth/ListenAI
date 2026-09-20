// Live integration check for the /mcp route. Usage:
//   MCP_URL=http://localhost:3120/mcp MCP_KEY=<temporary key> node test/integration.mjs
// Uses the official SDK client. text_to_speech calls hit the real TTS API and spend a few characters of the key.
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { parseWav } from '../src/lib/mcp/wav.ts'

const URL_ = process.env.MCP_URL || 'http://localhost:3120/mcp'
const KEY = process.env.MCP_KEY
assert(KEY, 'MCP_KEY required')
const ok = (m) => console.log('PASS', m)
const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }
const post = (auth, body = init) => fetch(URL_, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify(body) })

// HTTP-level behaviour
let r = await post(null)
assert.equal(r.status, 401); assert.match(r.headers.get('www-authenticate') || '', /^Bearer/); ok('missing key -> 401 + WWW-Authenticate')
r = await post('Bearer definitely-not-a-real-key')
assert.equal(r.status, 401); ok('bad key -> 401')
r = await fetch(URL_, { method: 'OPTIONS', headers: { origin: 'http://x', 'access-control-request-method': 'POST' } })
assert.equal(r.status, 204); assert.equal(r.headers.get('access-control-allow-origin'), '*'); ok('OPTIONS CORS')
r = await fetch(URL_); assert.equal(r.status, 405); ok('GET -> 405')
r = await fetch(URL_, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: 'x'.repeat(70000) })
assert.equal(r.status, 413); ok('oversized body -> 413')

// SDK client
const client = new Client({ name: 'integration-test', version: '1.0.0' })
await client.connect(new StreamableHTTPClientTransport(new URL(URL_), { requestInit: { headers: { Authorization: `Bearer ${KEY}` } } }))
ok(`initialize (server ${client.getServerVersion().name})`)
const { tools } = await client.listTools()
assert.deepEqual(tools.map((t) => t.name).sort(), ['get_api_status', 'list_voices', 'text_to_speech']); ok('tools/list: ' + tools.map((t) => t.name).join(', '))
const lv = await client.callTool({ name: 'list_voices', arguments: { engine: 'kokoro' } })
assert(lv.structuredContent.kokoro.voices.includes('af_heart')); ok('list_voices')
const st = await client.callTool({ name: 'get_api_status', arguments: {} })
console.log('     status:', JSON.stringify(st.structuredContent.piper)); ok('get_api_status')

async function speak(args) {
  const res = await client.callTool({ name: 'text_to_speech', arguments: args })
  assert(!res.isError, JSON.stringify(res.content))
  const audio = res.content.find((c) => c.type === 'audio')
  assert.equal(audio.mimeType, 'audio/wav')
  const w = parseWav(Buffer.from(audio.data, 'base64'))
  assert.equal(w.sampleRate, 24000); assert.equal(w.channels, 1); assert(w.seconds > 0.3)
  console.log('    ', res.content.find((c) => c.type === 'text').text)
  return w
}
await speak({ text: 'Hello from the ReadAloud MCP server.' }); ok('text_to_speech piper -> valid WAV')
await speak({ text: 'This is Kokoro.', engine: 'kokoro', voice: 'af_heart' }); ok('text_to_speech kokoro -> valid WAV')

const errText = async (args) => { try { const x = await client.callTool({ name: 'text_to_speech', arguments: args }); return x.isError ? x.content[0].text : 'NOERROR' } catch (e) { return 'THROWN ' + e.message } }
let e = await errText({ text: 'x'.repeat(1001) })
assert.match(e, /1000|too big|Too big|at most/i); ok('over-length text rejected: ' + e.slice(0, 80).replace(/\n/g, ' '))
e = await errText({ text: 'hi', voice: 'nope' })
assert.match(e, /invalid_voice/); ok('invalid voice -> structured error')

// Rate limit: 15 speech calls/min/key. Invalid-voice calls are counted but cost nothing.
let limited = 0
for (let i = 0; i < 20; i++) if (/rate_limited/.test(await errText({ text: 'hi', voice: 'nope' }))) limited++
assert(limited > 0); ok(`per-key rate limit triggered (${limited}/20 limited)`)
await client.close()
console.log('ALL PASSED')
