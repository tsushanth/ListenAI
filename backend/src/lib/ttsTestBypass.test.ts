import test from 'node:test';
import assert from 'node:assert/strict';
import { isTtsTestBypass, safeEqualSecret } from './ttsTestBypass.js';

const SECRET = 'unit-test-secret-0123456789abcdef';
const req = (headers: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  ({ method: 'POST', originalUrl: '/api/realtime-tts/authorize', headers, ...over }) as Parameters<typeof isTtsTestBypass>[0];

test('safeEqualSecret: equal strings match, different (and different length) do not', () => {
  assert.equal(safeEqualSecret(SECRET, SECRET), true);
  assert.equal(safeEqualSecret(SECRET, SECRET + 'x'), false);
  assert.equal(safeEqualSecret(SECRET, SECRET.slice(0, -1)), false);
  assert.equal(safeEqualSecret('', SECRET), false);
  assert.equal(safeEqualSecret('a', 'b'), false);
});

test('isTtsTestBypass: valid key passes on the authorize path only', () => {
  const env = { TTS_TEST_BYPASS_KEY: SECRET };
  assert.equal(isTtsTestBypass(req({ 'x-tts-test-key': SECRET }), env), true);
  assert.equal(isTtsTestBypass(req({ 'x-tts-test-key': SECRET }, { originalUrl: '/api/realtime-tts/authorize?x=1' }), env), true);
  assert.equal(isTtsTestBypass(req({ 'x-tts-test-key': SECRET }, { originalUrl: '/api/tts' }), env), false);
  assert.equal(isTtsTestBypass(req({ 'x-tts-test-key': SECRET }, { method: 'GET' }), env), false);
});

test('isTtsTestBypass: wrong, missing, empty or repeated header does not pass', () => {
  const env = { TTS_TEST_BYPASS_KEY: SECRET };
  for (const h of [undefined, '', 'wrong', SECRET + ' ', SECRET.toUpperCase(), [SECRET, SECRET]]) {
    assert.equal(isTtsTestBypass(req(h === undefined ? {} : { 'x-tts-test-key': h }), env), false, String(h));
  }
});

test('isTtsTestBypass: off when the secret is unset, empty or too short, whatever the header says', () => {
  for (const s of [undefined, '', 'short']) {
    const env = s === undefined ? {} : { TTS_TEST_BYPASS_KEY: s };
    assert.equal(isTtsTestBypass(req({ 'x-tts-test-key': s ?? '' }), env), false);
    assert.equal(isTtsTestBypass(req({ 'x-tts-test-key': 'undefined' }), env), false);
  }
});
