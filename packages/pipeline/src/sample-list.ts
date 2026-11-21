import type { Pack } from "@tell/config";
import { fetchAndaHolders, fetchExpiringAwards, socrataRows, fillTemplate, userAgent } from "@tell/watchers";
import { getDb, accounts, signals, eq, and, sql } from "@tell/db";

/**
 * `pnpm freelist <domain>`: the free list a niche email promises, built from the same public data, so a reply can go out
 * in minutes with real names. The list kind comes from the lead's play (`list:`) or its industry; its inputs (the
 * drug, the NAICS code, the state or city) are read from the lead's own evidence quotes. Every row is a public record.
 */
export type ListKind = "federal_buyers" | "anda_holders" | "hospitals" | "permits" | "recompetes";
export interface ListRow { [k: string]: string | number }
export interface SampleList { kind: ListKind; input: string; source: string; rows: ListRow[] }

const DAY = 86_400_000;
const money = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n / 1e3)}K`);

/** What the lead's evidence says the list is about (pure; exported for tests). */
export function listInputs(quotes: string[]): { drug?: string; device?: string; naics?: string; city?: string; state?: string } {
  const all = quotes.join("\n");
  const drug = all.match(/^(.+?) \([a-z, ]+\) is on the FDA drug shortage list/m)?.[1]
    ?? all.match(/^(.+?) is on the FDA drug shortage list/m)?.[1]
    ?? all.match(/ANDA \d+ \(([^,)]+)/)?.[1]
    ?? all.match(/holds ANDA \d+ for ([^.]+?)(?: and markets it)?\./)?.[1];
  const device = all.match(/510\(k\) clearance K\d+ for (.+?) (?:\(|on )/)?.[1];
  const naics = all.match(/NAICS (\d{4,6})/)?.[1];
  const place = all.match(/\(([A-Z][A-Za-z .'-]+), ([A-Z]{2})\)/);
  const city = all.match(/\b(?:in|on a) (Chicago|Austin|Seattle|New Orleans|Baton Rouge)\b/)?.[1] ?? (all.includes("NYC Buildings") ? "New York" : place?.[1]);
  return { ...(drug ? { drug: drug.trim() } : {}), ...(device ? { device: device.trim() } : {}), ...(naics ? { naics } : {}), ...(city ? { city } : {}), ...(place ? { state: place[2] } : {}) };
}

async function post(url: string, body: unknown) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`);
  return res.json() as Promise<{ results?: Record<string, unknown>[] }>;
}

/** Federal contracts naming the product, last 3 years: who buys it (agency) and who supplies it (distributor). */
export async function federalBuyers(term: string, now = new Date()): Promise<ListRow[]> {
  const j = await post("https://api.usaspending.gov/api/v2/search/spending_by_award/", {
    filters: { keywords: [term], award_type_codes: ["A", "B", "C", "D"], time_period: [{ start_date: new Date(now.getTime() - 3 * 365 * DAY).toISOString().slice(0, 10), end_date: now.toISOString().slice(0, 10) }] },
    fields: ["Recipient Name", "Awarding Agency", "Awarding Sub Agency", "Award Amount", "Description", "End Date"], sort: "Award Amount", order: "desc", limit: 100,
  });
  const by = new Map<string, ListRow & { _n: number }>();
  for (const r of j.results ?? []) {
    const k = `${r["Recipient Name"]}|${r["Awarding Sub Agency"] ?? r["Awarding Agency"]}`;
    const p = by.get(k) ?? { supplier: String(r["Recipient Name"]), buyer: String(r["Awarding Sub Agency"] ?? r["Awarding Agency"]), contracts: 0, total: 0, latest: "", example: String(r.Description ?? "").slice(0, 80), _n: 0 };
    p.contracts = Number(p.contracts) + 1; p._n += Number(r["Award Amount"] ?? 0); p.total = money(p._n);
    if (String(r["End Date"] ?? "") > String(p.latest)) p.latest = String(r["End Date"] ?? "");
    by.set(k, p);
  }
  return [...by.values()].sort((a, b) => b._n - a._n).slice(0, 25).map(({ _n, ...r }) => r);
}

/** US companies holding ANDAs for the drug (the API buyers, for an API / DMF maker). */
export async function andaHolders(drug: string): Promise<ListRow[]> {
  const hs = await fetchAndaHolders(drug.toUpperCase(), []);
  const by = new Map<string, ListRow>();
  for (const h of hs) { const name = h.labelers[0] ?? h.sponsor; const p = by.get(name) ?? { company: name, andas: 0, markets_it: "no" }; p.andas = Number(p.andas) + 1; if (h.marketed) p.markets_it = "yes"; by.set(name, p); }
  return [...by.values()].sort((a, b) => Number(b.andas) - Number(a.andas));
}

/** Hospitals in a state (CMS Hospital General Information), the city's first. */
export async function hospitals(state: string, city?: string): Promise<ListRow[]> {
  const url = `https://data.cms.gov/provider-data/api/1/datastore/query/xubh-q36u/0?limit=500&conditions[0][property]=state&conditions[0][value]=${encodeURIComponent(state)}&conditions[0][operator]=%3D`;
  const res = await fetch(url, { headers: { "user-agent": userAgent(), accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`CMS ${res.status}`);
  const rows = ((await res.json()) as { results?: Record<string, string>[] }).results ?? [];
  const c = city?.toUpperCase();
  return rows.map((r) => ({ hospital: r.facility_name ?? "", city: r.citytown ?? "", type: r.hospital_type ?? "", phone: r.telephone_number ?? "", rating: r.hospital_overall_rating ?? "" }))
    .sort((a, b) => Number(b.city === c) - Number(a.city === c)).slice(0, 50);
}

/** Recent large permits in the lead's city, from the pack's own permit dataset for it. */
export async function permits(pack: Pack, city: string, now = new Date()): Promise<ListRow[]> {
  const cfg = pack.sources.niche.socrata.find((x) => x.signal_type === "building_permit" && x.query.toLowerCase().includes(city.toLowerCase()));
  if (!cfg) throw new Error(`no permit dataset for ${city} in the pack`);
  const since = new Date(now.getTime() - 30 * DAY).toISOString().slice(0, 10);
  const rows = await socrataRows(cfg.domain, cfg.dataset, cfg.where.replaceAll("{since}", since).replaceAll("{since_ymd}", since.replace(/-/g, "")), cfg.order, 200);
  return rows.slice(0, 50).map((r) => ({ project: fillTemplate(cfg.quote, { ...r, company: String(r[cfg.company_field ?? ""] ?? "the contractor") }), date: fillTemplate(`{${cfg.date_field}|date}`, r) }));
}

/** Contracts in the NAICS code ending in the next 12 months, with incumbents (the recompete watchlist). */
export async function recompetes(pack: Pack, naics: string, now = new Date()): Promise<ListRow[]> {
  const cfg = pack.sources.niche.usaspending;
  const aw = await fetchExpiringAwards({ naics, setAsides: cfg.set_asides, from: now, to: new Date(now.getTime() + 365 * DAY), minAmount: cfg.min_amount, maxPages: 5, now });
  return aw.sort((a, b) => a.endDate.getTime() - b.endDate.getTime()).slice(0, 50)
    .map((a) => ({ incumbent: a.recipient, agency: a.agency, value: money(a.amount), ends: a.endDate.toISOString().slice(0, 10), what: a.description.slice(0, 80), award: a.url }));
}

/** The list for one lead: kind from its play / industry, inputs from its evidence. */
export async function sampleList(pack: Pack, domain: string, kindOverride?: ListKind, opts: { state?: string } = {}): Promise<SampleList> {
  const db = getDb();
  const [acc] = await db.select().from(accounts).where(eq(accounts.domain, domain)).limit(1);
  if (!acc) throw new Error(`no account for ${domain}`);
  const sig = await db.select({ type: signals.type, quote: signals.evidenceQuote }).from(signals).where(and(eq(signals.accountId, acc.id), sql`coalesce(${signals.lastSeenAt}, ${signals.observedAt}) > now() - interval '180 days'`));
  const playLists = Object.values(pack.plays.plays).filter((p) => p.list && p.requires.some((t) => sig.some((s) => s.type === t))).map((p) => p.list!);
  const industry = acc.segment ? pack.icp.industries[acc.segment] : undefined;
  const kind = (kindOverride ?? [...playLists, industry?.list].find((k) => k && k !== "gtm" && k !== "manual")) as ListKind | undefined;
  if (!kind) throw new Error("this lead's play has no public-data list (manual or GTM review): put it together by hand");
  const inp = { ...listInputs(sig.map((s) => s.quote)), ...(opts.state ? { state: opts.state.toUpperCase() } : {}) };
  const need = (v: string | undefined, what: string) => { if (!v) throw new Error(`the lead's evidence names no ${what} for a ${kind} list`); return v; };
  switch (kind) {
    case "federal_buyers": {
      const t = need(inp.drug ?? inp.device, "drug or device");
      let rows = await federalBuyers(t);
      // "Lidocaine Hydrochloride" is often listed as just "LIDOCAINE": widen to the first word when the full name finds few
      const short = t.split(/\s+/)[0]!;
      if (rows.length < 10 && short.length >= 5 && short !== t) { const wider = await federalBuyers(short); if (wider.length > rows.length) rows = wider; }
      return { kind, input: t, source: "USASpending.gov", rows };
    }
    case "anda_holders": return { kind, input: need(inp.drug, "drug"), source: "FDA Drugs@FDA", rows: await andaHolders(inp.drug!) };
    case "hospitals": return { kind, input: `${inp.city ?? ""} ${need(inp.state, "US state (add --state TX)")}`.trim(), source: "CMS Hospital General Information", rows: await hospitals(inp.state!, inp.city) };
    case "permits": return { kind, input: need(inp.city, "permit city"), source: "city open-data permits", rows: await permits(pack, inp.city!) };
    case "recompetes": return { kind, input: `NAICS ${need(inp.naics, "NAICS code")}`, source: "USASpending.gov", rows: await recompetes(pack, inp.naics!) };
  }
}

export function toCsv(rows: ListRow[]): string {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]!);
  const esc = (v: unknown) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
}

/**
 * A small proof sample for the opening email (the analyst's evidence): the real total and 2-3 rows from the list the
 * lead's free step names, as one quote. The full list stays with you (it's what you show on the call). Null when the
 * lead's evidence lacks the list's inputs or the source returns nothing.
 */
export async function proofSample(pack: Pack, kind: ListKind, quotes: string[], n = 3): Promise<{ quote: string; url: string } | null> {
  const i = listInputs(quotes);
  const top = <T>(xs: T[]) => xs.slice(0, n);
  switch (kind) {
    case "federal_buyers": {
      const t = i.drug ?? i.device; if (!t) return null;
      let rows = await federalBuyers(t); const short = t.split(/\s+/)[0]!;
      if (rows.length < 10 && short.length >= 5 && short !== t) { const w = await federalBuyers(short); if (w.length > rows.length) rows = w; }
      if (!rows.length) return null;
      return { quote: `Public contract data (USASpending, last 3 years): ${rows.length} buyer and supplier pairs for ${t}. For example: ${top(rows).map((r) => `${r.buyer} buying through ${r.supplier} (${r.contracts} contracts, latest ${r.latest})`).join("; ")}.`, url: "https://www.usaspending.gov/search" };
    }
    case "anda_holders": {
      if (!i.drug) return null; const rows = await andaHolders(i.drug); if (!rows.length) return null;
      return { quote: `FDA records: ${rows.length} companies hold ANDAs for ${i.drug}. For example: ${top(rows).map((r) => `${r.company} (${r.andas} ANDAs, ${r.markets_it === "yes" ? "markets it" : "not marketed"})`).join("; ")}.`, url: "https://www.accessdata.fda.gov/scripts/cder/daf/" };
    }
    case "hospitals": {
      if (!i.state) return null; const rows = await hospitals(i.state, i.city); if (!rows.length) return null;
      return { quote: `CMS records: ${rows.length} hospitals listed in ${i.state}. For example: ${top(rows).map((r) => `${r.hospital} (${r.city}, ${r.type})`).join("; ")}.`, url: "https://data.cms.gov/provider-data/" };
    }
    case "permits": {
      if (!i.city) return null; const rows = await permits(pack, i.city); if (!rows.length) return null;
      return { quote: `City permit records, last 30 days in ${i.city}: ${rows.length} large permitted projects. For example: ${top(rows).map((r) => String(r.project)).join(" ")}`, url: "https://www.usaspending.gov/" };
    }
    case "recompetes": {
      if (!i.naics) return null; const rows = await recompetes(pack, i.naics); if (!rows.length) return null;
      return { quote: `USASpending: at least ${rows.length} contracts in NAICS ${i.naics} end in the next 12 months. For example: ${top(rows).map((r) => `${r.incumbent}, ${r.agency}, ${r.value}, ends ${r.ends}`).join("; ")}.`, url: "https://www.usaspending.gov/search" };
    }
  }
}
