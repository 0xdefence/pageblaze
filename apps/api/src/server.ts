import 'dotenv/config';
import Fastify from 'fastify';
import { Queue } from 'bullmq';
import { ZodError, z } from 'zod';
import { QUEUE_NAME } from '@pageblaze/shared';

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

async function shutdown(signal: string) {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await queue.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

app.listen({ port: PORT, host: '0.0.0.0' }).then(() => app.log.info(`PageBlaze API on ${PORT}`));
