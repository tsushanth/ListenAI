'use client'
import type { SeriesRow } from '@/lib/adminBusiness'
import { barGeometry, chartCaption, isBeforeLedger } from '@/lib/chartGeometry'

const W = 320, H = 70
const box: React.CSSProperties = { border: '1px solid #8884', borderRadius: 8, padding: 10, minWidth: 200, flex: '1 1 260px' }

function Chart({ title, points, kind, unit, usageSince }: { title: string; points: Array<{ day: string; value: number }>; kind: 'accounts' | 'usage'; unit: string; usageSince: string | null }) {
  const { bars, max } = barGeometry(points, W, H)
  const total = points.reduce((s, p) => s + (kind === 'usage' && isBeforeLedger(p.day, usageSince) ? 0 : p.value), 0)
  return (
    <div style={box}>
      <div style={{ fontSize: 12, opacity: 0.7 }}>{title}</div>
      <div style={{ fontSize: 12, margin: '2px 0 6px' }}>{chartCaption(kind, usageSince, total, unit)}</div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`${title}, ${points.length} days`}>
        <line x1="0" x2={W} y1={H - 0.5} y2={H - 0.5} stroke="#8886" />
        {bars.map((b) => (
          <rect key={b.day} x={b.x} y={b.y} width={b.w} height={b.h} fill="#4a7cff" opacity={kind === 'usage' && isBeforeLedger(b.day, usageSince) ? 0.15 : 0.9}>
            <title>{`${b.day}: ${Math.round(b.value).toLocaleString('en-US')} ${unit}`}</title>
          </rect>
        ))}
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, opacity: 0.5 }}>
        <span>{points[0]?.day.slice(5)}</span><span>peak {Math.round(max).toLocaleString('en-US')}</span><span>{points[points.length - 1]?.day.slice(5)}</span>
      </div>
    </div>
  )
}

export default function AdminCharts({ series, usageSince }: { series: SeriesRow[]; usageSince: string | null }) {
  if (series.length < 2) return <p style={{ opacity: 0.6, fontSize: 13 }}>Choose 7d or 30d to see daily charts.</p>
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <Chart title="New accounts per day" kind="accounts" unit="new accounts" usageSince={usageSince} points={series.map((s) => ({ day: s.day, value: s.newAccounts }))} />
      <Chart title="Paid characters per day" kind="usage" unit="chars" usageSince={usageSince} points={series.map((s) => ({ day: s.day, value: s.chars }))} />
      <Chart title="STT minutes per day" kind="usage" unit="min" usageSince={usageSince} points={series.map((s) => ({ day: s.day, value: s.sttMinutes }))} />
    </div>
  )
}
