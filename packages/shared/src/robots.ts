export type RobotsPolicy = {
  disallow: string[];
  sitemapUrls: string[];
};

export function parseRobotsTxt(content: string): RobotsPolicy {
  const disallow: string[] = [];
  const sitemapUrls: string[] = [];

  const lines = content.split(/\r?\n/).map((l) => l.trim());
  let inGlobalAgent = false;

  for (const line of lines) {
    if (!line || line.startsWith('#')) continue;
    const [rawKey, ...rest] = line.split(':');
    if (!rawKey || !rest.length) continue;
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(':').trim();

    if (key === 'user-agent') {
      inGlobalAgent = value === '*';
      continue;
    }

    if (key === 'sitemap' && value) {
      sitemapUrls.push(value);
      continue;
    }

    if (inGlobalAgent && key === 'disallow' && value) {
      disallow.push(value);
    }
  }

  return { disallow, sitemapUrls };
}

export function isAllowedByRobots(targetUrl: string, policy: RobotsPolicy): boolean {
  const u = new URL(targetUrl);
  const path = u.pathname || '/';
  for (const rule of policy.disallow) {
    if (!rule || rule === '/') return false;
    if (path.startsWith(rule)) return false;
  }
  return true;
}

export function extractSitemapUrls(xml: string, max = 5000): string[] {
  const out: string[] = [];
  const re = /<loc>(.*?)<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) && out.length < max) {
    const v = m[1]?.trim();
    if (v) out.push(v);
  }
  return out;
}
