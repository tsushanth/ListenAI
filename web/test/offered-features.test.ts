// Voice design and trained custom voices are switched off (src/content/launchFlags.ts): nothing may offer them, and their
// pages must say so instead of showing a form that cannot work.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { OFFERED_FEATURES, UNAVAILABLE_COPY } from '../src/content/launchFlags.ts'
import { hiddenMcpTools } from '../src/lib/mcp/hiddenTools.ts'
import { createMcpServer } from '../src/lib/mcp/server.ts'
import { CORE_PATHS } from '../src/lib/seoLibrary/sitemapEntries.ts'
import { PARITY_ROWS } from '../src/content/migrationParity.ts'
import { RA_FREE_CREDITS, RA_OTHER_PRODUCTS } from '../src/content/readaloudFacts.ts'

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8')
const DESIGN_TOOLS = ['design_voice', 'get_voice_design']
const STUDIO_TOOLS = ['create_voice_clone', 'upload_voice_clone_dataset', 'commit_voice_clone_dataset', 'get_voice_clone_status', 'deploy_voice_clone', 'delete_voice_clone']
const toolNames = (offered?: { voiceDesign: boolean; customVoiceStudio: boolean }) =>
  Object.keys((createMcpServer({ apiKey: 'k', keyId: 'id' }, offered) as unknown as { _registeredTools: Record<string, unknown> })._registeredTools)

test('both features are off until someone turns them on after a verified live call', () => {
  assert.deepEqual(OFFERED_FEATURES, { voiceDesign: false, customVoiceStudio: false })
})

test('MCP: tools of a switched-off feature are not registered; instant cloning and conversion stay', () => {
  const names = toolNames()
  for (const t of [...DESIGN_TOOLS, ...STUDIO_TOOLS]) assert.ok(!names.includes(t), t)
  for (const t of ['text_to_speech', 'convert_voice', 'readaloud_create_voice_clone', 'readaloud_delete_voice_clone']) assert.ok(names.includes(t), t)
  const all = toolNames({ voiceDesign: true, customVoiceStudio: true })
  for (const t of [...DESIGN_TOOLS, ...STUDIO_TOOLS]) assert.ok(all.includes(t), t)
  assert.equal(all.length, names.length + DESIGN_TOOLS.length + STUDIO_TOOLS.length)
  assert.deepEqual([...hiddenMcpTools({ voiceDesign: true, customVoiceStudio: false })].sort(), [...STUDIO_TOOLS].sort())
})

test('each switched-off page returns the unavailable message before it renders the tool', () => {
  for (const [file, flag, tool] of [
    ['src/app/design-voice/page.tsx', 'voiceDesign', '<VoiceDesigner />'],
    ['src/app/voices/page.tsx', 'customVoiceStudio', '<VoiceStudio />'],
  ] as const) {
    const src = read(file)
    const gate = src.indexOf(`if (!OFFERED_FEATURES.${flag})`)
    assert.ok(gate > 0 && gate < src.indexOf(tool), file)
    assert.ok(src.includes(`message={UNAVAILABLE_COPY.${flag}}`), file)
    assert.ok(!/notFound\(/.test(src), `${file}: a message, not a dead page`)
  }
  for (const m of Object.values(UNAVAILABLE_COPY)) assert.match(m, /not available right now\.$/)
})

test('nothing advertises a switched-off feature: sitemap, parity table, shared facts, llms.txt', () => {
  assert.ok(!CORE_PATHS.includes('/design-voice'))
  for (const feature of ['Professional voice clone (trained voice)', 'Voice design from a text description']) {
    assert.equal(PARITY_ROWS.find((r) => r.feature === feature)!.status, 'not-yet', feature)
  }
  assert.ok(!/voice design/i.test(PARITY_ROWS.filter((r) => r.status !== 'not-yet').map((r) => r.note).join(' ')))
  assert.ok(!/voice design/i.test(RA_FREE_CREDITS.wording + RA_OTHER_PRODUCTS.join(' ')))
  assert.ok(!/voice design|design-voice|trained voice/i.test(read('public/llms.txt')))
})

test('links and docs for the switched-off features are behind their flag', () => {
  assert.match(read('src/components/ra/RaHeader.tsx'), /OFFERED_FEATURES\.voiceDesign \? \[\{ href: '\/design-voice'/)
  assert.match(read('src/components/ra/VoiceStudioLink.tsx'), /if \(!OFFERED_FEATURES\.customVoiceStudio\) return/)
  assert.match(read('src/app/page.tsx'), /OFFERED_FEATURES\.customVoiceStudio && \(/)
  const dev = read('src/app/developers/page.tsx')
  assert.match(dev, /\{STUDIO \? \(<>[\s\S]*<VoiceCloningDocs \/>[\s\S]*<\/>\) : \(/)
  assert.match(dev, /\{DESIGN \? \([\s\S]*\/api\/voice-design[\s\S]*\) : \(/)
})
