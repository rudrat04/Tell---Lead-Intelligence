import { userAgent } from "./identity.js";

/**
 * Common Crawl URL index (index.commoncrawl.org, CDX API): which URLs on a host pattern were crawled.
 * Used to list ATS tenants (acme.keka.com) that host-only APIs can't enumerate. The index server is
 * slow and often returns 504: one request at a time, page by page, with retries and backoff.
 */
const BASE = "https://index.commoncrawl.org";

export interface CcOptions { retries?: number; backoffMs?: number; maxPages?: number; fetchImpl?: typeof fetch }

async function getText(url: string, o: CcOptions): Promise<string | null> {
  const f = o.fetchImpl ?? fetch;
  for (let attempt = 0; attempt <= (o.retries ?? 4); attempt++) {
    try {
      const r = await f(url, { headers: { "user-agent": userAgent() }, signal: AbortSignal.timeout(90_000) });
      if (r.ok) return await r.text();
      if (r.status === 404) return ""; // no captures for this pattern
    } catch { /* timeout / reset: retry */ }
    if (attempt < (o.retries ?? 4)) await new Promise((res) => setTimeout(res, (o.backoffMs ?? 15_000) * (attempt + 1)));
  }
  return null;
}

/** Newest crawl id, e.g. CC-MAIN-2026-43. */
export async function ccLatestIndex(o: CcOptions = {}): Promise<string> {
  const t = await getText(`${BASE}/collinfo.json`, o);
  if (!t) throw new Error("common crawl collinfo unavailable");
  const id = (JSON.parse(t) as { id: string }[])[0]?.id;
  if (!id) throw new Error("common crawl collinfo empty");
  return id;
}

/** Every crawled URL (status 200) matching a pattern like `*.keka.com`. `complete` is false when a page failed. */
export async function ccUrls(index: string, pattern: string, o: CcOptions = {}): Promise<{ urls: string[]; complete: boolean }> {
  const q = `${BASE}/${index}-index?url=${encodeURIComponent(pattern)}&output=json&fl=url&filter=status:200`;
  const info = await getText(`${q}&showNumPages=true`, o);
  if (info == null) return { urls: [], complete: false };
  let pages = 1;
  try { pages = Math.max(1, (JSON.parse(info) as { pages: number }).pages); } catch { /* single page */ }
  const urls: string[] = [];
  let complete = true;
  for (let p = 0; p < Math.min(pages, o.maxPages ?? 20); p++) {
    const t = await getText(`${q}&page=${p}`, o);
    if (t == null) { complete = false; continue; }
    for (const line of t.split("\n")) {
      try { const u = (JSON.parse(line) as { url?: string }).url; if (u) urls.push(u); } catch { /* skip */ }
    }
  }
  if (pages > (o.maxPages ?? 20)) complete = false;
  return { urls, complete };
}

/** Vendor subdomains that are not customer tenants. */
const NOT_TENANTS = new Set(["www", "app", "api", "help", "support", "developers", "developer", "docs", "blog", "status", "community", "academy", "careers", "jobs", "partners", "login", "signup", "demo", "cdn", "static", "assets", "mail", "events", "learn", "go", "info", "dbox", "web"]);

/** Tenant labels from crawled URLs on `<tenant>.<suffix>`, e.g. tenantsFromUrls(urls, "keka.com"). */
export function tenantsFromUrls(urls: string[], suffix: string): string[] {
  const out = new Set<string>();
  const tail = `.${suffix}`;
  for (const u of urls) {
    let host: string;
    try { host = new URL(u).hostname.toLowerCase(); } catch { continue; }
    if (!host.endsWith(tail)) continue;
    const label = host.slice(0, -tail.length);
    if (!label || label.includes(".") || NOT_TENANTS.has(label) || !/^[a-z0-9][a-z0-9-]*$/.test(label)) continue;
    out.add(label);
  }
  return [...out].sort();
}
