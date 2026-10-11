import {
  RA_API_BASE, RA_EXPRESSIVE, RA_MIGRATION_MAP, RA_FORMATS, RA_FREE_CREDITS, RA_LANGUAGES, RA_LIMITS, RA_LIVE, RA_NAME, RA_OPENAI_ROUTE, RA_PATHS, RA_STREAMING, RA_STUDIO, RA_VOICES, RA_CLONING,
} from '../../content/readaloudFacts.ts'
import type { Vendor, VendorCategory } from './schema.ts'
import type { Library } from './load.ts'
import type { Block } from './model.ts'
import { joinList, joinOr, longDate, lowerFirst, poss, sentence } from './helpers.ts'
import { CATEGORY_LABEL, formatOverlap, hasText, priceIsArchiveOnly, priceStatements } from './vendor.ts'
import { DISCLAIMER, sunsetBlocks } from './compare.ts'

// /migrate/from-<slug>: a checklist for moving text-to-speech calls from a vendor to ReadAloud. The vendor side comes from the vendor's
// own migration.stepsToMove (with sources); the ReadAloud side comes from readaloudFacts.ts. Nothing here claims the move is easy,
// fast or lossless: voices, SSML, languages and custom voices do not carry over, and the page says so from the data.

const KIND_PARAGRAPH: Record<VendorCategory, (v: Vendor) => string> = {
  'api-platform': (v) => `${v.name} is ${CATEGORY_LABEL['api-platform']} companies use from their own code, so the move is mostly a change of endpoint, key and voice in your client, plus a test of your longest text.`,
  'cloud-provider': (v) => `${v.name} is a ${CATEGORY_LABEL['cloud-provider']}, so speech calls usually sit inside a larger cloud account. Expect to change the client library and the credentials, and check whether other parts of your account depend on the same project or billing setup.`,
  'studio-tool': (v) => `${v.name} is a ${CATEGORY_LABEL['studio-tool']}. If you work in its editor today, moving to an API means writing the script-to-audio step yourself. If you already call its API, the move is closer to a client change.`,
  'model-vendor': (v) => `${v.name} is a ${CATEGORY_LABEL['model-vendor']}, and speech is one endpoint among its other services. Moving speech alone leaves the rest of your integration in place.`,
  'open-source-host': (v) => `${v.name} is a ${CATEGORY_LABEL['open-source-host']}. Your current setup depends on the model you picked there, so the voice you hear today may not exist anywhere else.`,
}

/** True when the vendor's own data lists emotion, acting or style control, which ReadAloud does not offer. */
export function listsExpressiveControl(v: Vendor): boolean {
  if (v.migration.mapping.some((m) => m.kind === 'style')) return true
  const text = [v.positioning, ...v.strengths.map((s) => s.claim), ...v.migration.stepsToMove].join(' ')
  return /emotion|expressive|acting instruction|style prompt|steer/i.test(text)
}

export function migrateLede(v: Vendor, date: string): string {
  if (v.sunset) return `A step-by-step checklist for moving text-to-speech calls from ${v.name} to ${RA_NAME} before ${v.name} ends access on ${longDate(v.sunset.date)}, based on ${poss(v.name)} public pages as of ${date}.`
  return `A step-by-step checklist for moving text-to-speech calls from ${v.name} to ${RA_NAME}, based on ${poss(v.name)} public pages as of ${date}.`
}

export function migrateDescription(v: Vendor, date: string): string {
  const c = v.sunset ? [
    `${v.name} ends access ${longDate(v.sunset.date)}. A checklist for moving to ${RA_NAME}: what changes, what does not carry over and how to test. Pages reviewed ${date}.`,
    `${v.name} ends access ${longDate(v.sunset.date)}. Moving to ${RA_NAME}: what changes, what does not carry over, how to test. Reviewed ${date}.`,
    `Moving from ${v.name} before ${longDate(v.sunset.date)}: what changes and how to test. Reviewed ${date}.`,
  ] : [
    `A checklist for moving from ${v.name} to ${RA_NAME}: what changes, what does not carry over and how to test. Based on ${poss(v.name)} pages reviewed ${date}.`,
    `Moving from ${v.name} to ${RA_NAME}: what changes, what does not carry over, how to test. ${poss(v.name)} pages reviewed ${date}.`,
    `Moving from ${v.name} to ${RA_NAME}: what changes and how to test, from pages reviewed ${date}.`,
  ]
  return c.find((x) => x.length <= 165) ?? c[c.length - 1]
}

function codeSample(v: Vendor): Block {
  const base = `${RA_API_BASE}/v1`
  const code = `# ${RA_NAME} through its OpenAI-compatible speech route (${RA_OPENAI_ROUTE.path}).
# Replace YOUR_KEY with a ${RA_NAME} API key.
curl -X POST "${base}/audio/speech" \\
  -H "Authorization: Bearer YOUR_KEY" -H "Content-Type: application/json" \\
  -d '{"model":"tts-1","voice":"${RA_VOICES.defaultId}","input":"Paste a sentence you send to ${v.name} today.","response_format":"mp3"}' \\
  -o test.mp3`
  return { kind: 'code', language: 'bash', code, caption: `A first test call to ${RA_NAME} (works from any language that can send an HTTP request)` }
}

export function migrateBlocks(lib: Library, v: Vendor): Block[] {
  const date = longDate(v.retrievedAt)
  const overlap = formatOverlap(v)
  const change: { text: string; sourceUrl?: string }[] = []

  change.push(v.compatibility.openaiSpeechCompatible === 'yes'
    ? { text: `Endpoint: ${v.name} lists an OpenAI-compatible speech endpoint, so changing the base URL to ${RA_API_BASE}/v1 and the key may be enough.` }
    : { text: `Endpoint: ${poss(v.name)} request shape is its own, so rewrite the call; ${RA_OPENAI_ROUTE.path} is one plain HTTP request.` })
  change.push({ text: `Voice: ${v.name} voices do not exist at ${RA_NAME}. ${RA_VOICES.short}` })
  if (hasText(v.voices.languages)) change.push({ text: `Languages, as ${poss(v.name)} pages put it: ${sentence(v.voices.languages)} ${RA_NAME}: ${RA_LANGUAGES.short}.`, sourceUrl: v.voices.sourceUrl })
  if (overlap.shared.length || overlap.vendorOnly.length) {
    change.push({ text: `Formats: ${v.name} lists ${joinList(v.formats.slice(0, 6))}. ${overlap.shared.length ? `${RA_NAME} returns ${joinList(overlap.shared)} on at least one route.` : ''} ${overlap.vendorOnly.length ? `It does not return ${joinList(overlap.vendorOnly)}, so convert on your side if you need ${overlap.vendorOnly.length > 1 ? 'them' : 'it'}.` : ''}`.replace(/\s+/g, ' ').trim() })
  } else {
    change.push({ text: `Formats: ${RA_NAME} returns ${RA_FORMATS.short}.` })
  }
  if (v.ssml === 'yes') change.push({ text: `SSML: ${v.name} lists SSML support. ${RA_NAME} does not accept it; strip or rewrite markup before sending text.` })
  if (hasText(v.limits.perRequestCharacters)) change.push({ text: `Request size: ${v.name} states ${v.limits.perRequestCharacters.replace(/[.\s]+$/, '')}. ${RA_NAME} accepts ${RA_LIMITS.perRequestCharacters.toLocaleString('en-US')} characters per request, so split longer text at sentence boundaries.`, sourceUrl: v.limits.sourceUrl })
  else change.push({ text: `Request size: ${RA_NAME} accepts ${RA_LIMITS.perRequestCharacters.toLocaleString('en-US')} characters per request, so split longer text at sentence boundaries and send the parts in order.` })
  if (v.streaming.websocket === 'yes') change.push({ text: `Streaming: ${v.name} lists WebSocket streaming. ${RA_NAME} streams over WebSocket after an authorize call; see ${RA_PATHS.developers}.` })
  if (hasText(v.voices.customVoiceOrCloning)) change.push({ text: `Custom voices, as ${poss(v.name)} pages describe them: ${sentence(v.voices.customVoiceOrCloning)} Those voices cannot be exported to ${RA_NAME}.`, sourceUrl: v.voices.sourceUrl })

  const mismatch: { text: string; sourceUrl?: string }[] = []
  if (listsExpressiveControl(v)) mismatch.push({ text: `Expressive control: ${poss(v.name)} pages list controls over emotion, acting or style. ${RA_EXPRESSIVE.statement} ${RA_EXPRESSIVE.advice}`, sourceUrl: v.migration.sourceUrls[0] })

  const mapRows = v.migration.mapping.map((m) => [
    { text: m.vendorItem, sourceUrl: v.migration.sourceUrls[0] },
    { text: RA_MIGRATION_MAP[m.kind] + (hasText(m.note) ? `. ${sentence(m.note)}` : '') },
  ])

  const before: { text: string; sourceUrl?: string }[] = []
  if (v.sunset) before.push({ text: `Export what you need from your ${v.name} account before ${longDate(v.sunset.date)}. Its documentation says account data is deleted afterwards, so audio, voice designs and settings you have not saved will be gone.`, sourceUrl: v.sunset.noticeSourceUrls[v.sunset.noticeSourceUrls.length - 1] })
  before.push({ text: `Collect the exact text you send to ${v.name} today: the longest, the shortest, and the ones with names, numbers and abbreviations.` })
  if (hasText(v.licensing.attributionOrConditions)) before.push({ text: `Conditions on ${poss(v.name)} side: ${sentence(v.licensing.attributionOrConditions)} Check what they mean for audio you already generated.`, sourceUrl: v.licensing.sourceUrl })
  if (hasText(v.licensing.commercialUse)) before.push({ text: `Commercial use at ${v.name}: ${sentence(v.licensing.commercialUse)}`, sourceUrl: v.licensing.sourceUrl })
  if (v.sdks.length) before.push({ text: `List where your code uses ${joinOr(v.sdks.slice(0, 4))} so you can replace each call site.` })
  // The announced end date has its own notice at the top of the page, so it is not repeated as a condition.
  for (const l of v.limitations.filter((x) => !v.sunset?.noticeSourceUrls.includes(x.sourceUrl)).slice(0, 3)) before.push({ text: `Condition listed by ${v.name}: ${sentence(l.claim)}`, sourceUrl: l.sourceUrl })
  before.push({ text: `Save any audio you need to keep from ${v.name} before you cancel, and note which plan covers the right to keep using it.` })

  const cost: Block[] = [
    { kind: 'h2', text: `What it costs to test ${RA_NAME}` },
    { kind: 'p', text: `${RA_FREE_CREDITS.short}` },
    ...priceStatements(v).map((text) => ({ kind: 'p' as const, text })),
    ...(priceIsArchiveOnly(v) ? [] : [{ kind: 'p' as const, text: `These are list prices as of ${date}. The tiers cover different things, so price your own volume rather than reading across.` }]),
  ]

  const steps = [
    ...(v.sunset ? [`Set the cut-over date before ${longDate(v.sunset.date)}, and keep ${v.name} running until the ${RA_NAME} path has carried real traffic.`] : []),
    `Create a key (${RA_PATHS.signup}) and run the test call below.`,
    `Pick ${RA_LIVE.name} (${RA_LIVE.role}) or ${RA_STUDIO.name} (${RA_STUDIO.role}).`,
    `Keep the base URL, key and voice in a setting, and move a small share of traffic first.`,
  ]

  return [
    ...sunsetBlocks(v),
    { kind: 'verified', text: `Last verified ${date}.` },
    { kind: 'p', tone: 'note', text: DISCLAIMER(v.name, v.retrievedAt) },
    { kind: 'h2', text: `Moving from ${v.name}: what kind of move this is` },
    { kind: 'p', text: `How ${v.name} positions itself: ${sentence(v.positioning)}` },
    { kind: 'p', text: KIND_PARAGRAPH[v.category](v) },
    ...(hasText(v.bestFor) ? [{ kind: 'p' as const, text: `${poss(v.name)} pages suggest it fits: ${lowerFirst(sentence(v.bestFor))}` }] : []),
    { kind: 'h2', text: `Before you leave ${v.name}` },
    { kind: 'list', items: before },
    { kind: 'h2', text: `Steps to move off ${v.name}` },
    { kind: 'p', text: `These steps come from ${poss(v.name)} public pages. Sources are listed at the end.` },
    { kind: 'list', ordered: true, items: v.migration.stepsToMove.map((text) => ({ text, sourceUrl: v.migration.sourceUrls[0] })) },
    ...(mapRows.length ? [
      { kind: 'h2' as const, text: `Map each ${v.name} request field and endpoint` },
      { kind: 'table' as const, caption: `${v.name} fields and endpoints and what they become at ${RA_NAME}`, columns: [`In ${v.name}`, `At ${RA_NAME}`], rows: mapRows },
    ] : []),
    { kind: 'h2', text: 'What changes in your code and what does not carry over' },
    { kind: 'list', items: change },
    ...(mismatch.length ? [{ kind: 'h2' as const, text: `Where ${RA_NAME} does not match ${v.name}` }, { kind: 'list' as const, items: mismatch }] : []),
    { kind: 'h2', text: `Steps on the ${RA_NAME} side` },
    { kind: 'list', ordered: true, items: steps.map((text) => ({ text })) },
    codeSample(v),
    ...cost,
    ...(v.unknowns.length ? [{ kind: 'h2' as const, text: `What we could not confirm about ${v.name}` }, { kind: 'list' as const, items: v.unknowns.map((text) => ({ text })) }] : []),
  ]
}
