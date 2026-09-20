// POST /oauth/approve logic with injectable dependencies (see deps.ts). No secrets are logged.
import { CONNECTOR_LABEL_PREFIX } from './config.ts'
import { buildRedirect, validateAuthorize } from './authorize.ts'
import { mintCode } from './tokens.ts'

export interface KeySummary { id: string; label: string | null; revoked: boolean }
export class ApproveError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}
export interface ApproveDeps {
  /** Verify the Supabase access token server-side; returns the user id or null. */
  verifyUser(token: string): Promise<string | null>
  listKeys(token: string): Promise<KeySummary[]>
  revokeKey(token: string, id: string): Promise<void>
  createKey(token: string, label: string): Promise<{ key: string }>
}

export const connectorLabel = (clientName: string) => `${CONNECTOR_LABEL_PREFIX}${clientName})`

export async function approve(deps: ApproveDeps, accessToken: string, q: URLSearchParams): Promise<{ redirect_url: string }> {
  const v = validateAuthorize(q)
  if (!v.ok) throw new ApproveError(400, v.message)
  const sub = accessToken ? await deps.verifyUser(accessToken) : null
  if (!sub) throw new ApproveError(401, 'Please sign in again.')
  const label = connectorLabel(v.p.clientName)
  // Reconnects replace the previous connector key so the per-user key cap is not exhausted.
  const existing = await deps.listKeys(accessToken)
  for (const k of existing) if (!k.revoked && k.label === label) await deps.revokeKey(accessToken, k.id)
  const { key } = await deps.createKey(accessToken, label)
  const code = mintCode({ sub, clientId: v.p.clientId, redirectUri: v.p.redirectUri, codeChallenge: v.p.codeChallenge, resource: v.p.resource, apiKey: key })
  return { redirect_url: buildRedirect(v.p.redirectUri, { code, state: v.p.state }) }
}
