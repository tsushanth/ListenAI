// backend/src/lib/eventLog.ts
// Failure log for the admin dashboard. Called from billing and webhook failure paths, so it must never throw or
// block them: use safeEvent there. Detail is clipped and must never carry user content (see Global Constraints).
import { supabase } from './supabaseClient.js';
import { logger } from './logger.js';

const eventLogger = logger.child({ module: 'event-log' });

export type EventKind = 'usage_report_failed' | 'webhook_failed';
export interface EventInput { kind: EventKind; userId?: string | null; detail?: string }
export type EventRecorder = (e: EventInput) => Promise<void>;

const DETAIL_MAX = 200;
const WRITE_TIMEOUT_MS = 3000;
const RETENTION_DAYS = 30;

export const recordEvent: EventRecorder = async (e) => {
  const { error } = await supabase.from('realtimetts_event_log').insert({
    kind: e.kind, user_id: e.userId ?? null, detail: (e.detail ?? '').slice(0, DETAIL_MAX),
  });
  if (error) throw new Error(error.message);
};

/** Records an event without ever throwing or waiting longer than WRITE_TIMEOUT_MS. No recorder given = no-op. */
export async function safeEvent(rec: EventRecorder | undefined, e: EventInput, timeoutMs: number = WRITE_TIMEOUT_MS): Promise<void> {
  if (!rec) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      rec(e),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error('event log write timed out')), timeoutMs);
        timer.unref();
      }),
    ]);
  } catch (err) {
    eventLogger.warn({ err: err instanceof Error ? err.message : String(err), kind: e.kind }, 'Could not record event (billing unaffected)');
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Drops events past retention. Never throws. */
export async function pruneOldEvents(now: Date = new Date()): Promise<void> {
  try {
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86_400_000).toISOString();
    const { error } = await supabase.from('realtimetts_event_log').delete().lt('created_at', cutoff);
    if (error) throw new Error(error.message);
  } catch (err) {
    eventLogger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Could not prune event log');
  }
}
