import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Worker, Job, UnrecoverableError } from 'bullmq';
import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';
import { Readability } from '@mozilla/readability';
import { chromium } from 'playwright';
import {
  QUEUE_NAME,
  db,
  extractSitemapUrls,
  hashUrl,
  verifySchema,
  isAllowedByRobots,
  normalizeUrl,
  parseRobotsTxt,
  type RobotsPolicy,
} from '@pageblaze/shared';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const BROWSER_ENABLED = String(process.env.BROWSER_ENABLED || 'false').toLowerCase() === 'true';
const VISUAL_SCREENSHOT_ENABLED = String(process.env.VISUAL_SCREENSHOT_ENABLED || 'false').toLowerCase() === 'true';
const VISUAL_ARTIFACTS_DIR = process.env.VISUAL_ARTIFACTS_DIR || './artifacts/visual';
const DOMAIN_DELAY_MS = Number(process.env.DOMAIN_DELAY_MS || 250);
const lastRequestAtByHost = new Map<string, number>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function classifyRetryability(err: unknown): { retryable: boolean; code: string } {
  const m = String((err as any)?.message || err || '').toLowerCase();
  if (!m) return { retryable: false, code: 'unknown' };
  if (m.includes('robots_disallow')) return { retryable: false, code: 'robots_disallow' };
  if (m.includes('payload_too_large')) return { retryable: false, code: 'payload_too_large' };
  if (m.includes('validation')) return { retryable: false, code: 'validation' };
  if (m.includes('http_fetch_failed:4')) return { retryable: false, code: 'http_4xx' };
  if (m.includes('http_fetch_failed:5')) return { retryable: true, code: 'http_5xx' };
  if (m.includes('timeout') || m.includes('timed out') || m.includes('econnreset') || m.includes('enotfound') || m.includes('eai_again')) {
    return { retryable: true, code: 'network_transient' };
  }
  return { retryable: false, code: 'other' };
}

async function throttleByHost(targetUrl: string) {
  const host = new URL(targetUrl).host.toLowerCase();
  const last = lastRequestAtByHost.get(host) || 0;
  const now = Date.now();
  const delta = now - last;
  if (delta < DOMAIN_DELAY_MS) await sleep(DOMAIN_DELAY_MS - delta);
  lastRequestAtByHost.set(host, Date.now());
}

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

function recommendationForIssue(code: string, severity: 'critical' | 'high' | 'medium' | 'low', message: string) {
  const impactMap: Record<string, number> = { critical: 1.0, high: 0.85, medium: 0.6, low: 0.35 };
  const defaults = { action: 'Review and fix this issue', impact: impactMap[severity], confidence: 0.75, effort: 0.6 };

  const byCode: Record<string, { action: string; impact?: number; confidence?: number; effort?: number }> = {
    title_missing: { action: 'Add a unique descriptive <title> tag', impact: 0.9, confidence: 0.9, effort: 0.3 },
    title_too_short: { action: 'Expand title to be descriptive (15-60 chars)', impact: 0.45, confidence: 0.8, effort: 0.2 },
    title_too_long: { action: 'Trim title to ~60 characters', impact: 0.35, confidence: 0.8, effort: 0.2 },
    meta_description_missing: { action: 'Add meta description (50-160 chars)', impact: 0.55, confidence: 0.8, effort: 0.25 },
    meta_description_length: { action: 'Adjust meta description length to recommended range', impact: 0.3, confidence: 0.75, effort: 0.2 },
    canonical_missing: { action: 'Set canonical URL for page', impact: 0.7, confidence: 0.85, effort: 0.3 },
    h1_missing: { action: 'Add one clear H1 heading', impact: 0.65, confidence: 0.85, effort: 0.25 },
    h1_multiple: { action: 'Reduce to a single primary H1', impact: 0.3, confidence: 0.75, effort: 0.2 },
    noindex_present: { action: 'Remove noindex if page should rank', impact: 0.8, confidence: 0.85, effort: 0.25 },
    image_alt_missing: { action: 'Add alt text to images', impact: 0.25, confidence: 0.7, effort: 0.35 },
    schema_missing: { action: 'Add relevant JSON-LD structured data', impact: 0.4, confidence: 0.7, effort: 0.5 },
  };

  const c = byCode[code] || { action: message };
  const impact = c.impact ?? defaults.impact;
  const confidence = c.confidence ?? defaults.confidence;
  const effort = c.effort ?? defaults.effort;
  const priority = Number((impact * confidence * (1 - effort)).toFixed(4));

  return {
    action: c.action || defaults.action,
    impact_score: impact,
    confidence_score: confidence,
    effort_score: effort,
    priority_score: priority,
  };
}

function textSimilarity(a: string, b: string): number {
  const ta = new Set((a || '').toLowerCase().split(/\W+/).filter(Boolean));
  const tb = new Set((b || '').toLowerCase().split(/\W+/).filter(Boolean));
  if (!ta.size && !tb.size) return 1;
  const inter = [...ta].filter((x) => tb.has(x)).length;
  const union = new Set([...ta, ...tb]).size;
  return union ? inter / union : 1;
}

async function captureScreenshotArtifacts(url: string, urlHash: string) {
  if (!VISUAL_SCREENSHOT_ENABLED || !BROWSER_ENABLED) {
    return { imagePaths: null as any, imageHashes: null as any };
  }

  const now = Date.now();
  const baseDir = path.resolve(VISUAL_ARTIFACTS_DIR, urlHash.slice(0, 12));
  await fs.mkdir(baseDir, { recursive: true });

  const desktopPath = path.join(baseDir, `${now}-desktop.png`);
  const mobilePath = path.join(baseDir, `${now}-mobile.png`);

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.screenshot({ path: desktopPath, fullPage: true });

    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await mobile.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await mobile.screenshot({ path: mobilePath, fullPage: true });

    const desktopBuf = await fs.readFile(desktopPath);
    const mobileBuf = await fs.readFile(mobilePath);

    return {
      imagePaths: { desktop: desktopPath, mobile: mobilePath },
      imageHashes: { desktop: hashUrl(desktopBuf.toString('base64')), mobile: hashUrl(mobileBuf.toString('base64')) },
    };
  } catch {
    return { imagePaths: null as any, imageHashes: null as any };
  } finally {
    await browser.close();
  }
}

async function saveVisualSnapshot(client: any, runId: string, documentId: number, url: string, normalizedUrl: string, urlHash: string, textContent: string) {
  const contentHash = hashUrl(textContent || '');
  const shot = await captureScreenshotArtifacts(url, urlHash);

  const snapRes = await client.query(
    `INSERT INTO visual_snapshots (run_id, document_id, url, normalized_url, url_hash, snapshot_kind, content_hash, image_path, metadata_json)
     VALUES ($1, $2, $3, $4, $5, 'content', $6, $7, $8)
     RETURNING id`,
    [
      runId,
      documentId,
      url,
      normalizedUrl,
      urlHash,
      contentHash,
      shot.imagePaths?.desktop || null,
      JSON.stringify({ source: 'text_hash', imagePaths: shot.imagePaths, imageHashes: shot.imageHashes }),
    ]
  );
  const snapshotId = Number(snapRes.rows[0].id);

  const prevRes = await client.query(
    `SELECT id, content_hash, document_id, metadata_json FROM visual_snapshots
     WHERE url_hash=$1 AND id <> $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [urlHash, snapshotId]
  );

  let diffScore = 0;
  let changed = false;
  let summary = 'first snapshot';
  let prevId: number | null = null;

  if (prevRes.rowCount) {
    prevId = Number(prevRes.rows[0].id);
    const prevDocId = Number(prevRes.rows[0].document_id || 0);
    const prevMeta = prevRes.rows[0].metadata_json || {};
    let prevText = '';
    if (prevDocId) {
      const prevDocRes = await client.query('SELECT text_content FROM documents WHERE id=$1', [prevDocId]);
      prevText = String(prevDocRes.rows[0]?.text_content || '');
    }

    const sim = textSimilarity(textContent || '', prevText);
    diffScore = Number((1 - sim).toFixed(4));

    const prevDesktopHash = prevMeta?.imageHashes?.desktop;
    const curDesktopHash = shot.imageHashes?.desktop;
    if (prevDesktopHash && curDesktopHash && prevDesktopHash !== curDesktopHash) {
      diffScore = Math.max(diffScore, 0.35);
      summary = 'visual drift detected (desktop hash changed)';
    }

    changed = diffScore >= 0.2;
    if (!summary || summary === 'first snapshot') {
      summary = changed ? 'content drift detected' : 'minor/no drift';
    }
  }

  await client.query(
    `INSERT INTO visual_diffs (run_id, snapshot_id, previous_snapshot_id, url, normalized_url, url_hash, diff_score, changed, summary, metadata_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      runId,
      snapshotId,
      prevId,
      url,
      normalizedUrl,
      urlHash,
      diffScore,
      changed,
      summary,
      JSON.stringify({ method: 'token_jaccard', screenshot_enabled: VISUAL_SCREENSHOT_ENABLED }),
    ]
  );

  return { snapshotId, diffScore, changed };
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
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    const page = await client.query(
      `INSERT INTO crawl_pages (run_id, url, normalized_url, url_hash, depth, title, excerpt, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'done')
       ON CONFLICT (run_id, normalized_url)
       DO UPDATE SET url=EXCLUDED.url, title=EXCLUDED.title, excerpt=EXCLUDED.excerpt, status='done', error=NULL
       RETURNING id`,
      [runId, url, normalizedUrl, urlHash, depth, data.title || null, data.excerpt || null]
    );

    const doc = await client.query(
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
      const issueRes = await client.query(
        `INSERT INTO seo_issues (run_id, document_id, url, normalized_url, url_hash, code, severity, message, evidence_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (run_id, url_hash, code)
         DO UPDATE SET severity=EXCLUDED.severity, message=EXCLUDED.message, evidence_json=EXCLUDED.evidence_json, document_id=EXCLUDED.document_id
         RETURNING id`,
        [runId, documentId, url, normalizedUrl, urlHash, issue.code, issue.severity, issue.message, JSON.stringify(issue.evidence || {})]
      );

      const issueId = Number(issueRes.rows[0].id);
      const rec = recommendationForIssue(issue.code, issue.severity, issue.message);

      await client.query(
        `INSERT INTO recommendations (run_id, issue_id, url, code, severity, message, action, impact_score, confidence_score, effort_score, priority_score)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (run_id, issue_id)
         DO UPDATE SET
          url=EXCLUDED.url,
          code=EXCLUDED.code,
          severity=EXCLUDED.severity,
          message=EXCLUDED.message,
          action=EXCLUDED.action,
          impact_score=EXCLUDED.impact_score,
          confidence_score=EXCLUDED.confidence_score,
          effort_score=EXCLUDED.effort_score,
          priority_score=EXCLUDED.priority_score`,
        [
          runId,
          issueId,
          url,
          issue.code,
          issue.severity,
          issue.message,
          rec.action,
          rec.impact_score,
          rec.confidence_score,
          rec.effort_score,
          rec.priority_score,
        ]
      );
    }

    const visual = await saveVisualSnapshot(client, runId, documentId, url, normalizedUrl, urlHash, data.text || '');

    await client.query('COMMIT');
    return {
      documentId,
      normalizedUrl,
      urlHash,
      seoIssueCount: (data.seoIssues || []).length,
      snapshotId: visual.snapshotId,
      diffScore: visual.diffScore,
      changed: visual.changed,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function handleScrape(job: Job) {
  const runId = String(job.id);
  const { url, renderMode = 'auto' } = job.data as any;
  await throttleByHost(url);
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
      await throttleByHost(normalizedCurrent);
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
      const retry = classifyRetryability(err);
      await db.query(
        `UPDATE crawl_runs SET status='failed', error=$2, updated_at=NOW() WHERE id=$1`,
        [runId, `${retry.code}:${String(err?.message || err)}`]
      );
      if (!retry.retryable) {
        throw new UnrecoverableError(`${retry.code}:${String(err?.message || err)}`);
      }
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
  await verifySchema();
  console.log('PageBlaze worker started');
})();
