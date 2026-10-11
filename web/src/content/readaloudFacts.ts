import { FREE_CREDIT_UNITS, FREE_CREDIT_USD } from '../lib/pricing.ts'

// Single source of truth for every statement the programmatic library (src/lib/seoLibrary) makes about ReadAloud.
// No template types a ReadAloud price, limit, format, latency figure or capability: they all come from here, and
// test/seoLibrary/templates.test.ts scans the templates to keep it that way.
//
// Where each fact comes from (re-read on 2026-10-10 when this file was written):
//   web/src/app/developers/page.tsx                       prices, limits, formats, streaming, free credits, latency table and method
//   web/src/app/developers/migrate-from-elevenlabs/page.tsx   ElevenLabs-compatible routes: what was tested and what is not supported
//   web/src/app/page.tsx                                  tiers, "English today"
//   web/src/lib/pricing.ts                                free credit grant
//   realtime-tts repo, docs/OPENAI_COMPAT.md              OpenAI speech route fields and formats
// If a fact cannot be checked against one of those, it is not in this file; it is listed in UNVERIFIED instead and kept off pages.
//
// Public repo: nothing private here. No costs, margins, engine names or internal hostnames.
//
// Naming rule: pages say "ReadAloud Live" (the low-latency tier) and "ReadAloud Studio" (the higher-priced tier with several English
// voices) and the voice id `readaloud-default`. They never name the engines behind them (test/seoLibrary/templates.test.ts enforces it).

export const RA_NAME = 'ReadAloud'
export const RA_PRODUCT = 'ReadAloud AI'
export const RA_SITE = 'https://readaloudai.org'
export const RA_API_BASE = 'https://api.readaloudai.org'
export const RA_SUPPORT_EMAIL = 'support@readaloudai.org'
export const RA_FACTS_CHECKED_AT = '2026-10-10'

/** Certification and compliance claims ReadAloud may make about itself. Empty on purpose: the site claims none. Add a key here only with evidence. */
export const RA_CERTIFICATION_ALLOW_LIST: string[] = []
export const RA_COMPLIANCE_STATEMENT = 'ReadAloud does not claim HIPAA, SOC 2, GDPR or other certifications. If you need one of them, ask the vendors you are considering what they can show you.'

export const RA_PATHS = {
  developers: '/developers',
  signup: '/developers#get-started',
  openaiSection: '/developers#openai-compatible',
  integrationsSection: '/developers#integrations',
  latencyTable: '/developers#vs-elevenlabs',
  migrateFromElevenLabs: '/developers/migrate-from-elevenlabs',
  mcp: '/developers/mcp',
  pricing: '/#pricing',
  engines: '/#engines',
} as const

export type RaTier = {
  id: 'live' | 'studio'
  name: string
  /** USD per 1,000 characters as written on the developers page. */
  per1kUsd: number
  /** USD per 1,000,000 characters. Kept as a literal (not computed) so no float rounding reaches a page; a test checks per1kUsd * 1000. */
  per1MUsd: number
  /** What the tier is for, in ReadAloud's own words and with no comparison to other vendors. */
  role: string
  voices: string
}

export const RA_TIERS: readonly RaTier[] = [
  {
    id: 'live',
    name: 'ReadAloud Live',
    per1kUsd: 0.004,
    per1MUsd: 4,
    role: 'the low-latency tier, built for live calls and voice agents',
    voices: 'one American English voice, readaloud-default',
  },
  {
    id: 'studio',
    name: 'ReadAloud Studio',
    per1kUsd: 0.01,
    per1MUsd: 10,
    role: 'the higher-priced tier for read-aloud and narration, with several English voices',
    voices: 'several English voices, listed by GET /v1/voices',
  },
]

export const RA_LIVE = RA_TIERS[0]
export const RA_STUDIO = RA_TIERS[1]

export const RA_BILLING = {
  unit: 'per character of speech that finishes; cancelled requests are not billed',
  noMinimums: true,
  /** Audio-based tools appear on the invoice as character equivalents on the same meter. */
  otherToolsOnSameMeter: true,
} as const

export const RA_FREE_CREDITS = {
  units: FREE_CREDIT_UNITS,
  usd: FREE_CREDIT_USD,
  approxCharacters: FREE_CREDIT_UNITS,
  wording: `Every account gets a one-time grant of free credits (worth $${FREE_CREDIT_USD.toFixed(2)}, about ${FREE_CREDIT_UNITS.toLocaleString('en-US')} characters of speech). It is one capped pool per account, shared across all of the account's keys and across speech, transcription, dubbing, voice conversion and voice design, and it is used first. When it runs out, requests return 402 until a payment method is added, then billing is pay as you go.`,
  /** One short sentence for tables and lists. */
  short: `A one-time grant of free credits worth $${FREE_CREDIT_USD.toFixed(2)} (about ${FREE_CREDIT_UNITS.toLocaleString('en-US')} characters of speech), shared by all keys on the account.`,
  noCardToStart: true,
} as const

export const RA_LIMITS = {
  perRequestCharacters: 5000,
  /** Per ReadAloud Live server, from the developers page; more servers start under load. */
  liveStreamsPerServer: 12,
  short: 'Up to 12 Live streams per server; more start under load',
  atCapacity: 'Beyond capacity the API returns 429 (HTTP) or an "at capacity" error with close code 1013 (WebSocket); retry with a short backoff.',
} as const

export const RA_FORMATS = {
  openaiRoute: ['mp3', 'opus', 'wav', 'pcm'],
  openaiRouteDetail: 'mp3 (default, 24 kHz), opus (48 kHz, Ogg), wav (24 kHz) and pcm (24 kHz, 16-bit, mono); aac and flac return 400',
  websocket: ['pcm_24000', 'pcm_8000', 'mulaw_8000', 'alaw_8000'],
  websocketDetail: 'PCM16 at 24 kHz by default, plus 8 kHz PCM and G.711 mu-law and A-law for phone lines',
  /** A flat list used to compare with a vendor's output formats. Names are matched on the family (mp3, opus, wav, pcm, mulaw, alaw). */
  short: 'mp3, opus, wav, pcm; 8 kHz mu-law and A-law over WebSocket',
  families: ['mp3', 'opus', 'wav', 'pcm', 'mulaw', 'alaw'],
} as const

export const RA_STREAMING = {
  websocket: true,
  httpStreaming: true,
  short: 'WebSocket and HTTP streaming',
  detail: 'Streaming works over a WebSocket (authorize first for a 60-second token) and over HTTP streaming on ReadAloud Live. The OpenAI-compatible route streams audio as it is produced, except wav, which is returned whole.',
} as const

/**
 * Latency. The only ReadAloud timing figures pages may print, with their date and method. Nothing here is a benchmark claim about
 * another vendor, and a vendor's own latency is only ever shown as the vendor states it.
 */
export const RA_LATENCY = {
  liveWarmMedianMs: 250,
  liveWarmLabel: 'about 250 ms',
  measuredOn: '2026-10-10',
  method:
    'median time to the first audio byte on a warm streaming connection, two runs of 40 requests each from one machine in the Fly.io San Jose region, short sentences of 35 to 60 characters; ReadAloud was reached through the authorize call and then a direct WebSocket',
  /** Short form for table cells; the full method is on the developers page. */
  methodShort: 'our measurement, median to first audio byte, warm connection, San Jose',
  caveat: 'Results vary with location, hour and connection, and these figures include the network.',
  methodPath: '/developers#vs-elevenlabs',
  /**
   * The head-to-head with ElevenLabs Flash (about 170 ms in the same two runs). It is on the developers page, but library pages show
   * vendor latency only as vendor-stated, so this is NOT rendered by the library. Kept here so a future editor sees why it is absent.
   */
  headToHeadElevenLabsFlashMs: 170,
  renderHeadToHeadOnLibraryPages: false,
} as const

export const RA_OPENAI_ROUTE = {
  path: '/v1/audio/speech',
  summary: 'POST https://api.readaloudai.org/v1/audio/speech accepts the OpenAI audio.speech.create request, so OpenAI SDKs, Open WebUI, LiteLLM and other tools that take an OpenAI base URL work by changing the base URL and the key.',
  voiceNote: 'The OpenAI stock voice names (alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer, verse, marin, cedar) all map to readaloud-default, so they sound the same.',
  speedRange: '0.25 to 4.0',
  ignoredFields: 'model, instructions and stream_format are accepted and ignored',
  notSupported: 'aac and flac output, voice style prompts (instructions), GET /v1/models in the OpenAI shape, and the OpenAI Realtime API',
  liveAcceptance: 'Returned mp3, wav and streamed pcm in a live check on 2026-10-09 with the OpenAI Python SDK',
} as const

export const RA_ELEVENLABS_ROUTES = {
  summary: 'The API serves the ElevenLabs text-to-speech HTTP and WebSocket routes, so ElevenLabs SDK code runs against https://api.readaloudai.org after you change the base URL, the key and the voice id.',
  testedOn: '2026-10-10',
  testedWith: 'elevenlabs (Python) 2.71.0 and @elevenlabs/elevenlabs-js 2.71.0',
  notSupported: 'ElevenLabs speech to text, dubbing, the Agents platform, voice cloning with ElevenLabs semantics, speech to speech, voice design, audio isolation, sound generation, history, pronunciation dictionaries and projects',
  voiceNote: 'ElevenLabs voice ids, including your own clones, do not exist here; use readaloud-default.',
} as const

export const RA_VOICES = {
  defaultId: 'readaloud-default',
  defaultVoice: 'a single American English voice',
  studioVoices: 'several English voices, listed by GET /v1/voices',
  noSsml: 'No SSML and no audio tags.',
  short: 'Live: one American English voice. Studio: several English voices.',
  noVoiceMapping: 'There is no table that maps another vendor\'s voices to ReadAloud voices.',
} as const

/**
 * What ReadAloud does not offer in the way of expressive control. Printed on migrate pages for vendors whose data lists emotion, acting
 * or style controls. Sources: developers page, "Not supported" (instructions ignored) and the no-SSML statement above.
 */
export const RA_EXPRESSIVE = {
  statement: 'ReadAloud does not offer emotion or expressive control: it has no acting instructions, no style prompts, no SSML and no audio tags, and the instructions field of the OpenAI route is ignored.',
  advice: 'If you need that, ReadAloud is not the right fit for that part of your product; evaluate other vendors that list it.',
} as const

/** What each kind of vendor request field or endpoint becomes at ReadAloud (migrate pages, vendor migration.mapping). */
export const RA_MIGRATION_MAP = {
  text: 'input on the OpenAI-compatible route (text on the WebSocket), up to 5,000 characters per request; split longer text at sentence boundaries',
  voice: 'voice: readaloud-default on ReadAloud Live, or a ReadAloud Studio voice listed by GET /v1/voices. Vendor voice names and ids do not exist at ReadAloud',
  style: 'No equivalent. ReadAloud has no acting instructions, style prompts, SSML or audio tags',
  ssml: 'No equivalent. ReadAloud does not accept SSML; send plain text and remove markup',
  model: 'model is accepted and ignored: the voice decides how the audio is made',
  ignored: 'Accepted and ignored by the OpenAI-compatible route',
  timing: 'No equivalent is documented. ReadAloud documents audio plus a per-sentence chunk_meta message on the WebSocket; no word or viseme marks are documented',
  speed: 'speed, 0.25 to 4.0 on the OpenAI-compatible route',
  format: 'response_format on the OpenAI-compatible route: mp3, opus, wav or pcm (aac and flac return 400); the WebSocket also offers 8 kHz mu-law and A-law',
  other: 'No matching field is documented; leave it out and test the result',
  'endpoint-http': 'POST /v1/audio/speech (the OpenAI-compatible route), which returns the audio in the response',
  'endpoint-stream': 'POST /v1/audio/speech, which streams audio as it is produced (wav is returned whole)',
  'endpoint-websocket': 'WebSocket streaming: call the authorize route for a 60-second token, then connect and send synthesize messages (see the Voice API page)',
} as const

export const RA_LANGUAGES = {
  headline: 'English',
  short: 'English today',
  statement: 'ReadAloud speaks English today. More languages are on the roadmap, and the site says so rather than list languages it cannot yet do well.',
} as const

export const RA_CLONING = {
  exists: true,
  short: 'API, with a consent step and a payment method',
  /** Do not describe beyond this. */
  statement: 'Custom voices from your own recordings are available through the API with a consent step, on keys that have a payment method. See the Voice API page for the steps and price.',
} as const

export const RA_OTHER_PRODUCTS = [
  'speech to text (batch, uploaded recordings)',
  'dubbing',
  'voice conversion and voice design',
  'audiobook export',
  'a reader app for Android and the web',
] as const

export const RA_INTEGRATIONS = {
  pipecat: { name: 'Pipecat', pkg: 'pipecat-readaloud', status: 'plugin written and maintained by ReadAloud, MIT licensed' },
  livekit: { name: 'LiveKit Agents', pkg: 'livekit-plugins-readaloud', status: 'plugin written and maintained by ReadAloud, MIT licensed' },
  vapi: { name: 'Vapi', status: 'custom voice endpoint verified directly, and one real Vapi assistant call run on 2026-10-10 with the inline secret; the Custom Credential flow, the sample rate Vapi requested, 429 and timeout handling, and audio quality by ear were not tested' },
  n8n: { name: 'n8n', pkg: 'n8n-nodes-readaloud', status: 'community node on npm, in n8n\'s verification review; not verified by n8n' },
  vercelAiSdk: { name: 'Vercel AI SDK', pkg: 'ai-sdk-provider-readaloud', status: 'provider package on npm' },
  openai: { name: 'OpenAI SDKs', status: 'OpenAI-compatible speech route' },
  mcp: { name: 'MCP server', status: 'hosted MCP server for Claude, Cursor and VS Code' },
} as const

/**
 * Features that were checked against the live site on 2026-10-10 and added to the vocabulary below, each with the place that shows it.
 * Add a feature here only with an evidence path; a use case that lists a feature nobody can point at is a false claim.
 */
export const RA_VERIFIED_FEATURES: readonly { feature: string; evidence: string }[] = [
  { feature: '5,000-character requests', evidence: 'web/src/app/developers/page.tsx: "ReadAloud Live accepts up to 5,000 characters per request"; the OpenAI route returns 400 for input over 5,000 characters' },
  { feature: 'server-side keys', evidence: 'web/src/app/developers/page.tsx, SDKs and MCP: "Because a client takes your API key, use it from a server, not a browser."' },
  { feature: 'error codes', evidence: 'web/src/app/developers/page.tsx: 400, 401, 402, 404 and 429 on the OpenAI route; 401, 402 on authorize; 503 with Retry-After on HTTP streaming; close code 1013 on the WebSocket' },
  { feature: 'g.711 output', evidence: 'web/src/app/developers/page.tsx, Audio formats: mulaw_8000 and alaw_8000 (G.711, 8 kHz)' },
  { feature: 'sentence-by-sentence synthesis', evidence: 'web/src/app/developers/page.tsx: chunk_meta "once per sentence"; HTTP streaming "streams raw audio as each sentence is ready"' },
]

/** Product and feature names a use-case page may list under featuresUsed. Matched loosely (substring, either way). A miss is a warning. */
export const RA_FEATURE_VOCABULARY: readonly string[] = [
  'ReadAloud Live',
  'ReadAloud Studio',
  'streaming',
  'websocket',
  'http streaming',
  'openai-compatible',
  'speech endpoint',
  'elevenlabs-compatible',
  'voice',
  'default voice',
  'output format',
  'mp3',
  'opus',
  'wav',
  'pcm',
  'mulaw',
  'alaw',
  'speed',
  'telephony',
  '8 khz',
  'custom voice',
  'voice cloning',
  'consent',
  'speech to text',
  'transcription',
  'dubbing',
  'audiobook',
  'mcp',
  'pipecat',
  'livekit',
  'vapi',
  'sdk',
  'api key',
  'free credits',
  'per-character',
  'long text',
  'chunk',
  'interrupt',
  'stop',
  ...RA_VERIFIED_FEATURES.map((f) => f.feature.toLowerCase()),
]

/** Names of the engines behind the tiers. They must not appear on any page the library renders about ReadAloud. */
export const RA_FORBIDDEN_ENGINE_NAMES: readonly string[] = ['piper', 'kokoro', 'chatterbox', 'xtts', 'orpheus', 'whisper', 'parler', 'styletts', 'lessac', 'faster-whisper', 'coqui']

/**
 * Things the owner or coordinator listed or implied that could not be checked against the site, and so stay off pages.
 * Reported to the owner in the hand-off.
 */
export const UNVERIFIED: readonly string[] = [
  'How many Studio voices exist and which languages they cover: the site says "multiple English voices" only, so no count is printed.',
  'Vapi beyond one real assistant call on 2026-10-10 (inline secret, 24 seconds, two Vapi-reported custom-voice latencies): the Custom Credential flow, the sample rate Vapi requested, 429 and timeout handling and audio quality by ear are untested and stay off pages as claims.',
  'Latency for ReadAloud Studio: no measurement is published, so none is printed.',
  'Latency on the OpenAI-compatible route: a 150-170 ms warm figure sits in the gateway docs but not on the site, so it is not printed.',
  'A head-to-head latency figure against any vendor other than the one on the developers page; library pages print vendor latency only as vendor-stated.',
  'Concurrency limits for paying accounts beyond "up to 12 streams per ReadAloud Live server, more servers start under load".',
  'Non-English output: only English is stated. The dubbing tool translates to other languages, but that is not a text-to-speech language claim and is not made.',
  'Cloning details beyond the consent step and the payment-method requirement.',
  'SSML tag support beyond "none": the migration page says no SSML; pages say that and nothing more.',
]

export type RaFeatureFact = { label: string; value: string }
