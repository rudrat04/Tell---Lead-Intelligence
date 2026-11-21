/**
 * Public-record sources for niche industries (pack sources.niche). Every adapter returns records that name a company and
 * carry their own evidence (quote + official URL); numbers in a quote are computed here from the records, never guessed.
 *
 *   openFDA (api.fda.gov, no key; OPENFDA_API_KEY raises 1,000 -> 120,000 requests/day): drug shortages + Drugs@FDA.
 *     Terms: open.fda.gov/terms (public domain data, CC0; no automated-access ban). fda.gov web pages (DMF list) are NOT
 *     fetched: Akamai refuses automated requests.
 *   USASpending (api.usaspending.gov, no key): federal contract awards. Public API meant for programmatic use.
 *   CMS Provider Data (data.cms.gov/provider-data API, no key): Medicare-certified home health agencies and hospices.
 */
import { userAgent } from "./identity.js";

const json = async (url: string, init: RequestInit = {}, tries = 3): Promise<unknown> => {
  for (let i = 0; ; i++) {
    const res = await fetch(url, { ...init, headers: { "user-agent": userAgent(), accept: "application/json", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(45_000) });
    if (res.status === 404) return null; // openFDA: no matches
    if ((res.status === 429 || res.status >= 500) && i < tries - 1) { await new Promise((r) => setTimeout(r, 2000 * (i + 1))); continue; }
    if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`);
    return res.json();
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const title = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

// ------------------------------------------------------------------------------------------------ openFDA

export interface Shortage {
  /** substance as openFDA names it (upper case), the key for Drugs@FDA */
  substance: string;
  /** readable name, e.g. "Methylprednisolone Acetate" */
  name: string;
  /** dosage form families short (injectable, oral, ...) */
  forms: string[];
  /** worst availability across its presentations ("Unavailable" beats "Limited Availability") */
  availability: string;
  /** every presentation listed is at that availability (false = only some are) */
  allSame: boolean;
  /** "Shortage per Manufacturer: Manufacturing Delay"-style text from FDA, when given */
  reason: string | null;
  updatedAt: Date | null;
}

/** Dosage form family: a shortage of an injection is not a shortage of the tablet. Exported for tests. */
export function formFamily(s: string): string {
  const t = s.toLowerCase();
  if (/inject|intraven|intramusc|subcutan|parenteral|infusion|for solution;? ?iv/.test(t)) return "injectable";
  if (/ophthalm|eye/.test(t)) return "ophthalmic";
  if (/inhal|nebul|aerosol/.test(t)) return "inhalation";
  if (/topical|cream|ointment|gel|patch|transderm|lotion/.test(t)) return "topical";
  if (/tablet|capsule|oral|suspension|syrup|elixir|chewable/.test(t)) return "oral";
  return "other";
}

const usDate = (s?: string | null) => {
  const m = s?.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? new Date(`${m[3]}-${m[1]}-${m[2]}T00:00:00Z`) : null;
};

/** Group openFDA shortage records by substance (one record per package NDC). Exported for tests. */
export function parseShortages(results: unknown[], skipAvailability: string[] = ["Available"]): Shortage[] {
  const by = new Map<string, Shortage>();
  for (const x of results) {
    const r = x as { status?: string; availability?: string; generic_name?: string; dosage_form?: string; related_info?: string; shortage_reason?: string; update_date?: string; openfda?: { substance_name?: string[] } };
    if (r.status !== "Current" || !r.availability || skipAvailability.includes(r.availability)) continue;
    const substance = (r.openfda?.substance_name?.[0] ?? r.generic_name?.replace(/\b(injection|tablets?|capsules?|oral|solution|suspension|for injection|usp)\b.*$/i, "") ?? "").trim().toUpperCase();
    if (substance.length < 3) continue;
    const form = formFamily(`${r.dosage_form ?? ""} ${r.generic_name ?? ""}`);
    const reason = r.related_info?.match(/Shortage per Manufacturer:\s*([^;]+)/i)?.[1]?.trim() ?? (r.shortage_reason && r.shortage_reason !== "Other" ? r.shortage_reason : null);
    const prev = by.get(substance);
    const updatedAt = usDate(r.update_date);
    if (!prev) by.set(substance, { substance, name: title(substance), forms: [form], availability: r.availability, allSame: true, reason, updatedAt });
    else {
      if (!prev.forms.includes(form)) prev.forms.push(form);
      if (r.availability !== prev.availability) prev.allSame = false;
      if (r.availability === "Unavailable") prev.availability = "Unavailable";
      prev.reason ??= reason;
      if (updatedAt && (!prev.updatedAt || updatedAt > prev.updatedAt)) prev.updatedAt = updatedAt;
    }
  }
  return [...by.values()];
}

export async function fetchShortages(opts: { apiKey?: string; skipAvailability?: string[] } = {}): Promise<Shortage[]> {
  const key = opts.apiKey ?? process.env.OPENFDA_API_KEY;
  const all: unknown[] = [];
  for (let skip = 0; skip < 5000; skip += 1000) {
    const url = `https://api.fda.gov/drug/shortages.json?search=status:%22Current%22&limit=1000&skip=${skip}${key ? `&api_key=${key}` : ""}`;
    const j = (await json(url)) as { results?: unknown[]; meta?: { results?: { total?: number } } } | null;
    all.push(...(j?.results ?? []));
    if (!j?.results?.length || skip + 1000 >= (j.meta?.results?.total ?? 0)) break;
    await sleep(300);
  }
  return parseShortages(all, opts.skipAvailability);
}

export interface AndaHolder {
  /** ANDA number without the prefix, e.g. "210043" */
  appNo: string;
  /** Drugs@FDA sponsor (often abbreviated: "AMNEAL") */
  sponsor: string;
  /** labeler names from the drug labels, fuller ("Amneal Pharmaceuticals LLC"); empty when no current label */
  labelers: string[];
  /** at least one product in a matching dosage form is marketed (Prescription / Over-the-counter) */
  marketed: boolean;
  url: string;
}

const MARKETED = new Set(["Prescription", "Over-the-counter"]);

/** ANDA holders for a substance in the shortage's dosage forms (pure; exported for tests). */
export function parseAndaHolders(results: unknown[], forms: string[]): AndaHolder[] {
  const out: AndaHolder[] = [];
  for (const x of results) {
    const r = x as { application_number?: string; sponsor_name?: string; openfda?: { manufacturer_name?: string[] }; products?: { dosage_form?: string; route?: string; marketing_status?: string }[] };
    if (!r.application_number?.startsWith("ANDA") || !r.sponsor_name) continue;
    const matching = (r.products ?? []).filter((p) => !forms.length || forms.includes(formFamily(`${p.dosage_form ?? ""} ${p.route ?? ""}`)));
    // tentative approvals can't be sold yet: not a holder
    const real = matching.filter((p) => p.marketing_status && !/tentative/i.test(p.marketing_status));
    if (!real.length) continue;
    const appNo = r.application_number.replace(/^ANDA/, "");
    out.push({
      appNo, sponsor: r.sponsor_name.trim(), labelers: r.openfda?.manufacturer_name ?? [],
      marketed: real.some((p) => MARKETED.has(p.marketing_status!)),
      url: `https://www.accessdata.fda.gov/scripts/cder/daf/index.cfm?event=overview.process&ApplNo=${appNo}`,
    });
  }
  return out;
}

export async function fetchAndaHolders(substance: string, forms: string[], apiKey = process.env.OPENFDA_API_KEY): Promise<AndaHolder[]> {
  const q = `openfda.substance_name:"${substance.replace(/"/g, "")}" AND application_number:ANDA*`;
  const all: unknown[] = [];
  for (let skip = 0; skip < 1000; skip += 100) {
    const j = (await json(`https://api.fda.gov/drug/drugsfda.json?search=${encodeURIComponent(q)}&limit=100&skip=${skip}${apiKey ? `&api_key=${apiKey}` : ""}`)) as { results?: unknown[]; meta?: { results?: { total?: number } } } | null;
    all.push(...(j?.results ?? []));
    if (!j?.results?.length || skip + 100 >= (j.meta?.results?.total ?? 0)) break;
    await sleep(250);
  }
  return parseAndaHolders(all, forms);
}

/** Counted facts for the quote: how many sponsors hold ANDAs for it, how many of them sell it. */
export function holderCounts(holders: AndaHolder[]): { holders: number; marketed: number } {
  const key = (h: AndaHolder) => h.sponsor.toLowerCase().replace(/[^a-z0-9]/g, "");
  const all = new Set(holders.map(key)), sold = new Set(holders.filter((h) => h.marketed).map(key));
  return { holders: all.size, marketed: sold.size };
}

// ------------------------------------------------------------------------------------------------ USASpending

export interface ExpiringAward {
  awardId: string;
  recipient: string;
  amount: number;
  endDate: Date;
  agency: string;
  description: string;
  naics: string;
  state: string | null;
  url: string;
}

/** Awards whose end date falls inside [from, to] (pure; exported for tests). */
export function parseAwards(results: unknown[], naics: string, from: Date, to: Date, minAmount = 0): ExpiringAward[] {
  return results.flatMap((x) => {
    const r = x as Record<string, unknown>;
    const end = typeof r["End Date"] === "string" ? new Date(`${r["End Date"]}T00:00:00Z`) : null;
    const amount = Number(r["Award Amount"] ?? 0);
    if (!end || Number.isNaN(end.getTime()) || end < from || end > to || amount < minAmount) return [];
    const recipient = String(r["Recipient Name"] ?? "").trim();
    const id = String(r.generated_internal_id ?? "");
    if (!recipient || !id || /^multiple recipients$/i.test(recipient)) return [];
    return [{
      awardId: String(r["Award ID"] ?? id), recipient, amount, endDate: end, agency: String(r["Awarding Agency"] ?? "").trim(),
      description: String(r.Description ?? "").replace(/\s+/g, " ").trim().slice(0, 200), naics,
      state: (r["Place of Performance State Code"] as string | null) ?? null, url: `https://www.usaspending.gov/award/${encodeURIComponent(id)}`,
    }];
  });
}

/**
 * Contracts in one NAICS code (and set-asides) ending between `from` and `to`. USASpending can't filter on the end
 * date, so awards with any action in the last two years are read newest end date first, page by page, until end dates fall
 * before the window.
 */
export async function fetchExpiringAwards(opts: { naics: string | null; keywords?: string[]; setAsides: string[]; from: Date; to: Date; minAmount: number; maxPages: number; now?: Date }): Promise<ExpiringAward[]> {
  const now = opts.now ?? new Date();
  const start = new Date(now.getTime() - 2 * 365 * 86_400_000).toISOString().slice(0, 10);
  const out: ExpiringAward[] = [];
  for (let page = 1; page <= opts.maxPages; page++) {
    const body = {
      filters: {
        award_type_codes: ["A", "B", "C", "D"], ...(opts.naics ? { naics_codes: [opts.naics] } : {}), ...(opts.keywords?.length ? { keywords: opts.keywords } : {}),
        ...(opts.setAsides.length ? { set_aside_type_codes: opts.setAsides } : {}),
        time_period: [{ start_date: start, end_date: now.toISOString().slice(0, 10) }],
      },
      fields: ["Award ID", "Recipient Name", "Award Amount", "End Date", "Awarding Agency", "Description", "Place of Performance State Code"],
      sort: "End Date", order: "desc", limit: 100, page,
    };
    const j = (await json("https://api.usaspending.gov/api/v2/search/spending_by_award/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })) as
      { results?: Record<string, unknown>[]; page_metadata?: { hasNext?: boolean } } | null;
    const rows = j?.results ?? [];
    out.push(...parseAwards(rows, opts.naics ?? "", opts.from, opts.to, opts.minAmount));
    const last = rows.at(-1)?.["End Date"];
    if (!j?.page_metadata?.hasNext || (typeof last === "string" && new Date(`${last}T00:00:00Z`) < opts.from)) break;
    await sleep(500);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ CMS provider data

export interface NewProvider { kind: "home_health" | "hospice"; ccn: string; name: string; city: string; state: string; certifiedAt: Date; url: string }

const CMS_DATASETS = { home_health: { id: "6jpm-sxkc", name: "provider_name", compare: "home-health" }, hospice: { id: "yc9t-dgbk", name: "facility_name", compare: "hospice" } } as const;

/** Providers certified on or after `since` (pure; exported for tests). */
export function parseProviders(kind: NewProvider["kind"], results: unknown[], since: Date, states: string[] = []): NewProvider[] {
  const ds = CMS_DATASETS[kind];
  return results.flatMap((x) => {
    const r = x as Record<string, string | undefined>;
    const at = usDate(r.certification_date);
    const name = r[ds.name]?.trim(), ccn = r.cms_certification_number_ccn?.trim(), state = r.state?.trim() ?? "";
    if (!at || at < since || !name || !ccn) return [];
    if (states.length && !states.includes(state)) return [];
    return [{ kind, ccn, name: title(name).replace(/\b(Llc|Inc|Lp|Pllc)\b/g, (m) => m.toUpperCase()), city: title(r.citytown ?? ""), state, certifiedAt: at, url: `https://www.medicare.gov/care-compare/details/${ds.compare}/${ccn}` }];
  });
}

export async function fetchNewProviders(kind: NewProvider["kind"], since: Date, states: string[] = []): Promise<NewProvider[]> {
  const ds = CMS_DATASETS[kind];
  const out: NewProvider[] = [];
  for (let offset = 0; offset < 30_000; offset += 1500) {
    const j = (await json(`https://data.cms.gov/provider-data/api/1/datastore/query/${ds.id}/0?limit=1500&offset=${offset}`)) as { results?: unknown[]; count?: number } | null;
    const rows = j?.results ?? [];
    out.push(...parseProviders(kind, rows, since, states));
    if (rows.length < 1500 || offset + 1500 >= (j?.count ?? 0)) break;
    await sleep(500);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ more openFDA

const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
/** "20261015" or "2026-10-15" -> Date */
export const anyDate = (s?: string | null): Date | null => {
  const m = s?.match(/^(\d{4})-?(\d{2})-?(\d{2})/);
  return m ? new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`) : null;
};

export interface DeviceClearance { contact?: string; applicant: string; kNumber: string; device: string; panel: string; country: string; city: string; decidedAt: Date; url: string }

/** 510(k) clearances (substantially equivalent only) in the listed countries (pure; exported for tests). */
export function parseClearances(results: unknown[], countries: string[]): DeviceClearance[] {
  return results.flatMap((x) => {
    const r = x as Record<string, string | undefined>;
    const at = anyDate(r.decision_date);
    if (!r.applicant || !r.k_number || !at || !/^substantially equivalent/i.test((r.decision_description ?? "").trim())) return [];
    if (countries.length && !countries.includes(r.country_code ?? "")) return [];
    return [{ ...(r.contact && /^[A-Za-z.'-]+( [A-Za-z.'-]+){1,3}$/.test(r.contact.trim()) ? { contact: title(r.contact.trim().replace(/^(mr|mrs|ms|dr)\.?\s+/i, "")) } : {}), applicant: r.applicant.trim(), kNumber: r.k_number, device: (r.device_name ?? "").trim(), panel: (r.advisory_committee_description ?? "").trim(), country: r.country_code ?? "", city: title(r.city ?? ""), decidedAt: at,
      url: `https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfpmn/pmn.cfm?ID=${r.k_number}` }];
  });
}

export async function fetchClearances(since: Date, countries: string[], now = new Date(), apiKey = process.env.OPENFDA_API_KEY): Promise<DeviceClearance[]> {
  const all: unknown[] = [];
  const cc = countries.length ? `+AND+(${countries.map((c) => `country_code:${c}`).join("+")})` : "";
  for (let skip = 0; skip < 3000; skip += 1000) {
    const j = (await json(`https://api.fda.gov/device/510k.json?search=decision_date:%5B${ymd(since)}+TO+${ymd(now)}%5D${cc}&limit=1000&skip=${skip}${apiKey ? `&api_key=${apiKey}` : ""}`)) as { results?: unknown[]; meta?: { results?: { total?: number } } } | null;
    all.push(...(j?.results ?? []));
    if (!j?.results?.length || skip + 1000 >= (j.meta?.results?.total ?? 0)) break;
    await sleep(300);
  }
  return parseClearances(all, countries);
}

export interface AndaApproval { appNo: string; sponsor: string; labelers: string[]; ingredient: string; form: string; approvedAt: Date; url: string }

/** Original ANDA approvals dated inside [since, now] (pure; exported for tests). */
export function parseAndaApprovals(results: unknown[], since: Date, now = new Date()): AndaApproval[] {
  return results.flatMap((x) => {
    const r = x as { application_number?: string; sponsor_name?: string; openfda?: { manufacturer_name?: string[] }; submissions?: { submission_type?: string; submission_status?: string; submission_status_date?: string }[]; products?: { active_ingredients?: { name?: string }[]; dosage_form?: string; route?: string }[] };
    if (!r.application_number?.startsWith("ANDA") || !r.sponsor_name) return [];
    const orig = (r.submissions ?? []).find((s) => s.submission_type === "ORIG" && s.submission_status === "AP");
    const at = anyDate(orig?.submission_status_date);
    if (!at || at < since || at > now) return [];
    const p = r.products?.[0];
    const appNo = r.application_number.replace(/^ANDA/, "");
    return [{ appNo, sponsor: r.sponsor_name.trim(), labelers: r.openfda?.manufacturer_name ?? [], ingredient: title((p?.active_ingredients ?? []).map((a) => a.name ?? "").filter(Boolean).join(" + ")),
      form: `${p?.dosage_form ?? ""}`.toLowerCase().replace(/;/g, ", "), approvedAt: at, url: `https://www.accessdata.fda.gov/scripts/cder/daf/index.cfm?event=overview.process&ApplNo=${appNo}` }];
  });
}

export async function fetchAndaApprovals(since: Date, now = new Date(), apiKey = process.env.OPENFDA_API_KEY): Promise<AndaApproval[]> {
  const q = `submissions.submission_status_date:[${ymd(since)} TO ${ymd(now)}] AND submissions.submission_type:ORIG AND application_number:ANDA*`;
  const all: unknown[] = [];
  for (let skip = 0; skip < 1000; skip += 100) {
    const j = (await json(`https://api.fda.gov/drug/drugsfda.json?search=${encodeURIComponent(q)}&limit=100&skip=${skip}${apiKey ? `&api_key=${apiKey}` : ""}`)) as { results?: unknown[]; meta?: { results?: { total?: number } } } | null;
    all.push(...(j?.results ?? []));
    if (!j?.results?.length || skip + 100 >= (j.meta?.results?.total ?? 0)) break;
    await sleep(250);
  }
  return parseAndaApprovals(all, since, now);
}

// ------------------------------------------------------------------------------------------------ USASpending: new awards

export interface NewAward { awardId: string; recipient: string; amount: number; startDate: Date | null; endDate: Date | null; agency: string; description: string; naics: string; url: string }

export function parseNewAwards(results: unknown[], naics: string, minAmount = 0): NewAward[] {
  return results.flatMap((x) => {
    const r = x as Record<string, unknown>;
    const recipient = String(r["Recipient Name"] ?? "").trim(), id = String(r.generated_internal_id ?? ""), amount = Number(r["Award Amount"] ?? 0);
    if (!recipient || !id || amount < minAmount || /^multiple recipients$/i.test(recipient)) return [];
    return [{ awardId: String(r["Award ID"] ?? id), recipient, amount, startDate: anyDate(r["Start Date"] as string), endDate: anyDate(r["End Date"] as string), agency: String(r["Awarding Agency"] ?? "").trim(),
      description: String(r.Description ?? "").replace(/\s+/g, " ").trim(), naics, url: `https://www.usaspending.gov/award/${encodeURIComponent(id)}` }];
  });
}

/** Contracts signed in [since, now] in one NAICS code, or matching keywords in any code (largest first). */
export async function fetchNewAwards(opts: { naics: string | null; keywords?: string[]; setAsides: string[]; since: Date; now?: Date; minAmount: number; maxPages: number }): Promise<NewAward[]> {
  const now = opts.now ?? new Date();
  const out: NewAward[] = [];
  for (let page = 1; page <= opts.maxPages; page++) {
    const body = {
      filters: { award_type_codes: ["A", "B", "C", "D"], ...(opts.naics ? { naics_codes: [opts.naics] } : {}), ...(opts.keywords?.length ? { keywords: opts.keywords } : {}), ...(opts.setAsides.length ? { set_aside_type_codes: opts.setAsides } : {}),
        time_period: [{ start_date: opts.since.toISOString().slice(0, 10), end_date: now.toISOString().slice(0, 10), date_type: "date_signed" }] },
      fields: ["Award ID", "Recipient Name", "Award Amount", "Start Date", "End Date", "Awarding Agency", "Description"],
      sort: "Award Amount", order: "desc", limit: 100, page,
    };
    const j = (await json("https://api.usaspending.gov/api/v2/search/spending_by_award/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })) as { results?: unknown[]; page_metadata?: { hasNext?: boolean } } | null;
    const rows = parseNewAwards(j?.results ?? [], opts.naics ?? "", opts.minAmount);
    out.push(...rows);
    if (!j?.page_metadata?.hasNext || rows.length < (j?.results?.length ?? 0)) break; // sorted by amount: the rest are under the minimum
    await sleep(500);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ Socrata open-data portals

/** Rows from a Socrata dataset (city permits, FMCSA carrier census...). SoQL `where` is the pack's. No key needed;
 *  SOCRATA_APP_TOKEN (free) raises the throttle. */
export async function socrataRows(domain: string, dataset: string, where: string, order: string | undefined, limit: number): Promise<Record<string, unknown>[]> {
  const q = new URLSearchParams({ $where: where, $limit: String(limit), ...(order ? { $order: order } : {}) });
  // SOCRATA_APP_TOKEN alone = an app token (X-App-Token); with SOCRATA_APP_SECRET it's an API key id + secret (basic
  // auth). Credentials the portal rejects fall back to anonymous access (lower throttle, same data).
  const token = process.env.SOCRATA_APP_TOKEN, secret = process.env.SOCRATA_APP_SECRET;
  const auth: Record<string, string> = token && secret ? { authorization: `Basic ${Buffer.from(`${token}:${secret}`).toString("base64")}` } : token ? { "X-App-Token": token } : {};
  const url = `https://${domain}/resource/${dataset}.json?${q}`;
  let res = await fetch(url, { headers: { "user-agent": userAgent(), accept: "application/json", ...auth }, signal: AbortSignal.timeout(60_000) });
  if ((res.status === 401 || res.status === 403) && Object.keys(auth).length) res = await fetch(url, { headers: { "user-agent": userAgent(), accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${domain} ${res.status}`);
  const j = await res.json();
  return Array.isArray(j) ? (j as Record<string, unknown>[]) : [];
}

/** Fill "{field}" / "{field|money}" / "{field|date}" / "{field|title}" placeholders from a row (pure; exported for tests). */
export function fillTemplate(t: string, row: Record<string, unknown>): string {
  return t.replace(/\{([a-z0-9_]+)(?:\|(money|date|title|upper))?\}/gi, (_, f: string, fmt?: string) => {
    const v = row[f];
    const s = v == null ? "" : typeof v === "object" ? String((v as { url?: string }).url ?? "") : String(v).trim();
    if (!s) return "";
    if (fmt === "money") { const n = Number(s); return Number.isFinite(n) ? (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${n}`) : s; }
    if (fmt === "date") { const d = anyDate(s); return d ? d.toISOString().slice(0, 10) : s; }
    if (fmt === "title") return title(s).replace(/\b(Llc|Inc|Lp|Llp|Pllc)\b/g, (m) => m.toUpperCase());
    if (fmt === "upper") return s.toUpperCase();
    return s;
  }).replace(/\s+/g, " ").replace(/\(\s*\)/g, "").trim();
}

// ------------------------------------------------------------------------------------------------ SEC Form D (details)

export interface FormDDetail { executives?: { name: string; role: string }[]; entity: string; city: string; state: string; industry: string; offering: number | null; sold: number | null; filedAt: Date; url: string; amendment: boolean }

const tag = (xml: string, t: string) => xml.match(new RegExp(`<${t}>([^<]*)</${t}>`))?.[1]?.trim() ?? "";

/** primary_doc.xml of a Form D (pure; exported for tests). */
export function parseFormDXml(xml: string, filedAt: Date, url: string): FormDDetail | null {
  const entity = tag(xml, "entityName");
  if (!entity) return null;
  const num = (s: string) => (/^\d+(\.\d+)?$/.test(s) ? Number(s) : null);
  const issuer = xml.match(/<primaryIssuer>[\s\S]*?<\/primaryIssuer>/)?.[0] ?? xml;
  const executives = [...xml.matchAll(/<relatedPersonInfo>([\s\S]*?)<\/relatedPersonInfo>/g)].flatMap((m) => {
    const name = [tag(m[1]!, "firstName"), tag(m[1]!, "lastName")].filter(Boolean).map(title).join(" ");
    const role = [...m[1]!.matchAll(/<relationship>([^<]+)<\/relationship>/g)].map((x) => x[1]!.trim()).join(", ");
    return name.includes(" ") && /executive officer/i.test(role) ? [{ name, role }] : [];
  }).slice(0, 3);
  return {
    executives,
    entity: entity.replace(/\s+/g, " "), city: title(tag(issuer, "city")), state: tag(issuer, "stateOrCountry"), industry: tag(xml, "industryGroupType"),
    offering: num(tag(xml, "totalOfferingAmount")), sold: num(tag(xml, "totalAmountSold")), filedAt, url, amendment: tag(xml, "isAmendment") === "true",
  };
}

/** The filing's primary_doc.xml URL from its EDGAR .txt URL ("edgar/data/123/0001234567-26-000001.txt"). */
export const formDDocUrl = (txtUrl: string) => txtUrl.replace(/\/(\d{10})-(\d{2})-(\d{6})\.txt$/, "/$1$2$3/primary_doc.xml");

export async function fetchFormDDetail(txtUrl: string, filedAt: Date, ua = process.env.SEC_USER_AGENT): Promise<FormDDetail | null> {
  if (!ua) return null;
  const res = await fetch(formDDocUrl(txtUrl), { headers: { "user-agent": ua }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) return null;
  return parseFormDXml(await res.text(), filedAt, txtUrl.replace(/\.txt$/, "-index.htm"));
}
