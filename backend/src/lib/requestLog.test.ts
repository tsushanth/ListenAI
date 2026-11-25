// backend/src/lib/requestLog.test.ts
// Run: npm test. Validation, kill switch, insert, prune, and a static guard on migration 037 (applied by hand).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';

const modP = import('./requestLog.js');
const NOW = new Date('2026-11-24T12:00:00.000Z');

const good = (over: Record<string, unknown> = {}) => ({
  ts: '2026-11-24T11:59:58.250Z', request_id: 'req-1', gateway_key_id: 'key-uuid-1', transport: 'http',
  endpoint: '/v1/text-to-speech/stream', voice: 'mira', language: 'en', chars: 120, outcome: 'ok',
  http_status: 200, error_code: null, ttfb_ms: 180, duration_ms: 950, ...over,
});

test('a valid event is accepted and normalised (ts to canonical ISO)', async () => {
  const { validateEvent } = await modP;
  const row = validateEvent(good({ ts: '2026-11-24T11:59:58+00:00' }), NOW);
  assert.ok(row);
  assert.equal(row.ts, '2026-11-24T11:59:58.000Z');
  assert.equal(row.chars, 120);
  assert.equal(row.voice, 'mira');
});

test('nullable fields accept null; optional-by-contract fields may not be omitted-with-garbage', async () => {
  const { validateEvent } = await modP;
  const row = validateEvent(good({ voice: null, language: null, error_code: null, ttfb_ms: null, duration_ms: null }), NOW);
  assert.ok(row);
  assert.equal(row.ttfb_ms, null);
  // an omitted nullable field is undefined, not null: refused (the contract lists every field)
  const { voice: _v, ...noVoice } = good();
  assert.equal(validateEvent(noVoice, NOW), null);
});

test('ts: must be an ISO-8601 string within +-1 day of now', async () => {
  const { validateEvent } = await modP;
  for (const ts of ['yesterday', '2026-11-24', 1764000000000, null, undefined, '2026-11-24 11:59:58', '2026-11-22T12:00:00Z', '2026-11-26T12:00:01Z', '2026-13-45T00:00:00Z']) {
    assert.equal(validateEvent(good({ ts }), NOW), null, String(ts));
  }
  assert.ok(validateEvent(good({ ts: '2026-11-23T12:00:01Z' }), NOW));
  assert.ok(validateEvent(good({ ts: '2026-11-25T11:59:59Z' }), NOW));
});

test('string fields: type, empty, and length caps (endpoint 120, voice 60, language 20, error_code 60, request_id 80, gateway_key_id 80)', async () => {
  const { validateEvent } = await modP;
  const caps: Record<string, number> = { endpoint: 120, voice: 60, language: 20, error_code: 60, request_id: 80, gateway_key_id: 80 };
  for (const [field, cap] of Object.entries(caps)) {
    assert.ok(validateEvent(good({ [field]: 'a'.repeat(cap) }), NOW), `${field} at cap`);
    assert.equal(validateEvent(good({ [field]: 'a'.repeat(cap + 1) }), NOW), null, `${field} over cap`);
    assert.equal(validateEvent(good({ [field]: 42 }), NOW), null, `${field} number`);
    assert.equal(validateEvent(good({ [field]: '' }), NOW), null, `${field} empty`);
    assert.equal(validateEvent(good({ [field]: 'bad\nline' }), NOW), null, `${field} control char`);
  }
  for (const field of ['request_id', 'gateway_key_id', 'endpoint']) assert.equal(validateEvent(good({ [field]: null }), NOW), null, `${field} null`);
});

test('transport and outcome enums are exact', async () => {
  const { validateEvent, TRANSPORTS, OUTCOMES } = await modP;
  for (const transport of TRANSPORTS) assert.ok(validateEvent(good({ transport }), NOW), transport);
  for (const outcome of OUTCOMES) assert.ok(validateEvent(good({ outcome }), NOW), outcome);
  for (const transport of ['HTTP', 'grpc', '', null, 5]) assert.equal(validateEvent(good({ transport }), NOW), null, String(transport));
  for (const outcome of ['OK', 'success', 'error', '', null]) assert.equal(validateEvent(good({ outcome }), NOW), null, String(outcome));
});

test('integers: chars 0..10M, http_status 100..599, ttfb 0..600000, duration 0..86400000; no floats, strings, NaN', async () => {
  const { validateEvent } = await modP;
  const cases: Array<[string, unknown[], unknown[]]> = [
    ['chars', [0, 10_000_000], [-1, 10_000_001, 1.5, '12', NaN, Infinity, null, undefined]],
    ['http_status', [100, 599], [99, 600, 200.5, '200', null, undefined]],
    ['ttfb_ms', [0, 600_000, null], [-1, 600_001, 1.2, '5', NaN]],
    ['duration_ms', [0, 86_400_000, null], [-1, 86_400_001, 0.5, '5', NaN]],
  ];
  for (const [field, ok, bad] of cases) {
    for (const v of ok) assert.ok(validateEvent(good({ [field]: v }), NOW), `${field}=${String(v)}`);
    for (const v of bad) assert.equal(validateEvent(good({ [field]: v }), NOW), null, `${field}=${String(v)}`);
  }
});

test('privacy: unknown fields (text, audio, raw key, user_id) refuse the whole event; rtts_ keys are refused in any string', async () => {
  const { validateEvent } = await modP;
  for (const extra of [{ text: 'hello world' }, { audio: 'AAAA' }, { api_key: 'x' }, { user_id: 'u1' }, { key: 'k' }]) {
    assert.equal(validateEvent(good(extra), NOW), null, Object.keys(extra)[0]);
  }
  assert.equal(validateEvent(good({ gateway_key_id: 'rtts_abcdef0123456789' }), NOW), null);
  assert.equal(validateEvent(good({ request_id: 'x-rtts_abcdef' }), NOW), null);
  assert.equal(validateEvent(good({ endpoint: '/v1/tts?text=hello' }), NOW), null, 'query string');
  assert.equal(validateEvent(good({ endpoint: '/v1/tts#frag' }), NOW), null, 'fragment');
});

test('non-objects are refused', async () => {
  const { validateEvent } = await modP;
  for (const v of [null, undefined, 'str', 7, [], [good()], true]) assert.equal(validateEvent(v, NOW), null, JSON.stringify(v));
});

test('validateBatch: envelope 400, 200 ok, 201 is 413, empty ok, partial rejection counted', async () => {
  const { validateBatch } = await modP;
  for (const body of [null, undefined, 'x', [], [good()], {}, { events: 'x' }, { events: {} }, { events: null }]) {
    assert.deepEqual(validateBatch(body, NOW), { ok: false, status: 400 }, JSON.stringify(body));
  }
  const r200 = validateBatch({ events: Array.from({ length: 200 }, () => good()) }, NOW);
  assert.ok(r200.ok && r200.rows.length === 200 && r200.rejected === 0);
  assert.deepEqual(validateBatch({ events: Array.from({ length: 201 }, () => good()) }, NOW), { ok: false, status: 413 });
  const empty = validateBatch({ events: [] }, NOW);
  assert.ok(empty.ok && empty.rows.length === 0 && empty.rejected === 0);
  const mixed = validateBatch({ events: [good(), good({ chars: -1 }), 'junk', good({ request_id: 'req-2' }), { text: 'x' }] }, NOW);
  assert.ok(mixed.ok);
  assert.equal(mixed.rows.length, 2);
  assert.equal(mixed.rejected, 3);
});

test('kill switch defaults OFF and only accepts explicit on-values', async () => {
  const { requestLogIngestEnabled } = await modP;
  assert.equal(requestLogIngestEnabled({}), false);
  for (const v of ['', '0', 'false', 'off', 'no', 'maybe', ' ']) assert.equal(requestLogIngestEnabled({ REQUEST_LOG_INGEST_ENABLED: v }), false, v);
  for (const v of ['1', 'true', 'TRUE', ' on ', 'yes']) assert.equal(requestLogIngestEnabled({ REQUEST_LOG_INGEST_ENABLED: v }), true, v);
});

// ---- insert and prune against the real supabase client, with its network layer replaced -------------------------

// Replaces supabase.from for one test; `insertResult` is what the insert resolves to.
async function fakeSupabase(insertResult: { error: { message: string } | null }) {
  const { supabase } = await import('./supabaseClient.js');
  const sb = supabase as any;
  const original = sb.from;
  const inserts: Array<{ table: string; payload: unknown }> = [];
  sb.from = (table: string) => ({ insert: async (payload: unknown) => { inserts.push({ table, payload }); return insertResult; } });
  return { inserts, restore: () => { sb.from = original; } };
}

test('insertRequestLog does one bulk insert of every row into realtimetts_request_log (no user_id)', async () => {
  const fake = await fakeSupabase({ error: null });
  try {
    const { insertRequestLog, validateEvent } = await modP;
    const rows = [validateEvent(good(), NOW)!, validateEvent(good({ request_id: 'req-2' }), NOW)!];
    await insertRequestLog(rows);
    assert.equal(fake.inserts.length, 1, 'one insert call for the whole batch');
    assert.equal(fake.inserts[0]!.table, 'realtimetts_request_log');
    const stored = fake.inserts[0]!.payload as Array<Record<string, unknown>>;
    assert.equal(stored.length, 2);
    assert.ok(stored.every((r) => !('user_id' in r) && !('text' in r)));
    assert.equal(stored[1]!.request_id, 'req-2');
  } finally { fake.restore(); }
});

test('insertRequestLog throws on a database error', async () => {
  const fake = await fakeSupabase({ error: { message: 'relation does not exist' } });
  try {
    const { insertRequestLog, validateEvent } = await modP;
    await assert.rejects(() => insertRequestLog([validateEvent(good(), NOW)!]), /relation does not exist/);
  } finally { fake.restore(); }
});

test('insertRequestLog does not carry a failing row (check-violation detail) into the thrown message', async () => {
  const fake = await fakeSupabase({ error: { message: 'new row violates check constraint "x". Failing row contains (1, req-SENTINEL, key-SENTINEL)' } });
  try {
    const { insertRequestLog, validateEvent } = await modP;
    await assert.rejects(() => insertRequestLog([validateEvent(good(), NOW)!]), (e: Error) => /violates check constraint/.test(e.message) && !/SENTINEL|Failing row/.test(e.message));
  } finally { fake.restore(); }
});

test('insertRequestLog with no rows touches nothing', async () => {
  const { insertRequestLog } = await modP;
  const fake = await fakeSupabase({ error: null });
  try { await insertRequestLog([]); assert.equal(fake.inserts.length, 0); } finally { fake.restore(); }
});

test('pruneOldRequestLog deletes rows with ts older than 30 days, keeps newer, and never throws', async () => {
  const { pruneOldRequestLog } = await modP;
  const calls: Array<{ table: string; col: string; val: string }> = [];
  const client = {
    from: (table: string) => ({ delete: () => ({ lt: async (col: string, val: string) => { calls.push({ table, col, val }); return { error: null }; } }) }),
  } as any;
  await pruneOldRequestLog(NOW, client);
  assert.deepEqual(calls, [{ table: 'realtimetts_request_log', col: 'ts', val: '2026-10-25T12:00:00.000Z' }]);

  const failing = { from: () => ({ delete: () => ({ lt: async () => ({ error: { message: 'boom' } }) }) }) } as any;
  await pruneOldRequestLog(NOW, failing); // resolves
  const throwing = { from: () => { throw new Error('network'); } } as any;
  await pruneOldRequestLog(NOW, throwing); // resolves
});

// ---- migration 037 -----------------------------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, '../../supabase/migrations/037_realtimetts_request_log.sql'), 'utf8');
const rollback = readFileSync(join(here, '../../supabase/rollbacks/037_rollback.sql'), 'utf8');

test('migration 037: says NOT APPLIED, creates the table with the contract columns, no user_id', () => {
  assert.match(sql.split('\n').slice(0, 6).join('\n'), /NOT APPLIED until the owner runs it in the Supabase SQL editor/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS realtimetts_request_log/);
  for (const col of ['id', 'ts', 'received_at', 'request_id', 'gateway_key_id', 'transport', 'endpoint', 'voice', 'language', 'chars', 'outcome', 'http_status', 'error_code', 'ttfb_ms', 'duration_ms']) {
    assert.match(sql, new RegExp(`^\\s+${col}\\s`, 'm'), col);
  }
  assert.doesNotMatch(sql.replace(/--.*$/gm, ''), /user_id/);
});

test('migration 037: indexes, RLS on, one service_role policy, anon/authenticated revoked', () => {
  assert.match(sql, /CREATE INDEX IF NOT EXISTS \w+ ON realtimetts_request_log\(gateway_key_id, ts\)/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS \w+ ON realtimetts_request_log\(ts\)/);
  assert.match(sql, /ALTER TABLE realtimetts_request_log ENABLE ROW LEVEL SECURITY/);
  assert.equal((sql.match(/CREATE POLICY/g) ?? []).length, 1);
  assert.match(sql, /CREATE POLICY[^;]*ON realtimetts_request_log[^;]*TO service_role/);
  assert.match(sql, /REVOKE ALL ON realtimetts_request_log FROM anon, authenticated/);
  assert.doesNotMatch(sql, /TO (anon|authenticated|public)/i);
});

test('migration 037: enum CHECKs match the validator exactly', async () => {
  const { TRANSPORTS, OUTCOMES } = await modP;
  const list = (re: RegExp) => [...(re.exec(sql)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(list(/transport[^\n]*CHECK \(transport IN \(([^)]*)\)/), [...TRANSPORTS]);
  assert.deepEqual(list(/outcome[^\n]*CHECK \(outcome IN \(([^)]*)\)/), [...OUTCOMES]);
});

test('rollback 037 drops the table', () => {
  assert.match(rollback, /DROP TABLE IF EXISTS realtimetts_request_log/);
});
