// Run: npx tsx --test src/lib/monitoringGaps.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';

const sigP = import('./failureSignals.js');
const netP = import('./serverErrorNet.js');
const monP = import('./jobMonitor.js');
const jfsP = import('./jobFailureSignal.js');

type Call = { flow: string; msg: string; stack: string; ctx: Record<string, string> };
function recorder() {
  const calls: Call[] = [];
  const report = (flow: string, err: unknown, ctx: Record<string, string> = {}) => {
    const e = err as Error;
    calls.push({ flow, msg: e.message, stack: e.stack ?? '', ctx });
  };
  return { calls, report };
}

test('classifyFailure: provider-wide auth and credit errors get their own class', async () => {
  const { classifyFailure } = await jfsP;
  assert.equal(classifyFailure('Request failed with status code 401'), 'TTS_AUTH_REJECTED');
  assert.equal(classifyFailure('402 Payment Required'), 'TTS_CREDIT_EXHAUSTED');
  assert.equal(classifyFailure('quota_exceeded: insufficient credits'), 'TTS_CREDIT_EXHAUSTED');
  assert.equal(classifyFailure('timeout of 120000ms exceeded'), 'TTS_TIMEOUT'); // unchanged
  assert.equal(classifyFailure('status code 429'), 'TTS_RATE_LIMITED'); // unchanged
});

test('signals: message is only the class, stack blank, no free text in context', async () => {
  const s = await sigP;
  const r = recorder();
  s.signalMediaJobFailed('music', {}, r.report);
  s.signalStuckJobsReaped('sound_effect', 3, r.report);
  s.signalStuckJobsReaped('dub', 0, r.report); // nothing reaped: no signal
  s.signalProviderFailure('elevenlabs', 'CREDIT_EXHAUSTED', r.report);
  s.signalWebhookFailure('SIGNATURE_INVALID', {}, r.report);
  s.signalSttWorkerFailure('rate limited!', r.report);
  s.signalLoopFailure('usage_report', r.report);
  assert.deepEqual(r.calls.map(c => c.msg), [
    'MUSIC_JOB_FAILED', 'SOUND_EFFECT_JOB_STUCK', 'PROVIDER_ELEVENLABS_CREDIT_EXHAUSTED',
    'STRIPE_WEBHOOK_SIGNATURE_INVALID', 'STT_WORKER_RATE_LIMITED', 'LOOP_USAGE_REPORT_FAILED',
  ]);
  for (const c of r.calls) assert.equal(c.stack, '');
  assert.deepEqual(r.calls[1].ctx, { reaped: '3' });
});

test('classifyProviderStatus and signalProviderFailureFromStatus', async () => {
  const s = await sigP;
  assert.equal(s.classifyProviderStatus(401), 'AUTH_REJECTED');
  assert.equal(s.classifyProviderStatus(402), 'CREDIT_EXHAUSTED');
  assert.equal(s.classifyProviderStatus(503), 'UNAVAILABLE');
  assert.equal(s.classifyProviderStatus(undefined, 'ETIMEDOUT'), 'TIMEOUT');
  assert.equal(s.classifyProviderStatus(404), null);
  const r = recorder();
  s.signalProviderFailureFromStatus('tts_gateway', 404, undefined, r.report); // not provider-wide
  s.signalProviderFailureFromStatus('tts_gateway', 429, undefined, r.report); // per-user pressure, not an outage
  s.signalProviderFailureFromStatus('tts_gateway', 502, undefined, r.report);
  assert.deepEqual(r.calls.map(c => c.msg), ['PROVIDER_TTS_GATEWAY_UNAVAILABLE']);
});

test('signals never throw even if the reporter does', async () => {
  const s = await sigP;
  const boom = () => { throw new Error('x'); };
  assert.doesNotThrow(() => s.signalMediaJobFailed('stt', {}, boom));
  assert.doesNotThrow(() => s.signalConfigMissing(['A'], boom));
});

test('missingProdEnv lists names only, signalConfigMissing is silent when nothing is missing', async () => {
  const s = await sigP;
  assert.deepEqual(s.missingProdEnv({ STRIPE_SECRET_KEY: 'x' } as NodeJS.ProcessEnv, ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']), ['STRIPE_WEBHOOK_SECRET']);
  const r = recorder();
  s.signalConfigMissing([], r.report);
  assert.equal(r.calls.length, 0);
  s.signalConfigMissing(['STRIPE_WEBHOOK_SECRET'], r.report);
  assert.equal(r.calls[0].msg, 'CONFIG_MISSING');
  assert.equal(r.calls[0].ctx.missing, 'STRIPE_WEBHOOK_SECRET');
});

function fakeRes(status: number, locals: Record<string, unknown> = {}) {
  const res: any = new EventEmitter();
  res.statusCode = status; res.locals = locals;
  return res;
}
const req = (o: object = {}) => ({ method: 'POST', baseUrl: '/api/stt', route: { path: '/:id/x' }, originalUrl: '/api/stt/123e4567/x?token=secret', url: '/123/x', path: '/123/x', ...o }) as any;

test('serverErrorNet: reports an unreported 5xx once, with the route template (no ids, no query)', async () => {
  const { serverErrorNet } = await netP;
  const r = recorder();
  const res = fakeRes(502);
  let nexted = false;
  serverErrorNet(r.report)(req(), res, () => { nexted = true; });
  assert.ok(nexted);
  res.emit('finish'); res.emit('finish');
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].msg, 'HTTP_502');
  assert.deepEqual(r.calls[0].ctx, { route: 'POST /api/stt/:id/x', status: '502' });
  assert.equal(JSON.stringify(r.calls[0]).includes('secret'), false);
});

test('serverErrorNet: ignores 4xx, already-reported 5xx and health probes', async () => {
  const { serverErrorNet } = await netP;
  const r = recorder();
  for (const [status, locals, url] of [[404, {}, '/api/x'], [500, { failureReported: true }, '/api/x'], [503, {}, '/health/deep']] as const) {
    const res = fakeRes(status, { ...locals });
    serverErrorNet(r.report)(req({ originalUrl: url }), res, () => {});
    res.emit('finish');
  }
  assert.equal(r.calls.length, 0);
});

test('serverErrorNet: unmatched route and a throwing reporter are safe', async () => {
  const { serverErrorNet, routeLabel } = await netP;
  assert.equal(routeLabel({ method: 'GET', baseUrl: '', route: undefined, path: '/zzz' } as any), 'GET unmatched');
  const res = fakeRes(500);
  serverErrorNet(() => { throw new Error('x'); })(req(), res, () => {});
  assert.doesNotThrow(() => res.emit('finish'));
});

// ---- job monitor ----
type Row = { status: string; created_at: string };
function fakeMonitorDb(tables: Record<string, Row[]>, opts: { failAll?: boolean } = {}) {
  return {
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      const q: any = {
        select() { return q; },
        in(_c: string, v: string[]) { filters.push(r => v.includes(r.status)); return q; },
        gte(_c: string, v: string) { filters.push(r => r.created_at >= v); return q; },
        lt(_c: string, v: string) { filters.push(r => r.created_at < v); return q; },
        then(res: (v: unknown) => void) {
          if (opts.failAll) return res({ count: null, error: { message: 'down' } });
          res({ count: (tables[table] ?? []).filter(r => filters.every(f => f(r))).length, error: null });
        },
      };
      return q;
    },
  } as any;
}
const NOW = Date.parse('2026-10-30T12:00:00Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const src = [{ kind: 'MUSIC', table: 'music_jobs', okStatuses: ['ready'], pendingStatuses: ['queued', 'processing'] }];

test('jobMonitor: healthy table raises nothing', async () => {
  const { runJobMonitor } = await monP;
  const r = recorder();
  const rows = [30, 60, 90, 120].map(m => ({ status: 'ready', created_at: ago(m) }));
  const out = await runJobMonitor({ db: fakeMonitorDb({ music_jobs: rows }), now: () => NOW, report: r.report, sources: src });
  assert.deepEqual(out.alerts, []);
  assert.equal(r.calls.length, 0);
});

test('jobMonitor: jobs piling up with no runner (queued 35 min) raises STALLED', async () => {
  const { runJobMonitor } = await monP;
  const r = recorder();
  const rows = Array.from({ length: 8 }, () => ({ status: 'queued', created_at: ago(35) }));
  const out = await runJobMonitor({ db: fakeMonitorDb({ music_jobs: rows }), now: () => NOW, report: r.report, sources: src });
  assert.ok(out.alerts.includes('MUSIC_JOBS_STALLED'));
  const c = r.calls.find(x => x.msg === 'MUSIC_JOBS_STALLED')!;
  assert.equal(c.flow, 'job_monitor');
  assert.equal(c.ctx.stalled, '8');
  assert.equal(c.stack, '');
});

test('jobMonitor: 3 attempts in 3h and none ready raises NO_SUCCESS; fresh rows get a grace period', async () => {
  const { runJobMonitor } = await monP;
  const failed = [30, 60, 90].map(m => ({ status: 'failed', created_at: ago(m) }));
  let out = await runJobMonitor({ db: fakeMonitorDb({ music_jobs: failed }), now: () => NOW, report: () => {}, sources: src });
  assert.ok(out.alerts.includes('MUSIC_JOBS_NO_SUCCESS'));
  const fresh = [1, 2, 3].map(m => ({ status: 'processing', created_at: ago(m) }));
  out = await runJobMonitor({ db: fakeMonitorDb({ music_jobs: fresh }), now: () => NOW, report: () => {}, sources: src });
  assert.deepEqual(out.alerts, []);
});

test('jobMonitor: low daily completion ratio raises LOW_COMPLETION', async () => {
  const { runJobMonitor } = await monP;
  const rows = [
    ...Array.from({ length: 12 }, (_, i) => ({ status: 'failed', created_at: ago(600 + i) })),
    { status: 'ready', created_at: ago(700) },
  ];
  const out = await runJobMonitor({ db: fakeMonitorDb({ music_jobs: rows }), now: () => NOW, report: () => {}, sources: src });
  assert.deepEqual(out.alerts, ['MUSIC_JOBS_LOW_COMPLETION']);
});

test('jobMonitor: poll-driven tables never raise STALLED; unreadable tables raise JOB_MONITOR_BLIND once', async () => {
  const { runJobMonitor } = await monP;
  const pd = [{ ...src[0], pollDriven: true }];
  const rows = Array.from({ length: 5 }, () => ({ status: 'queued', created_at: ago(60) }));
  let out = await runJobMonitor({ db: fakeMonitorDb({ music_jobs: rows }), now: () => NOW, report: () => {}, sources: pd });
  assert.ok(!out.alerts.includes('MUSIC_JOBS_STALLED'));
  const r = recorder();
  out = await runJobMonitor({ db: fakeMonitorDb({}, { failAll: true }), now: () => NOW, report: r.report, sources: src });
  assert.deepEqual(out.alerts, ['JOB_MONITOR_BLIND']);
  assert.equal(r.calls.length, 1);
});
