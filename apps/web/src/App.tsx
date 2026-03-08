import { useEffect, useMemo, useState } from 'react';

type Stats = { counts?: Record<string, number>; statusCounters?: Record<string, Record<string, number>> };
type Recommendation = { id: number; run_id: string; url: string; code: string; severity: string; action: string; priority_score: number; message?: string; created_at?: string };
type Issue = { id: number; run_id: string; url: string; code: string; severity: string; message: string; created_at?: string };
type AlertEvent = { id: number; category: string; severity: string; title: string; status: string; created_at: string };

const API_BASE = (import.meta as any).env?.VITE_API_BASE || 'http://127.0.0.1:4410';
const API_KEY = (import.meta as any).env?.VITE_API_KEY || 'pageblaze-dev-key';

async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { headers: { 'x-api-key': API_KEY } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

const rel = (iso?: string) => {
  if (!iso) return '-';
  const d = Date.now() - new Date(iso).getTime();
  const m = Math.floor(d / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

export function App() {
  const init = new URLSearchParams(window.location.search);
  const [tab, setTab] = useState<'overview' | 'issues' | 'recommendations'>((init.get('tab') as any) || 'overview');
  const [severity, setSeverity] = useState<'all' | 'critical' | 'high' | 'medium' | 'low'>((init.get('severity') as any) || 'all');
  const [theme, setTheme] = useState<'dark' | 'light'>(((localStorage.getItem('pb-theme') as any) || 'dark'));
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'priority' | 'newest'>('priority');

  const [stats, setStats] = useState<Stats>({});
  const [topFixes, setTopFixes] = useState<Recommendation[]>([]);
  const [alerts, setAlerts] = useState<AlertEvent[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const syncUrl = (t = tab, s = severity) => {
    const p = new URLSearchParams(window.location.search);
    p.set('tab', t);
    p.set('severity', s);
    history.replaceState(null, '', `${window.location.pathname}?${p.toString()}`);
  };

  useEffect(() => { document.body.className = ''; localStorage.setItem('pb-theme', theme); }, [theme]);

  const loadOverview = async () => {
    const [st, tf, ev] = await Promise.all([
      api<{ ok: boolean; counts: Record<string, number>; statusCounters: any }>('/v1/stats'),
      api<{ ok: boolean; topFixes: Recommendation[] }>('/v1/recommendations/top?limit=8'),
      api<{ ok: boolean; events: AlertEvent[] }>('/v1/alerts/events?limit=8'),
    ]);
    setStats(st); setTopFixes(tf.topFixes || []); setAlerts(ev.events || []);
  };

  const refresh = async () => {
    try {
      setLoading(true);
      if (tab === 'overview') await loadOverview();
      if (tab === 'issues') {
        const q = severity === 'all' ? '' : `&severity=${severity}`;
        const res = await api<{ ok: boolean; issues: Issue[] }>(`/v1/issues?limit=80${q}`);
        setIssues(res.issues || []);
      }
      if (tab === 'recommendations') {
        const q = severity === 'all' ? '' : `&severity=${severity}`;
        const res = await api<{ ok: boolean; recommendations: Recommendation[] }>(`/v1/recommendations?limit=80${q}`);
        setRecommendations(res.recommendations || []);
      }
      setError('');
    } catch (e: any) { setError(String(e?.message || e)); }
    finally { setLoading(false); }
  };

  useEffect(() => { syncUrl(); refresh(); }, [tab, severity]);

  const kpis = useMemo(() => [
    ['Runs', stats.counts?.runs || 0], ['Issues', stats.counts?.issues || 0], ['Recommendations', stats.counts?.recommendations || 0], ['Visual Changes', stats.counts?.visualChangedDiffs || 0],
  ], [stats]);

  const filteredIssues = useMemo(() => issues.filter(i => !query || `${i.code} ${i.message} ${i.url}`.toLowerCase().includes(query.toLowerCase())), [issues, query]);
  const filteredRecs = useMemo(() => {
    const base = recommendations.filter(r => !query || `${r.code} ${r.action} ${r.url}`.toLowerCase().includes(query.toLowerCase()));
    return [...base].sort((a, b) => sort === 'priority' ? (b.priority_score - a.priority_score) : ((+new Date(b.created_at || 0)) - (+new Date(a.created_at || 0))));
  }, [recommendations, query, sort]);

  const copy = async (txt: string) => { try { await navigator.clipboard.writeText(txt); } catch {} };

  return (
    <div className={`page theme-${theme}`}>
      <header>
        <h1>PageBlaze — Ops Dashboard</h1>
        <p>UI Block 3: polish, filters, skeletons, search/sort, URL state</p>
      </header>

      <div className="toolbar">
        <div className="tabs">
          {(['overview', 'issues', 'recommendations'] as const).map(t => (
            <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>
          ))}
        </div>
        <div className="toolbar-right">
          {tab !== 'overview' && <select value={severity} onChange={e => setSeverity(e.target.value as any)}><option value="all">All severities</option><option value="critical">Critical</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select>}
          {tab !== 'overview' && <input aria-label="Search" className="search" placeholder="Search code, action, URL..." value={query} onChange={e => setQuery(e.target.value)} />}
          {tab === 'recommendations' && <select value={sort} onChange={e => setSort(e.target.value as any)}><option value="priority">Sort: Priority</option><option value="newest">Sort: Newest</option></select>}
          <button className="theme-toggle" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? '☀ Light' : '🌙 Dark'}</button>
          <button className="theme-toggle" onClick={refresh}>↻ Refresh</button>
        </div>
      </div>

      {error && <div className="error">{error} <button onClick={refresh}>Retry</button></div>}
      {loading && <div className="skeleton-grid"><div className="skeleton"/><div className="skeleton"/><div className="skeleton"/></div>}

      {!loading && tab === 'overview' && (
        <>
          <section className="kpis">{kpis.map(([label, value]) => <div className="card" key={label}><div className="label">{label}</div><div className="value">{value}</div></div>)}</section>
          <section className="grid">
            <div className="panel"><h2>Top Fixes</h2><table><thead><tr><th>Severity</th><th>Code</th><th>Priority</th><th>Action</th></tr></thead><tbody>{topFixes.map(r => <tr key={r.id}><td><span className={`sev ${r.severity}`}>{r.severity}</span></td><td>{r.code}</td><td>{Number(r.priority_score || 0).toFixed(3)}</td><td>{r.action}</td></tr>)}</tbody></table></div>
            <div className="panel"><h2>Recent Alert Events</h2><table><thead><tr><th>Status</th><th>Category</th><th>Severity</th><th>Title</th><th>When</th></tr></thead><tbody>{alerts.map(a => <tr key={a.id}><td>{a.status}</td><td>{a.category}</td><td><span className={`sev ${a.severity}`}>{a.severity}</span></td><td>{a.title}</td><td>{rel(a.created_at)}</td></tr>)}</tbody></table></div>
          </section>
        </>
      )}

      {!loading && tab === 'issues' && (
        <section className="panel full">
          <h2>Issues</h2>
          {filteredIssues.length === 0 ? <div className="empty">No issues found for this filter.</div> : (
            <table><thead><tr><th>Severity</th><th>Code</th><th>Message</th><th>URL</th><th/></tr></thead><tbody>{filteredIssues.map(i => <tr key={i.id}><td><span className={`sev ${i.severity}`}>{i.severity}</span></td><td>{i.code}</td><td>{i.message}</td><td className="url">{i.url}</td><td><button className="copy" onClick={() => copy(i.url)}>Copy</button></td></tr>)}</tbody></table>
          )}
        </section>
      )}

      {!loading && tab === 'recommendations' && (
        <section className="panel full">
          <h2>Recommendations</h2>
          {filteredRecs.length === 0 ? <div className="empty">No recommendations found for this filter.</div> : (
            <table><thead><tr><th>Severity</th><th>Code</th><th>Priority</th><th>Action</th><th>URL</th><th>When</th><th/></tr></thead><tbody>{filteredRecs.map(r => <tr key={r.id}><td><span className={`sev ${r.severity}`}>{r.severity}</span></td><td>{r.code}</td><td>{Number(r.priority_score || 0).toFixed(3)}</td><td>{r.action}</td><td className="url">{r.url}</td><td>{rel(r.created_at)}</td><td><button className="copy" onClick={() => copy(r.url)}>Copy</button></td></tr>)}</tbody></table>
          )}
        </section>
      )}
    </div>
  );
}
