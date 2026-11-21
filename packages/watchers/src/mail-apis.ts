/**
 * Email finder and verifier APIs, used only on today's leads (never in bulk):
 *   QuickEmailVerification  QUICKEMAILVERIFICATION_API_KEY, 100 free a day: is this address deliverable?
 *   Hunter                  HUNTER_API_KEY, 50 free credits a month: a person's address from name + domain
 *   Prospeo                 PROSPEO_API_KEY, ~75 free a month: the same, as a second try
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

/** Prospeo email-finder response (pure; exported for tests). */
export function parseProspeo(j: unknown): Found | null {
  const r = j as { error?: boolean; response?: { email?: { email?: string; email_status?: string } | string } } | null;
  if (!r || r.error) return null;
  const e = typeof r.response?.email === "string" ? { email: r.response.email } : r.response?.email;
  return e?.email ? { address: e.email.toLowerCase(), score: null, verified: /valid|verified/i.test((e as { email_status?: string }).email_status ?? "") } : null;
}
export async function prospeoFind(first: string, last: string, domain: string, key = process.env.PROSPEO_API_KEY): Promise<Found | null> {
  if (!key) return null;
  const res = await fetch("https://api.prospeo.io/email-finder", { method: "POST", headers: { "X-KEY": key, "content-type": "application/json" }, body: JSON.stringify({ first_name: first, last_name: last, company: domain }), signal: AbortSignal.timeout(30_000) });
  if (!res.ok) return null;
  return parseProspeo(await res.json());
}
