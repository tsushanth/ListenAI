import test from 'node:test';
import assert from 'node:assert/strict';
import { CODE_WORDS, issuePhrase, normalizeWords, scoreTranscript, wordErrorRate } from './consentPhrase.js';

test('code word list has no duplicates and enough entropy', () => {
  assert.equal(new Set(CODE_WORDS).size, CODE_WORDS.length);
  assert.ok(CODE_WORDS.length >= 200);
  for (const w of CODE_WORDS) assert.match(w, /^[a-z]+$/);
});

test('issuePhrase draws 4 distinct code words and embeds them in the phrase', () => {
  const { phrase, codeWords } = issuePhrase();
  assert.equal(codeWords.length, 4);
  assert.equal(new Set(codeWords).size, 4);
  for (const w of codeWords) assert.ok(phrase.includes(w));
  assert.match(phrase, /synthetic copy of my voice/);
});

test('issuePhrase re-draws on a duplicate pick', () => {
  const seq = [0, 0, 1, 2, 3];
  let i = 0;
  const { codeWords } = issuePhrase(() => seq[i++]!);
  assert.deepEqual(codeWords, [CODE_WORDS[0], CODE_WORDS[1], CODE_WORDS[2], CODE_WORDS[3]]);
});

test('two phrases differ (not a constant)', () => {
  const a = issuePhrase().phrase;
  const b = issuePhrase().phrase;
  const c = issuePhrase().phrase;
  assert.ok(new Set([a, b, c]).size > 1);
});

test('normalizeWords lowercases and strips punctuation', () => {
  assert.deepEqual(normalizeWords("I agree, that ReadAloud's copy."), ['i', 'agree', 'that', "readaloud's", 'copy']);
});

test('wordErrorRate basics', () => {
  assert.equal(wordErrorRate(['a', 'b', 'c'], ['a', 'b', 'c']), 0);
  assert.equal(wordErrorRate(['a', 'b', 'c'], ['a', 'x', 'c']), 1 / 3);
  assert.equal(wordErrorRate(['a', 'b'], []), 1);
  assert.equal(wordErrorRate([], []), 0);
});

test('scoreTranscript: exact read passes with order check', () => {
  const phrase = 'I agree that ReadAloud may create a synthetic copy of my voice. My code words are maple, tiger, ocean, cedar.';
  const s = scoreTranscript(phrase, ['maple', 'tiger', 'ocean', 'cedar'], 'I agree that ReadAloud may create a synthetic copy of my voice. My code words are maple tiger ocean cedar');
  assert.equal(s.wer, 0);
  assert.equal(s.codeWordsInOrder, true);
});

test('scoreTranscript: a missing or reordered code word fails the code check even if WER is low', () => {
  const phrase = 'I agree that ReadAloud may create a synthetic copy of my voice. My code words are maple, tiger, ocean, cedar.';
  const missing = scoreTranscript(phrase, ['maple', 'tiger', 'ocean', 'cedar'], 'I agree that ReadAloud may create a synthetic copy of my voice. My code words are maple tiger ocean');
  assert.equal(missing.codeWordsInOrder, false);
  const swapped = scoreTranscript(phrase, ['maple', 'tiger', 'ocean', 'cedar'], 'I agree that ReadAloud may create a synthetic copy of my voice. My code words are tiger maple ocean cedar');
  assert.equal(swapped.codeWordsInOrder, false);
});

test('scoreTranscript: unrelated speech has high WER', () => {
  const s = scoreTranscript('I agree that ReadAloud may create a synthetic copy of my voice. My code words are maple tiger ocean cedar.', ['maple', 'tiger', 'ocean', 'cedar'], 'the quick brown fox jumps over the lazy dog');
  assert.ok(s.wer > 0.8);
});
