// Guard for the owner's rule: nothing a visitor or an API/MCP user of the web app can read names a model, an engine, a dataset or a vendor
// we serve. A voice shows its name, language, dialect (plus gender and the Live/Studio tier) and nothing else.
//
// What is scanned (the places text reaches a visitor, an HTTP response, an MCP tool description or response, page metadata, JSON-LD, llms.txt):
//   - string literals, template-literal text and JSX text in every .ts/.tsx file under src/app, src/components, src/lib and src/content
//     (a TypeScript AST walk: identifiers, comments and import paths are NOT scanned, so internal names and notes never need an entry)
//   - every key and string value of the .json files under src/content and src/generated
//   - the generated .ts twins under src/generated, and every text file under public/
// What is NOT scanned: admin-only pages and components (internal), tests, scripts.
//
// The terms are registry/public-policy.json's denylist (read through TTS_REGISTRY_DIR, as the sync --check test does), matched exactly as
// registry/build.mjs publicLeak does (case-insensitive, word boundaries, a space also matches "-" or nothing), plus EXTRA_TERMS below.
// An allow-list entry (file + terms + reason) is the only way past a hit. Each entry must still match something, so a stale one fails the test.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const WEB = fileURLToPath(new URL('..', import.meta.url))
const REGISTRY_DIR = process.env.TTS_REGISTRY_DIR
const SKIP = !REGISTRY_DIR || !existsSync(join(REGISTRY_DIR, 'public-policy.json'))
  ? 'set TTS_REGISTRY_DIR to the registry folder (the one holding public-policy.json) to run the public-leak guard'
  : false

/** Model names that the registry policy does not list yet but that were found on visitor-facing text. Propose them for public-policy.json. */
const EXTRA_TERMS = ['seed-vc', 'seedvc', 'misaki', 'perth', 'parler']

type Allow = { file: string; terms: string[]; text?: RegExp; reason: string }
/**
 * Every entry names one file, the terms it may contain and why that text is not a disclosure. `text` narrows an entry to hits whose
 * literal matches it. Keep this short: a new entry needs a reason a reviewer can accept.
 */
const ALLOW: Allow[] = [
  {
    file: 'src/app/credits/page.tsx',
    terms: ['cml-tts', 'libritts', 'librispeech', 'mls'],
    reason: 'The /credits page names the three CC BY 4.0 datasets that some voices were trained on, because that licence requires crediting the authors. Dataset author lines only: no model, engine or vendor line remains on that page.',
  },
  {
    file: 'src/content/readaloudFacts.ts',
    terms: ['piper', 'kokoro', 'chatterbox', 'xtts', 'orpheus', 'coqui', 'whisper', 'styletts', 'lessac', 'parler'],
    text: /^piper$|^kokoro$|^chatterbox$|^xtts$|^orpheus$|^whisper$|^parler$|^styletts$|^lessac$|^faster-whisper$|^coqui$/,
    reason: 'RA_FORBIDDEN_ENGINE_NAMES: the list of names the SEO library validators must NOT see on a page. It is never rendered; it exists to ban these words.',
  },
  {
    file: 'src/content/vendors/resemble-ai.json',
    terms: ['chatterbox'],
    text: /^https:\/\/www\.resemble\.ai\/chatterbox\/$/,
    reason: 'Vendor comparison page for Resemble AI: source URL of Resemble\'s own product page, cited for Resemble\'s own claims (streaming, licensing). No text says or implies ReadAloud serves that model.',
  },
  {
    file: 'src/generated/tts-legacy-voice-ids.ts',
    terms: ['mls', 'serena', 'paola', 'faber', 'cadu', 'supertonic'],
    reason: 'Input-only map from old voice ids to public ids, so a client that still sends an old id is understood. It is never rendered and never returned in a response or tool output; list_voices and the docs use the public ids only.',
  },
  {
    file: 'src/lib/readerVoices.ts',
    terms: ['libritts', 'ljspeech'],
    text: /^custom:en-us-(libritts_r-[fm]\d+|ljspeech)$/,
    reason: 'Wire ids the web reader sends to the speech worker (the same ids the Android app sends) and stores in localStorage. They are never rendered: the picker shows the name and a language/dialect label. They need a public alias from the gateway before they can change (follow-up).',
  },
  {
    file: 'src/lib/piperReader.ts',
    terms: ['piper'],
    text: /^piper$/,
    reason: 'The engine value the web reader sends in its own authorize request body to our backend. A request field, not a response and not shown to anyone; it changes only together with the backend.',
  },
  {
    file: 'src/lib/mcp/upstream.ts',
    terms: ['piper'],
    text: /^https:\/\/piper-tts-sjc\.fly\.dev\/health$/,
    reason: 'Server-to-server health probe URL, fetched by this process. get_api_status returns only status and stream counts, never the host.',
  },
]

// ---------------------------------------------------------------------------------------------------------------------------------
const policy = SKIP ? { denylist: [] as string[] } : JSON.parse(readFileSync(join(REGISTRY_DIR!, 'public-policy.json'), 'utf8'))
const DENY = [...policy.denylist, ...EXTRA_TERMS].map((t: string) => [t, new RegExp('(^|[^a-z0-9])' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '[ -]?') + '($|[^a-z0-9])', 'i')] as const)
const hitsIn = (text: string) => DENY.filter(([, re]) => re.test(text)).map(([t]) => t)

/** Admin-only pages and components are internal and stay untouched. */
const isAdmin = (rel: string) => /(^|\/)(admin[^/]*|Admin[^/]*|adminBusiness[^/]*)(\/|\.|$)/.test(rel)

function walk(dir: string, accept: (rel: string) => boolean, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (f === 'node_modules' || f === '.next') continue
    if (statSync(p).isDirectory()) walk(p, accept, out)
    else { const rel = relative(WEB, p).split(sep).join('/'); if (accept(rel) && !isAdmin(rel)) out.push(rel) }
  }
  return out
}

type Hit = { file: string; term: string; text: string }

/** String literals, template text and JSX text of a source file; identifiers, comments and module specifiers are skipped. */
export function visibleStrings(rel: string, src: string): string[] {
  const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, rel.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const out: string[] = []
  const visit = (n: ts.Node) => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) return // module specifiers are code paths, not text
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) out.push(n.text)
    else if (ts.isJsxText(n)) out.push(n.text)
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

function jsonStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) v.forEach((x) => jsonStrings(x, out))
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); jsonStrings(x, out) }
  return out
}

export function collectHits(): { hits: Hit[]; scanned: number } {
  const hits: Hit[] = []
  let scanned = 0
  const add = (file: string, texts: string[]) => { scanned += texts.length; for (const text of texts) for (const term of hitsIn(text)) hits.push({ file, term, text }) }
  const code = (rel: string) => /\.(ts|tsx)$/.test(rel) && !/\.d\.ts$/.test(rel)
  for (const root of ['src/app', 'src/components', 'src/lib', 'src/content', 'src/generated']) {
    for (const rel of walk(join(WEB, root), (r) => code(r) || (/^src\/(content|generated)\//.test(r) && r.endsWith('.json')))) {
      const raw = readFileSync(join(WEB, rel), 'utf8')
      add(rel, rel.endsWith('.json') ? jsonStrings(JSON.parse(raw)) : visibleStrings(rel, raw))
    }
  }
  for (const rel of walk(join(WEB, 'public'), (r) => /\.(txt|xml|json|md|html|svg|webmanifest|js)$/.test(r))) {
    // public files are served as they are: every line counts, comments included
    add(rel, readFileSync(join(WEB, rel), 'utf8').split('\n'))
  }
  return { hits, scanned }
}

const allowed = (h: Hit, used: Set<Allow>): boolean => {
  const a = ALLOW.find((e) => e.file === h.file && e.terms.includes(h.term) && (!e.text || e.text.test(h.text.trim())))
  if (a) used.add(a)
  return !!a
}

test('public-leak: no visitor-facing text names a model, engine, dataset or vendor we serve', { skip: SKIP }, () => {
  const { hits, scanned } = collectHits()
  assert.ok(scanned > 2000, `the scan should cover the whole web app (saw only ${scanned} strings)`)
  const used = new Set<Allow>()
  const bad = hits.filter((h) => !allowed(h, used))
  assert.deepEqual(bad.map((h) => `${h.file}: "${h.term}" in "${h.text.slice(0, 110)}"`), [], 'a denylisted term reached visitor-facing text; reword it, or (only if it is not a disclosure) add an allow-list entry with a reason')
  const stale = ALLOW.filter((e) => !used.has(e))
  assert.deepEqual(stale.map((e) => e.file), [], 'allow-list entries that no longer match anything: delete them')
})

test('public-leak: the matcher is the registry\'s (word boundaries, case-insensitive) and flags a reintroduced term', { skip: SKIP }, () => {
  assert.deepEqual(hitsIn('Powered by Kokoro-82M'), ['kokoro'])
  assert.deepEqual(hitsIn('the PIPER voice'), ['piper'])
  assert.deepEqual(hitsIn('Fish Speech and fish-speech'), ['fish speech'])
  assert.deepEqual(hitsIn('Seed-VC'), ['seed-vc'])
  assert.deepEqual(hitsIn('whispers and whispering'), [], 'a longer word is not the term')
  assert.deepEqual(hitsIn('Voices: de-f1, en-heart, Studio, Live'), [])
  // the AST walk reads text and ignores identifiers and comments
  const strs = visibleStrings('x.tsx', "// piper in a comment\nconst PIPER_VOICE = 'ok'\nconst a = <p>hello Kokoro</p>\nconst b = `x ${PIPER_VOICE} y`")
  assert.deepEqual(strs.filter((s) => hitsIn(s).length).map((s) => s.trim()), ['hello Kokoro'])
})

test('public-leak: generated public data carries only the public voice fields', () => {
  const reg = JSON.parse(readFileSync(join(WEB, 'src/generated/tts-registry.json'), 'utf8'))
  const allowedVoiceKeys = new Set(['id', 'name', 'language', 'languages', 'dialect', 'gender', 'beta'])
  for (const t of ['live', 'studio']) {
    for (const v of reg.engines[t].voices) for (const k of Object.keys(v)) assert.ok(allowedVoiceKeys.has(k), `${t}/${v.id}: unexpected field ${k}`)
    for (const k of Object.keys(reg.engines[t])) assert.ok(['label', 'publicAlias', 'languages', 'defaultVoice', 'voices', 'voicesByLanguage', 'betaLanguages'].includes(k), `${t}: unexpected field ${k}`)
  }
  assert.equal(reg.registry.catalog, 'public-catalog.json')
})
