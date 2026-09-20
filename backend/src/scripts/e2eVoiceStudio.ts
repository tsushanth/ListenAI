// End-to-end check of the voice studio backend router against a REAL intake deployment (no Supabase, no
// gateway: auth and key backfill are stubbed). Never prints secrets.
//   INTAKE_URL=... INTAKE_SECRET=... PIPER_ADMIN_URL=... PIPER_ADMIN_TOKEN=... ZIP=/path/good.zip \
//   [EXPECT=ready|rejected:<code>] npx tsx src/scripts/e2eVoiceStudio.ts
import express from 'express';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import { createVoiceStudioRouter, CONSENT_TEXT_VERSION } from '../routes/voiceStudioRouter.js';
import { createIntakeClient } from '../lib/voiceIntakeClient.js';

const env = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`${k} not set`); return v; };
const intake = createIntakeClient(env('INTAKE_URL'), env('INTAKE_SECRET'));
const app = express();
app.use('/api/voice-studio', createVoiceStudioRouter({
  authenticate: async (req) => (req.headers.authorization ?? '').replace('Bearer ', '') || null,
  intake, enabledUsers: () => '*', maxVoicesPerUser: 3, maxZipBytes: 300 * 1048576,
  backfillKeyOwners: async () => undefined, log: console,
}));
const srv = app.listen(0);
const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/voice-studio`;
const A = 'e2e-user-a', B = 'e2e-user-b';
const call = (u: string, m: string, p: string, body?: unknown, raw?: Uint8Array) =>
  fetch(base + p, { method: m, headers: { Authorization: `Bearer ${u}`, ...(raw ? { 'Content-Type': 'application/octet-stream' } : body ? { 'Content-Type': 'application/json' } : {}) }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
const piper = async () => (await (await fetch(`${env('PIPER_ADMIN_URL')}/admin/voices`, { headers: { Authorization: `Bearer ${env('PIPER_ADMIN_TOKEN')}` } })).json()) as { voices: string[] };
const ok = (name: string, c: boolean, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${name} ${x}`); if (!c) process.exitCode = 1; };
const t0 = Date.now(); const el = () => `${Math.round((Date.now() - t0) / 1000)}s`;

const expect = process.env.EXPECT ?? 'ready';
let id = '';
try {
  const c = await call(A, 'POST', '/', { speaker_name: 'E2E Test Speaker', attested_by: 'E2E Test', consent: true, consent_text_version: CONSENT_TEXT_VERSION });
  id = ((await c.json()) as { id: string }).id; ok('create voice', c.status === 201 && /^v-/.test(id), id);
  ok('other user cannot see it', (await call(B, 'GET', `/${id}`)).status === 404);
  ok('list shows it to owner only', ((await (await call(A, 'GET', '/')).json()) as { voices: unknown[] }).voices.length === 1 && ((await (await call(B, 'GET', '/')).json()) as { voices: unknown[] }).voices.length === 0);
  const zip = fs.readFileSync(env('ZIP')); const P = 8 * 1048576; const n = Math.ceil(zip.length / P);
  let t = Date.now();
  for (let i = 0; i < n; i++) { const r = await call(A, 'PUT', `/${id}/dataset/parts/${i}`, undefined, zip.subarray(i * P, (i + 1) * P)); if (r.status !== 200) throw new Error(`part ${i}: ${r.status} ${await r.text()}`); }
  ok(`uploaded ${n} parts (${(zip.length / 1048576).toFixed(1)} MB) in ${Math.round((Date.now() - t) / 1000)}s`, true);
  ok('other user cannot commit', (await call(B, 'POST', `/${id}/dataset/commit`, { parts: n })).status === 404);
  t = Date.now(); const cm = await call(A, 'POST', `/${id}/dataset/commit`, { parts: n });
  ok(`commit ${Math.round((Date.now() - t) / 1000)}s`, cm.status === 202, JSON.stringify(await cm.json()));
  let st = ''; let v: any;
  for (let i = 0; i < 180; i++) { v = await (await call(A, 'GET', `/${id}`)).json(); if (v.status !== st) { st = v.status; console.log(`[${el()}] status ${st}`); } if (v.status === 'ready' || v.status === 'rejected') break; await new Promise((r) => setTimeout(r, 20000)); }
  console.log('result', JSON.stringify({ status: v.status, stats: v.stats, warnings: v.warnings?.map((w: any) => w.code ?? w), error: v.error }));
  if (expect.startsWith('rejected')) ok(`rejected with ${expect.split(':')[1]}`, v.status === 'rejected' && v.error?.code === expect.split(':')[1]);
  else {
    ok('trained (ready)', v.status === 'ready');
    for (let i = 0; i < 5; i++) { const r = await call(A, 'GET', `/${id}/samples/${i}`); const b = Buffer.from(await r.arrayBuffer()); ok(`sample ${i} is wav`, r.status === 200 && b.subarray(0, 4).toString() === 'RIFF', `${b.length} bytes`); }
    const pv = await call(A, 'POST', `/${id}/preview`, { text: 'Testing the custom voice preview.' }); const pb = Buffer.from(await pv.arrayBuffer());
    ok('custom preview', pv.status === 200 && pb.subarray(0, 4).toString() === 'RIFF', `${pb.length} bytes`);
    ok('other user cannot preview/deploy', (await call(B, 'POST', `/${id}/preview`, { text: 'x' })).status === 404 && (await call(B, 'POST', `/${id}/deploy`)).status === 404);
    const d = await call(A, 'POST', `/${id}/deploy`); const dj = (await d.json()) as { voice?: string };
    ok('deploy', d.status === 200 && dj.voice === `custom:${id}`, dj.voice);
    ok('voice present in Piper registry', (await piper()).voices.includes(id));
  }
} finally {
  if (id) {
    const r = await call(A, 'DELETE', `/${id}`); ok('delete', r.status === 200);
    ok('gone from status', (await call(A, 'GET', `/${id}`)).status === 404);
    ok('gone from Piper registry', !(await piper()).voices.includes(id));
    ok('owner list empty', ((await (await call(A, 'GET', '/')).json()) as { voices: unknown[] }).voices.length === 0);
  }
  srv.close();
}
