/**
 * Sweeps stale per-user voice-convert / voice-isolate resources (S6 report: 8 orphan secrets/volumes from 2026-09-29).
 *
 *   npx tsx scripts/cleanup-stale-voice-deployments.ts            # DRY RUN (default): prints the plan, changes nothing
 *   npx tsx scripts/cleanup-stale-voice-deployments.ts --apply --confirm=<N>
 *                                                                  # executes; N must equal the number of planned actions
 *
 * Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (reads/deletes deployment rows) and a logged-in `modal` CLI
 * (MODAL_TOKEN_ID/SECRET or `modal token`). Only resources matching the exact per-user naming pattern are touched
 * (see src/lib/perUserDeploy.ts); shared apps/secrets/volumes can never match. A live (ready / freshly deploying)
 * row protects its app, secret and volume. Review the dry-run output with the owner before --apply: deleting a
 * volume deletes any job audio left on it, and secret/volume deletes are not reversible.
 */
import { execFileSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { planCleanup, parseModalNames, type CleanupAction, type DeploymentRow, type Feature } from '../src/lib/perUserDeploy.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const confirm = args.find((a) => a.startsWith('--confirm='))?.split('=')[1];
const minAgeHours = Number(args.find((a) => a.startsWith('--min-age-hours='))?.split('=')[1] ?? 24);

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.'); process.exit(2); }
const supabase = createClient(url, key, { auth: { persistSession: false } });

const modal = (...a: string[]) => execFileSync('modal', a, { encoding: 'utf8', timeout: 60_000 });

async function loadRows(): Promise<DeploymentRow[]> {
  const rows: DeploymentRow[] = [];
  for (const feature of ['convert', 'isolate'] as Feature[]) {
    const { data, error } = await supabase.from(`user_voice_${feature}_deployments`).select('user_id, app_name, status, job_count, updated_at');
    if (error) throw new Error(`reading user_voice_${feature}_deployments: ${error.message}`);
    for (const r of data ?? []) rows.push({ feature, ...(r as Omit<DeploymentRow, 'feature'>) });
  }
  return rows;
}

function describe(a: CleanupAction): string {
  switch (a.kind) {
    case 'modal_app_stop': return `modal app stop ${a.name}   (${a.why})`;
    case 'modal_secret_delete': return `modal secret delete ${a.name} --yes   (${a.why})`;
    case 'modal_volume_delete': return `modal volume delete ${a.name} --yes   (${a.why})`;
    case 'db_row_delete': return `DELETE FROM user_voice_${a.feature}_deployments WHERE user_id='${a.user_id}'   (${a.why})`;
  }
}

async function run(a: CleanupAction): Promise<void> {
  switch (a.kind) {
    case 'modal_app_stop': modal('app', 'stop', a.name); break;
    case 'modal_secret_delete': modal('secret', 'delete', a.name, '--yes'); break;
    case 'modal_volume_delete': modal('volume', 'delete', a.name, '--yes'); break;
    case 'db_row_delete': {
      const { error } = await supabase.from(`user_voice_${a.feature}_deployments`).delete().eq('user_id', a.user_id);
      if (error) throw new Error(error.message);
      break;
    }
  }
}

async function main(): Promise<void> {
  const rows = await loadRows();
  const inventory = {
    apps: parseModalNames(modal('app', 'list', '--json'), 'app'),
    secrets: parseModalNames(modal('secret', 'list', '--json'), 'secret'),
    volumes: parseModalNames(modal('volume', 'list', '--json'), 'volume'),
  };
  const plan = planCleanup({ rows, modal: inventory, minAgeMs: minAgeHours * 3600_000 });

  console.log(`${rows.length} deployment rows, ${inventory.apps.length} apps, ${inventory.secrets.length} secrets, ${inventory.volumes.length} volumes inspected.`);
  console.log(plan.length ? `Planned actions (${plan.length}):` : 'Nothing to clean up.');
  for (const a of plan) console.log('  ' + describe(a));

  if (!apply) { console.log('\nDRY RUN: nothing changed. Re-run with --apply --confirm=' + plan.length + ' after review.'); process.exit(0); }
  if (confirm !== String(plan.length)) { console.error(`\nRefusing: --confirm must equal the planned action count (${plan.length}).`); process.exit(3); }
  let failed = 0;
  for (const a of plan) {
    try { await run(a); console.log('done:   ' + describe(a)); } catch (e) { failed++; console.error('FAILED: ' + describe(a) + ' -> ' + (e as Error).message); }
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
