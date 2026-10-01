// MCP side of the explicit deployment lifecycle (backend/src/routes/deployments.ts). Voice conversion, voice
// isolation, sound effects and dubbing each run on a private Modal app that the caller brings up, uses and tears
// down. Starting one is a deliberate act (manage_deployment, action "deploy"); a tool call that needs a deployment
// never starts one as a side effect.
import { z } from 'zod'
import { UpstreamError } from './upstream.ts'

const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL || 'https://listenai-backend.fly.dev'
const REQUEST_TIMEOUT_MS = 30_000

export const DEPLOY_SERVICES = ['convert', 'isolate', 'sound_effect', 'dub'] as const
export type DeployService = (typeof DEPLOY_SERVICES)[number]

const SERVICE_INFO: Record<DeployService, { path: string; label: string; tool: string }> = {
  convert: { path: '/api/voice-convert/deploy', label: 'voice conversion', tool: 'convert_voice' },
  isolate: { path: '/api/voice-isolate/deploy', label: 'voice isolation', tool: 'isolate_voice' },
  sound_effect: { path: '/api/sound-effects/deploy', label: 'sound effects', tool: 'generate_sound_effect' },
  dub: { path: '/api/dub/deploy', label: 'dubbing', tool: 'dub_audio' },
}

export const manageDeploymentInput = {
  service: z.enum(DEPLOY_SERVICES).describe('Which feature: convert (convert_voice), isolate (isolate_voice), sound_effect (generate_sound_effect) or dub (dub_audio).'),
  action: z.enum(['status', 'deploy', 'teardown']).describe('status: show the current deployment. deploy: bring up your private GPU app (takes about 1-3 minutes). teardown: stop it.'),
}
export const manageDeploymentSchema = z.object(manageDeploymentInput)

/** The error a tool returns when the backend says the caller has no ready deployment. */
export function deploymentRequiredError(service: DeployService): UpstreamError {
  const { label, tool } = SERVICE_INFO[service]
  return new UpstreamError(
    'invalid_input',
    `${label[0].toUpperCase()}${label.slice(1)} runs on your own private GPU app, which is not running. Call manage_deployment with service "${service}" and action "deploy", wait until its status is "ready" (about 1-3 minutes; check with action "status"), then call ${tool} again. Call manage_deployment with action "teardown" when finished (it also stops automatically after an idle period).`,
    false,
  )
}

export interface DeploymentView { status: string; [key: string]: unknown }
export interface ManageResult { text: string; data: Record<string, unknown> }

/** Only fields a caller needs. The Modal app name and endpoint stay server side. */
function publicView(raw: unknown): DeploymentView | null {
  if (!raw || typeof raw !== 'object') return null
  const d = raw as Record<string, unknown>
  if (typeof d.status !== 'string') return null
  const out: DeploymentView = { status: d.status }
  for (const k of ['created_at', 'ready_at', 'last_used_at', 'expires_at', 'auto_teardown_at', 'seconds_until_auto_teardown', 'job_count', 'stop_reason', 'error']) {
    if (d[k] !== undefined && d[k] !== null) out[k] = d[k]
  }
  return out
}

async function call(method: 'GET' | 'POST' | 'DELETE', service: DeployService, headers: Record<string, string>): Promise<Response> {
  try {
    return await fetch(`${BACKEND_URL}${SERVICE_INFO[service].path}`, { method, headers, cache: 'no-store', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  } catch {
    throw new UpstreamError('upstream', `Could not reach the ${SERVICE_INFO[service].label} backend. Try again shortly.`, true)
  }
}

async function errorMessage(r: Response): Promise<string> {
  const body = (await r.json().catch(() => null)) as { error?: unknown } | null
  return typeof body?.error === 'string' ? body.error : ''
}

/** Maps a refused deploy or an unexpected response to an UpstreamError. Always throws. */
async function fail(r: Response, label: string): Promise<never> {
  const msg = await errorMessage(r)
  if (r.status === 401) throw new UpstreamError('unauthorized', 'Invalid or revoked API key.', false)
  if (r.status === 402) throw new UpstreamError('payment_required', msg || `${label} needs a payment method on file. Add one at https://readaloudai.org/developers#get-started, then try again.`, false)
  if (r.status === 403) throw new UpstreamError('unauthorized', msg || `${label} deployments need a signed-in ReadAloud account.`, false)
  if (r.status === 429) throw new UpstreamError('rate_limited', msg || `Deployment limit reached for ${label}. Tear one down or try again later.`, false)
  if (r.status === 503) throw new UpstreamError('capacity', msg || `${label} is not available right now.`, true)
  if (r.status === 404) throw new UpstreamError('upstream', `${label} is not available on this deployment.`, false)
  throw new UpstreamError('upstream', `The ${label} backend returned ${r.status}${msg ? `: ${msg}` : ''}`, r.status >= 500)
}

export async function manageDeployment(service: DeployService, action: 'status' | 'deploy' | 'teardown', headers: Record<string, string>): Promise<ManageResult> {
  const { label } = SERVICE_INFO[service]

  if (action === 'status') {
    const r = await call('GET', service, headers)
    if (r.status === 404) return { text: `No ${label} deployment. Use action "deploy" to start one.`, data: { service, status: 'none' } }
    if (!r.ok) await fail(r, label)
    const dep = publicView(await r.json().catch(() => null))
    if (!dep) throw new UpstreamError('upstream', `Unexpected response from the ${label} backend.`, true)
    return { text: statusText(label, dep), data: { service, ...dep } }
  }

  if (action === 'teardown') {
    const r = await call('DELETE', service, headers)
    if (r.status === 404) return { text: `No active ${label} deployment to tear down.`, data: { service, status: 'none' } }
    if (!r.ok) await fail(r, label)
    const body = (await r.json().catch(() => null)) as { status?: string; message?: string } | null
    return { text: body?.message || `Tearing down your ${label} deployment.`, data: { service, status: body?.status ?? 'stopping' } }
  }

  let r = await call('POST', service, headers)
  if (r.status === 409) {
    const existing = publicView(((await r.json().catch(() => null)) as { deployment?: unknown } | null)?.deployment)
    if (existing?.status === 'failed') {
      // A failed deployment blocks a new one until it is cleaned up. The caller asked to deploy, so clear it once.
      await call('DELETE', service, headers)
      r = await call('POST', service, headers)
    } else if (existing) {
      return { text: statusText(label, existing), data: { service, ...existing } }
    }
  }
  if (r.status === 202 || r.status === 200) {
    const dep = publicView(await r.json().catch(() => null))
    return {
      text: `Deploying your ${label} app. It is ready when status is "ready" (usually 1-3 minutes); check with action "status". You are stopped with action "teardown" when you are done, and it also stops automatically after an idle period.`,
      data: { service, ...(dep ?? { status: 'deploying' }) },
    }
  }
  if (r.status === 409) {
    const dep = publicView(((await r.json().catch(() => null)) as { deployment?: unknown } | null)?.deployment)
    return { text: `Your ${label} deployment is still ${dep?.status ?? 'in progress'}. Check again with action "status".`, data: { service, ...(dep ?? { status: 'deploying' }) } }
  }
  return fail(r, label)
}

function statusText(label: string, dep: DeploymentView): string {
  const secs = typeof dep.seconds_until_auto_teardown === 'number' ? ` It stops automatically in about ${Math.max(1, Math.round(dep.seconds_until_auto_teardown / 60))} min unless used.` : ''
  switch (dep.status) {
    case 'ready': return `Your ${label} app is ready.${secs}`
    case 'requested':
    case 'deploying': return `Your ${label} app is still deploying. Check again shortly.`
    case 'stopping': return `Your ${label} app is shutting down. Deploy again once it shows "stopped".`
    case 'stopped': return `Your ${label} app is stopped. Use action "deploy" to start a new one.`
    case 'failed': return `Your ${label} deployment failed${typeof dep.error === 'string' ? `: ${dep.error}` : ''}. Use action "deploy" to retry.`
    default: return `Your ${label} deployment is ${dep.status}.`
  }
}
