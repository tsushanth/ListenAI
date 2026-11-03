/**
 * Owner signals for the failure paths that jobFailureSignal.ts does not cover: music / sound-effect / dub / isolate / STT jobs,
 * provider-wide outages (vendor auth, credit, quota, unreachable), payment webhooks, startup config and the job monitor.
 *
 * Same rules as jobFailureSignal.ts: the message is ONLY a stable class name (one email per class per hour), the stack is
 * blank, context holds fixed labels and counts only (never user ids, emails, text, voice names, file names or raw provider
 * messages), fire-and-forget, and a no-op in tests / without FAILURE_REPORTER_KEY.
 */
import { reportFailure } from './failureReporter.js';
import { classError, type ReportFn } from './jobFailureSignal.js';

export type MediaJobKind = 'music' | 'sound_effect' | 'dub' | 'voice_isolate' | 'stt';

function emit(report: ReportFn, flow: string, cls: string, ctx: Record<string, string> = {}): void {
  try { report(flow, classError(cls), ctx); } catch { /* signalling must never break the caller */ }
}

/** One music / sound-effect / dub / isolate / STT job ended 'failed'. */
export function signalMediaJobFailed(kind: MediaJobKind, ctx: Record<string, string> = {}, report: ReportFn = reportFailure): void {
  emit(report, `${kind}_job_failed`, `${kind.toUpperCase()}_JOB_FAILED`, ctx);
}

/** A stuck-job reaper pass marked rows failed (one aggregate signal per pass). */
export function signalStuckJobsReaped(kind: MediaJobKind, count: number, report: ReportFn = reportFailure): void {
  if (count <= 0) return;
  emit(report, `${kind}_job_reaper`, `${kind.toUpperCase()}_JOB_STUCK`, { reaped: String(count) });
}

export type ProviderFailureClass = 'AUTH_REJECTED' | 'CREDIT_EXHAUSTED' | 'RATE_LIMITED' | 'UNAVAILABLE' | 'TIMEOUT';

/** Map an upstream HTTP status (or network error code) to a provider failure class, or null when it is not provider-wide. */
export function classifyProviderStatus(status: number | undefined | null, code?: string | null): ProviderFailureClass | null {
  if (status === 401 || status === 403) return 'AUTH_REJECTED';
  if (status === 402) return 'CREDIT_EXHAUSTED';
  if (status === 429) return 'RATE_LIMITED';
  if (typeof status === 'number' && status >= 500) return 'UNAVAILABLE';
  if (code === 'ETIMEDOUT' || code === 'ECONNABORTED') return 'TIMEOUT';
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ENOTFOUND') return 'UNAVAILABLE';
  return null;
}

/** A vendor (elevenlabs, anthropic, tts_gateway, stt_gateway, modal_worker...) is failing for everyone: ONE alert per provider+class. */
export function signalProviderFailure(provider: string, cls: ProviderFailureClass, report: ReportFn = reportFailure): void {
  const p = provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  emit(report, 'provider_failure', `PROVIDER_${p}_${cls}`, { provider, class: cls });
}

/** Convenience for catch blocks: classify and signal only when the failure is provider-wide. */
export function signalProviderFailureFromStatus(provider: string, status: number | undefined | null, code?: string | null, report: ReportFn = reportFailure): void {
  const cls = classifyProviderStatus(status, code);
  if (cls && cls !== 'RATE_LIMITED') signalProviderFailure(provider, cls, report);
}

export type WebhookFailure = 'SIGNATURE_INVALID' | 'HANDLER_FAILED' | 'SECRET_MISSING' | 'USER_UNRESOLVED';

/** Stripe (payment / subscription) webhook problem. SIGNATURE_INVALID means the endpoint secret is wrong or a forged call. */
export function signalWebhookFailure(cls: WebhookFailure, ctx: Record<string, string> = {}, report: ReportFn = reportFailure): void {
  emit(report, 'stripe_webhook', `STRIPE_WEBHOOK_${cls}`, ctx);
}

/** An STT worker fallback / failure worth knowing about (labels only). */
export function signalSttWorkerFailure(reason: string, report: ReportFn = reportFailure): void {
  const r = reason.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'UNKNOWN';
  emit(report, 'stt_worker', `STT_WORKER_${r}`, { reason });
}

/** A background loop whose failure used to be a log line only (e.g. billing usage drain). */
export function signalLoopFailure(name: string, report: ReportFn = reportFailure): void {
  emit(report, 'background_loop', `LOOP_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_FAILED`, { loop: name });
}

/** Required env vars missing at boot. Names only. */
export function signalConfigMissing(names: string[], report: ReportFn = reportFailure): void {
  if (names.length === 0) return;
  emit(report, 'startup_config', 'CONFIG_MISSING', { missing: names.join(',').slice(0, 200) });
}

/** Env vars that must be set in production for the product to work. Names only; checked once at boot. */
export const REQUIRED_PROD_ENV = ['STRIPE_WEBHOOK_SECRET', 'STRIPE_SECRET_KEY', 'PUBSUB_PUSH_SECRET', 'TTS_GATEWAY_ADMIN_SECRET', 'FAILURE_REPORTER_KEY'] as const;

export function missingProdEnv(env: NodeJS.ProcessEnv = process.env, names: readonly string[] = REQUIRED_PROD_ENV): string[] {
  return names.filter((n) => !env[n]);
}
