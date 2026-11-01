// Run: npx tsx --test src/lib/failureReporterTestRunnerGuard.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';

// Regression: plain `node --test` sets neither NODE_ENV=test nor FAILURE_REPORTER_DISABLED, so with the reporter key present
// (as on a dev box or CI with the Fly secret) a stray report call in any test used to post a fake error to the live reporter.
test('under node --test the reporter never posts, even with a key set and NODE_ENV unset', async () => {
  assert.ok(process.env.NODE_TEST_CONTEXT, 'sanity: running under the node test runner');
  delete process.env.NODE_ENV;
  delete process.env.FAILURE_REPORTER_DISABLED;
  process.env.FAILURE_REPORTER_KEY = 'test-key';
  process.env.FAILURE_REPORTER_URL = 'https://reporter.example/v1/report';
  const calls: unknown[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (...a: unknown[]) => { calls.push(a); return new Response('{}', { status: 200 }); }) as typeof fetch;
  try {
    // The module reads the environment at import time; this file runs in its own process, so this is its first load.
    const fr = await import('./failureReporter.js');
    fr.reportFailure('x', new Error('must not leave the process'));
    fr.reportBackendError({ method: 'GET', path: '/x' }, new Error('nor this'), 500);
    await fr.reportCrash('x', new Error('nor this either'));
    await new Promise((r) => setTimeout(r, 20));
  } finally { globalThis.fetch = real; }
  assert.equal(calls.length, 0, 'no network call to the reporter');
});
