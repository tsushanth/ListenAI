#!/usr/bin/env node
// READ-ONLY per-account request-log report. Issues GET requests only (Supabase Auth admin list + PostgREST selects);
// it never writes, and it needs no packages beyond Node 18+.
//
//   cd backend
//   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=... \
//     node scripts/request-log-report.mjs [days=60] [--json]
//
// For every account created in the last N days it prints: email, first call time, number of calls, success rate
// (outcome 'ok'), count by outcome, median ttfb_ms (rows that have one), and the last error codes seen.
// Accounts with no calls are listed too (calls 0): those are the ones that signed up and never made a request.
// Rows come from realtimetts_request_log (migration 037), owner resolved through realtimetts_api_keys.gateway_key_id.
// The same logic as SQL is in the PR description that introduced this script.

import { pathToFileURL } from 'node:url';

export const DEFAULT_DAYS = 60;
export const LAST_ERRORS = 5;

/** Parses the CLI args. Returns { days, json } or { error }. */
export function parseArgs(argv) {
  let days = DEFAULT_DAYS;
  let json = false;
  for (const a of argv) {
    if (a === '--json') json = true;
    else if (/^\d+$/.test(a) && Number(a) >= 1 && Number(a) <= 3650) days = Number(a);
    else return { error: `unrecognised argument "${a}" (usage: request-log-report.mjs [days] [--json])` };
  }
  return { days, json };
}

/** Median like Postgres percentile_cont(0.5): mean of the two middle values for an even count. null when empty. */
export function median(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * Pure report logic.
 *   users: [{ id, email, created_at }]            auth users (any age; filtered here)
 *   keys:  [{ user_id, gateway_key_id }]           realtimetts_api_keys
 *   rows:  [{ gateway_key_id, ts, outcome, ttfb_ms, error_code }]   realtimetts_request_log
 * Returns one entry per account created within `days` of `now`, newest account first.
 */
export function buildReport({ users, keys, rows, days = DEFAULT_DAYS, now = new Date() }) {
  const cutoff = now.getTime() - days * 86_400_000;
  const owner = new Map(keys.map((k) => [k.gateway_key_id, k.user_id]));
  const byUser = new Map();
  for (const r of rows) {
    const uid = owner.get(r.gateway_key_id);
    if (!uid) continue; // a key id that no longer maps to an account (deleted key) belongs to nobody
    if (!byUser.has(uid)) byUser.set(uid, []);
    byUser.get(uid).push(r);
  }
  const out = [];
  for (const u of users) {
    if (!(Date.parse(u.created_at) >= cutoff)) continue;
    const calls = (byUser.get(u.id) ?? []).slice().sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    const byOutcome = {};
    for (const c of calls) byOutcome[c.outcome] = (byOutcome[c.outcome] ?? 0) + 1;
    const ok = byOutcome.ok ?? 0;
    const lastErrors = [];
    for (let i = calls.length - 1; i >= 0 && lastErrors.length < LAST_ERRORS; i--) {
      const code = calls[i].error_code;
      if (code && !lastErrors.includes(code)) lastErrors.push(code); // distinct, most recent first
    }
    out.push({
      email: u.email ?? null,
      account_created_at: u.created_at,
      first_call_at: calls.length ? new Date(calls[0].ts).toISOString() : null,
      calls: calls.length,
      success_rate: calls.length ? ok / calls.length : null,
      by_outcome: byOutcome,
      median_ttfb_ms: median(calls.map((c) => c.ttfb_ms)),
      last_error_codes: lastErrors,
    });
  }
  out.sort((a, b) => Date.parse(b.account_created_at) - Date.parse(a.account_created_at));
  return out;
}

/** Plain-text rendering of buildReport output. */
export function formatReport(report, days) {
  if (report.length === 0) return `No accounts created in the last ${days} days.\n`;
  const lines = [`Accounts created in the last ${days} days: ${report.length}`, ''];
  for (const a of report) {
    const pct = a.success_rate === null ? 'n/a' : `${(a.success_rate * 100).toFixed(1)}%`;
    const outcomes = Object.entries(a.by_outcome).map(([k, v]) => `${k}=${v}`).join(' ') || '-';
    lines.push(
      `${a.email ?? '(no email)'}`,
      `  created ${a.account_created_at}  first call ${a.first_call_at ?? 'never'}`,
      `  calls ${a.calls}  success ${pct}  outcomes ${outcomes}`,
      `  median ttfb ${a.median_ttfb_ms === null ? 'n/a' : `${a.median_ttfb_ms} ms`}  last errors ${a.last_error_codes.join(', ') || '-'}`,
      '',
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// I/O: GET only.
// ---------------------------------------------------------------------------------------------------------------

function makeGet(baseUrl, serviceKey, fetchImpl = fetch) {
  const base = baseUrl.replace(/\/+$/, '');
  return async function get(path, extraHeaders = {}) {
    const res = await fetchImpl(`${base}${path}`, {
      method: 'GET',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, ...extraHeaders },
    });
    if (!res.ok) throw new Error(`GET ${path.split('?')[0]} failed: HTTP ${res.status}`);
    return res.json();
  };
}

/** Pages through a PostgREST select with Range headers (1000 rows per page). */
async function selectAll(get, pathAndQuery, pageSize = 1000) {
  const all = [];
  for (let from = 0; ; from += pageSize) {
    const page = await get(pathAndQuery, { Range: `${from}-${from + pageSize - 1}`, 'Range-Unit': 'items' });
    all.push(...page);
    if (page.length < pageSize) return all;
  }
}

/** Fetches the three inputs for buildReport using GET requests only. */
export async function fetchInputs({ get, days, now = new Date() }) {
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  const users = [];
  for (let page = 1; ; page++) {
    const r = await get(`/auth/v1/admin/users?page=${page}&per_page=1000`);
    const batch = r.users ?? [];
    for (const u of batch) if (Date.parse(u.created_at) >= Date.parse(cutoff)) users.push({ id: u.id, email: u.email, created_at: u.created_at });
    if (batch.length < 1000) break;
  }
  if (users.length === 0) return { users, keys: [], rows: [] };
  const ids = users.map((u) => u.id);
  const keys = [];
  for (let i = 0; i < ids.length; i += 50) {
    const slice = ids.slice(i, i + 50).join(',');
    keys.push(...(await selectAll(get, `/rest/v1/realtimetts_api_keys?select=user_id,gateway_key_id&user_id=in.(${slice})`)));
  }
  const rows = [];
  for (let i = 0; i < keys.length; i += 25) {
    const slice = keys.slice(i, i + 25).map((k) => `"${String(k.gateway_key_id).replace(/["\\]/g, '')}"`).join(',');
    rows.push(...(await selectAll(
      get,
      `/rest/v1/realtimetts_request_log?select=gateway_key_id,ts,outcome,ttfb_ms,error_code&gateway_key_id=in.(${encodeURIComponent(slice)})&order=ts.asc`,
    )));
  }
  return { users, keys, rows };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if ('error' in args) { console.error(args.error); process.exit(2); }
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (see header of this script)'); process.exit(2); }
  const get = makeGet(url, key);
  const now = new Date();
  const { users, keys, rows } = await fetchInputs({ get, days: args.days, now });
  const report = buildReport({ users, keys, rows, days: args.days, now });
  process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report, args.days));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
}
