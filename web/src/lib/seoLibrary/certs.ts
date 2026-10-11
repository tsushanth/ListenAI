// Certification and compliance statements. A page may say a company is HIPAA/SOC 2/... compliant or certified only when the data
// supports it: a vendor's JSON says 'stated' for it (hipaa, soc2, gdpr), or, for ReadAloud, the allow-list in
// src/content/readaloudFacts.ts names it (empty today). This is a heuristic over rendered sentences, not a legal review: it flags
// affirmative wording, and lets through negations ("does not claim HIPAA compliance") and requirement language ("you may need to be
// HIPAA compliant"). A human still reads every page before it is published (see the hand-off steps).

export type CertKey = 'hipaa' | 'soc2' | 'soc3' | 'gdpr' | 'iso27001' | 'pci' | 'fedramp' | 'hitrust'

const CERT_TERMS: { key: CertKey; re: string }[] = [
  { key: 'hipaa', re: 'HIPAA' },
  { key: 'soc2', re: 'SOC[\\s-]?2' },
  { key: 'soc3', re: 'SOC[\\s-]?3' },
  { key: 'gdpr', re: 'GDPR' },
  { key: 'iso27001', re: 'ISO[\\s-]?27001' },
  { key: 'pci', re: 'PCI(?:[\\s-]DSS)?' },
  { key: 'fedramp', re: 'FedRAMP' },
  { key: 'hitrust', re: 'HITRUST' },
]

const ALL = CERT_TERMS.map((c) => c.re).join('|')
const TYPE = '(?:\\s+Type\\s+(?:I{1,2}|1|2))?(?:\\s+v?[\\d.]+)?'
const WORDS = 'compliant|compliance|certified|certification|attested|attestation|audited|ready|approved|accredited|verified|validated|eligible|report'
const VERBS = 'supports?|supported|offers?|provides?|includes?|has|have|meets?|follows?|adheres?\\s+to|aligns?\\s+with|complies\\s+with|is|are|we\'re|we\\s+are|with|under'

// "HIPAA compliant", "SOC 2 Type II certified", "HIPAA-ready"
const AFTER = new RegExp(`\\b(${ALL})${TYPE}[\\s-]+(?:${WORDS})\\b`, 'i')
// "compliant with HIPAA", "certified under SOC 2"
const BEFORE = new RegExp(`\\b(?:${WORDS})\\s+(?:with|to|under|for|against)\\s+(${ALL})\\b`, 'i')
// "supports HIPAA", "is SOC 2", "we are HIPAA"
const VERB = new RegExp(`\\b(?:${VERBS})\\s+(?:full\\s+|a\\s+|the\\s+)?(${ALL})\\b`, 'i')

const NEGATION = /\b(not|no|isn't|aren't|doesn't|don't|does not|do not|cannot|can't|without|never|neither|nor|none|lack|lacks|lacking|unless|until|n't)\b/i
const REQUIREMENT = /\b(must|should|need|needs|needed|require|required|requires|requirement|requirements|if|whether|ask|asks|verify|confirm|check|may|might|could|can|ensure|want|wants|wanting|looking for|when|before|depending|rules?|regulations?|laws?|obligations?|expected|expect|subject to|covered by|apply|applies)\b/i

// A negation AFTER the match: "HIPAA, SOC 2 and GDPR compliance statements were not found." The words before the match carry no negation, so
// the check above misreads it as a claim. Narrow on purpose: the negation must follow within three words and be about finding or stating
// the claim ("not found", "were not stated", "is not listed"); "is HIPAA compliant" and "HIPAA compliant, and not expensive" still match.
const TRAILING_NEGATION = /^[\s,]*(?:[\w-]+\s+){0,3}?(?:(?:were|was|are|is|could|can|did)\s+)?not\s+(?:been\s+)?(?:found|stated|listed|published|available|located|identified|confirmed|verified|claimed)\b/i

export function certKeyOf(term: string): CertKey | null {
  for (const c of CERT_TERMS) if (new RegExp(`^${c.re}$`, 'i').test(term.trim())) return c.key
  return null
}

export type CertClaim = { cert: CertKey; sentence: string; raSubject: boolean }

// The pronoun "us" is matched in lowercase only, so the country abbreviation "US" ("regional data residency (US, EU, India)") is not read as ReadAloud.
const RA_US = /\bus\b/
const isRaSubject = (s: string) => /\b(readaloud|we|our|ours)\b/i.test(s) || RA_US.test(s)

export function splitSentences(text: string): string[] {
  return text.split(/\n+/).flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z"'(])/)).map((s) => s.trim()).filter(Boolean)
}

/** Affirmative certification statements: not negated, not requirement or hedge language. */
export function findCertClaims(text: string): CertClaim[] {
  const out: CertClaim[] = []
  for (const sentence of splitSentences(text)) {
    for (const re of [AFTER, BEFORE, VERB]) {
      const m = re.exec(sentence)
      if (!m) continue
      const cert = certKeyOf(m[1].replace(/\s+Type.*$/i, '').trim()) ?? certKeyOf(m[1])
      if (!cert) continue
      const before = sentence.slice(Math.max(0, m.index - 120), m.index + m[0].length)
      if (NEGATION.test(before) || REQUIREMENT.test(before)) continue
      if (TRAILING_NEGATION.test(sentence.slice(m.index + m[0].length))) continue
      out.push({ cert, sentence, raSubject: isRaSubject(sentence) })
      break
    }
  }
  return out
}
