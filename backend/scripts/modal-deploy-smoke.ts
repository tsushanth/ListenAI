// Manual smoke test of the self-serve deployment lifecycle against REAL Modal. Not part of `npm test`.
//
//   npx tsx scripts/modal-deploy-smoke.ts
//
// Uses your logged-in Modal profile (or MODAL_TOKEN_ID/SECRET) and an in-memory store, so it never touches the
// database. It deploys one real per-user voice-isolate app for a throwaway user, checks that the app is deployed
// and that its per-user secret actually protects it, tears it down, and checks that the app, Secret and Volume are
// really gone. Cost: one image build (cached after the first run) and one CPU cold start, a few cents.
// Everything is cleaned up in a finally block even if a check fails.
import '../src/lib/modalDeploymentsTestEnv.js'; // dummy Supabase env so config loads; the store here is in memory
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DeploymentManager } from '../src/lib/modalDeployments.js';
import { createModalCli } from '../src/lib/modalCli.js';
import { runReaperOnce } from '../src/lib/deploymentReaper.js';
import { MemoryStore, TEST_LIMITS, type FakeClock } from '../src/lib/modalDeploymentsTestKit.js';

const run = promisify(execFile);
const USER = '5a0e5a0e-0000-0000-0000-000000000000'; // throwaway; matches the managed-app name pattern
const results: Array<{ step: string; ok: boolean; detail: string }> = [];
const check = (step: string, ok: boolean, detail = '') => {
  results.push({ step, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? `  (${detail})` : ''}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const modal = async (...args: string[]) => (await run('modal', args, { env: process.env, maxBuffer: 8 * 1024 * 1024 })).stdout;

async function main() {
  const clock = { ms: Date.now(), now: () => new Date(), advance() {} } as unknown as FakeClock;
  const store = new MemoryStore(clock);
  const manager = new DeploymentManager({
    store,
    cli: createModalCli({ cwd: process.cwd() }),
    limits: { ...TEST_LIMITS, requirePaymentMethod: false, volumeRetentionMs: 0, deployTimeoutMs: 15 * 60_000 },
    workspace: process.env.MODAL_WORKSPACE || 't-sushanth',
    cliConfigured: true,
    hasPaymentMethod: async () => true,
  });

  let deploymentId = '';
  try {
    const t0 = Date.now();
    const out = await manager.deploy(USER, 'isolate');
    check('deploy accepted', out.kind === 'accepted', out.kind);
    if (out.kind !== 'accepted') return;
    deploymentId = out.deployment.id;
    console.log(`      app ${out.deployment.app_name}\n      url ${out.deployment.modal_url}`);

    // wait for ready
    let status = 'requested';
    for (let i = 0; i < 180 && status !== 'ready' && status !== 'failed'; i++) {
      await sleep(5000);
      status = (await manager.getForUser(USER, 'isolate'))?.status ?? 'missing';
    }
    const row = (await store.getById(deploymentId))!;
    check('deployment reached ready', status === 'ready', `${status} after ${Math.round((Date.now() - t0) / 1000)}s${row.error ? `, error: ${row.error}` : ''}`);
    if (status !== 'ready') return;

    // Modal agrees the app is deployed
    const apps = JSON.parse(await modal('app', 'list', '--json')) as Array<Record<string, string>>;
    const mine = apps.find((a) => a['Description'] === row.app_name);
    check('Modal lists the app as deployed', !!mine && String(mine['State']).startsWith('deployed'), mine ? mine['State'] : 'not found');

    // The per-user secret really protects the endpoint (first request cold-starts a container: allow time)
    const probe = `${row.modal_url}/isolate/does-not-exist`;
    const noAuth = await fetch(probe, { signal: AbortSignal.timeout(150_000) });
    check('request without the secret is rejected (401)', noAuth.status === 401, `HTTP ${noAuth.status}`);
    const withAuth = await fetch(probe, { headers: { Authorization: `Bearer ${row.modal_secret}` }, signal: AbortSignal.timeout(150_000) });
    // The status route answers 200 {"status":"unknown"} for a job id it has never seen (isolate_job.py status()).
    const authBody = (await withAuth.json().catch(() => ({}))) as { status?: string };
    check('request with the secret is accepted (200, unknown job)', withAuth.status === 200 && authBody.status === 'unknown', `HTTP ${withAuth.status} ${JSON.stringify(authBody)}`);

    // teardown
    const td = await manager.teardown(deploymentId, 'smoke_test');
    check('teardown reports stopped', td === 'stopped', td);
    await sleep(3000);
    const after = JSON.parse(await modal('app', 'list', '--json')) as Array<Record<string, string>>;
    const stillThere = after.find((a) => a['Description'] === row.app_name);
    check('Modal shows the app as no longer deployed', !stillThere || !String(stillThere['State']).startsWith('deployed'), stillThere ? stillThere['State'] : 'gone');
    const secrets = await modal('secret', 'list', '--json');
    check('per-user Modal Secret was deleted', !secrets.includes(row.secret_name));

    // Volume cleanup via the reaper (retention set to 0 for this run)
    const vols = await modal('volume', 'list', '--json');
    check('per-user Volume existed before cleanup', row.volume_names.every((v) => vols.includes(v)), row.volume_names.join(','));
    const r = await runReaperOnce(manager);
    check('reaper deleted the Volume', r.volumesDeleted === 1, JSON.stringify(r));
    const vols2 = await modal('volume', 'list', '--json');
    check('per-user Volume is gone from Modal', row.volume_names.every((v) => !vols2.includes(v)));
  } finally {
    if (deploymentId) await manager.teardown(deploymentId, 'smoke_cleanup').catch(() => undefined);
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exitCode = failed.length ? 1 : 0;
  }
}

main().catch((err) => {
  console.error('smoke test crashed:', err);
  process.exitCode = 1;
});
