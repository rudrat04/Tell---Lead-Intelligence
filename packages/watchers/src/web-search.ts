import { RawItemSchema, type RawItem, type Watcher } from "./types.js";
import { tavilySearch, tavilyToSearchHits } from "./tavily.js";

/**
 * Web search as a source: public posts asking for help (LinkedIn, X, forums) found through a search API, so no
 * site is crawled. Only the search result's title + snippet is used; linkedin.com / x.com pages are never fetched
 * (their terms and robots.txt forbid it). Provider: Serper (Google results), SERPER_API_KEY.
 *
 * Searches cost credits, so a persisted daily budget caps them (counted before each request) and the pack's
 * queries rotate across days.
 */

export interface SearchHit { title: string; link: string; snippet: string; date?: string }

export interface SearchBudget {
  /** searches already made today (IST) */
  used(): Promise<number>;
  /** record n searches (called before the request, so a failed request still counts) */
  add(n: number): Promise<void>;
}

export interface WebSearchOpts {
  queries: string[];
  perDay: number;
  perTick: number;
  /** Google `tbs` recency: d | w | m */
  timeRange: "d" | "w" | "m";
  country: string;
  /** Google country codes to rotate through, one per search; empty = `country` every time */
  countries?: string[];
  maxAgeDays: number;
  budget: SearchBudget;
  search?: (q: string, country: string) => Promise<SearchHit[]>;
  now?: () => Date;
}

/** Which queries this tick runs: rotate by day so a long list is covered over several days. */
export function pickQueries(queries: string[], perDay: number, used: number, perTick: number, now: Date): string[] {
  if (!queries.length) return [];
  const n = Math.max(0, Math.min(perTick, perDay - used));
  const day = Math.floor(now.getTime() / 86_400_000);
  const start = day * perDay + used;
  // never repeat a query within one day, even when perDay > queries.length
  const out: string[] = [];
  for (let i = 0; i < n && used + i < Math.min(perDay, queries.length); i++) out.push(queries[(start + i) % queries.length]!);
  return out;
}

/** "3 days ago", "1 week ago", "Nov 10, 2026" -> Date; null when unknown. */
export function parseHitDate(s: string | undefined, now: Date): Date | null {
  if (!s) return null;
  const rel = /^(\d+)\s+(minute|hour|day|week|month)s?\s+ago$/i.exec(s.trim());
  if (rel) {
    const ms = { minute: 60e3, hour: 3600e3, day: 86_400e3, week: 7 * 86_400e3, month: 30 * 86_400e3 }[rel[2]!.toLowerCase() as "day"];
    return new Date(now.getTime() - Number(rel[1]) * ms);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The author handle a post URL carries, and its platform. LinkedIn: /posts/<vanity>_..., X: /<handle>/status/<id>. */
export function postAuthor(link: string): { platform: string; handle: string } | null {
  let u: URL;
  try { u = new URL(link); } catch { return null; }
  const host = u.hostname.replace(/^(www|[a-z]{2})\./, "");
  if (host === "linkedin.com") {
    const m = /^\/posts\/([A-Za-z0-9-]+)_/.exec(u.pathname);
    return m ? { platform: "linkedin", handle: m[1]! } : null;
  }
  if (host === "x.com" || host === "twitter.com") {
    const m = /^\/([A-Za-z0-9_]{1,15})\/status\/\d+/.exec(u.pathname);
    return m ? { platform: "x", handle: m[1]! } : null;
  }
  return null;
}

/** One URL per post: LinkedIn country hosts (in., uk.) and twitter.com fold into linkedin.com / x.com; query, hash
 *  and trailing slash dropped (tracking params differ between searches). Used as both the id and the evidence URL. */
export function canonicalUrl(link: string): string | null {
  let u: URL;
  try { u = new URL(link); } catch { return null; }
  let host = u.hostname.toLowerCase().replace(/^www\./, "");
  if (/(^|\.)linkedin\.com$/.test(host)) host = "www.linkedin.com";
  else if (/(^|\.)(twitter|x)\.com$/.test(host)) host = "x.com";
  return `https://${host}${u.pathname.replace(/\/+$/, "")}`;
}

/** Id for a hit: the canonical URL without the scheme. */
export const hitId = (link: string) => (canonicalUrl(link) ?? link).replace(/^https:\/\//, "").replace(/^www\./, "");

export function hitsToItems(hits: SearchHit[], query: string, now: Date, maxAgeDays: number): RawItem[] {
  const out: RawItem[] = [];
  for (const h of hits) {
    if (!h.link || !(h.snippet || h.title)) continue;
    const posted = parseHitDate(h.date, now);
    if (posted && now.getTime() - posted.getTime() > maxAgeDays * 86_400_000) continue;
    const url = canonicalUrl(h.link);
    if (!url) continue;
    const author = postAuthor(url);
    const parsed = RawItemSchema.safeParse({
      sourceId: "web_search",
      externalId: hitId(url),
      url,
      title: h.title || undefined,
      text: [h.title, h.snippet].filter(Boolean).join("\n\n"),
      author: author?.handle,
      postedAt: posted ?? undefined,
      meta: { query, ...(author ? { platform: author.platform } : {}) },
    });
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

export function serperSearch(opts: { apiKey: string; timeRange: string; country: string }) {
  return async (q: string, country = opts.country): Promise<SearchHit[]> => {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "x-api-key": opts.apiKey, "content-type": "application/json" },
      // free Serper accounts reject more than 10 results per search
      body: JSON.stringify({ q, num: 10, gl: country, hl: "en", tbs: `qdr:${opts.timeRange}` }),
      signal: AbortSignal.timeout(30_000),
    }).catch((e: unknown) => e as Error);
    if (res instanceof Error || !res.ok) {
      // Serper out of credits / refused: the same search on Tavily, in Serper's shape
      const fb = await tavilySearch({ query: q, topic: "general", timeRange: opts.timeRange, gl: country });
      if (fb) return tavilyToSearchHits(fb);
      throw res instanceof Error ? res : new Error(`serper -> ${res.status}`);
    }
    const j = (await res.json()) as { organic?: SearchHit[] };
    return j.organic ?? [];
  };
}

/** The country for the n-th search of the day: rotates through `countries`, shifted by day so every query meets every
 *  country over time (a query always running in the same country would never find the others). Exported for tests. */
export function countryFor(o: Pick<WebSearchOpts, "country" | "countries" | "perDay">, nthToday: number, now: Date): string {
  const cs = o.countries?.length ? o.countries : [o.country];
  const day = Math.floor(now.getTime() / 86_400_000);
  return cs[(day + nthToday) % cs.length]!;
}

export function makeWebSearch(o: WebSearchOpts): Watcher {
  return {
    id: "web_search",
    async fetch() {
      const now = (o.now ?? (() => new Date()))();
      const used = await o.budget.used();
      const qs = pickQueries(o.queries, o.perDay, used, o.perTick, now);
      const search = o.search ?? serperSearch({ apiKey: process.env.SERPER_API_KEY ?? "", timeRange: o.timeRange, country: o.country });
      const out: RawItem[] = [];
      for (const [i, q] of qs.entries()) {
        await o.budget.add(1);
        out.push(...hitsToItems(await search(q, countryFor(o, used + i, now)), q, now, o.maxAgeDays));
      }
      return [...new Map(out.map((i) => [i.externalId, i])).values()];
    },
  };
}
