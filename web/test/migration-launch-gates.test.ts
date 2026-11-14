// Launch gates for the ReadAloud API go-to-market: the migration page's price lists and cost calculator, the availability flags,
// the parity table, llms.txt, and the refreshed ElevenLabs compare and alternatives pages. Pure checks, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ELEVENLABS_PRICES, READALOUD_PRICES, CHARS_PER_SPOKEN_MINUTE, calculatorLists } from '../src/content/migrationPrices.ts'
import { RA_TIERS } from '../src/content/readaloudFacts.ts'
import { PRICING } from '../src/lib/pricing.ts'
import { compareCosts, formatUsd, minutesToCharacters, parseAmount, sttCostUsd, ttsCostUsd } from '../src/lib/migrationCalc.ts'
import { LAUNCH_FLAGS, availability, availabilityLabel, type LaunchFlag } from '../src/content/launchFlags.ts'
import { PARITY_ROWS, STATUS_LABEL, shownStatus } from '../src/content/migrationParity.ts'
import { loadLibrary } from '../src/lib/seoLibrary/load.ts'
import { buildPages } from '../src/lib/seoLibrary/pages.ts'
import { textOfPage } from '../src/lib/seoLibrary/text.ts'

const WEB = process.cwd()
const read = (rel: string) => fs.readFileSync(path.join(WEB, rel), 'utf8')

// ---------------------------------------------------------------- price lists

test('ElevenLabs list: every per-1M price is the per-1K price times 1,000, dated and sourced', () => {
  assert.match(ELEVENLABS_PRICES.retrievedOn, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(ELEVENLABS_PRICES.sourceUrl, 'https://elevenlabs.io/pricing/api')
  for (const t of ELEVENLABS_PRICES.tts) assert.equal(Math.round(t.per1kUsd * 1000 * 1e6), Math.round(t.per1MUsd * 1e6), t.name)
  const by = Object.fromEntries(ELEVENLABS_PRICES.tts.map((t) => [t.id, t.per1MUsd]))
  assert.deepEqual(by, { flash: 40, 'v4-turbo': 40, 'v3-conversational': 40, v4: 80, v3: 80, 'multilingual-v2': 80 })
})

test('ElevenLabs Scribe row is what the pricing page showed on 2026-11-14: 0.20 batch, 0.22 realtime (not the stale 0.22 / 0.39)', () => {
  assert.equal(ELEVENLABS_PRICES.stt.batch.perHourUsd, 0.2)
  assert.equal(ELEVENLABS_PRICES.stt.realtime.perHourUsd, 0.22)
  for (const f of ['src/app/page.tsx', 'src/app/developers/page.tsx', 'src/app/developers/migrate-from-elevenlabs/page.tsx', 'public/llms.txt']) {
    const t = read(f)
    assert.ok(!/\$0\.39/.test(t), `${f} still has the stale realtime price`)
    assert.ok(!/half of ElevenLabs Scribe/.test(t), `${f} still says half of Scribe`)
  }
})

test('ReadAloud side of the lists equals the facts the developers page prints', () => {
  assert.deepEqual(READALOUD_PRICES.tts.map((t) => [t.id, t.per1kUsd, t.per1MUsd]), RA_TIERS.map((t) => [t.id, t.per1kUsd, t.per1MUsd]))
  assert.equal(READALOUD_PRICES.sttBatchPerHourUsd, PRICING.speechToText.usd)
  assert.equal(READALOUD_PRICES.sttBatchPerHourUsd, 0.11)
  const lists = calculatorLists()
  assert.equal(lists.charsPerMinute, CHARS_PER_SPOKEN_MINUTE)
  assert.equal(lists.readaloud.tts.length, RA_TIERS.length)
  assert.equal(lists.elevenlabs.tts.length, ELEVENLABS_PRICES.tts.length)
  JSON.stringify(lists) // serializable: it crosses the server/client boundary
})

// ---------------------------------------------------------------- calculator arithmetic

test('calculator: the plan volumes (1M, 10M, 100M characters) give the list-price figures', () => {
  assert.equal(ttsCostUsd(1_000_000, 40), 40)
  assert.equal(ttsCostUsd(10_000_000, 40), 400)
  assert.equal(ttsCostUsd(10_000_000, 80), 800)
  assert.equal(ttsCostUsd(10_000_000, 4), 40)
  assert.equal(ttsCostUsd(10_000_000, 10), 100)
  assert.equal(ttsCostUsd(100_000_000, 4), 400)
  assert.equal(ttsCostUsd(100_000_000, 80), 8000)
})

test('calculator: totals, difference and percentage, with speech to text', () => {
  const r = compareCosts({ characters: 10_000_000, sttHours: 100, elTtsPer1MUsd: 40, raTtsPer1MUsd: 4, elSttPerHourUsd: 0.2, raSttPerHourUsd: 0.11 })
  assert.equal(r.elTts, 400)
  assert.equal(r.raTts, 40)
  assert.ok(Math.abs(r.elStt - 20) < 1e-9)
  assert.ok(Math.abs(r.raStt - 11) < 1e-9)
  assert.ok(Math.abs(r.elTotal - 420) < 1e-9)
  assert.ok(Math.abs(r.raTotal - 51) < 1e-9)
  assert.ok(Math.abs(r.difference + 369) < 1e-9)
  assert.ok(Math.abs((r.percentLower as number) - (369 / 420) * 100) < 1e-9)
})

test('calculator: zero volume, no division by zero, and a ReadAloud price above the vendor reads as higher', () => {
  const z = compareCosts({ characters: 0, sttHours: 0, elTtsPer1MUsd: 40, raTtsPer1MUsd: 4, elSttPerHourUsd: 0.2, raSttPerHourUsd: 0.11 })
  assert.equal(z.elTotal, 0)
  assert.equal(z.percentLower, null)
  const higher = compareCosts({ characters: 1_000_000, sttHours: 0, elTtsPer1MUsd: 4, raTtsPer1MUsd: 10, elSttPerHourUsd: 0, raSttPerHourUsd: 0 })
  assert.ok(higher.difference > 0)
  assert.ok((higher.percentLower as number) < 0)
})

test('calculator: input parsing is forgiving and safe', () => {
  assert.equal(parseAmount('10,000,000'), 10_000_000)
  assert.equal(parseAmount(' 2.5 '), 2.5)
  assert.equal(parseAmount('1_000'), 1000)
  for (const bad of ['', 'abc', '-5', 'NaN', 'Infinity', '1e999']) assert.equal(parseAmount(bad), 0, bad)
  assert.equal(parseAmount('9'.repeat(30)), 1e12, 'capped')
  assert.equal(parseAmount(Number.NaN), 0)
  assert.equal(ttsCostUsd(Number.NaN, 40), 0)
  assert.equal(sttCostUsd(-3, 0.2), 0)
})

test('calculator: minutes of speech use the labelled 900 characters-a-minute assumption', () => {
  assert.equal(CHARS_PER_SPOKEN_MINUTE, 900)
  assert.equal(minutesToCharacters(10, CHARS_PER_SPOKEN_MINUTE), 9000)
  // one minute on ReadAloud Live vs ElevenLabs Flash, the figures quoted in the go-to-market plan
  assert.equal(formatUsd(ttsCostUsd(900, 4)), '$0.0036')
  assert.equal(formatUsd(ttsCostUsd(900, 40)), '$0.036')
})

test('formatUsd: two decimals from a dollar, up to four below (trailing zeros trimmed to cents), never NaN', () => {
  assert.equal(formatUsd(400), '$400.00')
  assert.equal(formatUsd(1234.5), '$1,234.50')
  assert.equal(formatUsd(0.04), '$0.04')
  assert.equal(formatUsd(0.2), '$0.20')
  assert.equal(formatUsd(0.004), '$0.004')
  assert.equal(formatUsd(0.0015), '$0.0015')
  assert.equal(formatUsd(0.01), '$0.01')
  assert.equal(formatUsd(0), '$0.00')
  assert.equal(formatUsd(Number.NaN), '$0.00')
  assert.equal(formatUsd(-3), '-$3.00')
})

test('calculator component: client only, no network, storage or analytics, fed by the page lists', () => {
  const src = read('src/components/ra/MigrationCostCalculator.tsx')
  assert.match(src, /^'use client'/)
  for (const bad of ['fetch(', 'XMLHttpRequest', 'sendBeacon', 'localStorage', 'sessionStorage', 'WebSocket', 'posthog', 'gtag', 'analytics']) assert.ok(!src.includes(bad), `calculator uses ${bad}`)
  assert.ok(src.includes("from '@/lib/migrationCalc'"))
  assert.ok(!/\$\d/.test(src.replace(/\$\{[^}]*\}/g, '')), 'no price typed in the component')
  const page = read('src/app/developers/migrate-from-elevenlabs/page.tsx')
  assert.ok(page.includes('<MigrationCostCalculator lists={calculatorLists()} />'))
})

// ---------------------------------------------------------------- availability flags

test('launch flags: everything is "coming soon" until a person verifies it live', () => {
  for (const f of Object.keys(LAUNCH_FLAGS) as LaunchFlag[]) {
    assert.equal(LAUNCH_FLAGS[f], false, f)
    assert.equal(availability(f), 'coming-soon')
    assert.equal(availabilityLabel(f), 'Coming soon')
  }
})

test('parity table: flagged rows read "Coming soon" off and their real status on; the others never depend on a flag', () => {
  const on = Object.fromEntries((Object.keys(LAUNCH_FLAGS) as LaunchFlag[]).map((f) => [f, true])) as Record<LaunchFlag, boolean>
  const off = Object.fromEntries((Object.keys(LAUNCH_FLAGS) as LaunchFlag[]).map((f) => [f, false])) as Record<LaunchFlag, boolean>
  const flagged = PARITY_ROWS.filter((r) => r.flag)
  assert.ok(flagged.length >= 4)
  for (const r of flagged) {
    assert.equal(shownStatus(r, off), 'coming-soon', r.feature)
    assert.equal(shownStatus(r, on), r.status, r.feature)
  }
  for (const r of PARITY_ROWS.filter((x) => !x.flag)) assert.equal(shownStatus(r, off), r.status)
  assert.ok(PARITY_ROWS.some((r) => r.status === 'works') && PARITY_ROWS.some((r) => r.status === 'partial') && PARITY_ROWS.some((r) => r.status === 'not-yet'))
  assert.deepEqual(Object.keys(STATUS_LABEL).sort(), ['coming-soon', 'not-yet', 'partial', 'works'])
  for (const f of ['elevenLabsSpeechToText', 'elevenLabsInstantClone', 'oneKeyEverywhere'] as const) assert.ok(flagged.some((r) => r.flag === f), f)
})

test('parity table says what ElevenLabs is ahead on, and keeps the not-yet list', () => {
  const text = PARITY_ROWS.map((r) => `${r.feature} ${r.note}`).join(' ')
  assert.match(text, /ElevenLabs is far ahead/)
  assert.match(text, /Audio tags/)
  assert.match(text, /Realtime transcription/)
  assert.match(text, /Pronunciation dictionaries/)
})

test('llms.txt wording follows the launch flags', () => {
  const t = read('public/llms.txt')
  const line = (needle: string) => t.split('\n').find((l) => l.includes(needle)) ?? ''
  const cases: [LaunchFlag, string][] = [
    ['elevenLabsSpeechToText', 'POST /v1/speech-to-text'],
    ['elevenLabsInstantClone', 'POST /v1/voices/add'],
    ['oneKeyEverywhere', 'One rtts_ key on every REST family'],
  ]
  for (const [flag, needle] of cases) {
    const l = line(needle)
    assert.ok(l, `llms.txt has a line for ${needle}`)
    assert.equal(/coming soon/i.test(l), !LAUNCH_FLAGS[flag], `${flag}: llms.txt must say coming soon exactly while the flag is off`)
  }
})

test('llms.txt carries the migrate page, routes, prices, limits and what is unsupported', () => {
  const t = read('public/llms.txt')
  for (const needle of [
    'https://readaloudai.org/developers/migrate-from-elevenlabs', 'https://api.readaloudai.org', '/v1/text-to-speech/{voice_id}', 'stream-input', '/v1/voices', '/v1/models', '/v1/audio/speech',
    '$0.004 per 1,000', '$0.01 per 1,000', '$0.11 per hour', '$0.20 per hour', '$0.22 per hour', '2026-11-14', '5,000 characters per request', '429', '1013',
    'Not supported yet', 'emotion control', 'pronunciation dictionaries', 'realtime speech to text', 'ElevenLabs Flash was faster',
  ]) assert.ok(t.includes(needle), `llms.txt is missing: ${needle}`)
  assert.ok(!/[^\x00-\x7F]/.test(t.replace(/—/g, '-')), 'ASCII apart from the existing dashes')
})

// ---------------------------------------------------------------- migration page source

test('migration page: three-value swap, flags, dated prices, honest latency and not-yet list are all present', () => {
  const p = read('src/app/developers/migrate-from-elevenlabs/page.tsx')
  for (const needle of ['Three things to change', 'readaloud-default', 'availabilityLabel(', 'LAUNCH_FLAGS.', 'ELEVENLABS_PRICES.retrievedOn', 'Latency: ElevenLabs Flash is faster', 'PARITY_ROWS', 'Not supported on the ElevenLabs paths', 'x-compat-ignored', 'diarize', 'consent']) {
    assert.ok(p.includes(needle), `page is missing: ${needle}`)
  }
})

// ---------------------------------------------------------------- compare and alternatives pages (real content)

const lib = loadLibrary(path.join(WEB, 'src', 'content'))
const pages = buildPages(lib)
const eleven = (key: string) => textOfPage(pages.find((p) => p.key === key)!)

test('ElevenLabs compare page: dated 2026-11-14, Scribe row 0.20 batch and 0.22 realtime, and the latency row says ElevenLabs Flash was faster', () => {
  const t = eleven('compare:elevenlabs')
  assert.match(t, /November 14, 2026/)
  assert.match(t, /batch \$0\.20 per hour of audio and realtime \$0\.22 per hour/)
  assert.ok(!/0\.39/.test(t))
  assert.match(t, /Time to first audio, side by side in our own runs/)
  assert.match(t, /first audio sooner than ReadAloud Live/)
  assert.match(t, /Measured October 10, 2026/)
  assert.match(t, /\$40 per 1M characters/)
})

test('ElevenLabs alternatives page: speech-to-text and latency statements, dated, no ReadAloud speed claim', () => {
  const t = eleven('alternatives:elevenlabs')
  assert.match(t, /Speech to text/)
  assert.match(t, /\$0\.20 per hour of audio/)
  assert.match(t, /makes no claim of lower latency/)
  assert.match(t, /November 14, 2026/)
})

test('no other vendor page prints a measured head-to-head latency row', () => {
  for (const p of pages) {
    if (p.vendorSlug === 'elevenlabs') continue
    assert.ok(!/side by side in our own runs/.test(textOfPage(p)), p.path)
  }
})
