/**
 * Ways to find a company's own website from its name, besides the Exa company index (paid, capped) and Maps:
 *   Wikidata  free (CC0, public API, descriptive user agent asked for): an item's "official website" (P856) and country.
 *             Covers established companies (listed pharma, manufacturers, SME IPO filers that have a page), not new
 *             local businesses.
 *   Serper    Google web results (SERPER_API_KEY, ~$1 per 1,000 searches on a paid plan): the first results' titles and
 *             links, matched like any other candidate. Off unless the pack gives it a daily budget.
 * Both only suggest candidates; the caller's matchCompany() decides (same name, domain carries the name, one domain).
 */
import { userAgent } from "./identity.js";
import type { CompanyHit } from "./people-search.js";

const COUNTRY: Record<string, string> = { Q668: "India", Q30: "United States of America", Q145: "United Kingdom", Q16: "Canada", Q408: "Australia", Q334: "Singapore", Q878: "United Arab Emirates" };

/** Parse wbgetentities into company candidates (pure; exported for tests). Items without an official website are dropped. */
export function parseWikidata(j: unknown): CompanyHit[] {
  const ents = (j as { entities?: Record<string, unknown> } | null)?.entities ?? {};
  return Object.values(ents).flatMap((e) => {
    const x = e as { labels?: { en?: { value?: string } }; descriptions?: { en?: { value?: string } }; claims?: Record<string, { mainsnak?: { datavalue?: { value?: unknown } } }[]> };
    const site = x.claims?.P856?.[0]?.mainsnak?.datavalue?.value;
    const name = x.labels?.en?.value;
    if (typeof site !== "string" || !name) return [];
    const country = (x.claims?.P17?.[0]?.mainsnak?.datavalue?.value as { id?: string } | undefined)?.id;
    const emp = (x.claims?.P1128?.[0]?.mainsnak?.datavalue?.value as { amount?: string } | undefined)?.amount;
    return [{ name, url: site, employees: emp ? Math.abs(Number(emp)) || null : null, description: x.descriptions?.en?.value ?? "", country: country ? COUNTRY[country] ?? country : null }];
  });
}

/** Wikidata items matching a company name, with an official website. Two requests; no key. */
export async function wikidataCompanies(name: string): Promise<CompanyHit[]> {
  const headers = { "user-agent": userAgent(), accept: "application/json" };
  const s = await fetch(`https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=en&type=item&limit=5&search=${encodeURIComponent(name)}`, { headers, signal: AbortSignal.timeout(20_000) });
  if (!s.ok) throw new Error(`wikidata ${s.status}`);
  const ids = (((await s.json()) as { search?: { id?: string }[] }).search ?? []).map((x) => x.id).filter((x): x is string => !!x);
  if (!ids.length) return [];
  const g = await fetch(`https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&languages=en&props=labels|descriptions|claims&ids=${ids.join("|")}`, { headers, signal: AbortSignal.timeout(20_000) });
  if (!g.ok) throw new Error(`wikidata ${g.status}`);
  return parseWikidata(await g.json());
}

/** A web result title as a company name: "Acme Pharma | Generic APIs" -> "Acme Pharma" (pure; exported for tests). */
export const titleName = (t: string) => t.split(/\s[|–—:·-]\s|\s\|\s?/)[0]!.replace(/\b(home|official site|welcome to)\b/gi, "").trim();

/** Google web results via Serper as company candidates (one credit). */
export async function serperOrganic(apiKey: string, query: string, gl: string): Promise<CompanyHit[]> {
  const res = await fetch("https://google.serper.dev/search", { method: "POST", headers: { "x-api-key": apiKey, "content-type": "application/json" }, body: JSON.stringify({ q: query, gl, num: 10 }), signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`serper ${res.status}`);
  const j = (await res.json()) as { organic?: { title?: string; link?: string; snippet?: string }[] };
  return (j.organic ?? []).slice(0, 6).flatMap((o) => (o.link && o.title ? [{ name: titleName(o.title), url: o.link, employees: null, description: o.snippet ?? "", country: null }] : []));
}

// ------------------------------------------------------------------------------------------------ ClinicalTrials.gov

/** A completed industry-sponsored trial: the sponsor is about to commercialize (or decide not to). */
export interface CompletedTrial { nctId: string; title: string; sponsor: string; completedAt: Date; interventions: { type: string; name: string }[]; countries: string[]; phase: string; url: string }

/** Parse ClinicalTrials.gov v2 studies (pure; exported for tests). */
export function parseTrials(j: unknown): CompletedTrial[] {
  const studies = (j as { studies?: unknown[] } | null)?.studies ?? [];
  return studies.flatMap((s) => {
    const p = (s as { protocolSection?: Record<string, any> }).protocolSection ?? {};
    const nctId = p.identificationModule?.nctId as string | undefined, sponsor = p.sponsorCollaboratorsModule?.leadSponsor?.name as string | undefined;
    const date = p.statusModule?.completionDateStruct?.date as string | undefined;
    if (!nctId || !sponsor || !date) return [];
    const completedAt = new Date(date.length === 7 ? `${date}-01` : date);
    if (Number.isNaN(completedAt.getTime())) return [];
    const interventions = ((p.armsInterventionsModule?.interventions ?? []) as { type?: string; name?: string }[]).flatMap((i) => (i.type ? [{ type: i.type, name: (i.name ?? "").trim() }] : []));
    const countries = [...new Set(((p.contactsLocationsModule?.locations ?? []) as { country?: string }[]).map((l) => l.country ?? "").filter(Boolean))];
    return [{ nctId, title: String(p.identificationModule?.briefTitle ?? "").trim(), sponsor: sponsor.trim(), completedAt, interventions, countries,
      phase: ((p.designModule?.phases ?? []) as string[]).join("/"), url: `https://clinicaltrials.gov/study/${nctId}` }];
  });
}

/** Industry-sponsored trials completed since `since` (interventional), newest first, up to `max`. */
export async function fetchCompletedTrials(since: Date, max = 300): Promise<CompletedTrial[]> {
  const out: CompletedTrial[] = [];
  let token: string | undefined;
  const term = `AREA[LeadSponsorClass]INDUSTRY AND AREA[StudyType]INTERVENTIONAL AND AREA[CompletionDate]RANGE[${since.toISOString().slice(0, 10)},MAX]`;
  const fields = "NCTId,BriefTitle,LeadSponsorName,CompletionDate,InterventionType,InterventionName,LocationCountry,Phase";
  while (out.length < max) {
    const q = new URLSearchParams({ "filter.overallStatus": "COMPLETED", "query.term": term, fields, pageSize: "100", sort: "CompletionDate:desc", ...(token ? { pageToken: token } : {}) });
    const res = await fetch(`https://clinicaltrials.gov/api/v2/studies?${q}`, { headers: { "user-agent": userAgent(), accept: "application/json" }, signal: AbortSignal.timeout(45_000) });
    if (!res.ok) throw new Error(`clinicaltrials ${res.status}`);
    const j = (await res.json()) as { nextPageToken?: string };
    out.push(...parseTrials(j));
    token = j.nextPageToken;
    if (!token) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  return out.slice(0, max);
}

/** Industry-sponsored trials matching keywords (a condition, a molecule, a device type), completed or started since
 *  `since`, newest first. */
export async function searchTrials(keywords: string[], since: Date, max = 40): Promise<CompletedTrial[]> {
  if (!keywords.length) return [];
  const words = keywords.slice(0, 4).map((k) => `"${k.replace(/"/g, "")}"`).join(" OR ");
  const term = `(${words}) AND AREA[LeadSponsorClass]INDUSTRY AND AREA[LastUpdatePostDate]RANGE[${since.toISOString().slice(0, 10)},MAX]`;
  const q = new URLSearchParams({ "query.term": term, "filter.overallStatus": "COMPLETED|RECRUITING|ACTIVE_NOT_RECRUITING", fields: "NCTId,BriefTitle,LeadSponsorName,CompletionDate,InterventionType,InterventionName,LocationCountry,Phase", pageSize: String(Math.min(max, 100)), sort: "LastUpdatePostDate:desc" });
  const res = await fetch(`https://clinicaltrials.gov/api/v2/studies?${q}`, { headers: { "user-agent": userAgent(), accept: "application/json" }, signal: AbortSignal.timeout(45_000) });
  if (!res.ok) throw new Error(`clinicaltrials ${res.status}`);
  return parseTrials(await res.json()).slice(0, max);
}
