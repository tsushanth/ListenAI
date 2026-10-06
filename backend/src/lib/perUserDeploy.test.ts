// npm test (node:test via tsx). Pure policy tests for per-user Modal deployment decisions and cleanup planning.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideDeploy, planCleanup, perUserSuffix, DEPLOYING_STALE_MS, type DeploymentRow } from './perUserDeploy.js';

const NOW = Date.parse('2026-10-06T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

test('decideDeploy: no row, no shared endpoint -> create', () => {
  assert.deepEqual(decideDeploy({ existing: null, sharedConfigured: false, now: NOW }), { action: 'create' });
});

test('decideDeploy: shared endpoint configured -> never deploy per user', () => {
  assert.deepEqual(decideDeploy({ existing: null, sharedConfigured: true, now: NOW }), { action: 'shared' });
  assert.deepEqual(decideDeploy({ existing: { status: 'failed', updated_at: ago(1) }, sharedConfigured: true, now: NOW }), { action: 'shared' });
});

test('decideDeploy: VOICE_PER_USER_DEPLOY escape hatch restores legacy deploy even with a shared endpoint', () => {
  assert.deepEqual(decideDeploy({ existing: null, sharedConfigured: true, perUserDeployForced: true, now: NOW }), { action: 'create' });
});

test('decideDeploy: ready row is a 409 conflict (active), also with a shared endpoint', () => {
  assert.deepEqual(decideDeploy({ existing: { status: 'ready' }, sharedConfigured: false, now: NOW }), { action: 'conflict', reason: 'active' });
  assert.deepEqual(decideDeploy({ existing: { status: 'ready' }, sharedConfigured: true, now: NOW }), { action: 'conflict', reason: 'active' });
  assert.deepEqual(decideDeploy({ existing: { status: 'stopping' }, sharedConfigured: false, now: NOW }), { action: 'conflict', reason: 'active' });
});

test('decideDeploy: failed row can be retried (was a permanent 409)', () => {
  assert.deepEqual(decideDeploy({ existing: { status: 'failed', updated_at: ago(1000) }, sharedConfigured: false, now: NOW }), { action: 'retry' });
  assert.deepEqual(decideDeploy({ existing: { status: 'stopped' }, sharedConfigured: false, now: NOW }), { action: 'retry' });
});

test('decideDeploy: fresh deploying row is in progress, stale one is retried, unknown age is treated as fresh', () => {
  assert.deepEqual(decideDeploy({ existing: { status: 'deploying', updated_at: ago(60_000) }, sharedConfigured: false, now: NOW }), { action: 'conflict', reason: 'in_progress' });
  assert.deepEqual(decideDeploy({ existing: { status: 'deploying', updated_at: ago(DEPLOYING_STALE_MS + 1) }, sharedConfigured: false, now: NOW }), { action: 'retry' });
  assert.deepEqual(decideDeploy({ existing: { status: 'deploying' }, sharedConfigured: false, now: NOW }), { action: 'conflict', reason: 'in_progress' });
  assert.deepEqual(decideDeploy({ existing: { status: 'deploying', updated_at: 'garbage' }, sharedConfigured: false, now: NOW }), { action: 'conflict', reason: 'in_progress' });
});

test('perUserSuffix only matches the exact per-user naming pattern (shared resources never match)', () => {
  assert.equal(perUserSuffix('convert', 'app', 'voice-convert-dev-user-ab12cd34-ef56'), 'user-ab12cd34-ef56');
  assert.equal(perUserSuffix('convert', 'secret', 'voice-convert-user-ab12cd34-ef56'), 'user-ab12cd34-ef56');
  assert.equal(perUserSuffix('convert', 'volume', 'voice-convert-dev-jobs-user-ab12cd34-ef56'), 'user-ab12cd34-ef56');
  assert.equal(perUserSuffix('isolate', 'app', 'voice-isolate-dev-user-ab12cd34-ef56'), 'user-ab12cd34-ef56');
  for (const shared of ['voice-convert', 'voice-convert-dev', 'voice-convert-dev-jobs', 'voice-convert-user-', 'voice-convert-user-ab12cd34', 'voice-convert-user-XYZ12345-abcd', 'voice-convert-dev-s6test']) {
    assert.equal(perUserSuffix('convert', 'secret', shared), null, shared);
    assert.equal(perUserSuffix('convert', 'app', shared), null, shared);
  }
  assert.equal(perUserSuffix('isolate', 'secret', 'voice-convert-user-ab12cd34-ef56'), null); // wrong feature
});

const row = (o: Partial<DeploymentRow>): DeploymentRow => ({ feature: 'convert', user_id: 'u1', app_name: 'voice-convert-dev-user-aaaaaaaa-1111', status: 'ready', job_count: 0, updated_at: ago(30 * 86400_000), ...o });

test('planCleanup: orphan per-user resources are removed, live ones and shared ones are kept', () => {
  const modal = {
    apps: ['voice-convert-dev-user-aaaaaaaa-1111', 'voice-convert-dev-user-bbbbbbbb-2222', 'voice-convert-dev', 'voice-convert-dev-s6test'],
    secrets: ['voice-convert-user-aaaaaaaa-1111', 'voice-convert-user-bbbbbbbb-2222', 'voice-convert', 's6-vc-secret'],
    volumes: ['voice-convert-dev-jobs-user-aaaaaaaa-1111', 'voice-convert-dev-jobs-user-bbbbbbbb-2222', 'voice-convert-dev-jobs'],
  };
  const plan = planCleanup({ rows: [row({})], modal, now: NOW });
  assert.deepEqual(plan.map((a) => `${a.kind}:${'name' in a ? a.name : a.user_id}`).sort(), [
    'modal_app_stop:voice-convert-dev-user-bbbbbbbb-2222',
    'modal_secret_delete:voice-convert-user-bbbbbbbb-2222',
    'modal_volume_delete:voice-convert-dev-jobs-user-bbbbbbbb-2222',
  ]);
});

test('planCleanup: an idle ready deployment is never deleted by age alone', () => {
  const plan = planCleanup({ rows: [row({ status: 'ready', updated_at: ago(400 * 86400_000) })], modal: { apps: ['voice-convert-dev-user-aaaaaaaa-1111'], secrets: [], volumes: [] }, now: NOW });
  assert.deepEqual(plan, []);
});

test('planCleanup: old failed row -> row + its app/secret/volume removed; recent failed row is left alone', () => {
  const modal = { apps: ['voice-convert-dev-user-aaaaaaaa-1111'], secrets: ['voice-convert-user-aaaaaaaa-1111'], volumes: ['voice-convert-dev-jobs-user-aaaaaaaa-1111'] };
  const old = planCleanup({ rows: [row({ status: 'failed', updated_at: ago(2 * 86400_000) })], modal, now: NOW });
  assert.deepEqual(old.map((a) => a.kind).sort(), ['db_row_delete', 'modal_app_stop', 'modal_secret_delete', 'modal_volume_delete']);
  const recent = planCleanup({ rows: [row({ status: 'failed', updated_at: ago(3600_000) })], modal, now: NOW });
  assert.deepEqual(recent, []);
});

test('planCleanup: a fresh deploying row protects its resources; a stale one does not', () => {
  const modal = { apps: ['voice-convert-dev-user-aaaaaaaa-1111'], secrets: ['voice-convert-user-aaaaaaaa-1111'], volumes: [] };
  assert.deepEqual(planCleanup({ rows: [row({ status: 'deploying', updated_at: ago(60_000) })], modal, now: NOW }), []);
  const stale = planCleanup({ rows: [row({ status: 'deploying', updated_at: ago(3 * 86400_000) })], modal, now: NOW });
  assert.ok(stale.some((a) => a.kind === 'db_row_delete'));
  assert.ok(stale.some((a) => a.kind === 'modal_app_stop'));
});

test('planCleanup: convert and isolate namespaces do not protect each other', () => {
  const modal = { apps: ['voice-isolate-dev-user-aaaaaaaa-1111'], secrets: [], volumes: [] };
  const plan = planCleanup({ rows: [row({ feature: 'convert' })], modal, now: NOW });
  assert.equal(plan.length, 1);
});

test('parseModalNames reads the real `modal ... list --json` shapes and skips stopped apps', async () => {
  const { parseModalNames } = await import('./perUserDeploy.js');
  const apps = JSON.stringify([{ 'App ID': 'ap-1', Description: 'voice-convert-dev-user-aaaaaaaa-1111', State: 'deployed' }, { 'App ID': 'ap-2', Description: 'old', State: 'stopped' }]);
  assert.deepEqual(parseModalNames(apps, 'app'), ['voice-convert-dev-user-aaaaaaaa-1111']);
  assert.deepEqual(parseModalNames(JSON.stringify([{ Name: 's1' }, { Name: 's2' }, {}]), 'secret'), ['s1', 's2']);
  assert.throws(() => parseModalNames('{}', 'volume'), /not an array/);
});
