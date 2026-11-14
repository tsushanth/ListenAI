'use client'

import { useId, useState } from 'react'
import { compareCosts, formatUsd, minutesToCharacters, parseAmount } from '@/lib/migrationCalc'
import type { CalculatorLists } from '@/content/migrationPrices'

// Client-side only: no network request, no storage, no tracking. Everything it shows comes from the two price lists passed in by the page
// (src/content/migrationPrices.ts), so it cannot drift from the price table above it.

type Props = { lists: CalculatorLists }

const field = { display: 'grid', gap: 4 } as const
const input = { padding: '8px 10px', border: '1px solid var(--line, #cfcfcf)', borderRadius: 6, font: 'inherit', background: 'transparent', color: 'inherit', width: '100%' } as const

export default function MigrationCostCalculator({ lists }: Props) {
  const id = useId()
  const [unit, setUnit] = useState<'characters' | 'minutes'>('characters')
  const [amount, setAmount] = useState('10000000')
  const [sttHours, setSttHours] = useState('0')
  const [elId, setElId] = useState(lists.elevenlabs.tts[0].id)
  const [raId, setRaId] = useState(lists.readaloud.tts[0].id)

  const el = lists.elevenlabs.tts.find((t) => t.id === elId) ?? lists.elevenlabs.tts[0]
  const ra = lists.readaloud.tts.find((t) => t.id === raId) ?? lists.readaloud.tts[0]
  const characters = unit === 'characters' ? parseAmount(amount) : minutesToCharacters(parseAmount(amount), lists.charsPerMinute)
  const r = compareCosts({
    characters,
    sttHours: parseAmount(sttHours),
    elTtsPer1MUsd: el.per1MUsd,
    raTtsPer1MUsd: ra.per1MUsd,
    elSttPerHourUsd: lists.elevenlabs.sttBatchPerHourUsd,
    raSttPerHourUsd: lists.readaloud.sttBatchPerHourUsd,
  })
  const lower = r.difference < 0
  const same = r.difference === 0
  const preset = (chars: number) => { setUnit('characters'); setAmount(String(chars)) }

  return (
    <div className="ra-ref" data-testid="cost-calculator" style={{ marginTop: 16 }}>
      <form onSubmit={(e) => e.preventDefault()} aria-label="Monthly cost calculator" style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
        <label style={field} htmlFor={`${id}-unit`}>
          <span>Measure text as</span>
          <select id={`${id}-unit`} style={input} value={unit} onChange={(e) => setUnit(e.target.value as 'characters' | 'minutes')}>
            <option value="characters">Characters per month</option>
            <option value="minutes">Minutes of speech per month (about {lists.charsPerMinute} characters a minute, an assumption)</option>
          </select>
        </label>
        <label style={field} htmlFor={`${id}-amount`}>
          <span>{unit === 'characters' ? 'Characters per month' : 'Minutes of speech per month'}</span>
          <input id={`${id}-amount`} style={input} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label style={field} htmlFor={`${id}-stt`}>
          <span>Hours of audio to transcribe per month (batch, optional)</span>
          <input id={`${id}-stt`} style={input} inputMode="decimal" value={sttHours} onChange={(e) => setSttHours(e.target.value)} />
        </label>
        <label style={field} htmlFor={`${id}-el`}>
          <span>ElevenLabs model to compare with</span>
          <select id={`${id}-el`} style={input} value={elId} onChange={(e) => setElId(e.target.value)}>
            {lists.elevenlabs.tts.map((t) => <option key={t.id} value={t.id}>{t.name} ({formatUsd(t.per1MUsd)} per 1M characters)</option>)}
          </select>
        </label>
        <label style={field} htmlFor={`${id}-ra`}>
          <span>ReadAloud tier</span>
          <select id={`${id}-ra`} style={input} value={raId} onChange={(e) => setRaId(e.target.value)}>
            {lists.readaloud.tts.map((t) => <option key={t.id} value={t.id}>{t.name} ({formatUsd(t.per1MUsd)} per 1M characters)</option>)}
          </select>
        </label>
      </form>
      <p className="ra-small" style={{ marginTop: 10 }}>
        Quick volumes:{' '}
        {[1_000_000, 10_000_000, 100_000_000].map((n) => (
          <button key={n} type="button" onClick={() => preset(n)} style={{ marginRight: 8, textDecoration: 'underline', background: 'none', border: 0, color: 'inherit', cursor: 'pointer', font: 'inherit' }}>
            {n.toLocaleString('en-US')}
          </button>
        ))}
      </p>

      <div className="ra-table-wrap" style={{ marginTop: 12 }}>
        <table className="ra-table">
          <caption style={{ textAlign: 'left', position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>Monthly cost at list prices</caption>
          <thead><tr><th scope="col">Per month, list prices</th><th scope="col">ElevenLabs {el.name}</th><th scope="col">ReadAloud {ra.name.replace(/^ReadAloud /, '')}</th></tr></thead>
          <tbody>
            <tr><th scope="row">Text to speech ({Math.round(characters).toLocaleString('en-US')} characters)</th><td>{formatUsd(r.elTts)}</td><td>{formatUsd(r.raTts)}</td></tr>
            <tr><th scope="row">Batch speech to text</th><td>{formatUsd(r.elStt)}</td><td>{formatUsd(r.raStt)}</td></tr>
            <tr><th scope="row">Total</th><td><b>{formatUsd(r.elTotal)}</b></td><td><b>{formatUsd(r.raTotal)}</b></td></tr>
          </tbody>
        </table>
      </div>
      <p aria-live="polite" data-testid="calc-summary" style={{ marginTop: 10 }}>
        {r.elTotal === 0 && r.raTotal === 0
          ? 'Enter a volume to see the monthly difference.'
          : same
            ? 'At these list prices the two cost the same.'
            : lower
              ? `At these list prices ReadAloud costs ${formatUsd(-r.difference)} less per month${r.percentLower !== null ? ` (${r.percentLower.toFixed(0)}% lower)` : ''}.`
              : `At these list prices ReadAloud costs ${formatUsd(r.difference)} more per month.`}
      </p>
      <p className="ra-small" style={{ marginTop: 6 }}>
        ElevenLabs figures are its API list prices read from <a href={lists.elevenlabs.sourceUrl} style={{ textDecoration: 'underline' }}>its pricing page</a> on {lists.elevenlabs.retrievedOn}; ReadAloud figures are this site&rsquo;s own list prices. Plans, volume discounts, promotions and the free credits on either side are not included, and your bill depends on the voice you choose. Calculated in your browser; nothing is sent anywhere.
      </p>
    </div>
  )
}
