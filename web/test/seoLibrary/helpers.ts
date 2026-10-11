import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadLibrary, type Library } from '../../src/lib/seoLibrary/load.ts'
import type { Vendor } from '../../src/lib/seoLibrary/schema.ts'

export const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'seo-library')
export const NOW = new Date('2026-10-10T12:00:00Z')

export function fixtureLibrary(publish: string[] = []): Library {
  const lib = loadLibrary(FIXTURE_DIR)
  return { ...lib, publish: { published: publish } }
}

const NOUNS = ['harbor', 'lantern', 'orchard', 'compass', 'meadow', 'granite', 'saffron', 'cobalt', 'thistle', 'velvet', 'ember', 'quarry', 'willow', 'copper', 'juniper', 'marble', 'pepper', 'summit', 'tundra', 'walnut']
const VOCAB = 'amber anchor arbor atlas aurora badge basalt beacon birch bishop bramble brook cabin canyon carbon cedar chalk cinder clover coast comet coral cove crest crimson dagger delta dune eagle elm fable falcon fern fjord flint forge fossil galley garnet geyser glacier glade gorge grove gull haven hazel heron hollow indigo island ivory jasper jetty kelp kestrel lagoon larch ledge lichen loam lotus lumen maple mesa mica mist moss nectar nettle oasis onyx opal osprey otter pebble pine plover prairie prism puma quartz quill raven reef ridge river rowan rune sable sage shale shoal sierra slate sparrow spruce steppe stork talon tarn teak thorn tidal topaz trail umber vale verdant vesper violet wharf wren yarrow zephyr zinc'.split(' ')
/** n distinct pseudo-random words for vendor i, field k: free text from different researchers rarely shares five-word runs. */
const phrase = (i: number, k: number, n = 7): string => Array.from({ length: n }, (_, j) => VOCAB[(i * 131 + k * 37 + j * 17 + ((i * j * k) % 11)) % VOCAB.length]).join(' ')
const CATS = ['api-platform', 'cloud-provider', 'studio-tool', 'model-vendor', 'open-source-host'] as const

/** n synthetic vendors, each with its own wording, so pages differ the way real researched vendors would. Test data only. */
export function syntheticVendors(base: Vendor, n: number): Vendor[] {
  return Array.from({ length: n }, (_, i) => {
    const w = NOUNS[i % NOUNS.length]
    const x = NOUNS[(i * 7 + 3) % NOUNS.length]
    const slug = `${w}-${i}`
    const url = `https://${w}${i}.example.com`
    return {
      ...base,
      slug,
      name: `${w[0].toUpperCase()}${w.slice(1)}Voice${i}`,
      url,
      category: CATS[i % CATS.length],
      positioning: `A ${w} oriented speech service: ${phrase(i, 1, 14)}.`,
      pricing: {
        ...base.pricing,
        model: `Billed ${phrase(i, 2, 10)}`,
        headline: `${phrase(i, 3, 9)}`,
        pricePer1MCharsUsd: 6 + i * 3,
        headlineTier: `${w} tier`,
        tiers: [
          { name: `${w} tier`, pricePer1MCharsUsd: 6 + i * 3, unit: '1M characters', notes: `${phrase(i, 4, 7)}` },
          { name: `${x} plus`, pricePer1MCharsUsd: 12 + i * 3, unit: '1M characters', notes: `${phrase(i, 5, 7)}` },
        ],
        freeTier: `${phrase(i, 6, 8)}`,
        promotions: [`${phrase(i, 28, 8)}`],
        sourceUrls: [`${url}/pricing`],
      },
      voices: { count: `${20 + i * 5} voices`, languages: `${phrase(i, 7, 6)}`, customVoiceOrCloning: `${phrase(i, 8, 8)}`, sourceUrl: `${url}/voices` },
      streaming: { websocket: i % 3 ? 'yes' : 'no', http: 'yes', vendorStatedLatency: `${40 + i * 6} ms ${phrase(i, 9, 5)}`, note: '', sourceUrl: `${url}/docs/streaming` },
      formats: [['mp3', 'wav', 'pcm_16000'], ['mp3', 'flac', 'ulaw_8000'], ['opus', 'wav', 'aac']][i % 3],
      ssml: (['yes', 'no', 'unknown'] as const)[i % 3],
      compatibility: { openaiSpeechCompatible: i % 4 === 0 ? 'yes' : 'no', note: `${phrase(i, 10, 7)}` },
      licensing: { commercialUse: `${phrase(i, 11, 9)}`, attributionOrConditions: `${phrase(i, 12, 7)}`, sourceUrl: `${url}/terms` },
      limits: { perRequestCharacters: `${2000 + i * 250} characters ${phrase(i, 13, 4)}`, concurrency: `${i + 2} ${phrase(i, 14, 5)}`, sourceUrl: `${url}/limits` },
      sdks: [`${w} Python SDK`, `${x} Node SDK`],
      compliance: { hipaa: 'not-stated', soc2: 'not-stated', gdpr: 'not-stated', note: '', sourceUrl: undefined },
      strengths: [
        { claim: `${phrase(i, 15, 10)}`, sourceUrl: `${url}/voices` },
        { claim: `${phrase(i, 16, 9)}`, sourceUrl: `${url}/voices` },
        { claim: `${phrase(i, 23, 9)}`, sourceUrl: `${url}/docs/streaming` },
        { claim: `${phrase(i, 24, 8)}`, sourceUrl: `${url}/terms` },
      ],
      limitations: [{ claim: `${phrase(i, 17, 10)}`, sourceUrl: `${url}/limits` }, { claim: `${phrase(i, 25, 9)}`, sourceUrl: `${url}/terms` }, { claim: `${phrase(i, 26, 8)}`, sourceUrl: `${url}/pricing` }],
      migration: { stepsToMove: [`${phrase(i, 18, 8)}.`, `${phrase(i, 19, 9)}.`, `${phrase(i, 20, 7)}.`], sourceUrls: [`${url}/docs/export`], mapping: [] },
      bestFor: `Teams with ${phrase(i, 21, 8)}`,
      sources: ['pricing', 'voices', 'docs/streaming', 'terms', 'limits', 'docs/export'].map((s) => ({ url: `${url}/${s}`, title: `${w} ${s}`, retrievedAt: '2026-10-09' })),
      unknowns: [`${phrase(i, 22, 10)} was not stated.`, `${phrase(i, 27, 9)} was unclear.`],
    } as Vendor
  })
}
