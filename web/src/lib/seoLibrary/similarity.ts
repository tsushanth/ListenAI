import { wordsOf } from './text.ts'

// Near-duplicate detection between pages of the same type. Pages are compared as sets of overlapping 5-word shingles (a "shingle" is
// five consecutive words), the standard test for near-duplicate documents.
//
//   jaccard(a, b)  = |shingles(a) intersect shingles(b)| / |shingles(a) union shingles(b)|     1 = identical, 0 = nothing in common
//   uniqueShare(p) = share of page p's shingles that appear on no other page of its type
//
// Thresholds (SIMILARITY below): shared template wording (headings, the pricing paragraph, the disclaimer) is tolerated, but a page
// that is mostly boilerplate fails. Two pages of one type may overlap at most 50% (Jaccard), and each page must have at least 40% of
// its shingles to itself. Change the numbers only here; the validator and the tests read them from this object.

export const SIMILARITY = {
  shingleWords: 5,
  maxPairJaccard: 0.5,
  warnPairJaccard: 0.35,
  minUniqueShare: 0.4,
  warnUniqueShare: 0.5,
} as const

export function shingles(text: string, n: number = SIMILARITY.shingleWords): Set<string> {
  const w = wordsOf(text)
  const out = new Set<string>()
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' '))
  return out
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  let inter = 0
  const [small, big] = a.size < b.size ? [a, b] : [b, a]
  for (const s of Array.from(small)) if (big.has(s)) inter++
  return inter / (a.size + b.size - inter)
}

export type SimilarityReport = {
  pairs: { a: string; b: string; jaccard: number }[]
  unique: { id: string; share: number; shingles: number }[]
  maxJaccard: number
  minUnique: number
}

export function similarityReport(items: { id: string; text: string }[]): SimilarityReport {
  const sets = items.map((i) => ({ id: i.id, s: shingles(i.text) }))
  const pairs: SimilarityReport['pairs'] = []
  for (let i = 0; i < sets.length; i++) for (let j = i + 1; j < sets.length; j++) pairs.push({ a: sets[i].id, b: sets[j].id, jaccard: jaccard(sets[i].s, sets[j].s) })
  const count = new Map<string, number>()
  for (const { s } of sets) for (const sh of Array.from(s)) count.set(sh, (count.get(sh) ?? 0) + 1)
  const unique = sets.map(({ id, s }) => {
    let own = 0
    for (const sh of Array.from(s)) if (count.get(sh) === 1) own++
    return { id, shingles: s.size, share: s.size ? own / s.size : 0 }
  })
  return { pairs, unique, maxJaccard: pairs.reduce((m, p) => Math.max(m, p.jaccard), 0), minUnique: unique.reduce((m, u) => Math.min(m, u.share), 1) }
}
