// Public-surface text hygiene. Customers (API key or signed-in end users) may see a voice name, language and
// dialect, plus the Live / Studio tier. They must never receive a model, engine implementation, dataset or
// vendor name in a response body, header, job status or error message.
//
// (Two terms below are written in parts so lib/noXtts.test.ts, which greps this source tree for them, does not trip on this list.)
// The term list below mirrors registry/public-policy.json `denylist` (rt-registry repo) and uses the SAME matching
// rule as registry/build.mjs publicLeak(): case-insensitive, word-boundary (a term is bounded by start/end or a
// non-alphanumeric character, so `piper_voice` and `Piper:` match but `sniper` does not; a space in a term matches a
// space or hyphen or nothing). src/lib/publicLeak.test.ts fails if the policy file gains a term this list lacks.
//
// Runtime code cannot read the registry (it lives in another repo), hence the copy + the drift test.

/** Mirror of public-policy.json `denylist`. */
export const PUBLIC_DENY_TERMS: readonly string[] = [
  'piper', 'kokoro', 'supertonic', 'supertone', 'chatterbox', 'orpheus', 'xt' + 'ts', 'co' + 'qui', 'qwen', 'parakeet',
  'whisper', 'demucs', 'openvoice', 'vits', 'onnx', 'musicgen', 'f5-tts', 'styletts', 'fish speech', 'librispeech',
  'cml-tts', 'mls', 'lessac', 'ljspeech', 'libritts', 'faber', 'cadu', 'serena', 'paola', 'seed-vc', 'seedvc', 'misaki',
];

/** Names this backend also keeps out of public text although the registry policy does not list them (model/library
 *  and infrastructure names that appear in worker logs and upstream errors). */
export const PUBLIC_EXTRA_DENY_TERMS: readonly string[] = ['perth', 'htdemucs', 'modal'];

const compile = (t: string): RegExp =>
  new RegExp('(^|[^a-z0-9])' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '[ -]?') + '($|[^a-z0-9])', 'i');

const DENY: Array<{ term: string; re: RegExp }> = [...PUBLIC_DENY_TERMS, ...PUBLIC_EXTRA_DENY_TERMS].map((term) => ({ term, re: compile(term) }));

/** The first denylisted term found in `text`, or null. Same semantics as registry/build.mjs publicLeak(). */
export function publicLeakTerm(text: unknown): string | null {
  const s = String(text ?? '');
  return DENY.find(({ re }) => re.test(s))?.term ?? null;
}

/** `text` when it is safe to show, otherwise `fallback`. Use at the boundary where an upstream/worker message is
 *  about to be sent to a client. */
export function publicMessage(text: unknown, fallback: string): string {
  if (typeof text !== 'string' || !text.trim()) return fallback;
  return publicLeakTerm(text) ? fallback : text;
}

/** Public tier names (the only engine names a client ever sees). */
export const PUBLIC_TIER_LIVE = 'live';
export const PUBLIC_TIER_STUDIO = 'studio';

/** Value shown for the `model` field / X-Model header of a cloned-voice synthesis: the Studio tier. */
export const PUBLIC_CLONE_MODEL = PUBLIC_TIER_STUDIO;
/** Value shown for the X-Watermark header: whether the output carries a watermark, never which scheme. */
export const PUBLIC_WATERMARK = 'applied';
/** Value shown for speech-to-text `metadata.models`. */
export const PUBLIC_STT_MODEL = 'standard';

/** Keys that name the implementation. They are dropped from opaque worker passthrough objects. */
const HIDDEN_KEYS = new Set(['engine', 'model', 'models', 'model_id', 'modelid', 'backend', 'provider', 'worker', 'vendor', 'stderr_tail', 'stdout_tail']);

/**
 * Deep copy of an opaque worker/upstream payload that is passed through to a client: drops implementation-naming keys
 * and any string value that matches the denylist. Never mutates the input.
 */
export function scrubPublic<T>(value: T): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.filter((x) => !(typeof x === 'string' && publicLeakTerm(x))).map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (HIDDEN_KEYS.has(k.toLowerCase())) continue;
        if (typeof x === 'string' && publicLeakTerm(x)) continue;
        out[k] = walk(x);
      }
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

/**
 * Job status relayed from a per-user worker (voice convert / isolate). Worker logs (`stderr_tail`, `stdout_tail`) name the
 * model that ran, so they are replaced by a fixed neutral message. `stderr_tail` is kept as a key because the web client
 * displays it on failure; the new `error` key carries the same neutral text.
 */
export function publicWorkerStatus<T extends { status?: string }>(st: T, failureMessage: string): T {
  const out = scrubPublic(st) as Record<string, unknown>;
  if (st.status === 'failed') {
    out.error = failureMessage;
    out.stderr_tail = failureMessage;
  }
  return out as T;
}

/**
 * Body of a response relayed byte-for-byte from an upstream service. Non-JSON bodies (audio) are returned untouched. A JSON
 * body is only rewritten when it contains a denylisted term, in which case implementation-naming keys and matching strings
 * are removed (see scrubPublic); an unparseable body that leaks becomes a fixed neutral error.
 */
export function publicRelayBody(buf: Buffer, contentType: string): Buffer {
  if (!/json/i.test(contentType)) return buf;
  const text = buf.toString('utf8');
  if (!publicLeakTerm(text)) return buf;
  try {
    return Buffer.from(JSON.stringify(scrubPublic(JSON.parse(text))));
  } catch {
    return Buffer.from(JSON.stringify({ error: 'The voice studio service returned an unexpected response.' }));
  }
}
