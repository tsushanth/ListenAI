import { PRICING } from '../lib/pricing.ts'
import { RA_TIERS } from './readaloudFacts.ts'

// The two price lists behind the migration page's price table and cost calculator. Nothing else feeds them.
//
// ElevenLabs: API list prices (pay as you go, USD) as printed on https://elevenlabs.io/pricing/api when we read it on
//   ELEVENLABS_PRICES.retrievedOn. The page prints per 1,000 characters (text to speech) and per hour (speech to text); the per
//   1,000,000 figure is that price times 1,000. The page itself shows no publication date, so the date here is OUR reading date.
//   Plans, enterprise discounts and time-limited promotions (its banner on that day: "30,000 credits for $1", "Ends September 30",
//   no year printed) can make what a customer pays lower; the calculator compares list prices only.
// ReadAloud: RA_TIERS (text to speech, per character) and PRICING.speechToText (per hour of audio), the same values the developers
//   page and the home page print.
//
// To refresh after a price change: re-read the page, edit ELEVENLABS_PRICES, bump retrievedOn. test/migration-prices.test.ts checks that
// every per-1M figure equals the per-1K figure times 1,000 and that the ReadAloud side still equals the developers-page facts.

export const ELEVENLABS_PRICES = {
  retrievedOn: '2026-11-14',
  sourceUrl: 'https://elevenlabs.io/pricing/api',
  basis: 'pay-as-you-go API list prices in USD, before plans, discounts and promotions',
  promotionNote: 'The page showed a promotion banner (30,000 credits for $1, "Ends September 30", no year printed). List prices exclude promotions.',
  tts: [
    { id: 'flash', name: 'Flash / Turbo', per1kUsd: 0.04, per1MUsd: 40 },
    { id: 'v4-turbo', name: 'v4 Turbo', per1kUsd: 0.04, per1MUsd: 40 },
    { id: 'v3-conversational', name: 'v3 Conversational', per1kUsd: 0.04, per1MUsd: 40 },
    { id: 'v4', name: 'v4', per1kUsd: 0.08, per1MUsd: 80 },
    { id: 'v3', name: 'v3', per1kUsd: 0.08, per1MUsd: 80 },
    { id: 'multilingual-v2', name: 'v2 Multilingual', per1kUsd: 0.08, per1MUsd: 80 },
  ],
  stt: {
    batch: { name: 'Scribe v3 (batch)', perHourUsd: 0.2 },
    realtime: { name: 'Scribe v3 Live (realtime)', perHourUsd: 0.22 },
  },
} as const

export type ElTtsId = (typeof ELEVENLABS_PRICES.tts)[number]['id']

/** The ReadAloud side, read from the facts the developers page prints. */
export const READALOUD_PRICES = {
  tts: RA_TIERS.map((t) => ({ id: t.id, name: t.name, per1kUsd: t.per1kUsd, per1MUsd: t.per1MUsd })),
  sttBatchPerHourUsd: PRICING.speechToText.usd,
  /** ReadAloud publishes no realtime speech-to-text price: the batch route is the only public speech-to-text. */
  sttRealtimePerHourUsd: null as number | null,
}

/** A rough bridge from spoken minutes to characters, labelled an assumption wherever it is used (150 words a minute x 6 characters). */
export const CHARS_PER_SPOKEN_MINUTE = 900

/** Plain, serializable lists handed from the server page to the client calculator. */
export type CalculatorLists = {
  elevenlabs: { retrievedOn: string; sourceUrl: string; tts: { id: string; name: string; per1MUsd: number }[]; sttBatchPerHourUsd: number }
  readaloud: { tts: { id: string; name: string; per1MUsd: number }[]; sttBatchPerHourUsd: number }
  charsPerMinute: number
}

export function calculatorLists(): CalculatorLists {
  return {
    elevenlabs: {
      retrievedOn: ELEVENLABS_PRICES.retrievedOn,
      sourceUrl: ELEVENLABS_PRICES.sourceUrl,
      tts: ELEVENLABS_PRICES.tts.map((t) => ({ id: t.id, name: t.name, per1MUsd: t.per1MUsd })),
      sttBatchPerHourUsd: ELEVENLABS_PRICES.stt.batch.perHourUsd,
    },
    readaloud: { tts: READALOUD_PRICES.tts.map((t) => ({ id: t.id, name: t.name, per1MUsd: t.per1MUsd })), sttBatchPerHourUsd: READALOUD_PRICES.sttBatchPerHourUsd },
    charsPerMinute: CHARS_PER_SPOKEN_MINUTE,
  }
}
