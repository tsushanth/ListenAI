import test from 'node:test';
import assert from 'node:assert/strict';
const modP = import('./adminHealth.js');
const NOW = new Date('2026-10-08T12:00:00Z');

test('parseProbeTargets reads ADMIN_HEALTH_TARGETS JSON and ignores junk', async () => {
  const { parseProbeTargets } = await modP;
  assert.deepEqual(parseProbeTargets({ ADMIN_HEALTH_TARGETS: '{"gateway":"https://g.example.test/health"}' } as any), [{ name: 'gateway', url: 'https://g.example.test/health' }]);
  assert.deepEqual(parseProbeTargets({ ADMIN_HEALTH_TARGETS: 'not json' } as any), []);
  assert.deepEqual(parseProbeTargets({ ADMIN_HEALTH_TARGETS: '{"x":5}' } as any), []);
});

test('parseProbeTargets falls back to the gateway health URL when only TTS_GATEWAY_URL is set', async () => {
  const { parseProbeTargets } = await modP;
  assert.deepEqual(parseProbeTargets({ TTS_GATEWAY_URL: 'https://g.example.test' } as any), [{ name: 'gateway', url: 'https://g.example.test/health' }]);
});

const resp = (status: number) => async () => new Response('{}', { status });

test('probeTarget: 2xx fast = up; 2xx slow = slow; non-2xx and errors = down', async () => {
  const { probeTarget } = await modP;
  let t = 0;
  const clock = () => (t += 100);
  assert.equal((await probeTarget({ name: 'a', url: 'https://x' }, resp(200) as any, clock)).status, 'up');
  let t2 = 0;
  const slow = () => (t2 += 2000);
  assert.equal((await probeTarget({ name: 'a', url: 'https://x' }, resp(200) as any, slow)).status, 'slow');
  assert.equal((await probeTarget({ name: 'a', url: 'https://x' }, resp(503) as any, clock)).status, 'down');
  const boom = async () => { throw new Error('ECONNREFUSED'); };
  const d = await probeTarget({ name: 'a', url: 'https://x' }, boom as any, clock);
  assert.equal(d.status, 'down'); assert.match(d.detail ?? '', /ECONNREFUSED/);
});

test('passiveHealth never probes: kokoro from usage freshness, stt from recent requests', async () => {
  const { passiveHealth } = await modP;
  const fresh = [{ day: '2026-10-08', user_id: 'u', chars: 1, piper_chars: 0, audio_seconds: 0, free_chars: 0, updated_at: '2026-10-08T11:58:00Z' }];
  const stale = [{ ...fresh[0]!, updated_at: '2026-10-08T09:00:00Z' }];
  assert.equal(passiveHealth({ usage: fresh, stt: [], now: NOW }).find((h) => h.name === 'kokoro')!.status, 'up');
  assert.equal(passiveHealth({ usage: stale, stt: [], now: NOW }).find((h) => h.name === 'kokoro')!.status, 'asleep');
  assert.equal(passiveHealth({ usage: [], stt: [], now: NOW }).find((h) => h.name === 'kokoro')!.status, 'unknown');
  const failed = ['11:50', '11:51', '11:52'].map((m) => ({ user_id: 'u', status: 'failed', created_at: `2026-10-08T${m}:00Z` }));
  assert.equal(passiveHealth({ usage: [], stt: failed, now: NOW }).find((h) => h.name === 'stt')!.status, 'down');
  assert.equal(passiveHealth({ usage: [], stt: [{ user_id: 'u', status: 'done', created_at: '2026-10-08T11:59:00Z' }], now: NOW }).find((h) => h.name === 'stt')!.status, 'up');
});

test('collectHealth merges probes and passive items, and one failing probe is only that item', async () => {
  const { collectHealth } = await modP;
  const f = async (url: any) => { if (String(url).includes('bad')) throw new Error('nope'); return new Response('{}', { status: 200 }); };
  process.env.ADMIN_HEALTH_TARGETS = '{"good":"https://good.example.test","bad":"https://bad.example.test"}';
  try {
    const items = await collectHealth({ usage: [], stt: [], now: NOW }, f as any);
    const by = Object.fromEntries(items.map((h) => [h.name, h.status]));
    assert.equal(by.good, 'up'); assert.equal(by.bad, 'down'); assert.ok('kokoro' in by && 'stt' in by);
  } finally { delete process.env.ADMIN_HEALTH_TARGETS; }
});
