import { parse as parseDomain } from "tldts";
import type { Pack } from "@tell/config";

/** Domain lists from the pack's domains.yaml. */
export interface DomainLists {
  neverCompany: Set<string>;
  freeMail: Set<string>;
  shorteners: Set<string>;
}

export function domainLists(d: Pack["domains"]): DomainLists {
  const set = (xs: string[]) => new Set(xs.map((x) => x.toLowerCase()));
  return { neverCompany: set(d.never_company), freeMail: set(d.free_mail), shorteners: set(d.shorteners) };
}

/**
 * Registrable domain ("eTLD+1") for a URL, host or email domain.
 * Private suffixes are on, so acme.github.io and foo.github.io stay separate accounts.
 */
export function registrableDomain(input: string): string | null {
  let host = input.trim().toLowerCase();
  if (!host) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(host)) host = "http://" + host;
  const p = parseDomain(host, { allowPrivateDomains: true });
  if (!p.domain || p.isIp || !p.publicSuffix) return null;
  return p.domain.replace(/\.$/, "");
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'()\]]+/gi;
// bare domains like "acme.com" or "www.acme.io/pricing" (not inside an email address)
const BARE_RE = /(?<![@\w.-])(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})(?:\/[^\s<>"'()\]]*)?/gi;
const EMAIL_RE = /\b[a-z0-9._%+-]+@([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})\b/gi;

export interface Candidate {
  domain: string;
  via: "url" | "bare" | "email";
  /** the original URL when via=url (needed to expand shorteners) */
  url?: string;
}

/** Every company-domain candidate mentioned in a text, before filtering. */
export function rawCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];
  for (const m of text.matchAll(EMAIL_RE)) {
    const d = registrableDomain(m[1]!);
    if (d) out.push({ domain: d, via: "email" });
  }
  const withoutEmails = text.replace(EMAIL_RE, " ");
  for (const m of withoutEmails.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;:!?]+$/, "");
    const d = registrableDomain(url);
    if (d) out.push({ domain: d, via: "url", url });
  }
  const withoutUrls = withoutEmails.replace(URL_RE, " ");
  for (const m of withoutUrls.matchAll(BARE_RE)) {
    const d = registrableDomain(m[1]!);
    // a bare token like "node.js" or "next.js" parses as a domain; require a real ICANN-style TLD length and no file-ish suffix
    if (d && !/\.(js|ts|py|md|json|yaml|yml|txt|png|jpg|pdf)$/.test(d)) out.push({ domain: d, via: "bare" });
  }
  return out;
}

/** Drop tool/platform/free-mail domains; shorteners are kept aside for expansion. */
export function filterCandidates(cands: Candidate[], lists: DomainLists): { company: Candidate[]; shortened: Candidate[] } {
  const company: Candidate[] = [];
  const shortened: Candidate[] = [];
  const seen = new Set<string>();
  for (const c of cands) {
    if (lists.shorteners.has(c.domain)) { if (c.url) shortened.push(c); continue; }
    if (lists.neverCompany.has(c.domain) || lists.freeMail.has(c.domain)) continue;
    if (seen.has(c.domain)) continue;
    seen.add(c.domain);
    company.push(c);
  }
  return { company, shortened };
}

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");

/** Does a company name plausibly belong to a domain? ("Acme Labs" ~ acmelabs.com, getacme.io, acme.ai) */
export function nameMatchesDomain(name: string, domain: string): boolean {
  const label = norm(domain.split(".")[0] ?? "");
  const n = norm(name.replace(/\b(inc|llc|ltd|limited|gmbh|corp|co|hq|labs?|technologies|tech|ai|io|app)\b\.?/gi, ""));
  const full = norm(name);
  if (label.length < 3 || (n.length < 3 && full.length < 3)) return false;
  return [n, full].some((x) => x.length >= 3 && (label.includes(x) || x.includes(label)));
}

/**
 * Pick the company domain from filtered candidates. Never "first link wins":
 * - company name known: exactly one candidate must match it (a lone link to some other site,
 *   e.g. a job page on a recruiting tool, is not the company);
 * - no name: only an unambiguous single candidate.
 */
export function chooseDomain(company: Candidate[], companyName: string | null): { domain: string; via: Candidate["via"] } | null {
  if (company.length === 0) return null;
  if (companyName) {
    const matches = company.filter((c) => nameMatchesDomain(companyName, c.domain));
    return matches.length === 1 ? { domain: matches[0]!.domain, via: matches[0]!.via } : null;
  }
  return company.length === 1 ? { domain: company[0]!.domain, via: company[0]!.via } : null;
}
