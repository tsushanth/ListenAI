import { test } from 'node:test'
import assert from 'node:assert/strict'

const { barGeometry, chartCaption, isBeforeLedger } = await import('../src/lib/chartGeometry.ts')

test('barGeometry scales to the maximum and keeps every bar inside the box', () => {
  const { bars, max } = barGeometry([{ day: 'a', value: 5 }, { day: 'b', value: 10 }, { day: 'c', value: 0 }], 100, 40, 4)
  assert.equal(max, 10)
  assert.equal(bars.length, 3)
  assert.equal(bars[1]!.h, 40)
  assert.equal(bars[0]!.h, 20)
  assert.equal(bars[2]!.h, 0)
  for (const b of bars) { assert.ok(b.x >= 0 && b.x + b.w <= 100.0001); assert.ok(b.y >= 0 && b.y + b.h <= 40.0001) }
})

test('barGeometry on all zeros is a flat baseline, not NaN', () => {
  const { bars, max } = barGeometry([{ day: 'a', value: 0 }, { day: 'b', value: 0 }], 100, 40)
  assert.equal(max, 0)
  assert.ok(bars.every((b) => b.h === 0 && Number.isFinite(b.w) && Number.isFinite(b.y)))
})

test('barGeometry gives a tiny non-zero value at least a 1px bar, and tolerates an empty list', () => {
  const { bars } = barGeometry([{ day: 'a', value: 1 }, { day: 'b', value: 1_000_000 }], 100, 40)
  assert.ok(bars[0]!.h >= 1)
  assert.deepEqual(barGeometry([], 100, 40), { bars: [], max: 0 })
})

test('isBeforeLedger: no ledger yet means every day is before it', () => {
  assert.equal(isBeforeLedger('2026-10-08', null), true)
  assert.equal(isBeforeLedger('2026-10-07', '2026-10-08'), true)
  assert.equal(isBeforeLedger('2026-10-08', '2026-10-08'), false)
})

test('chartCaption words the empty ledger and the since-date honestly', () => {
  assert.equal(chartCaption('usage', null, 0, 'chars'), 'No usage recorded yet')
  assert.equal(chartCaption('usage', '2026-10-08', 1500, 'chars'), '1,500 chars since 2026-10-08')
  assert.equal(chartCaption('accounts', null, 3, 'new accounts'), '3 new accounts')
})
