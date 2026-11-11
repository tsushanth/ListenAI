// Supabase-backed AccountStore. Every read and delete is keyed by the verified user id passed in; there is no code
// path that deletes by anything else. Tables that are not present in a deployment (several migrations are applied by
// hand) are skipped, so the same code runs against any of them.
import { supabase, AUDIO_BUCKET } from './supabaseClient.js';
import { revokeGatewayKey } from './ttsGatewayClient.js';
import { sourceIsActive, type SourceRow } from './webEntitlement.js';
import type { AccountStore, StorageGroup, SubscriptionFlags } from './accountDeletion.js';

const CLONED_VOICES_BUCKET = 'cloned-voices';
const CHUNK = 100;

/** The slice of the supabase-js client this module uses (and what the unit test fakes). */
export type SupabaseLike = typeof supabase;

type DbError = { code?: string; message?: string } | null;

/** Postgres undefined_table, or PostgREST "table not in the schema cache". */
export function isMissingTable(error: DbError): boolean {
  return !!error && (error.code === '42P01' || error.code === 'PGRST205');
}

function fail(what: string, error: DbError): never {
  throw new Error(`account deletion: ${what} failed: ${error?.message ?? 'unknown error'}`);
}

/** [table, column that holds the user id]. Children before parents; every column is matched with .eq(column, userId). */
export const USER_ROW_TARGETS: ReadonlyArray<readonly [string, string]> = [
  ['voice_ratings', 'user_id'],
  ['voice_reports', 'reporter_user_id'],
  ['voice_creator_rewards', 'owner_user_id'],
  ['shared_voices', 'owner_user_id'],
  ['cloned_voices', 'user_id'],
  ['voice_design_jobs', 'user_id'],
  ['voice_design_presets', 'user_id'],
  ['voice_conversions', 'user_id'],
  ['voice_isolations', 'user_id'],
  ['user_voice_convert_configs', 'user_id'],
  ['user_voice_convert_deployments', 'user_id'],
  ['user_voice_isolate_deployments', 'user_id'],
  ['audiobooks', 'user_id'], // audiobook_chapters cascade
  ['stt_transcriptions', 'user_id'],
  ['stt_key_settings', 'subject'], // subject = '<user uuid>' (per-key rows are 'key:<id>' and are not matched)
  ['sound_effect_jobs', 'user_id'],
  ['music_jobs', 'user_id'],
  ['music_api_keys', 'user_id'],
  ['tts_jobs', 'user_id'], // tts_job_texts cascade
  ['tts_usage', 'user_id'],
  ['daily_quota', 'user_id'],
  ['monthly_quota', 'user_id'],
  ['latency_metrics', 'user_id'],
  ['realtimetts_usage_daily', 'user_id'],
  ['realtimetts_free_credit_events', 'user_id'],
  ['realtimetts_free_credits', 'user_id'],
  ['realtimetts_api_keys', 'user_id'],
  ['realtimetts_billing', 'user_id'],
  ['entitlement_sources', 'user_id'],
  ['subscriptions', 'user_id'],
  ['user_devices', 'user_id'],
  ['app_users', 'id'],
];

/**
 * Not deleted on purpose: voice_consents / voice_consent_challenges / voice_clone_output_hashes (consent evidence and
 * output hashes outlive the account for their retention window, see migration 033 and lib/voiceCloning/service.ts),
 * voice_creator_rewards rows where this user is only the listener (they are the voice owner's earnings ledger),
 * tts_cache (shared across users), stripe_webhook_events (idempotency ledger), realtimetts_event_log (user_id is
 * set to NULL by its foreign key when the auth user goes).
 */

/** Tables whose rows point at stored audio: [table, user column or null (no user column), path columns, bucket]. */
const PATH_SOURCES: ReadonlyArray<{ table: string; userColumn: string; columns: string[]; bucket: string }> = [
  { table: 'tts_jobs', userColumn: 'user_id', columns: ['audio_path', 'preview_audio_path', 'full_audio_path'], bucket: AUDIO_BUCKET },
  { table: 'sound_effect_jobs', userColumn: 'user_id', columns: ['audio_path'], bucket: AUDIO_BUCKET },
  { table: 'music_jobs', userColumn: 'user_id', columns: ['audio_path'], bucket: AUDIO_BUCKET },
  { table: 'audiobooks', userColumn: 'user_id', columns: ['export_audio_path'], bucket: AUDIO_BUCKET },
  { table: 'cloned_voices', userColumn: 'user_id', columns: ['audio_path'], bucket: CLONED_VOICES_BUCKET },
];

const chunks = <T>(a: T[], n = CHUNK): T[][] => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

export function createSupabaseAccountStore(db: SupabaseLike = supabase): AccountStore {
  // Rows are read through a loosely typed handle: the tables are not all in the generated types.
  const from = (t: string) => (db as unknown as { from: (t: string) => any }).from(t);

  /** All values of [columns] for rows of [table] matching a user (or NOT matching, for the "someone else" check). */
  async function pathsOf(table: string, userColumn: string, userId: string, columns: string[]): Promise<string[]> {
    const { data, error } = await from(table).select(columns.join(',')).eq(userColumn, userId);
    if (error) { if (isMissingTable(error)) return []; fail(`read ${table}`, error); }
    return ((data ?? []) as Array<Record<string, unknown>>).flatMap((r) => columns.map((c) => r[c])).filter((p): p is string => typeof p === 'string' && p.length > 0);
  }

  /** Subset of [paths] that something not owned by this user references (other users' jobs, or the shared cache). */
  async function sharedWithOthers(paths: string[], userId: string): Promise<Set<string>> {
    const shared = new Set<string>();
    for (const part of chunks(paths)) {
      const cache = await from('tts_cache').select('audio_path').in('audio_path', part);
      if (cache.error) { if (!isMissingTable(cache.error)) fail('read tts_cache', cache.error); }
      else for (const r of cache.data ?? []) shared.add(r.audio_path);
      for (const src of PATH_SOURCES) {
        if (src.table === 'cloned_voices' || src.table === 'audiobooks') continue; // private per-user objects, never cache hits
        for (const col of src.columns) {
          const res = await from(src.table).select(col).in(col, part).neq(src.userColumn, userId);
          if (res.error) { if (!isMissingTable(res.error)) fail(`read ${src.table}`, res.error); continue; }
          for (const r of res.data ?? []) shared.add(r[col]);
        }
      }
    }
    return shared;
  }

  /** Everything under "<userId>/" in a bucket (uploads are stored per user prefix). */
  async function listPrefix(bucket: string, userId: string): Promise<string[]> {
    const out: string[] = [];
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await db.storage.from(bucket).list(userId, { limit: 1000, offset });
      if (error) {
        if (/not found/i.test(error.message ?? '')) return out; // bucket absent in this deployment
        fail(`list ${bucket}/${userId}`, error as DbError);
      }
      const files = (data ?? []).filter((f) => f.id !== null && f.name); // folders have a null id
      out.push(...files.map((f) => `${userId}/${f.name}`));
      if ((data ?? []).length < 1000) return out;
    }
  }

  return {
    async subscriptionFlags(userId): Promise<SubscriptionFlags> {
      const flags: SubscriptionFlags = { stripe: false, play: false };
      const src = await from('entitlement_sources')
        .select('user_id, source, tier, status, stripe_customer_id, stripe_subscription_id, current_period_end, canceled_at, last_event_created')
        .eq('user_id', userId);
      if (src.error) { if (!isMissingTable(src.error)) fail('read entitlement_sources', src.error); }
      else {
        const now = Date.now();
        for (const row of (src.data ?? []) as SourceRow[]) {
          if (!sourceIsActive(row, now)) continue;
          if (row.source === 'stripe') flags.stripe = true;
          if (row.source === 'revenuecat') flags.play = true;
        }
      }
      // The developer-API plan is a Stripe subscription too (never a comped row: that has no Stripe objects).
      const billing = await from('realtimetts_billing').select('active, comped, stripe_subscription_id').eq('user_id', userId).maybeSingle();
      if (billing.error) { if (!isMissingTable(billing.error)) fail('read realtimetts_billing', billing.error); }
      else if (billing.data?.active && !billing.data.comped && billing.data.stripe_subscription_id) flags.stripe = true;
      return flags;
    },

    async revokeGatewayKeys(userId) {
      const { data, error } = await from('realtimetts_api_keys').select('id, gateway_key_id').eq('user_id', userId).is('revoked_at', null);
      if (error) { if (isMissingTable(error)) return 0; fail('read realtimetts_api_keys', error); }
      let n = 0;
      for (const k of (data ?? []) as Array<{ id: string; gateway_key_id: string }>) {
        await revokeGatewayKey(k.gateway_key_id); // false = gateway no longer knows it: fine. Throws if the gateway refuses.
        const upd = await from('realtimetts_api_keys').update({ revoked_at: new Date().toISOString() }).eq('id', k.id).eq('user_id', userId);
        if (upd.error) fail('mark api key revoked', upd.error);
        n += 1;
      }
      return n;
    },

    async collectStorage(userId): Promise<StorageGroup[]> {
      const byBucket = new Map<string, Set<string>>();
      const add = (bucket: string, paths: string[]) => {
        const s = byBucket.get(bucket) ?? new Set<string>();
        paths.forEach((p) => s.add(p));
        byBucket.set(bucket, s);
      };
      for (const src of PATH_SOURCES) add(src.bucket, await pathsOf(src.table, src.userColumn, userId, src.columns));

      // Chapter audio of the user's audiobooks.
      const books = await from('audiobooks').select('id').eq('user_id', userId);
      if (books.error) { if (!isMissingTable(books.error)) fail('read audiobooks', books.error); }
      else {
        const ids = ((books.data ?? []) as Array<{ id: string }>).map((b) => b.id);
        for (const part of chunks(ids)) {
          const ch = await from('audiobook_chapters').select('audio_path').in('audiobook_id', part);
          if (ch.error) { if (isMissingTable(ch.error)) continue; fail('read audiobook_chapters', ch.error); }
          add(AUDIO_BUCKET, (ch.data ?? []).map((r: { audio_path: string | null }) => r.audio_path).filter((p: unknown): p is string => typeof p === 'string' && p.length > 0));
        }
      }

      // Per-user prefixes (uploads).
      add(AUDIO_BUCKET, await listPrefix(AUDIO_BUCKET, userId));
      add(CLONED_VOICES_BUCKET, await listPrefix(CLONED_VOICES_BUCKET, userId));

      const groups: StorageGroup[] = [];
      for (const [bucket, set] of byBucket) {
        const all = [...set];
        if (all.length === 0) continue;
        // Objects under the user's own prefix are theirs by construction; anything else may be a shared cache object.
        const maybeShared = all.filter((p) => !p.startsWith(`${userId}/`));
        const shared = maybeShared.length > 0 && bucket === AUDIO_BUCKET ? await sharedWithOthers(maybeShared, userId) : new Set<string>();
        groups.push({ bucket, paths: all.filter((p) => !shared.has(p)) });
      }
      return groups;
    },

    async removeStorage(group) {
      for (const part of chunks(group.paths)) {
        const { error } = await db.storage.from(group.bucket).remove(part);
        if (error) fail(`remove from ${group.bucket}`, error as DbError);
      }
    },

    async deleteUserRows(userId) {
      let tablesTouched = 0;
      const tablesSkipped: string[] = [];
      for (const [table, column] of USER_ROW_TARGETS) {
        const { error } = await from(table).delete().eq(column, userId);
        if (error) {
          if (isMissingTable(error)) { tablesSkipped.push(table); continue; }
          fail(`delete from ${table}`, error);
        }
        tablesTouched += 1;
      }
      return { tablesTouched, tablesSkipped };
    },

    async deleteAuthUser(userId) {
      const { error } = await db.auth.admin.deleteUser(userId);
      if (!error) return 'deleted';
      const e = error as { status?: number; code?: string; message?: string };
      if (e.status === 404 || e.code === 'user_not_found' || /user not found/i.test(e.message ?? '')) return 'not_found';
      fail('delete auth user', e);
    },
  };
}

export const supabaseAccountStore: AccountStore = createSupabaseAccountStore();
