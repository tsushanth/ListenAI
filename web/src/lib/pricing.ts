// Single source of truth for prices shown on the web tool pages
// (/transcribe, /dub, /sound-effects, /isolate-voice, /audiobooks).
//
// Values mirror what the site documents today (web/src/app/page.tsx and
// web/src/app/developers/page.tsx). When backend prices change, update this
// file only - no page or component hardcodes a price.
//
// Free credits: every account gets a one-time grant, usable across these tools. Keep FREE_CREDIT_UNITS in
// sync with backend/src/lib/realtimeTtsBilling.ts. One unit = $0.00001 (the character meter's unit), so
// 10,000 units = $0.10 = 10,000 characters of speech.
export const FREE_CREDIT_UNITS = 10000
export const FREE_CREDIT_USD = 0.1

/** Friendly line for a free-credit balance in meter units, e.g. "about 10,000 characters of speech". */
export function creditsAsCharacters(units: number): string {
  const n = Math.max(0, Math.round(units))
  return `about ${n.toLocaleString('en-US')} characters of speech`
}

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
  // Documented: "$0.15 per minute of source audio", by the second, 30 s minimum.
  dubbing: { usd: 0.15, unit: 'minute of source audio', note: 'Billed by the second (30 second minimum); failed jobs are not billed.' },
  // Documented: "$0.0015 per second of generated audio". Cache hits are not billed (backend behavior).
  soundEffects: { usd: 0.0015, unit: 'second of generated audio', note: '4 second minimum; cache hits are free.' },
  // Documented: "$0.05 per minute of input audio", by the second, 45 s minimum.
  voiceIsolate: { usd: 0.05, unit: 'minute of audio', note: 'Billed by the second (45 second minimum); failed jobs are not billed.' },
  // Documented: Kokoro voices are "$0.01 per 1,000 characters" (audiobook chapters use Kokoro).
  audiobooks: { usd: 0.01, unit: '1,000 characters', note: 'Same rate as text to speech with Kokoro voices.' },
} as const satisfies Record<string, ToolPrice>

export type PricedTool = keyof typeof PRICING

function fmtUsd(n: number): string {
  // Cents at minimum, up to 4 decimals ($0.11, $0.004, $0.0015, $2.00).
  const s = n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
  const [whole, frac = ''] = s.split('.')
  return `$${whole}.${frac.padEnd(2, '0')}`
}

/** Human-readable price line for a tool page. */
export function priceLine(tool: PricedTool): string {
  const p: ToolPrice = PRICING[tool]
  if (p.usd === null) return 'Free credits, then a payment method. A per-use price is not published yet.'
  return `${fmtUsd(p.usd)} per ${p.unit}.${p.note ? ` ${p.note}` : ''}`
}
