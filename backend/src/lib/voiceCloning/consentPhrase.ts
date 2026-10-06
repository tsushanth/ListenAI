// Server-issued consent phrase + transcript scoring. The phrase carries random code words so a clip
// recorded earlier (or scraped from somewhere) cannot be replayed: the speaker has to say words they
// could not have known before this request.
import { randomInt } from 'node:crypto';

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

export interface IssuedPhrase {
  phrase: string;
  codeWords: string[];
}

export function issuePhrase(pick: (maxExclusive: number) => number = (n) => randomInt(n)): IssuedPhrase {
  const used = new Set<string>();
  const codeWords: string[] = [];
  while (codeWords.length < CODE_WORD_COUNT) {
    const w = CODE_WORDS[pick(CODE_WORDS.length)]!;
    if (!used.has(w)) {
      used.add(w);
      codeWords.push(w);
    }
  }
  return { phrase: `${PHRASE_TEMPLATE} ${codeWords.join(', ')}.`, codeWords };
}

export function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
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

export function scoreTranscript(phrase: string, codeWords: string[], transcript: string): TranscriptScore {
  const hyp = normalizeWords(transcript);
  let cursor = 0;
  let inOrder = true;
  for (const w of codeWords) {
    const idx = hyp.indexOf(w, cursor);
    if (idx === -1) {
      inOrder = false;
      break;
    }
    cursor = idx + 1;
  }
  return { wer: wordErrorRate(normalizeWords(phrase), hyp), codeWordsInOrder: inOrder };
}
