import type { Pack } from "@tell/config";
import {
  fetchShortages, fetchAndaHolders, holderCounts, fetchExpiringAwards, fetchNewProviders, exaCompanySearch, companyKey, isSourceEnabled,
  type Shortage, type AndaHolder, type ExpiringAward, type NewProvider, type CompanyHit,
} from "@tell/watchers";
import { passesHardFilters, regionInScope } from "@tell/intel";
import { registrableDomain, nameMatchesDomain, checkHomepage, domainLists, type DomainLists } from "@tell/people";
import { getDb, accounts, signals, companySeeds, and, eq, sql } from "@tell/db";
import { applyPackIdentity } from "./scheduled.js";
import { neonUsage, type UsageStore } from "./usage.js";
import { bandForHeadcount } from "./company-facts.js";

/**
 * Niche public-record discovery (pack sources.niche, `pnpm niche`). Each source yields records that name a company and
 * carry their own evidence; the company becomes an account only when a company search proves its website (name and
 * domain both match, a distinctive word of the name in the domain, HQ in an allowed region, homepage loads on the same
 * brand). Numbers in every quote are counted here from the records: drafts may only repeat them, never invent them.
 */

const DAY = 86_400_000;
/** a name that didn't resolve is tried again after this long (Exa indexes new sites; records repeat daily) */
const RETRY_DAYS = 60;

/** One record to turn into account + signal. */
export interface NicheRecord {
  source: string;
  /** company name as the record gives it */
  name: string;
  /** what to search for (name plus context: city, industry) */
  query: string;
  segment: string;
  /** regions the company's HQ may be in */
  regions: string[];
  /** the company description must mention this (keeps a same-name company in another industry out) */
  mustMention?: RegExp;
  signal: { type: string; quote: string; url: string; observedAt: Date };
}

export interface NicheResult { source: string; records: number; companies: number; looked: number; resolved: number; accountsNew: number; signals: number; noMatch: number; notRegion: number; filtered: number; badSite: number; capped: number; errors: number; skipped?: string }

const empty = (source: string): NicheResult => ({ source, records: 0, companies: 0, looked: 0, resolved: 0, accountsNew: 0, signals: 0, noMatch: 0, notRegion: 0, filtered: 0, badSite: 0, capped: 0, errors: 0 });

/** Exa country -> the region names scoring uses ("India", "United States of America"). Exported for tests. */
export function regionName(c: string | null): string | null {
  if (!c) return null;
  const t = c.trim();
  if (/^(in|ind|india|republic of india)$/i.test(t)) return "India";
  if (/^(us|usa|u\.s\.a?\.?|united states( of america)?|america)$/i.test(t)) return "United States of America";
  return t;
}

const GENERIC = new Set(["the", "a", "an", "of", "and", "home", "health", "care", "healthcare", "hospice", "services", "service", "group", "pharma", "pharmaceutical", "pharmaceuticals", "labs", "laboratories", "life", "sciences", "medical", "national", "american", "united", "global", "first", "new", "best", "quality", "general", "federal", "systems", "solutions", "technologies", "consulting", "llc", "inc", "ltd", "limited", "pvt", "private", "corp", "corporation", "company", "co", "usa", "india"]);
const words = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
/** the first word of a name that tells it apart ("Sunrise" in "Sunrise Home Health LLC"); null when every word is generic */
export const distinctive = (name: string) => words(name).find((w) => w.length >= 3 && !GENERIC.has(w)) ?? null;
const key = (s: string) => words(s).filter((w) => !GENERIC.has(w) || w === "home" || w === "health").join(" ");

/**
 * The company record for a public-record name (pure; exported for tests). Stricter than a name search: the hit's name
 * equals the record's (generic words aside) or one starts with the other; the domain carries the name AND its first
 * distinctive word; the description mentions the industry when asked; exactly one domain survives.
 */
export function matchCompany(name: string, hits: CompanyHit[], lists: DomainLists, mustMention?: RegExp): { hit: CompanyHit; domain: string } | null {
  const k = key(name), d = distinctive(name);
  if (!d || k.length < 4) return null;
  const ok = hits.flatMap((h) => {
    const domain = registrableDomain(h.url);
    if (!domain || /linkedin\.com|crunchbase\.com|tracxn\.com|zaubacorp\.com|bloomberg\.com|dnb\.com|zoominfo\.com|opencorporates\.com|medicare\.gov|usaspending\.gov|sam\.gov/i.test(domain)) return [];
    if (lists.neverCompany.has(domain) || lists.freeMail.has(domain)) return [];
    const hk = key(h.name);
    const sameName = hk === k || (hk.length >= 5 && k.length >= 5 && (hk.startsWith(`${k} `) || k.startsWith(`${hk} `) || hk.startsWith(k) || k.startsWith(hk)));
    if (!sameName || !nameMatchesDomain(name, domain) || !domain.split(".")[0]!.replace(/-/g, "").includes(d)) return [];
    if (mustMention && !mustMention.test(`${h.name} ${h.description}`)) return [];
    return [{ hit: h, domain }];
  });
  return new Set(ok.map((x) => x.domain)).size === 1 ? ok[0]! : null;
}

interface Deps { pack: Pack; companies?: (q: string) => Promise<CompanyHit[]>; usage?: UsageStore; now?: Date; homepage?: typeof checkHomepage }

/**
 * Records -> accounts + signals. Company names are looked up once (company_seeds, source `niche:<source>`); a resolved
 * name is reused without a search. Exa searches are capped per source per run (sources.niche.per_run).
 */
export async function persistNicheRecords(records: NicheRecord[], deps: Deps, res: NicheResult): Promise<NicheResult> {
  const { pack } = deps;
  const db = getDb();
  const now = deps.now ?? new Date();
  const usage = deps.usage ?? neonUsage();
  const lists = domainLists(pack.domains);
  const search = deps.companies ?? ((q: string) => exaCompanySearch(q));
  const homepage = deps.homepage ?? checkHomepage;
  const cap = pack.sources.niche.per_run;
  let searches = 0;
  res.records += records.length;

  // one lookup per company name; every record of that name follows the verdict
  const byName = new Map<string, NicheRecord[]>();
  for (const r of records) { const k = companyKey(r.name); if (k) byName.set(k, [...(byName.get(k) ?? []), r]); }
  res.companies += byName.size;
  const seedSource = `niche:${records[0]?.source ?? "x"}`;

  for (const [k, recs] of byName) {
    const r0 = recs[0]!;
    const [seed] = await db.select().from(companySeeds).where(and(eq(companySeeds.source, seedSource), eq(companySeeds.sourceId, k))).limit(1);
    let accountId: string | null = null;
    if (seed?.fitPass && seed.domain) {
      const [a] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.domain, seed.domain)).limit(1);
      accountId = a?.id ?? null;
    }
    if (!accountId) {
      if (seed && !seed.fitPass && seed.siteCheckedAt && now.getTime() - seed.siteCheckedAt.getTime() < RETRY_DAYS * DAY) continue;
      if (searches >= cap) { res.capped++; continue; }
      searches++;
      res.looked++;
      await usage.addSpend("exa_niche", 1, cap * 3);
      const v = await resolve(r0).catch(() => ({ reason: "error" } as Verdict));
      if (v.reason === "no-match") res.noMatch++;
      else if (v.reason === "error") res.errors++;
      else if (v.reason === "not-region") res.notRegion++;
      else if (v.reason === "bad-site") res.badSite++;
      else if (v.reason.startsWith("filtered")) res.filtered++;
      else { res.resolved++; if (v.isNew) res.accountsNew++; accountId = v.accountId ?? null; }
      await db.insert(companySeeds).values({ source: seedSource, sourceId: k, domain: v.domain ?? null, fitPass: !!accountId, reason: v.reason, siteCheckedAt: now, updatedAt: now })
        .onConflictDoUpdate({ target: [companySeeds.source, companySeeds.sourceId], set: { domain: v.domain ?? null, fitPass: !!accountId, reason: v.reason, siteCheckedAt: now, updatedAt: now } });
    }
    if (!accountId) continue;
    for (const r of recs) {
      const spec = pack.signals.signals[r.signal.type];
      if (!spec) continue; // the pack doesn't use this signal type
      const values = { accountId, class: spec.class, type: r.signal.type, strength: spec.strength, evidenceQuote: r.signal.quote.slice(0, 500), evidenceUrl: r.signal.url, observedAt: r.signal.observedAt, halfLifeDays: spec.half_life_days, lastSeenAt: now };
      // a state (still on the shortage list, contract still ending in the window) moves last_seen_at and refreshes the
      // counted facts; an event keeps its first record
      if (spec.state) await db.insert(signals).values(values).onConflictDoUpdate({ target: [signals.evidenceUrl, signals.type], set: { lastSeenAt: now, evidenceQuote: values.evidenceQuote } });
      else await db.insert(signals).values(values).onConflictDoNothing({ target: [signals.evidenceUrl, signals.type] });
      res.signals++;
    }
  }
  return res;

  type Verdict = { reason: string; domain?: string; isNew?: boolean; accountId?: string };

  async function resolve(r: NicheRecord): Promise<Verdict> {
    const m = matchCompany(r.name, await search(r.query), lists, r.mustMention);
    if (!m) return { reason: "no-match" };
    const region = regionName(m.hit.country);
    if (!region || !r.regions.includes(region) || !regionInScope(region, pack.icp, r.segment)) return { reason: "not-region", domain: m.domain };
    const home = await homepage(m.domain);
    if (!home.ok) return { reason: "bad-site", domain: m.domain };
    const domain = home.finalDomain ?? m.domain;
    if (domain !== m.domain && !nameMatchesDomain(r.name, domain)) return { reason: "bad-site", domain };
    const fit = passesHardFilters({ domain, teamSize: m.hit.employees, industries: [], status: null }, pack.icp, r.segment);
    if (!fit.pass) return { reason: `filtered: ${fit.reason}`, domain };
    const sizeBand = m.hit.employees ? bandForHeadcount(m.hit.employees, pack.icp) : null;
    const before = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.domain, domain)).limit(1);
    const [acc] = await db.insert(accounts).values({ domain, name: r.name, region, sizeBand, segment: r.segment })
      .onConflictDoUpdate({ target: accounts.domain, set: {
        name: sql`coalesce(${accounts.name}, excluded.name)`, region: sql`coalesce(${accounts.region}, excluded.region)`,
        sizeBand: sql`coalesce(${accounts.sizeBand}, excluded.size_band)`, segment: sql`excluded.segment`,
      } })
      .returning({ id: accounts.id });
    return { reason: "resolved", domain, isNew: before.length === 0, accountId: acc!.id };
  }
}

// ------------------------------------------------------------------------------------------------ record builders (pure)

const fmtUsd = (n: number) => (n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n / 1e3)}K`);
const monthYear = (d: Date) => d.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
/** award descriptions run to paragraphs: the first ~90 characters, cut at a word */
const shortDesc = (d: string) => { const t = d.toLowerCase(); return t.length <= 90 ? t : `${t.slice(0, 90).replace(/[\s,;:(]+\S*$/, "")}...`; };
/** US-style labeler names ("... LLC", "... Inc") are rarely Indian HQs: looked up last, so the per-run cap goes further */
const likelyForeign = (n: string) => /\b(llc|inc\.?|corp\.?|usa|us|l\.p\.|lp)\b/i.test(n);

/** FDA shortage x ANDA holders -> records (pure; exported for tests). The company name is the fullest one given. */
export function shortageRecords(s: Shortage, holders: AndaHolder[], cfg: Pack["sources"]["niche"]["fda_shortage"], now: Date): NicheRecord[] {
  const c = holderCounts(holders);
  const forms = s.forms.filter((f) => f !== "other");
  const what = `${s.name}${forms.length ? ` (${forms.join(", ")})` : ""}`;
  const avail = s.allSame === false ? `some presentations ${s.availability.toLowerCase()}` : s.availability.toLowerCase();
  const shortage = `${what} is on the FDA drug shortage list (${avail}${s.reason ? `; reason: ${s.reason.toLowerCase()}` : ""})`;
  return holders.map((h) => {
    const name = (h.labelers.find((l) => !likelyForeign(l)) ?? h.labelers[0] ?? h.sponsor).replace(/\s+/g, " ").trim();
    const status = h.marketed ? "and markets it" : "but does not market it now (approved, discontinued)";
    return {
      source: "fda_shortage", name, query: `${name} pharmaceutical company`, segment: cfg.segment, regions: cfg.regions,
      mustMention: /pharm|drug|generic|formulation|api\b|active pharmaceutical|injectable|healthcare|medicine/i,
      signal: {
        type: h.marketed ? "shortage_anda_marketed" : "shortage_anda_dormant",
        quote: `${shortage}. ${name} holds ANDA ${h.appNo} for it ${status}. ${c.holders} companies hold ANDAs for it; ${c.marketed} market it.`,
        url: h.url, observedAt: now,
      },
    };
  }).sort((a, b) => Number(likelyForeign(a.name)) - Number(likelyForeign(b.name)));
}

/** Expiring awards in one NAICS -> one record per incumbent (its largest award), with the window's counts. */
export function awardRecords(awards: ExpiringAward[], cfg: Pack["sources"]["niche"]["usaspending"]): NicheRecord[] {
  if (!awards.length) return [];
  const naics = awards[0]!.naics;
  const total = awards.reduce((n, a) => n + a.amount, 0);
  const best = new Map<string, ExpiringAward>();
  for (const a of awards) { const k = companyKey(a.recipient); const p = best.get(k); if (!p || a.amount > p.amount) best.set(k, a); }
  // what was counted, said as counted: only the set-asides and minimum amount searched, and "at least" (the scan reads
  // a capped number of pages and only awards with an action in the last two years)
  const scope = `${cfg.set_asides.length ? "small-business set-aside " : ""}contracts over ${fmtUsd(cfg.min_amount)}`;
  // biggest contracts first: the per-run search cap goes to the incumbents with the most at stake
  return [...best.values()].sort((x, y) => y.amount - x.amount).map((a) => {
    const name = a.recipient.toLowerCase().replace(/\b[a-z]/g, (ch) => ch.toUpperCase()).replace(/\b(Llc|Inc|Lp)\b/g, (m) => m.toUpperCase());
    const others = awards.length - 1;
    return {
      source: "usaspending", name, query: `${name} government contractor`, segment: cfg.segment, regions: [cfg.region],
      signal: {
        type: "contract_expiring",
        quote: `${name}'s ${fmtUsd(a.amount)} contract with the ${a.agency}${a.description ? ` (${shortDesc(a.description)})` : ""} ends ${monthYear(a.endDate)} (${isoDay(a.endDate)}; award ${a.awardId}, NAICS ${naics}). At least ${others} other ${scope} in NAICS ${naics}, worth ${fmtUsd(total - a.amount)}, end in the same window.`,
        url: a.url, observedAt: new Date(),
      },
    };
  });
}

/** Newly certified providers -> records (pure; exported for tests). */
export function providerRecords(ps: NewProvider[], cfg: Pack["sources"]["niche"]["cms_new_providers"]): NicheRecord[] {
  return ps.map((p) => {
    const kind = p.kind === "home_health" ? "home health agency" : "hospice";
    return {
      source: "cms_new_providers", name: p.name, query: `${p.name} ${kind} ${p.city} ${p.state}`, segment: cfg.segment, regions: [cfg.region],
      mustMention: /home health|home care|hospice|palliative|in-home|skilled nursing/i,
      signal: {
        type: "new_medicare_certification",
        quote: `${p.name} (${p.city}, ${p.state}) was certified by Medicare as a ${kind} on ${monthYear(p.certifiedAt)} (${isoDay(p.certifiedAt)}; CCN ${p.ccn}).`,
        url: p.url, observedAt: p.certifiedAt,
      },
    };
  });
}

// ------------------------------------------------------------------------------------------------ runners

export async function runFdaShortage(deps: Deps & { shortages?: () => Promise<Shortage[]>; holders?: (s: string, forms: string[]) => Promise<AndaHolder[]> }): Promise<NicheResult> {
  const res = empty("fda_shortage");
  const cfg = deps.pack.sources.niche.fda_shortage;
  if (!cfg.enabled) return { ...res, skipped: "disabled in the pack" };
  if (!isSourceEnabled("openfda")) return { ...res, skipped: "disabled by source policy" };
  if (!deps.companies && !process.env.EXA_API_KEY) return { ...res, skipped: "EXA_API_KEY not set" };
  applyPackIdentity(deps.pack);
  const now = deps.now ?? new Date();
  const list = (await (deps.shortages ?? (() => fetchShortages({ skipAvailability: cfg.skip_availability })))())
    .sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0)).slice(0, cfg.max_substances);
  const records: NicheRecord[] = [];
  for (const s of list) {
    try { records.push(...shortageRecords(s, await (deps.holders ?? fetchAndaHolders)(s.substance, s.forms.filter((f) => f !== "other")), cfg, now)); }
    catch { res.errors++; }
  }
  return persistNicheRecords(records, deps, res);
}

export async function runUsaSpending(deps: Deps & { awards?: (naics: string, from: Date, to: Date) => Promise<ExpiringAward[]> }): Promise<NicheResult> {
  const res = empty("usaspending");
  const cfg = deps.pack.sources.niche.usaspending;
  if (!cfg.enabled || !cfg.naics.length) return { ...res, skipped: "disabled in the pack" };
  if (!isSourceEnabled("usaspending")) return { ...res, skipped: "disabled by source policy" };
  if (!deps.companies && !process.env.EXA_API_KEY) return { ...res, skipped: "EXA_API_KEY not set" };
  applyPackIdentity(deps.pack);
  const now = deps.now ?? new Date();
  const from = new Date(now.getTime() + cfg.min_days * DAY), to = new Date(now.getTime() + cfg.max_days * DAY);
  const records: NicheRecord[] = [];
  for (const naics of cfg.naics) {
    try {
      const awards = await (deps.awards ?? ((n, f, t) => fetchExpiringAwards({ naics: n, setAsides: cfg.set_asides, from: f, to: t, minAmount: cfg.min_amount, maxPages: cfg.max_pages, now })))(naics, from, to);
      records.push(...awardRecords(awards, cfg).map((r) => ({ ...r, signal: { ...r.signal, observedAt: now } })));
    } catch { res.errors++; }
  }
  return persistNicheRecords(records, deps, res);
}

export async function runCmsNewProviders(deps: Deps & { providers?: (kind: NewProvider["kind"], since: Date) => Promise<NewProvider[]> }): Promise<NicheResult> {
  const res = empty("cms_new_providers");
  const cfg = deps.pack.sources.niche.cms_new_providers;
  if (!cfg.enabled) return { ...res, skipped: "disabled in the pack" };
  if (!isSourceEnabled("cms_provider_data")) return { ...res, skipped: "disabled by source policy" };
  if (!deps.companies && !process.env.EXA_API_KEY) return { ...res, skipped: "EXA_API_KEY not set" };
  applyPackIdentity(deps.pack);
  const now = deps.now ?? new Date();
  const since = new Date(now.getTime() - cfg.max_age_days * DAY);
  const records: NicheRecord[] = [];
  for (const kind of cfg.kinds) {
    try {
      const ps = await (deps.providers ?? ((k, s) => fetchNewProviders(k, s, cfg.states)))(kind, since);
      // newest first: the per-run search cap goes to the freshest certifications
      records.push(...providerRecords(ps.sort((a, b) => b.certifiedAt.getTime() - a.certifiedAt.getTime()), cfg));
    } catch { res.errors++; }
  }
  return persistNicheRecords(records, deps, res);
}

/** Operator exports (pnpm niche import <csv>): one row = company, signal type, quote, URL, date (+ optional domain,
 *  region, segment). Parsed here (pure; exported for tests); rows without the required fields are skipped. */
export interface ImportRow { company: string; signal_type: string; quote: string; url: string; date?: string; domain?: string; region?: string; segment?: string; query?: string }

export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.some((c) => c.trim()));
  if (!head) return [];
  const h = head.map((x) => x.trim().toLowerCase().replace(/\s+/g, "_"));
  return body.map((r) => Object.fromEntries(h.map((k, i) => [k, (r[i] ?? "").trim()])));
}

export function importRecords(rows: Record<string, string>[], pack: Pack, defaults: { region: string; segment: string }): { records: NicheRecord[]; skipped: number } {
  let skipped = 0;
  const records = rows.flatMap((r): NicheRecord[] => {
    const type = r.signal_type ?? "";
    const date = r.date ? new Date(r.date) : new Date();
    if (!r.company || !r.quote || !/^https?:\/\//.test(r.url ?? "") || !pack.signals.signals[type] || Number.isNaN(date.getTime())) { skipped++; return []; }
    const region = r.region || defaults.region, segment = r.segment || defaults.segment;
    return [{ source: "niche_import", name: r.company, query: r.query || (r.domain ? r.domain : `${r.company} company`), segment, regions: [region], signal: { type, quote: r.quote, url: r.url!, observedAt: date } }];
  });
  return { records, skipped };
}
