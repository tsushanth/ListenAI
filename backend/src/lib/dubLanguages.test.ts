import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveDubLanguage,
  isKokoroVoiceIdAnyLanguage,
  assignSpeakerVoices,
  supportedDubLanguageList,
} from './dubLanguages.js';

test('resolveDubLanguage accepts names, codes and regional variants', () => {
  assert.equal(resolveDubLanguage('Spanish')?.code, 'es');
  assert.equal(resolveDubLanguage('es')?.code, 'es');
  assert.equal(resolveDubLanguage('es-MX')?.code, 'es');
  assert.equal(resolveDubLanguage(' FRENCH ')?.code, 'fr');
  assert.equal(resolveDubLanguage('fr_FR')?.code, 'fr');
  assert.equal(resolveDubLanguage('Hindi')?.code, 'hi');
  assert.equal(resolveDubLanguage('Italian')?.code, 'it');
  assert.equal(resolveDubLanguage('pt-BR')?.code, 'pt');
  assert.equal(resolveDubLanguage('Portuguese')?.code, 'pt');
  assert.equal(resolveDubLanguage('en-GB')?.variant, 'en-gb');
  assert.equal(resolveDubLanguage('English')?.code, 'en');
});

test('resolveDubLanguage rejects languages Kokoro cannot speak instead of silently using an English voice', () => {
  for (const l of ['German', 'de', 'Korean', 'Arabic', 'Russian', 'Klingon', '', 'x']) {
    assert.equal(resolveDubLanguage(l), null, l);
  }
});

test('ja/zh are not offered for dubbing yet (service images lack misaki ja/zh, never heard)', () => {
  assert.equal(resolveDubLanguage('Japanese'), null);
  assert.equal(resolveDubLanguage('zh'), null);
  assert.ok(!supportedDubLanguageList().includes('ja'));
});

test('each language carries the Kokoro lang_code, BCP-47 tag and only native voices', () => {
  const es = resolveDubLanguage('es')!;
  assert.equal(es.kokoroLangCode, 'e');
  assert.equal(es.bcp47, 'es-ES');
  assert.ok([...es.voices.female, ...es.voices.male].every((v) => v.startsWith('e')));
  const fr = resolveDubLanguage('fr')!;
  assert.equal(fr.kokoroLangCode, 'f');
  assert.deepEqual(fr.voices.female, ['ff_siwis']);
  assert.equal(resolveDubLanguage('hi')!.kokoroLangCode, 'h');
  assert.equal(resolveDubLanguage('pt')!.kokoroLangCode, 'p');
  assert.equal(resolveDubLanguage('it')!.kokoroLangCode, 'i');
  assert.equal(resolveDubLanguage('en')!.kokoroLangCode, 'a');
  assert.equal(resolveDubLanguage('en-gb')!.kokoroLangCode, 'b');
});

test('isKokoroVoiceIdAnyLanguage recognises non-English Kokoro ids (am_adam-only regex was the bug)', () => {
  for (const v of ['am_adam', 'bf_emma', 'em_alex', 'ef_dora', 'ff_siwis', 'hm_omega', 'if_sara', 'pm_santa']) {
    assert.equal(isKokoroVoiceIdAnyLanguage(v), true, v);
  }
  for (const v of ['rachel', 'xx_foo', 'am_', '', 'jf_alpha']) {
    assert.equal(isKokoroVoiceIdAnyLanguage(v), false, v);
  }
});

test('assignSpeakerVoices: single speaker with no request gets the language default (never am_adam for es)', () => {
  const es = resolveDubLanguage('es')!;
  const r = assignSpeakerVoices(es, [undefined], undefined);
  assert.equal(r.voiceBySpeaker.get(undefined), 'em_alex');
  assert.equal(r.ignoredRequestedVoice, undefined);
});

test('assignSpeakerVoices: a requested voice of the right language is honoured', () => {
  const es = resolveDubLanguage('es')!;
  const r = assignSpeakerVoices(es, [undefined], 'ef_dora');
  assert.equal(r.voiceBySpeaker.get(undefined), 'ef_dora');
});

test('assignSpeakerVoices: a requested voice from another language is ignored and reported', () => {
  const es = resolveDubLanguage('es')!;
  const r = assignSpeakerVoices(es, [undefined], 'am_adam');
  assert.equal(r.voiceBySpeaker.get(undefined), 'em_alex');
  assert.equal(r.ignoredRequestedVoice, 'am_adam');
});

test('assignSpeakerVoices: distinct speakers get distinct voices, alternating gender, in first-seen order', () => {
  const es = resolveDubLanguage('es')!;
  const r = assignSpeakerVoices(es, ['S0', 'S1', 'S2'], undefined);
  const voices = ['S0', 'S1', 'S2'].map((s) => r.voiceBySpeaker.get(s)!);
  assert.equal(new Set(voices).size, 3);
  assert.equal(voices[0], 'em_alex');
  assert.ok(es.voices.female.includes(voices[1]!), 'second speaker is the other gender');
});

test('assignSpeakerVoices: more speakers than voices wraps around and flags it (French has one female + no male)', () => {
  const fr = resolveDubLanguage('fr')!;
  const r = assignSpeakerVoices(fr, ['A', 'B'], undefined);
  assert.equal(r.voiceBySpeaker.get('A'), 'ff_siwis');
  assert.equal(r.voiceBySpeaker.get('B'), 'ff_siwis');
  assert.equal(r.collapsed, true);
});

test('assignSpeakerVoices: no collapse flag when voices suffice', () => {
  const es = resolveDubLanguage('es')!;
  assert.equal(assignSpeakerVoices(es, ['A', 'B'], undefined).collapsed, false);
});
