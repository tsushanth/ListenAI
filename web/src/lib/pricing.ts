// Single source of truth for prices shown on the web tool pages
// (/transcribe, /dub, /sound-effects, /isolate-voice, /audiobooks).
//
// Values mirror what the site documents today (web/src/app/page.tsx and
// web/src/app/developers/page.tsx). When backend prices change, update this
// file only - no page or component hardcodes a price.
//
// `usd: null` means the site does not currently document a per-use price for
// that tool; the UI then says so instead of inventing a number.

export interface ToolPrice {
  /** USD amount, or null when no price is documented. */
  usd: number | null
  /** What the amount is per, e.g. "hour of audio". */
  unit: string
  /** Extra note appended to the price line, e.g. billing details. */
  note?: string
}

export const PRICING = {
  // Documented: "$0.11 per hour of audio" (developers page, home page).
  speechToText: { usd: 0.11, unit: 'hour of audio', note: 'Billed by the second; failed requests are not billed.' },
  // Not documented on the site today.
  dubbing: { usd: null, unit: 'job' },
  // Not documented on the site today. Cache hits are not billed (backend behavior).
  soundEffects: { usd: null, unit: 'clip' },
  // Not documented on the site today.
  voiceIsolate: { usd: null, unit: 'clip' },
  // Documented: Kokoro voices are "$0.01 per 1,000 characters" (audiobook chapters use Kokoro).
  audiobooks: { usd: 0.01, unit: '1,000 characters', note: 'Same rate as text to speech with Kokoro voices.' },
} as const satisfies Record<string, ToolPrice>

export type PricedTool = keyof typeof PRICING

function fmtUsd(n: number): string {
  // Cents at minimum, up to 3 decimals ($0.11, $0.004, $2.00).
  const s = n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
  const [whole, frac = ''] = s.split('.')
  return `$${whole}.${frac.padEnd(2, '0')}`
}

/** Human-readable price line for a tool page. */
export function priceLine(tool: PricedTool): string {
  const p: ToolPrice = PRICING[tool]
  if (p.usd === null) return 'Requires an active subscription. A per-use price is not published yet.'
  return `${fmtUsd(p.usd)} per ${p.unit}.${p.note ? ` ${p.note}` : ''}`
}
