import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMusicCacheKey, generateMusicAudioPath, computeSoundEffectCacheKey, generateSoundEffectAudioPath } from './cacheKey.js';

test('computeMusicCacheKey - produces different keys for different prompts at the same duration', () => {
  const keyA = computeMusicCacheKey({ prompt: 'corporate upbeat instrumental', durationSec: 30 });
  const keyB = computeMusicCacheKey({ prompt: 'calm ambient loop', durationSec: 30 });
  assert.notStrictEqual(keyA, keyB);
});

test('computeMusicCacheKey - produces the same key for the same prompt and duration', () => {
  const keyA = computeMusicCacheKey({ prompt: 'corporate upbeat instrumental', durationSec: 30 });
  const keyB = computeMusicCacheKey({ prompt: 'corporate upbeat instrumental', durationSec: 30 });
  assert.strictEqual(keyA, keyB);
});

test('computeMusicCacheKey - produces different keys for the same prompt at different durations', () => {
  const keyA = computeMusicCacheKey({ prompt: 'corporate upbeat instrumental', durationSec: 30 });
  const keyB = computeMusicCacheKey({ prompt: 'corporate upbeat instrumental', durationSec: 60 });
  assert.notStrictEqual(keyA, keyB);
});

test('generateMusicAudioPath - includes the job id in the path', () => {
  const path = generateMusicAudioPath('abc-123');
  assert.ok(path.includes('abc-123'), 'path should contain job id');
  assert.ok(path.endsWith('.wav'), 'path should end with .wav');
});

test('computeMusicCacheKey and computeSoundEffectCacheKey never collide for the same prompt and duration', () => {
  const opts = { prompt: 'thunder rolling over hills', durationSec: 10 };
  assert.notStrictEqual(computeMusicCacheKey(opts), computeSoundEffectCacheKey(opts));
});

test('music and sound effect audio paths live under separate prefixes', () => {
  assert.strictEqual(generateMusicAudioPath('job-1'), 'music/jobs/job-1.wav');
  assert.strictEqual(generateSoundEffectAudioPath('job-1'), 'sound-effects/jobs/job-1.wav');
});
