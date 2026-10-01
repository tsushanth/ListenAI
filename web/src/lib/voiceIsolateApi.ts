import { API_BASE_URL, ApiError, authHeaders, fail } from './toolsApiCommon'
import { normalizeAudioFile } from './audioFiles'

// Backend: /api/voice-isolate (same per-user Modal deploy model as /api/voice-convert)
//   GET/POST/DELETE /deploy
//   POST /isolations (multipart: input, consent_statement, want_instrumental)
//   GET  /isolations/:id -> {status: queued|running|done|failed, stderr_tail?}
//   GET  /isolations/:id/audio?stem=vocals|instrumental -> audio/wav

// Must match the backend's expectedConsent string exactly (voiceIsolate.ts).
const CONSENT_STATEMENT =
  "I confirm that I have the legal right to use this audio and that isolating its vocal track does not infringe anyone else's rights."

export type IsolateStatus = 'queued' | 'running' | 'done' | 'failed'
export type Stem = 'vocals' | 'instrumental'

export interface IsolateJob {
  job_id: string
  status: IsolateStatus | 'rejected'
}

export interface IsolateJobStatus {
  status: IsolateStatus
  stderr_tail?: string
}

export const voiceIsolateApi = {
  getConsentText(): string {
    return CONSENT_STATEMENT
  },

  // Deploy / status / teardown for the isolator live in deploymentsApi.ts (shared by every tool).

  async create(params: { input: File; wantInstrumental: boolean }): Promise<IsolateJob> {
    const form = new FormData()
    form.append('input', normalizeAudioFile(params.input))
    form.append('consent_statement', CONSENT_STATEMENT)
    form.append('want_instrumental', params.wantInstrumental ? 'true' : 'false')

    const res = await fetch(`${API_BASE_URL}/api/voice-isolate/isolations`, {
      method: 'POST',
      headers: await authHeaders(),
      body: form,
    })
    if (res.status === 400) {
      const body = (await res.clone().json().catch(() => null)) as { status?: string } | null
      if (body?.status === 'rejected') {
        throw new ApiError(400, 'The isolator rejected this audio. It may be too long or not decodable; try a shorter clip.')
      }
    }
    if (!res.ok) return fail(res)
    return res.json()
  },

  async poll(jobId: string): Promise<IsolateJobStatus> {
    const res = await fetch(`${API_BASE_URL}/api/voice-isolate/isolations/${encodeURIComponent(jobId)}`, {
      headers: await authHeaders(),
    })
    if (!res.ok) return fail(res)
    return res.json()
  },

  /** Returns an object URL for the requested stem (caller should revoke it). */
  async audio(jobId: string, stem: Stem): Promise<string> {
    const res = await fetch(
      `${API_BASE_URL}/api/voice-isolate/isolations/${encodeURIComponent(jobId)}/audio?stem=${stem}`,
      { headers: await authHeaders() },
    )
    if (!res.ok) return fail(res)
    return URL.createObjectURL(await res.blob())
  },
}
