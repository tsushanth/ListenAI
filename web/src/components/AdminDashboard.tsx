'use client';

// Internal health/issues/usage view. Data comes from this site's own /api/admin/overview
// (which authenticates the user, then calls the central reporter Worker with a server-side secret).
import { useCallback, useEffect, useState } from 'react';

type Row = Record<string, any>;
interface Overview { health: Row[]; latest: Row[]; groups: Row[]; recent: Row[]; byKind: Row[]; usage: Row[] }

const ago = (t: number) => {
  const s = (Date.now() - t) / 1000;
  return s < 90 ? `${Math.round(s)}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 172800 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};
const box: React.CSSProperties = { border: '1px solid #8884', borderRadius: 8, padding: 10 };
const th: React.CSSProperties = { textAlign: 'left', padding: '6px 8px', opacity: 0.6, fontWeight: 500 };
const td: React.CSSProperties = { padding: '6px 8px', borderTop: '1px solid #8883', verticalAlign: 'top' };
const h2: React.CSSProperties = { fontSize: 13, textTransform: 'uppercase', letterSpacing: '.05em', opacity: 0.6, margin: '24px 0 8px' };

// token: for sites whose session is a bearer token held in the browser (sent as Authorization). Cookie-session sites omit it.
// scopes: optional tabs that split one app's view (e.g. ReadAloud app vs API); value is sent as ?scope=.
export default function AdminDashboard({ token, scopes, renderTop }: { token?: string | null; scopes?: { label: string; value: string }[]; renderTop?: (scope: string, hours: number) => React.ReactNode } = {}) {
  const [hours, setHours] = useState(24);
  const [scope, setScope] = useState(scopes?.[0]?.value ?? '');
  const [d, setD] = useState<Overview | null>(null);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setErr('');
    try {
      const r = await fetch(`/api/admin/overview?hours=${hours}${scope ? `&scope=${scope}` : ''}`, {
        cache: 'no-store',
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setD(await r.json());
    } catch (e: any) {
      setErr(e.message || 'failed to load');
    }
  }, [hours, token, scope]);

  useEffect(() => { load(); }, [load]);

  const days = d ? Array.from(new Set(d.usage.map((u) => u.day))).sort().reverse().slice(0, 14) : [];
  const metrics = d ? Array.from(new Set(d.usage.map((u) => u.metric))).sort() : [];

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: 16, fontSize: 14, lineHeight: 1.45 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <h1 style={{ fontSize: 18, margin: 0 }}>Health, issues &amp; usage</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <select value={hours} onChange={(e) => setHours(Number(e.target.value))} style={{ padding: 6 }}>
            <option value={1}>1 hour</option><option value={24}>24 hours</option><option value={168}>7 days</option><option value={720}>30 days</option>
          </select>
          <button onClick={load} style={{ padding: '6px 10px' }}>Refresh</button>
        </div>
      </div>
      {scopes && (
        <div style={{ display: 'flex', gap: 8, margin: '12px 0 0' }}>
          {scopes.map((s) => (
            <button key={s.value} onClick={() => setScope(s.value)} style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #8886', fontWeight: scope === s.value ? 700 : 400, background: scope === s.value ? '#8882' : 'transparent' }}>{s.label}</button>
          ))}
        </div>
      )}
      {renderTop?.(scope, hours)}
      {err && <p style={{ color: '#cf222e' }}>Could not load: {err}</p>}
      {!d && !err && <p style={{ opacity: 0.6 }}>Loading...</p>}
      {d && (<>
        <h2 style={h2}>Health (probed every 5 min)</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(220px,1fr))', gap: 8 }}>
          {d.latest.length === 0 && <p style={{ opacity: 0.6 }}>No probes yet.</p>}
          {d.latest.map((l) => {
            const s = d.health.find((h) => h.target === l.target);
            const up = s ? Math.round((100 * s.ok) / s.n) : 0;
            const color = !l.ok ? '#cf222e' : up < 99 ? '#9a6700' : '#1a7f37';
            return (
              <div key={l.target} style={box}>
                <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: '50%', background: color, marginRight: 6 }} />
                <b>{l.target}</b>
                <div style={{ opacity: 0.7 }}>{l.ok ? 'up' : `DOWN (${l.status || 'no response'})`} &middot; {l.latency_ms} ms &middot; {ago(l.ts)}</div>
                <div style={{ opacity: 0.7 }}>{up}% uptime &middot; avg {s?.avg_ms ?? '-'} ms &middot; max {s?.max_ms ?? '-'} ms</div>
              </div>
            );
          })}
        </div>

        <h2 style={h2}>Issues ({d.byKind.map((k) => `${k.n} ${k.kind}`).join(', ') || 'none'})</h2>
        <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={th}>Kind</th><th style={th}>Where</th><th style={th}>Message</th><th style={th}>Count</th><th style={th}>Last</th><th style={th}>Versions</th></tr></thead>
          <tbody>{d.groups.map((g) => (
            <tr key={g.fingerprint}><td style={td}>{g.kind}</td><td style={td}>{g.flow}<div style={{ opacity: 0.6 }}>{g.platforms}</div></td>
              <td style={{ ...td, maxWidth: 480, wordBreak: 'break-word' }}>{String(g.message).split('\n')[0].slice(0, 160)}</td>
              <td style={td}>{g.n}</td><td style={td}>{ago(g.last_ts)}</td><td style={td}>{g.versions}</td></tr>
          ))}</tbody>
        </table></div>

        <h2 style={h2}>Recent events</h2>
        <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={th}>When</th><th style={th}>Kind</th><th style={th}>Where</th><th style={th}>Message</th></tr></thead>
          <tbody>{d.recent.map((e) => (
            <tr key={e.id}><td style={td}>{ago(e.ts)}</td><td style={td}>{e.kind}</td><td style={td}>{e.flow}<div style={{ opacity: 0.6 }}>{e.platform} {e.version}</div></td>
              <td style={{ ...td, maxWidth: 520, wordBreak: 'break-word' }}><details><summary style={{ cursor: 'pointer' }}>{String(e.message).split('\n')[0].slice(0, 140)}</summary>
                <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{e.message}{e.stack ? `\n\n${e.stack}` : ''}</pre></details></td></tr>
          ))}</tbody>
        </table></div>

        <h2 style={h2}>Usage</h2>
        {metrics.length === 0 ? <p style={{ opacity: 0.6 }}>No usage reported yet.</p> : (
          <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>Metric</th>{days.map((x) => <th key={x} style={th}>{x.slice(5)}</th>)}</tr></thead>
            <tbody>{metrics.map((m) => (
              <tr key={m}><td style={td}>{m}</td>{days.map((x) => <td key={x} style={td}>{d.usage.find((u) => u.metric === m && u.day === x)?.value ?? ''}</td>)}</tr>
            ))}</tbody>
          </table></div>
        )}
      </>)}
    </div>
  );
}
