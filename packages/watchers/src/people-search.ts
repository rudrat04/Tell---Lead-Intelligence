/**
 * People search through a search provider's own index (Exa "people" category).
 * We read the provider's structured results (name, work history, profile URL); we never request LinkedIn or any page.
 * Free tier: $10 credit/month (~$0.007 per search); callers cache results and cap searches per run.
 */

export interface PeopleRole { title: string; company: string; current: boolean }
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
    .map((w) => ({ title: w.title!.trim(), company: w.company!.name!.trim(), current: !w.dates?.to }));
  return { name: (person.name ?? r.title ?? "").trim() || null, url: r.url, roles };
}

export const exaPeopleSearch = (apiKey = process.env.EXA_API_KEY): PeopleSearch => ({
  async search(query, num = 5) {
    if (!apiKey) throw new Error("EXA_API_KEY is not set");
    const res = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: { "x-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({ query, category: "people", type: "auto", numResults: num }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Exa search ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { results?: ExaResult[] };
    return (j.results ?? []).map(parseExaPerson).filter((x): x is PeopleHit => !!x);
  },
});
