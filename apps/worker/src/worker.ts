import 'dotenv/config';
import { Worker, Job } from 'bullmq';
import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';
import { Readability } from '@mozilla/readability';
import { chromium } from 'playwright';
import { QUEUE_NAME, db, hashUrl, initDbSchema, normalizeUrl } from '@pageblaze/shared';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const BROWSER_ENABLED = String(process.env.BROWSER_ENABLED || 'false').toLowerCase() === 'true';

async function fetchHttp(url: string): Promise<string> {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`http_fetch_failed:${res.status}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len && len > 2_500_000) throw new Error('payload_too_large');
  return await res.text();
}

async function fetchBrowser(url: string): Promise<string> {
  if (!BROWSER_ENABLED) throw new Error('browser_disabled');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    return await page.content();
  } finally {
    await browser.close();
  }
}

function extractContent(html: string, url: string) {
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;
  const parsed = new Readability(doc).parse();
  const contentHtml = parsed?.content || doc.body?.innerHTML || '';
  const turndown = new TurndownService();
  const markdown = turndown.turndown(contentHtml);
  const text = (parsed?.textContent || doc.body?.textContent || '').trim();
  const links = Array.from(doc.querySelectorAll('a[href]'))
    .map((a) => (a as HTMLAnchorElement).href)
    .filter(Boolean)
    .slice(0, 400);
  return {
    title: parsed?.title || doc.title || '',
    excerpt: parsed?.excerpt || '',
    markdown,
    text,
    links,
  };
}

async function scrapeUrl(url: string, renderMode = 'auto') {
  let html = '';
  let mode = renderMode;

  if (renderMode === 'http') html = await fetchHttp(url);
  else if (renderMode === 'browser') html = await fetchBrowser(url);
  else {
    try {
      html = await fetchHttp(url);
      mode = 'http';
      if (html.length < 2000 && BROWSER_ENABLED) {
        html = await fetchBrowser(url);
        mode = 'browser';
      }
    } catch {
      html = await fetchBrowser(url);
      mode = 'browser';
    }
  }

  const extracted = extractContent(html, url);
  return { ok: true, mode, url, ...extracted };
}

async function saveDocument(runId: string, url: string, depth: number, data: any) {
  const normalizedUrl = normalizeUrl(url);
  const urlHash = hashUrl(normalizedUrl);

  const page = await db.query(
    `INSERT INTO crawl_pages (run_id, url, normalized_url, url_hash, depth, title, excerpt, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'done')
     ON CONFLICT (run_id, normalized_url)
     DO UPDATE SET url=EXCLUDED.url, title=EXCLUDED.title, excerpt=EXCLUDED.excerpt, status='done', error=NULL
     RETURNING id`,
    [runId, url, normalizedUrl, urlHash, depth, data.title || null, data.excerpt || null]
  );

  const doc = await db.query(
    `INSERT INTO documents (run_id, url, normalized_url, url_hash, title, excerpt, markdown, text_content, metadata_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (run_id, url_hash)
     DO UPDATE SET
      url=EXCLUDED.url,
      title=EXCLUDED.title,
      excerpt=EXCLUDED.excerpt,
      markdown=EXCLUDED.markdown,
      text_content=EXCLUDED.text_content,
      metadata_json=EXCLUDED.metadata_json
     RETURNING id`,
    [
      runId,
      url,
      normalizedUrl,
      urlHash,
      data.title || null,
      data.excerpt || null,
      data.markdown || '',
      data.text || '',
      JSON.stringify({ mode: data.mode, links: data.links?.length || 0, pageId: page.rows[0].id }),
    ]
  );

  return { documentId: Number(doc.rows[0].id), normalizedUrl, urlHash };
}

async function handleScrape(job: Job) {
  const runId = String(job.id);
  const { url, renderMode = 'auto' } = job.data as any;
  const result = await scrapeUrl(url, renderMode);
  const saved = await saveDocument(runId, url, 0, result);

  await db.query(
    `UPDATE crawl_runs
     SET status='done', pages_count=1, result_json=$2::jsonb, updated_at=NOW()
     WHERE id=$1`,
    [runId, JSON.stringify({ ok: true, type: 'scrape', url, normalizedUrl: saved.normalizedUrl, documentId: saved.documentId })]
  );

  return { runId, ...saved, ...result };
}

async function handleCrawl(job: Job) {
  const runId = String(job.id);
  const {
    startUrl,
    maxDepth = 1,
    maxPages = 30,
    allowDomains,
    excludePatterns = [],
    renderMode = 'auto',
  } = job.data as any;

  const start = new URL(startUrl);
  const allowed = new Set((allowDomains?.length ? allowDomains : [start.hostname]).map((d: string) => d.toLowerCase()));
  const seen = new Set<string>();
  const q: Array<{ url: string; depth: number }> = [{ url: normalizeUrl(startUrl), depth: 0 }];
  const items: any[] = [];

  while (q.length && items.length < maxPages) {
    const cur = q.shift()!;
    const normalizedCurrent = normalizeUrl(cur.url);
    if (seen.has(normalizedCurrent)) continue;
    seen.add(normalizedCurrent);

    const u = new URL(normalizedCurrent);
    if (!allowed.has(u.hostname.toLowerCase())) continue;
    if (excludePatterns.some((p: string) => normalizedCurrent.includes(p))) continue;

    try {
      const r = await scrapeUrl(normalizedCurrent, renderMode);
      const saved = await saveDocument(runId, normalizedCurrent, cur.depth, r);
      items.push({ url: normalizedCurrent, depth: cur.depth, title: r.title, excerpt: r.excerpt, documentId: saved.documentId });

      if (cur.depth < maxDepth) {
        for (const l of r.links || []) {
          try {
            const lu = normalizeUrl(new URL(l, normalizedCurrent).toString());
            if (!seen.has(lu)) q.push({ url: lu, depth: cur.depth + 1 });
          } catch {
            // ignore malformed links
          }
        }
      }
    } catch (e: any) {
      await db.query(
        `INSERT INTO crawl_pages (run_id, url, normalized_url, url_hash, depth, status, error)
         VALUES ($1, $2, $3, $4, $5, 'failed', $6)
         ON CONFLICT (run_id, normalized_url)
         DO UPDATE SET status='failed', error=EXCLUDED.error`,
        [runId, normalizedCurrent, normalizedCurrent, hashUrl(normalizedCurrent), cur.depth, String(e?.message || e)]
      );
    }

    await job.updateProgress(Math.min(100, Math.round((items.length / maxPages) * 100)));
  }

  await db.query(
    `UPDATE crawl_runs
     SET status='done', pages_count=$2, result_json=$3::jsonb, updated_at=NOW()
     WHERE id=$1`,
    [runId, items.length, JSON.stringify({ ok: true, type: 'crawl', startUrl: normalizeUrl(startUrl), pages: items.length })]
  );

  return { ok: true, runId, startUrl: normalizeUrl(startUrl), pages: items.length, items };
}

const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const runId = String(job.id);
    await db.query(`UPDATE crawl_runs SET status='running', updated_at=NOW() WHERE id=$1`, [runId]);

    try {
      if (job.name === 'scrape') return await handleScrape(job);
      if (job.name === 'crawl') return await handleCrawl(job);
      throw new Error(`unknown_job:${job.name}`);
    } catch (err: any) {
      await db.query(
        `UPDATE crawl_runs SET status='failed', error=$2, updated_at=NOW() WHERE id=$1`,
        [runId, String(err?.message || err)]
      );
      throw err;
    }
  },
  { connection: { url: redisUrl }, concurrency: 3 }
);

worker.on('failed', (job, err) => {
  console.error('job_failed', { id: job?.id, name: job?.name, err: err.message });
});

async function shutdown(signal: string) {
  console.log(`worker shutting down: ${signal}`);
  await worker.close();
  await db.end();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

(async () => {
  await initDbSchema();
  console.log('PageBlaze worker started');
})();
