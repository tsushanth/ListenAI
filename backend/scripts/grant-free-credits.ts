// Admin-only: grant extra free credits to ONE user (e.g. 3 audio-hours of STT = 33000 units).
//
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     npx tsx scripts/grant-free-credits.ts --email a@b.com --units 33000            # dry run (default)
//     npx tsx scripts/grant-free-credits.ts --email a@b.com --units 33000 --apply    # writes
//
// Units are the meter unit of migrations 027/028 (1 unit = $0.00001). STT is $0.11/hour = 3.0556 units/second,
// so 3 hours = 33,000 units ($0.33).
//
// Safety:
//   * Dry run unless `--apply` is passed. The dry run only READS.
//   * `--max-total-usd` (default 25) caps the TOTAL ever granted by this script across all users and runs.
//     Prior grants are summed from realtimetts_free_credit_events rows whose identifier starts with
//     GRANT_REASON_PREFIX; a grant that would push the total over the cap is refused.
//   * Audit: every applied grant writes one realtimetts_free_credit_events row with identifier
//     "admin-grant:grant-free-credits:<ts>-<rand>" and units = the granted amount (the distinct reason is that
//     prefix; the table has no reason column and this needs no migration). consume_free_credits() only writes
//     rows for deductions, so these are told apart by prefix.
//   * The service-role key is read from the environment only (never a flag, never printed).
//   * The credit row is changed with a compare-and-swap on `granted`, so it cannot lose a concurrent
//     consume_free_credits() update (that function only touches `used`). A user with no row yet gets
//     DEFAULT_FREE_GRANT + units, so they keep the normal free grant.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomBytes } from 'node:crypto';

export const GRANT_REASON_PREFIX = 'admin-grant:grant-free-credits:';
export const USD_PER_UNIT = 0.00001;
export const STT_UNITS_PER_SECOND = 3.0556; // keep in sync with STT_CHARS_PER_SECOND in src/lib/realtimeTtsBilling.ts
// Keep in sync with FREE_CREDIT_UNITS in src/lib/realtimeTtsBilling.ts (the grant consume_free_credits creates a row with).
export const DEFAULT_FREE_GRANT = 10000;
export const DEFAULT_MAX_TOTAL_USD = 25;

export interface Args { email: string; units: number; apply: boolean; maxTotalUsd: number }

export function parseArgs(argv: string[]): Args {
  const out: Partial<Args> & { apply: boolean; maxTotalUsd: number } = { apply: false, maxTotalUsd: DEFAULT_MAX_TOTAL_USD };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--apply') out.apply = true;
    else if (a === '--email') out.email = val().trim().toLowerCase();
    else if (a === '--units') {
      const s = val();
      if (!/^\d+$/.test(s)) throw new Error('--units must be a positive integer');
      out.units = Number(s);
    } else if (a === '--max-total-usd') {
      const n = Number(val());
      if (!Number.isFinite(n) || n <= 0) throw new Error('--max-total-usd must be a positive number');
      out.maxTotalUsd = n;
    } else throw new Error(`Unknown argument: ${a}`);
  }
  if (!out.email || !/^[^@\s]+@[^@\s]+$/.test(out.email)) throw new Error('--email is required');
  if (!out.units || out.units <= 0 || !Number.isSafeInteger(out.units)) throw new Error('--units is required (positive integer)');
  return out as Args;
}

export interface Credits { granted: number; used: number }

export interface Deps {
  findUserIdByEmail(email: string): Promise<string | null>;
  sumPriorGrantedUnits(): Promise<number>;
  getCredits(userId: string): Promise<Credits | null>;
  /** Writes the audit event first, then bumps the credit row; throws on failure (and removes the event). */
  applyGrant(userId: string, units: number, identifier: string): Promise<void>;
  log(line: string): void;
}

export interface Plan {
  userId: string;
  units: number;
  usd: number;
  sttHours: number;
  priorTotalUnits: number;
  newTotalUnits: number;
  capUnits: number;
  before: Credits | null;
}

export async function planGrant(args: Args, deps: Deps): Promise<Plan> {
  const userId = await deps.findUserIdByEmail(args.email);
  if (!userId) throw new Error(`No auth user with email ${args.email}`);
  const capUnits = Math.floor(args.maxTotalUsd / USD_PER_UNIT + 1e-6);
  const priorTotalUnits = await deps.sumPriorGrantedUnits();
  const newTotalUnits = priorTotalUnits + args.units;
  if (newTotalUnits > capUnits) {
    throw new Error(
      `Refusing: total granted by this script would be ${newTotalUnits} units ($${(newTotalUnits * USD_PER_UNIT).toFixed(2)}), ` +
      `over the cap of ${capUnits} units ($${args.maxTotalUsd}). Already granted: ${priorTotalUnits} units.`);
  }
  const before = await deps.getCredits(userId);
  return {
    userId, units: args.units, usd: args.units * USD_PER_UNIT, sttHours: args.units / STT_UNITS_PER_SECOND / 3600,
    priorTotalUnits, newTotalUnits, capUnits, before,
  };
}

export async function run(argv: string[], deps: Deps): Promise<number> {
  let args: Args;
  try { args = parseArgs(argv); } catch (e) { deps.log(`error: ${(e as Error).message}`); return 2; }
  let plan: Plan;
  try { plan = await planGrant(args, deps); } catch (e) { deps.log(`error: ${(e as Error).message}`); return 1; }
  deps.log(
    `${args.apply ? 'APPLY' : 'DRY RUN'}: grant ${plan.units} units ($${plan.usd.toFixed(4)}, about ${plan.sttHours.toFixed(2)} STT hours) to ${args.email} (${plan.userId})\n` +
    `  current: ${plan.before ? `granted=${plan.before.granted} used=${plan.before.used}` : `no row yet (will be created with ${DEFAULT_FREE_GRANT} + ${plan.units})`}\n` +
    `  script total: ${plan.priorTotalUnits} -> ${plan.newTotalUnits} of cap ${plan.capUnits} units ($${args.maxTotalUsd})`);
  if (!args.apply) { deps.log('Dry run only. Re-run with --apply to write.'); return 0; }
  const identifier = `${GRANT_REASON_PREFIX}${Date.now()}-${randomBytes(4).toString('hex')}`;
  try { await deps.applyGrant(plan.userId, plan.units, identifier); } catch (e) { deps.log(`error: grant failed: ${(e as Error).message}`); return 1; }
  deps.log(`Granted. Audit identifier: ${identifier}`);
  return 0;
}

export function supabaseDeps(db: SupabaseClient, log: (l: string) => void): Deps {
  return {
    log,
    async findUserIdByEmail(email) {
      for (let page = 1; page <= 100; page++) {
        const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
        if (error) throw new Error(`listUsers failed: ${error.message}`);
        const hit = data.users.find((u) => (u.email ?? '').toLowerCase() === email);
        if (hit) return hit.id;
        if (data.users.length < 1000) return null;
      }
      return null;
    },
    async sumPriorGrantedUnits() {
      let total = 0;
      for (let from = 0; ; from += 1000) {
        const { data, error } = await db.from('realtimetts_free_credit_events').select('units')
          .like('identifier', `${GRANT_REASON_PREFIX}%`).order('identifier').range(from, from + 999);
        if (error) throw new Error(`reading prior grants failed: ${error.message}`);
        for (const r of data ?? []) total += Number(r.units) || 0;
        if (!data || data.length < 1000) return total;
      }
    },
    async getCredits(userId) {
      const { data, error } = await db.from('realtimetts_free_credits').select('granted, used').eq('user_id', userId).maybeSingle();
      if (error) throw new Error(`reading credits failed: ${error.message}`);
      return data ? { granted: Number(data.granted), used: Number(data.used) } : null;
    },
    async applyGrant(userId, units, identifier) {
      const ev = await db.from('realtimetts_free_credit_events').insert({ identifier, user_id: userId, units });
      if (ev.error) throw new Error(`audit insert failed: ${ev.error.message}`);
      const undo = async () => { await db.from('realtimetts_free_credit_events').delete().eq('identifier', identifier); };
      try {
        for (let attempt = 0; attempt < 5; attempt++) {
          const cur = await this.getCredits(userId);
          if (!cur) {
            const ins = await db.from('realtimetts_free_credits').insert({ user_id: userId, granted: DEFAULT_FREE_GRANT + units, used: 0 });
            if (!ins.error) return;
            if (ins.error.code !== '23505') throw new Error(ins.error.message); // 23505: row appeared meanwhile, retry via CAS
            continue;
          }
          const upd = await db.from('realtimetts_free_credits')
            .update({ granted: cur.granted + units, updated_at: new Date().toISOString() })
            .eq('user_id', userId).eq('granted', cur.granted).select('user_id');
          if (upd.error) throw new Error(upd.error.message);
          if (upd.data && upd.data.length === 1) return;
        }
        throw new Error('credit row kept changing; gave up after 5 attempts');
      } catch (e) {
        await undo();
        throw e;
      }
    },
  };
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error('error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the environment'); process.exit(2); }
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  process.exit(await run(process.argv.slice(2), supabaseDeps(db, (l) => console.log(l))));
}

if (/grant-free-credits\.[tj]s$/.test(process.argv[1] ?? '')) void main();
