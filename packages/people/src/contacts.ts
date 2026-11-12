import { toRegex, type Pack } from "@tell/config";

/** A known person at an account (from sources that carry identity by design, plan 9a). */
export interface Person {
  name: string;
  role: string | null;
  linkedin?: string | null;
  twitter?: string | null;
  source: string;
  sourceUrl?: string | null;
}

export interface Contact {
  person: Person;
  /** the pack persona this person matched, or null when we fell back to the best available person */
  persona: string | null;
  /** why this person (shown in the digest) */
  note: string;
}

/** Within a persona, prefer the commercial lead: CEO > founder > technical founder. */
function seniority(role: string | null): number {
  const r = role ?? "";
  let s = 0;
  if (/\b(ceo|chief executive)\b/i.test(r)) s += 3;
  if (/\b(founder|co-?founder)\b/i.test(r)) s += 1;
  if (/\b(cto|chief technology|technical|engineer(ing)?|scientist)\b/i.test(r)) s -= 2;
  return s;
}

/**
 * Pick who to reach out to at an account, following the pack's personas in order of preference,
 * restricted to personas meant for the account's size band. Falls back to the most senior known person.
 */
export function pickContact(people: Person[], personas: Pack["icp"]["personas"], sizeBand: string | null): Contact | null {
  if (people.length === 0) return null;
  for (const p of personas) {
    if (p.size_bands.length && sizeBand && !p.size_bands.includes(sizeBand)) continue;
    const rx = p.patterns.map(toRegex);
    const matches = people.filter((x) => x.role && rx.some((r) => r.test(x.role!))).sort((a, b) => seniority(b.role) - seniority(a.role));
    if (matches[0]) return { person: matches[0], persona: p.title, note: `${p.title}` };
  }
  const best = [...people].sort((a, b) => seniority(b.role) - seniority(a.role))[0]!;
  return { person: best, persona: null, note: "no listed person matches your personas for this company size; best available" };
}

export const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/**
 * For personas nobody is known for yet: a LinkedIn people-search link you open yourself (nothing is scraped).
 * Only personas meant for this company size, excluding the one the named contact already covers.
 */
export function personaSearchLinks(personas: Pack["icp"]["personas"], sizeBand: string | null, company: string, contact: Contact | null): { persona: string; url: string }[] {
  return personas
    .filter((p) => !(p.size_bands.length && sizeBand && !p.size_bands.includes(sizeBand)))
    .filter((p) => p.title !== contact?.persona)
    .map((p) => {
      const term = p.search ?? p.title.split("/")[0]!.trim();
      return { persona: p.title, url: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(`${term} ${company}`)}` };
    });
}
