// "I ran" beats to the app-failure-reporter, so a scheduled job that stops running is noticed (it can raise nothing
// itself). The reporter alerts when a job registered in its HEARTBEATS setting goes quiet for twice its interval.
import { usageUrlFrom } from './reporterUsage.js';
import { logger } from './logger.js';

const heartbeatLogger = logger.child({ module: 'heartbeat' });

export interface HeartbeatDeps { env?: Record<string, string | undefined>; fetchImpl?: typeof fetch }

/** True when the beat was accepted. Never throws; off without FAILURE_REPORTER_KEY and in tests. */
export async function postHeartbeat(job: string, deps: HeartbeatDeps = {}): Promise<boolean> {
  const env = deps.env ?? process.env;
  const key = env.FAILURE_REPORTER_KEY;
  if (!key || env.FAILURE_REPORTER_DISABLED === '1' || env.NODE_ENV === 'test' || env.NODE_TEST_CONTEXT) return false;
  try {
    const res = await (deps.fetchImpl ?? fetch)(usageUrlFrom(env.FAILURE_REPORTER_URL), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Report-Key': key },
      body: JSON.stringify({ metric: `heartbeat.${job}`, value: 1 }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) heartbeatLogger.warn({ job, status: res.status }, 'heartbeat not accepted');
    return res.ok;
  } catch (err) {
    heartbeatLogger.warn({ job, err: err instanceof Error ? err.message : String(err) }, 'heartbeat not sent');
    return false;
  }
}
