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
    async deleteVoice(voiceId, _language) {
      // 404 = already gone: deletion is idempotent.
      const res = await f(`${base}/voices/${encodeURIComponent(voiceId)}`, { method: 'DELETE', headers, signal: AbortSignal.timeout(60_000) }).catch((err) => {
        throw new ServiceUnavailableError(`voice clone service unreachable: ${(err as Error).message}`);
      });
      if (!res.ok && res.status !== 404) throw new ServiceUnavailableError(`voice clone service delete returned HTTP ${res.status}`);
    },
    async disableVoice(voiceId, _language) {
      await call(`/voices/${encodeURIComponent(voiceId)}/disable`, { method: 'POST' });
    },
    /** Starts a cold container early (a GPU app takes a while to come up); the answer is ignored. */
    async warm() {
      try { await f(`${base}/health`, { headers, signal: AbortSignal.timeout(timeout) }); } catch { /* best effort */ }
    },
  };
}

/**
 * Two serving apps behind one client: voices in `mlLanguages` live on the multilingual app, everything else stays on the primary app.
 * Reference analysis and speaker similarity run on the multilingual app by default (same metrics and thresholds, far shorter cold start;
 * VOICE_CLONE_ANALYZE_ON_PRIMARY=true puts them back on the primary). A voice's language
 * is known at creation, synthesis, deletion and takedown, so each call goes to exactly one app; when the language is unknown the
 * call goes to both and any failure is reported (a deletion must never be silently half done).
 */
export function createRoutingServiceClient(opts: {
  primary: CloneServiceClient; ml: CloneServiceClient; mlLanguages: ReadonlySet<string>;
  /** Where the reference gate and speaker similarity run. 'ml' (default): the multilingual app, falling back to the primary if it is down. */
  analyzeOn?: 'ml' | 'primary';
  now?: () => number;
}): CloneServiceClient {
  const { primary, ml, mlLanguages } = opts;
  const analyzeOn = opts.analyzeOn ?? 'ml';
  const now = opts.now ?? Date.now;
  const pick = (language?: string) => (language && mlLanguages.has(language) ? ml : primary);
  const both = async (fn: (c: CloneServiceClient) => Promise<void>) => { await Promise.all([fn(primary), fn(ml)]); };
  // The multilingual app measures with the same code and the same speaker embedding as the primary (identical numbers on the same
  // clips, checked 2026-11-16), and it starts in about 20 s where the primary can take minutes when GPUs are busy.
  const gate = async <T>(fn: (c: CloneServiceClient) => Promise<T>): Promise<T> => {
    if (analyzeOn === 'primary') return fn(primary);
    try { return await fn(ml); } catch (err) {
      if (err instanceof ServiceUnavailableError) return fn(primary);
      throw err;
    }
  };
  const lastWarm = new Map<CloneServiceClient, number>();
  const warmLog = new Map<CloneServiceClient, number[]>();
  const WARM_GAP_MS = 90_000, WARM_PER_HOUR = 20;
  const warmOne = (c: CloneServiceClient): Promise<void> => {
    const t = now();
    if (t - (lastWarm.get(c) ?? -Infinity) < WARM_GAP_MS || !c.warm) return Promise.resolve();
    const recent = (warmLog.get(c) ?? []).filter((x) => t - x < 3_600_000);
    if (recent.length >= WARM_PER_HOUR) return Promise.resolve(); // a GPU wake-up costs money: bounded per hour per app
    recent.push(t); warmLog.set(c, recent); lastWarm.set(c, t);
    return c.warm().catch(() => undefined);
  };
  return {
    analyze: (audio, filename) => gate((c) => c.analyze(audio, filename)),
    similarity: (a, b) => gate((c) => c.similarity(a, b)),
    createVoice: (p) => pick(p.language).createVoice(p),
    synthesize: (p) => pick(p.language).synthesize(p),
    deleteVoice: (voiceId, language) => (language ? pick(language).deleteVoice(voiceId, language) : both((c) => c.deleteVoice(voiceId))),
    disableVoice: async (voiceId, language) => {
      if (language) return pick(language).disableVoice(voiceId, language);
      // unknown language: the app that does not hold the voice answers 404, which is not a failure as long as one app took the takedown
      const r = await Promise.allSettled([primary.disableVoice(voiceId), ml.disableVoice(voiceId)]);
      if (r.every((x) => x.status === 'rejected')) throw (r[0] as PromiseRejectedResult).reason;
    },
    // At most once per 90 s and 20 times an hour per app, so repeated calls cannot keep GPUs running.
    warm: async (language) => { await (language ? warmOne(pick(language)) : Promise.all([warmOne(primary), warmOne(ml)]).then(() => undefined)); },
  };
}

const DEFAULT_ML_LANGUAGES = 'de,fr,es,pt,it,ja,pl,ru';

/** Real client from env, or null when the service is not configured (feature stays dark). */
export function serviceClientFromEnv(env: Record<string, string | undefined> = process.env): CloneServiceClient | null {
  const baseUrl = env.VOICE_CLONE_SERVICE_URL;
  const secret = env.VOICE_CLONE_SERVICE_SECRET;
  const mlUrl = env.VOICE_CLONE_ML_SERVICE_URL;
  const mlSecret = env.VOICE_CLONE_ML_SERVICE_SECRET;
  const primary = baseUrl && secret ? createServiceClient({ baseUrl, secret }) : null;
  const ml = mlUrl && mlSecret ? createServiceClient({ baseUrl: mlUrl, secret: mlSecret }) : null;
  if (primary && ml) {
    const mlLanguages = new Set((env.VOICE_CLONE_ML_LANGUAGES ?? DEFAULT_ML_LANGUAGES).split(',').map((x) => x.trim()).filter(Boolean));
    return createRoutingServiceClient({ primary, ml, mlLanguages, analyzeOn: env.VOICE_CLONE_ANALYZE_ON_PRIMARY === 'true' ? 'primary' : 'ml' });
  }
  return primary ?? ml;
}
