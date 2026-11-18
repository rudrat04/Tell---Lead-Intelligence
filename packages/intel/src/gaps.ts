/**
 * Need check (roles.yaml `gaps`): which of the role groups you fill nobody at the company holds today. Pure: the
 * people come from people search (current roles at this company only). Nobody in a group = the pitch ("Missing: GTM").
 * "No one found" is a strong hint, not proof; the digest says so.
 */

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Loose title match: "Founder's Office" also matches "Founders Office" and "founder’s office"; spaces and dashes are
 * interchangeable; whole words only.
 */
export function rolePattern(titles: string[]): RegExp {
  const parts = titles.map((r) =>
    escapeRe(r.toLowerCase().replace(/[’`]/g, "'"))
      .replace(/s'/g, "s['’]?")
      .replace(/'s\b/g, "['’]?s['’]?")
      .replace(/[\s-]+/g, "[\\s-]+"),
  );
  return new RegExp(`(?<![\\w])(?:${parts.join("|")})(?![\\w])`, "i");
}

/** [[a1, a2], [b1]] -> [a1, b1, a2]: a search cut short still covers every group's main titles. */
export const interleave = <T>(lists: T[][]): T[] =>
  Array.from({ length: Math.max(0, ...lists.map((l) => l.length)) }, (_, i) => lists.flatMap((l) => (i < l.length ? [l[i]!] : []))).flat();

export interface GapVerdict {
  /** groups nobody holds, in the pack's order */
  missing: string[];
  /** who holds the others (first holder per group) */
  has: { group: string; name: string; role: string }[];
}

export function gapVerdict(groups: Record<string, string[]>, people: { name: string; role: string | null }[]): GapVerdict {
  const missing: string[] = [];
  const has: GapVerdict["has"] = [];
  for (const [group, titles] of Object.entries(groups)) {
    const rx = rolePattern(titles);
    const holder = people.find((p) => p.role && rx.test(p.role));
    if (holder) has.push({ group, name: holder.name, role: holder.role! });
    else missing.push(group);
  }
  return { missing, has };
}

/** The evidence quote: "Missing: GTM, Product Marketing · has Founder's Office: Asha Rao (Chief of Staff at Acme)". */
export function gapQuote(v: GapVerdict): string {
  const has = v.has.map((h) => `${h.group}: ${h.name} (${h.role})`).join("; ");
  return `Missing: ${v.missing.join(", ")}${has ? ` · has ${has}` : ""}`;
}
