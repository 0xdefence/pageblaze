import 'dotenv/config';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import { Queue } from 'bullmq';
import { ZodError, z } from 'zod';
import { ALERT_QUEUE_NAME, QUEUE_NAME, db, normalizeUrl, verifySchema } from '@pageblaze/shared';

const app = Fastify({ logger: true });
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const queue = new Queue(QUEUE_NAME, { connection: { url: redisUrl } });
const alertQueue = new Queue(ALERT_QUEUE_NAME, { connection: { url: redisUrl } });
const PORT = Number(process.env.PORT || 4410);
const API_KEY = process.env.API_KEY || 'pageblaze-dev-key';
const STARTED_AT = Date.now();
const DB_SLOW_MS = Number(process.env.DB_SLOW_MS || 250);

async function q(sql: string, params: any[] = [], label = 'query') {
  const t0 = Date.now();
  const res = await db.query(sql, params);
  const ms = Date.now() - t0;
  if (ms >= DB_SLOW_MS) app.log.warn({ label, ms, rows: res.rowCount ?? 0 }, 'slow_db_query');
  return res;
}

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  status: z.string().optional(),
  type: z.enum(['scrape', 'crawl']).optional(),
  runId: z.string().optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  code: z.string().optional(),
});

const alertEndpointSchema = z.object({
  kind: z.enum(['webhook']),
  url: z.string().url(),
  secret: z.string().optional(),
  enabled: z.boolean().optional(),
  metadata: z.record(z.any()).optional(),
});

async function deliverWebhook(url: string, payload: any, secret?: string) {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (secret) headers['x-pageblaze-signature'] = secret;
  const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
  const txt = await res.text().catch(() => '');
  return { ok: res.ok, status: res.status, bodySnippet: txt.slice(0, 300) };
}

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof ZodError) {
    return reply.status(400).send({ ok: false, error: 'validation_error', details: err.issues });
  }
  app.log.error(err);
  return reply.status(500).send({ ok: false, error: 'internal_error' });
});

app.addHook('onRequest', async (req, reply) => {
  if (req.url === '/healthz' || req.url === '/livez' || req.url === '/readyz') return;

  const key = String(req.headers['x-api-key'] || '');
  if (!key) return reply.status(401).send({ ok: false, error: 'unauthorized' });

  // bootstrap admin key (full access)
  if (key === API_KEY) return;

  const requiredScope = req.method === 'GET' ? 'read' : 'write';
  const r = await q('SELECT scopes_json, enabled FROM api_keys WHERE token=$1 LIMIT 1', [key], 'auth_lookup_key');
  if (!r.rowCount) return reply.status(401).send({ ok: false, error: 'unauthorized' });

  const row = r.rows[0];
  if (!row.enabled) return reply.status(403).send({ ok: false, error: 'key_disabled' });
  const scopes: string[] = Array.isArray(row.scopes_json) ? row.scopes_json : [];
  if (!scopes.includes(requiredScope) && !scopes.includes('admin')) {
    return reply.status(403).send({ ok: false, error: 'insufficient_scope', requiredScope });
  }
});

app.get('/healthz', async () => ({ ok: true }));
app.get('/livez', async () => ({ ok: true }));
app.get('/readyz', async () => {
  await q('SELECT 1', [], 'readyz_db_ping');
  return { ok: true };
});

const scrapeSchema = z.object({
  url: z.string().url(),
  renderMode: z.enum(['auto', 'http', 'browser']).optional(),
  extract: z.enum(['markdown', 'text', 'html']).optional(),
  includeLinks: z.boolean().optional(),
});

function queueOpts(kind: 'scrape' | 'crawl') {
  return {
    removeOnComplete: 100,
    removeOnFail: 500,
    attempts: kind === 'crawl' ? 2 : 3,
    backoff: { type: 'exponential' as const, delay: kind === 'crawl' ? 3000 : 1500 },
    timeout: kind === 'crawl' ? 120_000 : 60_000,
  };
}

app.post('/v1/scrape', async (req, reply) => {
  const body = scrapeSchema.parse(req.body);
  const job = await queue.add('scrape', body, queueOpts('scrape'));
  await db.query(
    `INSERT INTO crawl_runs (id, type, start_url, status)
     VALUES ($1, 'scrape', $2, 'queued')
     ON CONFLICT (id) DO NOTHING`,
    [String(job.id), normalizeUrl(body.url)]
  );
  return reply.status(202).send({ ok: true, type: 'scrape', jobId: job.id });
});

const crawlSchema = z.object({
  startUrl: z.string().url(),
  maxDepth: z.number().int().min(0).max(5).optional(),
  maxPages: z.number().int().min(1).max(5000).optional(),
  allowDomains: z.array(z.string()).optional(),
  excludePatterns: z.array(z.string()).optional(),
  renderMode: z.enum(['auto', 'http', 'browser']).optional(),
  respectRobots: z.boolean().optional(),
});

app.post('/v1/crawl', async (req, reply) => {
  const body = crawlSchema.parse(req.body);
  const job = await queue.add('crawl', body, queueOpts('crawl'));
  await db.query(
    `INSERT INTO crawl_runs (id, type, start_url, status)
     VALUES ($1, 'crawl', $2, 'queued')
     ON CONFLICT (id) DO NOTHING`,
    [String(job.id), normalizeUrl(body.startUrl)]
  );
  return reply.status(202).send({ ok: true, type: 'crawl', jobId: job.id });
});

app.get('/v1/jobs/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const job = await queue.getJob(id);
  if (!job) return reply.status(404).send({ ok: false, error: 'job_not_found' });
  const state = await job.getState();
  return {
    ok: true,
    job: {
      id: job.id,
      name: job.name,
      state,
      progress: job.progress,
      failedReason: job.failedReason,
      result: job.returnvalue,
    },
  };
});

app.get('/v1/stats', async () => {
  const [runs, pages, docs, issues, recs, snapshots, diffs, changedDiffs, runStatus, pageStatus, issueSeverity] = await Promise.all([
    q('SELECT COUNT(*)::int AS count FROM crawl_runs', [], 'stats_runs'),
    q('SELECT COUNT(*)::int AS count FROM crawl_pages', [], 'stats_pages'),
    q('SELECT COUNT(*)::int AS count FROM documents', [], 'stats_docs'),
    q('SELECT COUNT(*)::int AS count FROM seo_issues', [], 'stats_issues'),
    q('SELECT COUNT(*)::int AS count FROM recommendations', [], 'stats_recs'),
    q('SELECT COUNT(*)::int AS count FROM visual_snapshots', [], 'stats_visual_snapshots'),
    q('SELECT COUNT(*)::int AS count FROM visual_diffs', [], 'stats_visual_diffs'),
    q('SELECT COUNT(*)::int AS count FROM visual_diffs WHERE changed = true', [], 'stats_visual_changed'),
    q('SELECT status, COUNT(*)::int AS count FROM crawl_runs GROUP BY status', [], 'stats_run_status'),
    q('SELECT status, COUNT(*)::int AS count FROM crawl_pages GROUP BY status', [], 'stats_page_status'),
    q('SELECT severity, COUNT(*)::int AS count FROM seo_issues GROUP BY severity', [], 'stats_issue_severity'),
  ]);

  return {
    ok: true,
    counts: {
      runs: runs.rows[0]?.count ?? 0,
      pages: pages.rows[0]?.count ?? 0,
      documents: docs.rows[0]?.count ?? 0,
      issues: issues.rows[0]?.count ?? 0,
      recommendations: recs.rows[0]?.count ?? 0,
      visualSnapshots: snapshots.rows[0]?.count ?? 0,
      visualDiffs: diffs.rows[0]?.count ?? 0,
      visualChangedDiffs: changedDiffs.rows[0]?.count ?? 0,
    },
    statusCounters: {
      runs: Object.fromEntries(runStatus.rows.map((r: any) => [r.status, r.count])),
      pages: Object.fromEntries(pageStatus.rows.map((r: any) => [r.status, r.count])),
      issues: Object.fromEntries(issueSeverity.rows.map((r: any) => [r.severity, r.count])),
    },
  };
});

app.get('/v1/metrics', async () => {
  const queueCounts = await queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
  return {
    ok: true,
    uptimeSec: Math.floor((Date.now() - STARTED_AT) / 1000),
    queue: queueCounts,
    dbSlowMsThreshold: DB_SLOW_MS,
  };
});

app.post('/v1/alerts/endpoints', async (req, reply) => {
  const body = alertEndpointSchema.parse(req.body);
  const res = await q(
    `INSERT INTO alert_endpoints (kind, url, secret, enabled, metadata_json)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, kind, url, enabled, metadata_json, created_at`,
    [body.kind, body.url, body.secret || null, body.enabled ?? true, JSON.stringify(body.metadata || {})],
    'alerts_create_endpoint'
  );
  return reply.status(201).send({ ok: true, endpoint: res.rows[0] });
});

app.get('/v1/alerts/endpoints', async (req) => {
  const qv = listQuerySchema.parse(req.query || {});
  const limit = qv.limit ?? 50;
  const offset = qv.offset ?? 0;
  const res = await q(
    `SELECT id, kind, url, enabled, metadata_json, created_at
     FROM alert_endpoints
     ORDER BY id DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset],
    'alerts_list_endpoints'
  );
  const total = await q('SELECT COUNT(*)::int AS count FROM alert_endpoints', [], 'alerts_count_endpoints');
  return { ok: true, endpoints: res.rows, page: { limit, offset, total: total.rows[0]?.count ?? 0 } };
});

app.post('/v1/auth/keys', async (req, reply) => {
  const body = z.object({ name: z.string().min(1), scopes: z.array(z.enum(['read', 'write', 'admin'])).min(1).default(['read']) }).parse(req.body || {});
  const token = `pb_${crypto.randomUUID().replace(/-/g, '')}`;
  const res = await q(
    `INSERT INTO api_keys (name, token, scopes_json, enabled)
     VALUES ($1, $2, $3::jsonb, true)
     RETURNING id, name, scopes_json, enabled, created_at`,
    [body.name, token, JSON.stringify(body.scopes)],
    'auth_create_key'
  );
  return reply.status(201).send({ ok: true, key: { ...res.rows[0], token } });
});

app.get('/v1/auth/keys', async () => {
  const res = await q(
    `SELECT id, name, scopes_json, enabled, created_at FROM api_keys ORDER BY id DESC LIMIT 200`,
    [],
    'auth_list_keys'
  );
  return { ok: true, keys: res.rows };
});

app.get('/v1/alerts/events', async (req) => {
  const qv = listQuerySchema.parse(req.query || {});
  const limit = qv.limit ?? 50;
  const offset = qv.offset ?? 0;

  const where: string[] = [];
  const params: any[] = [];
  if (qv.runId) { params.push(qv.runId); where.push(`run_id = $${params.length}`); }
  if (qv.status) { params.push(qv.status); where.push(`status = $${params.length}`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  params.push(limit, offset);
  const res = await q(
    `SELECT id, run_id, endpoint_id, category, severity, title, status, attempts, last_error, delivered_at, created_at, updated_at
     FROM alert_events ${whereSql}
     ORDER BY id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
    'alerts_list_events'
  );
  const countParams = params.slice(0, -2);
  const total = await q(`SELECT COUNT(*)::int AS count FROM alert_events ${whereSql}`, countParams, 'alerts_count_events');
  return { ok: true, events: res.rows, page: { limit, offset, total: total.rows[0]?.count ?? 0 } };
});

app.post('/v1/alerts/retry/:eventId', async (req, reply) => {
  const { eventId } = req.params as { eventId: string };
  const ev = await q(
    `SELECT id, run_id, category, severity, title, payload_json
     FROM alert_events WHERE id=$1`,
    [eventId],
    'alerts_retry_lookup'
  );
  if (!ev.rowCount) return reply.status(404).send({ ok: false, error: 'alert_event_not_found' });

  const row = ev.rows[0];
  const job = await alertQueue.add('alert-deliver', {
    runId: row.run_id,
    category: row.category,
    severity: row.severity,
    title: row.title,
    payload: row.payload_json,
  }, { removeOnComplete: 300, removeOnFail: 500, attempts: 3, backoff: { type: 'exponential', delay: 2000 } });

  return { ok: true, retriedEventId: Number(eventId), alertJobId: job.id };
});

app.post('/v1/alerts/test', async (req, reply) => {
  const body = z.object({ endpointId: z.number().int().optional(), url: z.string().url().optional(), payload: z.record(z.any()).optional() }).parse(req.body || {});
  const payload = body.payload || { kind: 'pageblaze.alert.test', ts: new Date().toISOString(), message: 'test alert' };

  let url = body.url;
  let secret: string | undefined;
  let endpointId: number | null = null;
  if (!url && body.endpointId) {
    const ep = await q('SELECT id, url, secret FROM alert_endpoints WHERE id=$1', [body.endpointId], 'alerts_test_endpoint_lookup');
    if (!ep.rowCount) return reply.status(404).send({ ok: false, error: 'endpoint_not_found' });
    endpointId = Number(ep.rows[0].id);
    url = ep.rows[0].url;
    secret = ep.rows[0].secret || undefined;
  }
  if (!url) return reply.status(400).send({ ok: false, error: 'url_or_endpointId_required' });

  const sent = await deliverWebhook(url, payload, secret);

  if (endpointId) {
    await q(
      `INSERT INTO alert_events (run_id, endpoint_id, category, severity, title, payload_json, status, attempts, last_error, delivered_at, updated_at)
       VALUES (NULL, $1, 'test', 'low', 'manual test alert', $2, $3, 1, $4, $5, NOW())`,
      [endpointId, JSON.stringify(payload), sent.ok ? 'sent' : 'failed', sent.ok ? null : `${sent.status}:${sent.bodySnippet}`, sent.ok ? new Date().toISOString() : null],
      'alerts_test_event_insert'
    );
  }

  return { ok: sent.ok, delivery: sent };
});

app.get('/v1/crawls', async (req) => {
  const q = listQuerySchema.parse(req.query || {});
  const limit = q.limit ?? 20;
  const offset = q.offset ?? 0;

  const where: string[] = [];
  const params: any[] = [];
  if (q.status) {
    params.push(q.status);
    where.push(`status = $${params.length}`);
  }
  if (q.type) {
    params.push(q.type);
    where.push(`type = $${params.length}`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.push(limit, offset);

  const res = await db.query(
    `SELECT id, type, start_url, status, pages_count, error, created_at, updated_at
     FROM crawl_runs
     ${whereSql}
     ORDER BY created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  const countParams = params.slice(0, params.length - 2);
  const totalRes = await db.query(
    `SELECT COUNT(*)::int AS count FROM crawl_runs ${whereSql}`,
    countParams
  );

  const statusRes = await db.query(
    `SELECT status, COUNT(*)::int AS count FROM crawl_runs ${whereSql} GROUP BY status`,
    countParams
  );

  return {
    ok: true,
    crawls: res.rows,
    page: { limit, offset, total: totalRes.rows[0]?.count ?? 0 },
    counters: { byStatus: Object.fromEntries(statusRes.rows.map((r: any) => [r.status, r.count])) },
  };
});

app.get('/v1/crawls/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const runRes = await db.query('SELECT * FROM crawl_runs WHERE id=$1', [id]);
  if (!runRes.rowCount) return reply.status(404).send({ ok: false, error: 'crawl_not_found' });

  const pagesRes = await db.query(
    'SELECT id, url, normalized_url, depth, title, excerpt, status, error, created_at FROM crawl_pages WHERE run_id=$1 ORDER BY id ASC LIMIT 500',
    [id]
  );

  return {
    ok: true,
    crawl: runRes.rows[0],
    pages: pagesRes.rows,
  };
});

app.get('/v1/crawls/:id/pages', async (req, reply) => {
  const { id } = req.params as { id: string };
  const q = listQuerySchema.parse(req.query || {});
  const limit = q.limit ?? 100;
  const offset = q.offset ?? 0;

  const runRes = await db.query('SELECT id FROM crawl_runs WHERE id=$1', [id]);
  if (!runRes.rowCount) return reply.status(404).send({ ok: false, error: 'crawl_not_found' });

  const params: any[] = [id];
  let filter = '';
  if (q.status) {
    params.push(q.status);
    filter = ` AND status = $${params.length}`;
  }

  params.push(limit, offset);
  const res = await db.query(
    `SELECT id, run_id, url, normalized_url, depth, title, excerpt, status, error, created_at
     FROM crawl_pages
     WHERE run_id=$1${filter}
     ORDER BY id ASC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  const countParams = params.slice(0, params.length - 2);
  const totalRes = await db.query(
    `SELECT COUNT(*)::int AS count FROM crawl_pages WHERE run_id=$1${filter}`,
    countParams
  );

  const statusRes = await db.query(
    'SELECT status, COUNT(*)::int AS count FROM crawl_pages WHERE run_id=$1 GROUP BY status',
    [id]
  );

  return {
    ok: true,
    pages: res.rows,
    page: { limit, offset, total: totalRes.rows[0]?.count ?? 0 },
    counters: { byStatus: Object.fromEntries(statusRes.rows.map((r: any) => [r.status, r.count])) },
  };
});

app.get('/v1/documents', async (req) => {
  const q = listQuerySchema.parse(req.query || {});
  const limit = q.limit ?? 20;
  const offset = q.offset ?? 0;

  const params: any[] = [];
  let where = '';
  if (q.runId) {
    params.push(q.runId);
    where = `WHERE run_id = $${params.length}`;
  }

  params.push(limit, offset);
  const res = await db.query(
    `SELECT id, run_id, url, normalized_url, title, excerpt, created_at
     FROM documents
     ${where}
     ORDER BY id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  const countParams = params.slice(0, params.length - 2);
  const totalRes = await db.query(`SELECT COUNT(*)::int AS count FROM documents ${where}`, countParams);

  return {
    ok: true,
    documents: res.rows,
    page: { limit, offset, total: totalRes.rows[0]?.count ?? 0 },
  };
});

app.get('/v1/issues', async (req) => {
  const q = listQuerySchema.parse(req.query || {});
  const limit = q.limit ?? 50;
  const offset = q.offset ?? 0;

  const where: string[] = [];
  const params: any[] = [];

  if (q.runId) {
    params.push(q.runId);
    where.push(`run_id = $${params.length}`);
  }
  if (q.severity) {
    params.push(q.severity);
    where.push(`severity = $${params.length}`);
  }
  if (q.code) {
    params.push(q.code);
    where.push(`code = $${params.length}`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  params.push(limit, offset);
  const issuesRes = await db.query(
    `SELECT id, run_id, document_id, url, normalized_url, code, severity, message, evidence_json, created_at
     FROM seo_issues
     ${whereSql}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  const countParams = params.slice(0, params.length - 2);
  const totalRes = await db.query(`SELECT COUNT(*)::int AS count FROM seo_issues ${whereSql}`, countParams);
  const sevRes = await db.query(`SELECT severity, COUNT(*)::int AS count FROM seo_issues ${whereSql} GROUP BY severity`, countParams);
  const codeRes = await db.query(
    `SELECT code, COUNT(*)::int AS count FROM seo_issues ${whereSql} GROUP BY code ORDER BY count DESC LIMIT 20`,
    countParams
  );

  return {
    ok: true,
    issues: issuesRes.rows,
    page: { limit, offset, total: totalRes.rows[0]?.count ?? 0 },
    counters: {
      bySeverity: Object.fromEntries(sevRes.rows.map((r: any) => [r.severity, r.count])),
      topCodes: codeRes.rows,
    },
  };
});

app.get('/v1/documents/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const res = await db.query(
    'SELECT id, run_id, url, normalized_url, title, excerpt, markdown, text_content, metadata_json, created_at FROM documents WHERE id=$1',
    [id]
  );
  if (!res.rowCount) return reply.status(404).send({ ok: false, error: 'document_not_found' });
  return { ok: true, document: res.rows[0] };
});

app.get('/v1/recommendations', async (req) => {
  const q = listQuerySchema.parse(req.query || {});
  const limit = q.limit ?? 50;
  const offset = q.offset ?? 0;

  const where: string[] = [];
  const params: any[] = [];

  if (q.runId) {
    params.push(q.runId);
    where.push(`run_id = $${params.length}`);
  }
  if (q.severity) {
    params.push(q.severity);
    where.push(`severity = $${params.length}`);
  }
  if (q.code) {
    params.push(q.code);
    where.push(`code = $${params.length}`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  params.push(limit, offset);
  const recRes = await db.query(
    `SELECT id, run_id, issue_id, url, code, severity, message, action, impact_score, confidence_score, effort_score, priority_score, created_at
     FROM recommendations
     ${whereSql}
     ORDER BY priority_score DESC, created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  const countParams = params.slice(0, params.length - 2);
  const totalRes = await db.query(`SELECT COUNT(*)::int AS count FROM recommendations ${whereSql}`, countParams);
  const sevRes = await db.query(`SELECT severity, COUNT(*)::int AS count FROM recommendations ${whereSql} GROUP BY severity`, countParams);

  return {
    ok: true,
    recommendations: recRes.rows,
    page: { limit, offset, total: totalRes.rows[0]?.count ?? 0 },
    counters: {
      bySeverity: Object.fromEntries(sevRes.rows.map((r: any) => [r.severity, r.count])),
    },
  };
});

app.get('/v1/recommendations/top', async (req) => {
  const q = listQuerySchema.parse(req.query || {});
  const limit = q.limit ?? 10;

  const params: any[] = [];
  let where = '';
  if (q.runId) {
    params.push(q.runId);
    where = `WHERE run_id = $${params.length}`;
  }

  params.push(limit);
  const res = await db.query(
    `SELECT id, run_id, issue_id, url, code, severity, message, action, impact_score, confidence_score, effort_score, priority_score, created_at
     FROM recommendations
     ${where}
     ORDER BY priority_score DESC, created_at DESC
     LIMIT $${params.length}`,
    params
  );

  return { ok: true, topFixes: res.rows, limit };
});

app.get('/v1/visual/snapshots', async (req) => {
  const qv = listQuerySchema.parse(req.query || {});
  const limit = qv.limit ?? 50;
  const offset = qv.offset ?? 0;

  const params: any[] = [];
  let where = '';
  if (qv.runId) {
    params.push(qv.runId);
    where = `WHERE run_id = $${params.length}`;
  }

  params.push(limit, offset);
  const res = await db.query(
    `SELECT id, run_id, document_id, url, normalized_url, url_hash, snapshot_kind, content_hash, image_path, metadata_json, created_at
     FROM visual_snapshots
     ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const countParams = params.slice(0, params.length - 2);
  const totalRes = await db.query(`SELECT COUNT(*)::int AS count FROM visual_snapshots ${where}`, countParams);

  return { ok: true, snapshots: res.rows, page: { limit, offset, total: totalRes.rows[0]?.count ?? 0 } };
});

app.get('/v1/visual/diffs', async (req) => {
  const qv = listQuerySchema.parse(req.query || {});
  const limit = qv.limit ?? 50;
  const offset = qv.offset ?? 0;

  const params: any[] = [];
  let where = '';
  if (qv.runId) {
    params.push(qv.runId);
    where = `WHERE run_id = $${params.length}`;
  }

  params.push(limit, offset);
  const res = await db.query(
    `SELECT id, run_id, snapshot_id, previous_snapshot_id, url, normalized_url, url_hash, diff_score, changed, summary, metadata_json, created_at
     FROM visual_diffs
     ${where}
     ORDER BY diff_score DESC, created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const countParams = params.slice(0, params.length - 2);
  const totalRes = await db.query(`SELECT COUNT(*)::int AS count FROM visual_diffs ${where}`, countParams);

  return { ok: true, diffs: res.rows, page: { limit, offset, total: totalRes.rows[0]?.count ?? 0 } };
});

app.get('/v1/issues/groups', async (req) => {
  const q = listQuerySchema.parse(req.query || {});
  const limit = q.limit ?? 20;
  const offset = q.offset ?? 0;

  const where: string[] = [];
  const params: any[] = [];
  if (q.runId) {
    params.push(q.runId);
    where.push(`run_id = $${params.length}`);
  }
  if (q.severity) {
    params.push(q.severity);
    where.push(`severity = $${params.length}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  params.push(limit, offset);
  const groupsRes = await db.query(
    `SELECT code, severity, COUNT(*)::int AS issue_count,
            COUNT(DISTINCT normalized_url)::int AS affected_urls,
            MAX(created_at) AS last_seen,
            MIN(message) AS sample_message
     FROM seo_issues
     ${whereSql}
     GROUP BY code, severity
     ORDER BY issue_count DESC, affected_urls DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  const countParams = params.slice(0, params.length - 2);
  const totalGroups = await db.query(
    `SELECT COUNT(*)::int AS count FROM (
      SELECT 1 FROM seo_issues ${whereSql} GROUP BY code, severity
    ) t`,
    countParams
  );

  return { ok: true, groups: groupsRes.rows, page: { limit, offset, total: totalGroups.rows[0]?.count ?? 0 } };
});

app.get('/v1/trends/issues', async (req) => {
  const q = listQuerySchema.parse(req.query || {});
  const where: string[] = [];
  const params: any[] = [];

  if (q.runId) {
    params.push(q.runId);
    where.push(`run_id = $${params.length}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const res = await db.query(
    `SELECT to_char(date_trunc('hour', created_at), 'YYYY-MM-DD"T"HH24:00:00"Z"') AS bucket,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE severity='critical')::int AS critical,
            COUNT(*) FILTER (WHERE severity='high')::int AS high,
            COUNT(*) FILTER (WHERE severity='medium')::int AS medium,
            COUNT(*) FILTER (WHERE severity='low')::int AS low
     FROM seo_issues
     ${whereSql}
     GROUP BY 1
     ORDER BY 1 DESC
     LIMIT 168`,
    params
  );

  return { ok: true, buckets: res.rows };
});

app.get('/v1/trends/recommendations', async (req) => {
  const q = listQuerySchema.parse(req.query || {});
  const where: string[] = [];
  const params: any[] = [];

  if (q.runId) {
    params.push(q.runId);
    where.push(`run_id = $${params.length}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const res = await db.query(
    `SELECT to_char(date_trunc('hour', created_at), 'YYYY-MM-DD"T"HH24:00:00"Z"') AS bucket,
            COUNT(*)::int AS total,
            AVG(priority_score)::float8 AS avg_priority
     FROM recommendations
     ${whereSql}
     GROUP BY 1
     ORDER BY 1 DESC
     LIMIT 168`,
    params
  );

  return { ok: true, buckets: res.rows };
});

function toCsv(rows: any[], columns: string[]) {
  const esc = (v: any) => {
    if (v == null) return '';
    const s = String(v).replace(/"/g, '""');
    return /[",\n]/.test(s) ? `"${s}"` : s;
  };
  const header = columns.join(',');
  const lines = rows.map((r) => columns.map((c) => esc(r[c])).join(','));
  return [header, ...lines].join('\n') + '\n';
}

app.get('/v1/export/issues.csv', async (req, reply) => {
  const q = listQuerySchema.parse(req.query || {});
  const params: any[] = [];
  const where: string[] = [];
  if (q.runId) {
    params.push(q.runId);
    where.push(`run_id = $${params.length}`);
  }
  if (q.severity) {
    params.push(q.severity);
    where.push(`severity = $${params.length}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const res = await db.query(
    `SELECT id, run_id, url, code, severity, message, created_at
     FROM seo_issues ${whereSql}
     ORDER BY created_at DESC, id DESC
     LIMIT 5000`,
    params
  );
  const csv = toCsv(res.rows, ['id', 'run_id', 'url', 'code', 'severity', 'message', 'created_at']);
  reply.header('content-type', 'text/csv; charset=utf-8');
  return csv;
});

app.get('/v1/export/recommendations.csv', async (req, reply) => {
  const q = listQuerySchema.parse(req.query || {});
  const params: any[] = [];
  const where: string[] = [];
  if (q.runId) {
    params.push(q.runId);
    where.push(`run_id = $${params.length}`);
  }
  if (q.severity) {
    params.push(q.severity);
    where.push(`severity = $${params.length}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const res = await db.query(
    `SELECT id, run_id, url, code, severity, action, priority_score, impact_score, confidence_score, effort_score, created_at
     FROM recommendations ${whereSql}
     ORDER BY priority_score DESC, created_at DESC
     LIMIT 5000`,
    params
  );
  const csv = toCsv(res.rows, [
    'id',
    'run_id',
    'url',
    'code',
    'severity',
    'action',
    'priority_score',
    'impact_score',
    'confidence_score',
    'effort_score',
    'created_at',
  ]);
  reply.header('content-type', 'text/csv; charset=utf-8');
  return csv;
});

async function shutdown(signal: string) {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await queue.close();
  await alertQueue.close();
  await db.end();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

(async () => {
  await verifySchema();
  await app.listen({ port: PORT, host: '0.0.0.0' });
  app.log.info(`PageBlaze API on ${PORT}`);
})();
