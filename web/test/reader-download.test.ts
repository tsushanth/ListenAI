import { test } from 'node:test'
import assert from 'node:assert/strict'

const { readerDownloadFilename } = await import('../src/lib/readerDownload.ts')

test('file name comes from the first words of the text', () => {
  assert.equal(readerDownloadFilename('The Quick Brown Fox!'), 'readaloud-the-quick-brown-fox.wav')
  assert.equal(readerDownloadFilename('  \n Chapter 1: A Beginning  '), 'readaloud-chapter-1-a-beginning.wav')
})

test('only the first 8 words and 48 characters are used', () => {
  assert.equal(readerDownloadFilename('one two three four five six seven eight nine ten'), 'readaloud-one-two-three-four-five-six-seven-eight.wav')
  const long = readerDownloadFilename('supercalifragilisticexpialidocious '.repeat(5))
  assert.ok(long.length <= 'readaloud-'.length + 48 + '.wav'.length, long)
  assert.match(long, /^readaloud-[a-z0-9-]+\.wav$/)
  assert.ok(!long.includes('--') && !long.endsWith('-.wav'))
})

test('accents are folded and unsafe characters never reach the name', () => {
  assert.equal(readerDownloadFilename('Café crème'), 'readaloud-cafe-creme.wav')
  const nasty = readerDownloadFilename('../../etc/passwd; rm -rf "/" <script>')
  assert.match(nasty, /^readaloud-[a-z0-9-]+\.wav$/)
  assert.ok(!/[\\/<>:"|?*;\s.]/.test(nasty.slice(0, -4)))
})

test('text with nothing usable falls back to a plain name', () => {
  for (const t of ['', '   ', '!!!', '你好世界', '\u{1F600}\u{1F600}']) {
    assert.equal(readerDownloadFilename(t), 'readaloud-audio.wav', JSON.stringify(t))
  }
})
