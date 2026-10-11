// Claude spend accounting with no LLM_USAGE_KEY: the client is inert. Nothing is sent, even though FAILURE_REPORTER_KEY is set.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
delete process.env.LLM_USAGE_KEY;
process.env.FAILURE_REPORTER_KEY = 'reporter-key-must-not-enable-usage';

const calls: string[] = [];
mock.module('node-fetch', {
  defaultExport: async (input: unknown) => {
    calls.push(String(input));
    return new Response(JSON.stringify({
      id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', stop_reason: 'end_turn', stop_sequence: null,
      content: [{ type: 'text', text: '{"chapters":[]}' }], usage: { input_tokens: 10, output_tokens: 5 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  },
});
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => { calls.push(String(typeof input === 'string' ? input : input.url)); return realFetch(input, init); }) as typeof fetch;

test('without LLM_USAGE_KEY the client is disabled, records nothing and sends nothing (FAILURE_REPORTER_KEY is not reused)', async () => {
  const { llm, flushLlmUsage } = await import('./llm.js');
  const { detectChaptersFromText } = await import('./chapterDetection.js');
  assert.equal(llm.enabled, false);
  await detectChaptersFromText('word '.repeat(4000), 'T');
  assert.ok(calls.some((u) => u.includes('api.anthropic.com')), 'the Claude call itself must still happen');
  assert.equal(llm.pending(), 0);
  await flushLlmUsage(100);
  assert.deepEqual(calls.filter((u) => !u.includes('api.anthropic.com')), []);
});
