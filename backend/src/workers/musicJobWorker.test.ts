// Run: npx tsx --test src/workers/musicJobWorker.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';

const modP = import('./musicJobWorker.js'); // after env is set; no top-level await (CJS build)

function recorder<Args extends unknown[], R>(impl: (...args: Args) => Promise<R> | R) {
  const calls: Args[] = [];
  const fn = async (...args: Args): Promise<R> => {
    calls.push(args);
    return impl(...args);
  };
  return { fn, calls };
}

test('returns false when no job is queued', async () => {
  const { processOneJob } = await modP;
  const claimJob = recorder(async () => null);
  const updateStatus = recorder(async () => undefined);
  const uploadAudio = recorder(async () => undefined);
  const callModalWorker = recorder(async () => Buffer.from(''));

  const result = await processOneJob({
    claimJob: claimJob.fn as any,
    updateStatus: updateStatus.fn as any,
    uploadAudio: uploadAudio.fn as any,
    callModalWorker: callModalWorker.fn as any,
  });

  assert.equal(result, false);
  assert.equal(updateStatus.calls.length, 0);
});

test('on success, uploads audio and marks the job ready', async () => {
  const { processOneJob } = await modP;
  const claimJob = recorder(async () => ({ id: 'job-1', prompt: 'ambient loop', duration_sec: 30 } as any));
  const updateStatus = recorder(async () => undefined);
  const uploadAudio = recorder(async () => undefined);
  const callModalWorker = recorder(async () => Buffer.from('fake-wav-bytes'));

  const result = await processOneJob({
    claimJob: claimJob.fn as any,
    updateStatus: updateStatus.fn as any,
    uploadAudio: uploadAudio.fn as any,
    callModalWorker: callModalWorker.fn as any,
  });

  assert.equal(result, true);
  assert.deepEqual(uploadAudio.calls[0], ['music/jobs/job-1.wav', Buffer.from('fake-wav-bytes')]);
  assert.deepEqual(updateStatus.calls[0], ['job-1', 'ready', { audioPath: 'music/jobs/job-1.wav' }]);
});

test('on Modal call failure, marks the job failed instead of leaving it stuck processing', async () => {
  const { processOneJob } = await modP;
  const claimJob = recorder(async () => ({ id: 'job-2', prompt: 'ambient loop', duration_sec: 30 } as any));
  const updateStatus = recorder(async () => undefined);
  const uploadAudio = recorder(async () => undefined);
  const callModalWorker = recorder(async () => {
    throw new Error('modal timeout');
  });

  const result = await processOneJob({
    claimJob: claimJob.fn as any,
    updateStatus: updateStatus.fn as any,
    uploadAudio: uploadAudio.fn as any,
    callModalWorker: callModalWorker.fn as any,
  });

  assert.equal(result, true);
  assert.equal(uploadAudio.calls.length, 0);
  assert.deepEqual(updateStatus.calls[0], [
    'job-2',
    'failed',
    { errorCode: 'GENERATION_FAILED', errorMessage: 'modal timeout' },
  ]);
});
