// End-to-end check of /app/reader in a real Chrome: every Generate <-> Play transition in ONE page session, and that the
// session makes a single realtime-tts authorize call (the backend allows 10 per IP per 5 minutes).
//
// NOT part of `npm test`: it needs Chrome, network access and the live voice service (it generates real audio, a few
// sentences per run). Run it on demand:
//
//   npm run test:e2e:reader                                   # against http://localhost:3000 (start `npm run dev` first)
//   BASE_URL=https://readaloudai.org npm run test:e2e:reader  # against production
//
// Env:  BASE_URL    site origin (default http://localhost:3000)
//       CHROME_PATH Chrome/Chromium executable (default: first one found on macOS/Linux)
//       SHOTS_DIR   if set, a final screenshot is written there
//
// Against a local server the backend's CORS (readaloudai.org only) would block the browser, so web security is switched
// off for localhost runs only; runs against any other origin keep it on, which also proves CORS works from that origin.
import puppeteer from 'puppeteer-core'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE_URL = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '')
const IS_LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(BASE_URL)

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]
  return candidates.find((p) => p && existsSync(p))
}
const executablePath = findChrome()
if (!executablePath) {
  console.error('No Chrome found. Set CHROME_PATH to a Chrome/Chromium executable.')
  process.exit(2)
}

const profile = mkdtempSync(join(tmpdir(), 'reader-e2e-'))
const browser = await puppeteer.launch({
  executablePath,
  headless: 'new',
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox', ...(IS_LOCAL ? ['--disable-web-security'] : []), `--user-data-dir=${profile}`],
  defaultViewport: { width: 1400, height: 1000 },
})

const results = []
const rec = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

try {
  const page = await browser.newPage()
  let authorizePosts = 0
  page.on('request', (r) => { if (r.url().includes('/api/realtime-tts/authorize') && r.method() === 'POST') authorizePosts++ })
  page.on('pageerror', (e) => console.log('  page error:', e.message))
  await page.goto(`${BASE_URL}/app/reader`, { waitUntil: 'networkidle2', timeout: 60000 })

  const buttons = () => page.$$eval('button', (bs) => bs.map((b) => (b.textContent || '').trim()))
  const has = async (prefix) => (await buttons()).some((t) => t.startsWith(prefix))
  const waitFor = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(150) } return false }
  const click = (prefix) => page.evaluate((p) => {
    const b = [...document.querySelectorAll('button')].find((e) => (e.textContent || '').trim().startsWith(p))
    if (b) b.click()
    return !!b
  }, prefix)
  const setText = async (t) => { await page.click('textarea', { clickCount: 3 }); await page.keyboard.press('Backspace'); await page.type('textarea', t) }
  const generate = async (t) => { await setText(t); await click('Generate Speech'); return waitFor(async () => (await has('Pause')) || (await has('Play'))) }

  rec('1  first generation produces player controls', await generate('The old lighthouse stood at the edge of the cliff, its lamp swinging slowly against the grey evening sky.'))
  await click('Pause')
  await click('Start over'); await sleep(300)
  rec('2  paused, then Start over returns to Generate', await has('Generate Speech'))
  rec('3  a second generation works', await generate('Second take, with different words.'))
  await click('Start over'); await sleep(300)
  rec('4  Start over after a generated clip returns to Generate', await has('Generate Speech'))
  await generate('Third take.')
  await page.type('textarea', ' And then it rained.'); await sleep(300)
  rec('5  editing the text after generating returns to Generate', await has('Generate Speech'))
  await generate('This sentence is long enough that it is still playing when we press the button, so we can check that the audio stops. '.repeat(3))
  const wasPlaying = await has('Pause')
  await click('Start over'); await sleep(300)
  rec('6  Start over while playing returns to Generate', wasPlaying && (await has('Generate Speech')), wasPlaying ? 'was playing' : 'was not playing, test invalid')
  await generate('Short one.')
  await waitFor(() => has('Play'), 15000)   // clip ended
  await click('Play')
  rec('7  Play after the clip ended replays it', await waitFor(() => has('Pause'), 5000))
  if (process.env.SHOTS_DIR) await page.screenshot({ path: join(process.env.SHOTS_DIR, 'reader-flow-final.png') })
  rec('8  the whole session used a single authorize call', authorizePosts === 1, `${authorizePosts} authorize POST(s)`)
} finally {
  await browser.close()
  rmSync(profile, { recursive: true, force: true })
}

const failed = results.filter((ok) => !ok).length
console.log(`\n${BASE_URL}: ${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
