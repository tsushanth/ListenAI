// Server-issued consent phrase + transcript scoring. The phrase carries random code words so a clip
// recorded earlier (or scraped from somewhere) cannot be replayed: the speaker has to say words they
// could not have known before this request.
import { randomInt } from 'node:crypto';
import { CODE_WORDS_DE, CODE_WORDS_ES } from './consentWords.js';

// Short, common English words. 4 drawn per phrase from ~250 words (~31 bits). Freshness + single use + expiry are what matter; this is not a secret.
export const CODE_WORDS = [
  'amber','anchor','apple','arrow','autumn','badger','balloon','banner','barrel','basket','beacon','berry',
  'bishop','blanket','bridge','bronze','bucket','butter','cabin','camel','candle','canyon','carpet','castle',
  'cedar','cherry','circle','clover','cobalt','copper','cotton','crystal','dancer','delta','desert','diamond',
  'dolphin','dragon','eagle','ember','engine','falcon','feather','ferry','forest','fossil','garden','ginger',
  'glacier','granite','guitar','hammer','harbor','hazel','helmet','honey','island','ivory','jacket','jungle',
  'kettle','kitten','ladder','lantern','lemon','lizard','magnet','maple','marble','meadow','mirror','monkey',
  'mountain','napkin','needle','nickel','ocean','olive','orange','orchid','otter','paddle','panda','pebble',
  'pepper','piano','pillow','planet','pocket','pumpkin','puzzle','rabbit','radio','raven','ribbon','river',
  'rocket','saddle','salmon','sandal','scarlet','shadow','silver','spider','spruce','squirrel','statue','sugar',
  'summer','sunset','table','temple','thunder','ticket','timber','tiger','tomato','tunnel','turtle','velvet',
  'violin','walnut','whistle','window','winter','wizard','yellow','zebra','acorn','alpine','apricot','aspen',
  'bamboo','barley','beetle','birch','biscuit','bobcat','bonfire','breeze','buffalo','cactus','canoe','cheddar',
  'chimney','cinder','citrus','cliff','coconut','comet','cookie','coral','cricket','curtain','daisy','dune',
  'elbow','fiddle','flannel','fountain','galaxy','gadget','gravel','gypsum','harvest','hickory','horizon','iceberg',
  'jasmine','jigsaw','juniper','kayak','lagoon','lavender','lobster','mango','mitten','moose','nectar','nutmeg',
  'oatmeal','oyster','paprika','parrot','peanut','pelican','pickle','pigeon','pretzel','quartz','quilt','radish',
  'raisin','robin','saffron','sailor','sapphire','seagull','sesame','sketch','sparrow','spinach','sponge',
  'stable','sunrise','teapot','thistle','topaz','trumpet','tulip','umbrella','valley','vanilla','violet','waffle',
  'walrus','wagon','willow','yogurt','zipper','almond','anvil','badge','cabbage','cargo','drizzle','fabric',
];

export const PHRASE_TEMPLATE = 'I agree that ReadAloud may create a synthetic copy of my voice. My code words are';
const CODE_WORD_COUNT = 4;

/** Languages the consent phrase can be read in. English is the default and its phrase has not changed. */
export const CONSENT_LANGUAGES = ['en', 'es', 'de'] as const;
export type ConsentLanguage = (typeof CONSENT_LANGUAGES)[number];
export const DEFAULT_CONSENT_LANGUAGE: ConsentLanguage = 'en';

interface PhraseSpec { template: string; words: readonly string[] }
const SPECS: Record<ConsentLanguage, PhraseSpec> = {
  en: { template: PHRASE_TEMPLATE, words: CODE_WORDS },
  es: { template: 'Acepto que ReadAloud cree una copia sintética de mi voz. Mis cuatro palabras son', words: CODE_WORDS_ES },
  de: { template: 'Ich bin einverstanden, dass ReadAloud eine synthetische Kopie meiner Stimme erstellt. Meine vier Wörter lauten', words: CODE_WORDS_DE },
};

export const phraseTemplateFor = (language: ConsentLanguage): string => SPECS[language].template;
export const codeWordsFor = (language: ConsentLanguage): readonly string[] => SPECS[language].words;

/** "de", "DE", "de-AT" and "de_CH" all mean German. Returns null for a language the consent phrase is not offered in. */
export function normalizeConsentLanguage(raw: unknown): ConsentLanguage | null {
  if (typeof raw !== 'string') return null;
  const base = raw.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  return (CONSENT_LANGUAGES as readonly string[]).includes(base) ? (base as ConsentLanguage) : null;
}

/**
 * The language a stored phrase was issued in. The challenge row keeps the phrase text, which starts with the language's
 * template, so the language travels with the challenge without a schema change and the recording is always checked in
 * the language it was issued in. A phrase that matches no template (older rows) is English.
 */
export function languageOfPhrase(phrase: string): ConsentLanguage {
  for (const lang of CONSENT_LANGUAGES) if (lang !== 'en' && phrase.startsWith(SPECS[lang].template)) return lang;
  return 'en';
}

export interface IssuedPhrase {
  phrase: string;
  codeWords: string[];
  language: ConsentLanguage;
}

export function issuePhrase(pick: (maxExclusive: number) => number = (n) => randomInt(n), language: ConsentLanguage = DEFAULT_CONSENT_LANGUAGE): IssuedPhrase {
  const { template, words } = SPECS[language];
  const used = new Set<string>();
  const codeWords: string[] = [];
  while (codeWords.length < CODE_WORD_COUNT) {
    const w = words[pick(words.length)]!;
    if (!used.has(w)) {
      used.add(w);
      codeWords.push(w);
    }
  }
  return { phrase: `${template} ${codeWords.join(', ')}.`, codeWords, language };
}

export function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Words for a language. English is unchanged (a-z, digits, apostrophes). Spanish and German drop accents and write the
 * sharp s as "ss" on both sides, so "Wörter" and "worter", or "Straße" and "Strasse", compare equal.
 */
export function normalizeWordsFor(text: string, language: ConsentLanguage = DEFAULT_CONSENT_LANGUAGE): string[] {
  if (language === 'en') return normalizeWords(text);
  return text
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9'\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Word-level Levenshtein distance / reference length. */
export function wordErrorRate(reference: string[], hypothesis: string[]): number {
  if (reference.length === 0) return hypothesis.length === 0 ? 0 : 1;
  const prev = Array.from({ length: hypothesis.length + 1 }, (_, j) => j);
  for (let i = 1; i <= reference.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= hypothesis.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (reference[i - 1] === hypothesis[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[hypothesis.length]! / reference.length;
}

export interface TranscriptScore {
  wer: number;
  /** True only if every random code word appears in the transcript, in the issued order. */
  codeWordsInOrder: boolean;
}

/** Levenshtein distance between two words (single row). */
export function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/**
 * A heard word counts as the issued code word if it is identical, or (for words of 5+ letters) one letter off.
 * Speech-to-text spells rare words its own way ("sesame" heard as "sessame", "orchid" as "orcid", "quartz" as
 * "quarts"); with exact matching about one phrase in eight failed even for clean synthetic speech. One letter of
 * slack on a word that was said in the right place, with the right neighbours, does not let a replayed or guessed
 * clip through: the words are random per request and all four still have to appear, in order.
 */
export function codeWordHeard(heard: string, word: string): boolean {
  if (heard === word) return true;
  return word.length >= 5 && heard.length >= 4 && Math.abs(heard.length - word.length) <= 1 && editDistance(heard, word) <= 1;
}

/** The service name is one word in the phrase but transcribers write it as two ("read aloud"). */
function joinBrandName(transcript: string): string {
  return transcript.replace(/\bread[\s-]+aloud\b/gi, 'ReadAloud');
}

export function scoreTranscript(phrase: string, codeWords: string[], transcript: string, language: ConsentLanguage = DEFAULT_CONSENT_LANGUAGE): TranscriptScore {
  const hyp = normalizeWordsFor(joinBrandName(transcript), language);
  let cursor = 0;
  let inOrder = true;
  for (const w of codeWords) {
    const target = language === 'en' ? w : (normalizeWordsFor(w, language)[0] ?? w);
    const idx = hyp.findIndex((h, i) => i >= cursor && codeWordHeard(h, target));
    if (idx === -1) {
      inOrder = false;
      break;
    }
    cursor = idx + 1;
  }
  return { wer: wordErrorRate(normalizeWordsFor(phrase, language), hyp), codeWordsInOrder: inOrder };
}
