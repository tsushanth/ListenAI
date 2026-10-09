# ReadAloud Admin Dashboard Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add daily charts, a failure log that powers the two deferred attention rules, and a daily push of headline metrics to the reporter Worker, on top of the live Phase 1 dashboard; and settle (by one read-only check) whether a Stripe history backfill is worth building.

**Architecture:** One new service-role-only table (`realtimetts_event_log`) is written fire-and-forget from the existing failure paths (Stripe meter-event failure in the gateway drain and in STT reporting, Stripe webhook handler errors) and read by the dashboard to produce the two attention rules. Charts are plain inline SVG in a new web component fed by the `series` section the endpoint already returns. A small in-process job pushes today's totals to the reporter Worker's existing `POST /v1/usage` (idempotent per app/day/metric) and prunes old log rows.

**Tech Stack:** TypeScript, Express, Supabase (Postgres, service role), Stripe SDK, Next.js (App Router), node:test with tsx (backend) and `node --test` (web). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-08-readaloud-admin-dashboard-design.md` (approved). Phase 1 plan: `docs/superpowers/plans/2026-10-08-readaloud-admin-dashboard-plan.md` (its "Phase 2 outline" is what this plan expands). Phase 1 is live on `main`.

## Global Constraints

- The repo is PUBLIC: no emails, secrets, margins or cost figures in code, tests, docs or commit messages. Use `example.test` addresses in fixtures.
- Billing behaviour must be unchanged: every new write on a billing or webhook path is fire-and-forget through a function that never throws (`safeEvent`), and must not delay metering or change a webhook response code.
- No new dependencies (no chart library). No new Fly secrets: the reporter key `FAILURE_REPORTER_KEY` and `FAILURE_REPORTER_URL` already exist.
- Migrations are applied by the owner in the Supabase SQL editor (project ListenAI). Nothing in this plan applies a migration, deploys, or sets a secret. The next free migration number is 035.
- Admin gating is unchanged (Google identity, confirmed email, `ADMIN_EMAILS`, fail closed with 404). Owner accounts listed in `ADMIN_EXCLUDE_EMAILS` never produce attention items, customers rows or chart data.
- Failure-log `detail` is at most 200 characters and never contains request bodies, transcripts, text, or tokens.
- The Phase 1 `Section<T>` rule holds: a failing source degrades only its own section.
- Out of scope: per-customer drill-down, the App tab, margin or cost display, email alerts, request counts.

## Review Focus

1. **One-day series.** The 24h range yields a single point; charts must show a hint ("choose 7d or 30d"), not a broken or empty axis. (Task 4)
2. **Empty ledger.** Today the usage ledger has no rows. Usage charts must render a flat baseline with the caption "no usage recorded yet", and days before the ledger start must be visibly muted, never presented as real zeros. (Task 4)
3. **Log write failure.** If the event-log insert errors or hangs, metering and the webhook response are unchanged. (Tasks 1, 2)
4. **Reporter push failure or empty totals.** A push error or a failed `totals` section must not affect the drain, and must not push zeros over real values. (Task 5)
5. **Owner exclusion.** A failure event for an excluded owner account must not raise an attention item, and the webhook rule must not count signature failures (attacker noise). (Tasks 2, 3)

---

## File structure

Backend (`backend/`):
- Create `supabase/migrations/035_realtimetts_event_log.sql`, `supabase/rollbacks/035_rollback.sql`.
- Create `src/lib/eventLog.ts` (+ `src/lib/eventLog.test.ts`): `recordEvent`, `safeEvent`, `pruneOldEvents`.
- Modify `src/lib/realtimeTtsBilling.ts`: `recordEvent?` dep; log in the two Stripe-failure catches.
- Modify `src/routes/stripeWebhook.ts`: log handler errors.
- Modify `src/lib/adminDashboard.ts`: `EventRow`, `listEvents?` dep, events in `DashboardInputs`, two new attention rules, `defaultDashboardDeps.listEvents`.
- Create `src/lib/reporterUsage.ts` (+ test): `headlineMetrics`, `pushHeadlineMetrics`.
- Modify `src/index.ts`: schedule the push/prune job.
- Modify `package.json` test script: add the new test files.

Web (`web/`):
- Create `src/lib/chartGeometry.ts` (+ `test/chart-geometry.test.ts`).
- Create `src/components/AdminCharts.tsx`; modify `src/components/AdminBusiness.tsx` to render it.

Docs: `docs/superpowers/notes/2026-10-09-stripe-backfill-gate.md` (Task 6 result).

---

### Task 1: Event-log table and recorder

**Files:**
- Create: `backend/supabase/migrations/035_realtimetts_event_log.sql`
- Create: `backend/supabase/rollbacks/035_rollback.sql`
- Create: `backend/src/lib/eventLog.ts`
- Test: `backend/src/lib/eventLog.test.ts`
- Modify: `backend/package.json` (append `src/lib/eventLog.test.ts` to the `test` script's file list)

**Interfaces:**
- Produces:
  ```ts
  export type EventKind = 'usage_report_failed' | 'webhook_failed';
  export interface EventInput { kind: EventKind; userId?: string | null; detail?: string }
  export type EventRecorder = (e: EventInput) => Promise<void>;
  export const recordEvent: EventRecorder;            // inserts one row, throws on DB error
  export function safeEvent(rec: EventRecorder | undefined, e: EventInput): Promise<void>; // never throws, no recorder = no-op
  export function pruneOldEvents(now?: Date): Promise<void>; // deletes rows older than 30 days, never throws
  ```
- Table `realtimetts_event_log(id, kind, user_id, detail, created_at)`.

- [ ] **Step 1: Write the migration**

```sql
-- backend/supabase/migrations/035_realtimetts_event_log.sql
-- Migration 035: failure log for the admin dashboard (usage-report and webhook failures).
-- NOT APPLIED until the owner runs it in the Supabase SQL editor.
-- SECURITY: RLS on, one service_role policy, anon/authenticated revoked (same pattern as 033/034).
CREATE TABLE IF NOT EXISTS realtimetts_event_log (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind        TEXT        NOT NULL CHECK (kind IN ('usage_report_failed', 'webhook_failed')),
    user_id     UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
    detail      TEXT        NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_realtimetts_event_log_kind_created ON realtimetts_event_log(kind, created_at DESC);

ALTER TABLE realtimetts_event_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role only on realtimetts_event_log" ON realtimetts_event_log;
CREATE POLICY "Service role only on realtimetts_event_log" ON realtimetts_event_log
    FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON realtimetts_event_log FROM anon, authenticated;
```

```sql
-- backend/supabase/rollbacks/035_rollback.sql
DROP TABLE IF EXISTS realtimetts_event_log;
```

- [ ] **Step 2: Write the failing test**

The billing test kit (`test/billingKit.ts`) fakes `supabase.from(table)` for any table name and records inserted rows in `kit.tables[table]`, so no kit change is needed.

```ts
// backend/src/lib/eventLog.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { installKit } from '../../test/billingKit.js';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';

const modP = import('./eventLog.js');

test('recordEvent inserts kind, user and a clipped detail', async () => {
  const kit = await installKit();
  try {
    const { recordEvent } = await modP;
    await recordEvent({ kind: 'usage_report_failed', userId: 'u1', detail: 'x'.repeat(500) });
    const rows = kit.tables.realtimetts_event_log!;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.kind, 'usage_report_failed');
    assert.equal(rows[0]!.user_id, 'u1');
    assert.equal(rows[0]!.detail.length, 200);
  } finally { kit.restore(); }
});

test('recordEvent stores a null user and an empty detail when omitted', async () => {
  const kit = await installKit();
  try {
    const { recordEvent } = await modP;
    await recordEvent({ kind: 'webhook_failed' });
    const r = kit.tables.realtimetts_event_log![0]!;
    assert.equal(r.user_id, null);
    assert.equal(r.detail, '');
  } finally { kit.restore(); }
});

test('safeEvent never throws, with a throwing recorder or none', async () => {
  const { safeEvent } = await modP;
  await safeEvent(async () => { throw new Error('db down'); }, { kind: 'webhook_failed' });
  await safeEvent(undefined, { kind: 'webhook_failed' });
});

test('safeEvent does not wait forever on a hung recorder', async () => {
  const { safeEvent } = await modP;
  const started = Date.now();
  await Promise.race([
    safeEvent(() => new Promise<void>(() => {}), { kind: 'webhook_failed' }),
    new Promise((r) => setTimeout(r, 3500)),
  ]);
  assert.ok(Date.now() - started < 3600);
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `cd backend && npx tsx --test --experimental-test-module-mocks src/lib/eventLog.test.ts`
Expected: FAIL (module `./eventLog.js` not found).

- [ ] **Step 4: Implement**

```ts
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
export async function safeEvent(rec: EventRecorder | undefined, e: EventInput): Promise<void> {
  if (!rec) return;
  try {
    await Promise.race([
      rec(e),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('event log write timed out')), WRITE_TIMEOUT_MS).unref()),
    ]);
  } catch (err) {
    eventLogger.warn({ err: err instanceof Error ? err.message : String(err), kind: e.kind }, 'Could not record event (billing unaffected)');
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
```

If the kit's fake `delete()` is not supported, `pruneOldEvents` is covered in Task 5 by injecting it as a dependency; do not add a kit feature just for it.

- [ ] **Step 5: Run the test and the typecheck**

Run: `cd backend && npx tsx --test --experimental-test-module-mocks src/lib/eventLog.test.ts && npm run typecheck`
Expected: 4 pass, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add backend/supabase backend/src/lib/eventLog.ts backend/src/lib/eventLog.test.ts backend/package.json
git commit -m "feat: failure log table (migration 035) and never-throwing recorder"
```

---

### Task 2: Record failures from billing and the webhook

**Files:**
- Modify: `backend/src/lib/realtimeTtsBilling.ts` (type `UsageReportDeps`, `defaultUsageDeps`, the `catch` after `createMeterEvent` in `reportUsageToStripe` around line 570, and the `catch` in `reportSttUsage` around line 720)
- Modify: `backend/src/routes/stripeWebhook.ts` (the `catch (error)` around line 103)
- Test: `backend/src/lib/realtimeTtsBilling.eventLog.test.ts` (new), `backend/src/routes/stripeWebhook.eventLog.test.ts` (new)
- Modify: `backend/package.json` (add both test files)

**Interfaces:**
- Consumes: `EventRecorder`, `safeEvent`, `recordEvent` from `../lib/eventLog.js` (Task 1).
- Produces: `UsageReportDeps.recordEvent?: EventRecorder`; events of kind `usage_report_failed` (with `userId` of the key owner when known) and `webhook_failed` (no user).

- [ ] **Step 1: Write the failing tests**

Model the first file on `realtimeTtsBilling.usageDaily.test.ts` (same `run()` helper shape; copy it and add a `failMeter` option and a `recordEvent` capture):

```ts
// backend/src/lib/realtimeTtsBilling.eventLog.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';

const modP = import('./realtimeTtsBilling.js');

async function run(opts: { failMeter?: boolean; recorder?: ((e: any) => Promise<void>) | null }) {
  const { reportUsageToStripe } = await modP;
  const events: any[] = [];
  const logged: any[] = [];
  await reportUsageToStripe({
    drain: async () => ({ usage: [{ id: 'k1', chars: 1000 }], freeChars: [] }),
    getKeyOwner: async () => ({ user_id: 'u1' }),
    getBilling: async () => ({ user_id: 'u1', stripe_customer_id: 'cus_u1', active: true } as any),
    createMeterEvent: async (p) => { if (opts.failMeter) throw new Error('stripe 500'); events.push(p); return {}; },
    consumeFreeCredits: async () => 0,
    recordUsage: async () => {},
    recordEvent: opts.recorder === null ? undefined : (opts.recorder ?? (async (e) => { logged.push(e); })),
  });
  await new Promise((r) => setImmediate(r));
  return { events, logged };
}

test('a failed Stripe meter report logs usage_report_failed for the key owner', async () => {
  const { logged } = await run({ failMeter: true });
  assert.equal(logged.length, 1);
  assert.equal(logged[0].kind, 'usage_report_failed');
  assert.equal(logged[0].userId, 'u1');
  assert.match(logged[0].detail, /stripe 500/);
});

test('a successful report logs nothing', async () => {
  const { logged, events } = await run({});
  assert.equal(events.length, 1);
  assert.deepEqual(logged, []);
});

test('a throwing or missing event recorder never changes billing', async () => {
  const bad = await run({ recorder: async () => { throw new Error('db down'); } });
  const none = await run({ recorder: null });
  assert.equal(bad.events.length, 1);
  assert.equal(none.events.length, 1);
});
```

For `reportSttUsage` (no deps parameter today): read `test/billingKit.ts` lines 60-150. If the Stripe prototype spy has no way to make `meterEvents.create` throw, add one small knob, `stripeThrows: Record<string, Error>`, to the kit (checked in the same place `stripeReturns` is read), then add a test to the file above:

```ts
test('a failed STT meter report logs usage_report_failed', async () => {
  const kit = await (await import('../../test/billingKit.js')).installKit();
  try {
    kit.tables.realtimetts_billing!.push((await import('../../test/billingKit.js')).billingRow({ user_id: 'u1', active: true }));
    kit.stripeThrows['meterEvents.create'] = new Error('stripe 500');
    const { reportSttUsage } = await modP;
    await reportSttUsage('u1', 60);
    await new Promise((r) => setImmediate(r));
    const rows = kit.tables.realtimetts_event_log ?? [];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.kind, 'usage_report_failed');
  } finally { kit.restore(); }
});
```

Webhook test: reuse the `post()` helper pattern from `stripeWebhook.test.ts` (copy the helper into the new file). Make a handler throw by wrapping `supabase.from` for the `users` table:

```ts
// backend/src/routes/stripeWebhook.eventLog.test.ts  (header and post() helper copied from stripeWebhook.test.ts)
test('a handler error answers 500 and logs webhook_failed', async () => {
  const kit = await installKit();
  const { supabase } = await import('../lib/supabaseClient.js');
  const sb = supabase as any;
  const wrapped = sb.from;
  sb.from = (t: string) => { if (t === 'users') throw new Error('boom'); return wrapped(t); };
  try {
    const status = await post(kit, { id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_1', customer_details: { email: 'a@example.test' }, customer: 'cus_1', subscription: 'sub_1' } } });
    await new Promise((r) => setImmediate(r));
    assert.equal(status, 500);
    assert.equal((kit.tables.realtimetts_event_log ?? []).filter((r) => r.kind === 'webhook_failed').length, 1);
  } finally { sb.from = wrapped; kit.restore(); }
});

test('a bad signature answers 400 and logs nothing', async () => {
  const kit = await installKit();
  try {
    const { stripeWebhookRouter: router } = await import('./stripeWebhook.js');
    const app = express(); app.use(express.raw({ type: 'application/json' })); app.use('/webhooks', router);
    const server = http.createServer(app).listen(0);
    const { port } = server.address() as AddressInfo;
    const r = await fetch(`http://127.0.0.1:${port}/webhooks/stripe`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=bad' }, body: '{}' });
    server.close();
    assert.equal(r.status, 400);
    assert.equal((kit.tables.realtimetts_event_log ?? []).length, 0);
  } finally { kit.restore(); }
});
```

If `checkout.session.completed` does not reach a `users` query as written, adjust the event payload (read `stripeWebhook.ts` lines 52-62 and 110-135) so the handler does reach it; the assertion that matters is 500 plus exactly one `webhook_failed` row.

- [ ] **Step 2: Run them and watch them fail**

Run: `cd backend && npx tsx --test --experimental-test-module-mocks src/lib/realtimeTtsBilling.eventLog.test.ts src/routes/stripeWebhook.eventLog.test.ts`
Expected: FAIL (no events recorded; `recordEvent` is not a known dep).

- [ ] **Step 3: Implement**

In `realtimeTtsBilling.ts`: import `{ safeEvent, recordEvent, type EventRecorder } from './eventLog.js'`; add `recordEvent?: EventRecorder;` to `UsageReportDeps` and `recordEvent,` to `defaultUsageDeps`. In `reportUsageToStripe`, declare `let ownerId: string | undefined;` at the top of the per-entry `try`, set it right after `getKeyOwner` returns a record, and change the catch to:

```ts
    } catch (err) {
      billingLogger.error({ err, gatewayKeyId, chars }, 'Failed to report usage to Stripe');
      void safeEvent(deps.recordEvent, { kind: 'usage_report_failed', userId: ownerId, detail: err instanceof Error ? err.message : String(err) });
    }
```

In `reportSttUsage`'s catch, after the existing `billingLogger.error`, add `void safeEvent(recordEvent, { kind: 'usage_report_failed', userId, detail: err instanceof Error ? err.message : String(err) });`.

In `stripeWebhook.ts`, import `{ safeEvent, recordEvent } from '../lib/eventLog.js'` and in the `catch (error)` block, before the `res.status(500)` line, add `void safeEvent(recordEvent, { kind: 'webhook_failed', detail: `${event.type}: ${error instanceof Error ? error.message : String(error)}` });`. Do not log in the signature-failure branches.

- [ ] **Step 4: Run the new tests plus the existing billing and webhook suites**

Run: `cd backend && npx tsx --test --experimental-test-module-mocks src/lib/realtimeTtsBilling.eventLog.test.ts src/routes/stripeWebhook.eventLog.test.ts src/lib/realtimeTtsBilling.test.ts src/lib/realtimeTtsBilling.usageDaily.test.ts src/routes/stripeWebhook.test.ts && npm run typecheck`
Expected: all pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add backend/src backend/test backend/package.json
git commit -m "feat: log Stripe usage-report and webhook failures (fire-and-forget, billing unchanged)"
```

---

### Task 3: Attention rules from the failure log

**Files:**
- Modify: `backend/src/lib/adminDashboard.ts`
- Test: `backend/src/lib/adminDashboard.test.ts` (extend), `backend/src/routes/adminDashboard.test.ts` (only if its fake deps need `listEvents`; the new dep is optional, so it should not)

**Interfaces:**
- Consumes: table `realtimetts_event_log` (Task 1).
- Produces:
  ```ts
  export interface EventRow { kind: 'usage_report_failed' | 'webhook_failed'; user_id: string | null; detail: string; created_at: string }
  // DashboardDeps gains:  listEvents?(sinceIso: string): Promise<EventRow[]>;
  // DashboardInputs gains: events: EventRow[]
  ```
  Attention texts (exact, tests match on them):
  - `<email or id>: usage report to Stripe failed <n>x in the last 24h (that usage was not billed)`
  - `Stripe webhook handler failed <n>x in the last 24h`

- [ ] **Step 1: Write the failing tests** (append to `adminDashboard.test.ts`, using its `inputs()` helper, which you extend with `events: []` as a default so existing tests keep passing)

```ts
test('attention: failed usage reports for a real customer are flagged with a count', async () => {
  const { buildAttention, buildCustomers } = await modP;
  const i = await inputs({ events: [
    { kind: 'usage_report_failed', user_id: 'a', detail: 'x', created_at: '2026-10-08T10:00:00Z' },
    { kind: 'usage_report_failed', user_id: 'a', detail: 'x', created_at: '2026-10-08T11:00:00Z' },
  ] });
  const out = buildAttention(i, buildCustomers(i));
  assert.ok(out.some((a: any) => a.text === 'a@example.test: usage report to Stripe failed 2x in the last 24h (that usage was not billed)'));
});

test('attention: failures older than 24h or for excluded owners are ignored', async () => {
  const { buildAttention, buildCustomers } = await modP;
  const i = await inputs({ events: [
    { kind: 'usage_report_failed', user_id: 'a', detail: 'x', created_at: '2026-10-07T11:00:00Z' }, // 25h old
    { kind: 'usage_report_failed', user_id: 'me', detail: 'x', created_at: '2026-10-08T11:00:00Z' }, // excluded owner
  ] });
  assert.ok(!buildAttention(i, buildCustomers(i)).some((a: any) => /usage report/.test(a.text)));
});

test('attention: webhook handler failures in the last 24h are flagged', async () => {
  const { buildAttention, buildCustomers } = await modP;
  const i = await inputs({ events: [{ kind: 'webhook_failed', user_id: null, detail: 'checkout.session.completed: boom', created_at: '2026-10-08T09:00:00Z' }] });
  assert.ok(buildAttention(i, buildCustomers(i)).some((a: any) => a.text === 'Stripe webhook handler failed 1x in the last 24h'));
});

test('buildDashboard: a failing event source degrades attention with a warning, other sections stay ok', async () => {
  const { buildDashboard, parseExcludeEmails } = await modP;
  const d = await buildDashboard({ ...(await fakeDeps()), listEvents: async () => { throw new Error('events down'); } }, { range: '7d', excludeEmails: parseExcludeEmails('') });
  assert.equal(d.totals.ok, true);
  assert.ok(d.attention.ok && d.attention.data.some((a: any) => /failure log/.test(a.text)));
});
```

`fakeDeps()` is the existing helper in this file that builds a complete `DashboardDeps`; if it is named differently, use that name. A `listEvents` that is absent must behave as "no events" (add one test: `buildDashboard` without `listEvents` returns attention ok with no failure-log warning).

- [ ] **Step 2: Run them and watch them fail**

Run: `cd backend && npx tsx --test --experimental-test-module-mocks src/lib/adminDashboard.test.ts`
Expected: the four new tests FAIL.

- [ ] **Step 3: Implement**

- Add `EventRow`; add `events: EventRow[]` to `DashboardInputs`; add `listEvents?` to `DashboardDeps`.
- In `buildDashboard`, after the other sections are fetched, add `const events = await section(() => (deps.listEvents ? deps.listEvents(new Date(now.getTime() - DAY_MS).toISOString()) : Promise.resolve([] as EventRow[])));`, pass `events: events.ok ? events.data : []` into the `DashboardInputs` built in `build()`, and in the attention builder add `if (!events.ok) items.push({ level: 'warn', text: `Could not read the failure log: ${events.error}` });`.
- In `buildAttention`, after the STT rule:

```ts
  const dayAgo = new Date(i.now.getTime() - DAY_MS).toISOString();
  const recent = i.events.filter((e) => e.created_at >= dayAgo);
  const byUser = new Map<string, number>();
  for (const e of recent) {
    if (e.kind !== 'usage_report_failed' || !e.user_id || ex.has(e.user_id)) continue;
    byUser.set(e.user_id, (byUser.get(e.user_id) ?? 0) + 1);
  }
  for (const [uid, n] of byUser) {
    const email = i.users.find((u) => u.id === uid)?.email ?? uid;
    out.push({ level: 'warn', text: `${email}: usage report to Stripe failed ${n}x in the last 24h (that usage was not billed)` });
  }
  const hooks = recent.filter((e) => e.kind === 'webhook_failed').length;
  if (hooks > 0) out.push({ level: 'warn', text: `Stripe webhook handler failed ${hooks}x in the last 24h` });
```

(`ex` is the excluded-id set already defined earlier in `buildAttention`.)

- Add to `defaultDashboardDeps`:

```ts
  listEvents: (sinceIso) => fetchAll<EventRow>((f, t) => supabase.from('realtimetts_event_log').select('kind, user_id, detail, created_at').gte('created_at', sinceIso).order('created_at').order('id').range(f, t)),
```

- [ ] **Step 4: Run the dashboard tests, route tests and typecheck**

Run: `cd backend && npx tsx --test --experimental-test-module-mocks src/lib/adminDashboard.test.ts src/routes/adminDashboard.test.ts && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src
git commit -m "feat: attention rules for failed usage reports and webhook failures"
```

---

### Task 4: Daily charts on the API tab

**Files:**
- Create: `web/src/lib/chartGeometry.ts`
- Test: `web/test/chart-geometry.test.ts`
- Create: `web/src/components/AdminCharts.tsx`
- Modify: `web/src/components/AdminBusiness.tsx` (render the charts after the funnel)

**Interfaces:**
- Consumes: `SeriesRow` (`{ day; newAccounts; chars; sttMinutes }`), `DashboardData.usageSince` from `web/src/lib/adminBusiness.ts`.
- Produces:
  ```ts
  export interface Point { day: string; value: number }
  export interface Bar { x: number; y: number; w: number; h: number; day: string; value: number }
  export function barGeometry(points: Point[], width: number, height: number, gap?: number): { bars: Bar[]; max: number }
  export function chartCaption(kind: 'accounts' | 'usage', usageSince: string | null, total: number, unit: string): string
  export function isBeforeLedger(day: string, usageSince: string | null): boolean
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// web/test/chart-geometry.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { barGeometry, chartCaption, isBeforeLedger } from '../src/lib/chartGeometry.ts';

test('barGeometry scales to the maximum and keeps every bar inside the box', () => {
  const { bars, max } = barGeometry([{ day: 'a', value: 5 }, { day: 'b', value: 10 }, { day: 'c', value: 0 }], 100, 40, 4);
  assert.equal(max, 10);
  assert.equal(bars.length, 3);
  assert.equal(bars[1]!.h, 40);
  assert.equal(bars[0]!.h, 20);
  assert.equal(bars[2]!.h, 0);
  for (const b of bars) { assert.ok(b.x >= 0 && b.x + b.w <= 100.0001); assert.ok(b.y >= 0 && b.y + b.h <= 40.0001); }
});

test('barGeometry on all zeros is a flat baseline, not NaN', () => {
  const { bars, max } = barGeometry([{ day: 'a', value: 0 }, { day: 'b', value: 0 }], 100, 40);
  assert.equal(max, 0);
  assert.ok(bars.every((b) => b.h === 0 && Number.isFinite(b.w) && Number.isFinite(b.y)));
});

test('barGeometry gives a tiny non-zero value at least a 1px bar, and tolerates an empty list', () => {
  const { bars } = barGeometry([{ day: 'a', value: 1 }, { day: 'b', value: 1_000_000 }], 100, 40);
  assert.ok(bars[0]!.h >= 1);
  assert.deepEqual(barGeometry([], 100, 40), { bars: [], max: 0 });
});

test('isBeforeLedger: no ledger yet means every day is before it', () => {
  assert.equal(isBeforeLedger('2026-10-08', null), true);
  assert.equal(isBeforeLedger('2026-10-07', '2026-10-08'), true);
  assert.equal(isBeforeLedger('2026-10-08', '2026-10-08'), false);
});

test('chartCaption words the empty ledger and the since-date honestly', () => {
  assert.equal(chartCaption('usage', null, 0, 'chars'), 'No usage recorded yet');
  assert.equal(chartCaption('usage', '2026-10-08', 1500, 'chars'), '1,500 chars since 2026-10-08');
  assert.equal(chartCaption('accounts', null, 3, 'new accounts'), '3 new accounts');
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd web && node --test test/chart-geometry.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the geometry**

```ts
// web/src/lib/chartGeometry.ts
export interface Point { day: string; value: number }
export interface Bar { x: number; y: number; w: number; h: number; day: string; value: number }

export function barGeometry(points: Point[], width: number, height: number, gap = 2): { bars: Bar[]; max: number } {
  if (points.length === 0) return { bars: [], max: 0 };
  const max = Math.max(0, ...points.map((p) => (Number.isFinite(p.value) ? p.value : 0)));
  const w = Math.max(1, (width - gap * (points.length - 1)) / points.length);
  const bars = points.map((p, i) => {
    const v = Number.isFinite(p.value) && p.value > 0 ? p.value : 0
    const h = max > 0 && v > 0 ? Math.max(1, (v / max) * height) : 0
    return { x: i * (w + gap), y: height - h, w, h, day: p.day, value: v }
  });
  return { bars, max };
}

export const isBeforeLedger = (day: string, usageSince: string | null): boolean => usageSince === null || day < usageSince;

export function chartCaption(kind: 'accounts' | 'usage', usageSince: string | null, total: number, unit: string): string {
  const n = Math.round(total).toLocaleString('en-US');
  if (kind === 'accounts') return `${n} ${unit}`;
  return usageSince === null ? 'No usage recorded yet' : `${n} ${unit} since ${usageSince}`;
}
```

- [ ] **Step 4: Run the tests**

Run: `cd web && node --test test/chart-geometry.test.ts`
Expected: 5 pass.

- [ ] **Step 5: Build the component and wire it in**

```tsx
// web/src/components/AdminCharts.tsx
'use client'
import type { SeriesRow } from '@/lib/adminBusiness'
import { barGeometry, chartCaption, isBeforeLedger } from '@/lib/chartGeometry'

const W = 320, H = 70
const box: React.CSSProperties = { border: '1px solid #8884', borderRadius: 8, padding: 10, minWidth: 200, flex: '1 1 260px' }

function Chart({ title, points, kind, unit, usageSince }: { title: string; points: Array<{ day: string; value: number }>; kind: 'accounts' | 'usage'; unit: string; usageSince: string | null }) {
  const { bars, max } = barGeometry(points, W, H)
  const total = points.reduce((s, p) => s + (kind === 'usage' && isBeforeLedger(p.day, usageSince) ? 0 : p.value), 0)
  return (
    <div style={box}>
      <div style={{ fontSize: 12, opacity: 0.7 }}>{title}</div>
      <div style={{ fontSize: 12, margin: '2px 0 6px' }}>{chartCaption(kind, usageSince, total, unit)}</div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`${title}, ${points.length} days`}>
        <line x1="0" x2={W} y1={H - 0.5} y2={H - 0.5} stroke="#8886" />
        {bars.map((b) => (
          <rect key={b.day} x={b.x} y={b.y} width={b.w} height={b.h} fill="#4a7cff" opacity={kind === 'usage' && isBeforeLedger(b.day, usageSince) ? 0.15 : 0.9}>
            <title>{`${b.day}: ${Math.round(b.value).toLocaleString('en-US')} ${unit}`}</title>
          </rect>
        ))}
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, opacity: 0.5 }}>
        <span>{points[0]?.day.slice(5)}</span><span>peak {Math.round(max).toLocaleString('en-US')}</span><span>{points[points.length - 1]?.day.slice(5)}</span>
      </div>
    </div>
  )
}

export default function AdminCharts({ series, usageSince }: { series: SeriesRow[]; usageSince: string | null }) {
  if (series.length < 2) return <p style={{ opacity: 0.6, fontSize: 13 }}>Choose 7d or 30d to see daily charts.</p>
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <Chart title="New accounts per day" kind="accounts" unit="new accounts" usageSince={usageSince} points={series.map((s) => ({ day: s.day, value: s.newAccounts }))} />
      <Chart title="Paid characters per day" kind="usage" unit="chars" usageSince={usageSince} points={series.map((s) => ({ day: s.day, value: s.chars }))} />
      <Chart title="STT minutes per day" kind="usage" unit="min" usageSince={usageSince} points={series.map((s) => ({ day: s.day, value: s.sttMinutes }))} />
    </div>
  )
}
```

In `AdminBusiness.tsx`, after the Funnel block add:

```tsx
      <h2 style={h2}>Daily trend</h2>
      {!d.series.ok ? <Failed what="series" s={d.series} /> : <AdminCharts series={d.series.data} usageSince={d.usageSince} />}
```

and `import AdminCharts from './AdminCharts'`.

- [ ] **Step 6: Run web tests and typecheck**

Run: `cd web && npm test && npx tsc --noEmit -p . 2>&1 | grep -v '^test/' | head`
Expected: all web tests pass; no type errors outside `test/` (existing test files already have unrelated type noise; do not fix it here).

- [ ] **Step 7: Commit**

```bash
git add web/src web/test
git commit -m "feat(web): daily trend charts on the API tab (inline SVG, ledger-aware)"
```

---

### Task 5: Daily headline metrics to the reporter Worker, and event pruning

**Files:**
- Create: `backend/src/lib/reporterUsage.ts`
- Test: `backend/src/lib/reporterUsage.test.ts`
- Modify: `backend/src/index.ts` (schedule, next to the existing 5-minute drain interval)
- Modify: `backend/package.json` (add the test file)

**Interfaces:**
- Consumes: `buildDashboard`, `defaultDashboardDeps`, `parseExcludeEmails`, `Totals` from `./adminDashboard.js`; `pruneOldEvents` from `./eventLog.js`; the Worker contract `POST /v1/usage` with header `X-Report-Key`, body an array of up to 50 `{ metric, value, day }` (metric matches `/^[a-z0-9_.-]+$/i`, at most 60 chars). It is idempotent per app/day/metric (last write wins).
- Produces:
  ```ts
  export interface HeadlineMetric { metric: string; value: number }
  export function headlineMetrics(t: Totals): HeadlineMetric[]
  export interface PushDeps { totals(): Promise<Totals | null>; post(day: string, items: HeadlineMetric[]): Promise<void>; now(): Date }
  export function pushHeadlineMetrics(deps: PushDeps): Promise<{ pushed: number }>  // never throws
  export const defaultPushDeps: PushDeps
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// backend/src/lib/reporterUsage.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';

const modP = import('./reporterUsage.js');
const totals = { accounts: 2, activeKeys: 2, newAccounts: 1, kokoroChars: 1200, piperChars: 300, sttMinutes: 12.345, freeCharsUsed: 50, creditsGranted: 20000, creditsUsed: 50, paidCustomers: 1, billedUnits: 900 } as any;

test('headlineMetrics names and rounds the daily headline numbers', async () => {
  const { headlineMetrics } = await modP;
  const m = Object.fromEntries(headlineMetrics(totals).map((x: any) => [x.metric, x.value]));
  assert.deepEqual(m, {
    'api.accounts': 2, 'api.new_accounts': 1, 'api.kokoro_chars': 1200, 'api.piper_chars': 300,
    'api.free_chars': 50, 'api.stt_minutes': 12.3, 'api.paid_customers': 1,
  });
});

test('every metric name is valid for the Worker (charset and length)', async () => {
  const { headlineMetrics } = await modP;
  for (const x of headlineMetrics(totals)) { assert.match(x.metric, /^[a-z0-9_.-]+$/i); assert.ok(x.metric.length <= 60); }
});

test('push posts today (UTC) once with all metrics', async () => {
  const { pushHeadlineMetrics } = await modP;
  const calls: any[] = [];
  const r = await pushHeadlineMetrics({ totals: async () => totals, post: async (day, items) => { calls.push({ day, n: items.length }); }, now: () => new Date('2026-10-09T23:59:00Z') });
  assert.deepEqual(calls, [{ day: '2026-10-09', n: 7 }]);
  assert.equal(r.pushed, 7);
});

test('no totals (section failed) pushes nothing, so zeros never overwrite real values', async () => {
  const { pushHeadlineMetrics } = await modP;
  let posted = false;
  const r = await pushHeadlineMetrics({ totals: async () => null, post: async () => { posted = true; }, now: () => new Date() });
  assert.equal(posted, false);
  assert.equal(r.pushed, 0);
});

test('a throwing post or totals never propagates', async () => {
  const { pushHeadlineMetrics } = await modP;
  await pushHeadlineMetrics({ totals: async () => totals, post: async () => { throw new Error('worker down'); }, now: () => new Date() });
  await pushHeadlineMetrics({ totals: async () => { throw new Error('db down'); }, post: async () => {}, now: () => new Date() });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd backend && npx tsx --test --experimental-test-module-mocks src/lib/reporterUsage.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// backend/src/lib/reporterUsage.ts
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
```

In `index.ts`, import `pushHeadlineMetrics, defaultPushDeps` and `pruneOldEvents`, and after the drain interval add:

```ts
  // Daily headline metrics to the reporter Worker + log retention. Idempotent, non-critical, never in tests.
  const THIRTY_MINUTES_MS = 30 * 60 * 1000;
  if (process.env.NODE_ENV !== 'test' && process.env.FAILURE_REPORTER_KEY) {
    const job = () => { void pushHeadlineMetrics(defaultPushDeps); void pruneOldEvents(); };
    setTimeout(job, 60_000).unref();
    setInterval(job, THIRTY_MINUTES_MS).unref();
  }
```

- [ ] **Step 4: Gate step, run before merging this task:** confirm which Worker app the backend's `FAILURE_REPORTER_KEY` belongs to, because the web overview reads `app=readaloud`. Read `appForKey` in `app-failure-reporter/worker/src/index.ts` and the Worker's key-to-app configuration. If the backend key maps to a different app name than `readaloud`, the pushed metrics would land under that other app and the existing Usage table would still look empty: in that case change nothing in code, record the finding in the task report, and ask the owner whether to remap or to read that app name in `web/src/app/api/admin/overview/route.ts`.

- [ ] **Step 5: Run the tests, the whole backend suite and the typecheck**

Run: `cd backend && npx tsx --test --experimental-test-module-mocks src/lib/reporterUsage.test.ts && npm test && npm run typecheck`
Expected: all pass (the full suite was 673/673 before this phase).

- [ ] **Step 6: Commit**

```bash
git add backend/src backend/package.json
git commit -m "feat: push daily headline API metrics to the reporter Worker; prune old log rows"
```

---

### Task 6: Stripe history backfill gate (read-only, no code unless it passes)

**Files:**
- Create: `docs/superpowers/notes/2026-10-09-stripe-backfill-gate.md`

**Why this is a gate, not a build:** a backfill only helps if customers were already metered before the usage ledger began. As of this plan there are two accounts with billing rows and zero paying customers, so there may be nothing to backfill. Build nothing speculative.

- [ ] **Step 1: Count the paying history that could exist** (read-only SQL, Supabase SQL editor or the MCP `execute_sql` on project ListenAI):

```sql
select count(*) filter (where active and not coalesce(comped, false)) as paying_now,
       count(*) as billing_rows
from realtimetts_billing;
```

- [ ] **Step 2: Decide.** If `paying_now` is 0 and no billing row was ever a paying customer, write the note: "No metered history exists, backfill not applicable; revisit when the first customer has paid usage before the ledger start date." Commit the note and stop; Task 6 is done.

- [ ] **Step 3 (only if Step 2 found paying customers):** run one read-only check of the Stripe meter event summaries from the backend machine (it already holds the Stripe key), using the SDK: `stripe.billing.meters.list()` to find the character meter, then `stripe.billing.meters.listEventSummaries(meterId, { customer, start_time, end_time, value_grouping_window: 'day' })` for one real customer id. Record in the note whether each summary row carries `start_time`, `end_time` and `aggregated_value`. Do not write anything to Stripe or the database.

- [ ] **Step 4:** If summaries carry per-day values, write a follow-up plan (new table for billed units per day, never mixed into `realtimetts_usage_daily` because meter units are character-equivalents across engines and STT, not raw characters). Do not implement it here.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/notes
git commit -m "docs: Stripe backfill gate result"
```

---

## Owner-gated rollout (not part of any task)

1. Apply migration 035 in the Supabase SQL editor (ListenAI project). Verify: `select count(*) from realtimetts_event_log;` returns 0, and `anon`/`authenticated` have no grants on it.
2. Deploy `listenai-backend` from a clean worktree of `origin/main` (failure recording + attention rules + reporter push). No new secrets are needed.
3. Deploy `readaloud-web` (charts).
4. Check `/admin` on the API tab: the "Daily trend" section renders, and the reporter Worker's Usage table starts showing `api.*` rows within 30 minutes.

## Self-review notes

- **Spec coverage:** charts (Task 4), Stripe backfill (Task 6, gated), push to the reporter Worker (Task 5), failure log and the two deferred attention rules (Tasks 1-3). Optional spec items (drill-down, App tab, request counts) are deliberately out of scope.
- **Placeholders:** none. Two steps tell the implementer to read a named file region because the exact line depends on current code (the STT test knob in `billingKit.ts`, the webhook event payload); each states the assertion that must hold.
- **Type consistency:** `EventKind`/`EventInput`/`EventRecorder` (Task 1) are used unchanged in Tasks 2 and 3; `EventRow.kind` mirrors `EventKind`; `Totals` fields used in Task 5 (`accounts`, `newAccounts`, `kokoroChars`, `piperChars`, `freeCharsUsed`, `sttMinutes`, `paidCustomers`) exist in `adminDashboard.ts`; `SeriesRow` fields in Task 4 match `buildSeries`.
- **Unverified until execution:** which reporter app name the backend key maps to (Task 5 Step 4); whether `kit.stripeThrows` already exists; the exact webhook payload that reaches the `users` query.
