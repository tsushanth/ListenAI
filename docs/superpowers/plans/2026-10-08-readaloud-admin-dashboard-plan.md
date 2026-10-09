# ReadAloud Admin Dashboard (API business view), Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the /admin page's API tab a real business view (real-customer counts, TTS/STT usage, free-credit burn, paid customers, funnel, customers table, worker health, needs-attention) fed by a new admin-only backend endpoint and a per-day usage ledger recorded inside the existing billing drain.

**Architecture:** (1) A new table `realtimetts_usage_daily` plus an atomic add-function, written from the existing 5-minute gateway drain in `reportUsageToStripe` (and from `reportSttUsage`) through an injectable, never-throwing recorder. (2) A new `GET /api/admin/dashboard` in listenai-backend that authenticates the Supabase bearer itself (Google, confirmed email, `ADMIN_EMAILS` allowlist; 404 otherwise) and returns independent sections. (3) A thin Next proxy route plus a new `AdminBusiness` panel injected into the existing `AdminDashboard` when the API tab is selected.

**Tech Stack:** Node/TypeScript ESM, Express 4, `@supabase/supabase-js`, `node:test` run through `tsx` (backend) and `node --test` with TS type-stripping (web, Node 26), Next 14 / React 18, Postgres (Supabase).

**Spec:** `docs/superpowers/specs/2026-10-08-readaloud-admin-dashboard-design.md` (approved 2026-10-08).

## Global Constraints

- This repo is PUBLIC: no emails, secrets, keys, margins or private numbers in any committed file, test fixture or doc. Use `a@example.test` style fixtures.
- Fail closed: no `ADMIN_EMAILS` configured means NO caller is admin. The endpoint answers `404 Not found` to everyone who is not an admin (anonymous, wrong account, email/password login, unconfirmed email, token error).
- Do NOT use `requireAuth` for the admin endpoint: it falls back to a default user for empty tokens and skips auth outside production (backend/src/middleware/auth.ts). Verify the bearer with `supabase.auth.getUser(token)`.
- Mount order: `app.use('/api/admin/dashboard', ...)` must be registered BEFORE `app.use('/api/admin', adminRouter)` in `backend/src/index.ts` (the generic admin router demands an `x-admin-key`).
- The gateway drain (`POST /admin/usage/drain`) CLEARS counters. Never add a second reader; record usage only inside the existing `reportUsageToStripe` call. A recorder failure must never throw into billing and must never change a Stripe meter event.
- New table: row-level security ON, a single policy `TO service_role`, all anon/authenticated privileges revoked (same pattern as migration 033). The known open-RLS problem on older tables must not be copied.
- Exclusion of the owner's own accounts is by env var `ADMIN_EXCLUDE_EMAILS` (comma-separated, case-insensitive), resolved to user ids; excluded users appear in NO number (totals, funnel, customers, series, attention).
- Backend imports use the `.js` suffix; new test files must be appended to the `test` script in `backend/package.json` (it lists files explicitly). Web tests are `web/test/*.test.ts`, import `.ts` files directly, and the imported lib files must not use extension-less relative imports.
- Typecheck and tests must pass before every commit: `cd backend && npm run typecheck && npm test`; `cd web && npm test` (and `npx tsc --noEmit` before the web deploy).
- Commits end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; never bypass the pre-push secrets hook.
- Estimated spend: $0. No GPU, no Modal.

## Rulings carried from verifying the real code (deviations from the approved spec, to confirm with the owner)

1. **Table key:** the spec said rows per `(day, gateway_key_id, engine)` with `units` and `requests`. The real drain returns free-tier usage per OWNER (`freeChars`), not per key, and no request counts (`GatewayUsageEntry` = `{id, chars, piperChars?, audioSeconds?}`). So the table is `(day, user_id)` with columns `chars, piper_chars, audio_seconds, free_chars`, and the dashboard shows no request counts in Phase 1.
2. **Funnel:** the spec's first stage "signed up" would count every consumer-app user in `auth.users`. The funnel starts at "created a key" (an API account).
3. **Needs-attention rules in Phase 1:** worker down/slow, key at its free limit without a card, one-account usage spike, STT failures. "A paying key whose usage report failed" and "Stripe webhook failures" have no stored source today and move to Phase 2.
4. **Billed usage:** shown as character-equivalents computed with the existing `billableChars()` over the ledger rows, not read from Stripe (Phase 2 can add meter summaries).
5. **Admin allowlist in the backend** reads `ADMIN_EMAILS` with NO default (the web code keeps its own default); the owner sets it when deploying.

## Review Focus

Failure modes the spec implies that the happy-path tasks would miss (each is pinned by a named test):
1. The recorder throws or the database is down while the drain runs: billing must still create the same meter events (Task 3).
2. One user with two keys in one drain, and two drains on the same day, must ADD, not overwrite (Tasks 1, 3: SQL function test + two-call test).
3. An excluded user must be absent from every section, including funnel counts, and the match is case-insensitive and whitespace-tolerant (Task 5).
4. More than one page of users or rows (Supabase returns at most 1,000 rows per request): totals must not silently truncate (Task 4).
5. An email/password account with the admin address, an unconfirmed email, and a Supabase outage while verifying the token all get 404 (Task 6).
6. `range` junk (`range=999d`, array, empty) falls back to 7d, never throws or widens the query (Task 5).
7. One section failing (a table error, a probe timeout) must not blank the whole response (Task 5).
8. UTC day boundary: usage is recorded and charted by UTC date, labelled as UTC (Tasks 2, 5).

## File Structure

Backend (`backend/`):
- `supabase/migrations/034_realtimetts_usage_daily.sql` (create; number = next free, check `ls supabase/migrations`) and `supabase/rollbacks/034_rollback.sql`: table, add-function, RLS.
- `src/lib/usageDaily.ts` (create): `UsageDelta`, `recordUsageDaily`, `safeRecord`, `utcDay`.
- `src/lib/realtimeTtsBilling.ts` (modify): optional `recordUsage` dep; record inside `reportUsageToStripe` and `reportSttUsage`.
- `test/billingKit.ts` (modify): fake `rpc` must branch on function name (today it treats every rpc as `consume_free_credits`).
- `src/lib/adminBearer.ts` (create): `isAdminBearer`.
- `src/lib/adminDashboard.ts` (create): types, pure aggregators, `buildDashboard`, paging helper, default Supabase deps.
- `src/lib/adminHealth.ts` (create): health probes + passive health.
- `src/routes/adminDashboard.ts` (create): the route.
- `src/index.ts` (modify): mount the route before `adminRouter`.
- Tests: `src/lib/usageDailyMigration.test.ts`, `src/lib/usageDaily.test.ts`, `src/lib/realtimeTtsBilling.usageDaily.test.ts`, `src/lib/adminBearer.test.ts`, `src/lib/adminDashboard.test.ts`, `src/lib/adminHealth.test.ts`, `src/routes/adminDashboard.test.ts`.

Web (`web/`):
- `src/lib/adminBusiness.ts` (create): response types and pure formatters (no relative imports).
- `src/lib/adminProxy.ts` (create): `forwardAdminDashboard` (pure, injectable fetch).
- `src/app/api/admin/dashboard/route.ts` (create): thin proxy using the helper.
- `src/components/AdminBusiness.tsx` (create): the panel.
- `src/components/AdminDashboard.tsx` (modify): optional `renderTop(scope, hours)` prop.
- `src/app/admin/page.tsx` (modify): pass `renderTop`.
- Tests: `test/admin-business.test.ts`, `test/admin-proxy.test.ts`.

---

### Task 1: Migration: `realtimetts_usage_daily` and `realtimetts_add_usage`

**Files:**
- Create: `backend/supabase/migrations/034_realtimetts_usage_daily.sql` (use the next unused number)
- Create: `backend/supabase/rollbacks/034_rollback.sql`
- Test: `backend/src/lib/usageDailyMigration.test.ts`

**Interfaces:**
- Produces: table `realtimetts_usage_daily(day date, user_id uuid, chars bigint, piper_chars bigint, audio_seconds double precision, free_chars bigint, updated_at timestamptz, primary key(day, user_id))`; function `realtimetts_add_usage(p_day date, p_user uuid, p_chars bigint, p_piper bigint, p_audio double precision, p_free bigint) returns void` (service_role only).

- [ ] **Step 1: Write the failing static test**

```ts
// backend/src/lib/usageDailyMigration.test.ts
// Run: npm test. Static guard on the usage-ledger migration (the SQL is applied by hand in the Supabase editor).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(import.meta.dirname, '../../supabase/migrations');
const file = readdirSync(dir).find((f) => f.endsWith('_realtimetts_usage_daily.sql'));
const sql = file ? readFileSync(join(dir, file), 'utf8') : '';

test('migration file exists', () => {
  assert.ok(file, 'expected a *_realtimetts_usage_daily.sql migration');
});

test('table has RLS on, a service_role-only policy, and anon/authenticated revoked', () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS realtimetts_usage_daily/);
  assert.match(sql, /ALTER TABLE realtimetts_usage_daily ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /CREATE POLICY[\s\S]*ON realtimetts_usage_daily[\s\S]*TO service_role/);
  assert.match(sql, /REVOKE ALL ON realtimetts_usage_daily FROM anon, authenticated/);
  assert.doesNotMatch(sql, /TO (anon|authenticated|public)/i);
});

test('add function adds on conflict (never overwrites) and is service_role only', () => {
  assert.match(sql, /CREATE OR REPLACE FUNCTION realtimetts_add_usage/);
  assert.match(sql, /ON CONFLICT \(day, user_id\) DO UPDATE SET[\s\S]*chars\s*=\s*realtimetts_usage_daily\.chars \+ EXCLUDED\.chars/);
  assert.match(sql, /audio_seconds\s*=\s*realtimetts_usage_daily\.audio_seconds \+ EXCLUDED\.audio_seconds/);
  assert.match(sql, /REVOKE ALL ON FUNCTION realtimetts_add_usage[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION realtimetts_add_usage[\s\S]*TO service_role/);
});

test('rollback drops the function and the table', () => {
  const rb = readFileSync(join(import.meta.dirname, '../../supabase/rollbacks/034_rollback.sql'), 'utf8');
  assert.match(rb, /DROP FUNCTION IF EXISTS realtimetts_add_usage/);
  assert.match(rb, /DROP TABLE IF EXISTS realtimetts_usage_daily/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx tsx --test src/lib/usageDailyMigration.test.ts`
Expected: FAIL ("expected a *_realtimetts_usage_daily.sql migration").

- [ ] **Step 3: Write the migration and rollback**

```sql
-- backend/supabase/migrations/034_realtimetts_usage_daily.sql
-- ============================================================================
-- Migration 034: per-day API usage ledger for the admin dashboard.
-- NOT APPLIED until the owner runs it in the Supabase SQL editor.
-- Written from reportUsageToStripe (the 5-minute gateway drain) and reportSttUsage, by realtimetts_add_usage.
-- SECURITY: RLS on, one service_role policy, anon/authenticated revoked (same pattern as migration 033).
-- ============================================================================
CREATE TABLE IF NOT EXISTS realtimetts_usage_daily (
    day            DATE             NOT NULL,                       -- UTC day
    user_id        UUID             NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    chars          BIGINT           NOT NULL DEFAULT 0,             -- paid-key characters, total across engines (gateway drain `chars`)
    piper_chars    BIGINT           NOT NULL DEFAULT 0,             -- the Piper subset of `chars`
    audio_seconds  DOUBLE PRECISION NOT NULL DEFAULT 0,             -- batch STT audio seconds
    free_chars     BIGINT           NOT NULL DEFAULT 0,             -- free-tier characters (gateway drain `freeChars`, per owner)
    updated_at     TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
    PRIMARY KEY (day, user_id)
);
CREATE INDEX IF NOT EXISTS idx_realtimetts_usage_daily_user ON realtimetts_usage_daily(user_id);

ALTER TABLE realtimetts_usage_daily ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role only on realtimetts_usage_daily" ON realtimetts_usage_daily;
CREATE POLICY "Service role only on realtimetts_usage_daily" ON realtimetts_usage_daily
    FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON realtimetts_usage_daily FROM anon, authenticated;

CREATE OR REPLACE FUNCTION realtimetts_add_usage(
    p_day DATE, p_user UUID, p_chars BIGINT, p_piper BIGINT, p_audio DOUBLE PRECISION, p_free BIGINT
) RETURNS VOID
LANGUAGE sql
AS $$
    INSERT INTO realtimetts_usage_daily (day, user_id, chars, piper_chars, audio_seconds, free_chars)
    VALUES (p_day, p_user, p_chars, p_piper, p_audio, p_free)
    ON CONFLICT (day, user_id) DO UPDATE SET
        chars         = realtimetts_usage_daily.chars + EXCLUDED.chars,
        piper_chars   = realtimetts_usage_daily.piper_chars + EXCLUDED.piper_chars,
        audio_seconds = realtimetts_usage_daily.audio_seconds + EXCLUDED.audio_seconds,
        free_chars    = realtimetts_usage_daily.free_chars + EXCLUDED.free_chars,
        updated_at    = NOW();
$$;
REVOKE ALL ON FUNCTION realtimetts_add_usage(DATE, UUID, BIGINT, BIGINT, DOUBLE PRECISION, BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION realtimetts_add_usage(DATE, UUID, BIGINT, BIGINT, DOUBLE PRECISION, BIGINT) TO service_role;
```

```sql
-- backend/supabase/rollbacks/034_rollback.sql
DROP FUNCTION IF EXISTS realtimetts_add_usage(DATE, UUID, BIGINT, BIGINT, DOUBLE PRECISION, BIGINT);
DROP TABLE IF EXISTS realtimetts_usage_daily;
```

- [ ] **Step 4: Add the test to `backend/package.json`'s `test` script and run it**

Append ` src/lib/usageDailyMigration.test.ts` to the file list in the `"test"` script.
Run: `cd backend && npx tsx --test src/lib/usageDailyMigration.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/supabase/migrations/034_realtimetts_usage_daily.sql backend/supabase/rollbacks/034_rollback.sql backend/src/lib/usageDailyMigration.test.ts backend/package.json
git commit -m "db: realtimetts_usage_daily ledger and add-function for the admin dashboard

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The usage recorder (`usageDaily.ts`)

**Files:**
- Create: `backend/src/lib/usageDaily.ts`
- Test: `backend/src/lib/usageDaily.test.ts`

**Interfaces:**
- Produces: `interface UsageDelta { userId: string; chars?: number; piperChars?: number; audioSeconds?: number; freeChars?: number }`; `type UsageRecorder = (d: UsageDelta, now?: Date) => Promise<void>`; `utcDay(now: Date): string` (`YYYY-MM-DD`); `recordUsageDaily: UsageRecorder` (throws on a database error); `safeRecord(rec: UsageRecorder | undefined, d: UsageDelta): Promise<void>` (never throws; no-op when `rec` is undefined).

- [ ] **Step 1: Write the failing tests**

```ts
// backend/src/lib/usageDaily.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';

const modP = import('./usageDaily.js');
const supaP = import('./supabaseClient.js');

async function withRpc(impl: (fn: string, args: any) => Promise<any>, fn: (calls: any[]) => Promise<void>) {
  const { supabase } = await supaP;
  const sb = supabase as any;
  const orig = sb.rpc;
  const calls: any[] = [];
  sb.rpc = async (name: string, args: any) => { calls.push({ name, args }); return impl(name, args); };
  try { await fn(calls); } finally { sb.rpc = orig; }
}

test('utcDay uses the UTC date, not local time', async () => {
  const { utcDay } = await modP;
  assert.equal(utcDay(new Date('2026-10-08T23:59:59Z')), '2026-10-08');
  assert.equal(utcDay(new Date('2026-10-09T00:00:00Z')), '2026-10-09');
});

test('recordUsageDaily calls realtimetts_add_usage with rounded integers and zero defaults', async () => {
  const { recordUsageDaily } = await modP;
  await withRpc(async () => ({ data: null, error: null }), async (calls) => {
    await recordUsageDaily({ userId: 'u1', chars: 120.4, piperChars: 20, audioSeconds: 12.5 }, new Date('2026-10-08T10:00:00Z'));
    assert.deepEqual(calls[0], {
      name: 'realtimetts_add_usage',
      args: { p_day: '2026-10-08', p_user: 'u1', p_chars: 120, p_piper: 20, p_audio: 12.5, p_free: 0 },
    });
  });
});

test('recordUsageDaily skips all-zero deltas and negative/NaN values', async () => {
  const { recordUsageDaily } = await modP;
  await withRpc(async () => ({ data: null, error: null }), async (calls) => {
    await recordUsageDaily({ userId: 'u1' });
    await recordUsageDaily({ userId: 'u1', chars: -5, audioSeconds: NaN, freeChars: 0 });
    assert.equal(calls.length, 0);
  });
});

test('recordUsageDaily throws on a database error', async () => {
  const { recordUsageDaily } = await modP;
  await withRpc(async () => ({ data: null, error: { message: 'boom' } }), async () => {
    await assert.rejects(() => recordUsageDaily({ userId: 'u1', chars: 5 }), /boom/);
  });
});

test('safeRecord never throws, and is a no-op without a recorder', async () => {
  const { safeRecord } = await modP;
  await safeRecord(undefined, { userId: 'u1', chars: 5 });
  await safeRecord(async () => { throw new Error('down'); }, { userId: 'u1', chars: 5 });
  let seen: any = null;
  await safeRecord(async (d) => { seen = d; }, { userId: 'u2', freeChars: 9 });
  assert.deepEqual(seen, { userId: 'u2', freeChars: 9 });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx tsx --test src/lib/usageDaily.test.ts`
Expected: FAIL (`Cannot find module './usageDaily.js'`).

- [ ] **Step 3: Implement**

```ts
// backend/src/lib/usageDaily.ts
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
    usageLogger.warn({ err: (err as Error).message, userId: d.userId }, 'Could not record daily usage (billing unaffected)');
  }
}
```

- [ ] **Step 4: Append the test to the `test` script and run it**

Run: `cd backend && npx tsx --test src/lib/usageDaily.test.ts && npm run typecheck`
Expected: 5 passed; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add backend/src/lib/usageDaily.ts backend/src/lib/usageDaily.test.ts backend/package.json
git commit -m "feat: daily usage recorder (never throws into billing)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Hook the recorder into the billing drain (billing path: guarded and deployed alone first)

**Files:**
- Modify: `backend/test/billingKit.ts` (fake `rpc` must branch on function name)
- Modify: `backend/src/lib/realtimeTtsBilling.ts` (`UsageReportDeps`, `defaultUsageDeps`, `reportUsageToStripe`, `reportSttUsage`)
- Test: `backend/src/lib/realtimeTtsBilling.usageDaily.test.ts`

**Interfaces:**
- Consumes: `UsageRecorder`, `safeRecord`, `recordUsageDaily` from Task 2.
- Produces: `UsageReportDeps.recordUsage?: UsageRecorder` (optional, so existing tests that build `Deps` literals still type-check and see no behavior change); `Kit.usageRows: Array<Record<string, any>>` in the test kit.

Why the kit change: today `sb.rpc` in `test/billingKit.ts` treats EVERY rpc as `consume_free_credits` (`kit.freeCredits[args.p_user] ??= { granted: args.p_grant... }`). A call to `realtimetts_add_usage` (it also has `p_user`) would silently corrupt free-credit state in existing STT tests once `reportSttUsage` records usage.

- [ ] **Step 1: Write the failing tests** (kit behavior first, then the hook)

```ts
// backend/src/lib/realtimeTtsBilling.usageDaily.test.ts
// Run: npm test. The gateway drain also records a per-day usage ledger; billing must be byte-for-byte unchanged by it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installKit, billingRow, stripeMeterCalls, type Kit } from '../../test/billingKit.js';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';

const modP = import('./realtimeTtsBilling.js');

type Drain = Array<{ id: string; chars: number; piperChars?: number; audioSeconds?: number }>;

async function run(opts: {
  usage: Drain; freeChars?: Array<{ owner: string; chars: number }>; owners?: Record<string, string>;
  active?: Record<string, boolean>; recorder?: ((d: any) => Promise<void>) | null; // null = no recorder at all
}) {
  const { reportUsageToStripe } = await modP;
  const events: any[] = [];
  const recorded: any[] = [];
  await reportUsageToStripe({
    drain: async () => ({ usage: opts.usage, freeChars: opts.freeChars ?? [] }),
    getKeyOwner: async (id) => (opts.owners?.[id] ? { user_id: opts.owners[id]! } : null),
    getBilling: async (uid) =>
      opts.active && uid in opts.active ? ({ user_id: uid, stripe_customer_id: `cus_${uid}`, active: opts.active[uid] } as any) : null,
    createMeterEvent: async (p) => { events.push(p); return {}; },
    consumeFreeCredits: async () => 0,
    recordUsage: opts.recorder === null ? undefined : (opts.recorder ?? (async (d) => { recorded.push(d); })),
  });
  return { events, recorded };
}

test('a paid entry records raw chars, piper chars and audio seconds for the key owner', async () => {
  const { events, recorded } = await run({
    usage: [{ id: 'k1', chars: 1000, piperChars: 400, audioSeconds: 30 }], owners: { k1: 'u1' }, active: { u1: true },
  });
  assert.deepEqual(recorded, [{ userId: 'u1', chars: 1000, piperChars: 400, audioSeconds: 30 }]);
  assert.equal(events.length, 1); // the meter event is still created
});

test('the meter event value is identical with and without a recorder', async () => {
  const withRec = await run({ usage: [{ id: 'k1', chars: 1000, piperChars: 400, audioSeconds: 30 }], owners: { k1: 'u1' }, active: { u1: true } });
  const noRec = await run({
    usage: [{ id: 'k1', chars: 1000, piperChars: 400, audioSeconds: 30 }], owners: { k1: 'u1' }, active: { u1: true },
    recorder: null,
  });
  assert.equal(withRec.events[0].payload.value, noRec.events[0].payload.value);
});

test('a throwing recorder never stops billing', async () => {
  const { events } = await run({
    usage: [{ id: 'k1', chars: 500 }, { id: 'k2', chars: 700 }], owners: { k1: 'u1', k2: 'u2' }, active: { u1: true, u2: true },
    recorder: async () => { throw new Error('db down'); },
  });
  assert.equal(events.length, 2);
});

test('a comped user is recorded (usage is real) but never billed', async () => {
  const { reportUsageToStripe } = await modP;
  const recorded: any[] = []; const events: any[] = [];
  await reportUsageToStripe({
    drain: async () => ({ usage: [{ id: 'k1', chars: 50 }], freeChars: [] }),
    getKeyOwner: async () => ({ user_id: 'u1' }),
    getBilling: async () => ({ user_id: 'u1', stripe_customer_id: 'cus', active: true, comped: true } as any),
    createMeterEvent: async (p) => { events.push(p); return {}; },
    consumeFreeCredits: async () => 0,
    recordUsage: async (d) => { recorded.push(d); },
  });
  assert.equal(events.length, 0);
  assert.equal(recorded.length, 1);
});

test('free-tier usage is recorded per owner as freeChars', async () => {
  const { recorded } = await run({ usage: [], freeChars: [{ owner: 'u9', chars: 321 }] });
  assert.deepEqual(recorded, [{ userId: 'u9', freeChars: 321 }]);
});

test('two keys of one user produce two recorder calls (the SQL function adds them)', async () => {
  const { recorded } = await run({
    usage: [{ id: 'k1', chars: 10 }, { id: 'k2', chars: 20 }], owners: { k1: 'u1', k2: 'u1' }, active: { u1: true },
  });
  assert.deepEqual(recorded.map((r) => r.chars), [10, 20]);
});

test('an entry whose key has no owner is skipped and not recorded', async () => {
  const { recorded } = await run({ usage: [{ id: 'ghost', chars: 10 }], owners: {} });
  assert.equal(recorded.length, 0);
});

// --- reportSttUsage (customer-facing STT billing) records raw audio seconds through the real recorder -------
async function withKit(fn: (kit: Kit) => Promise<void>) {
  const kit = await installKit();
  try { await fn(kit); } finally { kit.restore(); }
}

test('reportSttUsage records the raw audio seconds for the user and leaves free credits alone for the ledger call', async () => {
  await withKit(async (kit) => {
    kit.tables.realtimetts_billing!.push(billingRow({ user_id: 'u1' }));
    const { reportSttUsage } = await modP;
    await reportSttUsage('u1', 42);
    assert.equal(kit.usageRows.length, 1);
    assert.equal(kit.usageRows[0]!.p_user, 'u1');
    assert.equal(kit.usageRows[0]!.p_audio, 42);
    assert.equal(stripeMeterCalls(kit).length, 1);
    assert.equal(Object.keys(kit.freeCredits).length, 0); // the add-usage rpc must not touch the free-credit fake
  });
});

test('reportSttUsage still bills when recording fails', async () => {
  await withKit(async (kit) => {
    kit.tables.realtimetts_billing!.push(billingRow({ user_id: 'u1' }));
    kit.usageRpcError = true;
    const { reportSttUsage } = await modP;
    await reportSttUsage('u1', 42);
    assert.equal(stripeMeterCalls(kit).length, 1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx tsx --test src/lib/realtimeTtsBilling.usageDaily.test.ts`
Expected: FAIL (`recordUsage` is not read by `reportUsageToStripe`, `kit.usageRows` undefined).

- [ ] **Step 3a: Teach the test kit about the new rpc**

In `backend/test/billingKit.ts`: add `usageRows: Array<Row>; usageRpcError: boolean;` to `Kit`, initialise them (`usageRows: [], usageRpcError: false`), and make `sb.rpc` branch first:

```ts
  sb.rpc = async (fn: string, args: Row) => {
    kit.rpcCalls.push({ fn, args });
    if (fn === 'realtimetts_add_usage') {
      if (kit.usageRpcError) return { data: null, error: { message: 'boom' } };
      kit.usageRows.push(args);
      return { data: null, error: null };
    }
    if (kit.rpcError) return { data: null, error: { message: 'boom' } };
    // ...the existing consume_free_credits mirror below is unchanged
```

- [ ] **Step 3b: Add the optional dep and the two recording points**

In `backend/src/lib/realtimeTtsBilling.ts`:
1. Add `import { recordUsageDaily, safeRecord, type UsageRecorder } from './usageDaily.js';`.
2. In `interface UsageReportDeps` add `recordUsage?: UsageRecorder;` and in `defaultUsageDeps` add `recordUsage: recordUsageDaily,`.
3. In `reportUsageToStripe`, inside the `for (const f of freeChars)` try-block, as the first statement after `if (!f?.owner || !(f.chars > 0)) continue;`:

```ts
      await safeRecord(deps.recordUsage, { userId: f.owner, freeChars: f.chars });
```

4. In the `for (const entry of usage)` loop, immediately after the `if (!keyRecord) { ...; continue; }` block and BEFORE `resolveMeterTarget`:

```ts
      await safeRecord(deps.recordUsage, {
        userId: keyRecord.user_id, chars: entry.chars, piperChars: entry.piperChars, audioSeconds: entry.audioSeconds,
      });
```

5. In `reportSttUsage`, after `if (audioSeconds <= 0) return;` and before `resolveMeterTarget`:

```ts
  await safeRecord(recordUsageDaily, { userId, audioSeconds: rawAudioSeconds });
```

- [ ] **Step 4: Run to verify the new tests and ALL existing billing tests pass**

Run: `cd backend && npx tsx --test --experimental-test-module-mocks src/lib/realtimeTtsBilling.usageDaily.test.ts src/lib/realtimeTtsBilling.test.ts src/lib/realtimeTtsBilling.sttMin.test.ts src/lib/realtimeTtsBilling.freeCredits.test.ts src/lib/realtimeTtsBilling.hardening.test.ts && npm run typecheck`
Expected: all pass; typecheck clean. If an existing test now fails, the cause is the hook or the kit change: fix the code, not the old test.

- [ ] **Step 5: Append the new test to the `test` script, run the whole suite, commit**

Run: `cd backend && npm test`
Expected: PASS (same pre-existing count plus the new tests).

```bash
git add backend/test/billingKit.ts backend/src/lib/realtimeTtsBilling.ts backend/src/lib/realtimeTtsBilling.usageDaily.test.ts backend/package.json
git commit -m "feat: record per-day usage from the gateway drain and STT billing (guarded, billing unchanged)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

**Deploy gate (do not continue to Task 4's deploy until this is live and watched):** see Rollout step 2.

---

### Task 4: Dashboard data layer: types, paging helper, pure aggregators

**Files:**
- Create: `backend/src/lib/adminDashboard.ts`
- Test: `backend/src/lib/adminDashboard.test.ts`

**Interfaces:**
- Produces (all exported):

```ts
export type Range = '24h' | '7d' | '30d';
export const RANGE_DAYS: Record<Range, number>;               // {'24h':1,'7d':7,'30d':30}
export function parseRange(v: unknown): Range;                 // junk -> '7d'
export function parseExcludeEmails(raw: string | undefined): Set<string>; // lower-cased, trimmed, empty dropped
export interface AdminUser { id: string; email: string | null; created_at: string }
export interface KeyRow { user_id: string; gateway_key_id: string; created_at: string; revoked_at: string | null }
export interface UsageRow { day: string; user_id: string; chars: number; piper_chars: number; audio_seconds: number; free_chars: number; updated_at: string }
export interface FreeCreditRow { user_id: string; granted: number; used: number }
export interface BillingRow { user_id: string; active: boolean; comped?: boolean | null }
export interface SttRow { user_id: string; status: string; created_at: string }
export interface HealthItem { name: string; status: 'up' | 'down' | 'slow' | 'asleep' | 'unknown'; latencyMs?: number; detail?: string; checkedAt: string }
export interface Totals { accounts: number; activeKeys: number; newAccounts: number; kokoroChars: number; piperChars: number; sttMinutes: number; freeCharsUsed: number; creditsGranted: number; creditsUsed: number; paidCustomers: number; billedUnits: number }
export interface FunnelStage { stage: string; count: number }
export type CustomerStatus = 'paid' | 'comped' | 'at limit' | 'free';
export interface Customer { userId: string; email: string | null; signedUp: string; activeKeys: number; firstRequest: string | null; lastRequest: string | null; chars7d: number; sttMinutes7d: number; creditsLeft: number; status: CustomerStatus }
export interface AttentionItem { level: 'warn' | 'info'; text: string }
export type Section<T> = { ok: true; data: T } | { ok: false; error: string };
export interface DashboardInputs { users: AdminUser[]; keys: KeyRow[]; usage: UsageRow[]; credits: FreeCreditRow[]; billing: BillingRow[]; stt: SttRow[]; health: HealthItem[]; now: Date; range: Range; excluded: Set<string> }
export function excludedUserIds(users: AdminUser[], excluded: Set<string>): Set<string>;
export function buildTotals(i: DashboardInputs): Totals;
export function buildFunnel(i: DashboardInputs): FunnelStage[];
export function buildCustomers(i: DashboardInputs): Customer[];
export function buildAttention(i: DashboardInputs, customers: Customer[]): AttentionItem[];
export function buildSeries(i: DashboardInputs): Array<{ day: string; newAccounts: number; chars: number; sttMinutes: number }>;
export async function fetchAll<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>, size?: number): Promise<T[]>;
export async function section<T>(fn: () => Promise<T> | T): Promise<Section<T>>;
```

Definitions used by the tests (write them into the code as written here):
- An API **account** = a non-excluded user with at least one `realtimetts_api_keys` row (revoked or not). **Active key** = `revoked_at === null` on a non-excluded owner.
- `newAccounts` = accounts whose first key `created_at` is within the range (24h = last 24 h; 7d/30d = last N UTC days).
- `kokoroChars = Σ(chars − piper_chars)`, `piperChars = Σpiper_chars`, `sttMinutes = Σaudio_seconds / 60`, `freeCharsUsed = Σfree_chars`, all over usage rows within the range for non-excluded users. `billedUnits = Σ billableChars({chars, piperChars: piper_chars, audioSeconds: audio_seconds})` (import from `./realtimeTtsBilling.js`).
- `paidCustomers` = non-excluded users with `billing.active === true && !billing.comped` (a comped account is active but never pays). `creditsGranted/creditsUsed` = sums over non-excluded `realtimetts_free_credits` rows.
- Funnel (non-excluded accounts): "Created a key" = accounts; "Made a first request" = accounts with any usage row (chars, audio or free chars > 0) ever; "Used up free credits" = accounts whose credits row has `used >= granted && granted > 0`; "Added a card" = accounts with an active, non-comped billing row.
- Customer `status`: `comped` if an active billing row has `comped`; else `paid` if active billing; else `at limit` if credits row exists with `used >= granted`; else `free`. `creditsLeft = max(0, granted - used)` (0 when no row). `chars7d`/`sttMinutes7d` = last 7 UTC days regardless of the range selector. `firstRequest` = min usage day, `lastRequest` = max `updated_at` of the user's usage rows.
- Attention rules: (a) each health item with status `down` -> warn "<name> is down"; `slow` -> warn "<name> is slow (<ms> ms)"; (b) each customer with status `at limit` -> warn "<email> is out of free credits and has no card"; (c) usage spike: a customer whose last-24h chars (usage row for today UTC) is >= 5x their average daily chars over the prior 7 days and >= 100,000 -> warn "<email>: usage spike"; (d) STT failures: >= 3 `stt` rows with status `failed` in the last hour -> warn "Batch STT: N failed requests in the last hour".

- [ ] **Step 1: Write the failing tests** (`backend/src/lib/adminDashboard.test.ts`)

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';

const modP = import('./adminDashboard.js');
const NOW = new Date('2026-10-08T12:00:00Z');

const user = (id: string, email: string, created = '2026-09-01T00:00:00Z') => ({ id, email, created_at: created });
const key = (u: string, id: string, revoked: string | null = null, created = '2026-09-02T00:00:00Z') =>
  ({ user_id: u, gateway_key_id: id, created_at: created, revoked_at: revoked });
const use = (u: string, day: string, over: Record<string, number> = {}) =>
  ({ day, user_id: u, chars: 0, piper_chars: 0, audio_seconds: 0, free_chars: 0, updated_at: `${day}T10:00:00Z`, ...over });

async function inputs(over: Record<string, unknown> = {}) {
  const { parseExcludeEmails } = await modP;
  return {
    users: [user('a', 'a@example.test'), user('b', 'b@example.test'), user('me', 'ME@example.test'), user('c', 'c@example.test')],
    keys: [key('a', 'k1'), key('a', 'k2', '2026-09-20T00:00:00Z'), key('b', 'k3'), key('me', 'k4')],
    usage: [
      use('a', '2026-10-08', { chars: 1000, piper_chars: 400, audio_seconds: 120 }),
      use('a', '2026-10-07', { chars: 500 }),
      use('b', '2026-10-08', { free_chars: 300 }),
      use('me', '2026-10-08', { chars: 999999 }),
    ],
    credits: [{ user_id: 'a', granted: 1000, used: 400 }, { user_id: 'b', granted: 1000, used: 1000 }, { user_id: 'me', granted: 1, used: 1 }],
    billing: [{ user_id: 'a', active: true }, { user_id: 'me', active: true }],
    stt: [], health: [], now: NOW, range: '7d' as const,
    excluded: parseExcludeEmails(' me@example.test , '),
    ...over,
  } as any;
}

test('parseRange: valid values pass, junk falls back to 7d', async () => {
  const { parseRange } = await modP;
  assert.equal(parseRange('24h'), '24h');
  assert.equal(parseRange('30d'), '30d');
  for (const v of ['999d', '', undefined, ['7d'], 5, null, '7D']) assert.equal(parseRange(v), '7d');
});

test('parseExcludeEmails lower-cases, trims and drops empties', async () => {
  const { parseExcludeEmails } = await modP;
  assert.deepEqual([...parseExcludeEmails(' A@x.test, ,b@X.test')].sort(), ['a@x.test', 'b@x.test']);
  assert.equal(parseExcludeEmails(undefined).size, 0);
});

test('excluded users (case-insensitive) are absent from totals, funnel and customers', async () => {
  const m = await modP; const i = await inputs();
  const t = m.buildTotals(i);
  assert.equal(t.accounts, 2);               // a, b (me excluded; c has no key)
  assert.equal(t.activeKeys, 2);             // k1, k3 (k2 revoked, k4 is mine)
  assert.equal(t.paidCustomers, 1);          // a
  assert.equal(t.kokoroChars + t.piperChars, 1500); // a: 1000 + 500; my 999,999 excluded
  assert.equal(m.buildFunnel(i)[0]!.count, 2);
  assert.ok(!m.buildCustomers(i).some((c: any) => c.userId === 'me'));
});

test('totals: kokoro/piper split, stt minutes, free chars, credits', async () => {
  const m = await modP; const t = m.buildTotals(await inputs());
  assert.equal(t.piperChars, 400);
  assert.equal(t.kokoroChars, 1100);         // (1000-400) + 500
  assert.equal(t.sttMinutes, 2);
  assert.equal(t.freeCharsUsed, 300);
  assert.equal(t.creditsGranted, 2000);
  assert.equal(t.creditsUsed, 1400);
});

test('a comped account is not a paying customer and is shown as comped', async () => {
  const m = await modP;
  const i = await inputs({ billing: [{ user_id: 'a', active: true, comped: true }] });
  assert.equal(m.buildTotals(i).paidCustomers, 0);
  assert.equal(m.buildFunnel(i)[3]!.count, 0);
  assert.equal(m.buildCustomers(i).find((c: any) => c.userId === 'a')!.status, 'comped');
});

test('range 24h only counts usage from the last UTC day', async () => {
  const m = await modP; const t = m.buildTotals(await inputs({ range: '24h' }));
  assert.equal(t.kokoroChars + t.piperChars, 1000);
});

test('funnel stages count accounts that reached each step', async () => {
  const m = await modP; const f = m.buildFunnel(await inputs());
  assert.deepEqual(f.map((s: any) => [s.stage, s.count]), [
    ['Created a key', 2], ['Made a first request', 2], ['Used up free credits', 1], ['Added a card', 1],
  ]);
});

test('customers: status, credits left, usage windows and first/last request', async () => {
  const m = await modP; const cs = m.buildCustomers(await inputs());
  const a = cs.find((c: any) => c.userId === 'a')!, b = cs.find((c: any) => c.userId === 'b')!;
  assert.equal(a.status, 'paid'); assert.equal(a.activeKeys, 1); assert.equal(a.creditsLeft, 600);
  assert.equal(a.chars7d, 1500); assert.equal(a.firstRequest, '2026-10-07'); assert.equal(a.lastRequest, '2026-10-08T10:00:00Z');
  assert.equal(b.status, 'at limit'); assert.equal(b.creditsLeft, 0);
});

test('attention: down/slow workers, at-limit without a card, spikes, STT failures', async () => {
  const m = await modP;
  const usage = [
    ...Array.from({ length: 7 }, (_, d) => use('a', `2026-10-0${1 + d}`, { chars: 10000 })),
    use('a', '2026-10-08', { chars: 600000 }),
  ];
  const stt = Array.from({ length: 3 }, (_, n) => ({ user_id: 'a', status: 'failed', created_at: `2026-10-08T11:${10 + n}:00Z` }));
  const i = await inputs({
    usage, stt,
    health: [{ name: 'piper', status: 'down', checkedAt: NOW.toISOString() }, { name: 'gateway', status: 'slow', latencyMs: 2100, checkedAt: NOW.toISOString() }],
  });
  const att = m.buildAttention(i, m.buildCustomers(i)).map((x: any) => x.text);
  assert.ok(att.includes('piper is down'));
  assert.ok(att.includes('gateway is slow (2100 ms)'));
  assert.ok(att.some((t: string) => t.startsWith('b@example.test is out of free credits')));
  assert.ok(att.some((t: string) => t.startsWith('a@example.test: usage spike')));
  assert.ok(att.includes('Batch STT: 3 failed requests in the last hour'));
});

test('no attention items when everything is healthy', async () => {
  const m = await modP; const i = await inputs({ credits: [], health: [{ name: 'gateway', status: 'up', checkedAt: NOW.toISOString() }] });
  assert.deepEqual(m.buildAttention(i, m.buildCustomers(i)), []);
});

test('series gives one row per UTC day with new accounts, chars and stt minutes', async () => {
  const m = await modP; const s = m.buildSeries(await inputs({ range: '7d' }));
  assert.equal(s.length, 7);
  assert.deepEqual(s[s.length - 1], { day: '2026-10-08', newAccounts: 0, chars: 1000, sttMinutes: 2 });
});

test('fetchAll pages past the 1,000-row server limit and stops on a short page', async () => {
  const { fetchAll } = await modP;
  const total = 2300; const seen: Array<[number, number]> = [];
  const rows = await fetchAll(async (from, to) => {
    seen.push([from, to]);
    return { data: Array.from({ length: Math.max(0, Math.min(total, to + 1) - from) }, (_, i) => ({ n: from + i })), error: null };
  }, 1000);
  assert.equal(rows.length, 2300);
  assert.deepEqual(seen, [[0, 999], [1000, 1999], [2000, 2999]]);
});

test('fetchAll throws on a database error', async () => {
  const { fetchAll } = await modP;
  await assert.rejects(() => fetchAll(async () => ({ data: null, error: { message: 'bad' } })), /bad/);
});

test('section captures a thrown error without throwing', async () => {
  const { section } = await modP;
  assert.deepEqual(await section(async () => 5), { ok: true, data: 5 });
  const bad = await section(async () => { throw new Error('nope'); });
  assert.deepEqual(bad, { ok: false, error: 'nope' });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx tsx --test src/lib/adminDashboard.test.ts`
Expected: FAIL (`Cannot find module './adminDashboard.js'`).

- [ ] **Step 3: Implement `backend/src/lib/adminDashboard.ts`** (types exactly as in Interfaces; the logic below)

```ts
import { billableChars } from './realtimeTtsBilling.js';

export type Range = '24h' | '7d' | '30d';
export const RANGE_DAYS: Record<Range, number> = { '24h': 1, '7d': 7, '30d': 30 };
export function parseRange(v: unknown): Range {
  return v === '24h' || v === '7d' || v === '30d' ? v : '7d';
}
export function parseExcludeEmails(raw: string | undefined): Set<string> {
  return new Set((raw ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean));
}

// ...interfaces AdminUser .. DashboardInputs exactly as listed above...

const DAY_MS = 86_400_000;
const utc = (d: Date) => d.toISOString().slice(0, 10);
const daysBack = (now: Date, n: number): string => utc(new Date(now.getTime() - (n - 1) * DAY_MS)); // first UTC day of an n-day window ending today

export function excludedUserIds(users: AdminUser[], excluded: Set<string>): Set<string> {
  return new Set(users.filter((u) => u.email && excluded.has(u.email.trim().toLowerCase())).map((u) => u.id));
}

function accountIds(i: DashboardInputs): Set<string> {
  const ex = excludedUserIds(i.users, i.excluded);
  return new Set(i.keys.map((k) => k.user_id).filter((id) => !ex.has(id)));
}
const inRange = (day: string, i: DashboardInputs) => day >= daysBack(i.now, RANGE_DAYS[i.range]);

export function buildTotals(i: DashboardInputs): Totals {
  const acc = accountIds(i);
  const keys = i.keys.filter((k) => acc.has(k.user_id));
  const firstKey = new Map<string, string>();
  for (const k of keys) { const cur = firstKey.get(k.user_id); if (!cur || k.created_at < cur) firstKey.set(k.user_id, k.created_at); }
  const since = new Date(`${daysBack(i.now, RANGE_DAYS[i.range])}T00:00:00Z`).toISOString();
  const rows = i.usage.filter((u) => acc.has(u.user_id) && inRange(u.day, i));
  const sum = (f: (u: UsageRow) => number) => rows.reduce((s, u) => s + f(u), 0);
  const credits = i.credits.filter((c) => acc.has(c.user_id));
  return {
    accounts: acc.size,
    activeKeys: keys.filter((k) => k.revoked_at === null).length,
    newAccounts: [...firstKey.values()].filter((c) => c >= since).length,
    kokoroChars: sum((u) => u.chars - u.piper_chars),
    piperChars: sum((u) => u.piper_chars),
    sttMinutes: sum((u) => u.audio_seconds) / 60,
    freeCharsUsed: sum((u) => u.free_chars),
    creditsGranted: credits.reduce((s, c) => s + c.granted, 0),
    creditsUsed: credits.reduce((s, c) => s + c.used, 0),
    paidCustomers: i.billing.filter((b) => b.active && !b.comped && acc.has(b.user_id)).length,
    billedUnits: sum((u) => billableChars({ chars: u.chars, piperChars: u.piper_chars, audioSeconds: u.audio_seconds })),
  };
}

const usedUp = (c: FreeCreditRow | undefined) => !!c && c.granted > 0 && c.used >= c.granted;

export function buildFunnel(i: DashboardInputs): FunnelStage[] {
  const acc = accountIds(i);
  const withUse = new Set(i.usage.filter((u) => acc.has(u.user_id) && (u.chars > 0 || u.audio_seconds > 0 || u.free_chars > 0)).map((u) => u.user_id));
  const credits = new Map(i.credits.map((c) => [c.user_id, c]));
  return [
    { stage: 'Created a key', count: acc.size },
    { stage: 'Made a first request', count: withUse.size },
    { stage: 'Used up free credits', count: [...acc].filter((id) => usedUp(credits.get(id))).length },
    { stage: 'Added a card', count: i.billing.filter((b) => b.active && !b.comped && acc.has(b.user_id)).length },
  ];
}

export function buildCustomers(i: DashboardInputs): Customer[] {
  const acc = accountIds(i);
  const emails = new Map(i.users.map((u) => [u.id, u]));
  const credits = new Map(i.credits.map((c) => [c.user_id, c]));
  const paid = new Set(i.billing.filter((b) => b.active && !b.comped).map((b) => b.user_id));
  const comped = new Set(i.billing.filter((b) => b.active && b.comped).map((b) => b.user_id));
  const since7 = daysBack(i.now, 7);
  return [...acc].map((id): Customer => {
    const rows = i.usage.filter((u) => u.user_id === id);
    const recent = rows.filter((u) => u.day >= since7);
    const c = credits.get(id);
    const days = rows.map((u) => u.day).sort();
    const last = rows.map((u) => u.updated_at).sort().pop() ?? null;
    return {
      userId: id,
      email: emails.get(id)?.email ?? null,
      signedUp: emails.get(id)?.created_at ?? '',
      activeKeys: i.keys.filter((k) => k.user_id === id && k.revoked_at === null).length,
      firstRequest: days[0] ?? null,
      lastRequest: last,
      chars7d: recent.reduce((s, u) => s + u.chars, 0),
      sttMinutes7d: recent.reduce((s, u) => s + u.audio_seconds, 0) / 60,
      creditsLeft: c ? Math.max(0, c.granted - c.used) : 0,
      status: comped.has(id) ? 'comped' : paid.has(id) ? 'paid' : usedUp(c) ? 'at limit' : 'free',
    };
  }).sort((a, b) => (b.lastRequest ?? '').localeCompare(a.lastRequest ?? ''));
}

export function buildAttention(i: DashboardInputs, customers: Customer[]): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const h of i.health) {
    if (h.status === 'down') out.push({ level: 'warn', text: `${h.name} is down` });
    if (h.status === 'slow') out.push({ level: 'warn', text: `${h.name} is slow (${h.latencyMs} ms)` });
  }
  for (const c of customers) if (c.status === 'at limit') out.push({ level: 'warn', text: `${c.email ?? c.userId} is out of free credits and has no card` });
  const today = utc(i.now), prior = new Set(Array.from({ length: 7 }, (_, n) => utc(new Date(i.now.getTime() - (n + 1) * DAY_MS))));
  for (const c of customers) {
    const rows = i.usage.filter((u) => u.user_id === c.userId);
    const todayChars = rows.filter((u) => u.day === today).reduce((s, u) => s + u.chars, 0);
    const priorAvg = rows.filter((u) => prior.has(u.day)).reduce((s, u) => s + u.chars, 0) / 7;
    if (todayChars >= 100_000 && todayChars >= 5 * priorAvg) out.push({ level: 'warn', text: `${c.email ?? c.userId}: usage spike` });
  }
  const hourAgo = new Date(i.now.getTime() - 3_600_000).toISOString();
  const failed = i.stt.filter((s) => s.status === 'failed' && s.created_at >= hourAgo).length;
  if (failed >= 3) out.push({ level: 'warn', text: `Batch STT: ${failed} failed requests in the last hour` });
  return out;
}

export function buildSeries(i: DashboardInputs) {
  const acc = accountIds(i);
  const n = RANGE_DAYS[i.range];
  const firstKey = new Map<string, string>();
  for (const k of i.keys) if (acc.has(k.user_id)) { const cur = firstKey.get(k.user_id); if (!cur || k.created_at < cur) firstKey.set(k.user_id, k.created_at); }
  return Array.from({ length: n }, (_, idx) => {
    const day = utc(new Date(i.now.getTime() - (n - 1 - idx) * DAY_MS));
    const rows = i.usage.filter((u) => u.day === day && acc.has(u.user_id));
    return {
      day,
      newAccounts: [...firstKey.values()].filter((c) => c.slice(0, 10) === day).length,
      chars: rows.reduce((s, u) => s + u.chars, 0),
      sttMinutes: rows.reduce((s, u) => s + u.audio_seconds, 0) / 60,
    };
  });
}

export async function fetchAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>, size = 1000,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += size) {
    const { data, error } = await page(from, from + size - 1);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < size) return out;
  }
}

export async function section<T>(fn: () => Promise<T> | T): Promise<Section<T>> {
  try { return { ok: true, data: await fn() }; } catch (e) { return { ok: false, error: (e as Error).message || 'failed' }; }
}
```

Series test expectation check: with `range: '7d'` at 2026-10-08, the last row is 2026-10-08 with chars 1000 (user a) + 0 (b has free chars only; `me` excluded) and sttMinutes 2: matches the test.

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx tsx --test --experimental-test-module-mocks src/lib/adminDashboard.test.ts && npm run typecheck`
Expected: all pass; typecheck clean.

- [ ] **Step 5: Append the test to the `test` script and commit**

```bash
git add backend/src/lib/adminDashboard.ts backend/src/lib/adminDashboard.test.ts backend/package.json
git commit -m "feat: admin dashboard aggregators (totals, funnel, customers, attention, series)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Fetching real data and assembling the response (`buildDashboard`)

**Files:**
- Modify: `backend/src/lib/adminDashboard.ts` (append)
- Test: `backend/src/lib/adminDashboard.test.ts` (append)

**Interfaces:**
- Consumes: Task 4's types and builders; `HealthItem` from Task 7 (type only, defined in Task 4).
- Produces:

```ts
export interface DashboardDeps {
  now(): Date;
  listUsers(): Promise<AdminUser[]>;
  listKeys(): Promise<KeyRow[]>;
  listUsage(sinceDay: string): Promise<UsageRow[]>;
  listFreeCredits(): Promise<FreeCreditRow[]>;
  listBilling(): Promise<BillingRow[]>;
  listRecentStt(sinceIso: string): Promise<SttRow[]>;
  probes(usage: UsageRow[], stt: SttRow[]): Promise<HealthItem[]>;
}
export interface DashboardResponse {
  generatedAt: string; range: Range; usageSince: string | null;
  attention: Section<AttentionItem[]>; health: Section<HealthItem[]>; totals: Section<Totals>;
  funnel: Section<FunnelStage[]>; customers: Section<Customer[]>; series: Section<ReturnType<typeof buildSeries>>;
}
export async function buildDashboard(deps: DashboardDeps, opts: { range: Range; excludeEmails: Set<string> }): Promise<DashboardResponse>;
export const defaultDashboardDeps: DashboardDeps; // Supabase-backed, uses fetchAll and auth.admin.listUsers paging
```

`usageSince` = the earliest `day` in `realtimetts_usage_daily` (so the page can label "since <date>"), or `null` when empty.

- [ ] **Step 1: Write the failing tests**

```ts
test('buildDashboard returns every section and labels usage history start', async () => {
  const m = await modP; const base = await inputs();
  const deps = {
    now: () => NOW, listUsers: async () => base.users, listKeys: async () => base.keys, listUsage: async () => base.usage,
    listFreeCredits: async () => base.credits, listBilling: async () => base.billing, listRecentStt: async () => [],
    probes: async () => [{ name: 'gateway', status: 'up', latencyMs: 40, checkedAt: NOW.toISOString() }],
  };
  const r = await m.buildDashboard(deps as any, { range: '7d', excludeEmails: base.excluded });
  for (const k of ['attention', 'health', 'totals', 'funnel', 'customers', 'series']) assert.equal((r as any)[k].ok, true, k);
  assert.equal(r.usageSince, '2026-10-07');
  assert.equal((r.totals as any).data.accounts, 2);
});

test('one failing source blanks only the sections that need it', async () => {
  const m = await modP; const base = await inputs();
  const deps = {
    now: () => NOW, listUsers: async () => base.users, listKeys: async () => base.keys,
    listUsage: async () => { throw new Error('usage table missing'); },
    listFreeCredits: async () => base.credits, listBilling: async () => base.billing, listRecentStt: async () => [],
    probes: async () => [],
  };
  const r = await m.buildDashboard(deps as any, { range: '7d', excludeEmails: base.excluded });
  assert.equal(r.totals.ok, false);
  assert.match((r.totals as any).error, /usage table missing/);
  assert.equal(r.health.ok, true);       // health does not depend on the usage table
});

test('a failing probe set does not take down the other sections', async () => {
  const m = await modP; const base = await inputs();
  const deps = {
    now: () => NOW, listUsers: async () => base.users, listKeys: async () => base.keys, listUsage: async () => base.usage,
    listFreeCredits: async () => base.credits, listBilling: async () => base.billing, listRecentStt: async () => [],
    probes: async () => { throw new Error('probe boom'); },
  };
  const r = await m.buildDashboard(deps as any, { range: '24h', excludeEmails: base.excluded });
  assert.equal(r.health.ok, false);
  assert.equal(r.customers.ok, true);
  assert.equal(r.totals.ok, true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx tsx --test src/lib/adminDashboard.test.ts`
Expected: FAIL (`m.buildDashboard is not a function`).

- [ ] **Step 3: Implement `buildDashboard` and the default Supabase deps** (append to `adminDashboard.ts`)

```ts
import { supabase } from './supabaseClient.js';

export async function buildDashboard(deps: DashboardDeps, opts: { range: Range; excludeEmails: Set<string> }): Promise<DashboardResponse> {
  const now = deps.now();
  const range = opts.range;
  const sinceDay = utc(new Date(now.getTime() - 30 * DAY_MS)); // one fetch covers 24h/7d/30d and the spike baseline
  const [users, keys, usage, credits, billing, stt] = await Promise.all([
    section(() => deps.listUsers()), section(() => deps.listKeys()), section(() => deps.listUsage(sinceDay)),
    section(() => deps.listFreeCredits()), section(() => deps.listBilling()), section(() => deps.listRecentStt(new Date(now.getTime() - 3_600_000).toISOString())),
  ]);
  const health = await section(() => deps.probes(usage.ok ? usage.data : [], stt.ok ? stt.data : []));
  const need = <T extends { ok: boolean }>(...s: T[]) => s.find((x) => !x.ok) as ({ ok: false; error: string } | undefined);
  const build = <T>(deps_: Array<Section<any>>, f: (i: DashboardInputs) => T): Section<T> => {
    const bad = need(...deps_);
    if (bad) return { ok: false, error: bad.error };
    const i: DashboardInputs = {
      users: (users as any).data, keys: (keys as any).data, usage: usage.ok ? usage.data : [], credits: credits.ok ? credits.data : [],
      billing: billing.ok ? billing.data : [], stt: stt.ok ? stt.data : [], health: health.ok ? health.data : [], now, range, excluded: opts.excludeEmails,
    };
    try { return { ok: true, data: f(i) }; } catch (e) { return { ok: false, error: (e as Error).message }; }
  };
  const customers = build([users, keys, usage, credits, billing], (i) => buildCustomers(i));
  return {
    generatedAt: now.toISOString(), range,
    usageSince: usage.ok ? ([...usage.data.map((u) => u.day)].sort()[0] ?? null) : null,
    health,
    totals: build([users, keys, usage, credits, billing], (i) => buildTotals(i)),
    funnel: build([users, keys, usage, credits, billing], (i) => buildFunnel(i)),
    customers,
    series: build([users, keys, usage], (i) => buildSeries(i)),
    attention: build([users, keys, usage, credits, billing], (i) => buildAttention(i, customers.ok ? customers.data : [])),
  };
}

export const defaultDashboardDeps: DashboardDeps = {
  now: () => new Date(),
  async listUsers() {
    const out: AdminUser[] = [];
    for (let page = 1; ; page++) {
      const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) throw new Error(error.message);
      out.push(...data.users.map((u) => ({ id: u.id, email: u.email ?? null, created_at: u.created_at })));
      if (data.users.length < 1000) return out;
    }
  },
  listKeys: () => fetchAll<KeyRow>((f, t) => supabase.from('realtimetts_api_keys').select('user_id, gateway_key_id, created_at, revoked_at').order('created_at').range(f, t)),
  listUsage: (sinceDay) => fetchAll<UsageRow>((f, t) => supabase.from('realtimetts_usage_daily').select('day, user_id, chars, piper_chars, audio_seconds, free_chars, updated_at').gte('day', sinceDay).order('day').range(f, t)),
  listFreeCredits: () => fetchAll<FreeCreditRow>((f, t) => supabase.from('realtimetts_free_credits').select('user_id, granted, used').order('user_id').range(f, t)),
  listBilling: () => fetchAll<BillingRow>((f, t) => supabase.from('realtimetts_billing').select('user_id, active, comped').order('user_id').range(f, t)),
  listRecentStt: (sinceIso) => fetchAll<SttRow>((f, t) => supabase.from('stt_transcriptions').select('user_id, status, created_at').gte('created_at', sinceIso).order('created_at').range(f, t)),
  probes: async (usage, stt) => (await import('./adminHealth.js')).collectHealth({ usage, stt, now: new Date() }),
};
```

Note `listUsage` is ordered by `day` and paged by `range`; the result is typed through `fetchAll`'s generic. If `tsc` rejects the Supabase builder as a `PromiseLike` of `{data, error}`, cast the builder result with `as unknown as PromiseLike<{ data: T[] | null; error: { message: string } | null }>`; do not weaken the exported types.

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx tsx --test --experimental-test-module-mocks src/lib/adminDashboard.test.ts && npm run typecheck`
Expected: all pass (Task 7 creates `adminHealth.ts`; until then create an empty stub exporting `collectHealth` so the dynamic import type-checks, and replace it in Task 7).

- [ ] **Step 5: Commit**

```bash
git add backend/src/lib/adminDashboard.ts backend/src/lib/adminDashboard.test.ts
git commit -m "feat: buildDashboard assembles independent sections from Supabase

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Admin bearer check (`adminBearer.ts`)

**Files:**
- Create: `backend/src/lib/adminBearer.ts`
- Test: `backend/src/lib/adminBearer.test.ts`

**Interfaces:**
- Produces:

```ts
export interface BearerUser { id: string; email?: string | null; email_confirmed_at?: string | null; identities?: Array<{ provider: string }> | null }
export interface AdminBearerDeps { getUser(token: string): Promise<BearerUser | null>; adminEmails: string[] }
export function adminEmailsFromEnv(env?: NodeJS.ProcessEnv): string[];            // ADMIN_EMAILS, lower-cased, no default
export async function isAdminBearer(authorization: string | undefined, deps?: AdminBearerDeps): Promise<boolean>;
```

- [ ] **Step 1: Write the failing tests**

```ts
// backend/src/lib/adminBearer.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';

const modP = import('./adminBearer.js');
const ok = { id: 'u', email: 'Boss@Example.test', email_confirmed_at: '2026-01-01T00:00:00Z', identities: [{ provider: 'google' }] };
const deps = (user: any, emails = ['boss@example.test']) => ({ getUser: async () => user, adminEmails: emails });

test('valid Google, confirmed, allowlisted (case-insensitive) is admin', async () => {
  const { isAdminBearer } = await modP;
  assert.equal(await isAdminBearer('Bearer t', deps(ok)), true);
});

test('missing or malformed header is not admin', async () => {
  const { isAdminBearer } = await modP;
  for (const h of [undefined, '', 'Basic abc', 'Bearer', 'Bearer ']) assert.equal(await isAdminBearer(h as any, deps(ok)), false);
});

test('email/password login of the admin address is not admin', async () => {
  const { isAdminBearer } = await modP;
  assert.equal(await isAdminBearer('Bearer t', deps({ ...ok, identities: [{ provider: 'email' }] })), false);
  assert.equal(await isAdminBearer('Bearer t', deps({ ...ok, identities: null })), false);
});

test('unconfirmed email, other address, no user are not admin', async () => {
  const { isAdminBearer } = await modP;
  assert.equal(await isAdminBearer('Bearer t', deps({ ...ok, email_confirmed_at: null })), false);
  assert.equal(await isAdminBearer('Bearer t', deps({ ...ok, email: 'other@example.test' })), false);
  assert.equal(await isAdminBearer('Bearer t', deps(null)), false);
});

test('an empty allowlist fails closed', async () => {
  const { isAdminBearer } = await modP;
  assert.equal(await isAdminBearer('Bearer t', deps(ok, [])), false);
});

test('a token-verification error (Supabase down) is not admin and never throws', async () => {
  const { isAdminBearer } = await modP;
  assert.equal(await isAdminBearer('Bearer t', { getUser: async () => { throw new Error('down'); }, adminEmails: ['boss@example.test'] }), false);
});

test('adminEmailsFromEnv has no default and normalizes', async () => {
  const { adminEmailsFromEnv } = await modP;
  assert.deepEqual(adminEmailsFromEnv({} as any), []);
  assert.deepEqual(adminEmailsFromEnv({ ADMIN_EMAILS: ' A@x.test, ,b@X.test' } as any), ['a@x.test', 'b@x.test']);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx tsx --test src/lib/adminBearer.test.ts`
Expected: FAIL (`Cannot find module './adminBearer.js'`).

- [ ] **Step 3: Implement**

```ts
// backend/src/lib/adminBearer.ts
// Strict admin check for the dashboard endpoint. Deliberately NOT requireAuth (that middleware falls back to a default
// user for empty tokens and skips auth outside production). Same rule as web/src/lib/adminAuth.ts, but with no default
// admin address: an unset ADMIN_EMAILS means nobody is admin.
import { supabase } from './supabaseClient.js';

export interface BearerUser { id: string; email?: string | null; email_confirmed_at?: string | null; identities?: Array<{ provider: string }> | null }
export interface AdminBearerDeps { getUser(token: string): Promise<BearerUser | null>; adminEmails: string[] }

export function adminEmailsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.ADMIN_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
}

const defaultDeps = (): AdminBearerDeps => ({
  adminEmails: adminEmailsFromEnv(),
  async getUser(token) {
    const { data, error } = await supabase.auth.getUser(token);
    return error ? null : (data.user as unknown as BearerUser | null);
  },
});

export async function isAdminBearer(authorization: string | undefined, deps: AdminBearerDeps = defaultDeps()): Promise<boolean> {
  if (!authorization?.startsWith('Bearer ')) return false;
  const token = authorization.slice(7).trim();
  if (!token) return false;
  try {
    const user = await deps.getUser(token);
    if (!user?.email || !user.email_confirmed_at) return false;
    if (!(user.identities ?? []).some((i) => i.provider === 'google')) return false;
    return deps.adminEmails.includes(user.email.trim().toLowerCase());
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx tsx --test src/lib/adminBearer.test.ts && npm run typecheck`
Expected: 7 passed.

- [ ] **Step 5: Append to the `test` script and commit**

```bash
git add backend/src/lib/adminBearer.ts backend/src/lib/adminBearer.test.ts backend/package.json
git commit -m "feat: strict fail-closed admin bearer check for the dashboard endpoint

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Health probes and passive health (`adminHealth.ts`)

**Files:**
- Create: `backend/src/lib/adminHealth.ts` (replace the Task 5 stub)
- Test: `backend/src/lib/adminHealth.test.ts`

**Interfaces:**
- Consumes: `HealthItem`, `UsageRow`, `SttRow` from Task 4.
- Produces:

```ts
export interface ProbeTarget { name: string; url: string }
export function parseProbeTargets(env?: NodeJS.ProcessEnv): ProbeTarget[];   // ADMIN_HEALTH_TARGETS='{"gateway":"https://...","piper":"https://..."}'; unset => gateway from TTS_GATEWAY_URL + '/health' when set
export async function probeTarget(t: ProbeTarget, fetchImpl?: typeof fetch, now?: () => number): Promise<HealthItem>;
export function passiveHealth(args: { usage: UsageRow[]; stt: SttRow[]; now: Date }): HealthItem[];
export async function collectHealth(args: { usage: UsageRow[]; stt: SttRow[]; now: Date }, fetchImpl?: typeof fetch): Promise<HealthItem[]>;
```

Rules: a probe is `up` for any 2xx within 1,500 ms, `slow` for a 2xx slower than 1,500 ms, `down` on a non-2xx, network error or a 4 s timeout. Kokoro and batch STT are NEVER probed (a probe wakes a Modal container and costs money): `passiveHealth` returns `{name:'kokoro', status:'asleep'|'up', detail:'last usage <iso>'}` from the newest `usage.updated_at` (asleep = none in 10 minutes, unknown = no rows) and `{name:'stt', ...}` from the newest `stt` row (`up` if its status is `done`, `down` if the newest 3 are all `failed`, `asleep` = no row in the last hour, `unknown` = no rows).

- [ ] **Step 1: Write the failing tests**

```ts
// backend/src/lib/adminHealth.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
const modP = import('./adminHealth.js');
const NOW = new Date('2026-10-08T12:00:00Z');

test('parseProbeTargets reads ADMIN_HEALTH_TARGETS JSON and ignores junk', async () => {
  const { parseProbeTargets } = await modP;
  assert.deepEqual(parseProbeTargets({ ADMIN_HEALTH_TARGETS: '{"gateway":"https://g.example.test/health"}' } as any), [{ name: 'gateway', url: 'https://g.example.test/health' }]);
  assert.deepEqual(parseProbeTargets({ ADMIN_HEALTH_TARGETS: 'not json' } as any), []);
  assert.deepEqual(parseProbeTargets({ ADMIN_HEALTH_TARGETS: '{"x":5}' } as any), []);
});

test('parseProbeTargets falls back to the gateway health URL when only TTS_GATEWAY_URL is set', async () => {
  const { parseProbeTargets } = await modP;
  assert.deepEqual(parseProbeTargets({ TTS_GATEWAY_URL: 'https://g.example.test' } as any), [{ name: 'gateway', url: 'https://g.example.test/health' }]);
});

const resp = (status: number) => async () => new Response('{}', { status });

test('probeTarget: 2xx fast = up; 2xx slow = slow; non-2xx and errors = down', async () => {
  const { probeTarget } = await modP;
  let t = 0;
  const clock = () => (t += 100);
  assert.equal((await probeTarget({ name: 'a', url: 'https://x' }, resp(200) as any, clock)).status, 'up');
  let t2 = 0;
  const slow = () => (t2 += 2000);
  assert.equal((await probeTarget({ name: 'a', url: 'https://x' }, resp(200) as any, slow)).status, 'slow');
  assert.equal((await probeTarget({ name: 'a', url: 'https://x' }, resp(503) as any, clock)).status, 'down');
  const boom = async () => { throw new Error('ECONNREFUSED'); };
  const d = await probeTarget({ name: 'a', url: 'https://x' }, boom as any, clock);
  assert.equal(d.status, 'down'); assert.match(d.detail ?? '', /ECONNREFUSED/);
});

test('passiveHealth never probes: kokoro from usage freshness, stt from recent requests', async () => {
  const { passiveHealth } = await modP;
  const fresh = [{ day: '2026-10-08', user_id: 'u', chars: 1, piper_chars: 0, audio_seconds: 0, free_chars: 0, updated_at: '2026-10-08T11:58:00Z' }];
  const stale = [{ ...fresh[0]!, updated_at: '2026-10-08T09:00:00Z' }];
  assert.equal(passiveHealth({ usage: fresh, stt: [], now: NOW }).find((h) => h.name === 'kokoro')!.status, 'up');
  assert.equal(passiveHealth({ usage: stale, stt: [], now: NOW }).find((h) => h.name === 'kokoro')!.status, 'asleep');
  assert.equal(passiveHealth({ usage: [], stt: [], now: NOW }).find((h) => h.name === 'kokoro')!.status, 'unknown');
  const failed = ['11:50', '11:51', '11:52'].map((m) => ({ user_id: 'u', status: 'failed', created_at: `2026-10-08T${m}:00Z` }));
  assert.equal(passiveHealth({ usage: [], stt: failed, now: NOW }).find((h) => h.name === 'stt')!.status, 'down');
  assert.equal(passiveHealth({ usage: [], stt: [{ user_id: 'u', status: 'done', created_at: '2026-10-08T11:59:00Z' }], now: NOW }).find((h) => h.name === 'stt')!.status, 'up');
});

test('collectHealth merges probes and passive items, and one failing probe is only that item', async () => {
  const { collectHealth } = await modP;
  const f = async (url: any) => { if (String(url).includes('bad')) throw new Error('nope'); return new Response('{}', { status: 200 }); };
  process.env.ADMIN_HEALTH_TARGETS = '{"good":"https://good.example.test","bad":"https://bad.example.test"}';
  try {
    const items = await collectHealth({ usage: [], stt: [], now: NOW }, f as any);
    const by = Object.fromEntries(items.map((h) => [h.name, h.status]));
    assert.equal(by.good, 'up'); assert.equal(by.bad, 'down'); assert.ok('kokoro' in by && 'stt' in by);
  } finally { delete process.env.ADMIN_HEALTH_TARGETS; }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx tsx --test src/lib/adminHealth.test.ts`
Expected: FAIL (stub does not export `parseProbeTargets`).

- [ ] **Step 3: Implement**

```ts
// backend/src/lib/adminHealth.ts
import type { HealthItem, UsageRow, SttRow } from './adminDashboard.js';

export interface ProbeTarget { name: string; url: string }
const SLOW_MS = 1500, TIMEOUT_MS = 4000, KOKORO_AWAKE_MS = 10 * 60_000, STT_AWAKE_MS = 60 * 60_000;

export function parseProbeTargets(env: NodeJS.ProcessEnv = process.env): ProbeTarget[] {
  if (env.ADMIN_HEALTH_TARGETS) {
    try {
      const o = JSON.parse(env.ADMIN_HEALTH_TARGETS) as Record<string, unknown>;
      return Object.entries(o).filter(([, v]) => typeof v === 'string' && /^https?:\/\//.test(v)).map(([name, url]) => ({ name, url: url as string }));
    } catch { return []; }
  }
  return env.TTS_GATEWAY_URL ? [{ name: 'gateway', url: `${env.TTS_GATEWAY_URL.replace(/\/$/, '')}/health` }] : [];
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
```

Note: `listRecentStt` only fetches the last hour, so `stt` is `unknown`/`asleep` outside active periods; that is intended ("asleep" = nothing in the last hour).

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx tsx --test src/lib/adminHealth.test.ts src/lib/adminDashboard.test.ts && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Append to the `test` script and commit**

```bash
git add backend/src/lib/adminHealth.ts backend/src/lib/adminHealth.test.ts backend/package.json
git commit -m "feat: health probes (gateway/Piper) and passive Kokoro/STT health without waking Modal

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The route, and mounting it before the generic admin router

**Files:**
- Create: `backend/src/routes/adminDashboard.ts`
- Modify: `backend/src/index.ts` (mount before `app.use('/api/admin', adminRouter)`)
- Test: `backend/src/routes/adminDashboard.test.ts`

**Interfaces:**
- Consumes: `isAdminBearer`/`AdminBearerDeps` (Task 6), `buildDashboard`, `defaultDashboardDeps`, `parseRange`, `parseExcludeEmails`, `DashboardDeps` (Tasks 4 and 5).
- Produces: `export function createAdminDashboardRouter(opts?: { isAdmin?: (auth?: string) => Promise<boolean>; deps?: DashboardDeps; excludeEmails?: () => Set<string> }): Router` and `export const adminDashboardRouter` (default wiring).

- [ ] **Step 1: Write the failing tests** (use a real Express app on an ephemeral port, as other route tests in this repo do; check `src/routes/ttsApiKeys.test.ts` for the local helper and copy its server-start pattern)

```ts
// backend/src/routes/adminDashboard.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';

const modP = import('./adminDashboard.js');
const NOW = new Date('2026-10-08T12:00:00Z');
const deps = {
  now: () => NOW, listUsers: async () => [{ id: 'a', email: 'a@example.test', created_at: '2026-09-01T00:00:00Z' }],
  listKeys: async () => [{ user_id: 'a', gateway_key_id: 'k1', created_at: '2026-09-02T00:00:00Z', revoked_at: null }],
  listUsage: async () => [], listFreeCredits: async () => [], listBilling: async () => [], listRecentStt: async () => [], probes: async () => [],
};

async function serve(isAdmin: (a?: string) => Promise<boolean>, extra: Record<string, unknown> = {}) {
  const { createAdminDashboardRouter } = await modP;
  const app = express();
  app.use('/api/admin/dashboard', createAdminDashboardRouter({ isAdmin, deps: deps as any, excludeEmails: () => new Set(), ...extra }));
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/admin/dashboard`;
  return { base, close: () => srv.close() };
}

test('non-admin (anonymous, wrong account, anything) gets 404 "Not found" with no data', async () => {
  const s = await serve(async () => false);
  try {
    for (const h of [{}, { Authorization: 'Bearer nope' }]) {
      const r = await fetch(s.base, { headers: h });
      assert.equal(r.status, 404);
      assert.equal(await r.text(), 'Not found');
    }
  } finally { s.close(); }
});

test('admin gets 200 JSON with every section, no-store, and the default range is 7d', async () => {
  const s = await serve(async (a) => a === 'Bearer good');
  try {
    const r = await fetch(s.base, { headers: { Authorization: 'Bearer good' } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const j: any = await r.json();
    assert.equal(j.range, '7d');
    for (const k of ['attention', 'health', 'totals', 'funnel', 'customers', 'series']) assert.ok(k in j, k);
    assert.equal(j.totals.data.accounts, 1);
  } finally { s.close(); }
});

test('range query: valid is honored, junk falls back to 7d', async () => {
  const s = await serve(async () => true);
  try {
    assert.equal(((await (await fetch(`${s.base}?range=30d`)).json()) as any).range, '30d');
    assert.equal(((await (await fetch(`${s.base}?range=999d`)).json()) as any).range, '7d');
    assert.equal(((await (await fetch(`${s.base}?range=24h&range=30d`)).json()) as any).range, '7d');
  } finally { s.close(); }
});

test('the admin check throwing is a 404, not a 500', async () => {
  const s = await serve(async () => { throw new Error('supabase down'); });
  try { assert.equal((await fetch(s.base, { headers: { Authorization: 'Bearer x' } })).status, 404); } finally { s.close(); }
});

test('only GET is allowed', async () => {
  const s = await serve(async () => true);
  try { assert.equal((await fetch(s.base, { method: 'POST' })).status, 404); } finally { s.close(); }
});

test('one failing data source still returns 200 with that section marked failed', async () => {
  const s = await serve(async () => true, { deps: { ...deps, listUsage: async () => { throw new Error('usage table missing'); } } });
  try {
    const j: any = await (await fetch(s.base)).json();
    assert.equal(j.totals.ok, false);
    assert.equal(j.health.ok, true);
  } finally { s.close(); }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx tsx --test src/routes/adminDashboard.test.ts`
Expected: FAIL (`Cannot find module './adminDashboard.js'`).

- [ ] **Step 3: Implement the route and mount it**

```ts
// backend/src/routes/adminDashboard.ts
// GET /api/admin/dashboard?range=24h|7d|30d. Admin-only (Supabase bearer, Google, confirmed, ADMIN_EMAILS); 404 otherwise.
// Mounted BEFORE the generic /api/admin router (which wants x-admin-key). Not behind requireAuth on purpose.
import { Router, type Request, type Response } from 'express';
import { isAdminBearer } from '../lib/adminBearer.js';
import { buildDashboard, defaultDashboardDeps, parseExcludeEmails, parseRange, type DashboardDeps } from '../lib/adminDashboard.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ module: 'admin-dashboard' });

export function createAdminDashboardRouter(opts: {
  isAdmin?: (authorization?: string) => Promise<boolean>;
  deps?: DashboardDeps;
  excludeEmails?: () => Set<string>;
} = {}): Router {
  const isAdmin = opts.isAdmin ?? ((a?: string) => isAdminBearer(a));
  const deps = opts.deps ?? defaultDashboardDeps;
  const exclude = opts.excludeEmails ?? (() => parseExcludeEmails(process.env.ADMIN_EXCLUDE_EMAILS));
  const router = Router();

  const notFound = (res: Response) => res.status(404).type('text/plain').send('Not found');

  router.get('/', async (req: Request, res: Response) => {
    let admin = false;
    try { admin = await isAdmin(req.headers.authorization); } catch { admin = false; }
    if (!admin) return notFound(res);
    try {
      const range = parseRange(typeof req.query.range === 'string' ? req.query.range : undefined);
      const body = await buildDashboard(deps, { range, excludeEmails: exclude() });
      res.set('Cache-Control', 'no-store').json(body);
    } catch (err) {
      log.error({ err: (err as Error).message }, 'admin dashboard failed');
      res.status(500).set('Cache-Control', 'no-store').json({ error: 'dashboard failed' });
    }
  });
  router.all('/', (_req, res) => notFound(res)); // anything but GET looks like nothing is here
  return router;
}

export const adminDashboardRouter = createAdminDashboardRouter();
```

In `backend/src/index.ts`, add `import { adminDashboardRouter } from './routes/adminDashboard.js';` with the other route imports and, immediately ABOVE `app.use('/api/admin', adminRouter);` (and next to the `voiceCloneAdminRouter` mount):

```ts
// Admin dashboard: verifies the Supabase bearer itself (404 for everyone but the allowlisted admin). Must come before adminRouter.
app.use('/api/admin/dashboard', adminDashboardRouter);
```

- [ ] **Step 4: Run to verify it passes, then the whole suite**

Run: `cd backend && npx tsx --test --experimental-test-module-mocks src/routes/adminDashboard.test.ts && npm run typecheck && npm test`
Expected: all pass.

- [ ] **Step 5: Append the route test to the `test` script and commit**

```bash
git add backend/src/routes/adminDashboard.ts backend/src/routes/adminDashboard.test.ts backend/src/index.ts backend/package.json
git commit -m "feat: GET /api/admin/dashboard (admin-only, fails closed, mounted before the generic admin router)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Web: types, formatters and the proxy helper

**Files:**
- Create: `web/src/lib/adminBusiness.ts` (no relative imports)
- Create: `web/src/lib/adminProxy.ts`
- Create: `web/src/app/api/admin/dashboard/route.ts`
- Test: `web/test/admin-business.test.ts`, `web/test/admin-proxy.test.ts`

**Interfaces:**
- Produces (`adminBusiness.ts`): the response types mirroring `DashboardResponse` (`Section<T>`, `Totals`, `Customer`, `FunnelStage`, `AttentionItem`, `HealthItem`, `SeriesRow`, `DashboardData`); `fmtNumber(n: number): string` (thousands separators, `—` for NaN); `fmtChars(n)` ("1.2M", "340k", "950"); `fmtMinutes(n)` ("12.5 min", "3.2 h"); `fmtAgo(iso: string | null, now?: number): string`; `statusTone(s: 'paid' | 'at limit' | 'free' | HealthStatus): 'good' | 'warn' | 'muted'`; `funnelPercent(stages: FunnelStage[]): Array<FunnelStage & { pct: number }>` (each stage as a percent of the first, 0 when the first is 0); `sortCustomers(rows, key, dir)`.
- Produces (`adminProxy.ts`): `forwardAdminDashboard(opts: { fetchImpl?: typeof fetch; backendBase: string; authorization: string | null; range: string | null }): Promise<{ status: number; body: string; contentType: string }>` (returns 404 `Not found` when no Authorization header; never forwards cookies; 8 s timeout; maps a network error to 502 `{"error":"dashboard unavailable"}`).

- [ ] **Step 1: Write the failing tests**

```ts
// web/test/admin-business.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'

const m = await import('../src/lib/adminBusiness.ts')

test('fmtNumber / fmtChars / fmtMinutes', () => {
  assert.equal(m.fmtNumber(1234567), '1,234,567')
  assert.equal(m.fmtNumber(NaN), '—')
  assert.equal(m.fmtChars(950), '950')
  assert.equal(m.fmtChars(340_000), '340k')
  assert.equal(m.fmtChars(1_240_000), '1.2M')
  assert.equal(m.fmtMinutes(12.5), '12.5 min')
  assert.equal(m.fmtMinutes(192), '3.2 h')
  assert.equal(m.fmtMinutes(0), '0 min')
})

test('fmtAgo handles null and units', () => {
  const now = Date.parse('2026-10-08T12:00:00Z')
  assert.equal(m.fmtAgo(null, now), 'never')
  assert.equal(m.fmtAgo('2026-10-08T11:59:30Z', now), '30s ago')
  assert.equal(m.fmtAgo('2026-10-08T11:50:00Z', now), '10m ago')
  assert.equal(m.fmtAgo('2026-10-08T07:00:00Z', now), '5h ago')
  assert.equal(m.fmtAgo('2026-10-05T12:00:00Z', now), '3d ago')
})

test('statusTone maps customer and health states', () => {
  assert.equal(m.statusTone('paid'), 'good')
  assert.equal(m.statusTone('up'), 'good')
  assert.equal(m.statusTone('at limit'), 'warn')
  assert.equal(m.statusTone('down'), 'warn')
  assert.equal(m.statusTone('slow'), 'warn')
  assert.equal(m.statusTone('free'), 'muted')
  assert.equal(m.statusTone('comped'), 'muted')
  assert.equal(m.statusTone('asleep'), 'muted')
  assert.equal(m.statusTone('unknown'), 'muted')
})

test('funnelPercent is relative to the first stage and safe at zero', () => {
  const out = m.funnelPercent([{ stage: 'a', count: 10 }, { stage: 'b', count: 4 }, { stage: 'c', count: 0 }])
  assert.deepEqual(out.map((s: any) => s.pct), [100, 40, 0])
  assert.deepEqual(m.funnelPercent([{ stage: 'a', count: 0 }, { stage: 'b', count: 0 }]).map((s: any) => s.pct), [0, 0])
})

test('sortCustomers sorts by key and direction, nulls last, without mutating', () => {
  const rows: any[] = [{ email: 'b', chars7d: 5, lastRequest: null }, { email: 'a', chars7d: 9, lastRequest: '2026-10-08T00:00:00Z' }]
  const copy = JSON.stringify(rows)
  assert.deepEqual(m.sortCustomers(rows, 'chars7d', 'desc').map((r: any) => r.email), ['a', 'b'])
  assert.deepEqual(m.sortCustomers(rows, 'lastRequest', 'desc').map((r: any) => r.email), ['a', 'b'])
  assert.equal(JSON.stringify(rows), copy)
})
```

```ts
// web/test/admin-proxy.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { forwardAdminDashboard } = await import('../src/lib/adminProxy.ts')

test('no Authorization header: 404 without calling the backend', async () => {
  let called = false
  const r = await forwardAdminDashboard({ backendBase: 'https://b.example.test', authorization: null, range: null, fetchImpl: (async () => { called = true; return new Response('x') }) as any })
  assert.equal(r.status, 404); assert.equal(r.body, 'Not found'); assert.equal(called, false)
})

test('forwards the bearer and a valid range to the backend and returns its status and body', async () => {
  let seen: { url: string; auth: string | null } | null = null
  const r = await forwardAdminDashboard({
    backendBase: 'https://b.example.test/', authorization: 'Bearer abc', range: '30d',
    fetchImpl: (async (url: any, init: any) => { seen = { url: String(url), auth: new Headers(init.headers).get('authorization') }; return new Response('{"ok":1}', { status: 200, headers: { 'content-type': 'application/json' } }) }) as any,
  })
  assert.equal(seen!.url, 'https://b.example.test/api/admin/dashboard?range=30d')
  assert.equal(seen!.auth, 'Bearer abc')
  assert.equal(r.status, 200); assert.equal(r.body, '{"ok":1}')
})

test('junk range is dropped, never forwarded', async () => {
  let url = ''
  await forwardAdminDashboard({ backendBase: 'https://b.example.test', authorization: 'Bearer abc', range: '../../x?y=1', fetchImpl: (async (u: any) => { url = String(u); return new Response('{}') }) as any })
  assert.equal(url, 'https://b.example.test/api/admin/dashboard')
})

test('backend 404 is passed through as 404', async () => {
  const r = await forwardAdminDashboard({ backendBase: 'https://b.example.test', authorization: 'Bearer abc', range: '7d', fetchImpl: (async () => new Response('Not found', { status: 404 })) as any })
  assert.equal(r.status, 404)
})

test('a network error is a 502 with a generic message (no internals leaked)', async () => {
  const r = await forwardAdminDashboard({ backendBase: 'https://b.example.test', authorization: 'Bearer abc', range: '7d', fetchImpl: (async () => { throw new Error('ECONNREFUSED 10.0.0.1') }) as any })
  assert.equal(r.status, 502); assert.doesNotMatch(r.body, /10\.0\.0\.1/)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd web && node --test test/admin-business.test.ts test/admin-proxy.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

```ts
// web/src/lib/adminBusiness.ts  (types mirror backend/src/lib/adminDashboard.ts; NO relative imports: tests load this with Node type-stripping)
export type Section<T> = { ok: true; data: T } | { ok: false; error: string }
export type HealthStatus = 'up' | 'down' | 'slow' | 'asleep' | 'unknown'
export interface HealthItem { name: string; status: HealthStatus; latencyMs?: number; detail?: string; checkedAt: string }
export interface Totals { accounts: number; activeKeys: number; newAccounts: number; kokoroChars: number; piperChars: number; sttMinutes: number; freeCharsUsed: number; creditsGranted: number; creditsUsed: number; paidCustomers: number; billedUnits: number }
export interface FunnelStage { stage: string; count: number }
export type CustomerStatus = 'paid' | 'comped' | 'at limit' | 'free'
export interface Customer { userId: string; email: string | null; signedUp: string; activeKeys: number; firstRequest: string | null; lastRequest: string | null; chars7d: number; sttMinutes7d: number; creditsLeft: number; status: CustomerStatus }
export interface AttentionItem { level: 'warn' | 'info'; text: string }
export interface SeriesRow { day: string; newAccounts: number; chars: number; sttMinutes: number }
export interface DashboardData {
  generatedAt: string; range: '24h' | '7d' | '30d'; usageSince: string | null
  attention: Section<AttentionItem[]>; health: Section<HealthItem[]>; totals: Section<Totals>
  funnel: Section<FunnelStage[]>; customers: Section<Customer[]>; series: Section<SeriesRow[]>
}

export const fmtNumber = (n: number): string => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—')
export function fmtChars(n: number): string {
  if (!Number.isFinite(n)) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(Math.round(n))
}
export function fmtMinutes(min: number): string {
  if (!Number.isFinite(min)) return '—'
  if (min >= 120) return `${(min / 60).toFixed(1)} h`
  return `${Math.round(min * 10) / 10} min`
}
export function fmtAgo(iso: string | null, now: number = Date.now()): string {
  if (!iso) return 'never'
  const s = Math.max(0, (now - Date.parse(iso)) / 1000)
  if (s < 90) return `${Math.round(s)}s ago`
  if (s < 5400) return `${Math.round(s / 60)}m ago`
  if (s < 172800) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}
export function statusTone(s: CustomerStatus | HealthStatus): 'good' | 'warn' | 'muted' {
  if (s === 'paid' || s === 'up') return 'good'
  if (s === 'at limit' || s === 'down' || s === 'slow') return 'warn'
  return 'muted'
}
export function funnelPercent(stages: FunnelStage[]): Array<FunnelStage & { pct: number }> {
  const first = stages[0]?.count ?? 0
  return stages.map((s) => ({ ...s, pct: first > 0 ? Math.round((s.count / first) * 100) : 0 }))
}
export function sortCustomers(rows: Customer[], key: keyof Customer, dir: 'asc' | 'desc'): Customer[] {
  const sign = dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const x = a[key] as unknown, y = b[key] as unknown
    if (x == null && y == null) return 0
    if (x == null) return 1
    if (y == null) return -1
    return (x < y ? -1 : x > y ? 1 : 0) * sign
  })
}
```

```ts
// web/src/lib/adminProxy.ts
// Thin server-side forward of the admin dashboard request. The BACKEND decides who is an admin; this only relays the bearer.
export interface ForwardArgs { fetchImpl?: typeof fetch; backendBase: string; authorization: string | null; range: string | null }
export interface ForwardResult { status: number; body: string; contentType: string }

const RANGES = new Set(['24h', '7d', '30d'])

export async function forwardAdminDashboard({ fetchImpl = fetch, backendBase, authorization, range }: ForwardArgs): Promise<ForwardResult> {
  if (!authorization?.startsWith('Bearer ')) return { status: 404, body: 'Not found', contentType: 'text/plain' }
  const qs = range && RANGES.has(range) ? `?range=${range}` : ''
  try {
    const res = await fetchImpl(`${backendBase.replace(/\/$/, '')}/api/admin/dashboard${qs}`, {
      headers: { Authorization: authorization }, cache: 'no-store', signal: AbortSignal.timeout(8000),
    })
    return { status: res.status, body: await res.text(), contentType: res.headers.get('content-type') ?? 'application/json' }
  } catch {
    return { status: 502, body: JSON.stringify({ error: 'dashboard unavailable' }), contentType: 'application/json' }
  }
}
```

```ts
// web/src/app/api/admin/dashboard/route.ts
import { NextResponse } from 'next/server'
import { forwardAdminDashboard } from '@/lib/adminProxy'

export const dynamic = 'force-dynamic'
const BACKEND = process.env.NEXT_PUBLIC_API_URL || 'https://listenai-backend.fly.dev'

export async function GET(request: Request) {
  const r = await forwardAdminDashboard({
    backendBase: BACKEND,
    authorization: request.headers.get('authorization'),
    range: new URL(request.url).searchParams.get('range'),
  })
  return new NextResponse(r.body, { status: r.status, headers: { 'Content-Type': r.contentType, 'Cache-Control': 'no-store' } })
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd web && node --test test/admin-business.test.ts test/admin-proxy.test.ts && npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/adminBusiness.ts web/src/lib/adminProxy.ts web/src/app/api/admin/dashboard/route.ts web/test/admin-business.test.ts web/test/admin-proxy.test.ts
git commit -m "feat(web): admin dashboard types, formatters and thin proxy route

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Web: the `AdminBusiness` panel and wiring into the existing page

**Files:**
- Create: `web/src/components/AdminBusiness.tsx`
- Modify: `web/src/components/AdminDashboard.tsx` (optional `renderTop` prop)
- Modify: `web/src/app/admin/page.tsx` (pass `renderTop` for the API scope)

**Interfaces:**
- Consumes: Task 9's `adminBusiness.ts` and `/api/admin/dashboard`.
- Produces: `AdminBusiness({ token, hours })` (client component) and `AdminDashboard`'s new optional prop `renderTop?: (scope: string, hours: number) => React.ReactNode`, rendered directly under the scope tabs. The shared template stays backward compatible (prop absent = unchanged).

There is no React test runner in this repo (web tests are Node unit tests), so this task is verified by type-checking, a production build, and a manual check against a fixture. Keep ALL logic in `adminBusiness.ts` (tested in Task 9); the component only renders.

- [ ] **Step 1: Write the component**

```tsx
// web/src/components/AdminBusiness.tsx
'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  fmtAgo, fmtChars, fmtMinutes, fmtNumber, funnelPercent, sortCustomers, statusTone,
  type Customer, type DashboardData, type Section,
} from '@/lib/adminBusiness'

const box: React.CSSProperties = { border: '1px solid #8884', borderRadius: 8, padding: 10 }
const th: React.CSSProperties = { textAlign: 'left', padding: '6px 8px', opacity: 0.6, fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap' }
const td: React.CSSProperties = { padding: '6px 8px', borderTop: '1px solid #8883', verticalAlign: 'top' }
const h2: React.CSSProperties = { fontSize: 13, textTransform: 'uppercase', letterSpacing: '.05em', opacity: 0.6, margin: '24px 0 8px' }
const TONE: Record<'good' | 'warn' | 'muted', string> = { good: '#2e9e4f', warn: '#d98a00', muted: '#8886' }

function Failed({ what, s }: { what: string; s: Extract<Section<unknown>, { ok: false }> }) {
  return <p style={{ ...box, opacity: 0.8 }}>Could not load {what}: {s.error}</p>
}

function Card({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div style={{ ...box, minWidth: 150, flex: '1 1 150px' }}>
      <div style={{ opacity: 0.6, fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600 }}>{value}</div>
      {hint && <div style={{ opacity: 0.6, fontSize: 12 }}>{hint}</div>}
    </div>
  )
}

export default function AdminBusiness({ token, hours }: { token: string; hours: number }) {
  const range = hours <= 24 ? '24h' : hours <= 168 ? '7d' : '30d'
  const [d, setD] = useState<DashboardData | null>(null)
  const [err, setErr] = useState('')
  const [sort, setSort] = useState<{ key: keyof Customer; dir: 'asc' | 'desc' }>({ key: 'lastRequest', dir: 'desc' })

  const load = useCallback(async () => {
    setErr('')
    try {
      const r = await fetch(`/api/admin/dashboard?range=${range}`, { cache: 'no-store', headers: { Authorization: `Bearer ${token}` } })
      if (!r.ok) throw new Error(r.status === 404 ? 'Not found (this account is not an admin)' : `HTTP ${r.status}`)
      setD(await r.json())
    } catch (e: any) { setErr(e.message || 'failed to load') }
  }, [range, token])
  useEffect(() => { load() }, [load])

  const customers = useMemo(() => (d?.customers.ok ? sortCustomers(d.customers.data, sort.key, sort.dir) : []), [d, sort])
  const th_ = (key: keyof Customer, label: string) => (
    <th style={th} onClick={() => setSort((s) => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }))}>{label}{sort.key === key ? (sort.dir === 'desc' ? ' ↓' : ' ↑') : ''}</th>
  )

  if (err) return <p style={{ ...box, marginTop: 16 }}>Business view: {err}</p>
  if (!d) return <p style={{ marginTop: 16, opacity: 0.6 }}>Loading business view…</p>
  const t = d.totals.ok ? d.totals.data : null

  return (
    <div style={{ marginTop: 8 }}>
      <h2 style={h2}>Needs attention</h2>
      {!d.attention.ok ? <Failed what="attention" s={d.attention} /> : d.attention.data.length === 0
        ? <p style={{ opacity: 0.6 }}>Nothing needs attention.</p>
        : <ul style={{ margin: 0, paddingLeft: 18 }}>{d.attention.data.map((a, i) => <li key={i} style={{ color: TONE.warn }}>{a.text}</li>)}</ul>}

      <h2 style={h2}>Health</h2>
      {!d.health.ok ? <Failed what="health" s={d.health} /> : (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {d.health.data.map((h) => (
            <div key={h.name} style={{ ...box, minWidth: 140 }}>
              <span style={{ color: TONE[statusTone(h.status)] }}>●</span> <b>{h.name}</b>
              <div style={{ opacity: 0.7, fontSize: 12 }}>{h.status}{h.latencyMs != null ? ` · ${h.latencyMs} ms` : ''}</div>
              {h.detail && <div style={{ opacity: 0.5, fontSize: 11 }}>{h.detail}</div>}
            </div>
          ))}
        </div>
      )}

      <h2 style={h2}>Customers and usage ({range}, your accounts excluded; usage history starts {d.usageSince ?? 'when recording began'} UTC)</h2>
      {!d.totals.ok || !t ? (d.totals.ok ? null : <Failed what="totals" s={d.totals} />) : (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Card label="API accounts" value={fmtNumber(t.accounts)} hint={`${fmtNumber(t.newAccounts)} new · ${fmtNumber(t.activeKeys)} active keys`} />
          <Card label="Kokoro characters" value={fmtChars(t.kokoroChars)} />
          <Card label="Piper characters" value={fmtChars(t.piperChars)} />
          <Card label="Batch STT" value={fmtMinutes(t.sttMinutes)} />
          <Card label="Free credits used" value={`${fmtNumber(t.creditsUsed)} / ${fmtNumber(t.creditsGranted)}`} hint={`${fmtChars(t.freeCharsUsed)} chars this range`} />
          <Card label="Paid customers" value={fmtNumber(t.paidCustomers)} hint={`${fmtChars(t.billedUnits)} billed units`} />
        </div>
      )}

      <h2 style={h2}>Funnel</h2>
      {!d.funnel.ok ? <Failed what="funnel" s={d.funnel} /> : (
        <div style={box}>
          {funnelPercent(d.funnel.data).map((s) => (
            <div key={s.stage} style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0' }}>
              <div style={{ width: 190 }}>{s.stage}</div>
              <div style={{ flex: 1, background: '#8882', borderRadius: 4, height: 10 }}><div style={{ width: `${s.pct}%`, background: '#4a7cff', height: 10, borderRadius: 4 }} /></div>
              <div style={{ width: 90, textAlign: 'right' }}>{fmtNumber(s.count)} · {s.pct}%</div>
            </div>
          ))}
        </div>
      )}

      <h2 style={h2}>Customers</h2>
      {!d.customers.ok ? <Failed what="customers" s={d.customers} /> : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr>{th_('email', 'Email')}{th_('signedUp', 'Signed up')}{th_('activeKeys', 'Keys')}{th_('firstRequest', 'First request')}{th_('lastRequest', 'Last request')}{th_('chars7d', 'Chars 7d')}{th_('sttMinutes7d', 'STT 7d')}{th_('creditsLeft', 'Credits left')}{th_('status', 'Status')}</tr></thead>
            <tbody>
              {customers.length === 0 && <tr><td style={td} colSpan={9}>No API customers yet.</td></tr>}
              {customers.map((c) => (
                <tr key={c.userId}>
                  <td style={td}>{c.email ?? c.userId}</td>
                  <td style={td}>{c.signedUp.slice(0, 10)}</td>
                  <td style={td}>{c.activeKeys}</td>
                  <td style={td}>{c.firstRequest ?? '—'}</td>
                  <td style={td}>{fmtAgo(c.lastRequest)}</td>
                  <td style={td}>{fmtChars(c.chars7d)}</td>
                  <td style={td}>{fmtMinutes(c.sttMinutes7d)}</td>
                  <td style={td}>{fmtNumber(c.creditsLeft)}</td>
                  <td style={{ ...td, color: TONE[statusTone(c.status)] }}>{c.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Add the optional prop to `AdminDashboard`**

In `web/src/components/AdminDashboard.tsx`: change the signature to
`export default function AdminDashboard({ token, scopes, renderTop }: { token?: string | null; scopes?: { label: string; value: string }[]; renderTop?: (scope: string, hours: number) => React.ReactNode } = {})`
and render `{renderTop?.(scope, hours)}` immediately after the scope-tabs `<div>` (the block that maps `scopes`), before the existing health/issues sections. Do not change anything else in that file.

- [ ] **Step 3: Wire it in `web/src/app/admin/page.tsx`**

```tsx
import AdminBusiness from '@/components/AdminBusiness'
// ...
  return (
    <AdminDashboard
      token={token}
      scopes={[{ label: 'App', value: 'app' }, { label: 'API', value: 'api' }]}
      renderTop={(scope, hours) => (scope === 'api' ? <AdminBusiness token={token} hours={hours} /> : null)}
    />
  )
```

- [ ] **Step 4: Verify**

Run: `cd web && npx tsc --noEmit && npm test && npx next build`
Expected: no type errors, tests pass, build succeeds. Manual check (after the backend endpoint is deployed, see Rollout): open `/admin` signed in as the admin, switch to the API tab, and confirm each section renders or shows its own "Could not load" line; confirm the App tab is unchanged; confirm a non-admin session sees "Business view: Not found (this account is not an admin)".

- [ ] **Step 5: Commit**

```bash
git add web/src/components/AdminBusiness.tsx web/src/components/AdminDashboard.tsx web/src/app/admin/page.tsx
git commit -m "feat(web): business view on the admin API tab (attention, health, usage, funnel, customers)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Rollout (owner-gated; the order matters because Task 3 touches billing)

1. **Migration (owner):** confirm the migration number is still free (`ls backend/supabase/migrations`), then the owner pastes `034_realtimetts_usage_daily.sql` into the Supabase SQL editor for the ListenAI project. Verify the schema with a read-only query: the table exists, `relrowsecurity` is true, anon/authenticated have no privileges, and `realtimetts_add_usage` exists. Rollback = `034_rollback.sql`.
2. **Deploy ONLY the drain hook (Task 3) first.** From a clean worktree of this repo with only these commits: check `flyctl releases -a listenai-backend` and the current branch first, then `flyctl deploy` for `listenai-backend` (never `flyctl secrets set` over an existing secret). Watch 2-3 drain cycles (about 15 minutes): the logs must show NO new "Failed to report usage to Stripe" lines versus before, the gateway usage still reaches Stripe, and `select count(*), sum(chars) from realtimetts_usage_daily` grows only when real traffic exists. If anything about billing changes: redeploy the previous release immediately.
3. **Config (owner supplies values, nothing in git):** `ADMIN_EMAILS` (the admin address) and `ADMIN_EXCLUDE_EMAILS` (the owner's own accounts) on `listenai-backend`; optionally `ADMIN_HEALTH_TARGETS` (JSON of health URLs, e.g. gateway and Piper). These are NEW secrets, set with `flyctl secrets set` only after the owner confirms the values.
4. **Deploy the endpoint (Tasks 4-8)** to `listenai-backend` and check: no token -> 404; the admin token -> 200 JSON (`curl` with a real session token from the browser, not stored).
5. **Deploy the web page (Tasks 9-10)** to `readaloud-web` and do the manual check from Task 10.

## Phase 2 outline (separate plan, written after Phase 1 is live and the owner has used it)

Entry criteria: Task 3 has been live for at least a week without billing differences; the owner confirms which extra views are wanted.
- Charts from `series` (new accounts, TTS characters, STT minutes per day), labelled "since <date>".
- Backfill of earlier TTS history from Stripe meter event summaries, only if the meter's customer-level events carry usable timestamps (to verify with one read-only API call).
- Push daily headline metrics to the reporter Worker `POST /v1/usage` (`api.*` metrics) so the existing App/API usage views fill; the Worker already supports it (`worker/src/index.ts` `handleUsage`).
- A failure log for usage reports and webhooks to enable the two attention rules deferred from Phase 1.
- Optional: per-customer drill-down, the App tab, request counts (needs the gateway to report them).

## Self-review notes

- Spec coverage: success criteria (counts excluding owner, usage ranges, free-credit burn, paid customers, funnel, customers table, health, attention) -> Tasks 4-10; architecture (backend endpoint with its own auth, thin proxy, exclusion by env var) -> Tasks 6, 8, 9; data constraints (single drain reader, new RLS table, guarded write) -> Tasks 1-3; failure handling (independent sections) -> Tasks 4-5, 8; testing list (aggregates, auth, drain hook, page) -> each task; rollout and risks -> Rollout section; deviations are listed under Rulings.
- Unverified until execution: the Supabase builder typing for `fetchAll` (see the note in Task 5), that migration number 034 is still free, the real Piper health URL for `ADMIN_HEALTH_TARGETS`, and which user owns the shared STT gateway key (its drained usage would be recorded under that owner; if that owner is not on `ADMIN_EXCLUDE_EMAILS`, STT usage could be double counted against `reportSttUsage` records. Check before the endpoint deploy and add that owner to the exclusion list if it is the owner's own account).
