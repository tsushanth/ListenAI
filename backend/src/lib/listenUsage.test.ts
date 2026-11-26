// npm test (node:test via tsx). Daily Android listening totals: counting, storing, posting.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { ListenUsage, countListening, listenOutcome, pushListenTotals, type ListenDeps, type ListenRow } from './listenUsage.js';

const DAY = Date.UTC(2026, 10, 26, 12);
const quiet = () => {};

test('outcomes: granted, refused (quota, rate limit, breaker), failed', () => {
  assert.equal(listenOutcome(200), 'ok');
  for (const s of [400, 402, 429, 503]) assert.equal(listenOutcome(s), 'refused');
  for (const s of [500, 502]) assert.equal(listenOutcome(s), 'failed');
});

test('counts are grouped per day and hashed install; a request without an id shares one row', async () => {
  const u = new ListenUsage(() => DAY);
  u.record('ok', 'id:aaaa'); u.record('ok', 'id:aaaa'); u.record('ok', 'id:bbbb');
  u.record('ok', 'ip:cccc'); u.record('ok', null);
  u.record('refused', 'id:aaaa'); u.record('failed', null);
  const stored: ListenRow[] = [];
  assert.equal(await u.flush({ add: async (r) => { stored.push(...r); } }), true);
  const by = Object.fromEntries(stored.map((r) => [r.bucket, [r.ok, r.refused, r.failed]]));
  assert.deepEqual(by, { 'id:aaaa': [2, 0, 0], 'id:bbbb': [1, 0, 0], anon: [2, 0, 0], '-': [0, 1, 1] });
  assert.ok(!JSON.stringify(stored).includes('ip:'), 'no address bucket is stored');
  assert.equal(u.size(), 0);
});

test('a failed write keeps the counts and adds them to the next one', async () => {
  const u = new ListenUsage(() => DAY);
  u.record('ok', 'id:aaaa');
  assert.equal(await u.flush({ add: async () => { throw new Error('down'); } }, quiet), false);
  u.record('ok', 'id:aaaa');
  let got: ListenRow[] = [];
  await u.flush({ add: async (r) => { got = r; } });
  assert.deepEqual(got, [{ day: '2026-11-26', bucket: 'id:aaaa', ok: 2, refused: 0, failed: 0 }]);
});

test('push stores first, then posts yesterday and today, zeros included; one bad day does not stop the other', async () => {
  const calls: string[] = [];
  const posts: Array<[string, Array<{ metric: string; value: number }>]> = [];
  const deps: ListenDeps = {
    now: () => new Date(DAY),
    add: async () => { calls.push('add'); },
    totals: async (day) => {
      calls.push(`totals ${day}`);
      if (day === '2026-11-25') throw new Error('nope');
      return { ok: 3, installs: 2, no_install_id: 1, refused: 4, failed: 0 };
    },
    post: async (day, items) => { posts.push([day, items]); },
  };
  const u = new ListenUsage(() => DAY);
  u.record('ok', 'id:aaaa');
  assert.deepEqual(await pushListenTotals(deps, u, quiet), ['2026-11-26']);
  assert.deepEqual(calls, ['add', 'totals 2026-11-25', 'totals 2026-11-26']);
  assert.deepEqual(posts[0][1].map((i) => [i.metric, i.value]), [
    ['listen.authorize_ok', 3], ['listen.installs', 2], ['listen.authorize_no_install_id', 1], ['listen.authorize_refused', 4], ['listen.authorize_failed', 0],
  ]);
  // the reporter accepts only these characters in a metric name, and treats an api. prefix as API usage
  for (const i of posts[0][1]) assert.match(i.metric, /^listen\.[a-z_]+$/);
});

test('the middleware counts what the authorize route and the limiters before it answered, and nothing else', async () => {
  const u = new ListenUsage(() => DAY);
  const app = express();
  app.use('/api/realtime-tts', countListening(u), (req, res) => {
    if (req.query.s === '429') { res.status(429).end(); return; }
    res.locals.listenBucket = 'id:zzzz';
    res.status(200).json({});
  });
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/realtime-tts`;
    await fetch(`${base}/authorize`, { method: 'POST' });
    await fetch(`${base}/authorize?s=429`, { method: 'POST' });
    await fetch(`${base}/authorize`, { method: 'GET' });
    await fetch(`${base}/other`, { method: 'POST' });
  } finally {
    server.close();
  }
  let got: ListenRow[] = [];
  await u.flush({ add: async (r) => { got = r; } });
  assert.deepEqual(got.map((r) => [r.bucket, r.ok, r.refused]).sort(), [['-', 0, 1], ['id:zzzz', 1, 0]]);
});
