import { config } from './config.js';
import type { HealthItem, UsageRow, SttRow } from './adminDashboard.js';

export interface ProbeTarget { name: string; url: string }
const SLOW_MS = 1500, TIMEOUT_MS = 4000, KOKORO_AWAKE_MS = 10 * 60_000, STT_AWAKE_MS = 60 * 60_000;

export function parseProbeTargets(envArg?: NodeJS.ProcessEnv): ProbeTarget[] {
  const env = envArg ?? process.env;
  if (env.ADMIN_HEALTH_TARGETS) {
    try {
      const o = JSON.parse(env.ADMIN_HEALTH_TARGETS) as Record<string, unknown>;
      return Object.entries(o).filter(([, v]) => typeof v === 'string' && /^https?:\/\//.test(v)).map(([name, url]) => ({ name, url: url as string }));
    } catch { return []; }
  }
  // Only the real process env falls back to config's default; an explicitly passed env is taken as-is (testable).
  const gateway = env.TTS_GATEWAY_URL ?? (envArg ? undefined : config.TTS_GATEWAY_URL);
  return gateway ? [{ name: 'gateway', url: `${gateway.replace(/\/$/, '')}/health` }] : [];
}

export async function probeTarget(t: ProbeTarget, fetchImpl: typeof fetch = fetch, clock: () => number = () => performance.now()): Promise<HealthItem> {
  const checkedAt = new Date().toISOString();
  const t0 = clock();
  try {
    const res = await fetchImpl(t.url, { signal: AbortSignal.timeout(TIMEOUT_MS), cache: 'no-store' });
    const latencyMs = Math.round(clock() - t0);
    if (!res.ok) return { name: t.name, status: 'down', latencyMs, detail: `HTTP ${res.status}`, checkedAt };
    return { name: t.name, status: latencyMs > SLOW_MS ? 'slow' : 'up', latencyMs, checkedAt };
  } catch (e) {
    return { name: t.name, status: 'down', detail: (e as Error).message, checkedAt };
  }
}

export function passiveHealth({ usage, stt, now }: { usage: UsageRow[]; stt: SttRow[]; now: Date }): HealthItem[] {
  const checkedAt = now.toISOString();
  const newestUsage = usage.map((u) => u.updated_at).sort().pop();
  const kokoro: HealthItem = !newestUsage
    ? { name: 'kokoro', status: 'unknown', detail: 'no usage recorded yet', checkedAt }
    : { name: 'kokoro', status: now.getTime() - Date.parse(newestUsage) <= KOKORO_AWAKE_MS ? 'up' : 'asleep', detail: `last usage ${newestUsage}`, checkedAt };
  const recent = [...stt].sort((a, b) => b.created_at.localeCompare(a.created_at));
  let sttItem: HealthItem;
  if (recent.length === 0) sttItem = { name: 'stt', status: 'unknown', detail: 'no recent requests', checkedAt };
  else if (recent.slice(0, 3).length === 3 && recent.slice(0, 3).every((r) => r.status === 'failed')) sttItem = { name: 'stt', status: 'down', detail: 'last 3 requests failed', checkedAt };
  else sttItem = { name: 'stt', status: now.getTime() - Date.parse(recent[0]!.created_at) <= STT_AWAKE_MS ? 'up' : 'asleep', detail: `last request ${recent[0]!.status}`, checkedAt };
  return [kokoro, sttItem];
}

export async function collectHealth(args: { usage: UsageRow[]; stt: SttRow[]; now: Date }, fetchImpl: typeof fetch = fetch): Promise<HealthItem[]> {
  const probed = await Promise.all(parseProbeTargets().map((t) => probeTarget(t, fetchImpl)));
  return [...probed, ...passiveHealth(args)];
}
