// backend/src/lib/usageDailyMigration.test.ts
// Run: npm test. Static guard on the usage-ledger migration (the SQL is applied by hand in the Supabase editor).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dir = join(__dirname, '../../supabase/migrations');
const file = readdirSync(dir).find((f) => f.endsWith('_realtimetts_usage_daily.sql'));
const sql = file ? readFileSync(join(dir, file), 'utf8') : '';

test('migration file exists', () => {
  assert.ok(file, 'expected a *_realtimetts_usage_daily.sql migration');
});

test('table has RLS on, a service_role-only policy, and anon/authenticated revoked', () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS realtimetts_usage_daily/);
  assert.match(sql, /ALTER TABLE realtimetts_usage_daily ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /CREATE POLICY[^;]*ON realtimetts_usage_daily[^;]*TO service_role/);
  assert.match(sql, /REVOKE ALL ON realtimetts_usage_daily FROM anon, authenticated/);
  assert.doesNotMatch(sql, /TO (anon|authenticated|public)/i);
});

test('add function adds on conflict (never overwrites) and is service_role only', () => {
  assert.match(sql, /CREATE OR REPLACE FUNCTION realtimetts_add_usage/);
  assert.match(sql, /ON CONFLICT \(day, user_id\) DO UPDATE SET[\s\S]*chars\s*=\s*realtimetts_usage_daily\.chars \+ EXCLUDED\.chars/);
  assert.match(sql, /audio_seconds\s*=\s*realtimetts_usage_daily\.audio_seconds \+ EXCLUDED\.audio_seconds/);
  assert.match(sql, /piper_chars\s*=\s*realtimetts_usage_daily\.piper_chars \+ EXCLUDED\.piper_chars/);
  assert.match(sql, /free_chars\s*=\s*realtimetts_usage_daily\.free_chars \+ EXCLUDED\.free_chars/);
  assert.match(sql, /LANGUAGE sql\s+SET search_path = public\s+AS/);
  assert.match(sql, /REVOKE ALL ON FUNCTION realtimetts_add_usage[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION realtimetts_add_usage[\s\S]*TO service_role/);
});

test('rollback drops the function and the table', () => {
  const rb = readFileSync(join(__dirname, '../../supabase/rollbacks/034_rollback.sql'), 'utf8');
  assert.match(rb, /DROP FUNCTION IF EXISTS realtimetts_add_usage/);
  assert.match(rb, /DROP TABLE IF EXISTS realtimetts_usage_daily/);
});
