// Guard: XTTS v2 weights are under the Coqui Public Model License (non-commercial), so no code path
// that can reach it may exist in the backend. This test fails if one is (re)introduced.
// Voice cloning is Chatterbox only (MIT); see lib/voiceCloning/.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Built from parts so this file does not match its own search.
const FORBIDDEN = new RegExp(['xt' + 'ts', 'co' + 'qui'].join('|'), 'i');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|js|json)$/.test(name)) out.push(p);
  }
  return out;
}

test('backend/src contains no reference to the non-commercial XTTS model', () => {
  const offenders = walk(SRC_ROOT)
    .filter((f) => !f.endsWith('noXtts.test.ts'))
    .filter((f) => FORBIDDEN.test(readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, []);
});

test('index.ts does not mount the retired /api/voice-clone XTTS route', () => {
  const index = readFileSync(join(SRC_ROOT, 'index.ts'), 'utf8');
  assert.ok(!/\/api\/voice-clone['"`]/.test(index), '/api/voice-clone must not be mounted');
  assert.ok(!/voiceClone\.js/.test(index), 'routes/voiceClone.js must not be imported');
});
