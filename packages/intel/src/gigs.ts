import { toRegex, type Pack } from "@tell/config";

/**
 * Freelance / contract gigs (pack gigs.yaml). Job ads are exact records, so code rules decide, not an LLM.
 * A gig must: match the offer (title or tags), be contract-like, be open to the user's location, be recent, not expired.
 */

export interface GigPosting {
  source: string;
  externalId: string;
  title: string;
  company?: string | null;
  companyDomain?: string | null;
  url: string;
  applyUrl?: string | null;
  employmentType?: string | null;
  /** free text ("Worldwide", "USA only") or joined country list; empty = no restriction stated */
  location?: string | null;
  tags: string[];
  description?: string | null;
  postedAt?: Date | null;
  expiresAt?: Date | null;
}

export interface GigRules { match: RegExp[]; exclude: RegExp[]; contract: RegExp[]; locations: RegExp[]; maxAgeDays: number }

export function compileGigRules(g: Pack["gigs"]): GigRules {
  return { match: g.match_any.map(toRegex), exclude: g.exclude.map(toRegex), contract: g.contract_any.map(toRegex), locations: g.locations_allowed.map(toRegex), maxAgeDays: g.max_age_days };
}

const any = (rs: RegExp[], s: string) => rs.some((r) => r.test(s));
const DAY = 86_400_000;

export function gigVerdict(p: GigPosting, r: GigRules, now = new Date()): { ok: boolean; reason: string } {
  if (p.expiresAt && p.expiresAt < now) return { ok: false, reason: "expired" };
  if (p.postedAt && now.getTime() - p.postedAt.getTime() > r.maxAgeDays * DAY) return { ok: false, reason: "too old" };
  if (any(r.exclude, p.title)) return { ok: false, reason: "excluded title" };
  const tags = p.tags.join(" ");
  if (!any(r.match, p.title) && !any(r.match, tags)) return { ok: false, reason: "not your kind of work" };
  // An explicit full-time type wins over soft words like "consultant": only an explicit contract word in the title overrides it.
  if (/full[- ]?time|permanent/i.test(p.employmentType ?? "")) {
    if (!/\b(contract(or)?|freelance|fractional|part[- ]time)\b/i.test(p.title)) return { ok: false, reason: "not contract/freelance" };
  } else {
    const contractText = [p.employmentType ?? "", p.title, tags, (p.description ?? "").slice(0, 3000)].join(" \n ");
    if (!any(r.contract, contractText)) return { ok: false, reason: "not contract/freelance" };
  }
  const loc = (p.location ?? "").trim();
  if (loc && !/^(remote|remote only|100% remote)$/i.test(loc) && !any(r.locations, loc)) return { ok: false, reason: "not open to your location" };
  return { ok: true, reason: "gig" };
}

/** Same gig on several boards: normalised company + title. */
export function gigDedupeKey(company: string | null | undefined, title: string): string {
  const n = (s: string) => s.toLowerCase().replace(/\(.*?\)|\[.*?\]/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
  return `${n(company ?? "")}|${n(title)}`;
}
