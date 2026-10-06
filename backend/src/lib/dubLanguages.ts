// Dubbing target languages -> Kokoro lang_code, BCP-47 tag and stock voices.
//
// Why this exists: the first dubbing route sent language 'en-US' for every voice and coerced any voice id
// that was not American/British English to am_adam, so Spanish/French/Hindi text was read by an English
// G2P with an English voice (measured in the S3 report: 44% es / 68% fr ASR error, Hindi 2.0x length).
// Kokoro selects the grapheme-to-phoneme front end by lang_code, which is the first letter of the voice id
// (a=American, b=British, e=Spanish, f=French, h=Hindi, i=Italian, p=Brazilian Portuguese, j=Japanese,
// z=Mandarin). Voice ids are from the Kokoro-82M VOICES.md.
//
// ENGINES (owner decision 2026-10-06, memory project_voice_provenance_gate): es and fr dub with PIPER voices whose data and
// lineage are clean (tier A in realtime-tts voices/catalog.json, CC BY 4.0): fr-fr-mls-f/m (Multilingual LibriSpeech) and
// es-pilot-f/m (CML-TTS; a PILOT model, ~15.4k steps, WER ~0.21 by Whisper, accent unlabelled, quality unverified by ear).
// Kokoro is NOT used for Spanish/French (Kokoro Spanish has no data statement). English keeps Kokoro as before.
// The CC BY 4.0 attribution strings for the Piper voices are in each voice's owner.json / catalog.json and must be shown
// wherever the output is published.
//
// Languages known but NOT offered yet (`offered: false` -> 400 "not offered yet"): hi, it, pt (Kokoro only, no listening
// pass, no demand), ja, zh (Kokoro needs misaki[ja/zh], not installed). Re-enable by flipping `offered` once there is a
// provenance-clean engine/voice and a listening pass; nothing else needs to change.
// Languages with no voices at all (de, ko, ar, ru, ...): resolveDubLanguage returns null -> 400 "not supported".

export type DubLanguageCode = 'en' | 'es' | 'fr' | 'hi' | 'it' | 'pt' | 'ja' | 'zh';

export interface DubLanguage {
  code: DubLanguageCode;
  /** 'en-us' | 'en-gb' for English, otherwise same as code. */
  variant: string;
  /** Name used in the translation prompt. */
  name: string;
  bcp47: string;
  /** TTS engine family: 'piper' voices are served by the Piper worker, 'kokoro' by the Kokoro services. */
  engine: 'kokoro' | 'piper';
  /** Offered for dubbing right now? false -> the route answers 400 "not offered yet". */
  offered: boolean;
  /** Kokoro KPipeline lang_code (also the espeak language family letter; informational for Piper voices). */
  kokoroLangCode: string;
  /** Allowed speed (Piper: 1/length_scale) range for the measured-duration refit. */
  speedRange: { min: number; max: number };
  voices: { female: string[]; male: string[] };
  /**
   * Characters per second the voice produces at speed 1.0. MEASURED for the offered Piper es/fr voices (see the constants
   * below) and for Kokoro hi (S3: 11.1); en/it/pt/ja/zh are NOT measured (estimates); the
   * measured-duration refit corrects any error, this only sizes the translator's length budget.
   */
  charsPerSec: number;
  cpsMeasured: boolean;
  /** Free-text caveat surfaced in the API response. */
  note?: string;
}

// MEASURED (Piper es-pilot-m/f 16.1/15.6, fr-fr-mls-m/f 15.0/15.2 chars/s at speed 1.0: median over ~55 S3 translations of 1.5 s+ slots).
const PIPER_CPS_ES = 15.8;
const PIPER_CPS_FR = 15.1;
const KOKORO_SPEED = { min: 0.8, max: 1.7 };
const PIPER_SPEED = { min: 0.8, max: 1.5 }; // Piper: speed = 1/length_scale; see PR notes for the measured trade-off

const EN_US: DubLanguage = {
  code: 'en', variant: 'en-us', name: 'English', bcp47: 'en-US', engine: 'kokoro', offered: true, kokoroLangCode: 'a', speedRange: KOKORO_SPEED,
  voices: { female: ['af_heart', 'af_bella', 'af_nicole', 'af_sarah', 'af_sky'], male: ['am_adam', 'am_michael'] },
  charsPerSec: 15, cpsMeasured: false,
};
const EN_GB: DubLanguage = {
  code: 'en', variant: 'en-gb', name: 'English (British)', bcp47: 'en-GB', engine: 'kokoro', offered: true, kokoroLangCode: 'b', speedRange: KOKORO_SPEED,
  voices: { female: ['bf_emma', 'bf_isabella'], male: ['bm_george', 'bm_lewis'] },
  charsPerSec: 15, cpsMeasured: false,
};
const ES: DubLanguage = {
  code: 'es', variant: 'es', name: 'Spanish', bcp47: 'es-ES', engine: 'piper', offered: true, kokoroLangCode: 'e', speedRange: PIPER_SPEED,
  voices: { female: ['es-pilot-f'], male: ['es-pilot-m'] },
  charsPerSec: PIPER_CPS_ES, cpsMeasured: true,
  note: 'Spanish uses a PILOT Piper voice (CML-TTS, 15.4k training steps, accent unlabelled): quality is unverified by ear and the speakers are LibriVox readers.',
};
const FR: DubLanguage = {
  code: 'fr', variant: 'fr', name: 'French', bcp47: 'fr-FR', engine: 'piper', offered: true, kokoroLangCode: 'f', speedRange: PIPER_SPEED,
  voices: { female: ['fr-fr-mls-f'], male: ['fr-fr-mls-m'] },
  charsPerSec: PIPER_CPS_FR, cpsMeasured: true,
  note: 'French voices are audiobook-paced Multilingual LibriSpeech readers; expect a slow, read-aloud delivery.',
};
// Not offered (see header). Kokoro-only, unlistened; kept so re-enabling is a one-line flip once a clean engine exists.
const HI: DubLanguage = {
  code: 'hi', variant: 'hi', name: 'Hindi', bcp47: 'hi-IN', engine: 'kokoro', offered: false, kokoroLangCode: 'h', speedRange: KOKORO_SPEED,
  voices: { female: ['hf_alpha', 'hf_beta'], male: ['hm_omega', 'hm_psi'] },
  charsPerSec: 11.1, cpsMeasured: true,
};
const IT: DubLanguage = {
  code: 'it', variant: 'it', name: 'Italian', bcp47: 'it-IT', engine: 'kokoro', offered: false, kokoroLangCode: 'i', speedRange: KOKORO_SPEED,
  voices: { female: ['if_sara'], male: ['im_nicola'] },
  charsPerSec: 16, cpsMeasured: false,
};
const PT: DubLanguage = {
  code: 'pt', variant: 'pt-br', name: 'Brazilian Portuguese', bcp47: 'pt-BR', engine: 'kokoro', offered: false, kokoroLangCode: 'p', speedRange: KOKORO_SPEED,
  voices: { female: ['pf_dora'], male: ['pm_alex', 'pm_santa'] },
  charsPerSec: 16, cpsMeasured: false,
};
const JA: DubLanguage = {
  code: 'ja', variant: 'ja', name: 'Japanese', bcp47: 'ja-JP', engine: 'kokoro', offered: false, kokoroLangCode: 'j', speedRange: KOKORO_SPEED,
  voices: { female: ['jf_alpha'], male: ['jm_kumo'] },
  charsPerSec: 7, cpsMeasured: false,
};
const ZH: DubLanguage = {
  code: 'zh', variant: 'zh', name: 'Chinese (Mandarin)', bcp47: 'zh-CN', engine: 'kokoro', offered: false, kokoroLangCode: 'z', speedRange: KOKORO_SPEED,
  voices: { female: ['zf_xiaobei'], male: ['zm_yunjian'] },
  charsPerSec: 5.5, cpsMeasured: false,
};

const BY_KEY: Record<string, DubLanguage> = {
  english: EN_US, en: EN_US, 'en-us': EN_US, 'en-gb': EN_GB, 'british english': EN_GB,
  spanish: ES, es: ES, espanol: ES, 'español': ES,
  french: FR, fr: FR, francais: FR, 'français': FR,
  hindi: HI, hi: HI,
  italian: IT, it: IT, italiano: IT,
  portuguese: PT, pt: PT, 'pt-br': PT, 'brazilian portuguese': PT,
  japanese: JA, ja: JA,
  chinese: ZH, zh: ZH, mandarin: ZH, 'zh-cn': ZH,
};

/**
 * Resolve a free-text language (name, ISO code, or locale like es-MX / fr_FR) to a known dub language, or null if we have
 * no voices for it at all. A returned language may still have `offered: false`.
 */
export function resolveDubLanguage(input: string): DubLanguage | null {
  const key = (input ?? '').trim().toLowerCase().replace(/_/g, '-');
  if (!key) return null;
  if (BY_KEY[key]) return BY_KEY[key]!;
  const base = key.split('-')[0]!;
  // en-GB handled above; any other English locale -> en-us, any other pt locale -> pt-br.
  return BY_KEY[base] ?? null;
}

export function supportedDubLanguageList(): string[] {
  return ['en', 'es', 'fr'];
}

// Kokoro voice ids: <lang letter><gender f|m>_<name>. ja/zh letters (j, z) are excluded: see header.
const KOKORO_ID = /^[abefhip][fm]_[a-z0-9]+$/;
export function isKokoroVoiceIdAnyLanguage(voiceId: string): boolean {
  return KOKORO_ID.test(voiceId ?? '');
}

export interface SpeakerVoiceAssignment {
  voiceBySpeaker: Map<string | undefined, string>;
  /** The requested voice_id, if it was not a voice of the target language and was therefore ignored. */
  ignoredRequestedVoice?: string;
  /** True when there are more distinct speakers than distinct voices (two speakers share a voice). */
  collapsed: boolean;
}

/**
 * Map each speaker label to a stock voice of the target language. `speakers` is the list of distinct speaker
 * labels in first-seen order (use [undefined] when the STT output carries no speaker labels, which is the
 * case today: worker-stt-prod does not diarize). The first speaker gets the requested voice when it belongs
 * to the target language, else the language default (first male voice, else first female). Further speakers
 * alternate gender, then reuse the remaining voices, then wrap.
 */
export function assignSpeakerVoices(
  lang: DubLanguage,
  speakers: Array<string | undefined>,
  requestedVoiceId: string | undefined
): SpeakerVoiceAssignment {
  const all = [...lang.voices.male, ...lang.voices.female];
  let first: string;
  let ignored: string | undefined;
  if (requestedVoiceId && all.includes(requestedVoiceId)) {
    first = requestedVoiceId;
  } else {
    if (requestedVoiceId) ignored = requestedVoiceId;
    first = lang.voices.male[0] ?? lang.voices.female[0]!;
  }
  const firstIsMale = lang.voices.male.includes(first);
  const same = firstIsMale ? lang.voices.male : lang.voices.female;
  const other = firstIsMale ? lang.voices.female : lang.voices.male;

  // Order: first, then alternate other/same genders so adjacent speakers sound different.
  const order: string[] = [first];
  const o = other.filter((v) => v !== first);
  const s = same.filter((v) => v !== first);
  while (o.length || s.length) {
    if (o.length) order.push(o.shift()!);
    if (s.length) order.push(s.shift()!);
  }

  const voiceBySpeaker = new Map<string | undefined, string>();
  speakers.forEach((sp, i) => voiceBySpeaker.set(sp, order[i % order.length]!));
  return { voiceBySpeaker, ignoredRequestedVoice: ignored, collapsed: speakers.length > order.length };
}
