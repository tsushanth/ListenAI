#!/usr/bin/env node
// Generates web/src/generated/tts-registry.json (+ a typed .ts twin) and the voices line of web/public/llms.txt
// from the TTS registry (registry/ in the realtime-tts repo). Docs surfaces read the generated files, so a voice or
// language change in the registry reaches the site by running this script, never by retyping a count.
//
//   node scripts/sync-tts-registry.mjs --registry <path to the registry folder, the one holding dist/>
//   node scripts/sync-tts-registry.mjs --registry <path> --check     (exit 1 if the generated files are stale; for CI)
//   TTS_REGISTRY_DIR=<path> node scripts/sync-tts-registry.mjs
//
// Reads registry/dist/registry.json (engines, hash, voice facts) and registry/dist/gateway-catalog.hide-unsupported.json
// (what GET /v1/voices lists, minus voices the worker cannot speak). Docs must list the second one, so a page never
// advertises a voice that fails. No dependencies.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB = resolve(HERE, '..')
const OUT_JSON = join(WEB, 'src/generated/tts-registry.json')
const OUT_TS = join(WEB, 'src/generated/tts-registry.ts')
const LLMS = join(WEB, 'public/llms.txt')
const LLMS_PREFIX = '- Voices and languages: '

// Language codes the docs know how to name. A registry code that is not here fails the sync (add it on purpose).
// `name` reads inside a sentence, `label` heads a table row.
const LANGUAGES = {
  en: { name: 'English', label: 'English' },
  de: { name: 'German', label: 'German' },
  es: { name: 'Spanish', label: 'Spanish' },
  fr: { name: 'French', label: 'French' },
  it: { name: 'Italian', label: 'Italian' },
  pt: { name: 'Portuguese', label: 'Portuguese' },
  'pt-BR': { name: 'Brazilian Portuguese', label: 'Portuguese (Brazil)' },
  ja: { name: 'Japanese', label: 'Japanese' },
  zh: { name: 'Chinese', label: 'Chinese' },
  el: { name: 'Greek', label: 'Greek' },
}

export const joinList = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)

const fail = (m) => { throw new Error(`sync-tts-registry: ${m}`) }
const readJson = (p) => { if (!existsSync(p)) fail(`missing ${p}`); return JSON.parse(readFileSync(p, 'utf8')) }

export function build(registryDir) {
  const dist = join(registryDir, 'dist')
  const reg = readJson(join(dist, 'registry.json'))
  const cat = readJson(join(dist, 'gateway-catalog.hide-unsupported.json'))
  if (!reg.hash || !reg.engines || !Array.isArray(reg.voices)) fail('dist/registry.json lacks hash/engines/voices (rebuild the registry)')
  if (!Array.isArray(cat.builtIn) || !Array.isArray(cat.piperLanguage)) fail('gateway-catalog.hide-unsupported.json has an unexpected shape')

  const lang = (code, where) => LANGUAGES[code] ?? fail(`no display name for language "${code}" (${where}); add it to LANGUAGES in this script`)
  const byRegistryId = Object.fromEntries(Object.entries(reg.engines).map(([id, e]) => [id, { id, ...e }]))
  const voiceFacts = new Map(reg.voices.map((v) => [v.voice_id, v]))

  // The catalog lists Kokoro as builtIn and Piper as piperLanguage (each with engine: 'piper'); an engine added later lists
  // its voices under its own engine id, each item naming its engine.
  const listed = [
    ...cat.builtIn.map((v) => ({ ...v, registryEngine: 'kokoro' })),
    ...cat.piperLanguage.map((v) => ({ ...v, registryEngine: v.engine ?? 'piper' })),
    ...Object.entries(cat).filter(([k, v]) => k !== 'builtIn' && k !== 'piperLanguage' && Array.isArray(v))
      .flatMap(([k, arr]) => arr.map((v) => ({ ...v, registryEngine: v.engine ?? k }))),
  ]

  const engines = {}
  for (const [registryId, e] of Object.entries(reg.engines)) {
    const alias = e.public_alias
    if (!alias) fail(`engine ${registryId} has no public_alias`)
    const voices = listed.filter((v) => v.registryEngine === registryId).map((v) => {
      if (!e.languages.includes(v.language)) fail(`voice ${v.voice_id}: language ${v.language} is not one of ${registryId}'s languages`)
      lang(v.language, v.voice_id)
      const o = { id: v.voice_id, name: v.name, language: v.language, gender: v.gender }
      if (v.accent) o.accent = v.accent
      o.beta = /^beta\b/i.test(v.description ?? '')
      return o
    })
    if (voices.length === 0) fail(`engine ${registryId} lists no voices in the hide-unsupported catalog`)
    const voicesByLanguage = {}
    for (const code of e.languages) {
      const ids = voices.filter((v) => v.language === code).map((v) => v.id)
      if (ids.length) voicesByLanguage[code] = ids
    }
    // An engine language with no listed voice is reached through the engine's implicit default voice (Live English).
    const implicit = e.languages.filter((c) => !voicesByLanguage[c])
    const dv = registryId === 'piper' ? voiceFacts.get('default') : undefined
    const defaultVoice = dv && dv.engine === registryId ? { id: dv.voice_id, language: dv.language } : null
    for (const c of implicit) if (!defaultVoice || defaultVoice.language !== c) fail(`engine ${registryId}: language ${c} has no listed voice and is not the default voice's language`)
    const listedNonDefault = Object.keys(voicesByLanguage)
    const betaLanguages = listedNonDefault.filter((c) => voices.filter((v) => v.language === c).every((v) => v.beta))
    engines[alias] = {
      registryId, label: e.label, publicAlias: alias, hardware: e.hardware, priceClass: e.price_class,
      languages: e.languages, defaultVoice, voices, voicesByLanguage, betaLanguages,
    }
  }
  for (const need of ['live', 'studio']) if (!engines[need]) fail(`registry has no engine with public_alias "${need}"`)

  // Voices the registry lists on the API but the worker cannot speak (worker_supported false): kept out of every
  // doc and list, but a caller that still sends one is passed through to the gateway as before.
  const hiddenUnsupportedVoiceIds = {}
  for (const v of reg.voices) {
    if (!(v.surfaces?.api && v.status !== 'deprecated' && v.worker_supported === false)) continue
    const alias = byRegistryId[v.engine]?.public_alias
    if (alias) (hiddenUnsupportedVoiceIds[alias] ??= []).push(v.voice_id)
  }

  const live = engines.live
  const studio = engines.studio
  const names = (codes) => codes.map((c) => lang(c, 'engine languages').name)
  const liveListedLangs = Object.keys(live.voicesByLanguage)
  const liveBeta = live.betaLanguages.length > 0 && live.betaLanguages.length === liveListedLangs.length
  const defaultName = live.defaultVoice ? lang(live.defaultVoice.language, 'default voice').name : null
  const liveListed = live.voices.filter((v) => !(live.defaultVoice && v.language === live.defaultVoice.language))
  const liveExtraLangs = [...new Set(liveListed.map((v) => v.language))]
  const phrase = {
    liveLanguages: joinList(names(live.languages)),
    liveExtraLanguages: joinList(names(liveExtraLangs)),
    studioLanguages: joinList(names(studio.languages)),
    liveBetaPrefix: liveBeta ? 'beta ' : '',
  }
  const liveSentence = defaultName
    ? `ReadAloud Live has a default ${defaultName} voice${liveListed.length ? ` and ${liveListed.length} ${phrase.liveBetaPrefix}voices in ${phrase.liveExtraLanguages}` : ''}`
    : `ReadAloud Live has ${live.voices.length} voices in ${phrase.liveLanguages}`
  const studioSentence = studio.languages.length === 1
    ? `ReadAloud Studio has ${studio.voices.length} ${phrase.studioLanguages} voices`
    : `ReadAloud Studio has ${studio.voices.length} voices in ${phrase.studioLanguages}`
  phrase.liveVoices = liveSentence
  phrase.studioVoices = studioSentence
  phrase.llms = `${liveSentence}; ${studioSentence}. GET /v1/voices lists them.`

  const data = {
    _generated: 'GENERATED by web/scripts/sync-tts-registry.mjs from the TTS registry (registry/dist). Do not edit by hand; run: node scripts/sync-tts-registry.mjs --registry <registry dir>',
    registry: { version: reg.version, hash: reg.hash, catalog: 'gateway-catalog.hide-unsupported.json' },
    languageNames: Object.fromEntries([...new Set([...live.languages, ...studio.languages])].map((c) => [c, lang(c, 'engines').name])),
    languageLabels: Object.fromEntries([...new Set([...live.languages, ...studio.languages])].map((c) => [c, lang(c, 'engines').label])),
    engines,
    counts: { total: Object.values(engines).reduce((n, e) => n + e.voices.length, 0), live: live.voices.length, studio: studio.voices.length, liveListedNonDefault: liveListed.length },
    hiddenUnsupportedVoiceIds,
    phrase,
  }
  return data
}

const tsTwin = (data) =>
  `// ${data._generated}\n// Typed twin of tts-registry.json (same data) so Next and \`node --test\` import it the same way, with no JSON import attributes.\nexport const TTS_REGISTRY = ${JSON.stringify(data, null, 2)} as const\n`

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
  const data = build(resolve(dir))
  const outJson = `${JSON.stringify(data, null, 2)}\n`
  const outTs = tsTwin(data)
  const llms = llmsWith(readFileSync(LLMS, 'utf8'), data)
  const cur = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null)
  if (check) {
    const stale = [[OUT_JSON, outJson], [OUT_TS, outTs], [LLMS, llms]].filter(([p, want]) => cur(p) !== want).map(([p]) => p)
    if (stale.length) { console.error(`stale (run the sync): ${stale.join(', ')}`); process.exit(1) }
    console.log(`up to date (registry ${data.registry.hash})`)
    return
  }
  mkdirSync(dirname(OUT_JSON), { recursive: true })
  writeFileSync(OUT_JSON, outJson)
  writeFileSync(OUT_TS, outTs)
  writeFileSync(LLMS, llms)
  console.log(`wrote tts-registry.json/.ts and llms.txt (registry ${data.registry.hash}): live ${data.counts.live} voices, studio ${data.counts.studio} voices`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main() } catch (e) { console.error(e.message); process.exit(1) }
}
