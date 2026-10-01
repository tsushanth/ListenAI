// Compare what we MEASURED (modal_usage_events, shadow mode) with what Modal actually BILLED for the per-user apps,
// per service. This is the evidence for deciding how to price Modal resources: the ratio shows how much real cost
// (cold starts, idle scale-down, image/volume overhead) sits on top of the GPU-seconds the workers report.
//
//   npx tsx scripts/modal-usage-reconcile.ts [--days 7] [--modal-only]
//
// Needs your Modal login (or MODAL_TOKEN_ID/SECRET). Without --modal-only it also needs SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY (read-only queries on modal_usage_events). Prints a table; changes nothing.
import '../src/lib/modalDeploymentsTestEnv.js'; // fills only UNSET Supabase vars so the config loads; real ones win
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SERVICE_SPECS, type DeploymentService } from '../src/lib/modalDeployments.js';

const run = promisify(execFile);
const args = process.argv.slice(2);
const daysIdx = args.indexOf('--days');
const days = daysIdx >= 0 ? Math.max(1, Number(args[daysIdx + 1]) || 7) : 7;
const modalOnly = args.includes('--modal-only');

interface BillingRow { Description: string; 'Interval Start': string; Cost: string }

const day = (d: Date) => d.toISOString().slice(0, 10);

/** Which service a per-user app belongs to, from its name: <appPrefix>-user-<8 hex>-<4 hex>. */
export function serviceForApp(appName: string): DeploymentService | null {
  for (const spec of Object.values(SERVICE_SPECS)) {
    if (new RegExp(`^${spec.appPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-user-[0-9a-f]{8}-[0-9a-f]{4}$`).test(appName)) return spec.service;
  }
  return null;
}

async function modalCostByService(start: string, end: string): Promise<Map<DeploymentService, { cost: number; apps: Set<string> }>> {
  const { stdout } = await run('modal', ['billing', 'report', '--start', start, '--end', end, '--resolution', 'd', '--json'], { maxBuffer: 32 * 1024 * 1024 });
  const rows = JSON.parse(stdout || '[]') as BillingRow[];
  const out = new Map<DeploymentService, { cost: number; apps: Set<string> }>();
  for (const r of rows) {
    const svc = serviceForApp(r.Description);
    if (!svc) continue; // standing apps and experiments are not per-user deployments
    const e = out.get(svc) ?? { cost: 0, apps: new Set<string>() };
    e.cost += Number(r.Cost) || 0;
    e.apps.add(r.Description);
    out.set(svc, e);
  }
  return out;
}

async function recordedByService(sinceIso: string): Promise<Map<DeploymentService, { events: number; seconds: number }>> {
  const { supabase } = await import('../src/lib/supabaseClient.js');
  const out = new Map<DeploymentService, { events: number; seconds: number }>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('modal_usage_events').select('service, gpu_seconds').gte('recorded_at', sinceIso).range(from, from + 999);
    if (error) throw new Error(`modal_usage_events: ${error.message}`);
    for (const r of data ?? []) {
      const svc = r.service as DeploymentService;
      const e = out.get(svc) ?? { events: 0, seconds: 0 };
      e.events++;
      e.seconds += Number(r.gpu_seconds) || 0;
      out.set(svc, e);
    }
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function main() {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() + 1); // the report's end date is exclusive: include today
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days - 1);
  console.log(`Window: ${day(start)} to ${day(end)} (exclusive), per-user apps only\n`);

  const billed = await modalCostByService(day(start), day(end));
  const recorded = modalOnly ? null : await recordedByService(start.toISOString());

  const rows = Object.keys(SERVICE_SPECS).map((svc) => {
    const b = billed.get(svc as DeploymentService);
    const r = recorded?.get(svc as DeploymentService);
    return {
      service: svc,
      'per-user apps': b ? b.apps.size : 0,
      'Modal billed ($)': b ? Number(b.cost.toFixed(4)) : 0,
      'recorded jobs': r ? r.events : modalOnly ? 'n/a' : 0,
      'recorded GPU-s': r ? Number(r.seconds.toFixed(1)) : modalOnly ? 'n/a' : 0,
      'billed $ per recorded GPU-s': r && r.seconds > 0 && b ? Number((b.cost / r.seconds).toFixed(6)) : 'n/a',
    };
  });
  console.table(rows);
  if (modalOnly) console.log('\n--modal-only: recorded usage not read.');
  else console.log('\nA ratio well above the GPU list rate means idle scale-down, cold starts and overhead are costing more than the measured GPU time.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
