import { tavilySearch } from "./tavily.js";
/**
 * Email finder and verifier APIs, used only on today's leads (never in bulk):
 *   QuickEmailVerification  QUICKEMAILVERIFICATION_API_KEY, 100 free a day: is this address deliverable?
 *   Hunter                  HUNTER_API_KEY, 50 free credits a month: a person's address from name + domain
 *   Prospeo                 PROSPEO_API_KEY, ~75 free a month: Enrich Person, verified emails only (the old
 *                           /email-finder was removed and answered 400 DEPRECATED)
 *   web search              SERPER_API_KEY (Tavily when it fails): the quoted name + "@domain" in public pages
 *   InboxTrue               INBOXTRUE_API_KEY, the second verifier: only when QuickEmailVerification gives no verdict
 *                           (no key, cap spent, unknown, catch-all); single checks stay free at a lower rate limit
 *   Apollo                  APOLLO_API_KEY, people/match (1 credit when it returns an email): the last finder; the free
 *                           plan answers 403 (not included), so it only helps on a paid plan
 * No SMTP probing of our own: these services answer from their own checks.
 */
export interface Verification { result: "valid" | "invalid" | "unknown"; acceptAll: boolean; disposable: boolean }
export interface Found { address: string; score: number | null; verified: boolean }

/** QuickEmailVerification response -> verdict (pure; exported for tests). */
export function parseQev(j: unknown): Verification | null {
  const r = j as { success?: string; result?: string; accept_all?: string; disposable?: string } | null;
  if (!r || r.success === "false" || !r.result) return null;
  const result = r.result === "valid" ? "valid" : r.result === "invalid" ? "invalid" : "unknown";
  return { result, acceptAll: r.accept_all === "true", disposable: r.disposable === "true" };
}
export async function verifyEmail(address: string, key = process.env.QUICKEMAILVERIFICATION_API_KEY): Promise<Verification | null> {
  if (!key) return null;
  const res = await fetch(`https://api.quickemailverification.com/v1/verify?email=${encodeURIComponent(address)}&apikey=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) return null;
  return parseQev(await res.json());
}

/** Hunter email-finder response (pure; exported for tests). */
export function parseHunter(j: unknown): Found | null {
  const d = (j as { data?: { email?: string | null; score?: number | null; verification?: { status?: string | null } } } | null)?.data;
  return d?.email ? { address: d.email.toLowerCase(), score: d.score ?? null, verified: d.verification?.status === "valid" } : null;
}
export async function hunterFind(first: string, last: string, domain: string, key = process.env.HUNTER_API_KEY): Promise<Found | null> {
  if (!key) return null;
  const q = new URLSearchParams({ domain, first_name: first, last_name: last, api_key: key });
  const res = await fetch(`https://api.hunter.io/v2/email-finder?${q}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) return null;
  return parseHunter(await res.json());
}

/** Prospeo Enrich Person response (pure; exported for tests). The old /email-finder endpoint was removed (it answers
 *  400 DEPRECATED). With only_verified_email a match is VERIFIED; an unrevealed (masked) address is no answer. The
 *  company's website comes back too, which is how a signal-side contact found by LinkedIn gets its domain. */
export function parseProspeo(j: unknown): (Found & { domain: string | null }) | null {
  const r = j as { error?: boolean; person?: { email?: { email?: string | null; status?: string | null; revealed?: boolean } | null } | null; company?: { website?: string | null; domain?: string | null } | null } | null;
  if (!r || r.error) return null;
  const e = r.person?.email;
  const address = e?.email?.toLowerCase().trim() ?? "";
  if (!address.includes("@") || address.includes("*") || e?.revealed === false) return null;
  const site = (r.company?.domain ?? r.company?.website ?? "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "") || null;
  return { address, score: null, verified: /^verified$/i.test(e?.status ?? ""), domain: site };
}
/** Prospeo Enrich Person (1 credit only when an email is found): by name + company website, or by LinkedIn profile. */
export async function prospeoFind(first: string, last: string, domain: string, key = process.env.PROSPEO_API_KEY, opts: { linkedin?: string | null; fetcher?: typeof fetch } = {}): Promise<(Found & { domain: string | null }) | null> {
  if (!key) return null;
  const data = opts.linkedin ? { linkedin_url: opts.linkedin } : { first_name: first, last_name: last, company_website: domain };
  const res = await (opts.fetcher ?? fetch)("https://api.prospeo.io/enrich-person", { method: "POST", headers: { "X-KEY": key, "content-type": "application/json" },
    body: JSON.stringify({ only_verified_email: true, enrich_mobile: false, data }), signal: AbortSignal.timeout(30_000) });
  // 400 NO_MATCH = nobody, or no verified email: no answer (and no charge)
  if (!res.ok) return null;
  return parseProspeo(await res.json());
}

/** Addresses on `domain` that public web pages show next to a person's name (Serper, Tavily when Serper fails): the
 *  query is the quoted name plus "@domain"; only addresses on that domain are kept, from titles and snippets (we never
 *  fetch the pages). Exported for tests through `addressesInHits`. */
export function addressesInHits(hits: { title?: string; snippet?: string; content?: string; link?: string; url?: string }[], domain: string): { address: string; url: string }[] {
  const d = domain.toLowerCase().replace(/\./g, "\\.");
  const rx = new RegExp(`[a-z0-9][a-z0-9._+-]{0,63}@${d}\\b`, "gi");
  const out: { address: string; url: string }[] = [];
  for (const h of hits) for (const m of `${h.title ?? ""} ${h.snippet ?? h.content ?? ""}`.matchAll(rx)) {
    const address = m[0].toLowerCase().replace(/\.+$/, "");
    if (!out.some((o) => o.address === address)) out.push({ address, url: h.link ?? h.url ?? "" });
  }
  return out;
}
export async function webEmailSearch(fullName: string, domain: string, key = process.env.SERPER_API_KEY): Promise<{ address: string; url: string }[]> {
  const q = `"${fullName.replace(/"/g, "")}" "@${domain}"`;
  const res = key ? await fetch("https://google.serper.dev/search", { method: "POST", headers: { "x-api-key": key, "content-type": "application/json" }, body: JSON.stringify({ q, num: 10 }), signal: AbortSignal.timeout(30_000) }).catch(() => null) : null;
  if (res?.ok) return addressesInHits(((await res.json()) as { organic?: { title?: string; snippet?: string; link?: string }[] }).organic ?? [], domain);
  const fb = await tavilySearch({ query: q, topic: "general" }).catch(() => null);
  return fb ? addressesInHits(fb, domain) : [];
}

/** InboxTrue single-address validation -> the same verdict QuickEmailVerification gives (pure; exported for tests).
 *  valid = valid; invalid / malformed = invalid; ambiguous, maybe_valid, greylisted, temp/perm errors = unknown (no
 *  verdict). Catch-all and disposable are flags of their own, as with QEV. */
export function parseInboxTrue(j: unknown): Verification | null {
  const r = j as { validity?: string; is_domain_catchall?: boolean | null; is_disposable?: boolean } | null;
  if (!r || typeof r.validity !== "string") return null;
  const result = r.validity === "valid" ? "valid" : r.validity === "invalid" || r.validity === "malformed" ? "invalid" : "unknown";
  return { result, acceptAll: r.is_domain_catchall === true, disposable: r.is_disposable === true };
}
export async function inboxTrueVerify(address: string, key = process.env.INBOXTRUE_API_KEY, fetcher: typeof fetch = fetch): Promise<Verification | null> {
  if (!key) return null;
  const q = new URLSearchParams({ email: address, timeout: "30" });
  const res = await fetcher(`https://api.inboxtrue.com/v1/email/validate?${q}`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(45_000) });
  if (!res.ok) return null;
  return parseInboxTrue(await res.json());
}

/** Apollo people/match -> an address (pure; exported for tests). Apollo answers locked addresses with a placeholder
 *  ("email_not_unlocked@domain.com"): those, and any address not at the company's own domain, are no answer. */
export function parseApollo(j: unknown, domain: string): Found | null {
  const p = (j as { person?: { email?: string | null; email_status?: string | null } | null } | null)?.person;
  const email = p?.email?.toLowerCase().trim();
  if (!email || /not_unlocked/.test(email)) return null;
  const at = email.split("@")[1] ?? "", d = domain.toLowerCase().replace(/^www\./, "");
  if (at !== d && !at.endsWith(`.${d}`)) return null;
  return { address: email, score: null, verified: p?.email_status === "verified" };
}
export async function apolloFind(first: string, last: string, domain: string, key = process.env.APOLLO_API_KEY, fetcher: typeof fetch = fetch): Promise<Found | null> {
  if (!key) return null;
  const q = new URLSearchParams({ first_name: first, last_name: last, domain, reveal_personal_emails: "false" });
  const res = await fetcher(`https://api.apollo.io/api/v1/people/match?${q}`, { method: "POST", headers: { "x-api-key": key, "content-type": "application/json", accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) return null;
  return parseApollo(await res.json(), domain);
}
