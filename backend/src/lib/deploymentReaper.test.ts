// npm test (node:test via tsx). Reaper passes against an in-memory store, fake Modal CLI and fake clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import './modalDeploymentsTestEnv.js'; // must stay first: sets env before config loads
import { makeHarness, type Harness } from './modalDeploymentsTestKit.js';
import { runReaperOnce, MAX_ORPHAN_STOPS_PER_RUN } from './deploymentReaper.js';

const MIN = 60_000;

async function ready(h: Harness, user = 'user-a'): Promise<string> {
  const out = await h.manager.deploy(user, 'convert');
  assert.equal(out.kind, 'accepted');
  await h.manager.whenIdle();
  return out.kind === 'accepted' ? out.deployment.id : '';
}

test('an idle deployment is torn down and a recently used one is left alone', async () => {
  const h = makeHarness();
  const idle = await ready(h, 'user-a');
  const busy = await ready(h, 'user-b');
  h.clock.advance(20 * MIN);
  await h.manager.touch(busy);
  h.clock.advance(15 * MIN); // idle: 35 min since use; busy: 15 min

  const r = await runReaperOnce(h.manager);
  assert.equal(r.idleTornDown, 1);
  assert.equal((await h.store.getById(idle))?.status, 'stopped');
  assert.equal((await h.store.getById(idle))?.stop_reason, 'idle');
  assert.equal((await h.store.getById(busy))?.status, 'ready');
});

test('a deployment past its maximum age is torn down even though it is busy', async () => {
  const h = makeHarness();
  const id = await ready(h);
  for (let i = 0; i < 10; i++) {
    h.clock.advance(25 * MIN);
    await h.manager.touch(id); // never idle
  }
  // 250 minutes after deploy, limit is 240.
  const r = await runReaperOnce(h.manager);
  assert.equal(r.expiredTornDown, 1);
  assert.equal((await h.store.getById(id))?.stop_reason, 'max_age');
});

test('a deployment stuck in deploying past the timeout is failed and cleaned up; a fresh one is not', async () => {
  const h = makeHarness();
  h.cli.armDeployGate(); // the CLI never returns, like a backend that died mid-deploy
  const stuck = await h.manager.deploy('user-a', 'convert');
  await h.cli.deployStarted;
  const stuckId = stuck.kind === 'accepted' ? stuck.deployment.id : '';

  h.clock.advance(5 * MIN);
  assert.equal((await runReaperOnce(h.manager)).stuckFailed, 0, 'still within the 10 minute window');
  h.clock.advance(6 * MIN);
  const r = await runReaperOnce(h.manager);
  assert.equal(r.stuckFailed, 1);
  const row = await h.store.getById(stuckId);
  assert.equal(row?.status, 'failed');
  assert.equal(row?.stop_reason, 'deploy_timeout');
  assert.ok(row?.stopped_at, 'its app and secret were cleaned up');
  h.cli.releaseDeploy();
  await h.manager.whenIdle();
});

test('a teardown that did not finish is retried, but not before the retry delay', async () => {
  const h = makeHarness();
  const id = await ready(h);
  h.cli.failOn.set('appStop', new Error('modal app stop failed: network down'));
  h.cli.failTimes.set('appStop', 1); // fails once, then works
  assert.equal(await h.manager.teardown(id, 'user'), 'stopping');

  assert.equal((await runReaperOnce(h.manager)).teardownRetried, 0, 'too soon');
  h.clock.advance(61_000);
  const r = await runReaperOnce(h.manager);
  assert.equal(r.teardownRetried, 1);
  assert.equal((await h.store.getById(id))?.status, 'stopped');
});

test('a failed deploy whose cleanup never completed is cleaned up on a later pass', async () => {
  const h = makeHarness();
  h.cli.failOn.set('deploy', new Error('deploy exploded'));
  h.cli.failOn.set('appStop', new Error('stop also failed'));
  h.cli.failTimes.set('appStop', 1);
  await h.manager.deploy('user-a', 'convert');
  await h.manager.whenIdle();
  const row = [...h.store.rows.values()][0];
  assert.equal(row.status, 'failed');
  assert.equal(row.stopped_at, null, 'first cleanup attempt failed');

  const r = await runReaperOnce(h.manager);
  assert.equal(r.failedCleaned, 1);
  assert.ok((await h.store.getById(row.id))?.stopped_at);
});

test('per-user Volumes are deleted only after the retention window, once', async () => {
  const h = makeHarness();
  const id = await ready(h);
  await h.manager.teardown(id, 'user');
  h.cli.calls.length = 0;

  h.clock.advance(23 * 60 * MIN);
  assert.equal((await runReaperOnce(h.manager)).volumesDeleted, 0, 'results are still fetchable');
  assert.equal(h.cli.ops().includes('volumeDelete'), false);

  h.clock.advance(2 * 60 * MIN);
  assert.equal((await runReaperOnce(h.manager)).volumesDeleted, 1);
  assert.deepEqual(h.cli.calls.filter((c) => c.op === 'volumeDelete').map((c) => c.args[0]), ['voice-convert-dev-jobs-user-usera-abcd']);
  assert.ok((await h.store.getById(id))?.volumes_deleted_at);

  h.cli.calls.length = 0;
  assert.equal((await runReaperOnce(h.manager)).volumesDeleted, 0, 'not deleted a second time');
  assert.equal(h.cli.ops().includes('volumeDelete'), false);
});

test('a Volume delete that fails is retried on the next pass', async () => {
  const h = makeHarness();
  const id = await ready(h);
  await h.manager.teardown(id, 'user');
  h.clock.advance(25 * 60 * MIN);
  h.cli.failOn.set('volumeDelete', new Error('modal volume delete failed'));
  h.cli.failTimes.set('volumeDelete', 1);
  assert.equal((await runReaperOnce(h.manager)).volumesDeleted, 0);
  assert.equal((await h.store.getById(id))?.volumes_deleted_at, null);
  assert.equal((await runReaperOnce(h.manager)).volumesDeleted, 1);
});

// ---------------------------------------------------------------------------------------------
// orphans
// ---------------------------------------------------------------------------------------------

test('orphan scan stops managed apps that no live row owns and nothing else', async () => {
  const h = makeHarness();
  // A real owned deployment, using an id that produces a name matching the managed pattern.
  const out = await h.manager.deploy('0123abcd-0000-0000-0000-000000000000', 'convert');
  assert.equal(out.kind, 'denied'); // not paying; add them so we can deploy
  h.paying.add('0123abcd-0000-0000-0000-000000000000');
  const ok = await h.manager.deploy('0123abcd-0000-0000-0000-000000000000', 'convert');
  assert.equal(ok.kind, 'accepted');
  await h.manager.whenIdle();
  const owned = ok.kind === 'accepted' ? ok.deployment.app_name : '';
  assert.equal(owned, 'voice-convert-dev-user-0123abcd-abcd');

  h.cli.apps = [
    { id: 'ap-owned', name: owned, state: 'deployed' },
    { id: 'ap-orphan', name: 'voice-isolate-dev-user-deadbeef-1234', state: 'deployed' },
    { id: 'ap-stopped', name: 'voice-convert-dev-user-feedface-0001', state: 'stopped' },
    { id: 'ap-hand', name: 'voice-convert-dev', state: 'deployed' }, // hand-deployed, no per-user suffix
    { id: 'ap-other', name: 'realtime-tts-worker', state: 'deployed' },
  ];
  h.cli.calls.length = 0;
  const r = await runReaperOnce(h.manager, { scanOrphans: true });
  assert.equal(r.orphansStopped, 1);
  assert.deepEqual(h.cli.calls.filter((c) => c.op === 'appStop').map((c) => c.args[0]), ['ap-orphan']);
});

test('orphan scan is skipped unless requested, and stops at most a handful per pass', async () => {
  const h = makeHarness();
  h.cli.apps = Array.from({ length: 12 }, (_, i) => ({
    id: `ap-${i}`,
    name: `voice-convert-dev-user-${(0xabc00000 + i).toString(16)}-0001`,
    state: 'deployed',
  }));
  h.cli.calls.length = 0;
  await runReaperOnce(h.manager); // default: no scan
  assert.equal(h.cli.ops().includes('appList'), false);

  const r = await runReaperOnce(h.manager, { scanOrphans: true });
  assert.equal(r.orphansStopped, MAX_ORPHAN_STOPS_PER_RUN, 'a bug in matching cannot mass-stop apps');
});

test('one failing step does not stop the others', async () => {
  const h = makeHarness();
  const id = await ready(h);
  await h.manager.teardown(id, 'user');
  h.clock.advance(25 * 60 * MIN);
  h.cli.failOn.set('volumeDelete', new Error('volume step is broken'));
  h.cli.apps = [{ id: 'ap-orphan', name: 'voice-isolate-dev-user-deadbeef-1234', state: 'deployed' }];
  const r = await runReaperOnce(h.manager, { scanOrphans: true });
  assert.equal(r.volumesDeleted, 0);
  assert.equal(r.orphansStopped, 1, 'orphan cleanup still ran');
});
