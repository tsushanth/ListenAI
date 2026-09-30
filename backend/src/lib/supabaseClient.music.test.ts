// Run: npx tsx --test src/lib/supabaseClient.music.test.ts
// Requires a local Supabase instance (`supabase start`) with migration
// 024_add_music_jobs.sql applied.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ??= 'http://127.0.0.1:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??=
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
process.env.SUPABASE_JWT_SECRET ??= 'super-secret-jwt-token-with-at-least-32-characters-long';
process.env.NODE_ENV = 'test'; // logger only loads pino-pretty in development

const modP = import('./supabaseClient.js'); // after env is set; no top-level await (CJS build)

const testUserId = '00000000-0000-0000-0000-000000000099';

test('creates a job in queued status and can fetch it back scoped to the owner', async () => {
  const { createMusicJob, getMusicJobForUser } = await modP;

  const job = await createMusicJob({
    userId: testUserId,
    prompt: 'corporate upbeat instrumental',
    durationSec: 30,
    cacheKey: 'test-cache-key-supabase-1',
  });

  assert.equal(job.status, 'queued');

  const fetched = await getMusicJobForUser(job.id, testUserId);
  assert.notEqual(fetched, null);
  assert.equal(fetched?.prompt, 'corporate upbeat instrumental');
});

test('returns null when fetching a job for the wrong user', async () => {
  const { createMusicJob, getMusicJobForUser } = await modP;

  const job = await createMusicJob({
    userId: testUserId,
    prompt: 'calm ambient loop',
    durationSec: 60,
    cacheKey: 'test-cache-key-supabase-2',
  });

  const fetched = await getMusicJobForUser(job.id, '00000000-0000-0000-0000-000000000098');
  assert.equal(fetched, null);
});

test('marks a job ready and it becomes retrievable via getCachedMusic', async () => {
  const { createMusicJob, updateMusicJobStatus, getCachedMusic } = await modP;

  const job = await createMusicJob({
    userId: testUserId,
    prompt: 'soft piano loop',
    durationSec: 45,
    cacheKey: 'test-cache-key-supabase-3',
  });

  await updateMusicJobStatus(job.id, 'ready', { audioPath: 'music/jobs/test.wav' });

  const cached = await getCachedMusic('test-cache-key-supabase-3');
  assert.equal(cached?.status, 'ready');
  assert.equal(cached?.audio_path, 'music/jobs/test.wav');
});
