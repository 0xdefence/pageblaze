import 'dotenv/config';
import Fastify from 'fastify';
import { Queue } from 'bullmq';
import { ZodError, z } from 'zod';
import { QUEUE_NAME, db, initDbSchema, normalizeUrl } from '@pageblaze/shared';

const app = Fastify({ logger: true });
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const queue = new Queue(QUEUE_NAME, { connection: { url: redisUrl } });
const PORT = Number(process.env.PORT || 4410);
const API_KEY = process.env.API_KEY || 'pageblaze-dev-key';

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof ZodError) {
    return reply.status(400).send({ ok: false, error: 'validation_error', details: err.issues });
  }
  app.log.error(err);
  return reply.status(500).send({ ok: false, error: 'internal_error' });
});

app.addHook('onRequest', async (req, reply) => {
  if (req.url === '/healthz') return;
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) return reply.status(401).send({ ok: false, error: 'unauthorized' });
});

app.get('/healthz', async () => ({ ok: true }));

const scrapeSchema = z.object({
  url: z.string().url(),
  renderMode: z.enum(['auto', 'http', 'browser']).optional(),
  extract: z.enum(['markdown', 'text', 'html']).optional(),
  includeLinks: z.boolean().optional(),
});

const queueOpts = {
  removeOnComplete: 100,
  removeOnFail: 500,
  attempts: 2,
  backoff: { type: 'exponential' as const, delay: 2000 },
};

app.post('/v1/scrape', async (req, reply) => {
  const body = scrapeSchema.parse(req.body);
  const job = await queue.add('scrape', body, queueOpts);
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
  const job = await queue.add('crawl', body, queueOpts);
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

app.get('/v1/crawls/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const runRes = await db.query('SELECT * FROM crawl_runs WHERE id=$1', [id]);
  if (!runRes.rowCount) return reply.status(404).send({ ok: false, error: 'crawl_not_found' });

  const pagesRes = await db.query(
    'SELECT id, url, depth, title, excerpt, status, error, created_at FROM crawl_pages WHERE run_id=$1 ORDER BY id ASC LIMIT 500',
    [id]
  );

  return {
    ok: true,
    crawl: runRes.rows[0],
    pages: pagesRes.rows,
  };
});

app.get('/v1/documents/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const res = await db.query(
    'SELECT id, run_id, url, title, excerpt, markdown, text_content, metadata_json, created_at FROM documents WHERE id=$1',
    [id]
  );
  if (!res.rowCount) return reply.status(404).send({ ok: false, error: 'document_not_found' });
  return { ok: true, document: res.rows[0] };
});

async function shutdown(signal: string) {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await queue.close();
  await db.end();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

(async () => {
  await initDbSchema();
  await app.listen({ port: PORT, host: '0.0.0.0' });
  app.log.info(`PageBlaze API on ${PORT}`);
})();
