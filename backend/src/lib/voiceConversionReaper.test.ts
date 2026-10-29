// Run: npx tsx --test src/lib/voiceConversionReaper.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';

import type { ReaperDb } from './voiceConversionReaper.js';

const modP = import('./voiceConversionReaper.js'); // after env is set

type Row = { id: string; status: string; created_at: string; error: string | null; completed_at: string | null };

/** In-memory stand-in for the supabase query builder: evaluates .in/.lt filters over real rows, so the reaper's WHERE clause is what gets tested. */
function fakeDb(rows: Row[], opts: { failSelect?: boolean } = {}) {
  const db = {
    from(table: string) {
      assert.equal(table, 'voice_conversions');
      const filters: Array<(r: Row) => boolean> = [];
      let patch: Partial<Row> | null = null;
      let limit = Infinity;
      let ascending = false;
      const matching = () => rows.filter(r => filters.every(f => f(r)));
      const q: any = {
        select() {
          return q;
        },
        update(p: Partial<Row>) { patch = p; return q; },
        in(col: keyof Row, vals: string[]) { filters.push(r => vals.includes(r[col] as string)); return q; },
        lt(col: keyof Row, v: string) { filters.push(r => (r[col] as string) < v); return q; },
        order(_c: string, o: { ascending: boolean }) { ascending = o.ascending; return q; },
        limit(n: number) { limit = n; return q; },
        then(resolve: (v: unknown) => void) {
          if (opts.failSelect) return resolve({ data: null, error: { message: 'boom' } });
          let hit = matching();
          if (ascending) hit = [...hit].sort((a, b) => a.created_at.localeCompare(b.created_at));
          hit = hit.slice(0, limit);
          if (patch) for (const r of hit) Object.assign(r, patch);
          resolve({ data: hit.map(r => ({ id: r.id })), error: null });
        },
      };
      return q;
    },
  };
  return db as unknown as ReaperDb;
}

const NOW = Date.parse('2026-10-29T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const row = (id: string, status: string, ageMs: number): Row => ({ id, status, created_at: ago(ageMs), error: null, completed_at: null });
const H = 60 * 60 * 1000;

test('only queued/processing rows older than 2h are failed; everything else is untouched', async () => {
  const { reapStaleVoiceConversions, STALE_AFTER_MS, REAPED_ERROR } = await modP;
  const rows = [
    row('old-queued', 'queued', 3 * H),
    row('old-processing', 'processing', 5 * H),
    row('fresh-queued', 'queued', 1 * H),
    row('just-under', 'queued', STALE_AFTER_MS - 1000),
    row('old-done', 'done', 9 * H),
    row('old-failed', 'failed', 9 * H),
    row('old-rejected', 'rejected', 9 * H),
  ];
  const reports: Array<{ flow: string; msg: string; ctx?: Record<string, string> }> = [];
  const n = await reapStaleVoiceConversions({ db: fakeDb(rows), now: () => NOW, report: (flow, err, ctx) => reports.push({ flow, msg: (err as Error).message, ctx }) });
  assert.equal(n, 2);
  const by = Object.fromEntries(rows.map(r => [r.id, r]));
  for (const id of ['old-queued', 'old-processing']) {
    assert.equal(by[id].status, 'failed');
    assert.equal(by[id].error, REAPED_ERROR);
    assert.equal(by[id].completed_at, new Date(NOW).toISOString());
  }
  for (const id of ['fresh-queued', 'just-under', 'old-done', 'old-failed', 'old-rejected']) {
    assert.equal(by[id].error, null, `${id} must be untouched`);
    assert.equal(by[id].completed_at, null);
  }
  assert.equal(by['fresh-queued'].status, 'queued');
  assert.equal(by['old-done'].status, 'done');
  // One aggregate signal for the whole pass, count only.
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0], { flow: 'voice_conversion_reaper', msg: 'VOICE_CONVERSION_STUCK', ctx: { reaped: '2' } });
});

test('nothing stale: no write and no signal', async () => {
  const { reapStaleVoiceConversions } = await modP;
  const rows = [row('a', 'queued', 1 * H), row('b', 'done', 10 * H)];
  let reported = 0;
  const n = await reapStaleVoiceConversions({ db: fakeDb(rows), now: () => NOW, report: () => { reported++; } });
  assert.equal(n, 0);
  assert.equal(reported, 0);
  assert.equal(rows[0].status, 'queued');
});

test('at most 100 rows per pass, oldest first, still one signal', async () => {
  const { reapStaleVoiceConversions, MAX_ROWS_PER_PASS } = await modP;
  const rows = Array.from({ length: 130 }, (_, i) => row(`r${i}`, 'queued', 3 * H + i * 1000));
  const reports: string[] = [];
  const n = await reapStaleVoiceConversions({ db: fakeDb(rows), now: () => NOW, report: (f) => { reports.push(f); } });
  assert.equal(n, MAX_ROWS_PER_PASS);
  assert.equal(rows.filter(r => r.status === 'failed').length, 100);
  assert.equal(reports.length, 1);
  // Age grows with the index, so r129 is the oldest and r0 the newest of the stale set.
  assert.equal(rows.find(r => r.id === 'r129')!.status, 'failed');
  assert.equal(rows.find(r => r.id === 'r30')!.status, 'failed');
  assert.equal(rows.find(r => r.id === 'r29')!.status, 'queued');
  assert.equal(rows.find(r => r.id === 'r0')!.status, 'queued');
});

test('a database error is swallowed and nothing is reported', async () => {
  const { reapStaleVoiceConversions } = await modP;
  let reported = 0;
  const n = await reapStaleVoiceConversions({ db: fakeDb([row('x', 'queued', 5 * H)], { failSelect: true }), now: () => NOW, report: () => { reported++; } });
  assert.equal(n, 0);
  assert.equal(reported, 0);
});
