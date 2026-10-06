// The legacy /api/cloned-voices router created clones from nothing but a client-chosen X-Device-ID.
// Creation must now be refused; no Supabase call may happen.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';

test('legacy POST /cloned-voices and /:id/confirm return 410 consent_required', async () => {
  const [{ default: express }, { clonedVoicesRouter }] = await Promise.all([import('express'), import('./clonedVoices.js')]);
  const app = express();
  app.use(express.json());
  app.use('/api/cloned-voices', clonedVoicesRouter);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/cloned-voices`;
  try {
    for (const path of ['', '/11111111-1111-4111-8111-111111111111/confirm']) {
      const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'X-Device-ID': 'any-device', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x', duration_sec: 10, file_size_bytes: 1000 }) });
      assert.equal(r.status, 410);
      const j = await r.json() as { code: string; use: string };
      assert.equal(j.code, 'consent_required');
      assert.equal(j.use, '/api/voice-clones');
    }
  } finally { server.close(); }
});
