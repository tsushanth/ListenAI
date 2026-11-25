// An MCP tool that fails because of us still answers HTTP 200, with isError inside the JSON-RPC result, so the route
// status says nothing. This finds those answers. Failures the caller caused (bad input, rate limit, payment, bad key) and
// "busy, retry" capacity answers are not reported.
import { reportServerFailure, sendServerReport, type SendReport } from '../serverReport.ts'

const OUR_FAULT = new Set(['upstream', 'timeout'])

/** `tool` per request id, for tools/call messages. Only the tool name is kept, never its arguments. */
function toolNames(requestBody: unknown): Map<unknown, string> {
  const out = new Map<unknown, string>()
  for (const m of Array.isArray(requestBody) ? requestBody : [requestBody]) {
    const msg = m as { id?: unknown; method?: unknown; params?: { name?: unknown } } | null
    if (msg?.method === 'tools/call' && typeof msg.params?.name === 'string' && /^[a-z_]{1,64}$/.test(msg.params.name)) out.set(msg.id, msg.params.name)
  }
  return out
}

export async function reportToolFailures(requestBody: unknown, response: Response, send: SendReport = sendServerReport): Promise<void> {
  try {
    const names = toolNames(requestBody)
    if (names.size === 0) return
    const answer = (await response.json()) as unknown
    for (const m of Array.isArray(answer) ? answer : [answer]) {
      const msg = m as { id?: unknown; error?: { code?: unknown }; result?: { isError?: boolean; structuredContent?: { error?: { code?: string; retryable?: boolean } } } } | null
      const tool = names.get(msg?.id)
      if (!tool) continue
      if (msg?.error?.code === -32603) reportServerFailure('mcp_tool', 'INTERNAL_ERROR', { tool }, send)
      const error = msg?.result?.isError ? msg.result.structuredContent?.error : undefined
      if (error?.code && OUR_FAULT.has(error.code) && error.retryable) reportServerFailure('mcp_tool', error.code, { tool }, send)
    }
  } catch { /* not JSON, or already consumed: nothing to report */ }
}
