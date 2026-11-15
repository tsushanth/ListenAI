#!/usr/bin/env node
// Generates web/src/generated/tts-registry.json (+ a typed .ts twin), web/src/generated/tts-legacy-voice-ids.ts and the voices line of
// web/public/llms.txt from the TTS registry (registry/ in the realtime-tts repo). Docs surfaces read the generated files, so a voice or
// language change in the registry reaches the site by running this script, never by retyping a count.
//
//   node scripts/sync-tts-registry.mjs --registry <path to the registry folder, the one holding dist/>
//   node scripts/sync-tts-registry.mjs --registry <path> --check     (exit 1 if the generated files are stale; for CI)
//   TTS_REGISTRY_DIR=<path> node scripts/sync-tts-registry.mjs
//
// PUBLIC DATA ONLY. The generated tts-registry.json/.ts and llms.txt are built from registry/dist/public-catalog.json (voice id, name,
// language, dialect, gender, tier: the fields registry/public-policy.json allows the public to see) and are checked against that policy's
// denylist before anything is written. registry/dist/registry.json is read for two things only: its content hash (so --check notices a
// registry change) and the old voice ids (aliases) of live voices, which go to the separate tts-legacy-voice-ids.ts, an input-only map
// that lets a caller who still sends an old id be understood. That map is never rendered or returned to a visitor. No dependencies.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB = resolve(HERE, '..')
const OUT_JSON = join(WEB, 'src/generated/tts-registry.json')
const OUT_TS = join(WEB, 'src/generated/tts-registry.ts')
const OUT_LEGACY = join(WEB, 'src/generated/tts-legacy-voice-ids.ts')
const LLMS = join(WEB, 'public/llms.txt')
const LLMS_PREFIX = '- Voices and languages: '

// The Live tier's default voice is implicit in the public catalog (a tier language with no listed voice is spoken by it).
const LIVE_DEFAULT_VOICE = { id: 'default', name: 'Default' }
// Product claim, not a registry field: every Live voice in a language other than the default one is in beta (the public catalog carries
// no description, so the word cannot be derived). Remove when the registry grows a public status field or the voices leave beta.
const LIVE_LISTED_VOICES_ARE_BETA = true

// Language codes the docs know how to name. A registry code that is not here fails the sync (add it on purpose).
// `name` reads inside a sentence, `label` heads a table row.
const LANGUAGES = {
  en: { name: 'English', label: 'English' },
  de: { name: 'German', label: 'German' },
  es: { name: 'Spanish', label: 'Spanish' },
  fr: { name: 'French', label: 'French' },
  it: { name: 'Italian', label: 'Italian' },
  pt: { name: 'Portuguese', label: 'Portuguese' },
  cs: { name: 'Czech', label: 'Czech' },
  nl: { name: 'Dutch', label: 'Dutch' },
  fi: { name: 'Finnish', label: 'Finnish' },
  el: { name: 'Greek', label: 'Greek' },
  hi: { name: 'Hindi', label: 'Hindi' },
  hu: { name: 'Hungarian', label: 'Hungarian' },
  id: { name: 'Indonesian', label: 'Indonesian' },
  ja: { name: 'Japanese', label: 'Japanese' },
  pl: { name: 'Polish', label: 'Polish' },
  ro: { name: 'Romanian', label: 'Romanian' },
  ru: { name: 'Russian', label: 'Russian' },
  sv: { name: 'Swedish', label: 'Swedish' },
  tr: { name: 'Turkish', label: 'Turkish' },
  uk: { name: 'Ukrainian', label: 'Ukrainian' },
  'pt-BR': { name: 'Brazilian Portuguese', label: 'Portuguese (Brazil)' },
  zh: { name: 'Chinese', label: 'Chinese' },
}

export const joinList = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)

const fail = (m) => { throw new Error(`sync-tts-registry: ${m}`) }
const readJson = (p) => { if (!existsSync(p)) fail(`missing ${p}`); return JSON.parse(readFileSync(p, 'utf8')) }

/** The registry's own matching rule (registry/build.mjs publicLeak): case-insensitive, on word boundaries, a space in a term also matches "-" or nothing. */
export function denyMatchers(policy) {
  return policy.denylist.map((t) => [t, new RegExp('(^|[^a-z0-9])' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '[ -]?') + '($|[^a-z0-9])', 'i')])
}
const strings = (v, out = []) => { if (typeof v === 'string') out.push(v); else if (Array.isArray(v)) v.forEach((x) => strings(x, out)); else if (v && typeof v === 'object') Object.values(v).forEach((x) => strings(x, out)); return out }

export function build(registryDir) {
  const dist = join(registryDir, 'dist')
  const pub = readJson(join(dist, 'public-catalog.json'))
  const reg = readJson(join(dist, 'registry.json'))
  const policy = readJson(join(registryDir, 'public-policy.json'))
  if (!reg.hash || !reg.engines || !Array.isArray(reg.voices)) fail('dist/registry.json lacks hash/engines/voices (rebuild the registry)')
  if (!pub.tiers || !Array.isArray(pub.voices)) fail('public-catalog.json has an unexpected shape (want {tiers, voices})')
  for (const need of ['live', 'studio']) if (!pub.tiers[need]?.languages?.length) fail(`public-catalog.json has no tier "${need}"`)

  const lang = (code, where) => LANGUAGES[code] ?? fail(`no display name for language "${code}" (${where}); add it to LANGUAGES in this script`)

  const tiers = {}
  for (const [tier, t] of Object.entries(pub.tiers)) {
    const voices = pub.voices.filter((v) => v.tier === tier).map((v) => {
      for (const f of ['voice_id', 'name', 'language', 'gender']) if (!v[f]) fail(`public voice ${JSON.stringify(v.voice_id)} lacks ${f}`)
      if (!t.languages.includes(v.language)) fail(`voice ${v.voice_id}: language ${v.language} is not one of tier ${tier}'s languages`)
      lang(v.language, v.voice_id)
      const o = { id: v.voice_id, name: v.name, language: v.language, gender: v.gender }
      if (v.dialect) o.dialect = v.dialect
      if (v.languages) { for (const c of v.languages) lang(c, v.voice_id); o.languages = [...v.languages] }
      o.beta = tier === 'live' && LIVE_LISTED_VOICES_ARE_BETA
      return o
    })
    const voicesByLanguage = {}
    for (const code of t.languages) {
      const ids = voices.filter((v) => (v.languages ?? [v.language]).includes(code)).map((v) => v.id)
      if (ids.length) voicesByLanguage[code] = ids
    }
    // A tier language with no listed voice is reached through the Live tier's implicit default voice (English).
    const implicit = t.languages.filter((c) => !voicesByLanguage[c])
    if (implicit.length > 1 || (implicit.length === 1 && tier !== 'live')) fail(`tier ${tier}: languages ${implicit.join(', ')} have no listed voice`)
    const defaultVoice = implicit.length ? { ...LIVE_DEFAULT_VOICE, language: implicit[0] } : null
    if (voices.length === 0) fail(`tier ${tier} lists no voices in public-catalog.json`)
    const betaLanguages = Object.keys(voicesByLanguage).filter((c) => voices.filter((v) => (v.languages ?? [v.language]).includes(c)).every((v) => v.beta))
    tiers[tier] = { label: tier[0].toUpperCase() + tier.slice(1), publicAlias: tier, languages: [...t.languages], defaultVoice, voices, voicesByLanguage, betaLanguages }
  }

  const live = tiers.live
  const studio = tiers.studio
  const names = (codes) => codes.map((c) => lang(c, 'tier languages').name)
  const liveListedLangs = Object.keys(live.voicesByLanguage)
  const liveBeta = live.betaLanguages.length > 0 && live.betaLanguages.length === liveListedLangs.length
  const defaultName = live.defaultVoice ? lang(live.defaultVoice.language, 'default voice').name : null
  // Every listed voice counts (the implicit default voice only exists for a language with no listed voice). A voice may speak several
  // languages (`languages`), so the language list is every tier language some listed voice speaks, in tier order.
  const liveListed = live.voices
  const liveExtraLangs = live.languages.filter((c) => live.voices.some((v) => (v.languages ?? [v.language]).includes(c)))
  const phrase = {
    liveLanguages: joinList(names(live.languages)),
    liveExtraLanguages: joinList(names(liveExtraLangs)),
    studioLanguages: joinList(names(studio.languages)),
    liveBetaPrefix: liveBeta ? 'beta ' : '',
  }
  const liveTail = defaultName
    ? `a default ${defaultName} voice${liveListed.length ? ` and ${liveListed.length} ${phrase.liveBetaPrefix}voices in ${phrase.liveExtraLanguages}` : ''}`
    : `${live.voices.length} voices in ${phrase.liveLanguages}`
  const liveSentence = `ReadAloud Live has ${liveTail}`
  phrase.liveVoicesTail = liveTail
  const studioSentence = studio.languages.length === 1
    ? `ReadAloud Studio has ${studio.voices.length} ${phrase.studioLanguages} voices`
    : `ReadAloud Studio has ${studio.voices.length} voices in ${phrase.studioLanguages}`
  phrase.liveVoices = liveSentence
  phrase.studioVoices = studioSentence
  phrase.llms = `${liveSentence}; ${studioSentence}. GET /v1/voices lists them.`

  const data = {
    _generated: 'GENERATED by web/scripts/sync-tts-registry.mjs from the public TTS catalog (registry/dist/public-catalog.json). Do not edit by hand; run: node scripts/sync-tts-registry.mjs --registry <registry dir>',
    registry: { version: reg.version, hash: reg.hash, catalog: 'public-catalog.json' },
    languageNames: Object.fromEntries([...new Set([...live.languages, ...studio.languages])].map((c) => [c, lang(c, 'tiers').name])),
    languageLabels: Object.fromEntries([...new Set([...live.languages, ...studio.languages])].map((c) => [c, lang(c, 'tiers').label])),
    engines: tiers,
    counts: { total: live.voices.length + studio.voices.length, live: live.voices.length, studio: studio.voices.length, liveListedNonDefault: liveListed.length },
    phrase,
  }

  // The public data must pass the registry's own denylist before it is written.
  const matchers = denyMatchers(policy)
  for (const s of strings({ ...data, _generated: undefined })) {
    const hit = matchers.find(([, re]) => re.test(s))
    if (hit) fail(`public data contains a denylisted term ("${hit[0]}") in "${s}"`)
  }

  // Old voice ids of live, API-listed voices -> public id and tier, so a caller who still sends one is understood (input only).
  const tierOfEngine = (e) => reg.engines[e]?.tier ?? reg.engines[e]?.public_alias
  const legacy = {}
  for (const v of reg.voices) {
    if (!(v.public_id && v.status === 'live' && v.surfaces?.api && (reg.engines[v.engine]?.status ?? 'live') === 'live')) continue
    const tier = tierOfEngine(v.engine)
    if (!tiers[tier]) continue
    for (const a of v.aliases ?? []) legacy[a] = { id: v.public_id, tier }
  }
  return Object.assign(data, { _legacy: legacy })
}

const tsTwin = (data) =>
  `// ${data._generated}\n// Typed twin of tts-registry.json (same data) so Next and \`node --test\` import it the same way, with no JSON import attributes.\nexport const TTS_REGISTRY = ${JSON.stringify(data, null, 2)} as const\n`

const legacyTs = (legacy) =>
  `// GENERATED by web/scripts/sync-tts-registry.mjs from the TTS registry (aliases of live voices). Do not edit by hand.\n// INPUT ONLY: lets the API and MCP tools understand an old voice id and map it to the public id. Never render or return these keys.\nexport const TTS_LEGACY_VOICE_IDS: Readonly<Record<string, { id: string; tier: 'live' | 'studio' }>> = ${JSON.stringify(legacy, null, 2)}\n`

export function llmsWith(text, data) {
  const lines = text.split('\n')
  const i = lines.findIndex((l) => l.startsWith(LLMS_PREFIX))
  if (i === -1) fail(`public/llms.txt has no line starting "${LLMS_PREFIX}" to fill`)
  lines[i] = `${LLMS_PREFIX}${data.phrase.llms}`
  return lines.join('\n')
}

function main() {
  const argv = process.argv.slice(2)
  const check = argv.includes('--check')
  const ri = argv.indexOf('--registry')
  const dir = ri !== -1 ? argv[ri + 1] : process.env.TTS_REGISTRY_DIR
  if (!dir) fail('pass --registry <registry dir> or set TTS_REGISTRY_DIR')
  const { _legacy, ...data } = build(resolve(dir))
  const outJson = `${JSON.stringify(data, null, 2)}\n`
  const outTs = tsTwin(data)
  const outLegacy = legacyTs(_legacy)
  const llms = llmsWith(readFileSync(LLMS, 'utf8'), data)
  const cur = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null)
  if (check) {
    const stale = [[OUT_JSON, outJson], [OUT_TS, outTs], [OUT_LEGACY, outLegacy], [LLMS, llms]].filter(([p, want]) => cur(p) !== want).map(([p]) => p)
    if (stale.length) { console.error(`stale (run the sync): ${stale.join(', ')}`); process.exit(1) }
    console.log(`up to date (registry ${data.registry.hash})`)
    return
  }
  mkdirSync(dirname(OUT_JSON), { recursive: true })
  writeFileSync(OUT_JSON, outJson)
  writeFileSync(OUT_TS, outTs)
  writeFileSync(OUT_LEGACY, outLegacy)
  writeFileSync(LLMS, llms)
  console.log(`wrote tts-registry.json/.ts, tts-legacy-voice-ids.ts and llms.txt (registry ${data.registry.hash}): live ${data.counts.live} voices, studio ${data.counts.studio} voices`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main() } catch (e) { console.error(e.message); process.exit(1) }
}
