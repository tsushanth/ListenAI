// Pushes today's headline API metrics to the app-failure-reporter Worker (POST /v1/usage), so its existing
// App/API Usage table fills. Idempotent per app/day/metric on the Worker side, so repeating it is harmless.
// Never throws: it runs on a timer next to billing and must not disturb it.
import { buildDashboard, defaultDashboardDeps, parseExcludeEmails, type Totals } from './adminDashboard.js';
import { logger } from './logger.js';

const reporterLogger = logger.child({ module: 'reporter-usage' });

export interface HeadlineMetric { metric: string; value: number }
export interface PushDeps { totals(): Promise<Totals | null>; post(day: string, items: HeadlineMetric[]): Promise<void>; now(): Date }

export function headlineMetrics(t: Totals): HeadlineMetric[] {
  return [
    { metric: 'api.accounts', value: t.accounts },
    { metric: 'api.new_accounts', value: t.newAccounts },
    { metric: 'api.kokoro_chars', value: t.kokoroChars },
    { metric: 'api.piper_chars', value: t.piperChars },
    { metric: 'api.free_chars', value: t.freeCharsUsed },
    { metric: 'api.stt_minutes', value: Math.round(t.sttMinutes * 10) / 10 },
    { metric: 'api.paid_customers', value: t.paidCustomers },
  ];
}

export async function pushHeadlineMetrics(deps: PushDeps): Promise<{ pushed: number }> {
  try {
    const t = await deps.totals();
    if (!t) return { pushed: 0 };
    const items = headlineMetrics(t);
    await deps.post(deps.now().toISOString().slice(0, 10), items);
    return { pushed: items.length };
  } catch (err) {
    reporterLogger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Could not push headline metrics (non-critical)');
    return { pushed: 0 };
  }
}

const REPORT_URL = process.env.FAILURE_REPORTER_URL || 'https://app-failure-reporter.t-sushanth.workers.dev/v1/report';
const USAGE_URL = REPORT_URL.replace(/\/v1\/report\/?$/, '/v1/usage');

export const defaultPushDeps: PushDeps = {
  now: () => new Date(),
  async totals() {
    const d = await buildDashboard(defaultDashboardDeps, { range: '24h', excludeEmails: parseExcludeEmails(process.env.ADMIN_EXCLUDE_EMAILS) });
    return d.totals.ok ? d.totals.data : null;
  },
  async post(day, items) {
    const key = process.env.FAILURE_REPORTER_KEY;
    if (!key) return;
    const res = await fetch(USAGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Report-Key': key },
      body: JSON.stringify(items.map((i) => ({ ...i, day }))),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`reporter usage ${res.status}`);
  },
};
