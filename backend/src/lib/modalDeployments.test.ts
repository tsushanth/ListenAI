// npm test (node:test via tsx). Lifecycle tests for the self-serve Modal deployment manager, using an
// in-memory store, a fake Modal CLI and a fake clock. No Modal, Supabase or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import './modalDeploymentsTestEnv.js'; // must stay first: sets env before config loads
import { makeHarness } from './modalDeploymentsTestKit.js';
import { SERVICE_SPECS, MAX_TEARDOWN_ATTEMPTS, managedAppPattern } from './modalDeployments.js';

const MAX_ATTEMPTS = MAX_TEARDOWN_ATTEMPTS;

const MIN = 60_000;

async function deployReady(h: ReturnType<typeof makeHarness>, user = 'user-a', service: 'convert' | 'isolate' = 'convert') {
  const out = await h.manager.deploy(user, service);
  assert.equal(out.kind, 'accepted');
  await h.manager.whenIdle();
  return out.kind === 'accepted' ? out.deployment.id : '';
}

// ---------------------------------------------------------------------------------------------
// deploy
// ---------------------------------------------------------------------------------------------

test('deploy creates the secret, deploys the Modal file with per-user names, and ends up ready', async () => {
  const h = makeHarness();
  const out = await h.manager.deploy('user-a', 'convert');
  assert.equal(out.kind, 'accepted');
  assert.equal(out.kind === 'accepted' && out.deployment.status, 'requested'); // returns immediately, before the CLI finishes
  await h.manager.whenIdle();

  assert.deepEqual(h.cli.ops(), ['secretCreate', 'deploy']);
  const [, key, value] = h.cli.calls[0].args as [string, string, string];
  assert.equal(key, 'CONVERT_SECRET');
  assert.match(value, /^0+1$/); // the 32-byte secret generated for this deployment
  const [file, env] = h.cli.calls[1].args as [string, Record<string, string>];
  assert.equal(file, 'modal/convert_job.py');
  assert.equal(env.VOICE_CONVERT_APP_SUFFIX, '-user-usera-abcd1234');
  assert.equal(env.VOICE_CONVERT_SECRET_NAME, 'voice-convert-user-usera-abcd1234');

  const row = [...h.store.rows.values()][0];
  assert.equal(row.status, 'ready');
  assert.equal(row.app_name, 'voice-convert-dev-user-usera-abcd1234');
  assert.equal(row.modal_url, 'https://test-ws--voice-convert-dev-user-usera-abcd1234-api.modal.run');
  assert.deepEqual(row.volume_names, ['voice-convert-dev-jobs-user-usera-abcd1234']);
  assert.equal(row.ready_at, h.clock.now().toISOString());
  assert.equal(row.expires_at, new Date(h.clock.ms + 4 * 60 * MIN).toISOString());
});

test('the public view never includes the secret and reports the auto-teardown time', async () => {
  const h = makeHarness();
  const id = await deployReady(h);
  const mine = await h.manager.getForUser('user-a', 'convert');
  assert.ok(mine);
  assert.equal(mine.id, id);
  assert.equal('modal_secret' in mine, false);
  assert.equal(JSON.stringify(mine).includes('secret'), false);
  assert.equal(mine.seconds_until_auto_teardown, 30 * 60); // idle timeout is the nearer limit
});

test('deploying again while one is live returns the existing deployment instead of creating a second', async () => {
  const h = makeHarness();
  await deployReady(h);
  const again = await h.manager.deploy('user-a', 'convert');
  assert.equal(again.kind, 'exists');
  assert.equal(h.cli.calls.filter((c) => c.op === 'deploy').length, 1);
});

test('a race that loses the unique-index insert resolves to the winner', async () => {
  const h = makeHarness();
  const realClaim = h.store.claim.bind(h.store);
  let first = true;
  h.store.claim = async (n, caps) => {
    if (first) {
      first = false;
      await realClaim(n, caps); // the "other request" wins
      return { conflict: true };
    }
    return realClaim(n, caps);
  };
  const out = await h.manager.deploy('user-a', 'convert');
  assert.equal(out.kind, 'exists');
});

test('each denial reason is reported and nothing is created', async (t) => {
  await t.test('kill switch', async () => {
    const h = makeHarness({ limits: { disabled: true } });
    const out = await h.manager.deploy('user-a', 'convert');
    assert.equal(out.kind === 'denied' && out.code, 'deployments_disabled');
  });
  await t.test('Modal credentials missing', async () => {
    const h = makeHarness({ cliConfigured: false });
    const out = await h.manager.deploy('user-a', 'convert');
    assert.equal(out.kind === 'denied' && out.code, 'not_configured');
  });
  await t.test('no payment method', async () => {
    const h = makeHarness();
    const out = await h.manager.deploy('stranger', 'convert');
    assert.equal(out.kind === 'denied' && out.code, 'payment_required');
    assert.equal(h.store.rows.size, 0);
  });
  await t.test('payment requirement can be switched off', async () => {
    const h = makeHarness({ limits: { requirePaymentMethod: false } });
    const out = await h.manager.deploy('stranger', 'convert');
    assert.equal(out.kind, 'accepted');
    await h.manager.whenIdle();
  });
  await t.test('per-user cap', async () => {
    const h = makeHarness({ limits: { maxActivePerUser: 1 } });
    await deployReady(h, 'user-a', 'convert');
    const out = await h.manager.deploy('user-a', 'isolate');
    assert.equal(out.kind === 'denied' && out.code, 'user_cap');
  });
  await t.test('global cap', async () => {
    const h = makeHarness({ limits: { maxActiveGlobal: 1 } });
    await deployReady(h, 'user-a');
    const out = await h.manager.deploy('user-b', 'convert');
    assert.equal(out.kind === 'denied' && out.code, 'global_cap');
  });
  await t.test('daily cap counts stopped deployments too', async () => {
    const h = makeHarness({ limits: { maxDeploysPerUserPerDay: 2 } });
    for (let i = 0; i < 2; i++) {
      const id = await deployReady(h, 'user-a');
      await h.manager.teardown(id, 'user');
    }
    const out = await h.manager.deploy('user-a', 'convert');
    assert.equal(out.kind === 'denied' && out.code, 'daily_cap');
  });
});

test('a failed deploy is marked failed, its error never contains the secret, and the leftovers are cleaned up', async () => {
  const h = makeHarness();
  h.cli.failOn.set('deploy', new Error('modal deploy failed (exit 1): boom, secret was 0000000000000000000000000000000000000000000000000000000000000001 oops'));
  const out = await h.manager.deploy('user-a', 'convert');
  assert.equal(out.kind, 'accepted');
  await h.manager.whenIdle();

  const row = [...h.store.rows.values()][0];
  assert.equal(row.status, 'failed');
  assert.equal(row.stop_reason, 'deploy_failed');
  assert.ok(row.error);
  assert.equal(row.error.includes('0000000000000000000000000000000000000000000000000000000000000001'), false);
  assert.ok(h.cli.ops().includes('appStop'));
  assert.ok(h.cli.ops().includes('secretDelete'));
  assert.ok(row.stopped_at, 'cleanup completed');

  // History does not block a retry.
  h.cli.failOn.clear();
  const retry = await h.manager.deploy('user-a', 'convert');
  assert.equal(retry.kind, 'accepted');
  await h.manager.whenIdle();
});

// ---------------------------------------------------------------------------------------------
// use
// ---------------------------------------------------------------------------------------------

test('resolveTarget returns the url and secret only for a ready, unexpired, non-idle deployment', async () => {
  const h = makeHarness();
  assert.equal(await h.manager.resolveTarget('user-a', 'convert'), null, 'nothing deployed');
  const id = await deployReady(h);
  const target = await h.manager.resolveTarget('user-a', 'convert');
  assert.ok(target);
  assert.equal(target.deploymentId, id);
  assert.equal(target.url, 'https://test-ws--voice-convert-dev-user-usera-abcd1234-api.modal.run');
  assert.match(target.secret, /^0+1$/);

  h.clock.advance(31 * MIN);
  assert.equal(await h.manager.resolveTarget('user-a', 'convert'), null, 'idle past the timeout is not usable even before the reaper runs');
});

test('a submitted job resets the idle clock and is counted', async () => {
  const h = makeHarness();
  const id = await deployReady(h);
  h.clock.advance(25 * MIN);
  const target = await h.manager.resolveTarget('user-a', 'convert');
  assert.ok(target);
  await h.manager.touch(target, { job: true });
  h.clock.advance(25 * MIN); // 50 minutes since deploy, but only 25 since the last job
  assert.ok(await h.manager.resolveTarget('user-a', 'convert'));
  const row = await h.store.getById(id);
  assert.equal(row?.job_count, 1);
});

test('plain activity (polling) keeps a deployment alive but does not write on every poll', async () => {
  const h = makeHarness();
  const id = await deployReady(h);
  let writes = 0;
  const realPatch = h.store.patch.bind(h.store);
  h.store.patch = async (...a) => { writes++; return realPatch(...a); };

  h.clock.advance(20 * MIN);
  let target = await h.manager.resolveTarget('user-a', 'convert');
  assert.ok(target);
  await h.manager.touch(target); // last write was 20 minutes ago: writes
  assert.equal(writes, 1);

  for (let i = 0; i < 5; i++) {
    h.clock.advance(5_000); // polling every few seconds
    target = await h.manager.resolveTarget('user-a', 'convert');
    assert.ok(target);
    await h.manager.touch(target);
  }
  assert.equal(writes, 1, 'throttled: no further writes inside a minute');
  assert.equal((await h.store.getById(id))?.job_count, 0, 'polling is not a job');

  h.clock.advance(25 * MIN); // idle clock restarted at the 20 minute touch, so this is 25 min later: still usable
  assert.ok(await h.manager.resolveTarget('user-a', 'convert'));
});

test('resolveTarget stops working at the maximum age even if the deployment is busy', async () => {
  const h = makeHarness();
  const id = await deployReady(h);
  for (let i = 0; i < 9; i++) {
    h.clock.advance(25 * MIN);
    const t = await h.manager.resolveTarget('user-a', 'convert');
    assert.ok(t);
    await h.manager.touch(t, { job: true });
  }
  // 225 minutes in, still under the 240 limit.
  assert.ok(await h.manager.resolveTarget('user-a', 'convert'));
  h.clock.advance(16 * MIN);
  assert.equal(await h.manager.resolveTarget('user-a', 'convert'), null);
});

// ---------------------------------------------------------------------------------------------
// teardown
// ---------------------------------------------------------------------------------------------

test('teardown stops the app, deletes the secret, and schedules the Volume for deletion after retention', async () => {
  const h = makeHarness();
  const id = await deployReady(h);
  h.cli.calls.length = 0;

  assert.equal(await h.manager.teardown(id, 'user'), 'stopped');
  assert.deepEqual(h.cli.ops(), ['appStop', 'secretDelete']);
  const row = await h.store.getById(id);
  assert.equal(row?.status, 'stopped');
  assert.equal(row?.stop_reason, 'user');
  assert.equal(row?.volume_delete_at, new Date(h.clock.ms + 24 * 60 * MIN).toISOString());
  assert.equal(row?.volumes_deleted_at, null, 'results stay fetchable until retention ends');

  // The user can deploy again right away.
  assert.equal((await h.manager.deploy('user-a', 'convert')).kind, 'accepted');
  await h.manager.whenIdle();
});

test('teardown is idempotent and safe to call twice', async () => {
  const h = makeHarness();
  const id = await deployReady(h);
  assert.equal(await h.manager.teardown(id, 'user'), 'stopped');
  h.cli.calls.length = 0;
  assert.equal(await h.manager.teardown(id, 'idle'), 'noop');
  assert.deepEqual(h.cli.ops(), [], 'no second round of Modal calls');
  assert.equal(await h.manager.teardown('does-not-exist', 'user'), 'noop');
});

test('a Modal stop that fails leaves the deployment stopping so it is retried, then gives up loudly after the attempt limit', async () => {
  const h = makeHarness();
  const id = await deployReady(h);
  h.cli.failOn.set('appStop', new Error('modal app stop failed (exit 1): network down'));

  assert.equal(await h.manager.teardown(id, 'user'), 'stopping');
  let row = await h.store.getById(id);
  assert.equal(row?.status, 'stopping');
  assert.equal(row?.attempts, 1);

  for (let i = 2; i < MAX_ATTEMPTS; i++) {
    await h.manager.teardown(id, 'retry');
  }
  row = await h.store.getById(id);
  assert.equal(row?.attempts, MAX_ATTEMPTS - 1);
  assert.equal(row?.stopped_at, null);

  await h.manager.teardown(id, 'retry');
  row = await h.store.getById(id);
  assert.equal(row?.attempts, MAX_ATTEMPTS);
  assert.ok(row?.stopped_at, 'stops retrying after the limit (and reports it) instead of looping forever');
});

test('a teardown during deploy wins: the app that finishes deploying afterwards is cleaned up, not left running', async () => {
  const h = makeHarness();
  h.cli.armDeployGate();
  const out = await h.manager.deploy('user-a', 'convert');
  assert.equal(out.kind, 'accepted');
  await h.cli.deployStarted; // CLI is now mid-deploy
  const id = out.kind === 'accepted' ? out.deployment.id : '';

  assert.equal(await h.manager.teardown(id, 'user'), 'stopped');
  h.cli.releaseDeploy(); // the deploy now "finishes" after teardown already ran
  await h.manager.whenIdle();

  const row = await h.store.getById(id);
  assert.equal(row?.status, 'stopped', 'never flips back to ready');
  const stops = h.cli.calls.filter((c) => c.op === 'appStop').length;
  assert.ok(stops >= 2, 'stopped once by the teardown and again after the late deploy finished');
});

// ---------------------------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------------------------

test('every registry entry produces names the orphan matcher recognises', async () => {
  const pattern = managedAppPattern();
  for (const spec of Object.values(SERVICE_SPECS)) {
    assert.ok(pattern.test(`${spec.appPrefix}-user-0123abcd-ef012345`), spec.service);
  }
  assert.equal(pattern.test('voice-convert-dev'), false, 'a hand-deployed app without the per-user suffix is not ours to stop');
  assert.equal(pattern.test('realtime-tts-worker'), false);
});

test('all five services are available', () => {
  const available = Object.values(SERVICE_SPECS).filter((s) => s.available).map((s) => s.service).sort();
  assert.deepEqual(available, ['convert', 'dub', 'isolate', 'music', 'sound_effect']);
  for (const s of Object.values(SERVICE_SPECS)) {
    if (!s.available) assert.ok(s.unavailableReason, `${s.service} explains why it is unavailable`);
  }
});

test('every service produces an endpoint subdomain within Modal\'s 63 character limit', () => {
  // "<workspace>--<app>-<function>"; 16 characters is longer than the 10 character workspace in use.
  const workspace = 'a'.repeat(16);
  for (const spec of Object.values(SERVICE_SPECS)) {
    const label = `${workspace}--${spec.appPrefix}-user-0123abcd-ef012345-${spec.urlLabel}`;
    assert.ok(label.length <= 63, `${spec.service}: ${label.length} chars (${label})`);
  }
});

test('a workspace name that would push an endpoint past 63 characters is refused before anything is deployed', async () => {
  const h = makeHarness();
  const long = new (h.manager.constructor as new (d: object) => typeof h.manager)({
    store: h.store, cli: h.cli, limits: h.manager.limits, workspace: 'w'.repeat(40), cliConfigured: true,
    hasPaymentMethod: async () => true, validateUserId: () => true, now: h.clock.now,
  });
  const out = await long.deploy('user-a', 'convert');
  assert.deepEqual([out.kind, out.kind === 'denied' && out.code], ['denied', 'not_configured']);
  assert.equal(h.store.rows.size, 0);
  assert.equal(h.cli.calls.length, 0);
});
