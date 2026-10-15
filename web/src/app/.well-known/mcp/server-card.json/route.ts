import { buildServerCard, type ServerCard } from '../../../../lib/mcp/serverCard.ts'

// MCP server card for directories that scan tools without signing in (see src/lib/mcp/serverCard.ts). Public, no credentials.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Max-Age': '86400' }
const TTL_MS = 60 * 60 * 1000
let cached: { at: number; card: ServerCard } | null = null

export async function GET(): Promise<Response> {
  if (!cached || Date.now() - cached.at > TTL_MS) cached = { at: Date.now(), card: await buildServerCard() }
  return Response.json(cached.card, { headers: { ...CORS, 'Cache-Control': 'public, max-age=300' } })
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS })
}
