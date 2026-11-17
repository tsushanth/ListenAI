import test from 'node:test';
import assert from 'node:assert/strict';
import { CODE_WORDS, codeWordHeard, editDistance, issuePhrase, normalizeWords, scoreTranscript, wordErrorRate } from './consentPhrase.js';

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

// Real transcriber output for clean synthetic reads, seen on 2026-11-17 (each of these failed with exact matching).
const BASE = 'I agree that ReadAloud may create a synthetic copy of my voice. My code words are';
test('scoreTranscript: spelling variants of rare code words still pass (sesame/sessame, orchid/orcid, quartz/quarts)', () => {
  const a = scoreTranscript(`${BASE} glacier, apple, anvil, sesame.`, ['glacier', 'apple', 'anvil', 'sesame'], 'I agree that read aloud may create a synthetic copy of my voice. My code words are Glacier, Apple, Anvil, Sessame.');
  assert.equal(a.codeWordsInOrder, true);
  assert.ok(a.wer <= 0.2, `wer ${a.wer}`);
  const b = scoreTranscript(`${BASE} orchid, marble, harvest, quartz.`, ['orchid', 'marble', 'harvest', 'quartz'], 'I agree that read aloud may create a synthetic copy of my voice. My code words are ORCID, MARBLE, HARVEST, QUARTS.');
  assert.equal(b.codeWordsInOrder, true);
  assert.ok(b.wer <= 0.2, `wer ${b.wer}`);
});

test('scoreTranscript: "read aloud" written as two words does not cost word errors', () => {
  const s = scoreTranscript(`${BASE} maple, tiger, ocean, cedar.`, ['maple', 'tiger', 'ocean', 'cedar'], 'I agree that read aloud may create a synthetic copy of my voice. My code words are maple, tiger, ocean, cedar.');
  assert.equal(s.wer, 0);
  assert.equal(scoreTranscript(`${BASE} maple, tiger, ocean, cedar.`, ['maple', 'tiger', 'ocean', 'cedar'], 'I agree that Read-Aloud may create a synthetic copy of my voice. My code words are maple, tiger, ocean, cedar.').wer, 0);
});

test('codeWordHeard: one letter of slack only for words of 5+ letters, never a different word', () => {
  assert.equal(codeWordHeard('sessame', 'sesame'), true);
  assert.equal(codeWordHeard('orcid', 'orchid'), true);
  assert.equal(codeWordHeard('quarts', 'quartz'), true);
  assert.equal(codeWordHeard('cliffs', 'cliff'), true);
  assert.equal(codeWordHeard('dun', 'dune'), false); // short words stay exact
  assert.equal(codeWordHeard('dunes', 'dune'), false);
  assert.equal(codeWordHeard('violet', 'violin'), false); // two letters off: a different code word
  assert.equal(codeWordHeard('maple', 'marble'), false);
  assert.equal(codeWordHeard('apple', 'maple'), false);
  assert.equal(editDistance('kitten', 'sitting'), 3);
});

test('scoreTranscript: slack does not let a missing, reordered or replaced code word through', () => {
  const words = ['maple', 'tiger', 'ocean', 'cedar'];
  const phrase = `${BASE} maple, tiger, ocean, cedar.`;
  assert.equal(scoreTranscript(phrase, words, `${BASE} maple tiger ocean`).codeWordsInOrder, false);
  assert.equal(scoreTranscript(phrase, words, `${BASE} tiger maple ocean cedar`).codeWordsInOrder, false);
  assert.equal(scoreTranscript(phrase, words, `${BASE} maple tiger ocean copper`).codeWordsInOrder, false);
  assert.equal(scoreTranscript(phrase, words, `${BASE} maples tigers oceans cedars`).codeWordsInOrder, true); // plural slips are accepted
  assert.equal(scoreTranscript(phrase, words, `${BASE} marble tiger ocean cedar`).codeWordsInOrder, false);
});
