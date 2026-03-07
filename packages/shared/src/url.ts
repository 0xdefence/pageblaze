import crypto from 'node:crypto';

const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'igshid',
  'mc_cid',
  'mc_eid',
  'ref',
  'ref_src',
  'utm_campaign',
  'utm_content',
  'utm_id',
  'utm_medium',
  'utm_source',
  'utm_term',
]);

export function normalizeUrl(input: string): string {
  const u = new URL(input);

  u.hash = '';
  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase();

  if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) {
    u.port = '';
  }

  const keys = Array.from(u.searchParams.keys());
  for (const key of keys) {
    const k = key.toLowerCase();
    if (k.startsWith('utm_') || TRACKING_PARAMS.has(k)) {
      u.searchParams.delete(key);
    }
  }

  const sorted = Array.from(u.searchParams.entries()).sort(([a], [b]) => a.localeCompare(b));
  u.search = '';
  for (const [k, v] of sorted) u.searchParams.append(k, v);

  u.pathname = u.pathname.replace(/\/+$/, '') || '/';

  return u.toString();
}

export function hashUrl(normalizedUrl: string): string {
  return crypto.createHash('sha256').update(normalizedUrl).digest('hex');
}
