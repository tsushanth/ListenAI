import { createHash } from 'node:crypto'
import { NextRequest } from 'next/server'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { createMcpServer, type RequestContext } from '@/lib/mcp/server'
import { SlidingWindowLimiter } from '@/lib/mcp/ratelimit'
import { UpstreamError, authorize } from '@/lib/mcp/upstream'

// Hosted MCP server for the ReadAloud AI voice API. Stateless Streamable HTTP (MCP spec 2025-06-18):
// every POST is a self-contained JSON-RPC exchange answered as plain JSON, no sessions, no SSE.
//
// Auth: `Authorization: Bearer <API key>`. The key is only forwarded to /tts/authorize; it is never
// logged or stored (only a SHA-256 prefix is kept in memory to bucket rate limits).
//
// TODO(OAuth): the MCP authorization spec (OAuth 2.1 + protected-resource metadata at
// /.well-known/oauth-protected-resource, dynamic client registration) is not implemented. To add it,
// serve that metadata, add `resource_metadata="..."` to the WWW-Authenticate header below, and accept
// access tokens here in addition to API keys.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

const MAX_BODY_BYTES = 64 * 1024
const ipLimiter = new SlidingWindowLimiter(120, 60_000) // any request, per client IP

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*', // auth is a bearer header, not cookies, so browser inspectors may call us
  'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
  'Access-Control-Expose-Headers': 'WWW-Authenticate, Retry-After, Mcp-Session-Id',
  'Access-Control-Max-Age': '86400',
}

function withHeaders(res: Response, extra: Record<string, string> = {}): Response {
  const h = new Headers(res.headers)
  for (const [k, v] of Object.entries({ ...CORS, 'Cache-Control': 'no-store', ...extra })) h.set(k, v)
  return new Response(res.body, { status: res.status, headers: h })
}

function rpcError(status: number, code: number, message: string, extra: Record<string, string> = {}): Response {
  return withHeaders(Response.json({ jsonrpc: '2.0', error: { code, message }, id: null }, { status }), extra)
}

function unauthorized(message: string): Response {
  return rpcError(401, -32001, message, { 'WWW-Authenticate': 'Bearer realm="ReadAloud AI MCP", error="invalid_token"' })
}

function clientIp(req: NextRequest): string {
  return req.headers.get('fly-client-ip') || req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown'
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS })
}

// We never open a server-to-client SSE stream and have no sessions, which the spec allows as 405.
const notAllowed = () => rpcError(405, -32000, 'This server is stateless: use POST with a JSON-RPC message.', { Allow: 'POST, OPTIONS' })
export const GET = notAllowed
export const DELETE = notAllowed

export async function POST(req: NextRequest) {
  const ip = ipLimiter.check(clientIp(req))
  if (!ip.ok) return rpcError(429, -32002, 'Too many requests from this IP. Slow down.', { 'Retry-After': String(ip.retryAfterSec) })

  const auth = req.headers.get('authorization') || ''
  const m = /^Bearer\s+(\S{8,256})$/i.exec(auth)
  if (!m) return unauthorized('Missing or malformed Authorization header. Send "Authorization: Bearer <your ReadAloud AI API key>". Get a key at https://readaloudai.org/developers#get-started')
  const apiKey = m[1]

  const raw = await req.text()
  if (raw.length > MAX_BODY_BYTES) return rpcError(413, -32600, 'Request body too large.')
  let body: unknown
  try { body = JSON.parse(raw) } catch { return rpcError(400, -32700, 'Parse error: body is not valid JSON.') }

  // Validate the key when a session starts, so a bad key fails at connect time instead of at the first tool call.
  const messages = Array.isArray(body) ? body : [body]
  if (messages.some((x) => x && typeof x === 'object' && (x as { method?: string }).method === 'initialize')) {
    try {
      await authorize(apiKey, 'piper')
    } catch (e) {
      if (e instanceof UpstreamError && e.code === 'unauthorized') return unauthorized('Invalid or revoked API key.')
      // 402 (free characters used up) still means the key is valid; connect and report it on the tool call.
    }
  }

  const ctx: RequestContext = { apiKey, keyId: createHash('sha256').update(apiKey).digest('hex').slice(0, 16) }
  const server = createMcpServer(ctx)
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  await server.connect(transport)
  try {
    const res = await transport.handleRequest(req, { parsedBody: body })
    // The key was checked at connect time; if it was revoked since, upstream says 401 during a tool call.
    if (ctx.authFailed) return unauthorized('Invalid or revoked API key.')
    return withHeaders(res)
  } finally {
    void server.close()
  }
}
