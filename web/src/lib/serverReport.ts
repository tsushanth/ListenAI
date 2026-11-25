// Sends SERVER-side failures of this web app's own routes (MCP, OAuth, checkout, Stripe webhook, demo token, the voice
// clone REST relay) to the central app-failure-reporter. The browser reporter cannot see these.
//
// Off unless FAILURE_REPORTER_KEY is set (a Fly secret) and never in tests. The report is a stable code plus fixed labels:
// no request body, header, query string, key, token, user id or upstream message ever leaves through here.
const DEFAULT_ENDPOINT = 'https://app-failure-reporter.t-sushanth.workers.dev/v1/report'

export type ServerReport = { flow: string; code: string; context: Record<string, string> }
export type SendReport = (report: ServerReport) => void

export const sendServerReport: SendReport = ({ flow, code, context }) => {
  const key = process.env.FAILURE_REPORTER_KEY
  if (!key || process.env.FAILURE_REPORTER_DISABLED === '1' || process.env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT) return
  void fetch(process.env.FAILURE_REPORTER_URL || DEFAULT_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Report-Key': key },
    body: JSON.stringify({ kind: 'failure', platform: 'web', version: process.env.FLY_IMAGE_REF || 'web', flow, message: code, stack: '', context }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {}) // reporting must never cause a failure of its own
}

const upper = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '_')

export function reportServerFailure(flow: string, what: string, context: Record<string, string> = {}, send: SendReport = sendServerReport): void {
  try { send({ flow: `server_${flow}`, code: `WEB_${upper(flow)}_${upper(what)}`, context }) } catch { /* never break a response */ }
}

/** Wraps a route handler: reports a 5xx answer or a thrown error. The response (or the error) is passed on unchanged. */
export function withFailureReport<A extends unknown[]>(flow: string, handler: (...args: A) => Response | Promise<Response>, send: SendReport = sendServerReport): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    let res: Response
    try {
      res = await handler(...args)
    } catch (e) {
      reportServerFailure(flow, 'CRASH', { error: e instanceof Error ? e.name : typeof e }, send)
      throw e
    }
    if (res.status >= 500) reportServerFailure(flow, `HTTP_${res.status}`, { status: String(res.status) }, send)
    return res
  }
}
