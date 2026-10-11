import {
  RA_API_BASE, RA_FORMATS, RA_FREE_CREDITS, RA_LANGUAGES, RA_LIMITS, RA_LIVE, RA_NAME, RA_OPENAI_ROUTE, RA_PATHS, RA_STREAMING, RA_STUDIO, RA_VOICES, RA_CLONING,
} from '../../content/readaloudFacts.ts'
import type { Vendor, VendorCategory } from './schema.ts'
import type { Library } from './load.ts'
import type { Block } from './model.ts'
import { joinList, joinOr, longDate, lowerFirst, poss, sentence } from './helpers.ts'
import { CATEGORY_LABEL, formatOverlap, hasText, priceStatements } from './vendor.ts'
import { DISCLAIMER } from './compare.ts'

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

export function migrateLede(v: Vendor, date: string): string {
  return `A step-by-step checklist for moving text-to-speech calls from ${v.name} to ${RA_NAME}, based on ${poss(v.name)} public pages as of ${date}.`
}

export function migrateDescription(v: Vendor, date: string): string {
  const c = [
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
  if (hasText(v.voices.languages)) change.push({ text: `Languages: ${v.name} lists ${v.voices.languages}. ${RA_NAME}: ${RA_LANGUAGES.short}.`, sourceUrl: v.voices.sourceUrl })
  if (overlap.shared.length || overlap.vendorOnly.length) {
    change.push({ text: `Formats: ${v.name} lists ${joinList(v.formats.slice(0, 6))}. ${overlap.shared.length ? `${RA_NAME} returns ${joinList(overlap.shared)} on at least one route .` : ''} ${overlap.vendorOnly.length ? `It does not return ${joinList(overlap.vendorOnly)}, so convert on your side if you need ${overlap.vendorOnly.length > 1 ? 'them' : 'it'}.` : ''}`.replace(/\s+/g, ' ').trim() })
  } else {
    change.push({ text: `Formats: ${RA_NAME} returns ${RA_FORMATS.short}.` })
  }
  if (v.ssml === 'yes') change.push({ text: `SSML: ${v.name} lists SSML support. ${RA_NAME} does not accept it; strip or rewrite markup before sending text.` })
  if (hasText(v.limits.perRequestCharacters)) change.push({ text: `Request size: ${v.name} states ${v.limits.perRequestCharacters}. ${RA_NAME} accepts ${RA_LIMITS.perRequestCharacters.toLocaleString('en-US')} characters per request, so split longer text at sentence boundaries.`, sourceUrl: v.limits.sourceUrl })
  else change.push({ text: `Request size: ${RA_NAME} accepts ${RA_LIMITS.perRequestCharacters.toLocaleString('en-US')} characters per request, so split longer text at sentence boundaries and send the parts in order.` })
  if (v.streaming.websocket === 'yes') change.push({ text: `Streaming: ${v.name} lists WebSocket streaming. ${RA_NAME} streams over WebSocket after an authorize call; see ${RA_PATHS.developers}.` })
  if (hasText(v.voices.customVoiceOrCloning)) change.push({ text: `Custom voices: ${v.name} lists ${lowerFirst(sentence(v.voices.customVoiceOrCloning))} Those voices cannot be exported to ${RA_NAME}.`, sourceUrl: v.voices.sourceUrl })

  const before: { text: string; sourceUrl?: string }[] = []
  before.push({ text: `Collect the exact text you send to ${v.name} today: the longest, the shortest, and the ones with names, numbers and abbreviations.` })
  if (hasText(v.licensing.attributionOrConditions)) before.push({ text: `Conditions on ${poss(v.name)} side: ${sentence(v.licensing.attributionOrConditions)} Check what they mean for audio you already generated.`, sourceUrl: v.licensing.sourceUrl })
  if (hasText(v.licensing.commercialUse)) before.push({ text: `Commercial use at ${v.name}: ${sentence(v.licensing.commercialUse)}`, sourceUrl: v.licensing.sourceUrl })
  if (v.sdks.length) before.push({ text: `List where your code uses ${joinOr(v.sdks.slice(0, 4))} so you can replace each call site.` })
  for (const l of v.limitations.slice(0, 3)) before.push({ text: `Condition listed by ${v.name}: ${sentence(l.claim)}`, sourceUrl: l.sourceUrl })
  before.push({ text: `Save any audio you need to keep from ${v.name} before you cancel, and note which plan covers the right to keep using it.` })

  const cost: Block[] = [
    { kind: 'h2', text: `What it costs to test ${RA_NAME}` },
    { kind: 'p', text: `${RA_FREE_CREDITS.short}` },
    ...priceStatements(v).map((text) => ({ kind: 'p' as const, text })),
    { kind: 'p', text: `These are list prices as of ${date}. The tiers cover different things, so price your own volume rather than reading across.` },
  ]

  const steps = [
    `Create a key (${RA_PATHS.signup}) and run the test call above.`,
    `Pick ${RA_LIVE.name} (${RA_LIVE.role}) or ${RA_STUDIO.name} (${RA_STUDIO.role}).`,
    `Keep the base URL, key and voice in a setting, and move a small share of traffic first.`,
  ]

  return [
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
    { kind: 'h2', text: 'What changes in your code and what does not carry over' },
    { kind: 'list', items: change },
    { kind: 'h2', text: `Steps on the ${RA_NAME} side` },
    codeSample(v),
    { kind: 'list', ordered: true, items: steps.map((text) => ({ text })) },
    ...cost,
    ...(v.unknowns.length ? [{ kind: 'h2' as const, text: `Questions to ask ${v.name} before you move` }, { kind: 'list' as const, items: v.unknowns.map((text) => ({ text })) }] : []),
  ]
}
