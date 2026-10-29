/**
 * Owner signal for background-job failures (TTS, cloned-voice TTS, voice conversion).
 *
 * Rules (so the alert email stays useful and never leaks anything):
 *  - The message sent is ONLY a stable class name (TTS_TIMEOUT, STUCK_JOB, ...), so the reporter's per-fingerprint
 *    hourly dedupe collapses a burst of the same problem into one email.
 *  - The stack is blanked: the reporter fingerprints on the top stack frame, which would otherwise differ by call site.
 *  - Context holds enum-like labels and counts only. Never user ids, emails, text, voice names or file names, and
 *    never the raw provider error message (it can echo request content). The raw message is used locally to pick the
 *    class and is not forwarded.
 *  - Fire-and-forget: reportFailure never throws and is a no-op in tests / without FAILURE_REPORTER_KEY.
 */
import { reportFailure } from './failureReporter.js';

export type JobFailureClass =
  | 'TTS_TIMEOUT'
  | 'TTS_SERVICE_404'
  | 'TTS_RATE_LIMITED'
  | 'CLONE_INPUT_INVALID'
  | 'STUCK_JOB'
  | 'VOICE_CONVERSION_FAILED'
  | 'VOICE_CONVERT_DEPLOY_FAILED'
  | 'VOICE_CONVERSION_STUCK'
  | 'UNKNOWN';

export type ReportFn = (flow: string, err: unknown, context?: Record<string, string>) => void;

export type JobKind = 'tts' | 'clone';

/**
 * Pick the class from the raw error text. Heuristic by design: the TTS stack surfaces axios/fetch messages, so the
 * match is on the stable fragments those produce ("timeout of 120000ms exceeded", "status code 404", ...).
 * The text is never forwarded to the reporter.
 */
export function classifyFailure(rawMessage: string | undefined | null, opts: { stuck?: boolean; kind?: JobKind } = {}): JobFailureClass {
  if (opts.stuck) return 'STUCK_JOB';
  const m = (rawMessage ?? '').toLowerCase();
  if (/invalid[^.\n]{0,40}reference|reference[^.\n]{0,40}(invalid|unusable|unreadable|rejected|corrupt|too short|cannot be used)|reference audio/.test(m)) {
    return 'CLONE_INPUT_INVALID';
  }
  if (/timed out|timeout|etimedout|econnaborted|aborted due to/.test(m)) return 'TTS_TIMEOUT';
  if (/\b429\b|rate limit|too many requests/.test(m)) return 'TTS_RATE_LIMITED';
  if (/\b404\b/.test(m)) return 'TTS_SERVICE_404';
  // The clone service answers 400/422 for audio it cannot read.
  if (opts.kind === 'clone' && /\b(400|422)\b/.test(m)) return 'CLONE_INPUT_INVALID';
  return 'UNKNOWN';
}

/** Coarse size bucket so the email shows scale without carrying the exact count. */
export function charsBucket(n: unknown): string {
  const c = typeof n === 'number' && Number.isFinite(n) ? n : -1;
  if (c < 0) return 'unknown';
  if (c < 500) return '<500';
  if (c < 2000) return '500-2k';
  if (c < 10000) return '2k-10k';
  if (c < 50000) return '10k-50k';
  return '50k+';
}

/** Provider/backend as a fixed label. Raw model or voice ids are never used as a value. */
export function providerLabel(modelId: unknown, kind: JobKind): string {
  if (kind === 'clone') return 'chatterbox';
  const m = typeof modelId === 'string' ? modelId : '';
  if (m === 'eleven_multilingual_v2' || m === 'elevenlabs') return 'elevenlabs';
  if (m === 'kokoro-82m' || m === 'kokoro') return 'selfhosted';
  return 'default';
}

/** An Error whose message is exactly the class and whose stack is empty (stable fingerprint). */
function classError(cls: string): Error {
  const e = new Error(cls);
  e.stack = '';
  return e;
}

export interface TtsFailureSignal {
  kind: JobKind;
  /** Raw error text, used only for classification. */
  rawMessage?: string | null;
  /** True for the STUCK_JOB watchdog path. */
  stuck?: boolean;
  modelId?: unknown;
  attempts: number;
  charCount?: unknown;
}

/** Report one permanently failed tts/clone job. Returns the class that was reported. */
export function signalTtsJobFailure(s: TtsFailureSignal, report: ReportFn = reportFailure): JobFailureClass {
  const cls = classifyFailure(s.rawMessage, { stuck: s.stuck, kind: s.kind });
  try {
    report(s.kind === 'clone' ? 'clone_job_failed' : 'tts_job_failed', classError(cls), {
      provider: providerLabel(s.modelId, s.kind),
      attempts: String(s.attempts),
      chars_bucket: charsBucket(s.charCount),
    });
  } catch { /* signalling must never break job handling */ }
  return cls;
}

/** One voice-conversion job failed at the provider (reported when the row first becomes 'failed'). */
export function signalVoiceConversionFailure(report: ReportFn = reportFailure): void {
  try { report('voice_conversion_failed', classError('VOICE_CONVERSION_FAILED'), {}); } catch { /* ignore */ }
}

/** A user's voice-convert deployment failed to come up. */
export function signalVoiceConvertDeployFailure(report: ReportFn = reportFailure): void {
  try { report('voice_convert_deploy_failed', classError('VOICE_CONVERT_DEPLOY_FAILED'), {}); } catch { /* ignore */ }
}

/** One aggregate signal per reaper pass. */
export function signalVoiceConversionsReaped(count: number, report: ReportFn = reportFailure): void {
  try { report('voice_conversion_reaper', classError('VOICE_CONVERSION_STUCK'), { reaped: String(count) }); } catch { /* ignore */ }
}
