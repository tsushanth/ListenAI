// Banned wording. Comparison pages make claims about other companies, so they avoid superlatives, disparagement, promises that
// cannot be verified, and (for text to speech) any claim about how audio sounds. The check runs on the rendered text of every
// vendor-facing page (compare, alternatives, migrate), which includes the researchers' wording from the vendor JSON, so a
// researcher's "best" fails the build for a published page the same way ours would.
//
// Matching is whole-word and case-insensitive. A word that is part of a company or product name is allowed by passing it in `allowNames`.

export const SUPERLATIVES = [
  'best', 'worst', 'unbeatable', 'only', 'cheapest', 'cheaper', 'fastest', 'leading', 'leader', 'number one', 'top-rated', 'top-tier', 'ultimate',
  'perfect', 'flawless', 'unmatched', 'unrivaled', 'unrivalled', 'superior', 'revolutionary', 'game-changing', 'world-class', 'industry-leading',
  'market-leading', 'best-in-class', 'second to none', 'no competition', 'better than', 'faster than', 'slower than',
]
export const DISPARAGING = [
  'terrible', 'awful', 'horrible', 'bad', 'poor', 'poorly', 'garbage', 'trash', 'junk', 'scam', 'sucks', 'rip-off', 'ripoff', 'overpriced',
  'useless', 'worthless', 'inferior', 'clunky', 'buggy', 'unreliable', 'shady', 'misleading', 'deceptive', 'fraud', 'fraudulent', 'lies', 'lying',
  'beware', 'avoid',
]
export const UNVERIFIABLE = [
  'guaranteed', 'guarantee', 'guarantees', 'always', 'never', '100%', 'risk-free', 'zero risk', 'instantly', 'no-brainer', 'seamless', 'effortless',
  'foolproof', 'bulletproof', 'unlimited',
]
/**
 * Claims about how the audio sounds or how one service performs against another. ReadAloud publishes no quality or benchmark claims on
 * these pages, and does not repeat a vendor's, so the words are banned everywhere (vendor pages and ReadAloud's own pages alike).
 */
export const QUALITY_CLAIMS = [
  'sounds better', 'sound better', 'sounds best', 'better quality', 'higher quality', 'highest quality', 'top quality', 'premium quality', 'more natural', 'most natural',
  'natural-sounding', 'natural sounding', 'human-like', 'humanlike', 'human-sounding', 'lifelike', 'life-like', 'realistic', 'hyper-realistic', 'ultra-realistic',
  'state-of-the-art', 'studio-quality', 'studio quality', 'broadcast-quality', 'broadcast quality', 'crystal clear', 'crystal-clear', 'indistinguishable',
  'outperform', 'outperforms', 'outperformed', 'beats', 'MOS', 'mean opinion score', 'benchmark', 'benchmarks', 'benchmarked', 'preferred by', 'listeners prefer',
  'blind test', 'word error rate', 'WER',
]

/** Vendor-facing pages: everything above. */
export const BANNED_STRICT: readonly string[] = [...SUPERLATIVES, ...DISPARAGING, ...UNVERIFIABLE, ...QUALITY_CLAIMS]
/** Use-case and integration pages: promises, absolute claims and quality claims only ("best practice" is ordinary English there). */
export const BANNED_LITE: readonly string[] = [
  'unbeatable', 'worst', 'guaranteed', 'guarantee', 'guarantees', 'risk-free', 'zero risk', '100%', 'no-brainer', 'world-class', 'industry-leading', 'market-leading',
  'best-in-class', 'cheapest', 'number one', 'foolproof', 'bulletproof', 'flawless', 'perfect', 'better than', 'faster than', ...QUALITY_CLAIMS,
]

// Phrases that contain a banned word but are exact, verifiable facts. Removed before matching.
const EXEMPT_PHRASES = [/english[- ]only/gi, /only english/gi]

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export type BannedHit = { term: string; context: string }

export function findBanned(text: string, banned: readonly string[], allowNames: string[] = []): BannedHit[] {
  let t = text
  for (const re of EXEMPT_PHRASES) t = t.replace(re, ' ')
  for (const n of allowNames) if (n) t = t.replace(new RegExp(escapeRe(n), 'gi'), ' ')
  const hits: BannedHit[] = []
  for (const term of banned) {
    // \b does not work next to %, so test the edges by hand. Short acronyms (MOS, WER) match case-sensitively so "mos" or "wer" inside prose never trips.
    const flags = /^[A-Z]{2,4}$/.test(term) ? 'g' : 'gi'
    const re = new RegExp(`(^|[^A-Za-z0-9_])${escapeRe(term)}(?![A-Za-z0-9_])`, flags)
    let m: RegExpExecArray | null
    while ((m = re.exec(t))) {
      const start = Math.max(0, m.index - 30)
      hits.push({ term, context: t.slice(start, m.index + m[0].length + 30).replace(/\s+/g, ' ').trim() })
    }
  }
  return hits
}
