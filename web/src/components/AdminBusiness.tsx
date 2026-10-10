'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  fmtAgo, fmtChars, fmtMinutes, fmtNumber, funnelPercent, isDashboardData, sortCustomers, statusTone,
  type Customer, type DashboardData, type Section,
} from '@/lib/adminBusiness'
import AdminCharts from './AdminCharts'

const box: React.CSSProperties = { border: '1px solid #8884', borderRadius: 8, padding: 10 }
const th: React.CSSProperties = { textAlign: 'left', padding: '6px 8px', opacity: 0.6, fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap' }
const td: React.CSSProperties = { padding: '6px 8px', borderTop: '1px solid #8883', verticalAlign: 'top' }
const h2: React.CSSProperties = { fontSize: 13, textTransform: 'uppercase', letterSpacing: '.05em', opacity: 0.6, margin: '24px 0 8px' }
const TONE: Record<'good' | 'warn' | 'muted', string> = { good: '#2e9e4f', warn: '#d98a00', muted: '#8886' }

function Failed({ what, s }: { what: string; s: Extract<Section<unknown>, { ok: false }> }) {
  return <p style={{ ...box, opacity: 0.8 }}>Could not load {what}: {s.error}</p>
}

function Card({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div style={{ ...box, minWidth: 150, flex: '1 1 150px' }}>
      <div style={{ opacity: 0.6, fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600 }}>{value}</div>
      {hint && <div style={{ opacity: 0.6, fontSize: 12 }}>{hint}</div>}
    </div>
  )
}

export default function AdminBusiness({ token, hours }: { token: string; hours: number }) {
  const range = hours <= 24 ? '24h' : hours <= 168 ? '7d' : '30d'
  const [d, setD] = useState<DashboardData | null>(null)
  const [err, setErr] = useState('')
  const [sort, setSort] = useState<{ key: keyof Customer; dir: 'asc' | 'desc' }>({ key: 'lastRequest', dir: 'desc' })

  useEffect(() => {
    let cancelled = false
    setD(null)
    setErr('')
    ;(async () => {
      try {
        const r = await fetch(`/api/admin/dashboard?range=${range}`, { cache: 'no-store', headers: { Authorization: `Bearer ${token}` } })
        if (!r.ok) throw new Error(r.status === 404 ? 'Not found (this account is not an admin)' : `HTTP ${r.status}`) // never read or render the body of a non-200
        const j: unknown = await r.json()
        if (!isDashboardData(j)) throw new Error('Unexpected response')
        if (!cancelled) setD(j)
      } catch (e: any) { if (!cancelled) setErr(e.message || 'failed to load') }
    })()
    return () => { cancelled = true }
  }, [range, token])

  const customers = useMemo(() => (d?.customers.ok ? sortCustomers(d.customers.data, sort.key, sort.dir) : []), [d, sort])
  const th_ = (key: keyof Customer, label: string) => (
    <th style={th} onClick={() => setSort((s) => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }))}>{label}{sort.key === key ? (sort.dir === 'desc' ? ' ↓' : ' ↑') : ''}</th>
  )

  if (err) return <p style={{ ...box, marginTop: 16 }}>Business view: {err}</p>
  if (!d) return <p style={{ marginTop: 16, opacity: 0.6 }}>Loading business view…</p>
  const rangeLabel = d.range === '24h' ? 'today (UTC)' : d.range
  const t = d.totals.ok ? d.totals.data : null

  return (
    <div style={{ marginTop: 8 }}>
      <h2 style={h2}>Needs attention</h2>
      {!d.attention.ok ? <Failed what="attention" s={d.attention} /> : d.attention.data.length === 0
        ? <p style={{ opacity: 0.6 }}>Nothing needs attention.</p>
        : <ul style={{ margin: 0, paddingLeft: 18 }}>{d.attention.data.map((a, i) => <li key={i} style={{ color: TONE.warn }}>{a.text}</li>)}</ul>}

      <h2 style={h2}>Health</h2>
      {!d.health.ok ? <Failed what="health" s={d.health} /> : (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {d.health.data.map((h) => (
            <div key={h.name} style={{ ...box, minWidth: 140 }}>
              <span style={{ color: TONE[statusTone(h.status)] }}>●</span> <b>{h.name}</b>
              <div style={{ opacity: 0.7, fontSize: 12 }}>{h.status}{h.latencyMs != null ? ` · ${h.latencyMs} ms` : ''}</div>
              {h.detail && <div style={{ opacity: 0.5, fontSize: 11 }}>{h.detail}</div>}
            </div>
          ))}
        </div>
      )}

      <h2 style={h2}>Customers and usage ({rangeLabel}, your accounts excluded; usage history starts {d.usageSince ?? 'when recording began'} UTC)</h2>
      {!d.totals.ok || !t ? (d.totals.ok ? null : <Failed what="totals" s={d.totals} />) : (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Card label="API accounts" value={fmtNumber(t.accounts)} hint={`${fmtNumber(t.newAccounts)} new · ${fmtNumber(t.activeKeys)} active keys`} />
          <Card label="Paid ReadAloud Studio characters" value={fmtChars(t.kokoroChars)} />
          <Card label="Paid ReadAloud Live characters" value={fmtChars(t.piperChars)} />
          <Card label="Free-tier characters" value={fmtChars(t.freeCharsUsed)} />
          <Card label="STT audio (batch + API)" value={fmtMinutes(t.sttMinutes)} />
          <Card label="Free credits used" value={`${fmtNumber(t.creditsUsed)} / ${fmtNumber(t.creditsGranted)}`} hint={`${fmtChars(t.freeCharsUsed)} chars this range`} />
          <Card label="Paid customers" value={fmtNumber(t.paidCustomers)} hint={`${fmtChars(t.billedUnits)} billed units`} />
        </div>
      )}

      <h2 style={h2}>Funnel</h2>
      {!d.funnel.ok ? <Failed what="funnel" s={d.funnel} /> : (
        <div style={box}>
          {funnelPercent(d.funnel.data).map((s) => (
            <div key={s.stage} style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0' }}>
              <div style={{ width: 190 }}>{s.stage}</div>
              <div style={{ flex: 1, background: '#8882', borderRadius: 4, height: 10 }}><div style={{ width: `${s.pct}%`, background: '#4a7cff', height: 10, borderRadius: 4 }} /></div>
              <div style={{ width: 90, textAlign: 'right' }}>{fmtNumber(s.count)} · {s.pct}%</div>
            </div>
          ))}
        </div>
      )}

      <h2 style={h2}>Daily trend</h2>
      {!d.series.ok ? <Failed what="series" s={d.series} /> : <AdminCharts series={d.series.data} usageSince={d.usageSince} />}

      <h2 style={h2}>Customers</h2>
      <p style={{ opacity: 0.6, fontSize: 12, margin: '0 0 8px' }}>Request dates come from the usage ledger, which starts at the date shown above; earlier activity shows as —</p>
      {!d.customers.ok ? <Failed what="customers" s={d.customers} /> : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr>{th_('email', 'Email')}{th_('signedUp', 'Signed up')}{th_('activeKeys', 'Keys')}{th_('firstRequest', 'First request (ledger)')}{th_('lastRequest', 'Last request (ledger)')}{th_('chars7d', 'Chars 7d')}{th_('sttMinutes7d', 'STT 7d')}{th_('creditsLeft', 'Credits left')}{th_('status', 'Status')}</tr></thead>
            <tbody>
              {customers.length === 0 && <tr><td style={td} colSpan={9}>No API customers yet.</td></tr>}
              {customers.map((c) => (
                <tr key={c.userId}>
                  <td style={td}>{c.email ?? c.userId}</td>
                  <td style={td}>{c.signedUp.slice(0, 10)}</td>
                  <td style={td}>{c.activeKeys}</td>
                  <td style={td}>{c.firstRequest ?? '—'}</td>
                  <td style={td}>{c.lastRequest ? fmtAgo(c.lastRequest) : '—'}</td>
                  <td style={td}>{fmtChars(c.chars7d)}</td>
                  <td style={td}>{fmtMinutes(c.sttMinutes7d)}</td>
                  <td style={td}>{fmtNumber(c.creditsLeft)}</td>
                  <td style={{ ...td, color: TONE[statusTone(c.status)] }}>{c.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
