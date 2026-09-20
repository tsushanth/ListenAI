// Client for the voice pipeline's intake API (realtime-tts repo, voice-pipeline/intake.py, Modal web app).
// Server-to-server only: Bearer INTAKE_SECRET. The intake API does NOT decide which user may touch which
// voice - routes/voiceStudioRouter.ts does, using the owner_user_id the intake stored at creation.
export interface IntakeVoiceStatus {
  voice_id: string;
  status: 'created' | 'training' | 'ready' | 'rejected' | 'deployed';
  owner_user_id?: string | null;
  speaker_name?: string | null;
  created_at?: number | null;
  manifest?: Record<string, unknown>;
  error?: { code?: string; reason?: string } & Record<string, unknown>;
  voice?: string;
}

export class IntakeError extends Error {
  constructor(public status: number, public detail: string) {
    super(`intake ${status}: ${detail}`);
  }
}

export interface IntakeClient {
  create(body: Record<string, unknown>): Promise<{ voice_id: string }>;
  list(ownerUserId: string): Promise<{ voices: Array<Record<string, unknown>> }>;
  get(voiceId: string): Promise<IntakeVoiceStatus>;
  putPart(voiceId: string, n: number, data: Buffer): Promise<{ part: number; bytes: number }>;
  listParts(voiceId: string): Promise<{ parts: Array<{ part: number; bytes: number }> }>;
  commit(voiceId: string, parts: number, bytes?: number): Promise<{ voice_id: string; status: string; clips: number }>;
  sample(voiceId: string, n: number): Promise<Buffer>;
  preview(voiceId: string, text: string): Promise<Buffer>;
  deploy(voiceId: string): Promise<{ voice_id: string; voice: string }>;
  remove(voiceId: string): Promise<{ deleted: string }>;
}

export function createIntakeClient(baseUrl: string, secret: string | undefined): IntakeClient {
  // Idempotent calls (GET, part PUTs) are retried on network errors and 5xx: Modal web endpoints
  // occasionally reset a connection (seen live: ECONNRESET on an 8 MB part). Everything else fails fast.
  async function call(method: string, path: string, opts: { json?: unknown; body?: Buffer; timeoutMs?: number; retry?: boolean } = {}): Promise<Response> {
    const tries = opts.retry || method === "GET" ? 3 : 1
    for (let attempt = 1; ; attempt++) {
      try {
        return await callOnce(method, path, opts)
      } catch (e) {
        const transient = !(e instanceof IntakeError) || e.status >= 500
        if (!transient || attempt >= tries) throw e instanceof IntakeError ? e : new IntakeError(502, 'network error talking to intake')
        await new Promise((r) => setTimeout(r, 500 * attempt))
      }
    }
  }
  async function callOnce(method: string, path: string, opts: { json?: unknown; body?: Buffer; timeoutMs?: number } = {}): Promise<Response> {
    if (!secret) throw new IntakeError(503, 'INTAKE_SECRET is not configured');
    const headers: Record<string, string> = { Authorization: `Bearer ${secret}` };
    let body: BodyInit | undefined;
    if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.json);
    } else if (opts.body) {
      headers['Content-Type'] = 'application/octet-stream';
      body = new Uint8Array(opts.body);
    }
    // redirect: 'follow' (default): Modal answers a web request that outlives ~150 s with a 303 to a result
    // URL; following it with GET is exactly the documented client behaviour (commit/preview can be slow).
    const res = await fetch(`${baseUrl}${path}`, { method, headers, body, signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000) });
    if (!res.ok) {
      let detail = '';
      try {
        const j = (await res.json()) as { detail?: unknown };
        detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail ?? j);
      } catch {
        /* not json */
      }
      throw new IntakeError(res.status, detail || res.statusText);
    }
    return res;
  }
  const json = async <T>(p: Promise<Response>) => (await p).json() as Promise<T>;
  const bin = async (p: Promise<Response>) => Buffer.from(await (await p).arrayBuffer());
  const id = encodeURIComponent;
  return {
    create: (b) => json(call('POST', '/voices', { json: b })),
    list: (u) => json(call('GET', `/voices?owner_user_id=${id(u)}`)),
    get: (v) => json(call('GET', `/voices/${id(v)}`)),
    putPart: (v, n, data) => json(call('PUT', `/voices/${id(v)}/dataset/parts/${n}`, { body: data, retry: true })),
    listParts: (v) => json(call('GET', `/voices/${id(v)}/dataset/parts`)),
    commit: (v, parts, bytes) => json(call('POST', `/voices/${id(v)}/dataset/commit`, { json: { parts, bytes }, timeoutMs: 600_000 })),
    sample: (v, n) => bin(call('GET', `/voices/${id(v)}/samples/${n}`)),
    preview: (v, text) => bin(call('POST', `/voices/${id(v)}/preview`, { json: { text }, timeoutMs: 180_000 })),
    deploy: (v) => json(call('POST', `/voices/${id(v)}/deploy`, { timeoutMs: 360_000 })),
    remove: (v) => json(call('DELETE', `/voices/${id(v)}`, { timeoutMs: 120_000 })),
  };
}
