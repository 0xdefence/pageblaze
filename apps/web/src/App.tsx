import { useEffect, useMemo, useState } from 'react';

type Stats = {
  counts?: Record<string, number>;
  statusCounters?: Record<string, Record<string, number>>;
};

type Recommendation = {
  id: number;
  run_id: string;
  url: string;
  code: string;
  severity: string;
  action: string;
  priority_score: number;
};

type AlertEvent = {
  id: number;
  category: string;
  severity: string;
  title: string;
  status: string;
  created_at: string;
};

const API_BASE = (import.meta as any).env?.VITE_API_BASE || 'http://127.0.0.1:4410';
const API_KEY = (import.meta as any).env?.VITE_API_KEY || 'pageblaze-dev-key';

async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { headers: { 'x-api-key': API_KEY } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export function App() {
  const [stats, setStats] = useState<Stats>({});
  const [topFixes, setTopFixes] = useState<Recommendation[]>([]);
  const [alerts, setAlerts] = useState<AlertEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        const [st, tf, ev] = await Promise.all([
          api<{ ok: boolean; counts: Record<string, number>; statusCounters: any }>('/v1/stats'),
          api<{ ok: boolean; topFixes: Recommendation[] }>('/v1/recommendations/top?limit=8'),
          api<{ ok: boolean; events: AlertEvent[] }>('/v1/alerts/events?limit=8'),
        ]);
        setStats(st);
        setTopFixes(tf.topFixes || []);
        setAlerts(ev.events || []);
        setError('');
      } catch (e: any) {
        setError(String(e?.message || e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const kpis = useMemo(() => [
    ['Runs', stats.counts?.runs || 0],
    ['Issues', stats.counts?.issues || 0],
    ['Recommendations', stats.counts?.recommendations || 0],
    ['Visual Changes', stats.counts?.visualChangedDiffs || 0],
  ], [stats]);

  return (
    <div className="page">
      <header>
        <h1>PageBlaze — Ops Dashboard</h1>
        <p>Overview + top fixes + alert flow (UI Block 1)</p>
      </header>

      {error && <div className="error">{error}</div>}
      {loading && <div className="loading">Loading...</div>}

      <section className="kpis">
        {kpis.map(([label, value]) => (
          <div className="card" key={label}>
            <div className="label">{label}</div>
            <div className="value">{value}</div>
          </div>
        ))}
      </section>

      <section className="grid">
        <div className="panel">
          <h2>Top Fixes</h2>
          <table>
            <thead>
              <tr><th>Severity</th><th>Code</th><th>Priority</th><th>Action</th></tr>
            </thead>
            <tbody>
              {topFixes.map((r) => (
                <tr key={r.id}>
                  <td><span className={`sev ${r.severity}`}>{r.severity}</span></td>
                  <td>{r.code}</td>
                  <td>{Number(r.priority_score || 0).toFixed(3)}</td>
                  <td>{r.action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="panel">
          <h2>Recent Alert Events</h2>
          <table>
            <thead>
              <tr><th>Status</th><th>Category</th><th>Severity</th><th>Title</th></tr>
            </thead>
            <tbody>
              {alerts.map((a) => (
                <tr key={a.id}>
                  <td>{a.status}</td>
                  <td>{a.category}</td>
                  <td><span className={`sev ${a.severity}`}>{a.severity}</span></td>
                  <td>{a.title}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
