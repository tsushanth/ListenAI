import { test } from 'node:test'
import assert from 'node:assert/strict'

const m = await import('../src/lib/adminBusiness.ts')

test('fmtNumber / fmtChars / fmtMinutes', () => {
  assert.equal(m.fmtNumber(1234567), '1,234,567')
  assert.equal(m.fmtNumber(NaN), '—')
  assert.equal(m.fmtChars(950), '950')
  assert.equal(m.fmtChars(340_000), '340k')
  assert.equal(m.fmtChars(1_240_000), '1.2M')
  assert.equal(m.fmtMinutes(12.5), '12.5 min')
  assert.equal(m.fmtMinutes(192), '3.2 h')
  assert.equal(m.fmtMinutes(0), '0 min')
})

test('fmtChars handles boundary and edge cases', () => {
  assert.equal(m.fmtChars(999_500), '1M')
  assert.equal(m.fmtChars(-340_000), '-340k')
  assert.equal(m.fmtChars(-950), '-950')
  assert.equal(m.fmtChars(NaN), '—')
})

test('fmtMinutes handles rounding boundary at 120', () => {
  assert.equal(m.fmtMinutes(119.96), '2 h')
  assert.equal(m.fmtMinutes(119.4), '119.4 min')
})

test('fmtAgo handles null and units', () => {
  const now = Date.parse('2026-10-08T12:00:00Z')
  assert.equal(m.fmtAgo(null, now), 'never')
  assert.equal(m.fmtAgo('2026-10-08T11:59:30Z', now), '30s ago')
  assert.equal(m.fmtAgo('2026-10-08T11:50:00Z', now), '10m ago')
  assert.equal(m.fmtAgo('2026-10-08T07:00:00Z', now), '5h ago')
  assert.equal(m.fmtAgo('2026-10-05T12:00:00Z', now), '3d ago')
})

test('fmtAgo handles invalid and future timestamps', () => {
  const now = Date.parse('2026-10-08T12:00:00Z')
  assert.equal(m.fmtAgo('not-a-date', now), '—')
  assert.equal(m.fmtAgo('2026-10-09T12:00:00Z', now), '0s ago')
})

test('statusTone maps customer and health states', () => {
  assert.equal(m.statusTone('paid'), 'good')
  assert.equal(m.statusTone('up'), 'good')
  assert.equal(m.statusTone('at limit'), 'warn')
  assert.equal(m.statusTone('down'), 'warn')
  assert.equal(m.statusTone('slow'), 'warn')
  assert.equal(m.statusTone('free'), 'muted')
  assert.equal(m.statusTone('comped'), 'muted')
  assert.equal(m.statusTone('asleep'), 'muted')
  assert.equal(m.statusTone('unknown'), 'muted')
})

test('funnelPercent is relative to the first stage and safe at zero', () => {
  const out = m.funnelPercent([{ stage: 'a', count: 10 }, { stage: 'b', count: 4 }, { stage: 'c', count: 0 }])
  assert.deepEqual(out.map((s: any) => s.pct), [100, 40, 0])
  assert.deepEqual(m.funnelPercent([{ stage: 'a', count: 0 }, { stage: 'b', count: 0 }]).map((s: any) => s.pct), [0, 0])
})

test('sortCustomers sorts by key and direction, nulls last, without mutating', () => {
  const rows: any[] = [{ email: 'b', chars7d: 5, lastRequest: null }, { email: 'a', chars7d: 9, lastRequest: '2026-10-08T00:00:00Z' }]
  const copy = JSON.stringify(rows)
  assert.deepEqual(m.sortCustomers(rows, 'chars7d', 'desc').map((r: any) => r.email), ['a', 'b'])
  assert.deepEqual(m.sortCustomers(rows, 'lastRequest', 'desc').map((r: any) => r.email), ['a', 'b'])
  assert.equal(JSON.stringify(rows), copy)
})
