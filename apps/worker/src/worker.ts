import 'dotenv/config';
import { Worker, Job } from 'bullmq';
import Redis from 'ioredis';
import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';
import { Readability } from '@mozilla/readability';
import { chromium } from 'playwright';
import { QUEUE_NAME } from '@pageblaze/shared';

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', { maxRetriesPerRequest: null });

async function fetchHttp(url: string): Promise<string> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`http_fetch_failed:${res.status}`);
  return await res.text();
}

async function fetchBrowser(url: string): Promise<string> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
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

async function handleScrape(job: Job) {
  const { url, renderMode = 'auto' } = job.data as any;
  let html = '';
  let mode = renderMode;

  if (renderMode === 'http') html = await fetchHttp(url);
  else if (renderMode === 'browser') html = await fetchBrowser(url);
  else {
    try {
      html = await fetchHttp(url);
      if (html.length < 2000) {
        html = await fetchBrowser(url);
        mode = 'browser';
      } else mode = 'http';
    } catch {
      html = await fetchBrowser(url);
      mode = 'browser';
    }
  }

  const extracted = extractContent(html, url);
  return { ok: true, mode, url, ...extracted };
}

async function handleCrawl(job: Job) {
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
  const q: Array<{ url: string; depth: number }> = [{ url: startUrl, depth: 0 }];
  const items: any[] = [];

  while (q.length && items.length < maxPages) {
    const cur = q.shift()!;
    if (seen.has(cur.url)) continue;
    seen.add(cur.url);

    const u = new URL(cur.url);
    if (!allowed.has(u.hostname.toLowerCase())) continue;
    if (excludePatterns.some((p: string) => cur.url.includes(p))) continue;

    const r = await handleScrape({ data: { url: cur.url, renderMode } } as any);
    items.push({ url: cur.url, depth: cur.depth, title: r.title, excerpt: r.excerpt });

    if (cur.depth < maxDepth) {
      for (const l of r.links || []) {
        try {
          const lu = new URL(l, cur.url);
          if (allowed.has(lu.hostname.toLowerCase()) && !seen.has(lu.href)) q.push({ url: lu.href, depth: cur.depth + 1 });
        } catch {}
      }
    }

    await job.updateProgress(Math.min(100, Math.round((items.length / maxPages) * 100)));
  }

  return { ok: true, startUrl, pages: items.length, items };
}

new Worker(
  QUEUE_NAME,
  async (job) => {
    if (job.name === 'scrape') return handleScrape(job);
    if (job.name === 'crawl') return handleCrawl(job);
    throw new Error(`unknown_job:${job.name}`);
  },
  { connection: redis, concurrency: 3 }
);

console.log('PageBlaze worker started');
