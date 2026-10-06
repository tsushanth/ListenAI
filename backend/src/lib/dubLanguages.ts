// Dubbing target languages -> Kokoro lang_code, BCP-47 tag and stock voices.
//
// Why this exists: the first dubbing route sent language 'en-US' for every voice and coerced any voice id
// that was not American/British English to am_adam, so Spanish/French/Hindi text was read by an English
// G2P with an English voice (measured in the S3 report: 44% es / 68% fr ASR error, Hindi 2.0x length).
// Kokoro selects the grapheme-to-phoneme front end by lang_code, which is the first letter of the voice id
// (a=American, b=British, e=Spanish, f=French, h=Hindi, i=Italian, p=Brazilian Portuguese, j=Japanese,
// z=Mandarin). Voice ids are from the Kokoro-82M VOICES.md.
//
// Languages deliberately NOT offered:
//  - ja / zh: Kokoro supports them but needs misaki[ja]/misaki[zh] (pyopenjtalk, jieba...) which the TTS
//    service images do not install, and nobody has listened to them. Add after a listening pass.
//  - de, ko, ar, ru, ...: Kokoro has no voices for them. Failing with a 400 beats silently reading German
//    with an English voice.

export type DubLanguageCode = 'en' | 'es' | 'fr' | 'hi' | 'it' | 'pt';

export interface DubLanguage {
  code: DubLanguageCode;
  /** 'en-us' | 'en-gb' for English, otherwise same as code. */
  variant: string;
  /** Name used in the translation prompt. */
  name: string;
  bcp47: string;
  /** Kokoro KPipeline lang_code. */
  kokoroLangCode: string;
  voices: { female: string[]; male: string[] };
  /**
   * Characters per second Kokoro produces at speed 1.0. MEASURED for es/fr/hi from the S3 run (median of
   * unclamped 1.5 s+ segments: es 16.6, fr 17.2, hi 11.1). en/it/pt are NOT measured (estimates); the
   * measured-duration refit corrects any error, this only sizes the translator's length budget.
   */
  charsPerSec: number;
  cpsMeasured: boolean;
  /** Free-text caveat surfaced in the API response. */
  note?: string;
}

const EN_US: DubLanguage = {
  code: 'en', variant: 'en-us', name: 'English', bcp47: 'en-US', kokoroLangCode: 'a',
  voices: { female: ['af_heart', 'af_bella', 'af_nicole', 'af_sarah', 'af_sky'], male: ['am_adam', 'am_michael'] },
  charsPerSec: 15, cpsMeasured: false,
};
const EN_GB: DubLanguage = {
  code: 'en', variant: 'en-gb', name: 'English (British)', bcp47: 'en-GB', kokoroLangCode: 'b',
  voices: { female: ['bf_emma', 'bf_isabella'], male: ['bm_george', 'bm_lewis'] },
  charsPerSec: 15, cpsMeasured: false,
};
const ES: DubLanguage = {
  code: 'es', variant: 'es', name: 'Spanish', bcp47: 'es-ES', kokoroLangCode: 'e',
  voices: { female: ['ef_dora'], male: ['em_alex', 'em_santa'] },
  charsPerSec: 16.6, cpsMeasured: true,
};
const FR: DubLanguage = {
  code: 'fr', variant: 'fr', name: 'French', bcp47: 'fr-FR', kokoroLangCode: 'f',
  // Kokoro ships exactly one French voice: every French speaker collapses onto it.
  voices: { female: ['ff_siwis'], male: [] },
  charsPerSec: 17.2, cpsMeasured: true,
  note: 'Only one French stock voice exists, so multiple speakers share a voice.',
};
const HI: DubLanguage = {
  code: 'hi', variant: 'hi', name: 'Hindi', bcp47: 'hi-IN', kokoroLangCode: 'h',
  voices: { female: ['hf_alpha', 'hf_beta'], male: ['hm_omega', 'hm_psi'] },
  charsPerSec: 11.1, cpsMeasured: true,
  note: 'Hindi intelligibility is the weakest of the supported languages (S3: 46% ASR error, partly confounded by the ASR).',
};
const IT: DubLanguage = {
  code: 'it', variant: 'it', name: 'Italian', bcp47: 'it-IT', kokoroLangCode: 'i',
  voices: { female: ['if_sara'], male: ['im_nicola'] },
  charsPerSec: 16, cpsMeasured: false,
  note: 'Not yet listened to or measured.',
};
const PT: DubLanguage = {
  code: 'pt', variant: 'pt-br', name: 'Brazilian Portuguese', bcp47: 'pt-BR', kokoroLangCode: 'p',
  voices: { female: ['pf_dora'], male: ['pm_alex', 'pm_santa'] },
  charsPerSec: 16, cpsMeasured: false,
  note: 'Not yet listened to or measured. Brazilian Portuguese only.',
};

const BY_KEY: Record<string, DubLanguage> = {
  english: EN_US, en: EN_US, 'en-us': EN_US, 'en-gb': EN_GB, 'british english': EN_GB,
  spanish: ES, es: ES, espanol: ES, 'español': ES,
  french: FR, fr: FR, francais: FR, 'français': FR,
  hindi: HI, hi: HI,
  italian: IT, it: IT, italiano: IT,
  portuguese: PT, pt: PT, 'pt-br': PT, 'brazilian portuguese': PT,
};

/** Resolve a free-text language (name, ISO code, or locale like es-MX / fr_FR) to a supported dub language, or null. */
export function resolveDubLanguage(input: string): DubLanguage | null {
  const key = (input ?? '').trim().toLowerCase().replace(/_/g, '-');
  if (!key) return null;
  if (BY_KEY[key]) return BY_KEY[key]!;
  const base = key.split('-')[0]!;
  // en-GB handled above; any other English locale -> en-us, any other pt locale -> pt-br.
  return BY_KEY[base] ?? null;
}

export function supportedDubLanguageList(): string[] {
  return ['en', 'es', 'fr', 'hi', 'it', 'pt'];
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
