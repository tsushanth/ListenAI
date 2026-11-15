// Pure arithmetic for the migration page's cost calculator. No imports, no network, no clock: the price lists are passed in.

export const MAX_INPUT = 1e12

/** Parse what a visitor typed ("10,000,000", "2.5", " 40 ") into a finite, non-negative number; anything else is 0. */
export function parseAmount(raw: string | number): number {
  const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[,_\s]/g, ''))
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.min(n, MAX_INPUT)
}

/** Text to speech: characters per month at a price per 1,000,000 characters. */
export function ttsCostUsd(characters: number, per1MUsd: number): number {
  return (parseAmount(characters) / 1_000_000) * per1MUsd
}

/** Speech to text: hours of audio per month at a price per hour. */
export function sttCostUsd(hours: number, perHourUsd: number): number {
  return parseAmount(hours) * perHourUsd
}

export const minutesToCharacters = (minutes: number, charsPerMinute: number): number => parseAmount(minutes) * charsPerMinute

export type CostInput = {
  characters: number
  sttHours: number
  elTtsPer1MUsd: number
  raTtsPer1MUsd: number
  elSttPerHourUsd: number
  raSttPerHourUsd: number
}
export type CostResult = {
  elTts: number
  raTts: number
  elStt: number
  raStt: number
  elTotal: number
  raTotal: number
  /** raTotal - elTotal; negative means ReadAloud costs less at list price. */
  difference: number
  /** 0 to 100: how much less ReadAloud costs than ElevenLabs at list price (negative when it costs more); null when the ElevenLabs total is 0. */
  percentLower: number | null
}

export function compareCosts(i: CostInput): CostResult {
  const elTts = ttsCostUsd(i.characters, i.elTtsPer1MUsd)
  const raTts = ttsCostUsd(i.characters, i.raTtsPer1MUsd)
  const elStt = sttCostUsd(i.sttHours, i.elSttPerHourUsd)
  const raStt = sttCostUsd(i.sttHours, i.raSttPerHourUsd)
  const elTotal = elTts + elStt
  const raTotal = raTts + raStt
  return { elTts, raTts, elStt, raStt, elTotal, raTotal, difference: raTotal - elTotal, percentLower: elTotal > 0 ? ((elTotal - raTotal) / elTotal) * 100 : null }
}

/** "$1,234.50", "$0.04", "$0.036", "$0.0036": two decimals from a dollar up; below a dollar up to four, trailing zeros trimmed to at least cents. */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return '$0.00'
  const abs = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  if (abs === 0) return '$0.00'
  if (abs >= 1) return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`
}
