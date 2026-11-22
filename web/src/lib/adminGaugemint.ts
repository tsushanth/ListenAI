// Logic of GET /api/admin/gaugemint, kept out of the route file so it can be tested without Next or Supabase (same split as adminProxy.ts).
// The route does the admin check (the very same line as /api/admin/overview) and passes the verdict in; this function never sees the
// bearer token and never takes the site from the request: the domain is fixed on the server (GAUGEMINT_DOMAIN).
import { GAUGEMINT_ERROR_STATUS, parseGaugemintPeriod, type GaugemintPeriod, type GaugemintResult } from './gaugemintTypes.ts'

export interface AdminGaugemintArgs {
  isAdmin: boolean
  /** The raw `period` query value. Anything but 7d, 30d or 12mo means 30d. */
  period: string | null
  getStats: (period: GaugemintPeriod) => Promise<GaugemintResult>
}
export interface AdminGaugemintResponse { status: number; body: string; contentType: string }

export async function adminGaugemint({ isAdmin, period, getStats }: AdminGaugemintArgs): Promise<AdminGaugemintResponse> {
  if (!isAdmin) return { status: 404, body: 'Not found', contentType: 'text/plain' } // same answer as /api/admin/overview
  let result: GaugemintResult
  try {
    result = await getStats(parseGaugemintPeriod(period))
  } catch {
    result = { ok: false, error: { kind: 'bad_response', message: 'Unexpected error while reading stats.' } }
  }
  if (result.ok) return { status: 200, body: JSON.stringify(result), contentType: 'application/json' }
  // Errors carry kind + message only (no key, no upstream body). The card shows `message`; `kind` picks the state.
  return { status: GAUGEMINT_ERROR_STATUS[result.error.kind], body: JSON.stringify(result), contentType: 'application/json' }
}
