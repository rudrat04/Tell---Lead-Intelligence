/**
 * People search through a search provider's own index (Exa "people" category).
 * We read the provider's results (name, headline, profile URL); we never request LinkedIn or any profile page.
 * Free tier: $10 credit/month (~1,400 searches); callers cache results and cap searches per run.
 */

export interface PeopleHit { title: string; url: string; text?: string | null }

export interface PeopleSearch { search(query: string, num?: number): Promise<PeopleHit[]> }

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
    const j = (await res.json()) as { results?: { title?: string | null; url?: string; text?: string | null }[] };
    return (j.results ?? []).filter((r) => r.title && r.url).map((r) => ({ title: r.title!, url: r.url!, text: r.text ?? null }));
  },
});

/**
 * Parse a profile headline like "Jane Doe - Head of Marketing at Acme | LinkedIn" or "Jane Doe – CMO – Acme".
 * Returns null when the shape isn't recognisable (nothing is guessed).
 */
export function parseProfileTitle(title: string): { name: string; headline: string } | null {
  const clean = title.replace(/\s*[|·]\s*LinkedIn.*$/i, "").replace(/\s+/g, " ").trim();
  const parts = clean.split(/\s+[-–—|]\s+/);
  if (parts.length < 2) return null;
  const name = parts[0]!.trim();
  // a person's name: 2-4 words, letters (incl. accents), no digits or company-ish words
  if (!/^[\p{L}][\p{L}'.-]*(\s+[\p{L}][\p{L}'.-]*){1,3}$/u.test(name)) return null;
  return { name, headline: parts.slice(1).join(" - ").trim() };
}
