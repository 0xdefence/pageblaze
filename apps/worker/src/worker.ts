import 'dotenv/config';
import { Worker, Job } from 'bullmq';
import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';
import { Readability } from '@mozilla/readability';
import { chromium } from 'playwright';
import {
  QUEUE_NAME,
  db,
  extractSitemapUrls,
  hashUrl,
  initDbSchema,
  isAllowedByRobots,
  normalizeUrl,
  parseRobotsTxt,
  type RobotsPolicy,
} from '@pageblaze/shared';

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

function detectSeoIssues(doc: Document, pageUrl: string) {
  const issues: Array<{ code: string; severity: 'critical' | 'high' | 'medium' | 'low'; message: string; evidence: any }> = [];

  const title = (doc.querySelector('title')?.textContent || '').trim();
  const metaDesc = (doc.querySelector('meta[name="description"]')?.getAttribute('content') || '').trim();
  const canonical = (doc.querySelector('link[rel="canonical"]')?.getAttribute('href') || '').trim();
  const h1s = Array.from(doc.querySelectorAll('h1'));
  const robotsMeta = (doc.querySelector('meta[name="robots"]')?.getAttribute('content') || '').toLowerCase();
  const imgsMissingAlt = Array.from(doc.querySelectorAll('img')).filter((i) => !i.getAttribute('alt')?.trim()).length;
  const hasSchema = doc.querySelector('script[type="application/ld+json"]') !== null;

  if (!title) issues.push({ code: 'title_missing', severity: 'high', message: 'Missing <title> tag', evidence: { url: pageUrl } });
  else {
    if (title.length < 15) issues.push({ code: 'title_too_short', severity: 'low', message: 'Title is too short', evidence: { length: title.length, title } });
    if (title.length > 60) issues.push({ code: 'title_too_long', severity: 'low', message: 'Title is too long', evidence: { length: title.length, title } });
  }

  if (!metaDesc) issues.push({ code: 'meta_description_missing', severity: 'medium', message: 'Missing meta description', evidence: { url: pageUrl } });
  else {
    if (metaDesc.length < 50 || metaDesc.length > 160) {
      issues.push({ code: 'meta_description_length', severity: 'low', message: 'Meta description length outside recommended range', evidence: { length: metaDesc.length } });
    }
  }

  if (!canonical) issues.push({ code: 'canonical_missing', severity: 'medium', message: 'Missing canonical link', evidence: { url: pageUrl } });

  if (h1s.length === 0) issues.push({ code: 'h1_missing', severity: 'high', message: 'Missing H1', evidence: { url: pageUrl } });
  if (h1s.length > 1) issues.push({ code: 'h1_multiple', severity: 'low', message: 'Multiple H1 tags found', evidence: { count: h1s.length } });

  if (robotsMeta.includes('noindex')) issues.push({ code: 'noindex_present', severity: 'medium', message: 'Page marked noindex', evidence: { robots: robotsMeta } });

  if (imgsMissingAlt > 0) issues.push({ code: 'image_alt_missing', severity: 'low', message: 'Images missing alt text', evidence: { count: imgsMissingAlt } });

  if (!hasSchema) issues.push({ code: 'schema_missing', severity: 'low', message: 'No JSON-LD schema detected', evidence: { url: pageUrl } });

  return issues;
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
  const seoIssues = detectSeoIssues(doc, url);
  return {
    title: parsed?.title || doc.title || '',
    excerpt: parsed?.excerpt || '',
    markdown,
    text,
    links,
    seoIssues,
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

async function fetchRobotsPolicy(startUrl: string): Promise<RobotsPolicy> {
  try {
    const u = new URL(startUrl);
    const robotsUrl = `${u.protocol}//${u.host}/robots.txt`;
    const txt = await fetchHttp(robotsUrl);
    return parseRobotsTxt(txt);
  } catch {
    return { disallow: [], sitemapUrls: [] };
  }
}

async function fetchSitemapSeeds(startUrl: string, policy: RobotsPolicy, max = 200): Promise<string[]> {
  const seeds = new Set<string>();
  const u = new URL(startUrl);
  const candidates = policy.sitemapUrls.length ? policy.sitemapUrls : [`${u.protocol}//${u.host}/sitemap.xml`];

  for (const s of candidates.slice(0, 3)) {
    try {
      const xml = await fetchHttp(s);
      for (const loc of extractSitemapUrls(xml, max)) {
        try {
          seeds.add(normalizeUrl(loc));
          if (seeds.size >= max) break;
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore missing sitemap
    }
    if (seeds.size >= max) break;
  }

  return Array.from(seeds);
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

  const documentId = Number(doc.rows[0].id);

  for (const issue of data.seoIssues || []) {
    await db.query(
      `INSERT INTO seo_issues (run_id, document_id, url, normalized_url, url_hash, code, severity, message, evidence_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (run_id, url_hash, code)
       DO UPDATE SET severity=EXCLUDED.severity, message=EXCLUDED.message, evidence_json=EXCLUDED.evidence_json, document_id=EXCLUDED.document_id`,
      [runId, documentId, url, normalizedUrl, urlHash, issue.code, issue.severity, issue.message, JSON.stringify(issue.evidence || {})]
    );
  }

  return { documentId, normalizedUrl, urlHash, seoIssueCount: (data.seoIssues || []).length };
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
    respectRobots = true,
  } = job.data as any;

  const normalizedStart = normalizeUrl(startUrl);
  const start = new URL(normalizedStart);
  const allowed = new Set((allowDomains?.length ? allowDomains : [start.hostname]).map((d: string) => d.toLowerCase()));

  const robotsPolicy = respectRobots ? await fetchRobotsPolicy(normalizedStart) : { disallow: [], sitemapUrls: [] };
  const sitemapSeeds = await fetchSitemapSeeds(normalizedStart, robotsPolicy, Math.min(maxPages, 200));

  const seen = new Set<string>();
  const q: Array<{ url: string; depth: number }> = [{ url: normalizedStart, depth: 0 }];
  for (const s of sitemapSeeds) q.push({ url: s, depth: 0 });

  const items: any[] = [];
  const blockedByRobots: string[] = [];

  while (q.length && items.length < maxPages) {
    const cur = q.shift()!;
    const normalizedCurrent = normalizeUrl(cur.url);
    if (seen.has(normalizedCurrent)) continue;
    seen.add(normalizedCurrent);

    const u = new URL(normalizedCurrent);
    if (!allowed.has(u.hostname.toLowerCase())) continue;
    if (excludePatterns.some((p: string) => normalizedCurrent.includes(p))) continue;
    if (respectRobots && !isAllowedByRobots(normalizedCurrent, robotsPolicy)) {
      blockedByRobots.push(normalizedCurrent);
      await db.query(
        `INSERT INTO crawl_pages (run_id, url, normalized_url, url_hash, depth, status, error)
         VALUES ($1, $2, $3, $4, $5, 'failed', 'robots_disallow')
         ON CONFLICT (run_id, normalized_url)
         DO UPDATE SET status='failed', error='robots_disallow'`,
        [runId, normalizedCurrent, normalizedCurrent, hashUrl(normalizedCurrent), cur.depth]
      );
      continue;
    }

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
    [
      runId,
      items.length,
      JSON.stringify({
        ok: true,
        type: 'crawl',
        startUrl: normalizedStart,
        pages: items.length,
        robots: { respected: !!respectRobots, blocked: blockedByRobots.length },
        sitemap: { seeds: sitemapSeeds.length },
      }),
    ]
  );

  return {
    ok: true,
    runId,
    startUrl: normalizedStart,
    pages: items.length,
    robots: { respected: !!respectRobots, blocked: blockedByRobots.length },
    sitemap: { seeds: sitemapSeeds.length },
    items,
  };
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
