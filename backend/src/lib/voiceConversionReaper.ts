/**
 * Reaper for voice_conversions rows that never reached a terminal status.
 * The row status only changes when the client polls GET /conversions/:id, so a client that never comes back leaves
 * the row 'queued' forever. This pass marks rows older than STALE_AFTER_MS failed and reports ONE aggregate signal.
 * Columns used (all exist in migration 014): id, status, error, created_at, completed_at.
 * Statuses allowed by the CHECK constraint: queued, processing, done, failed, rejected. There is no 'running'.
 */
import { supabase } from './supabaseClient.js';
import { logger } from './logger.js';
import { signalVoiceConversionsReaped, type ReportFn } from './jobFailureSignal.js';
import { reportFailure } from './failureReporter.js';

export const STALE_AFTER_MS = 2 * 60 * 60 * 1000;
export const MAX_ROWS_PER_PASS = 100;
export const STALE_STATUSES = ['queued', 'processing'] as const;
export const REAPED_ERROR = 'Timed out: no result was recorded within 2 hours.';

const reaperLogger = logger.child({ module: 'voice-conversion-reaper' });

/** The slice of the supabase client the reaper needs (kept narrow so tests can supply a fake). */
export type ReaperDb = Pick<typeof supabase, 'from'>;

export async function reapStaleVoiceConversions(
  deps: { db?: ReaperDb; now?: () => number; report?: ReportFn } = {},
): Promise<number> {
  const db = deps.db ?? supabase;
  const now = deps.now ?? Date.now;
  const report = deps.report ?? reportFailure;
  const cutoff = new Date(now() - STALE_AFTER_MS).toISOString();

  const { data: stale, error: selectError } = await db
    .from('voice_conversions')
    .select('id')
    .in('status', [...STALE_STATUSES])
    .lt('created_at', cutoff)
    .order('created_at', { ascending: true })
    .limit(MAX_ROWS_PER_PASS);
  if (selectError) {
    reaperLogger.warn({ error: selectError }, 'voice conversion reaper: select failed');
    return 0;
  }
  const ids = (stale ?? []).map((r: { id: string }) => r.id);
  if (ids.length === 0) return 0;

  // Re-assert status and age in the UPDATE: a row that finished or was re-polled in between is left alone.
  const { data: updated, error: updateError } = await db
    .from('voice_conversions')
    .update({ status: 'failed', error: REAPED_ERROR, completed_at: new Date(now()).toISOString() })
    .in('id', ids)
    .in('status', [...STALE_STATUSES])
    .lt('created_at', cutoff)
    .select('id');
  if (updateError) {
    reaperLogger.warn({ error: updateError }, 'voice conversion reaper: update failed');
    return 0;
  }
  const count = updated?.length ?? 0;
  if (count > 0) {
    reaperLogger.warn({ count }, 'Stale voice conversions marked failed');
    signalVoiceConversionsReaped(count, report);
  }
  return count;
}
