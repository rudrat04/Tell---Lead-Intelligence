/**
 * People search through a search provider's own index (Exa "people" category).
 * We read the provider's structured results (name, work history, profile URL); we never request LinkedIn or any page.
 * Free tier: $10 credit/month (~$0.007 per search); callers cache results and cap searches per run.
 */

export interface PeopleRole { title: string; company: string; current: boolean; from?: string | null; to?: string | null }
export interface PeopleHit { name: string | null; url: string; roles: PeopleRole[] }
export interface PeopleSearch { search(query: string, num?: number): Promise<PeopleHit[]> }

interface ExaWork { title?: string | null; company?: { name?: string | null } | null; dates?: { from?: string | null; to?: string | null } | null }
interface ExaResult { title?: string | null; url?: string; entities?: { type?: string; properties?: { name?: string | null; workHistory?: ExaWork[] } }[] }

/** Structured person result -> name + roles (current = no end date). Exported for tests. */
export function parseExaPerson(r: ExaResult): PeopleHit | null {
  if (!r.url) return null;
  const person = (r.entities ?? []).find((e) => e.type === "person")?.properties;
  if (!person) return null;
  const roles = (person.workHistory ?? [])
    .filter((w) => w.title && w.company?.name)
    .map((w) => ({ title: w.title!.trim(), company: w.company!.name!.trim(), current: !w.dates?.to, from: w.dates?.from ?? null, to: w.dates?.to ?? null }));
  return { name: (person.name ?? r.title ?? "").trim() || null, url: r.url, roles };
}

/** Exa refuses a key with these when its credits are spent, it is rate limited or revoked */
const EXA_REFUSED = new Set([401, 402, 403, 429]);
/**
 * One Exa search request. When the key is refused and EXA_API_KEY_2 is set, the very same request is sent once with the
 * second key, so the answer (and everything parsed from it) is what the first key would have returned. Exported for tests.
 */
export async function exaRequest(body: Record<string, unknown>, apiKey: string, fetcher: typeof fetch = fetch, second = process.env.EXA_API_KEY_2): Promise<Response> {
  const go = (k: string) => fetcher("https://api.exa.ai/search", { method: "POST", headers: { "x-api-key": k, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const res = await go(apiKey);
  return !res.ok && EXA_REFUSED.has(res.status) && second && second !== apiKey ? go(second) : res;
}

export const exaPeopleSearch = (apiKey = process.env.EXA_API_KEY): PeopleSearch => ({
  async search(query, num = 5) {
    if (!apiKey) throw new Error("EXA_API_KEY is not set");
    const res = await exaRequest({ query, category: "people", type: "auto", numResults: num }, apiKey);
    if (!res.ok) throw new Error(`Exa search ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { results?: ExaResult[] };
    return (j.results ?? []).map(parseExaPerson).filter((x): x is PeopleHit => !!x);
  },
});

/** A company record from Exa's company index (headcount, description, website). */
export interface CompanyHit { name: string; url: string; employees: number | null; description: string; country: string | null }

/** Parse Exa company results. Exported for tests. */
export function parseExaCompanies(j: unknown): CompanyHit[] {
  const results = (j as { results?: unknown[] } | null)?.results ?? [];
  return results.flatMap((x) => {
    const r = x as { url?: string; title?: string; entities?: { type?: string; properties?: { name?: string; description?: string; workforce?: { total?: number | null }; headquarters?: { country?: string | null } } }[] };
    const p = (r.entities ?? []).find((e) => e.type === "company")?.properties;
    if (!r.url || !p) return [];
    const total = p.workforce?.total;
    return [{ name: p.name ?? r.title ?? "", url: r.url, employees: typeof total === "number" && total > 0 ? total : null, description: (p.description ?? "").slice(0, 1500), country: p.headquarters?.country ?? null }];
  });
}

/** Exa company search for a domain (~1 search credit). The caller must check the result's website is that domain. */
export async function exaCompanySearch(domain: string, apiKey = process.env.EXA_API_KEY, numResults = 3): Promise<CompanyHit[]> {
  if (!apiKey) throw new Error("EXA_API_KEY is not set");
  const res = await exaRequest({ query: domain, category: "company", type: "auto", numResults }, apiKey);
  if (!res.ok) throw new Error(`Exa company search ${res.status}`);
  return parseExaCompanies(await res.json());
}
