// Run: npx tsx --test src/lib/jobFailureSignal.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

import {
  classifyFailure, charsBucket, providerLabel, signalTtsJobFailure,
  signalVoiceConversionFailure, signalVoiceConversionsReaped, signalVoiceConvertDeployFailure,
  type ReportFn,
} from './jobFailureSignal.js';

type Call = { flow: string; err: unknown; ctx: Record<string, string> | undefined };
function recorder(): { calls: Call[]; fn: ReportFn } {
  const calls: Call[] = [];
  return { calls, fn: (flow, err, ctx) => { calls.push({ flow, err, ctx }); } };
}

// Strings that must never appear anywhere in what is sent.
const SECRET_BITS = ['alice@example.com', 'user-1234-abcd', 'Chapter One of my diary', 'my-voice-name', 'secret_file.wav'];

test('classifies the recurring error shapes', () => {
  assert.equal(classifyFailure('SelfHosted: TTS request timed out - text may be too long'), 'TTS_TIMEOUT');
  assert.equal(classifyFailure('timeout of 120000ms exceeded'), 'TTS_TIMEOUT');
  assert.equal(classifyFailure('TTS_PROVIDER_ERROR SelfHosted: Request failed with status code 404'), 'TTS_SERVICE_404');
  assert.equal(classifyFailure('ElevenLabs: Rate limit exceeded - please try again later'), 'TTS_RATE_LIMITED');
  assert.equal(classifyFailure('Request failed with status code 429'), 'TTS_RATE_LIMITED');
  assert.equal(classifyFailure('Invalid reference audio: could not decode'), 'CLONE_INPUT_INVALID');
  assert.equal(classifyFailure('voice clone service /synthesize returned HTTP 422: bad', { kind: 'clone' }), 'CLONE_INPUT_INVALID');
  assert.equal(classifyFailure('anything', { stuck: true }), 'STUCK_JOB');
  assert.equal(classifyFailure('something odd'), 'UNKNOWN');
  assert.equal(classifyFailure(undefined), 'UNKNOWN');
});

test('a local "not found" is not mistaken for a TTS-service 404', () => {
  assert.equal(classifyFailure('Job text not found - ensure text is stored when creating job'), 'UNKNOWN');
  assert.equal(classifyFailure('Cloned voice not found.', { kind: 'clone' }), 'UNKNOWN');
});

test('a 422 on a plain TTS job is not labelled as clone input', () => {
  assert.equal(classifyFailure('Request failed with status code 422'), 'UNKNOWN');
});

test('buckets and labels never echo raw values', () => {
  assert.equal(charsBucket(120), '<500');
  assert.equal(charsBucket(1500), '500-2k');
  assert.equal(charsBucket(8000), '2k-10k');
  assert.equal(charsBucket(30000), '10k-50k');
  assert.equal(charsBucket(83000), '50k+');
  assert.equal(charsBucket(undefined), 'unknown');
  assert.equal(providerLabel('eleven_multilingual_v2', 'tts'), 'elevenlabs');
  assert.equal(providerLabel('kokoro-82m', 'tts'), 'selfhosted');
  assert.equal(providerLabel('alice-private-model', 'tts'), 'default');
  assert.equal(providerLabel('whatever', 'clone'), 'chatterbox');
});

test('a permanent TTS failure reports exactly once with the class and no content', () => {
  const r = recorder();
  const cls = signalTtsJobFailure({
    kind: 'tts',
    rawMessage: `SelfHosted: TTS request timed out for alice@example.com user-1234-abcd "Chapter One of my diary" my-voice-name secret_file.wav`,
    modelId: 'kokoro-82m',
    attempts: 3,
    charCount: 8000,
  }, r.fn);
  assert.equal(cls, 'TTS_TIMEOUT');
  assert.equal(r.calls.length, 1);
  const c = r.calls[0];
  assert.equal(c.flow, 'tts_job_failed');
  assert.equal((c.err as Error).message, 'TTS_TIMEOUT');
  assert.equal((c.err as Error).stack, '');
  assert.deepEqual(c.ctx, { provider: 'selfhosted', attempts: '3', chars_bucket: '2k-10k' });
  const everything = JSON.stringify([c.flow, (c.err as Error).message, (c.err as Error).stack, c.ctx]);
  for (const bit of SECRET_BITS) assert.ok(!everything.includes(bit), `leaked: ${bit}`);
});

test('clone failures use the clone flow and provider label', () => {
  const r = recorder();
  signalTtsJobFailure({ kind: 'clone', rawMessage: 'Invalid reference audio', modelId: 'chatterbox-mtl-v3', attempts: 3, charCount: 300 }, r.fn);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].flow, 'clone_job_failed');
  assert.equal((r.calls[0].err as Error).message, 'CLONE_INPUT_INVALID');
  assert.equal(r.calls[0].ctx?.provider, 'chatterbox');
});

test('the stuck watchdog reports STUCK_JOB', () => {
  const r = recorder();
  signalTtsJobFailure({ kind: 'tts', stuck: true, attempts: 3, modelId: 'x', charCount: 70000 }, r.fn);
  assert.equal((r.calls[0].err as Error).message, 'STUCK_JOB');
  assert.equal(r.calls[0].ctx?.chars_bucket, '50k+');
});

test('the same class gives the same message and stack every time (stable fingerprint)', () => {
  const r = recorder();
  signalTtsJobFailure({ kind: 'tts', rawMessage: 'Request failed with status code 404', attempts: 3, charCount: 100 }, r.fn);
  signalTtsJobFailure({ kind: 'tts', rawMessage: 'GET /voices/xyz returned 404 at 12:01', attempts: 1, charCount: 90000 }, r.fn);
  assert.equal((r.calls[0].err as Error).message, (r.calls[1].err as Error).message);
  assert.equal((r.calls[0].err as Error).stack, (r.calls[1].err as Error).stack);
});

test('a throwing reporter never breaks the caller', () => {
  assert.doesNotThrow(() => signalTtsJobFailure({ kind: 'tts', attempts: 1 }, () => { throw new Error('boom'); }));
});

test('voice conversion signals carry class names and counts only', () => {
  const r = recorder();
  signalVoiceConversionFailure(r.fn);
  signalVoiceConvertDeployFailure(r.fn);
  signalVoiceConversionsReaped(7, r.fn);
  assert.deepEqual(r.calls.map(c => (c.err as Error).message), ['VOICE_CONVERSION_FAILED', 'VOICE_CONVERT_DEPLOY_FAILED', 'VOICE_CONVERSION_STUCK']);
  assert.deepEqual(r.calls[2].ctx, { reaped: '7' });
});

test('the real reporter is silent in tests (no network)', () => {
  const orig = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => { fetched++; return new Response('{}'); }) as typeof fetch;
  try {
    signalTtsJobFailure({ kind: 'tts', rawMessage: 'timeout', attempts: 3 });
    assert.equal(fetched, 0);
  } finally { globalThis.fetch = orig; }
});
