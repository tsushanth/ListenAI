// npm test (node:test via tsx). The developers page "run it now" call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirstCall, FIRST_CALL_BODY, FIRST_CALL_TEXT, type FirstCallRecord } from './firstApiCall.js';
import { publicLeakTerm } from './publicText.js';

const KEY = 'rtts_abcdefgh12345678';
function make(opts: { free?: boolean; respond?: () => Response | Promise<Response>; recordFails?: boolean } = {}) {
  const records: FirstCallRecord[] = [];
  const sent: Array<{ url: string; init: RequestInit }> = [];
  const call = createFirstCall({
    isFree: async () => opts.free ?? true,
    record: async (r) => { if (opts.recordFails) throw new Error('down'); records.push(r); },
    fetchImpl: (async (url: string, init: RequestInit) => { sent.push({ url, init }); return opts.respond ? opts.respond() : new Response(new Uint8Array([1, 2, 3]), { status: 200 }); }) as unknown as typeof fetch,
    now: () => 1_000_000,
  }, () => 'https://gateway.test');
  return { call, records, sent };
}

test('one fixed, tiny call with the given key; the step is recorded without the key', async () => {
  const { call, records, sent } = make();
  const r = await call('user-1', KEY);
  assert.equal(r.http, 200);
  assert.ok(r.http === 200 && r.body.ok && r.body.audio_base64 === Buffer.from([1, 2, 3]).toString('base64'));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://gateway.test/v1/audio/speech');
  assert.equal((sent[0].init.headers as Record<string, string>).authorization, `Bearer ${KEY}`);
  assert.deepEqual(JSON.parse(String(sent[0].init.body)), FIRST_CALL_BODY);
  assert.ok(FIRST_CALL_TEXT.length < 50);
  assert.deepEqual(records, [{ user_id: 'user-1', ok: true, status: 200 }]);
  assert.ok(!JSON.stringify(records).includes(KEY));
});

test('without free credits nothing is called, and that step is recorded', async () => {
  const { call, records, sent } = make({ free: false });
  const r = await call('user-1', KEY);
  assert.equal(r.http, 409);
  assert.equal(sent.length, 0);
  assert.deepEqual(records, [{ user_id: 'user-1', ok: false, status: 409 }]);
});

test('a refused or unanswered call reports the status and a fixed message, never the service body', async () => {
  for (const [respond, status] of [
    [() => new Response('secret internal detail', { status: 500 }), 500],
    [() => new Response('{}', { status: 401 }), 401],
    [() => Promise.reject(new Error('timeout')), 0],
  ] as Array<[() => Response | Promise<Response>, number]>) {
    const { call, records } = make({ respond });
    const r = await call('user-1', KEY);
    assert.ok(r.http === 200 && !r.body.ok);
    assert.equal(r.body.status, status);
    assert.ok(!JSON.stringify(r.body).includes('secret internal detail'));
    assert.equal(publicLeakTerm(r.body.message), null);
    assert.deepEqual(records, [{ user_id: 'user-1', ok: false, status }]);
  }
});

test('bad keys are refused before anything happens; five tries per ten minutes', async () => {
  const { call, sent, records } = make();
  for (const k of [undefined, 42, '', 'sk-other', 'rtts_short', `rtts_${'a'.repeat(300)}`, 'rtts_abc defgh123']) {
    assert.equal((await call('user-2', k)).http, 400);
  }
  assert.equal(sent.length + records.length, 0);
  for (let i = 0; i < 5; i++) assert.equal((await call('user-3', KEY)).http, 200);
  assert.equal((await call('user-3', KEY)).http, 429);
  assert.equal(sent.length, 5);
});

test('a record that cannot be written does not break the call', async () => {
  const { call } = make({ recordFails: true });
  const r = await call('user-1', KEY);
  assert.ok(r.http === 200 && r.body.ok);
});
