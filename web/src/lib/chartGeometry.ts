export interface Point { day: string; value: number }
export interface Bar { x: number; y: number; w: number; h: number; day: string; value: number }

export function barGeometry(points: Point[], width: number, height: number, gap = 2): { bars: Bar[]; max: number } {
  if (points.length === 0) return { bars: [], max: 0 }
  const max = Math.max(0, ...points.map((p) => (Number.isFinite(p.value) ? p.value : 0)))
  const w = Math.max(1, (width - gap * (points.length - 1)) / points.length)
  const bars = points.map((p, i) => {
    const v = Number.isFinite(p.value) && p.value > 0 ? p.value : 0
    const h = max > 0 && v > 0 ? Math.max(1, (v / max) * height) : 0
    return { x: i * (w + gap), y: height - h, w, h, day: p.day, value: v }
  })
  return { bars, max }
}

export const isBeforeLedger = (day: string, usageSince: string | null): boolean => usageSince === null || day < usageSince

export function chartCaption(kind: 'accounts' | 'usage', usageSince: string | null, total: number, unit: string): string {
  const n = Math.round(total).toLocaleString('en-US')
  if (kind === 'accounts') return `${n} ${unit}`
  return usageSince === null ? 'No usage recorded yet' : `${n} ${unit} since ${usageSince}`
}
