import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSynthesizeMessage, isEnglishVoice } from '../src/ttsClient.js';

const parse = (...a) => JSON.parse(buildSynthesizeMessage(...a));

test('English / default voices ask for normalize:auto', () => {
  assert.equal(parse('See you at 9 AM').normalize, 'auto');
  assert.equal(parse('hi', { voice: 'default' }).normalize, 'auto');
  assert.equal(parse('hi', { voice: 'custom:en-us-warm-f' }).normalize, 'auto');
});

test('non-English custom voices send no normalize field', () => {
  assert.equal(isEnglishVoice('custom:de-de-mls-f'), false);
  assert.equal('normalize' in parse('hallo', { voice: 'custom:de-de-mls-f' }), false);
});

test('explicit normalize from the caller wins', () => {
  assert.equal(parse('hi', { voice: 'custom:en-us-warm-f', normalize: 'off' }).normalize, 'off');
  assert.equal(parse('hi', { voice: 'custom:de-de-mls-f', normalize: 'auto' }).normalize, 'auto');
});

test('message shape is otherwise unchanged', () => {
  assert.deepEqual(parse('hi', { voice: 'default', speed: 1.2 }), { type: 'synthesize', text: 'hi', voice: 'default', speed: 1.2, normalize: 'auto' });
});
