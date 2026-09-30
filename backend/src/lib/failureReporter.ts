/**
 * Sends backend failures to the unified app-failure-reporter Worker (dedupes and emails).
 * Fire-and-forget: never throws, never blocks a request. Set FAILURE_REPORTER_DISABLED=1 to silence (tests/dev).
 * Never pass user content (transcripts, note text, emails) as message or context.
 */
const ENDPOINT = process.env.FAILURE_REPORTER_URL || 'https://app-failure-reporter.t-sushanth.workers.dev/v1/report';
const KEY = process.env.FAILURE_REPORTER_KEY || 'afr_9adcdf8324b13e8e5cd9cd1eb178b55c';
const APP_VERSION = process.env.FLY_IMAGE_REF || process.env.K_REVISION || process.env.npm_package_version || 'unknown';
const DISABLED = process.env.FAILURE_REPORTER_DISABLED === '1' || process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development';

type Kind = 'crash' | 'failure' | 'backend_error';

async function post(kind: Kind, flow: string, err: unknown, context: Record<string, string>, timeoutMs: number): Promise<void> {
  if (DISABLED) return;
  try {
    const e = err instanceof Error ? err : new Error(String(err));
    await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Report-Key': KEY },
      body: JSON.stringify({ kind, platform: 'backend', version: APP_VERSION, flow, message: e.message || e.name, stack: e.stack ?? '', context }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch { /* reporting must never cause a failure of its own */ }
}

/** A handled server error (5xx). Path only: never log query strings, they can carry tokens. */
export function reportBackendError(req: { method: string; path?: string }, err: unknown, statusCode: number): void {
  if (statusCode < 500) return;
  void post('backend_error', `${req.method} ${req.path ?? ''}`, err, { status: String(statusCode) }, 5000);
}

/** A background job or flow failed (worker, queue, cron). */
export function reportFailure(flow: string, err: unknown, context: Record<string, string> = {}): void {
  void post('failure', flow, err, context, 5000);
}

/** Process is about to die: await this before process.exit so the email actually goes out. */
export function reportCrash(flow: string, err: unknown): Promise<void> {
  return post('crash', flow, err, {}, 2500);
}
