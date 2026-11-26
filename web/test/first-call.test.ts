import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  buildFirstCallCurl,
  buildExportLine,
  copyTextSafely,
  shellQuote,
  FIRST_CALL_NOTE,
  COPY_FAILED_MESSAGE,
  canRunFirstCall,
  runNowSuccessLine,
} from '../src/lib/firstCall.ts'

// The web app has no component-test setup (no jsdom / testing-library), so the first-call block is tested as:
//  - pure helpers in src/lib/firstCall.ts (snippet builder, copy fallback), run for real
//  - source assertions on the components/pages for the wiring that cannot run without a browser
// A real browser run of the key flow is NOT covered here.

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const KEY = 'rtts_example_not_a_real_key'

test('A: the snippet embeds the key, calls the speech endpoint with the agreed body, and fails loudly on HTTP errors', () => {
  const s = buildFirstCallCurl(KEY)
  assert.match(s, /^curl -f --show-error -o hello\.mp3 https:\/\/api\.readaloudai\.org\/v1\/audio\/speech \\\n/)
  assert.ok(s.includes(`-H 'Authorization: Bearer ${KEY}'`))
  assert.ok(s.includes(`-d '{"model":"tts-1","voice":"readaloud-default","input":"Hello from ReadAloud.","response_format":"mp3"}'`))
  assert.ok(!s.includes('$READALOUD_API_KEY'))
})

test('A: the export line and the one-line hint', () => {
  assert.equal(buildExportLine(KEY), `export READALOUD_API_KEY='${KEY}'`)
  assert.equal(FIRST_CALL_NOTE, 'If hello.mp3 will not play, open it in a text editor: it contains the error message.')
})

test('A: a key with a quote cannot break out of the shell quoting', () => {
  assert.equal(shellQuote(`a'b`), `'a'\\''b'`)
  const sh = spawnSync('sh', ['-c', `printf %s ${shellQuote(`a'b$(x)`)}`], { encoding: 'utf8' })
  assert.equal(sh.stdout, `a'b$(x)`)
})

test('A: the generated snippet parses as a single curl command in sh (dry run, no network)', () => {
  const dir = fileURLToPath(new URL('.', import.meta.url))
  // `sh -n` only parses; nothing is executed or sent.
  const r = spawnSync('sh', ['-n', '-c', buildFirstCallCurl(KEY)], { encoding: 'utf8', cwd: dir })
  assert.equal(r.status, 0, r.stderr)
})

test('C: copyTextSafely reports success, refusal and a missing clipboard', async () => {
  let written = ''
  assert.equal(await copyTextSafely('k', { writeText: async (t: string) => { written = t } }), true)
  assert.equal(written, 'k')
  assert.equal(await copyTextSafely('k', { writeText: async () => { throw new Error('denied') } }), false)
  assert.equal(await copyTextSafely('k', { writeText: () => { throw new Error('sync throw') } } as never), false)
  assert.equal(await copyTextSafely('k', undefined), false)
  assert.equal(COPY_FAILED_MESSAGE, 'Copy failed, select the key and copy it manually')
})

test('A and C: the component wires the block, the fallback message and wrapping; the key goes nowhere else', () => {
  const c = read('../src/components/DeveloperApiSection.tsx')
  const keyBox = c.slice(c.indexOf('ref={keyBoxRef}'), c.indexOf('</code>', c.indexOf('ref={keyBoxRef}')))
  assert.match(keyBox, /break-all/)
  assert.doesNotMatch(keyBox, /truncate/)
  assert.match(c, /copyTextSafely\(newKey/)
  assert.match(c, /COPY_FAILED_MESSAGE/)
  assert.match(c, /selectElementText\(keyBoxRef\.current\)/)
  assert.doesNotMatch(c, /navigator\.clipboard\.writeText/)
  assert.match(c, /Make your first call/)
  assert.match(c, /buildFirstCallCurl\(newKey\)/)
  assert.match(c, /buildExportLine\(newKey\)/)
  // newKey must not reach console, storage, URLs or analytics
  for (const line of c.split('\n').filter(l => l.includes('newKey'))) {
    assert.doesNotMatch(line, /console\.|localStorage|sessionStorage|fetch\(|posthog|track\(|location|sendBeacon/i, line)
  }
  const lib = read('../src/lib/firstCall.ts')
  assert.doesNotMatch(lib, /console\.|localStorage|sessionStorage|fetch\(|sendBeacon/)
})

test('B: every curl that writes audio to a file on the developers page uses -f --show-error', () => {
  const files = [
    '../src/app/developers/page.tsx',
    '../src/components/ra/VoiceCloningDocs.tsx',
    '../src/components/ra/ConsentVoiceCloningDocs.tsx',
  ]
  let checked = 0
  for (const f of files) {
    const src = read(f)
    // split into curl invocations: a `curl` word to the next blank line or closing backtick
    const cmds = src.match(/curl [\s\S]*?(?=\n\n|`)/g) ?? []
    for (const cmd of cmds) {
      if (/--output\s|\s-o\s/.test(cmd)) {
        checked++
        assert.match(cmd, /^curl -f --show-error /, `${f}: ${cmd.split('\n')[0]}`)
      }
    }
  }
  assert.equal(checked, 5, 'expected 5 audio-writing curls (openai-compatible, vapi, 2 voice-clone, 1 consent clone)')
})

test('B: the OpenAI-compatible curl is followed by the export sentence', () => {
  const p = read('../src/app/developers/page.tsx')
  assert.match(p, /--output hello\.mp3`\}<\/code><\/pre>\n\s*<p[^>]*>Run <code>export READALOUD_API_KEY=your_key<\/code> first; an empty key returns <code>401<\/code>\.<\/p>/)
})

test('D: Run it now is offered only when the call is free, and says what it used', () => {
  assert.equal(canRunFirstCall(true, 0), true)
  assert.equal(canRunFirstCall(false, 10000), true)
  assert.equal(canRunFirstCall(false, 20), false)
  assert.equal(canRunFirstCall(false, 0), false)
  assert.equal(canRunFirstCall(false, undefined), false)
  assert.equal(runNowSuccessLine(21, false), 'It worked and used 21 characters of your free credits. Press play to hear it.')
  assert.equal(runNowSuccessLine(21, true), 'It worked. Press play to hear it.')
})

test('D: the button sends the new key to our backend route only, and the result is shown with a player', () => {
  const c = read('../src/components/DeveloperApiSection.tsx')
  assert.match(c, /Run it now/)
  assert.match(c, /ttsApiKeysApi\.firstCall\(newKey\)/)
  assert.match(c, /<audio controls src=\{runResult\.audioUrl\}/)
  assert.match(read('../src/lib/ttsApiKeysApi.ts'), /'\/api\/tts-api-keys\/first-call'/)
})
