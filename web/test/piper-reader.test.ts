import { test } from 'node:test'
import assert from 'node:assert/strict'

const { splitText, buildWav, wavHeader, MAX_CHUNK_CHARS, PIPER_VOICE } = await import('../src/lib/piperReader.ts')

test('splitText keeps short text whole and trims it', () => {
  assert.deepEqual(splitText('  Hello there.  '), ['Hello there.'])
  assert.deepEqual(splitText('   '), [])
})

test('splitText never exceeds the limit and loses no words', () => {
  const sentence = 'The quick brown fox jumps over the lazy dog. '
  const text = sentence.repeat(300) // about 13,500 characters
  const parts = splitText(text, 4000)
  assert.ok(parts.length >= 4)
  for (const p of parts) assert.ok(p.length <= 4000, `piece of ${p.length} chars`)
  assert.equal(parts.join(' ').split(/\s+/).join(' '), text.trim().split(/\s+/).join(' '))
})

test('splitText prefers sentence ends over cutting mid-sentence', () => {
  const text = 'Alpha beta gamma. Delta epsilon zeta. Eta theta iota. Kappa lambda mu.'
  const parts = splitText(text, 40)
  for (const p of parts.slice(0, -1)) assert.match(p, /[.!?]$/)
  assert.ok(parts.every((p) => p.length <= 40))
})

test('splitText prefers paragraph breaks and falls back to words, then a hard cut', () => {
  const para = splitText('First paragraph is here.\n\nSecond paragraph follows after it ends.', 40)
  assert.equal(para[0], 'First paragraph is here.')
  const words = splitText('word '.repeat(30), 20)
  assert.ok(words.every((p) => p.length <= 20 && !p.includes('  ')))
  const hard = splitText('x'.repeat(95), 40)
  assert.deepEqual(hard.map((p) => p.length), [40, 40, 15])
})

test('the default chunk limit stays under the worker cap of 5000 characters', () => {
  assert.ok(MAX_CHUNK_CHARS < 5000)
  assert.equal(PIPER_VOICE, 'custom:en-us-warm-f')
})

test('wavHeader describes 16-bit mono PCM', () => {
  const h = wavHeader(1000, 24000)
  const dv = new DataView(h.buffer)
  assert.equal(h.length, 44)
  assert.equal(String.fromCharCode(...h.slice(0, 4)), 'RIFF')
  assert.equal(String.fromCharCode(...h.slice(8, 12)), 'WAVE')
  assert.equal(dv.getUint32(4, true), 1036)
  assert.equal(dv.getUint16(20, true), 1)       // PCM
  assert.equal(dv.getUint16(22, true), 1)       // mono
  assert.equal(dv.getUint32(24, true), 24000)   // sample rate
  assert.equal(dv.getUint32(28, true), 48000)   // byte rate
  assert.equal(dv.getUint16(34, true), 16)      // bits
  assert.equal(dv.getUint32(40, true), 1000)    // data length
})

test('buildWav concatenates frames in order after the header', () => {
  const wav = buildWav([Uint8Array.of(1, 2, 3, 4), Uint8Array.of(5, 6)], 22050)
  assert.equal(wav.length, 44 + 6)
  assert.deepEqual([...wav.slice(44)], [1, 2, 3, 4, 5, 6])
  assert.equal(new DataView(wav.buffer).getUint32(40, true), 6)
  assert.equal(buildWav([], 24000).length, 44)
})

// ---- session token reuse (fake fetch + WebSocket) ----
const { synthesizeWithPiper, clearAuthCache, AUTH_REUSE_MS } = await import('../src/lib/piperReader.ts')

type Script = (ws: FakeWS) => void
class FakeWS {
  static instances: FakeWS[] = []
  static script: Script = (ws) => ws.speak()
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string | ArrayBuffer }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  binaryType = ''
  sent: string[] = []
  url: string
  constructor(url: string) { this.url = url; FakeWS.instances.push(this); queueMicrotask(() => this.onopen?.()) }
  send(m: string) { this.sent.push(m); FakeWS.script(this) }
  close() {}
  speak() {
    queueMicrotask(() => {
      this.onmessage?.({ data: JSON.stringify({ type: 'chunk_meta', sample_rate: 24000 }) })
      this.onmessage?.({ data: new Int16Array([1, 2, 3, 4]).buffer })
      this.onmessage?.({ data: JSON.stringify({ type: 'done' }) })
    })
  }
}

function install(tokenFor: (n: number) => string) {
  let n = 0
  const calls: string[] = []
  ;(globalThis as any).fetch = async (url: string) => {
    calls.push(url)
    n += 1
    return { ok: true, status: 200, json: async () => ({ token: tokenFor(n), url: 'wss://worker.example/tts' }) }
  }
  ;(globalThis as any).WebSocket = FakeWS
  FakeWS.instances = []
  FakeWS.script = (ws) => ws.speak()
  clearAuthCache()
  return calls
}
const opts = { apiUrl: 'https://api.example' }

test('repeat generations within the reuse window authorize only once', async () => {
  const calls = install((n) => `tok${n}`)
  await synthesizeWithPiper('First take.', opts)
  await synthesizeWithPiper('Second take.', opts)
  await synthesizeWithPiper('Third take.', opts)
  assert.equal(calls.length, 1)
  assert.equal(FakeWS.instances.length, 3)
  assert.ok(FakeWS.instances.every((w) => w.url.endsWith('?token=tok1')))
})

test('the session token is not reused after the window expires', async () => {
  const calls = install((n) => `tok${n}`)
  const realNow = Date.now
  let t = 1_000_000
  Date.now = () => t
  try {
    await synthesizeWithPiper('First take.', opts)
    t += AUTH_REUSE_MS - 1
    await synthesizeWithPiper('Still inside the window.', opts)
    assert.equal(calls.length, 1)
    t += 2
    await synthesizeWithPiper('Now expired.', opts)
    assert.equal(calls.length, 2)
    assert.ok(FakeWS.instances[2]!.url.endsWith('?token=tok2'))
  } finally { Date.now = realNow }
})

test('a reused token the server drops is replaced once, transparently', async () => {
  const calls = install((n) => `tok${n}`)
  await synthesizeWithPiper('Warm the cache.', opts)
  FakeWS.script = (ws) => {                         // the cached token tok1 is now rejected: the socket closes without a word
    if (ws.url.endsWith('tok1')) queueMicrotask(() => ws.onclose?.())
    else ws.speak()
  }
  const r = await synthesizeWithPiper('Retry me.', opts)
  assert.equal(calls.length, 2)                      // initial authorize + one fresh authorize
  assert.ok(r.durationSec > 0)
  assert.ok(FakeWS.instances.at(-1)!.url.endsWith('tok2'))
})

test('a fresh token that is dropped is NOT retried forever', async () => {
  const calls = install((n) => `tok${n}`)
  FakeWS.script = (ws) => { queueMicrotask(() => ws.onclose?.()) }
  await assert.rejects(() => synthesizeWithPiper('Doomed.', opts), /closed before the audio finished/)
  assert.equal(calls.length, 1)
})

test('a 429 from authorize is reported and nothing is cached', async () => {
  install((n) => `tok${n}`)
  ;(globalThis as any).fetch = async () => ({ ok: false, status: 429, json: async () => ({}) })
  await assert.rejects(() => synthesizeWithPiper('Hello there.', opts), /Too many requests/)
  const calls = install((n) => `tok${n}`)
  await synthesizeWithPiper('Hello again.', opts)
  assert.equal(calls.length, 1)
})
