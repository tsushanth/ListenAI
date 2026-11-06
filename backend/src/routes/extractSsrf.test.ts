import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';


async function withApp<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const { extractRouter } = await import('./extract.js');
  const app = express();
  app.use(express.json());
  app.use('/api/extract', extractRouter);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  } finally {
    server.close();
  }
}

test('POST /api/extract refuses loopback, metadata and file URLs (SSRF) and never reaches them', async () => {
  let hits = 0;
  const internal = http.createServer((_q, r) => { hits++; r.end('<html><body><p>internal secret</p></body></html>'); });
  await new Promise<void>((r) => internal.listen(0, '127.0.0.1', r));
  const internalPort = (internal.address() as { port: number }).port;
  try {
    await withApp(async (base) => {
      for (const url of [`http://127.0.0.1:${internalPort}/`, `http://localhost:${internalPort}/`, 'http://169.254.169.254/latest/meta-data/', 'file:///etc/passwd']) {
        const res = await fetch(`${base}/api/extract`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url, clean: false }) });
        assert.ok(res.status === 400, `${url} -> ${res.status}`);
      }
    });
    assert.equal(hits, 0, 'the internal server must never be contacted');
  } finally {
    internal.close();
  }
});
