import { userAgent } from "./identity.js";
import { fetchMxHosts } from "./mail.js";

/**
 * Infrastructure signals (plan 5c), for accounts already tracked only.
 *
 * Subdomains come from Certificate Transparency via SSLMate's Cert Spotter API (crt.sh's robots.txt disallows all
 * bots, so it isn't used). The unauthenticated tier allows about 10 lookups an hour; CERTSPOTTER_API_KEY raises it.
 *
 * Lookalike sending domains ("tryacme.com") are checked over DNS-over-HTTPS and accepted only with ownership proof:
 * the lookalike's website must redirect to the account's own domain. A random similar domain is never a lead.
 */

/** Subdomains of `domain` seen in certificates, lowercased, without wildcards. Null when the lookup failed. */
export async function fetchCtSubdomains(domain: string, timeoutMs = 20_000): Promise<string[] | null> {
  try {
    const res = await fetch(`https://api.certspotter.com/v1/issuances?domain=${encodeURIComponent(domain)}&include_subdomains=true&expand=dns_names`, {
      headers: { "user-agent": userAgent(), ...(process.env.CERTSPOTTER_API_KEY ? { authorization: `Bearer ${process.env.CERTSPOTTER_API_KEY}` } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const items = (await res.json()) as { dns_names?: string[] }[];
    const d = domain.toLowerCase();
    const subs = new Set<string>();
    for (const it of items) for (const n of it.dns_names ?? []) {
      const name = n.toLowerCase().replace(/^\*\./, "");
      if (name.endsWith(`.${d}`)) subs.add(name.slice(0, -(d.length + 1)));
    }
    return [...subs].sort();
  } catch {
    return null;
  }
}

/** Prefixes that mean a GTM motion (marketing pages, demos, partner programme, live customers). Exported for tests. */
export const GTM_SUBDOMAIN = /^(go|lp|info|hs|pages|marketing|learn|events|webinar|demo|get|try|partners?|affiliates?|status|community|academy)$/;

/** First-label subdomains newly seen since the last check that match a GTM prefix. Exported for tests. */
export function newGtmSubdomains(prev: string[], cur: string[]): string[] {
  const before = new Set(prev.map((s) => s.split(".").pop()!));
  return [...new Set(cur.map((s) => s.split(".").pop()!))].filter((s) => GTM_SUBDOMAIN.test(s) && !before.has(s));
}

/** Lookalike names a team would register for cold email. Exported for tests. */
export function lookalikeCandidates(domain: string): string[] {
  const [label, ...rest] = domain.toLowerCase().split(".");
  if (!label || label.length < 3) return [];
  const tld = rest.join(".");
  const names = new Set<string>();
  for (const p of ["try", "get", "use", "join", "hey", "meet", "go"]) names.add(`${p}${label}.com`);
  for (const s of ["hq", "app", "team", "mail"]) names.add(`${label}${s}.com`);
  if (tld !== "com") names.add(`${label}.com`);
  for (const t of ["io", "co", "ai"]) if (t !== tld) names.add(`${label}.${t}`);
  return [...names].filter((n) => n !== domain);
}

/** Registrable host a site lands on after redirects (lowercased, no www), or null. */
async function landsOn(domain: string, timeoutMs: number): Promise<string | null> {
  try {
    const r = await fetch(`https://${domain}/`, { redirect: "follow", headers: { "user-agent": userAgent() }, signal: AbortSignal.timeout(timeoutMs) });
    await r.body?.cancel();
    return new URL(r.url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Proven lookalike sending domains: the candidate receives mail (MX) and its website redirects to the account's own
 * domain. Returns the proven names. Each candidate costs one DNS query, plus one fetch if it has MX.
 */
export async function provenLookalikes(domain: string, timeoutMs = 8_000): Promise<string[]> {
  const out: string[] = [];
  for (const c of lookalikeCandidates(domain)) {
    const mx = await fetchMxHosts(c, timeoutMs);
    if (!mx?.length) continue;
    const land = await landsOn(c, timeoutMs);
    if (land && (land === domain || land.endsWith(`.${domain}`))) out.push(c);
  }
  return out;
}
