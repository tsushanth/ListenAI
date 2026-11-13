import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const { AUDIOBOOK_CTA } = await import('../src/lib/audiobookCta.ts')
const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))

test('the CTA points at a route that exists', () => {
  assert.equal(AUDIOBOOK_CTA.href, '/audiobooks')
  assert.ok(existsSync(here('../src/app/audiobooks/page.tsx')), 'src/app/audiobooks/page.tsx is missing')
})

test('the CTA copy makes no promise the tool cannot keep', () => {
  const copy = Object.values(AUDIOBOOK_CTA).join(' ')
  for (const re of [/\bany book\b/i, /\binstant/i, /\bfree\b/i, /\bunlimited\b/i, /\bguarantee/i, /\bandroid app\b/i]) {
    assert.ok(!re.test(copy), `CTA copy matches ${re}`)
  }
})

test('the signed-in app home and the reader both use the shared CTA, not hand-written copies', () => {
  for (const f of ['../src/app/app/page.tsx', '../src/app/app/reader/page.tsx']) {
    const src = readFileSync(here(f), 'utf8')
    assert.match(src, /from '@\/lib\/audiobookCta'/, `${f} does not import the CTA`)
    assert.match(src, /AUDIOBOOK_CTA\.href/, `${f} does not link to AUDIOBOOK_CTA.href`)
    assert.ok(!/href=["']\/audiobooks["']/.test(src), `${f} hard-codes /audiobooks`)
  }
})
