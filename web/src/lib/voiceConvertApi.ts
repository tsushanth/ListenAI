import { supabase } from './supabaseClient'

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'https://listenai-backend.fly.dev'

const CONSENT_STATEMENT =
  'I confirm that I have the legal right to use both the source audio and the target voice reference, and that this conversion does not impersonate any person without their consent.'

async function token(): Promise<string> {
  const { data } = await supabase.auth.getSession()
  const t = data.session?.access_token
  if (!t) throw new Error('Please sign in again.')
  return t
}

async function fail(res: Response): Promise<never> {
  const err = await res.json().catch(() => ({ error: '' }))
  throw new Error(err.error || `Something went wrong (HTTP ${res.status}).`)
}

export interface ConversionJob {
  job_id: string
  status: 'queued' | 'running' | 'done' | 'failed'
}

export interface ConversionStatus {
  status: 'queued' | 'running' | 'done' | 'failed'
  stderr_tail?: string
}

export const voiceConvertApi = {
  getConsentText(): string {
    return CONSENT_STATEMENT
  },

  // Deploy / status / teardown for the converter live in deploymentsApi.ts (shared by every tool).

  // ------------------------------------------------------------------------
  // Conversion jobs
  // ------------------------------------------------------------------------

  async create(params: {
    source: File
    target: File
  }): Promise<ConversionJob> {
    const form = new FormData()
    form.append('source', params.source)
    form.append('target', params.target)
    form.append('consent_statement', CONSENT_STATEMENT)

    const res = await fetch(`${API_BASE_URL}/api/voice-convert/conversions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await token()}` },
      body: form,
    })
    if (!res.ok) return fail(res)
    return res.json()
  },

  async poll(jobId: string): Promise<ConversionStatus> {
    const res = await fetch(`${API_BASE_URL}/api/voice-convert/conversions/${jobId}`, {
      headers: { Authorization: `Bearer ${await token()}` },
    })
    if (!res.ok) return fail(res)
    return res.json()
  },

  async audio(jobId: string): Promise<string> {
    const res = await fetch(`${API_BASE_URL}/api/voice-convert/conversions/${jobId}/audio`, {
      headers: { Authorization: `Bearer ${await token()}` },
    })
    if (!res.ok) return fail(res)
    return URL.createObjectURL(await res.blob())
  },

  async remove(jobId: string): Promise<{ deleted: boolean }> {
    const res = await fetch(`${API_BASE_URL}/api/voice-convert/conversions/${jobId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${await token()}` },
    })
    if (!res.ok) return fail(res)
    return res.json()
  },
}
