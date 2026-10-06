// ASR for consent verification via the existing STT path: the realtime-tts gateway mints a short-lived
// token (POST /stt/authorize with STT_API_KEY) and the worker transcribes the raw bytes (POST /v1/stt).
// Same contract as routes/dub.ts and routes/stt.ts; duplicated here (small) rather than editing dub.ts,
// which another change is modifying.
import type { AsrClient } from './types.js';

export function createGatewayAsr(opts: { gatewayUrl: string; apiKey: string; fetchImpl?: typeof fetch }): AsrClient {
  const f = opts.fetchImpl ?? fetch;
  return {
    async transcribe(audio, mimeType, language) {
      const auth = await f(`${opts.gatewayUrl}/stt/authorize`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: opts.apiKey, mode: 'batch' }), signal: AbortSignal.timeout(10_000),
      });
      if (!auth.ok) throw new Error(`STT authorize failed: HTTP ${auth.status}`);
      const { token, url } = (await auth.json()) as { token?: string; url?: string };
      if (!token || !url) throw new Error('STT authorize returned an unexpected response');
      const qs = new URLSearchParams();
      if (language) qs.set('language', language);
      const res = await f(`${url}/v1/stt?${qs.toString()}`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': mimeType || 'application/octet-stream' },
        body: new Uint8Array(audio), signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`STT worker returned HTTP ${res.status}`);
      const body = (await res.json()) as { text?: string; segments?: Array<{ text: string }> };
      if (typeof body.text === 'string') return body.text;
      if (Array.isArray(body.segments)) return body.segments.map((s) => s.text).join(' ');
      throw new Error('STT worker returned an unexpected response shape');
    },
  };
}

export function asrFromEnv(env: Record<string, string | undefined> = process.env): AsrClient | null {
  const apiKey = env.STT_API_KEY;
  if (!apiKey) return null;
  return createGatewayAsr({ gatewayUrl: env.STT_GATEWAY_URL || 'https://api.readaloudai.org', apiKey });
}
