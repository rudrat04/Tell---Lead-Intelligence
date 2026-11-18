/**
 * Funding news: "X raises $Y" headlines from a news search API (Serper news, Google News results). Only the headline,
 * link, date and outlet are read; articles are never fetched. (Google News RSS is not used: its robots.txt disallows
 * every path but the home page, and blocks AI crawlers by name.) The company name comes from the headline; its
 * website is proven separately (company search: name and domain must both match) before it becomes an account.
 */

export interface NewsItem { title: string; url: string; postedAt: Date | null; outlet?: string }

/** A company named in a funding headline (newest story per company). */
export interface FundedCompany { name: string; headline: string; url: string; postedAt: Date | null }

const VERBS = /\s+(?:raises?|raised|bags|secures?|secured|closes|closed|lands|gets|announces|picks up|nets|mops up)\b/i;

/** Words that describe a company rather than name it: "Bengaluru-based fintech startup Acme". */
const DESCRIPTOR =
  /^(?:startups?|start-ups?|brands?|company|companies|firm|platform|marketplace|unicorn|maker|player|provider|app|venture|label|fintech|edtech|healthtech|agritech|insurtech|proptech|deeptech|spacetech|cleantech|climatetech|legaltech|martech|foodtech|traveltech|logistics|saas|d2c|dtc|b2b|b2c|ecommerce|e-commerce|[\w-]+-(?:based|backed|focused|led|first|owned)|[\w-]+['’]s)$/i;

/** Names too common to search for without drowning in other companies. */
const GENERIC = new Set(["india", "indian", "the", "this", "startup", "exclusive", "funding", "report", "news", "tech", "ai"]);

/**
 * The company a funding headline is about: the words before the funding verb, after the last descriptor
 * ("Child-care startup Nestly raises..." -> "Nestly"; "From rafting to trekking: Trailkit raises..." -> "Trailkit").
 * Null when no plausible name is found.
 */
export function companyFromHeadline(title: string): string | null {
  const m = title.match(new RegExp(`^(.*?)${VERBS.source}`, "i"));
  if (!m) return null;
  // anything before a colon is a lead-in ("Exclusive:", "From X to Y:")
  const before = m[1]!.split(/:\s+/).pop()!.replace(/^\[[^\]]*\]\s*/, "").trim();
  const words = before.split(/\s+/).filter(Boolean);
  let start = 0;
  words.forEach((w, i) => { if (DESCRIPTOR.test(w.replace(/,+$/, ""))) start = i + 1; });
  // lower-case words left over are a description, not a name ("rafting app Acme")
  let name = words.slice(start);
  for (let i = name.length - 1; i >= 0; i--) {
    // "altX" and "mistQ" are names despite the lower-case start
    if (/^[a-z]/.test(name[i]!) && !/^[a-z]+[A-Z]/.test(name[i]!)) { name = name.slice(i + 1); break; }
  }
  const joined = name.join(" ")
    .replace(/[’']s$/i, "")
    .replace(/\.(?:com|in|ai|io|co|app)$/i, "")
    .replace(/^[^\w]+|[^\w)]+$/g, "")
    .trim();
  if (joined.length < 3 || name.length > 4 || GENERIC.has(joined.toLowerCase())) return null;
  return joined;
}

/** "Acme Pay", "ACME PAY" and "Acme-Pay" are one company. */
export const companyKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Headlines that announce a round (pack keywords) and aren't roundups or investors' own funds (pack exclude). */
export function isFundingHeadline(title: string, keywords: string[], exclude: string[]): boolean {
  const kw = keywords.length ? new RegExp(`(?:${keywords.join("|")})`, "i") : null;
  const ex = exclude.length ? new RegExp(`(?<![\\w])(?:${exclude.join("|")})(?![\\w])`, "i") : null;
  return (!kw || kw.test(title)) && !(ex?.test(title));
}

/** One entry per company, newest story first (several outlets report the same round). */
export function companiesFromNews(items: NewsItem[]): FundedCompany[] {
  const byKey = new Map<string, FundedCompany>();
  const sorted = [...items].sort((a, b) => (b.postedAt?.getTime() ?? 0) - (a.postedAt?.getTime() ?? 0));
  for (const item of sorted) {
    const name = companyFromHeadline(item.title);
    if (!name) continue;
    const key = companyKey(name);
    if (!byKey.has(key)) byKey.set(key, { name, headline: item.title, url: item.url, postedAt: item.postedAt });
  }
  return [...byKey.values()];
}

/** "3 days ago", "1 week ago", "Nov 10, 2026" -> Date; null when unknown. */
export function newsDate(s: string | undefined, now: Date): Date | null {
  if (!s) return null;
  const rel = s.match(/^(\d+)\s+(minute|hour|day|week|month)s?\s+ago$/i);
  if (rel) {
    const unit = { minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000 }[rel[2]!.toLowerCase() as "day"];
    return new Date(now.getTime() - Number(rel[1]) * unit);
  }
  const t = Date.parse(s);
  return Number.isFinite(t) && t <= now.getTime() ? new Date(t) : null;
}

/** Serper news search (SERPER_API_KEY). One credit per call. */
export function serperNews(opts: { apiKey: string; country: string; timeRange: "d" | "w" | "m"; now?: () => Date }) {
  return async (q: string): Promise<NewsItem[]> => {
    const res = await fetch("https://google.serper.dev/news", {
      method: "POST",
      headers: { "x-api-key": opts.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ q, num: 10, gl: opts.country, hl: "en", tbs: `qdr:${opts.timeRange}` }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`serper news -> ${res.status}`);
    const j = (await res.json()) as { news?: { title?: string; link?: string; date?: string; source?: string }[] };
    const now = opts.now?.() ?? new Date();
    return (j.news ?? []).flatMap((n) => (n.title && n.link ? [{ title: n.title, url: n.link, postedAt: newsDate(n.date, now), outlet: n.source }] : []));
  };
}
