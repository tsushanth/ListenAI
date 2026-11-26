// "Run it now" on the developers page: one small speech call with the key the person has just created, made for them so the
// first call is one press. The text is fixed (the caller cannot choose it), it only runs while the account has free credits
// or is complimentary, and each attempt is recorded with its status. The key is used for this one call and never stored or
// logged.

/** Same words as the curl example the page shows. */
export const FIRST_CALL_TEXT = 'Hello from ReadAloud.';
export const FIRST_CALL_BODY = { model: 'tts-1', voice: 'readaloud-default', input: FIRST_CALL_TEXT, response_format: 'mp3' };
const KEY_RE = /^rtts_[A-Za-z0-9_-]{8,200}$/;
const TIMEOUT_MS = 60_000;
const MAX_AUDIO_BYTES = 1_000_000;
const PER_USER_LIMIT = 5;
const WINDOW_MS = 10 * 60_000;

export interface FirstCallRecord { user_id: string; ok: boolean; status: number }
export interface FirstCallDeps {
  /** True when this call costs the person nothing: complimentary account, or enough free credits left. */
  isFree(userId: string): Promise<boolean>;
  record(row: FirstCallRecord): Promise<void>;
  fetchImpl: typeof fetch;
  now(): number;
}

export type FirstCallResult =
  | { http: 400 | 409 | 429; body: { error: string; code: string } }
  | { http: 200; body: { ok: true; status: number; characters: number; audio_base64: string } }
  | { http: 200; body: { ok: false; status: number; characters: number; message: string } };

/** Plain words for a failed call. Fixed texts: the service's own error body is never passed on. */
export function firstCallMessage(status: number): string {
  if (status === 401 || status === 403) return 'The key was not accepted. Create a new key and try again.';
  if (status === 402) return 'Your free credits are used up. Add a payment method to keep going.';
  if (status === 429) return 'Too many requests just now. Wait a minute and try again.';
  if (status === 0) return 'The speech service did not answer in time. Try again in a minute.';
  return 'The speech service could not complete the call. Try again in a minute.';
}

export function createFirstCall(deps: FirstCallDeps, gatewayUrl: () => string = () => process.env.REALTIME_TTS_GATEWAY_URL || 'https://api.readaloudai.org') {
  const attempts = new Map<string, number[]>();

  const record = async (row: FirstCallRecord) => {
    try { await deps.record(row); } catch (err) { console.warn('[firstCall] could not record the step:', err instanceof Error ? err.message : String(err)); }
  };

  return async function firstCall(userId: string, key: unknown): Promise<FirstCallResult> {
    if (typeof key !== 'string' || !KEY_RE.test(key)) return { http: 400, body: { error: 'A ReadAloud API key is required.', code: 'invalid_key' } };
    const now = deps.now();
    const recent = (attempts.get(userId) ?? []).filter((t) => now - t < WINDOW_MS);
    if (recent.length >= PER_USER_LIMIT) return { http: 429, body: { error: 'Too many test calls. Wait a few minutes.', code: 'rate_limited' } };
    recent.push(now);
    attempts.set(userId, recent);
    if (attempts.size > 5000) attempts.clear();

    if (!(await deps.isFree(userId))) {
      await record({ user_id: userId, ok: false, status: 409 });
      return { http: 409, body: { error: 'This test only runs on free credits, and none are left. Use the command below instead.', code: 'no_free_credits' } };
    }

    let status = 0;
    let audio: Buffer | null = null;
    try {
      const res = await deps.fetchImpl(`${gatewayUrl()}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(FIRST_CALL_BODY),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      status = res.status;
      if (res.ok) {
        const bytes = Buffer.from(await res.arrayBuffer());
        if (bytes.length > 0 && bytes.length <= MAX_AUDIO_BYTES) audio = bytes;
        else status = 502;
      }
    } catch {
      status = 0;
      audio = null;
    }
    await record({ user_id: userId, ok: !!audio, status });
    if (audio) return { http: 200, body: { ok: true, status, characters: FIRST_CALL_TEXT.length, audio_base64: audio.toString('base64') } };
    return { http: 200, body: { ok: false, status, characters: FIRST_CALL_TEXT.length, message: firstCallMessage(status) } };
  };
}
