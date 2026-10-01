// Deploy / status / tear-down for the per-user GPU workers behind each tool (voice convert, voice isolate, sound effects,
// text-to-music, dubbing). Every tool exposes the same three calls under its own path; this is the one client for all of
// them. The backend (backend/src/routes/deployments.ts) never returns the deployment's secret.

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'https://listenai-backend.fly.dev'

export type DeploymentService = 'convert' | 'isolate' | 'sound_effect' | 'music' | 'dub'
export type DeploymentStatus = 'requested' | 'deploying' | 'ready' | 'stopping' | 'stopped' | 'failed'

/** Mirrors the backend's PublicDeployment. */
export interface Deployment {
  id: string
  service: DeploymentService
  status: DeploymentStatus
  app_name: string
  modal_url: string
  error: string | null
  job_count: number
  created_at: string
  ready_at: string | null
  last_used_at: string | null
  expires_at: string | null
  stop_reason: string | null
  /** When the system tears it down if nothing else happens (idle timeout or maximum age). */
  auto_teardown_at: string | null
  seconds_until_auto_teardown: number | null
}

/** Why a deploy was refused, as the backend reports it. */
export type DeployRefusal =
  | 'payment_required'
  | 'account_required'
  | 'user_cap'
  | 'daily_cap'
  | 'global_cap'
  | 'deployments_disabled'
  | 'not_configured'
  | 'service_unavailable'

export class DeploymentError extends Error {
  status: number
  code: string
  constructor(status: number, message: string, code = '') {
    super(message)
    this.name = 'DeploymentError'
    this.status = status
    this.code = code
  }
  /** The user has to add a payment method before they can deploy. */
  get paymentRequired(): boolean {
    return this.status === 402 || this.code === 'payment_required'
  }
}

/** Path prefix of each tool's API. */
export const SERVICE_PATHS: Record<DeploymentService, string> = {
  convert: '/api/voice-convert',
  isolate: '/api/voice-isolate',
  sound_effect: '/api/sound-effects',
  music: '/api/music',
  dub: '/api/dub',
}

/** Statuses in which the deployment exists and still needs watching. */
export const IN_PROGRESS: ReadonlySet<DeploymentStatus> = new Set<DeploymentStatus>(['requested', 'deploying', 'stopping'])

/** True when jobs can be submitted. */
export function isReady(d: Deployment | null | undefined): boolean {
  return d?.status === 'ready'
}

/** True when a deployment exists in any live state (including one that is still starting or stopping). */
export function isLive(d: Deployment | null | undefined): boolean {
  return !!d && (d.status === 'requested' || d.status === 'deploying' || d.status === 'ready' || d.status === 'stopping')
}

async function failFrom(res: Response): Promise<never> {
  const body = (await res.json().catch(() => null)) as { error?: unknown; message?: unknown; code?: unknown } | null
  const text = (typeof body?.message === 'string' && body.message) || (typeof body?.error === 'string' && body.error) || ''
  const code = typeof body?.code === 'string' ? body.code : ''
  throw new DeploymentError(res.status, text || `Something went wrong (HTTP ${res.status}).`, code)
}

export interface DeploymentsClient {
  /** The user's latest deployment for this tool in any state (a failed or stopped one stays visible), or null if none. */
  get(service: DeploymentService): Promise<Deployment | null>
  deploy(service: DeploymentService): Promise<Deployment>
  teardown(service: DeploymentService): Promise<{ deleted: boolean; status: string; message: string }>
}

/** Injectable for tests: `headers` supplies auth, `fetchFn` the network. */
export function createDeploymentsClient(
  // Loaded on first use, so importing this module (and testing the client with injected headers) does not pull in the
  // Supabase browser client.
  headers: () => Promise<Record<string, string>> = async () => (await import('./toolsApiCommon')).authHeaders(),
  fetchFn: typeof fetch = (...a) => fetch(...a),
  base: string = API_BASE_URL,
): DeploymentsClient {
  const url = (s: DeploymentService) => `${base}${SERVICE_PATHS[s]}/deploy`
  return {
    async get(service) {
      const res = await fetchFn(url(service), { headers: await headers() })
      if (res.status === 404) return null
      if (!res.ok) return failFrom(res)
      return res.json()
    },
    async deploy(service) {
      const res = await fetchFn(url(service), { method: 'POST', headers: await headers() })
      if (res.status === 409) {
        // Already has one: show it instead of an error.
        const body = (await res.json().catch(() => null)) as { deployment?: Deployment } | null
        if (body?.deployment) return body.deployment
      }
      if (!res.ok) return failFrom(res)
      return res.json()
    },
    async teardown(service) {
      const res = await fetchFn(url(service), { method: 'DELETE', headers: await headers() })
      if (!res.ok) return failFrom(res)
      return res.json()
    },
  }
}

export const deploymentsApi: DeploymentsClient = createDeploymentsClient()
