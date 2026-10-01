// Manual smoke test of the self-serve deployment lifecycle against REAL Modal. Not part of `npm test`.
//
//   npx tsx scripts/modal-deploy-smoke.ts [isolate|sound_effect|music|dub]     (default: isolate)
//
// Uses your logged-in Modal profile (or MODAL_TOKEN_ID/SECRET) and an in-memory store, so it never touches the
// database. It deploys one real per-user app for a throwaway user, checks that the app is deployed and that its
// per-user secret actually protects it, tears it down, and checks that the app, Secret and Volume are really gone.
//   isolate       CPU only. A few cents.
//   sound_effect  also runs one real 1-second GPU generation (A10G, model cold start): roughly 10-15 cents.
//   music         also runs one real 15-second GPU generation (A10G, finetuned model + LoRA): roughly 15-25 cents.
//   dub           also transcribes 2 seconds of audio on an L4 (speech-to-text worker, model baked into the image): a few cents.
// Everything is cleaned up in a finally block even if a check fails.
import '../src/lib/modalDeploymentsTestEnv.js'; // dummy Supabase env so config loads; the store here is in memory
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DeploymentManager, SERVICE_SPECS, isDeploymentService, type DeploymentService } from '../src/lib/modalDeployments.js';
import { createModalCli } from '../src/lib/modalCli.js';
import { runReaperOnce } from '../src/lib/deploymentReaper.js';
import { mintDubSessionToken } from '../src/lib/dubSessionToken.js';
import { MemoryStore, TEST_LIMITS, type FakeClock } from '../src/lib/modalDeploymentsTestKit.js';

const run = promisify(execFile);
const arg = process.argv[2] ?? 'isolate';
if (!isDeploymentService(arg) || !SERVICE_SPECS[arg].available) {
  console.error(`unknown or unavailable service "${arg}". Use isolate, sound_effect, music or dub.`);
  process.exit(2);
}
const SERVICE: DeploymentService = arg;
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
    const out = await manager.deploy(USER, SERVICE);
    check('deploy accepted', out.kind === 'accepted', out.kind);
    if (out.kind !== 'accepted') return;
    deploymentId = out.deployment.id;
    console.log(`      app ${out.deployment.app_name}\n      url ${out.deployment.modal_url}`);

    // wait for ready
    let status = 'requested';
    for (let i = 0; i < 180 && status !== 'ready' && status !== 'failed'; i++) {
      await sleep(5000);
      status = (await manager.getForUser(USER, SERVICE))?.status ?? 'missing';
    }
    const row = (await store.getById(deploymentId))!;
    check('deployment reached ready', status === 'ready', `${status} after ${Math.round((Date.now() - t0) / 1000)}s${row.error ? `, error: ${row.error}` : ''}`);
    if (status !== 'ready') return;

    // Modal agrees the app is deployed
    const apps = JSON.parse(await modal('app', 'list', '--json')) as Array<Record<string, string>>;
    const mine = apps.find((a) => a['Description'] === row.app_name);
    check('Modal lists the app as deployed', !!mine && String(mine['State']).startsWith('deployed'), mine ? mine['State'] : 'not found');

    // The per-user secret really protects the endpoint (the first request cold-starts a container: allow time)
    if (SERVICE === 'isolate') {
      const probe = `${row.modal_url}/isolate/does-not-exist`;
      const noAuth = await fetch(probe, { signal: AbortSignal.timeout(150_000) });
      check('request without the secret is rejected (401)', noAuth.status === 401, `HTTP ${noAuth.status}`);
      const withAuth = await fetch(probe, { headers: { Authorization: `Bearer ${row.modal_secret}` }, signal: AbortSignal.timeout(150_000) });
      // The status route answers 200 {"status":"unknown"} for a job id it has never seen (isolate_job.py status()).
      const authBody = (await withAuth.json().catch(() => ({}))) as { status?: string };
      check('request with the secret is accepted (200, unknown job)', withAuth.status === 200 && authBody.status === 'unknown', `HTTP ${withAuth.status} ${JSON.stringify(authBody)}`);
    } else if (SERVICE === 'dub') {
      // The STT worker authenticates with an HMAC session token the backend mints with the deployment's own secret.
      // The first request starts an L4 container (the model is baked into the image).
      const health = await fetch(`${row.modal_url}/health`, { signal: AbortSignal.timeout(300_000) });
      const hb = (await health.json().catch(() => ({}))) as { status?: string };
      check('worker answers /health (endpoint URL is right)', health.status === 200 && hb.status === 'healthy', `HTTP ${health.status} ${JSON.stringify(hb)}`);
      // 2 seconds of 16 kHz 16-bit mono silence as a WAV.
      const pcm = Buffer.alloc(16000 * 2 * 2);
      const header = Buffer.alloc(44);
      header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
      header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
      header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
      header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
      const wav = Buffer.concat([header, pcm]);
      const stt = (auth: string | null) =>
        fetch(`${row.modal_url}/v1/stt?language=en`, {
          method: 'POST',
          headers: { 'Content-Type': 'audio/wav', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
          body: new Uint8Array(wav),
          signal: AbortSignal.timeout(300_000),
        });
      const noAuth = await stt(null);
      check('transcribe without a token is rejected (401)', noAuth.status === 401, `HTTP ${noAuth.status}`);
      const wrong = await stt(mintDubSessionToken('some-other-deployments-secret', 'smoke'));
      check('a token signed with another deployment\'s secret is rejected (401)', wrong.status === 401, `HTTP ${wrong.status}`);
      const ok = await stt(mintDubSessionToken(row.modal_secret, 'dub:smoke:1'));
      const body = (await ok.json().catch(() => ({}))) as { segments?: unknown[]; gpu_seconds?: number; duration?: number };
      check('transcribe with the deployment\'s own token succeeds', ok.status === 200 && Array.isArray(body.segments), `HTTP ${ok.status}, duration ${body.duration}`);
      check('worker reports measured gpu_seconds in the response', typeof body.gpu_seconds === 'number' && body.gpu_seconds >= 0, `gpu_seconds=${body.gpu_seconds}`);
    } else {
      // sound_effect / music: the first request starts an A10G container and loads the model from the shared read-only Volume.
      const gen = (headers: Record<string, string>) =>
        fetch(`${row.modal_url}/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify(
            SERVICE === 'music'
              ? { prompt: 'calm ambient piano loop', duration_sec: 15 } // music's minimum
              : { prompt: 'a single short glass tap', duration_sec: 1 },
          ),
          signal: AbortSignal.timeout(600_000),
        });
      const noAuth = await gen({});
      check('generate without the secret is rejected (401)', noAuth.status === 401, `HTTP ${noAuth.status}`);
      const t1 = Date.now();
      const ok = await gen({ Authorization: `Bearer ${row.modal_secret}` });
      const bytes = Buffer.from(await ok.arrayBuffer());
      const gpu = ok.headers.get('x-gpu-seconds');
      check('generate with the secret returns WAV audio', ok.status === 200 && bytes.subarray(0, 4).toString() === 'RIFF', `HTTP ${ok.status}, ${bytes.length} bytes, ${Math.round((Date.now() - t1) / 1000)}s incl. cold start`);
      check('worker reports measured GPU seconds in X-GPU-Seconds', gpu !== null && Number.isFinite(Number(gpu)) && Number(gpu) > 0, `header=${gpu}`);
    }

    // teardown
    const td = await manager.teardown(deploymentId, 'smoke_test');
    check('teardown reports stopped', td === 'stopped', td);
    await sleep(3000);
    const after = JSON.parse(await modal('app', 'list', '--json')) as Array<Record<string, string>>;
    const stillThere = after.find((a) => a['Description'] === row.app_name);
    check('Modal shows the app as no longer deployed', !stillThere || !String(stillThere['State']).startsWith('deployed'), stillThere ? stillThere['State'] : 'gone');
    const secrets = await modal('secret', 'list', '--json');
    check('per-user Modal Secret was deleted', !secrets.includes(row.secret_name));

    // Volume cleanup via the reaper (retention set to 0 for this run). Services with no per-user Volume skip this.
    if (row.volume_names.length) {
      const vols = await modal('volume', 'list', '--json');
      check('per-user Volume existed before cleanup', row.volume_names.every((v) => vols.includes(v)), row.volume_names.join(','));
      const r = await runReaperOnce(manager);
      check('reaper deleted the Volume', r.volumesDeleted === 1, JSON.stringify(r));
      const vols2 = await modal('volume', 'list', '--json');
      check('per-user Volume is gone from Modal', row.volume_names.every((v) => !vols2.includes(v)));
    } else {
      check('service has no per-user Volume to clean up', true);
    }
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
