import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArgs, run, planGrant, supabaseDeps, GRANT_REASON_PREFIX, DEFAULT_FREE_GRANT, type Deps, type Credits,
} from './grant-free-credits.js';

function fakeDeps(init: { prior?: number; credits?: Credits | null; user?: string | null } = {}) {
  const lines: string[] = [];
  const applied: Array<{ userId: string; units: number; identifier: string }> = [];
  const deps: Deps = {
    log: (l) => lines.push(l),
    findUserIdByEmail: async () => (init.user === undefined ? 'user-1' : init.user),
    sumPriorGrantedUnits: async () => init.prior ?? 0,
    getCredits: async () => (init.credits === undefined ? { granted: 10000, used: 2500 } : init.credits),
    applyGrant: async (userId, units, identifier) => { applied.push({ userId, units, identifier }); },
  };
  return { deps, lines, applied };
}

test('parseArgs: defaults, validation', () => {
  const a = parseArgs(['--email', 'A@B.com', '--units', '33000']);
  assert.deepEqual(a, { email: 'a@b.com', units: 33000, apply: false, maxTotalUsd: 25 });
  assert.equal(parseArgs(['--email', 'a@b.com', '--units', '5', '--apply', '--max-total-usd', '1']).apply, true);
  assert.throws(() => parseArgs(['--units', '5']), /--email/);
  assert.throws(() => parseArgs(['--email', 'a@b.com']), /--units/);
  assert.throws(() => parseArgs(['--email', 'a@b.com', '--units', '-5']), /positive integer/);
  assert.throws(() => parseArgs(['--email', 'a@b.com', '--units', '1.5']), /positive integer/);
  assert.throws(() => parseArgs(['--email', 'a@b.com', '--units', '5', '--max-total-usd', '0']), /positive/);
  assert.throws(() => parseArgs(['--email', 'a@b.com', '--units', '5', '--wat']), /Unknown/);
});

test('dry run (no --apply) never writes and exits 0', async () => {
  const f = fakeDeps();
  const code = await run(['--email', 'a@b.com', '--units', '33000'], f.deps);
  assert.equal(code, 0);
  assert.equal(f.applied.length, 0);
  assert.match(f.lines.join('\n'), /DRY RUN/);
  assert.match(f.lines.join('\n'), /3\.00 STT hours/);
});

test('--apply writes exactly once with the distinct audit prefix', async () => {
  const f = fakeDeps();
  const code = await run(['--email', 'a@b.com', '--units', '33000', '--apply'], f.deps);
  assert.equal(code, 0);
  assert.equal(f.applied.length, 1);
  assert.equal(f.applied[0].units, 33000);
  assert.equal(f.applied[0].userId, 'user-1');
  assert.ok(f.applied[0].identifier.startsWith(GRANT_REASON_PREFIX));
});

test('cap is enforced against previously granted total (default $25 = 2,500,000 units)', async () => {
  const ok = fakeDeps({ prior: 2_467_000 });
  assert.equal(await run(['--email', 'a@b.com', '--units', '33000', '--apply'], ok.deps), 0); // exactly at cap
  const over = fakeDeps({ prior: 2_467_001 });
  assert.equal(await run(['--email', 'a@b.com', '--units', '33000', '--apply'], over.deps), 1);
  assert.equal(over.applied.length, 0);
  assert.match(over.lines.join('\n'), /Refusing/);
  const custom = fakeDeps({ prior: 90_000 });
  assert.equal(await run(['--email', 'a@b.com', '--units', '33000', '--apply', '--max-total-usd', '1'], custom.deps), 1);
});

test('cap also blocks a dry run (so a dry run predicts the real outcome)', async () => {
  const f = fakeDeps({ prior: 2_500_000 });
  assert.equal(await run(['--email', 'a@b.com', '--units', '1'], f.deps), 1);
});

test('unknown email -> error, no write', async () => {
  const f = fakeDeps({ user: null });
  assert.equal(await run(['--email', 'x@y.com', '--units', '10', '--apply'], f.deps), 1);
  assert.equal(f.applied.length, 0);
});

test('applyGrant failure -> exit 1', async () => {
  const f = fakeDeps();
  f.deps.applyGrant = async () => { throw new Error('db down'); };
  assert.equal(await run(['--email', 'a@b.com', '--units', '10', '--apply'], f.deps), 1);
  assert.match(f.lines.join('\n'), /db down/);
});

test('planGrant reports before-state and hours', async () => {
  const f = fakeDeps({ credits: null });
  const p = await planGrant(parseArgs(['--email', 'a@b.com', '--units', '33000']), f.deps);
  assert.equal(p.before, null);
  assert.ok(Math.abs(p.sttHours - 3) < 0.01);
  assert.ok(Math.abs(p.usd - 0.33) < 1e-9);
});

// ---- supabaseDeps.applyGrant against a minimal in-memory fake of the supabase-js query builder ----
function fakeDb(opts: { credits: Credits | null; failUpdate?: boolean; casLosses?: number }) {
  const events = new Map<string, { user_id: string; units: number }>();
  let row = opts.credits ? { ...opts.credits } : null;
  let casLosses = opts.casLosses ?? 0;
  const db = {
    from(table: string) {
      if (table === 'realtimetts_free_credit_events') {
        return {
          insert: async (v: { identifier: string; user_id: string; units: number }) => { events.set(v.identifier, v); return { error: null }; },
          delete: () => ({ eq: async (_c: string, id: string) => { events.delete(id); return { error: null }; } }),
        };
      }
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }),
        insert: async (v: Credits) => { row = { granted: v.granted, used: v.used }; return { error: null }; },
        update: (v: { granted: number }) => ({
          eq: () => ({
            eq: (_c: string, expected: number) => ({
              select: async () => {
                if (opts.failUpdate) return { data: null, error: { message: 'update failed' } };
                if (casLosses > 0) { casLosses--; if (row) row.granted += 1; return { data: [], error: null }; } // someone else bumped granted
                if (row && row.granted === expected) { row.granted = v.granted; return { data: [{ user_id: 'u' }], error: null }; }
                return { data: [], error: null };
              },
            }),
          }),
        }),
      };
    },
  };
  return { db: db as never, events, getRow: () => row };
}

test('applyGrant: existing row is bumped, audit row written', async () => {
  const f = fakeDb({ credits: { granted: 10000, used: 100 } });
  const d = supabaseDeps(f.db, () => {});
  await d.applyGrant('u', 33000, `${GRANT_REASON_PREFIX}t1`);
  assert.equal(f.getRow()!.granted, 43000);
  assert.equal(f.getRow()!.used, 100);
  assert.equal(f.events.get(`${GRANT_REASON_PREFIX}t1`)!.units, 33000);
});

test('applyGrant: no row -> created with the default free grant plus the units', async () => {
  const f = fakeDb({ credits: null });
  await supabaseDeps(f.db, () => {}).applyGrant('u', 33000, `${GRANT_REASON_PREFIX}t2`);
  assert.deepEqual(f.getRow(), { granted: DEFAULT_FREE_GRANT + 33000, used: 0 });
});

test('applyGrant: a lost compare-and-swap retries and still applies exactly once', async () => {
  const f = fakeDb({ credits: { granted: 10000, used: 0 }, casLosses: 2 });
  await supabaseDeps(f.db, () => {}).applyGrant('u', 500, `${GRANT_REASON_PREFIX}t3`);
  assert.equal(f.getRow()!.granted, 10000 + 2 + 500);
});

test('applyGrant: failure removes the audit row so the cap is not consumed by a grant that did not happen', async () => {
  const f = fakeDb({ credits: { granted: 10000, used: 0 }, failUpdate: true });
  await assert.rejects(supabaseDeps(f.db, () => {}).applyGrant('u', 500, `${GRANT_REASON_PREFIX}t4`), /update failed/);
  assert.equal(f.events.size, 0);
  assert.equal(f.getRow()!.granted, 10000);
});
