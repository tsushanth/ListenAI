import { NextRequest } from 'next/server'
import { oauthConfigured } from './crypto.ts'
import { SlidingWindowLimiter } from '../mcp/ratelimit.ts'

export const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept, MCP-Protocol-Version',
  'Access-Control-Max-Age': '86400',
}
const BASE_HEADERS = { ...CORS, 'Cache-Control': 'no-store', Pragma: 'no-cache' }

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...BASE_HEADERS, ...extra } })
}
export const oauthError = (error: string, description: string, status = 400, extra: Record<string, string> = {}) => json({ error, error_description: description }, status, extra)
export const preflight = () => new Response(null, { status: 204, headers: CORS })
export const notConfigured = () => oauthError('temporarily_unavailable', 'OAuth is not configured on this server.', 503)
export const configured = oauthConfigured

export function clientIp(req: NextRequest): string {
  return req.headers.get('fly-client-ip') || req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown'
}

export const registerLimiter = new SlidingWindowLimiter(20, 60 * 60_000)
export const tokenLimiter = new SlidingWindowLimiter(60, 60_000)
export const approveLimiter = new SlidingWindowLimiter(30, 60_000)

/** Reads a small urlencoded or JSON body into a string map. */
export async function readParams(req: NextRequest): Promise<Record<string, string> | null> {
  const raw = await req.text()
  if (raw.length > 8192) return null
  const ct = (req.headers.get('content-type') || '').toLowerCase()
  try {
    if (ct.includes('application/json')) {
      const o = JSON.parse(raw)
      if (!o || typeof o !== 'object' || Array.isArray(o)) return null
      return Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v === 'string')) as Record<string, string>
    }
    return Object.fromEntries(new URLSearchParams(raw))
  } catch { return null }
}
