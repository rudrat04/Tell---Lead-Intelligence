/**
 * Tavily search (TAVILY_API_KEY, 1,000 free credits a month, 1 credit per basic search): the fallback when a Serper call
 * fails (out of credits, rate limited, key refused). Its results are mapped into the exact shapes Serper's callers read
 * (SearchHit, NewsItem, CompanyHit), so everything downstream (parsers, gates, matchCompany, caps) runs unchanged: the
 * callers' own daily caps count the Serper attempt, so a fallback never adds calls on top of them.
 * Differences to know: Tavily's `country` only boosts (and only for topic "general"), so news isn't geo-filtered; there is
 * no outlet name, so the outlet is the site's host; snippets are cut to Google's ~300 characters.
 */
import type { SearchHit } from "./web-search.js";
import type { NewsItem } from "./funding-news.js";
import type { CompanyHit } from "./people-search.js";

export interface TavilyResult { title?: string; url?: string; content?: string; published_date?: string | null }

/** Serper's two-letter `gl` -> Tavily's country name (the ones the packs use; anything else = no country boost). */
const COUNTRY: Record<string, string> = {
  in: "india", us: "united states", gb: "united kingdom", uk: "united kingdom", ca: "canada", au: "australia", sg: "singapore",
  ae: "united arab emirates", de: "germany", fr: "france", nl: "netherlands", ie: "ireland", nz: "new zealand", za: "south africa",
};
export const tavilyCountry = (gl: string | undefined) => (gl ? COUNTRY[gl.toLowerCase()] : undefined);
/** Serper's qdr letter (d / w / m / y) is Tavily's short time_range form */
const RANGE = new Set(["d", "w", "m", "y"]);

/** Google snippets run ~300 characters; Tavily's content is longer. Cut at a word so the gates see what Serper gave. */
const snip = (s: string | undefined, n = 300) => { const t = (s ?? "").replace(/\s+/g, " ").trim(); return t.length <= n ? t : `${t.slice(0, n).replace(/\s+\S*$/, "")}...`; };
const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return undefined; } };

/** Tavily results as Serper organic hits (pure; exported for tests). */
export function tavilyToSearchHits(rs: TavilyResult[]): SearchHit[] {
  return rs.flatMap((r) => (r.title && r.url ? [{ title: r.title, link: r.url, snippet: snip(r.content), ...(r.published_date ? { date: r.published_date } : {}) }] : []));
}
/** Tavily news results as Serper news items (pure; exported for tests). A date in the future or unreadable = no date. */
export function tavilyToNews(rs: TavilyResult[], now: Date): NewsItem[] {
  return rs.flatMap((r) => {
    if (!r.title || !r.url) return [];
    const t = r.published_date ? Date.parse(r.published_date) : NaN;
    return [{ title: r.title, url: r.url, postedAt: Number.isFinite(t) && t <= now.getTime() ? new Date(t) : null, outlet: host(r.url) }];
  });
}
/** Tavily results as company candidates, like serperOrganic's (pure; exported for tests). `name` = the title's brand part. */
export function tavilyToCompanyHits(rs: TavilyResult[], titleName: (t: string) => string): CompanyHit[] {
  return rs.slice(0, 6).flatMap((r) => (r.url && r.title ? [{ name: titleName(r.title), url: r.url, employees: null, description: snip(r.content), country: null }] : []));
}

/** A news query with its country named, unless it already names it (pure; exported for tests). */
export const newsQueryFor = (q: string, country: string) => (q.toLowerCase().includes(country) ? q : `${q} ${country.replace(/\b\w/g, (c) => c.toUpperCase())}`);

export interface TavilyQuery { query: string; topic?: "general" | "news"; timeRange?: string; gl?: string; maxResults?: number }

/** One basic Tavily search; null without a key or when Tavily fails too (the caller then reports Serper's error). */
export async function tavilySearch(q: TavilyQuery, key = process.env.TAVILY_API_KEY, fetcher: typeof fetch = fetch): Promise<TavilyResult[] | null> {
  if (!key) return null;
  const topic = q.topic ?? "general";
  const named = tavilyCountry(q.gl);
  const country = topic === "general" ? named : undefined;
  // news takes no country: the country's name in the query stands in for Serper's gl (without it, an India search came
  // back with US stories only)
  const query = topic === "news" && named ? newsQueryFor(q.query, named) : q.query;
  const body = {
    query, topic, search_depth: "basic", max_results: Math.min(q.maxResults ?? 10, 20),
    ...(q.timeRange && RANGE.has(q.timeRange) ? { time_range: q.timeRange } : {}),
    ...(country ? { country } : {}),
    include_published_date: true,
  };
  try {
    const res = await fetcher("https://api.tavily.com/search", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { results?: TavilyResult[] };
    return Array.isArray(j.results) ? j.results : [];
  } catch { return null; }
}
