// TTS transport for dubbing. Three backends, chosen by DUB_TTS_BACKEND:
//   modal-cpu (DEFAULT, cheapest) - the dedicated CPU-only Modal function `readaloud-dub-piper`
//          (tts-service-modal/dub_piper.py): Piper on 4 CPU cores, scale-to-zero, reads the Modal volume `house-voices`,
//          ~$0.0003 per source minute. Same /synthesize contract as readaloud-tts, Bearer shared secret. Needs
//          DUB_PIPER_MODAL_URL and DUB_PIPER_MODAL_SECRET (the secret value is provisioned by the owner; it is NOT created
//          by this repo). No gateway key and no Fly Piper-worker voices needed.
//   gpu  - ReadAloud's own self-hosted TTS route (ttsProvider -> GPU Modal service `readaloud-tts`, CPU worker as the
//          provider's fallback). Piper voices there run inside the T4 container (about 5x the cost). Needs the
//          tts-service-modal redeploy.
//   cpu  - the realtime-tts Piper CPU worker (Fly piper-tts-sjc) through the gateway: POST <gateway>/tts/authorize
//          {key, engine:"piper"} -> {token, http_url}, then POST http_url {text, voice:"custom:<id>", speed, format:"pcm_24000"}
//          -> raw PCM16 24 kHz. Needs a gateway API key (DUB_PIPER_API_KEY, else STT_API_KEY) and the house voices in
//          that worker's voice storage.
// English (Kokoro) always goes through the provider route. Piper speed is length_scale / speed on every backend, so the
// measured-duration refit works the same on each.

import { encodeWavPcm16 } from './dubTiming.js';
import type { DubLanguage } from './dubLanguages.js';
import type { SynthFn } from './dubPipeline.js';

export type DubTtsBackend = 'modal-cpu' | 'gpu' | 'cpu';

export function getDubTtsBackend(env: Record<string, string | undefined> = process.env): DubTtsBackend {
  const v = (env.DUB_TTS_BACKEND ?? '').trim().toLowerCase();
  return v === 'cpu' ? 'cpu' : v === 'gpu' ? 'gpu' : 'modal-cpu';
}

export interface PiperWorkerOptions {
  gatewayUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  retryDelayMs?: number;
}

export class PiperWorkerClient {
  private token: string | null = null;
  private httpUrl: string | null = null;
  private readonly f: typeof fetch;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  constructor(private readonly o: PiperWorkerOptions) {
    this.f = o.fetchImpl ?? fetch;
    this.maxRetries = o.maxRetries ?? 4;
    this.retryDelayMs = o.retryDelayMs ?? 1000;
  }

  private async authorize(): Promise<void> {
    const r = await this.f(`${this.o.gatewayUrl.replace(/\/$/, '')}/tts/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: this.o.apiKey, engine: 'piper' }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(`Piper gateway authorize failed with HTTP ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
    const b = (await r.json().catch(() => null)) as { token?: string; http_url?: string } | null;
    if (!b?.token || !b.http_url) throw new Error('Piper gateway authorize returned no token/http_url (piper engine not available?)');
    this.token = b.token;
    this.httpUrl = b.http_url;
  }

  /** WAV (24 kHz mono PCM16) for `text` in the Piper house voice `voiceId`. */
  async synth(text: string, voiceId: string, speed: number): Promise<Buffer> {
    let reauthorized = false;
    for (let attempt = 0; ; attempt++) {
      if (!this.token || !this.httpUrl) await this.authorize();
      const r = await this.f(this.httpUrl!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
        body: JSON.stringify({ text, voice: `custom:${voiceId}`, speed, format: 'pcm_24000' }),
        signal: AbortSignal.timeout(120_000),
      });
      if (r.ok) {
        const pcmBuf = Buffer.from(await r.arrayBuffer());
        const n = Math.floor(pcmBuf.length / 2);
        const samples = new Int16Array(n);
        for (let i = 0; i < n; i++) samples[i] = pcmBuf.readInt16LE(i * 2);
        return encodeWavPcm16(samples, 24000);
      }
      if (r.status === 401 && !reauthorized) { reauthorized = true; this.token = null; continue; }
      if (r.status === 503 && attempt < this.maxRetries) {
        const ra = Number(r.headers.get('Retry-After'));
        await new Promise((res) => setTimeout(res, Number.isFinite(ra) && ra > 0 ? ra * 1000 : this.retryDelayMs));
        continue;
      }
      const detail = (await r.text().catch(() => '')).slice(0, 200);
      throw new Error(r.status === 503 ? `Piper worker at capacity (503) after ${attempt + 1} attempts` : `Piper worker returned HTTP ${r.status}: ${detail}`);
    }
  }
}

export interface ModalPiperOptions {
  url: string;
  secret: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  retryDelayMs?: number;
}

/** Client for the dedicated CPU Piper Modal function (tts-service-modal/dub_piper.py). */
export class ModalPiperClient {
  private readonly f: typeof fetch;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  constructor(private readonly o: ModalPiperOptions) {
    this.f = o.fetchImpl ?? fetch;
    this.maxRetries = o.maxRetries ?? 4;
    this.retryDelayMs = o.retryDelayMs ?? 2000;
  }

  /** WAV (24 kHz mono PCM16) straight from the function. A cold start can take minutes, hence the long timeout and retries. */
  async synth(text: string, voiceId: string, speed: number, language: string): Promise<Buffer> {
    const url = `${this.o.url.replace(/\/$/, '')}/synthesize`;
    for (let attempt = 0; ; attempt++) {
      let status = 0;
      let detail = '';
      try {
        const r = await this.f(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.o.secret}` },
          body: JSON.stringify({ text, voice_id: voiceId, language, speed }),
          signal: AbortSignal.timeout(300_000),
        });
        if (r.ok) return Buffer.from(await r.arrayBuffer());
        status = r.status;
        detail = (await r.text().catch(() => '')).slice(0, 200);
      } catch (err) {
        detail = (err as Error).message; // network error / timeout: treated as transient
      }
      const transient = status === 0 || status === 429 || status >= 500;
      if (transient && attempt < this.maxRetries) {
        await new Promise((res) => setTimeout(res, this.retryDelayMs));
        continue;
      }
      throw new Error(`Dubbing Piper function returned HTTP ${status || 'error'}: ${detail}`);
    }
  }
}

export interface DubSynthDeps {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  /** The ttsProvider (self-hosted GPU/CPU route) call; used for the gpu backend and for non-Piper languages. */
  providerSynth: (lang: DubLanguage, text: string, voiceId: string, speed: number) => Promise<Buffer>;
  /** Default gateway URL when DUB_PIPER_GATEWAY_URL is unset (the STT gateway URL, same host). */
  defaultGatewayUrl?: string;
  /** Fallback key when DUB_PIPER_API_KEY is unset. */
  fallbackApiKey?: string;
}

export async function createDubSynth(lang: DubLanguage, deps: DubSynthDeps): Promise<SynthFn> {
  const env = deps.env ?? process.env;
  const viaProvider: SynthFn = (text, voice, speed) => deps.providerSynth(lang, text, voice, speed);
  const backend = getDubTtsBackend(env);
  if (lang.engine !== 'piper' || backend === 'gpu') return viaProvider;

  if (backend === 'modal-cpu') {
    const url = env.DUB_PIPER_MODAL_URL;
    const secret = env.DUB_PIPER_MODAL_SECRET;
    if (!url || !secret) {
      throw new Error('DUB_TTS_BACKEND=modal-cpu (the default) needs DUB_PIPER_MODAL_URL and DUB_PIPER_MODAL_SECRET for the readaloud-dub-piper Modal function; or set DUB_TTS_BACKEND=gpu|cpu.');
    }
    const client = new ModalPiperClient({ url, secret, fetchImpl: deps.fetchImpl });
    return (text, voice, speed) => client.synth(text, voice, speed, lang.code);
  }

  const apiKey = env.DUB_PIPER_API_KEY || deps.fallbackApiKey;
  if (!apiKey) throw new Error('DUB_TTS_BACKEND=cpu needs a gateway API key: set DUB_PIPER_API_KEY (or STT_API_KEY) for the Piper worker.');
  const client = new PiperWorkerClient({
    gatewayUrl: env.DUB_PIPER_GATEWAY_URL || deps.defaultGatewayUrl || 'https://api.readaloudai.org',
    apiKey,
    fetchImpl: deps.fetchImpl,
  });
  return (text, voice, speed) => client.synth(text, voice, speed);
}
