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
  /** other known people matching your personas at this account (shown under "Also reach") */
  others?: { persona: string; person: Person }[];
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
  const named = new Set([contact?.persona, ...(contact?.others ?? []).map((o) => o.persona)].filter(Boolean));
  return personas
    .filter((p) => !(p.size_bands.length && sizeBand && !p.size_bands.includes(sizeBand)))
    .filter((p) => !named.has(p.title))
    .map((p) => {
      const term = p.search ?? p.title.split("/")[0]!.trim();
      return { persona: p.title, url: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(`${term} ${company}`)}` };
    });
}

const normCo = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]+/g, " ").replace(/\b(inc|llc|ltd|limited|gmbh|corp|co|hq|labs?|technologies|tech|ai|io|app)\b/g, " ").replace(/\s+/g, " ").trim();

/**
 * Accept a people-search hit only if it is clearly this persona at this company *now* (never guess):
 * one of the person's current roles (no end date) is at this company and its title matches the persona.
 * People who have left the company are rejected even if their old title matches.
 */
export function acceptPeopleHit(
  hit: { name: string | null; url: string; roles: { title: string; company: string; current: boolean }[] },
  company: string, domain: string, patterns: RegExp[],
): Person | null {
  if (!hit.name || !/^[\p{L}][\p{L}'.() -]{1,60}$/u.test(hit.name)) return null;
  const co = normCo(company);
  const label = domain.split(".")[0]!.toLowerCase();
  const sameCompany = (name: string) => {
    const n = normCo(name);
    return (co.length >= 3 && n === co) || (label.length >= 4 && n.replace(/ /g, "") === label);
  };
  const role = hit.roles.find((r) => r.current && sameCompany(r.company) && patterns.some((p) => p.test(r.title)));
  if (!role) return null;
  const linkedin = /linkedin\.com\/in\//i.test(hit.url) ? hit.url : null;
  return { name: hit.name, role: `${role.title} at ${role.company}`.slice(0, 120), linkedin, twitter: null, source: "exa", sourceUrl: hit.url };
}
