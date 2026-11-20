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
export async function fetchExpiringAwards(opts: { naics: string; setAsides: string[]; from: Date; to: Date; minAmount: number; maxPages: number; now?: Date }): Promise<ExpiringAward[]> {
  const now = opts.now ?? new Date();
  const start = new Date(now.getTime() - 2 * 365 * 86_400_000).toISOString().slice(0, 10);
  const out: ExpiringAward[] = [];
  for (let page = 1; page <= opts.maxPages; page++) {
    const body = {
      filters: {
        award_type_codes: ["A", "B", "C", "D"], naics_codes: [opts.naics],
        ...(opts.setAsides.length ? { set_aside_type_codes: opts.setAsides } : {}),
        time_period: [{ start_date: start, end_date: now.toISOString().slice(0, 10) }],
      },
      fields: ["Award ID", "Recipient Name", "Award Amount", "End Date", "Awarding Agency", "Description", "Place of Performance State Code"],
      sort: "End Date", order: "desc", limit: 100, page,
    };
    const j = (await json("https://api.usaspending.gov/api/v2/search/spending_by_award/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })) as
      { results?: Record<string, unknown>[]; page_metadata?: { hasNext?: boolean } } | null;
    const rows = j?.results ?? [];
    out.push(...parseAwards(rows, opts.naics, opts.from, opts.to, opts.minAmount));
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
