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
  assert.equal(resolveDubLanguage('en-GB')?.variant, 'en-gb');
  assert.equal(resolveDubLanguage('English')?.code, 'en');
});

test('resolveDubLanguage returns null for languages with no voices at all', () => {
  for (const l of ['German', 'de', 'Korean', 'Arabic', 'Russian', 'Klingon', '', 'x']) {
    assert.equal(resolveDubLanguage(l), null, l);
  }
});

test('only en and es are offered (Spanish-only pilot); fr/hi/it/pt/ja/zh are known but not offered yet (easy to re-enable)', () => {
  assert.deepEqual(supportedDubLanguageList(), ['en', 'es']);
  for (const l of ['fr', 'French', 'fr-FR', 'hi', 'it', 'pt', 'pt-BR', 'Hindi', 'Italian']) {
    const d = resolveDubLanguage(l);
    assert.ok(d, l);
    assert.equal(d!.offered, false, l);
  }
  for (const l of ['ja', 'zh', 'Japanese', 'Chinese']) assert.equal(resolveDubLanguage(l)?.offered ?? false, false, l);
  for (const l of ['en', 'es']) assert.equal(resolveDubLanguage(l)!.offered, true, l);
});

test('es and fr (when re-enabled) use clean-provenance Piper voices, never Kokoro', () => {
  const es = resolveDubLanguage('es')!;
  const fr = resolveDubLanguage('fr')!;
  assert.equal(es.engine, 'piper');
  assert.equal(fr.engine, 'piper');
  assert.deepEqual(es.voices, { female: ['es-pilot-f'], male: ['es-pilot-m'] });
  assert.deepEqual(fr.voices, { female: ['fr-fr-mls-f'], male: ['fr-fr-mls-m'] });
  assert.equal(es.bcp47, 'es-ES');
  assert.equal(fr.bcp47, 'fr-FR');
  assert.equal(resolveDubLanguage('en')!.engine, 'kokoro');
});

test('the Spanish voice carries the pilot caveat', () => {
  assert.match(resolveDubLanguage('es')!.note ?? '', /pilot/i);
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
  assert.equal(r.voiceBySpeaker.get(undefined), 'es-pilot-m');
  assert.equal(r.ignoredRequestedVoice, undefined);
});

test('assignSpeakerVoices: a requested voice of the right language is honoured', () => {
  const es = resolveDubLanguage('es')!;
  const r = assignSpeakerVoices(es, [undefined], 'es-pilot-f');
  assert.equal(r.voiceBySpeaker.get(undefined), 'es-pilot-f');
});

test('assignSpeakerVoices: a requested voice from another language is ignored and reported', () => {
  const es = resolveDubLanguage('es')!;
  const r = assignSpeakerVoices(es, [undefined], 'am_adam');
  assert.equal(r.voiceBySpeaker.get(undefined), 'es-pilot-m');
  assert.equal(r.ignoredRequestedVoice, 'am_adam');
});

test('assignSpeakerVoices: two speakers get the male and female voice; a Kokoro voice id is not accepted for es', () => {
  const es = resolveDubLanguage('es')!;
  const r = assignSpeakerVoices(es, ['S0', 'S1'], undefined);
  assert.equal(r.voiceBySpeaker.get('S0'), 'es-pilot-m');
  assert.equal(r.voiceBySpeaker.get('S1'), 'es-pilot-f');
  assert.equal(r.collapsed, false);
  const k = assignSpeakerVoices(es, [undefined], 'em_alex');
  assert.equal(k.voiceBySpeaker.get(undefined), 'es-pilot-m');
  assert.equal(k.ignoredRequestedVoice, 'em_alex');
});

test('assignSpeakerVoices: French has two voices now; a third speaker wraps and is flagged', () => {
  const fr = resolveDubLanguage('fr')!;
  const r = assignSpeakerVoices(fr, ['A', 'B', 'C'], undefined);
  assert.equal(r.voiceBySpeaker.get('A'), 'fr-fr-mls-m');
  assert.equal(r.voiceBySpeaker.get('B'), 'fr-fr-mls-f');
  assert.equal(r.voiceBySpeaker.get('C'), 'fr-fr-mls-m');
  assert.equal(r.collapsed, true);
});
