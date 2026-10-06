// TTS transport for dubbing. Two backends, chosen by DUB_TTS_BACKEND (default gpu):
//   gpu  - ReadAloud's own self-hosted TTS route (ttsProvider -> GPU Modal service `readaloud-tts`, CPU worker as the
//          provider's fallback). Piper dubbing voices (es-pilot-*, fr-fr-mls-*) are served by tts-service-modal/app.py
//          from the Modal volume `house-voices`; English stays Kokoro there. Needs the tts-service-modal redeploy.
//   cpu  - the realtime-tts Piper CPU worker (Fly piper-tts-sjc) through the gateway: POST <gateway>/tts/authorize
//          {key, engine:"piper"} -> {token, http_url}, then POST http_url {text, voice:"custom:<id>", speed, format:"pcm_24000"}
//          -> raw PCM16 24 kHz. Needs no readaloud-tts redeploy but needs a gateway API key (DUB_PIPER_API_KEY, else
//          STT_API_KEY) and the house voices present in that worker's voice storage. English still goes through the
//          provider (Kokoro), since the CPU Piper worker path is for the Piper (es/fr) voices.
// Piper speed is length_scale / speed on both backends, so the measured-duration refit works the same on either.

import { encodeWavPcm16 } from './dubTiming.js';
import type { DubLanguage } from './dubLanguages.js';
import type { SynthFn } from './dubPipeline.js';

export type DubTtsBackend = 'gpu' | 'cpu';

export function getDubTtsBackend(env: Record<string, string | undefined> = process.env): DubTtsBackend {
  return (env.DUB_TTS_BACKEND ?? '').trim().toLowerCase() === 'cpu' ? 'cpu' : 'gpu';
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
  if (getDubTtsBackend(env) !== 'cpu' || lang.engine !== 'piper') return viaProvider;

  const apiKey = env.DUB_PIPER_API_KEY || deps.fallbackApiKey;
  if (!apiKey) throw new Error('DUB_TTS_BACKEND=cpu needs a gateway API key: set DUB_PIPER_API_KEY (or STT_API_KEY) for the Piper worker.');
  const client = new PiperWorkerClient({
    gatewayUrl: env.DUB_PIPER_GATEWAY_URL || deps.defaultGatewayUrl || 'https://api.readaloudai.org',
    apiKey,
    fetchImpl: deps.fetchImpl,
  });
  return (text, voice, speed) => client.synth(text, voice, speed);
}
