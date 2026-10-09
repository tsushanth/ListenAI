// Per-day API usage ledger for the admin dashboard. Called from the gateway-drain billing path, so it must never
// throw into billing: use safeRecord there. The add is atomic in SQL (realtimetts_add_usage, migration 034).
import { supabase } from './supabaseClient.js';
import { logger } from './logger.js';

const usageLogger = logger.child({ module: 'usage-daily' });

export interface UsageDelta {
  userId: string;
  chars?: number;
  piperChars?: number;
  audioSeconds?: number;
  freeChars?: number;
}
export type UsageRecorder = (d: UsageDelta, now?: Date) => Promise<void>;

export const utcDay = (now: Date): string => now.toISOString().slice(0, 10);

const nonNeg = (n: number | undefined): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0);

export const recordUsageDaily: UsageRecorder = async (d, now = new Date()) => {
  const chars = Math.round(nonNeg(d.chars));
  const piper = Math.round(nonNeg(d.piperChars));
  const audio = nonNeg(d.audioSeconds);
  const free = Math.round(nonNeg(d.freeChars));
  if (chars === 0 && piper === 0 && audio === 0 && free === 0) return;
  const { error } = await supabase.rpc('realtimetts_add_usage', {
    p_day: utcDay(now), p_user: d.userId, p_chars: chars, p_piper: piper, p_audio: audio, p_free: free,
  });
  if (error) throw new Error(error.message);
};

/** Records a usage delta without ever throwing (billing must not depend on this). No recorder given = no-op. */
export async function safeRecord(rec: UsageRecorder | undefined, d: UsageDelta): Promise<void> {
  if (!rec) return;
  try {
    await rec(d);
  } catch (err) {
    usageLogger.warn({ err: err instanceof Error ? err.message : String(err), userId: d.userId }, 'Could not record daily usage (billing unaffected)');
  }
}
