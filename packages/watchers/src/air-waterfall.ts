/**
 * Air Waterfall (the operator's own people-lookup and email-waterfall service, github.com/rudrat04/air-waterfall):
 *   POST /people/discover  people at a domain, filtered by job titles (company site, Brave, Serper, PDL, Tomba, Hunter;
 *                          free sources first; reads search titles/snippets only, never fetches LinkedIn)
 *   POST /enrich           one person's work email through a free-first waterfall (published addresses, pattern guess,
 *                          mailbox check, then Hunter / Prospeo / Tomba, which bill only on a find), with a verdict
 * Auth: `x-api-key`. Configured by AIR_WATERFALL_URL + AIR_WATERFALL_API_KEY; absent = off. The hosted free instance
 * sleeps when idle, so the first call gets a long timeout.
 */
export interface WaterfallPerson { firstName: string; lastName: string; title: string; source: string; sourceUrl: string | null; nameShared: boolean }
export type WaterfallVerdict = "valid" | "likely" | "risky" | "invalid" | "not_found";
export interface WaterfallEmail { email: string | null; verdict: WaterfallVerdict; confidence: number; catchAll: boolean | null; foundAt: string | null; cached: boolean; credits: number }

export interface AirWaterfall {
  discover(domain: string, titles: string[]): Promise<WaterfallPerson[]>;
  enrich(p: { firstName: string; lastName: string; domain: string; role?: string | null }): Promise<WaterfallEmail>;
}

const VERDICTS = new Set<WaterfallVerdict>(["valid", "likely", "risky", "invalid", "not_found"]);

/** Parse a /people/discover response. Exported for tests. */
export function parseDiscover(j: unknown): WaterfallPerson[] {
  const people = (j as { people?: unknown[] } | null)?.people;
  if (!Array.isArray(people)) return [];
  return people.flatMap((x) => {
    const r = x as { first_name?: unknown; last_name?: unknown; title?: unknown; source?: unknown; source_url?: unknown; name_shared?: unknown };
    if (typeof r.first_name !== "string" || !r.first_name.trim()) return [];
    return [{
      firstName: r.first_name.trim(), lastName: typeof r.last_name === "string" ? r.last_name.trim() : "", title: typeof r.title === "string" ? r.title.trim() : "",
      source: typeof r.source === "string" ? r.source : "air-waterfall", sourceUrl: typeof r.source_url === "string" ? r.source_url : null, nameShared: r.name_shared === true,
    }];
  });
}

/** Parse a /enrich response. Exported for tests. */
export function parseEnrich(j: unknown): WaterfallEmail {
  const r = (j ?? {}) as { email?: unknown; verdict?: unknown; confidence?: unknown; catch_all?: unknown; found_at?: unknown; cached?: unknown; cost?: { credits?: unknown } };
  const verdict = VERDICTS.has(r.verdict as WaterfallVerdict) ? (r.verdict as WaterfallVerdict) : "not_found";
  const email = typeof r.email === "string" && r.email.includes("@") ? r.email.trim().toLowerCase() : null;
  return {
    email, verdict: email || verdict === "invalid" ? verdict : "not_found", confidence: typeof r.confidence === "number" ? r.confidence : 0,
    catchAll: typeof r.catch_all === "boolean" ? r.catch_all : null, foundAt: typeof r.found_at === "string" ? r.found_at : null,
    cached: r.cached === true, credits: typeof r.cost?.credits === "number" ? r.cost.credits : 0,
  };
}

export function airWaterfall(opts: { url?: string; apiKey?: string } = {}): AirWaterfall | null {
  const base = (opts.url ?? process.env.AIR_WATERFALL_URL ?? "").replace(/\/+$/, "");
  const key = opts.apiKey ?? process.env.AIR_WATERFALL_API_KEY ?? "";
  if (!base || !key) return null;
  let warm = false;
  const post = async (path: string, body: unknown): Promise<unknown> => {
    // a sleeping free instance takes about a minute to wake: the first call waits longer
    const res = await fetch(`${base}${path}`, {
      method: "POST", headers: { "x-api-key": key, "content-type": "application/json" }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(warm ? 90_000 : 150_000),
    });
    warm = true;
    if (!res.ok) throw new Error(`air-waterfall ${path} -> HTTP ${res.status}`);
    return res.json();
  };
  return {
    async discover(domain, titles) {
      return parseDiscover(await post("/people/discover", { domain, titles: titles.slice(0, 10).map((t) => t.slice(0, 60)) }));
    },
    async enrich(p) {
      return parseEnrich(await post("/enrich", { first_name: p.firstName, last_name: p.lastName, domain: p.domain, role: p.role ?? undefined, priority: "high" }));
    },
  };
}
