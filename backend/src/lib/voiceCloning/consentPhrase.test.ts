import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CODE_WORDS, CONSENT_LANGUAGES, codeWordHeard, codeWordsFor, editDistance, issuePhrase, languageOfPhrase, normalizeConsentLanguage, normalizeWords,
  normalizeWordsFor, phraseTemplateFor, scoreTranscript, wordErrorRate, type ConsentLanguage,
} from './consentPhrase.js';

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

// ---- other languages --------------------------------------------------------------------------------------------

const NON_EN: ConsentLanguage[] = ['es', 'de'];

test('consent languages: English is the default and the English phrase is unchanged', () => {
  assert.deepEqual([...CONSENT_LANGUAGES], ['en', 'es', 'de']);
  const { phrase, language } = issuePhrase();
  assert.equal(language, 'en');
  assert.ok(phrase.startsWith('I agree that ReadAloud may create a synthetic copy of my voice. My code words are '));
  assert.equal(phraseTemplateFor('en'), 'I agree that ReadAloud may create a synthetic copy of my voice. My code words are');
  assert.equal(issuePhrase(undefined, 'en').phrase.split(' ').length, phraseTemplateFor('en').split(' ').length + 4);
});

test('normalizeConsentLanguage accepts codes and regional tags, rejects the rest', () => {
  assert.equal(normalizeConsentLanguage('de'), 'de');
  assert.equal(normalizeConsentLanguage('DE'), 'de');
  assert.equal(normalizeConsentLanguage('de-AT'), 'de');
  assert.equal(normalizeConsentLanguage('es_MX'), 'es');
  assert.equal(normalizeConsentLanguage(' en '), 'en');
  for (const bad of ['fr', 'xx', '', 'german', null, undefined, 7, {}]) assert.equal(normalizeConsentLanguage(bad), null, String(bad));
});

for (const lang of NON_EN) {
  test(`${lang}: word list is clean (unique, 4+ letters, ASCII after normalising, no two words within one letter)`, () => {
    const words = codeWordsFor(lang);
    assert.ok(words.length >= 120, `${lang} has ${words.length} words`);
    const norm = words.map((w) => normalizeWordsFor(w, lang));
    for (const n of norm) assert.equal(n.length, 1, 'each code word is one word');
    const flat = norm.map((n) => n[0]!);
    assert.equal(new Set(words).size, words.length);
    for (const w of flat) { assert.match(w, /^[a-z]{4,}$/); }
    for (let i = 0; i < flat.length; i++) for (let j = i + 1; j < flat.length; j++) {
      assert.ok(editDistance(flat[i]!, flat[j]!) >= 2, `${flat[i]} / ${flat[j]} are one letter apart`);
    }
  });

  test(`${lang}: issuePhrase writes the ${lang} template, 4 distinct words from the ${lang} list, and the language is recoverable from the text`, () => {
    const p = issuePhrase(undefined, lang);
    assert.equal(p.language, lang);
    assert.ok(p.phrase.startsWith(phraseTemplateFor(lang) + ' '));
    assert.equal(new Set(p.codeWords).size, 4);
    for (const w of p.codeWords) assert.ok(codeWordsFor(lang).includes(w));
    assert.equal(languageOfPhrase(p.phrase), lang);
    assert.notEqual(phraseTemplateFor(lang), phraseTemplateFor('en'));
    assert.match(p.phrase, /ReadAloud/);
  });
}

test('languageOfPhrase: English phrases and anything unrecognised (older challenges) are English', () => {
  assert.equal(languageOfPhrase(issuePhrase().phrase), 'en');
  assert.equal(languageOfPhrase('something stored before languages existed, maple, tiger.'), 'en');
});

test('normalizeWordsFor: English unchanged; es/de drop accents and write the sharp s as ss', () => {
  assert.deepEqual(normalizeWordsFor('Café, naïve!', 'en'), normalizeWords('Café, naïve!'));
  assert.deepEqual(normalizeWordsFor('Straße Wörter über', 'de'), ['strasse', 'worter', 'uber']);
  assert.deepEqual(normalizeWordsFor('Mis cuatro palabras: montaña, sintética.', 'es'), ['mis', 'cuatro', 'palabras', 'montana', 'sintetica']);
});

function deRead(words: string[]) { return `${phraseTemplateFor('de')} ${words.join(', ')}.`; }
const DE_WORDS = ['apfel', 'wüste', 'kerze', 'ameise'];

test('de: an exact reading passes; so do the transcriber habits (no umlauts, ss for ß, brand name split, no comma)', () => {
  const phrase = deRead(DE_WORDS);
  assert.deepEqual(scoreTranscript(phrase, DE_WORDS, phrase, 'de'), { wer: 0, codeWordsInOrder: true });
  const heard = 'Ich bin einverstanden dass Read Aloud eine synthetische Kopie meiner Stimme erstellt. Meine vier Worter lauten Apfel Wuste Kerze Ameise';
  const s = scoreTranscript(phrase, DE_WORDS, heard, 'de');
  assert.equal(s.codeWordsInOrder, true);
  assert.ok(s.wer <= 0.2, `wer ${s.wer}`);
});

test('de: one letter of slack on a long code word, none on a different word, order and completeness still enforced', () => {
  const phrase = deRead(DE_WORDS);
  const say = (w: string[]) => scoreTranscript(phrase, DE_WORDS, deRead(w), 'de').codeWordsInOrder;
  assert.equal(say(['apfel', 'wüste', 'kerze', 'ameisen']), true); // plural slip
  assert.equal(say(['apfel', 'wüste', 'kerze', 'ameise']), true);
  assert.equal(say(['wüste', 'apfel', 'kerze', 'ameise']), false); // swapped
  assert.equal(say(['apfel', 'wüste', 'kerze']), false); // missing
  assert.equal(say(['apfel', 'wüste', 'kerze', 'ameisenbär']), false); // another word
  assert.equal(say(['apfel', 'wüste', 'kirche', 'ameise']), false); // a different word two letters off
});

test('es: reading passes with or without accents; code words in order are still required', () => {
  const words = ['montaña', 'cascada', 'lechuga', 'ballena'];
  const phrase = `${phraseTemplateFor('es')} ${words.join(', ')}.`;
  assert.deepEqual(scoreTranscript(phrase, words, phrase, 'es'), { wer: 0, codeWordsInOrder: true });
  const noAccents = 'Acepto que Read Aloud cree una copia sintetica de mi voz. Mis cuatro palabras son montana cascada lechuga ballena';
  const s = scoreTranscript(phrase, words, noAccents, 'es');
  assert.equal(s.codeWordsInOrder, true);
  assert.ok(s.wer <= 0.2, `wer ${s.wer}`);
  assert.equal(scoreTranscript(phrase, words, 'Acepto que ReadAloud cree una copia sintética de mi voz. Mis cuatro palabras son cascada montaña lechuga ballena', 'es').codeWordsInOrder, false);
});

test('a phrase read in the wrong language does not pass: an English reading of a German challenge fails the code words and has a high WER', () => {
  const phrase = deRead(DE_WORDS);
  const s = scoreTranscript(phrase, DE_WORDS, 'I agree that ReadAloud may create a synthetic copy of my voice. My code words are apple, desert, candle, ant', 'de');
  assert.equal(s.codeWordsInOrder, false);
  assert.ok(s.wer > 0.8);
});
