// npm test (node:test via tsx). Regression tests for the independent review of the deployment lifecycle: each test
// describes a scenario that leaked cost, failed open, or misreported, and fails without the matching fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import './modalDeploymentsTestEnv.js'; // must stay first: sets env before config loads
import { makeHarness } from './modalDeploymentsTestKit.js';
import { limitsFromConfig, managedAppPattern, MAX_TEARDOWN_ATTEMPTS, SERVICE_SPECS } from './modalDeployments.js';
import { config } from './config.js';
import { runReaperOnce } from './deploymentReaper.js';

const MIN = 60_000;
const UUID_A = '0123abcd-0000-4000-8000-000000000001';

async function ready(h: ReturnType<typeof makeHarness>, user = 'user-a', service: 'convert' | 'isolate' = 'convert') {
  const out = await h.manager.deploy(user, service);
  assert.equal(out.kind, 'accepted');
  await h.manager.whenIdle();
  return out.kind === 'accepted' ? out.deployment.id : '';
}

// ---------------------------------------------------------------------------------------------
// Late cleanup (a teardown raced a deploy)
// ---------------------------------------------------------------------------------------------

test('a late cleanup that fails is retried, not abandoned: the app has no live row and only the reaper can still stop it', async () => {
  const h = makeHarness();
  h.cli.armDeployGate();
  const out = await h.manager.deploy('user-a', 'convert');
  await h.cli.deployStarted;
  const id = out.kind === 'accepted' ? out.deployment.id : '';
  assert.equal(await h.manager.teardown(id, 'user'), 'stopped'); // teardown wins while the CLI is still deploying

  h.cli.failOn.set('appStop', new Error('modal app stop failed: network down'));
  h.cli.failTimes.set('appStop', 1); // fails once more, then works
  h.cli.releaseDeploy(); // the deploy now "finishes" after teardown: the app exists and must be stopped
  await h.manager.whenIdle();

  let row = await h.store.getById(id);
  assert.equal(row?.status, 'stopping', 'put back on the retry path instead of staying "stopped" with a running app');

  h.clock.advance(61_000);
  await runReaperOnce(h.manager);
  row = await h.store.getById(id);
  assert.equal(row?.status, 'stopped');
});

test('a deploy that FAILS after a teardown already ran still cleans up (the Secret created mid-deploy must not leak)', async () => {
  const h = makeHarness();
  h.cli.armDeployGate();
  const out = await h.manager.deploy('user-a', 'convert');
  await h.cli.deployStarted; // secretCreate already happened
  const id = out.kind === 'accepted' ? out.deployment.id : '';
  await h.manager.teardown(id, 'user'); // deletes the secret and stops the (not yet existing) app

  h.cli.failDeployAfterGate = new Error('image build failed'); // the in-flight deploy now fails, after the teardown
  const before = h.cli.calls.length;
  h.cli.releaseDeploy();
  await h.manager.whenIdle();

  const after = h.cli.calls.slice(before).map((c) => c.op);
  assert.ok(after.includes('secretDelete'), `cleanup must run after the late failure; saw ${JSON.stringify(after)}`);
  assert.ok(after.includes('appStop'));
});

// ---------------------------------------------------------------------------------------------
// Giving up on a teardown
// ---------------------------------------------------------------------------------------------

test('after the attempt limit a stuck teardown leaves the live set: the user is unblocked, the retries stop, and DELETE does not claim success', async () => {
  const h = makeHarness();
  const id = await ready(h);
  h.cli.failOn.set('appStop', new Error('modal app stop failed: boom'));

  let last: string = 'stopping';
  for (let i = 0; i < MAX_TEARDOWN_ATTEMPTS; i++) last = await h.manager.teardown(id, 'user');
  assert.equal(last, 'stopping', 'the app may still be running, so the caller is not told it was torn down');

  const row = await h.store.getById(id);
  assert.equal(row?.status, 'stopped', 'out of the live set');
  assert.equal(row?.stop_reason, 'teardown_failed');
  assert.ok(row?.error);
  assert.ok(row?.volume_delete_at, 'its Volume is still scheduled for deletion');

  // The unique "one live deployment" rule no longer blocks a redeploy.
  h.cli.failOn.clear();
  assert.equal((await h.manager.deploy('user-a', 'convert')).kind, 'accepted');
  await h.manager.whenIdle();

  // And the reaper does not keep retrying (and re-alerting) it every minute.
  h.cli.calls.length = 0;
  h.clock.advance(5 * MIN);
  h.cli.failOn.set('appStop', new Error('still failing'));
  await runReaperOnce(h.manager);
  assert.equal(h.cli.calls.filter((c) => c.op === 'appStop' && c.args[0] === row?.app_name).length, 0);
});

// ---------------------------------------------------------------------------------------------
// Caps are enforced atomically and cannot fail open
// ---------------------------------------------------------------------------------------------

test('the global cap holds under concurrent deploys (check-then-insert would let them all through)', async () => {
  const h = makeHarness({ limits: { maxActiveGlobal: 3 } });
  const users = ['user-a', 'user-b', 'user-c', 'user-d', 'user-e', 'user-f'];
  for (const u of users) h.paying.add(u);
  const results = await Promise.all(users.map((u) => h.manager.deploy(u, 'convert')));
  await h.manager.whenIdle();
  assert.equal(results.filter((r) => r.kind === 'accepted').length, 3);
  assert.equal(results.filter((r) => r.kind === 'denied' && r.code === 'global_cap').length, 3);
  assert.equal(await h.store.countLiveForTest(), 3);
});

test('the per-user cap holds under concurrent deploys across services', async () => {
  const h = makeHarness({ limits: { maxActivePerUser: 1 } });
  const results = await Promise.all((['convert', 'isolate', 'sound_effect', 'music'] as const).map((s) => h.manager.deploy('user-a', s)));
  await h.manager.whenIdle();
  assert.equal(results.filter((r) => r.kind === 'accepted').length, 1);
  assert.equal(results.filter((r) => r.kind === 'denied' && r.code === 'user_cap').length, 3);
});

test('garbage limit settings fail loudly instead of disabling the caps (NaN >= n is always false)', () => {
  const bad = (patch: Record<string, unknown>) => () => limitsFromConfig({ ...config, ...patch } as typeof config);
  assert.throws(bad({ MODAL_MAX_ACTIVE_GLOBAL: NaN }), /MODAL_MAX_ACTIVE_GLOBAL/);
  assert.throws(bad({ MODAL_MAX_ACTIVE_PER_USER: 0 }), /MODAL_MAX_ACTIVE_PER_USER/);
  assert.throws(bad({ MODAL_DEPLOY_MAX_AGE_MIN: Number('abc') }), /MODAL_DEPLOY_MAX_AGE_MIN/);
  assert.throws(bad({ MODAL_DEPLOY_IDLE_TTL_MIN: -5 }), /MODAL_DEPLOY_IDLE_TTL_MIN/);
});

test('the kill switch accepts the usual spellings of true, not only the exact string "true"', () => {
  for (const v of ['true', 'TRUE', 'True', '1', 'yes', 'on']) {
    assert.equal(limitsFromConfig({ ...config, MODAL_DEPLOYMENTS_DISABLED: v } as typeof config).disabled, true, v);
  }
  for (const v of ['false', '0', '', 'no']) {
    assert.equal(limitsFromConfig({ ...config, MODAL_DEPLOYMENTS_DISABLED: v } as typeof config).disabled, false, v);
  }
});

// ---------------------------------------------------------------------------------------------
// Orphan sweep
// ---------------------------------------------------------------------------------------------

test('a deployment created while the orphan sweep is running is not stopped as an orphan', async () => {
  const h = makeHarness({ strictUserIds: true });
  h.paying.add(UUID_A);
  const name = 'voice-convert-dev-user-0123abcd-deadbeef';
  h.cli.apps = [{ id: 'ap-new', name, state: 'deployed' }];
  // Modal answers the app list; in the same instant a deploy for this very app finishes and its row exists.
  h.cli.onAppList = async () => {
    h.store.seedReady(UUID_A, 'convert', 'https://x.modal.run', 'secret-value', name);
  };
  const r = await runReaperOnce(h.manager, { scanOrphans: true });
  assert.equal(r.orphansStopped, 0, 'listing apps BEFORE the rows closes the race');
  assert.deepEqual(h.cli.calls.filter((c) => c.op === 'appStop'), []);
});

// ---------------------------------------------------------------------------------------------
// What the API shows
// ---------------------------------------------------------------------------------------------

test('the public view does not expose raw CLI output (paths, token ids); the detail stays in the row for operators', async () => {
  const h = makeHarness();
  h.cli.failOn.set('deploy', new Error('modal deploy failed (exit 1): MODAL_TOKEN_ID=ak-123456 at /app/modal/convert_job.py line 9'));
  await h.manager.deploy('user-a', 'convert');
  await h.manager.whenIdle();
  const pub = await h.manager.getForUser('user-a', 'convert');
  assert.equal(pub?.status, 'failed');
  assert.ok(pub?.error, 'the user is told it failed');
  assert.doesNotMatch(pub!.error!, /ak-123456|\/app\/modal|MODAL_TOKEN/);
  const row = [...h.store.rows.values()][0];
  assert.match(row.error ?? '', /ak-123456/, 'operators still get the detail');
});

// ---------------------------------------------------------------------------------------------
// Names, identities, margins
// ---------------------------------------------------------------------------------------------

test('names carry 32 bits of randomness so a new deployment cannot collide with an old one\'s app and Volume names', async () => {
  const h = makeHarness();
  await ready(h);
  const row = [...h.store.rows.values()][0];
  assert.match(row.app_name, /^voice-convert-dev-user-[0-9a-z]{5,8}-[0-9a-f]{8}$/);
  assert.match(managedAppPattern().source, /\{8\}-\[0-9a-f\]\{8\}|\{8\}\)?-\[0-9a-f\]\{8\}/);
  assert.ok(managedAppPattern().test('voice-convert-dev-user-0123abcd-deadbeef'));
  assert.equal(managedAppPattern().test('voice-convert-dev-user-0123abcd-dead'), false, 'the old 16-bit form is no longer ours to match');
});

test('every service still fits Modal\'s 63 character subdomain with the longer suffix', () => {
  for (const spec of Object.values(SERVICE_SPECS)) {
    const label = `${'a'.repeat(16)}--${spec.appPrefix}-user-0123abcd-deadbeef-${spec.urlLabel}`;
    assert.ok(label.length <= 63, `${spec.service}: ${label.length} chars`);
  }
});

test('an identity that is not an account (an API key id) is refused with a clear code, not a database error', async () => {
  const h = makeHarness({ strictUserIds: true });
  const out = await h.manager.deploy('key_abc123', 'convert');
  assert.deepEqual([out.kind, out.kind === 'denied' && out.code], ['denied', 'account_required']);
  assert.equal(h.store.rows.size, 0);
  h.paying.add(UUID_A);
  assert.equal((await h.manager.deploy(UUID_A, 'convert')).kind, 'accepted');
  await h.manager.whenIdle();
});

test('new work is not accepted in the last minutes of a deployment\'s life, but in-flight work can still be fetched', async () => {
  const h = makeHarness();
  await ready(h);
  for (let i = 0; i < 9; i++) { // keep it busy (never idle) for 225 of its 240 minutes
    h.clock.advance(25 * MIN);
    const t = await h.manager.resolveTarget('user-a', 'convert');
    assert.ok(t);
    await h.manager.touch(t, { job: true });
  }
  h.clock.advance(12 * MIN); // 237 minutes in: 3 minutes left, only 12 minutes since the last job
  assert.equal(await h.manager.resolveTarget('user-a', 'convert', { forNewWork: true }), null, 'a long job submitted now would be killed mid-run');
  assert.ok(await h.manager.resolveTarget('user-a', 'convert'), 'polling and fetching results still work');
});

test('the number of `modal deploy` processes running at once is bounded', async () => {
  const h = makeHarness({ limits: { maxConcurrentDeploys: 2, maxActiveGlobal: 50, maxActivePerUser: 5 } });
  const users = ['u1', 'u2', 'u3', 'u4', 'u5'];
  for (const u of users) h.paying.add(u);
  h.cli.deployDelayMs = 5;
  await Promise.all(users.map((u) => h.manager.deploy(u, 'convert')));
  await h.manager.whenIdle();
  assert.ok(h.cli.maxConcurrentDeploys <= 2, `saw ${h.cli.maxConcurrentDeploys} at once`);
  assert.equal([...h.store.rows.values()].filter((r) => r.status === 'ready').length, 5, 'all of them still finish');
});
