// HTTP client for the Chatterbox cloning app (backend/modal/chatterbox_clone.py). Dark unless
// VOICE_CLONE_SERVICE_URL and VOICE_CLONE_SERVICE_SECRET are set; nothing points prod at it by default.
import type { AudioMetrics, CloneServiceClient, SynthesisResult } from './types.js';

export class ServiceUnavailableError extends Error {}

export interface ServiceClientOptions {
  baseUrl: string;
  secret: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createServiceClient(opts: ServiceClientOptions): CloneServiceClient {
  const f = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, '');
  const timeout = opts.timeoutMs ?? 10 * 60_000; // cold start 60-180 s (REPORT.md) + synthesis
  const headers = { Authorization: `Bearer ${opts.secret}` };

  async function call(path: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await f(`${base}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(timeout) });
    } catch (err) {
      throw new ServiceUnavailableError(`voice clone service unreachable: ${(err as Error).message}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ServiceUnavailableError(`voice clone service ${path} returned HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return res;
  }

  const blob = (b: Buffer) => new Blob([new Uint8Array(b)]);

  return {
    async analyze(audio, filename) {
      const form = new FormData();
      form.append('audio', blob(audio), filename || 'audio');
      const j = (await (await call('/analyze', { method: 'POST', body: form })).json()) as Record<string, number | null>;
      const m: AudioMetrics = {
        durationSec: Number(j.duration_sec), speechSec: Number(j.speech_sec), snrDb: Number(j.snr_db),
        clippingRatio: Number(j.clipping_ratio),
        minWindowSimilarity: j.min_window_similarity === null || j.min_window_similarity === undefined ? null : Number(j.min_window_similarity),
        musicProb: Number(j.music_prob),
      };
      if (![m.durationSec, m.speechSec, m.snrDb, m.clippingRatio, m.musicProb].every(Number.isFinite)) {
        throw new ServiceUnavailableError('voice clone service returned malformed analysis');
      }
      return m;
    },
    async similarity(a, b) {
      const form = new FormData();
      form.append('a', blob(a), 'a');
      form.append('b', blob(b), 'b');
      const j = (await (await call('/similarity', { method: 'POST', body: form })).json()) as { similarity?: number };
      if (typeof j.similarity !== 'number' || !Number.isFinite(j.similarity)) throw new ServiceUnavailableError('voice clone service returned malformed similarity');
      return j.similarity;
    },
    async createVoice({ voiceId, audio, filename, language }) {
      const form = new FormData();
      form.append('voice_id', voiceId);
      form.append('language', language);
      form.append('reference', blob(audio), filename || 'reference');
      const j = (await (await call('/voices', { method: 'POST', body: form })).json()) as { reference_sec?: number };
      return { referenceSec: Number(j.reference_sec ?? 0) };
    },
    async synthesize({ voiceId, text, language, speed }) {
      const res = await call(`/voices/${encodeURIComponent(voiceId)}/synthesize`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, language, speed: speed ?? 1 }),
      });
      const score = res.headers.get('X-Watermark-Score');
      const out: SynthesisResult = {
        audio: Buffer.from(await res.arrayBuffer()),
        sampleRate: Number(res.headers.get('X-Sample-Rate') ?? 24000),
        watermarkScore: score === null || score === '' ? null : Number(score),
        watermarkScheme: res.headers.get('X-Watermark-Scheme') ?? 'perth',
        modelId: res.headers.get('X-Model-Id') ?? 'chatterbox-mtl-v3',
      };
      return out;
    },
    async deleteVoice(voiceId) {
      // 404 = already gone: deletion is idempotent.
      const res = await f(`${base}/voices/${encodeURIComponent(voiceId)}`, { method: 'DELETE', headers, signal: AbortSignal.timeout(60_000) }).catch((err) => {
        throw new ServiceUnavailableError(`voice clone service unreachable: ${(err as Error).message}`);
      });
      if (!res.ok && res.status !== 404) throw new ServiceUnavailableError(`voice clone service delete returned HTTP ${res.status}`);
    },
    async disableVoice(voiceId) {
      await call(`/voices/${encodeURIComponent(voiceId)}/disable`, { method: 'POST' });
    },
  };
}

/** Real client from env, or null when the service is not configured (feature stays dark). */
export function serviceClientFromEnv(env: Record<string, string | undefined> = process.env): CloneServiceClient | null {
  const baseUrl = env.VOICE_CLONE_SERVICE_URL;
  const secret = env.VOICE_CLONE_SERVICE_SECRET;
  if (!baseUrl || !secret) return null;
  return createServiceClient({ baseUrl, secret });
}
