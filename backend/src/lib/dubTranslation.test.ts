import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTranslationSystemPrompt, buildTranslationUserPrompt, parseTranslationReply, overBudgetIndexes, chunkRanges } from './dubTranslation.js';
import { resolveDubLanguage } from './dubLanguages.js';

const es = resolveDubLanguage('es')!;

test('system prompt names the target language and states the per-segment length budget rule', () => {
  const p = buildTranslationSystemPrompt(es, 'English');
  assert.match(p, /Spanish/);
  assert.match(p, /max_chars/);
  assert.match(p, /JSON array of strings/);
  assert.match(p, /do not merge, split, reorder, or drop/i);
});

test('user prompt carries text and a max_chars budget per segment', () => {
  const u = JSON.parse(buildTranslationUserPrompt([{ text: 'Hello there', maxChars: 40, targetChars: 33 }]));
  assert.deepEqual(u, [{ text: 'Hello there', max_chars: 40, target_chars: 33 }]);
});

test('parseTranslationReply strips code fences and enforces length', () => {
  assert.deepEqual(parseTranslationReply('```json\n["a","b"]\n```', 2), ['a', 'b']);
  assert.throws(() => parseTranslationReply('nope', 1), /not valid JSON/);
  assert.throws(() => parseTranslationReply('["a"]', 2), /expected 2/);
  assert.deepEqual(parseTranslationReply('["a", 5]', 2), ['a', '']);
});

test('overBudgetIndexes flags only clearly-too-long translations', () => {
  const budgets = [{ maxChars: 50 }, { maxChars: 50 }, { maxChars: 10 }];
  const out = overBudgetIndexes(['x'.repeat(60), 'x'.repeat(80), 'x'.repeat(14)], budgets);
  assert.deepEqual(out, [1]); // 60 <= 50*1.3 ok; 80 > 65; 14 is under the 20 char floor
});

test('chunkRanges splits into batches', () => {
  assert.deepEqual(chunkRanges(5, 2), [[0, 2], [2, 4], [4, 5]]);
  assert.deepEqual(chunkRanges(0, 2), []);
});
