import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const { adminGaugemint } = await import('../src/lib/adminGaugemint.ts')
const { GAUGEMINT_ERROR_STATUS } = await import('../src/lib/gaugemintTypes.ts')

const WEB = fileURLToPath(new URL('..', import.meta.url))
const read = (p: string) => readFileSync(join(WEB, p), 'utf8')

const okStats = {
  ok: true as const, fetchedAt: '2026-11-21T10:00:00.000Z',
  stats: { site: 'readaloudai.org', period: '30d' as const, granularity: 'day' as const, totals: { visitors: 1, pageviews: 2, visits: 1, bounce_rate: 50, visit_duration: 10 }, series: [], pages: [], sources: [], countries: [], devices: [] },
}

// ---------- the handler ----------

test('not an admin: 404 "Not found" and Gaugemint is never called', async () => {
  let called = false
  const r = await adminGaugemint({ isAdmin: false, period: '7d', getStats: async () => { called = true; return okStats } })
  assert.equal(r.status, 404); assert.equal(r.body, 'Not found'); assert.equal(r.contentType, 'text/plain'); assert.equal(called, false)
})

test('admin: 200 with the stats JSON; the period is validated (junk and missing mean 30d)', async () => {
  const seen: string[] = []
  const getStats = async (p: string) => { seen.push(p); return okStats }
  for (const p of ['7d', '30d', '12mo', '90d', '../../x', '', null]) {
    const r = await adminGaugemint({ isAdmin: true, period: p, getStats })
    assert.equal(r.status, 200); assert.equal(r.contentType, 'application/json')
    assert.equal(JSON.parse(r.body).ok, true)
  }
  assert.deepEqual(seen, ['7d', '30d', '12mo', '30d', '30d', '30d', '30d'])
})

test('every error kind answers with its documented status and a JSON body of kind + message only', async () => {
  for (const [kind, status] of Object.entries(GAUGEMINT_ERROR_STATUS)) {
    const r = await adminGaugemint({ isAdmin: true, period: '30d', getStats: async () => ({ ok: false, error: { kind: kind as any, message: 'm' } }) })
    assert.equal(r.status, status, kind)
    assert.deepEqual(JSON.parse(r.body), { ok: false, error: { kind, message: 'm' } })
  }
  assert.equal(GAUGEMINT_ERROR_STATUS.not_configured, 500)
})

test('a getStats that throws is a generic 502, no internals leaked', async () => {
  const r = await adminGaugemint({ isAdmin: true, period: '30d', getStats: async () => { throw new Error('boom 10.0.0.1') } })
  assert.equal(r.status, 502); assert.doesNotMatch(r.body, /boom|10\.0\.0\.1/)
})

// ---------- the route file: same guard as /api/admin/overview, in front of everything ----------

const GUARD = `if (!(await isAdminToken(request.headers.get('authorization')))) return new NextResponse('Not found', { status: 404 });`

test('the route repeats the overview route admin check exactly, before anything else runs', () => {
  const overview = read('src/app/api/admin/overview/route.ts')
  const route = read('src/app/api/admin/gaugemint/route.ts')
  assert.ok(overview.includes(GUARD), 'overview guard line changed: update GUARD here and in the new route together')
  assert.ok(route.includes(GUARD), 'gaugemint route must use the same guard line as overview')
  assert.match(route, /import \{ isAdminToken \} from '@\/lib\/adminAuth';/)
  const code = route.replace(/^\/\/.*$/gm, '')
  const guardAt = code.indexOf(GUARD)
  assert.ok(guardAt > 0)
  for (const later of ['getGaugemintStats(', 'adminGaugemint(', 'searchParams', 'process.env']) {
    const i = code.indexOf(later)
    assert.ok(i === -1 || i > guardAt, `${later} appears before the guard`)
  }
})

test('the route never takes the site from the request and never touches overview', () => {
  const code = read('src/app/api/admin/gaugemint/route.ts').replace(/^\/\/.*$/gm, '')
  assert.doesNotMatch(code, /get\(['"](site|domain|site_id)['"]\)/)
  assert.doesNotMatch(code, /overview/)
  assert.match(code, /searchParams\.get\('period'\)/)
  assert.match(code, /export const dynamic = 'force-dynamic'/)
  assert.match(code, /'Cache-Control': 'no-store'/)
})

test('the overview route and the existing sender are untouched by this feature', () => {
  assert.doesNotMatch(read('src/app/api/admin/overview/route.ts'), /gaugemint/i)
  assert.doesNotMatch(read('src/lib/gaugemint.ts'), /READ_KEY/)
})

// ---------- the key stays on the server ----------

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(n)) out.push(p)
  }
  return out
}

test('only the admin route imports the read client; no client component does; the key has no NEXT_PUBLIC_ twin', () => {
  const importers: string[] = []
  for (const f of walk(join(WEB, 'src'))) {
    const rel = f.slice(WEB.length)
    const text = readFileSync(f, 'utf8')
    if (/GAUGEMINT_READ_KEY/.test(text) && /NEXT_PUBLIC_GAUGEMINT/.test(text)) assert.fail(`${rel} exposes the read key`)
    if (/['"]@\/lib\/gaugemintRead['"]|\/gaugemintRead(\.ts)?['"]/.test(text)) {
      importers.push(rel)
      assert.doesNotMatch(text.slice(0, 200), /['"]use client['"]/, `${rel} is a client file`)
    }
    if (/process\.env\.GAUGEMINT/.test(text) && /['"]use client['"]/.test(text.slice(0, 200))) assert.fail(`${rel} is a client file that reads a Gaugemint env var`)
  }
  assert.deepEqual(importers.sort(), ['src/app/api/admin/gaugemint/route.ts'])
})

test('the admin page gets a third tab Web, standalone, rendering the card with the token', () => {
  const page = read('src/app/admin/page.tsx')
  assert.match(page, /\{ label: 'Web', value: 'web' \}/)
  assert.match(page, /standaloneScopes=\{\['web'\]\}/)
  assert.match(page, /<AdminGaugemint token=\{token\} \/>/)
  const card = read('src/components/AdminGaugemint.tsx')
  assert.match(card, /\/api\/admin\/gaugemint\?period=/)
  assert.doesNotMatch(card, /guagemint\.com|api\/v1\/stats/)
})
