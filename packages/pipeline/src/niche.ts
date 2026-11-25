import { inScope, type Pack } from "@tell/config";
import {
  fetchShortages, fetchAndaHolders, holderCounts, fetchExpiringAwards, fetchNewProviders, exaCompanySearch, companyKey, isSourceEnabled,
  fetchClearances, fetchAndaApprovals, fetchNewAwards, socrataRows, fillTemplate, fetchFormDFilings, fetchFormDDetail,
  type Shortage, type AndaHolder, type ExpiringAward, type NewProvider, type CompanyHit, type DeviceClearance, type AndaApproval, type NewAward, type FormDDetail, type FormDFiling,
  googlePlaces, serperPlaces, wikidataCompanies, serperOrganic, brandfetchSearch, diffbotOrganizations, fetchCompletedTrials, type CompletedTrial, fetchNppesWeekly, requestSamExtract, downloadSamExtract, fetchRecalls, serperNews, companyFromHeadline,
  type PlaceHit, type NewNpi, type SamEntity, type Recall, type NewsItem, brandfetchBrand, type BrandFacts,
} from "@tell/watchers";
import { passesHardFilters, regionInScope } from "@tell/intel";
import { registrableDomain, nameMatchesDomain, checkHomepage, domainLists, type DomainLists } from "@tell/people";
import { getDb, accounts, signals, companySeeds, people, nicheQueue, usageDaily, and, eq, sql, desc } from "@tell/db";
import { applyPackIdentity } from "./scheduled.js";
import { neonUsage, type UsageStore } from "./usage.js";
import { bandForHeadcount, segmentPrompt, parseSegment, profileLine } from "./company-facts.js";
import { HaikuClient } from "@tell/extract";

/**
 * Niche public-record discovery (pack sources.niche, `pnpm niche`). Each source yields records that name a company and
 * carry their own evidence; the company becomes an account only when a company search proves its website (name and
 * domain both match, a distinctive word of the name in the domain, HQ in an allowed region, homepage loads on the same
 * brand). Numbers in every quote are counted here from the records: drafts may only repeat them, never invent them.
 */

const DAY = 86_400_000;
/** a name that didn't resolve is tried again after this long (Exa indexes new sites; records repeat daily) */
const RETRY_DAYS = 60;
/** a name the free ways (Wikidata, Maps, web) couldn't place waits this long before they're tried again; Exa may
 *  still try it any day it has budget */
const FREE_RETRY_DAYS = 7;
/** bumped when a free resolver is added (v2: Brandfetch + Diffbot): names that failed before it get a new try */
const FREE_RESOLVERS = "v2";

/** One record to turn into account + signal. */
export interface NicheRecord {
  source: string;
  /** company name as the record gives it */
  name: string;
  /** what to search for (name plus context: city, industry) */
  query: string;
  /** the industry; "auto" = classified from the company's own description once found (SME IPO filers, SBIR winners) */
  segment: string;
  /** regions the company's HQ may be in */
  regions: string[];
  /** the company description must mention this (keeps a same-name company in another industry out) */
  mustMention?: RegExp;
  signal: { type: string; quote: string; url: string; observedAt: Date };
  /** the record's own website for the company (SAM registrations): checked like any other candidate */
  website?: string | null;
  /** where the record itself says the company is (NPPES, SAM, FMCSA): used when the company index has no HQ */
  knownRegion?: string;
  /** a Maps search for the website when the company index finds nothing ("Acme Trucking Fresno CA") */
  mapsQuery?: string;
  /** small local businesses (new clinics, agencies, carriers) are rarely in the company index: try Maps first */
  mapsFirst?: boolean;
  /** named people the record lists (authorized official, registrant contact, Form D executive): saved as people */
  contacts?: { name: string; role: string }[];
}

export interface NicheResult { contacts?: number; source: string; records: number; companies: number; looked: number; resolved: number; accountsNew: number; signals: number; noMatch: number; notRegion: number; filtered: number; badSite: number; capped: number; errors: number; skipped?: string }

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

/**
 * A Brandfetch name-search match whose region is unknown, confirmed by the Brand API (pure; exported for tests): the
 * brand Brandfetch holds for that domain must be the same domain, carry the record's name (matchCompany's own rules)
 * and say where the company is. Anything less = no confirmation, and the match is dropped as before.
 */
export function confirmByBrand(name: string, m: { hit: CompanyHit; domain: string }, f: BrandFacts | null, lists: DomainLists): { hit: CompanyHit; domain: string } | null {
  if (!f || !f.country || !f.name || f.domain !== m.domain) return null;
  return matchCompany(name, [{ name: f.name, url: `https://${f.domain}`, employees: null, description: "", country: f.country }], lists) ? { ...m, hit: { ...m.hit, country: f.country } } : null;
}

/** Brand API fetches used so far, all time (the free plan's 100 are a one-off allowance) */
async function brandFetchesUsed(): Promise<number> {
  return Number((await getDb().select({ n: sql<number>`coalesce(sum(${usageDaily.used}), 0)` }).from(usageDaily).where(eq(usageDaily.service, "brandfetch_brand")))[0]?.n ?? 0);
}

interface Deps {
  pack: Pack; companies?: (q: string) => Promise<CompanyHit[]>; usage?: UsageStore; now?: Date; homepage?: typeof checkHomepage;
  /** free / web candidates (tests pass fakes; null = off) */
  wiki?: ((name: string) => Promise<CompanyHit[]>) | null; web?: ((q: string, region: string) => Promise<CompanyHit[]>) | null;
  /** Brandfetch name search (free) and Diffbot organisations (capped: DIFFBOT_PER_DAY, usage_daily "diffbot") */
  brand?: ((name: string) => Promise<CompanyHit[]>) | null; diffbot?: ((name: string) => Promise<CompanyHit[]>) | null;
  /** Brandfetch Brand API by domain (cached brands only, BRANDFETCH_BRAND_TOTAL fetches all time, usage_daily "brandfetch_brand") */
  brandFacts?: ((domain: string) => Promise<BrandFacts | null>) | null;
  /** industry for segment "auto" records, from the company's description */
  classify?: ((name: string, domain: string, description: string) => Promise<string | null>) | null;
}

/** Records in turns by industry (pure; exported for tests): one source that writes for many industries (contract awards,
 *  SAM, NPPES, Form D) would otherwise spend its whole lookup cap on whichever industry sorts first. */
export function interleaveBySegment<T extends { segment: string }>(xs: T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const x of xs) groups.set(x.segment, [...(groups.get(x.segment) ?? []), x]);
  const qs = [...groups.values()], out: T[] = [];
  for (let i = 0; out.length < xs.length; i++) for (const q of qs) if (q[i]) out.push(q[i]!);
  return out;
}

/**
 * Records -> accounts + signals. Company names are looked up once (company_seeds, source `niche:<source>`); a resolved
 * name is reused without a search. Exa searches are capped per source per run (sources.niche.per_run).
 */
// wall-clock budget for one process (unset = none): set by the daily chain, not by the ticks' drain
const NICHE_STARTED = Date.now();
export function pastNicheDeadline(now = Date.now()): boolean {
  const m = Number(process.env.NICHE_MAX_MINUTES ?? 0);
  return m > 0 && now - NICHE_STARTED > m * 60_000;
}

export async function persistNicheRecords(records: NicheRecord[], deps: Deps, res: NicheResult): Promise<NicheResult> {
  const { pack } = deps;
  const db = getDb();
  const now = deps.now ?? new Date();
  const usage = deps.usage ?? neonUsage();
  const lists = domainLists(pack.domains);
  const exa = deps.companies ?? ((q: string) => exaCompanySearch(q));
  const homepage = deps.homepage ?? checkHomepage;
  // per-run cap, within the day's search budget across every niche run (usage_daily "exa_niche")
  const budget = pack.sources.niche.daily_budget;
  const perRun = pack.sources.niche.per_run_by_source[records[0]?.source ?? ""] ?? pack.sources.niche.per_run;
  const cap = Math.max(0, Math.min(perRun, budget - (await usage.spentToday("exa_niche"))));
  const maps = await mapsClient(pack, usage, now);
  const rcfg = pack.sources.niche.resolvers;
  // injected company search (tests) = no live resolvers unless injected too
  const live = !deps.companies;
  const wiki = deps.wiki !== undefined ? deps.wiki : live && rcfg.wikidata ? wikidataCompanies : null;
  const brand = deps.brand !== undefined ? deps.brand : live && process.env.BRANDFETCH_SEARCH_API ? (n: string) => brandfetchSearch(n) : null;
  const diffbot = deps.diffbot !== undefined ? deps.diffbot : live && process.env.DIFFBOT_TOKEN ? (n: string) => diffbotOrganizations({ name: n }) : null;
  const brandTotal = Number(process.env.BRANDFETCH_BRAND_TOTAL ?? 90);
  const brandFacts = deps.brandFacts !== undefined ? deps.brandFacts : live && process.env.BRANDFETCH_BRAND_API ? async (d: string) => {
    if ((await brandFetchesUsed()) >= brandTotal) return null;
    const r = await brandfetchBrand(d);
    if (r.charged) await usage.addSpend("brandfetch_brand", 1, brandTotal);
    return r.facts;
  } : null;
  // organisations a day for niche names (each is 25 Diffbot credits; company facts has its own DIFFBOT_FACTS_PER_DAY)
  const diffbotCap = Number(process.env.DIFFBOT_PER_DAY ?? 6);
  const serperKey = process.env.SERPER_API_KEY;
  const web = deps.web !== undefined ? deps.web : live && rcfg.web_per_day > 0 && serperKey ? ((q: string, region: string) => serperOrganic(serperKey, q, region === "India" ? "in" : "us")) : null;
  let classify = deps.classify;
  let searches = 0;
  // records only from the pack's working regions (pack.yaml regions): the rest are paused, never looked up
  const scope = pack.meta.regions;
  if (scope.length) {
    const kept = records.filter((r) => inScope(scope, r.regions));
    res.filtered += records.length - kept.length;
    records = kept;
  }
  res.records += records.length;

  // one lookup per company name; every record of that name follows the verdict
  const byName = new Map<string, NicheRecord[]>();
  for (const r of interleaveBySegment(records)) { const k = companyKey(r.name); if (k) byName.set(k, [...(byName.get(k) ?? []), r]); }
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
      if (seed && !seed.fitPass && !seed.reason?.startsWith("deferred") && seed.siteCheckedAt && now.getTime() - seed.siteCheckedAt.getTime() < RETRY_DAYS * DAY) continue;
      // the free ways (Wikidata, Maps, web) already failed for this name this week: only Exa is left to try
      const freeTried = seed?.reason === `deferred:${FREE_RESOLVERS}` && !!seed.siteCheckedAt && now.getTime() - seed.siteCheckedAt.getTime() < FREE_RETRY_DAYS * DAY;
      // (a record that brings its own website, e.g. SAM's by UEI, is always worth one try: no search needed)
      if (freeTried && searches >= cap && !r0.website) { res.capped++; await enqueue(seedSource, k, recs); continue; }
      // the run's time budget is spent (NICHE_MAX_MINUTES, daily chain): queue the rest for the ticks' drain so later
      // steps (digest, opportunity leads) still run inside the job's limit
      if (pastNicheDeadline()) { res.capped++; await enqueue(seedSource, k, recs); continue; }
      res.looked++;
      const v = await resolve(r0, searches < cap, freeTried).catch(() => ({ reason: "error" } as Verdict));
      // nothing could look it up today (Exa's cap spent, the free ways found nothing): keep it for the next budget, and
      // remember the free ways failed so tomorrow's runs don't spend Maps on it again
      if (v.reason === "deferred") {
        res.looked--; res.capped++; await enqueue(seedSource, k, recs);
        await db.insert(companySeeds).values({ source: seedSource, sourceId: k, fitPass: false, reason: `deferred:${FREE_RESOLVERS}`, siteCheckedAt: now, updatedAt: now })
          .onConflictDoUpdate({ target: [companySeeds.source, companySeeds.sourceId], set: { fitPass: false, reason: `deferred:${FREE_RESOLVERS}`, siteCheckedAt: now, updatedAt: now } });
        continue;
      }
      if (v.reason === "no-match") res.noMatch++;
      else if (v.reason === "error") res.errors++;
      else if (v.reason === "not-region") res.notRegion++;
      else if (v.reason === "bad-site") res.badSite++;
      else if (v.reason.startsWith("filtered")) res.filtered++;
      else { res.resolved++; if (v.isNew) res.accountsNew++; accountId = v.accountId ?? null; }
      await db.insert(companySeeds).values({ source: seedSource, sourceId: k, domain: v.domain ?? null, fitPass: !!accountId, reason: v.reason, siteCheckedAt: now, updatedAt: now })
        .onConflictDoUpdate({ target: [companySeeds.source, companySeeds.sourceId], set: { domain: v.domain ?? null, fitPass: !!accountId, reason: v.reason, siteCheckedAt: now, updatedAt: now } });
    }
    await db.delete(nicheQueue).where(and(eq(nicheQueue.source, seedSource), eq(nicheQueue.key, k)));
    if (!accountId) continue;
    // people the records name (authorized officials, registrant contacts, Form D executives): a contact to reach
    const named = new Map(recs.flatMap((r) => r.contacts ?? []).filter((c) => c.name.trim().split(/\s+/).length >= 2).map((c) => [c.name.toLowerCase(), c]));
    if (named.size) {
      await db.insert(people).values([...named.values()].map((c) => ({ accountId: accountId!, fullName: c.name, role: c.role || null, source: "public_record", confidence: 0.8, sourceUrl: r0.signal.url, fetchedAt: now })))
        .onConflictDoUpdate({ target: [people.accountId, people.fullName, people.source], set: { role: sql`excluded.role`, fetchedAt: sql`excluded.fetched_at` } });
      res.contacts = (res.contacts ?? 0) + named.size;
    }
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

  async function resolve(r: NicheRecord, exaOk: boolean, freeTried = false): Promise<Verdict> {
    // 1. the record's own website; 2. Wikidata (free); 3. Maps first for small local businesses; 4. the company index
    // (Exa, capped); 5. Maps; 6. Google web results (Serper, own daily budget). Each only proposes: matchCompany decides.
    let m: { hit: CompanyHit; domain: string } | null = null;
    const own = r.website ? registrableDomain(/^https?:/i.test(r.website) ? r.website : `https://${r.website}`) : null;
    if (own && !lists.neverCompany.has(own) && !lists.freeMail.has(own) && nameMatchesDomain(r.name, own)) {
      m = { hit: { name: r.name, url: `https://${own}`, employees: null, description: "", country: r.knownRegion ?? null }, domain: own };
    }
    const viaMaps = async () => {
      // every record can try Maps: its own Maps query, else the company name in its region
      if (!maps) return null;
      const hit = await maps.lookup(r.mapsQuery ?? r.name, r.knownRegion ?? r.regions[0] ?? "");
      return hit ? matchCompany(r.name, [{ name: hit.name, url: hit.website!, employees: null, description: hit.name, country: r.knownRegion ?? null }], lists) : null;
    };
    if (!m && wiki && !r.mapsFirst && !freeTried) m = matchCompany(r.name, await wiki(r.name).catch(() => []), lists, r.mustMention);
    // Brandfetch (free) knows brands by name but not where they are: its match counts only when the region is known
    // some other way (a .in domain, the record's own region, a source allowed in one region)
    if (!m && brand && !freeTried) {
      const b = matchCompany(r.name, await brand(r.name).catch(() => []), lists);
      if (b && (b.hit.country || r.knownRegion || r.regions.length === 1)) m = b;
      // region unknown: the Brand API can confirm the domain and say where the company is (otherwise dropped, as before)
      else if (b && brandFacts) m = confirmByBrand(r.name, b, await brandFacts(b.domain).catch(() => null), lists);
    }
    // Diffbot proves website, country and size together (25 credits each: a few a day)
    if (!m && diffbot && !freeTried && (await usage.spentToday("diffbot")) < diffbotCap) {
      await usage.addSpend("diffbot", 2, diffbotCap); // size=2: two organisations, 50 credits
      m = matchCompany(r.name, await diffbot(r.name).catch(() => []), lists, r.mustMention);
    }
    if (!m && r.mapsFirst && !freeTried) m = await viaMaps();
    // the company index costs a search (usage_daily "exa_niche", within the daily budget)
    let exaTried = false;
    if (!m && exaOk) { exaTried = true; searches++; await usage.addSpend("exa_niche", 1, budget); m = matchCompany(r.name, await exa(r.query), lists, r.mustMention); }
    if (!m && !r.mapsFirst && !freeTried) m = await viaMaps();
    if (!m && web && !freeTried && (await usage.spentToday("serper_resolve")) < rcfg.web_per_day) {
      await usage.addSpend("serper_resolve", 1, rcfg.web_per_day);
      m = matchCompany(r.name, await web(r.query, r.knownRegion ?? r.regions[0] ?? ""), lists, r.mustMention);
    }
    // not found without Exa (its cap was spent): deferred to a day with budget, not marked as a miss
    if (!m) return { reason: exaTried ? "no-match" : "deferred" };
    // segment "auto": the industry from the company's own description (Haiku, within its daily cap)
    let segment = r.segment;
    if (segment === "auto") {
      if (classify === undefined) classify = live ? await makeClassifier(pack, usage) : null;
      segment = (classify && m.hit.description ? await classify(m.hit.name, m.domain, m.hit.description).catch(() => null) : null) ?? "";
      if (!segment) return { reason: "filtered: industry unknown", domain: m.domain };
    }
    // a record allowed in one region only (a US federal contract) is in that region when nothing says otherwise
    const region = regionName(m.hit.country) ?? r.knownRegion ?? (r.regions.length === 1 ? r.regions[0]! : null);
    if (!region || !r.regions.includes(region) || !regionInScope(region, pack.icp, segment)) return { reason: "not-region", domain: m.domain };
    const home = await homepage(m.domain);
    if (!home.ok) return { reason: "bad-site", domain: m.domain };
    const domain = home.finalDomain ?? m.domain;
    if (domain !== m.domain && !nameMatchesDomain(r.name, domain)) return { reason: "bad-site", domain };
    const fit = passesHardFilters({ domain, teamSize: m.hit.employees, industries: [], status: null }, pack.icp, segment);
    if (!fit.pass) return { reason: `filtered: ${fit.reason}`, domain };
    const sizeBand = m.hit.employees ? bandForHeadcount(m.hit.employees, pack.icp) : null;
    const before = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.domain, domain)).limit(1);
    const description = m.hit.description ? profileLine(m.hit.description) : null;
    // an account already known keeps its industry (a SaaS company winning a federal contract stays SaaS): signals its
    // industry doesn't count are ignored there, never relabelled into another industry
    const [acc] = await db.insert(accounts).values({ domain, name: r.name, region, sizeBand, segment, description })
      .onConflictDoUpdate({ target: accounts.domain, set: {
        name: sql`coalesce(${accounts.name}, excluded.name)`, region: sql`coalesce(${accounts.region}, excluded.region)`,
        sizeBand: sql`coalesce(${accounts.sizeBand}, excluded.size_band)`, segment: sql`coalesce(${accounts.segment}, excluded.segment)`,
        description: sql`coalesce(${accounts.description}, excluded.description)`,
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

// ------------------------------------------------------------------------------------------------ more sources (pure builders + runners)

type Niche = Pack["sources"]["niche"];
const PHARMA = /pharm|drug|generic|formulation|api\b|active pharmaceutical|injectable|healthcare|medicine/i;
const MEDTECH = /medical|device|health|surgical|diagnostic|orthop|dental|implant|hospital|clinical|imaging|catheter|wound|patient/i;
const fullName = (labelers: string[], sponsor: string) => (labelers.find((l) => !likelyForeign(l)) ?? labelers[0] ?? sponsor).replace(/\s+/g, " ").trim();
const titleName = (n: string) => n.toLowerCase().replace(/\b[a-z]/g, (ch) => ch.toUpperCase()).replace(/\b(Llc|Lp|Llp|Pllc)\b/g, (m) => m.toUpperCase());

export function clearanceRecords(cs: DeviceClearance[], cfg: NonNullable<Niche["fda_510k"]>): NicheRecord[] {
  return cs.map((c) => {
    const name = titleName(c.applicant);
    return {
      source: "fda_510k", name, query: `${name} medical device company`, segment: cfg.segment, regions: cfg.regions, mustMention: MEDTECH,
      knownRegion: c.country === "IN" ? "India" : c.country === "US" ? "United States of America" : undefined, mapsQuery: `${name} ${c.city}`,
      ...(c.contact ? { contacts: [{ name: c.contact, role: "Regulatory contact (FDA 510(k))" }] } : {}),
      signal: { type: "device_cleared", quote: `${name} received FDA 510(k) clearance ${c.kNumber} for ${c.device.toLowerCase()}${c.panel ? ` (${c.panel.toLowerCase()})` : ""} on ${monthYear(c.decidedAt)} (${isoDay(c.decidedAt)}).`, url: c.url, observedAt: c.decidedAt },
    };
  }).sort((a, b) => Number(likelyForeign(a.name)) - Number(likelyForeign(b.name)));
}

export function approvalRecords(as: AndaApproval[], cfg: NonNullable<Niche["anda_approvals"]>): NicheRecord[] {
  return as.map((a) => {
    const name = fullName(a.labelers, titleName(a.sponsor));
    return {
      source: "anda_approvals", name, query: `${name} pharmaceutical company`, segment: cfg.segment, regions: cfg.regions, mustMention: PHARMA,
      signal: { type: "anda_approved", quote: `${name} received FDA approval for ANDA ${a.appNo} (${a.ingredient}${a.form ? `, ${a.form}` : ""}) on ${monthYear(a.approvedAt)} (${isoDay(a.approvedAt)}).`, url: a.url, observedAt: a.approvedAt },
    };
  }).sort((a, b) => Number(likelyForeign(a.name)) - Number(likelyForeign(b.name)));
}

export function newAwardRecords(aw: NewAward[], segment: string, region: string, now: Date): NicheRecord[] {
  const best = new Map<string, NewAward>();
  for (const a of aw) { const k = companyKey(a.recipient); const p = best.get(k); if (!p || a.amount > p.amount) best.set(k, a); }
  return [...best.values()].sort((x, y) => y.amount - x.amount).map((a) => {
    const name = titleName(a.recipient);
    return {
      source: "usaspending_awards", name, query: `${name} contractor`, segment, regions: [region],
      signal: {
        type: "contract_won",
        quote: `${name} won a ${fmtUsd(a.amount)} contract from the ${a.agency}${a.description ? ` (${shortDesc(a.description)})` : ""}${a.startDate ? `, starting ${monthYear(a.startDate)}` : ""}${a.endDate ? ` and running to ${monthYear(a.endDate)}` : ""} (award ${a.awardId}, NAICS ${a.naics}).`,
        url: a.url, observedAt: a.startDate && a.startDate < now ? a.startDate : now,
      },
    };
  });
}

/** Contracts found by keyword (SBIR Phase II, CRM implementation) -> records, the largest per recipient first (pure;
 *  exported for tests). `must` / `exclude` test the award description (a license resale is no build work). */
export function keywordAwardRecords(aw: NewAward[], cfg: Niche["keyword_awards"][number], now: Date): NicheRecord[] {
  const must = cfg.must ? new RegExp(cfg.must, "i") : null, exclude = cfg.exclude ? new RegExp(cfg.exclude, "i") : null;
  const best = new Map<string, NewAward>();
  for (const a of aw) {
    if ((must && !must.test(a.description)) || (exclude && exclude.test(a.description))) continue;
    const k = companyKey(a.recipient); const p = best.get(k); if (!p || a.amount > p.amount) best.set(k, a);
  }
  return [...best.values()].sort((x, y) => y.amount - x.amount).map((a) => {
    const name = titleName(a.recipient);
    return {
      source: `awards_${cfg.id}`, name, query: `${name} company`, segment: cfg.segment, regions: [cfg.region], knownRegion: cfg.region, mapsQuery: name,
      signal: {
        type: cfg.signal_type,
        quote: `${name} won a ${fmtUsd(a.amount)} federal contract from the ${a.agency}${a.description ? ` for ${shortDesc(a.description)}` : ""}${a.startDate ? `, starting ${monthYear(a.startDate)}` : ""} (award ${a.awardId}).`,
        url: a.url, observedAt: a.startDate && a.startDate < now ? a.startDate : now,
      },
    };
  });
}

/** Completed industry trials -> records, one per sponsor (its latest trial), segment from the intervention type (pure;
 *  exported for tests). Trials testing nothing the pack maps (behavioral, procedure) are skipped. */
export function trialRecords(ts: CompletedTrial[], cfg: NonNullable<Niche["clinical_trials"]>): NicheRecord[] {
  const best = new Map<string, { t: CompletedTrial; segment: string }>();
  for (const t of ts) {
    const seg = t.interventions.map((i) => cfg.segments[i.type]).find(Boolean);
    if (!seg) continue;
    const k = companyKey(t.sponsor);
    if (!best.has(k) || best.get(k)!.t.completedAt < t.completedAt) best.set(k, { t, segment: seg });
  }
  return [...best.values()].map(({ t, segment }) => {
    const what = t.interventions.filter((i) => cfg.segments[i.type] === segment && i.name && !/placebo/i.test(i.name)).map((i) => i.name).slice(0, 2).join(" and ");
    return {
      source: "clinical_trials", name: t.sponsor, query: `${t.sponsor} ${segment === "medtech" ? "medical device" : "pharmaceutical"} company`, segment, regions: cfg.regions,
      mustMention: segment === "medtech" ? MEDTECH : PHARMA,
      signal: {
        type: "trial_completed",
        quote: `${t.sponsor} completed a clinical trial${what ? ` of ${what}` : ""} on ${isoDay(t.completedAt)}: "${t.title.slice(0, 140)}" (${t.nctId}${t.phase && t.phase !== "NA" ? `, ${t.phase.replace(/PHASE/g, "phase ").toLowerCase()}` : ""}).`,
        url: t.url, observedAt: t.completedAt,
      },
    };
  });
}

export async function runKeywordAwards(deps: Deps & { fetch?: (keywords: string[], since: Date, pages: number, min: number) => Promise<NewAward[]> }): Promise<NicheResult[]> {
  const out: NicheResult[] = [];
  const now = deps.now ?? new Date();
  for (const cfg of deps.pack.sources.niche.keyword_awards) {
    const src = `awards_${cfg.id}`;
    const g = guard(src, "usaspending", cfg.enabled, deps); if (g) { out.push(g); continue; }
    const res = empty(src);
    try {
      const since = new Date(now.getTime() - cfg.max_age_days * DAY);
      const aw = await (deps.fetch ?? ((k, s, p, m) => fetchNewAwards({ naics: null, keywords: k, setAsides: [], since: s, now, minAmount: m, maxPages: p })))(cfg.keywords, since, cfg.max_pages, cfg.min_amount);
      out.push(await persistNicheRecords(keywordAwardRecords(aw, cfg, now), deps, res));
    } catch { res.errors++; out.push(res); }
  }
  return out;
}

export async function runClinicalTrials(deps: Deps & { fetch?: (since: Date, max: number) => Promise<CompletedTrial[]> }): Promise<NicheResult> {
  const cfg = deps.pack.sources.niche.clinical_trials;
  const g = guard("clinical_trials", "clinicaltrials", cfg?.enabled, deps); if (g) return g;
  const now = deps.now ?? new Date();
  const res = empty("clinical_trials");
  const ts = await (deps.fetch ?? fetchCompletedTrials)(new Date(now.getTime() - cfg!.max_age_days * DAY), cfg!.max_trials);
  return persistNicheRecords(trialRecords(ts, cfg!), deps, res);
}

/** Form D issuer region: a US state code, or K7 (India); null = elsewhere. Exported for tests. */
export const formDRegion = (s: string) => (/^[A-Z]{2}$/.test(s) ? "United States of America" : s === "K7" ? "India" : null); // EDGAR: US states are 2 letters, other countries letter+digit

export function formDRecords(ds: FormDDetail[], cfg: NonNullable<Niche["form_d"]>): NicheRecord[] {
  return ds.flatMap((d) => {
    const segment = cfg.industries[d.industry];
    const region = formDRegion(d.state);
    if (!segment || !region || d.amendment || /pooled investment/i.test(d.industry) || (d.sold ?? 0) < cfg.min_sold) return [];
    if (/\b(fund|investors|holdings|spv|series [a-z0-9]+|portfolio|capital partners|lp)\b/i.test(d.entity) && segment === "real_estate") return []; // property SPVs: no website, no buyer
    const name = titleName(d.entity);
    const raised = d.sold != null && d.sold > 0 ? `${fmtUsd(d.sold)} sold${d.offering ? ` of a ${fmtUsd(d.offering)} offering` : ""}` : d.offering ? `a ${fmtUsd(d.offering)} offering` : "an offering of undisclosed size";
    return [{
      source: "form_d", name, query: `${name} ${d.city} company`, segment, regions: [region], knownRegion: region, mapsQuery: `${name} ${d.city} ${d.state}`,
      contacts: (d.executives ?? []).map((e) => ({ name: e.name, role: "Executive Officer (SEC Form D)" })),
      signal: { type: "form_d_raise", quote: `${name} (${d.city}${d.state.length === 2 ? `, ${d.state}` : ""}) filed a Form D with the SEC on ${isoDay(d.filedAt)}: ${raised} (industry: ${d.industry.toLowerCase()}).`, url: d.url, observedAt: d.filedAt },
    }];
  });
}

type SocrataCfg = Niche["socrata"][number];

/** One Socrata row -> a record (pure; exported for tests). Null when no company name or the name is a person / owner. */
export function socrataRecord(row: Record<string, unknown>, cfg: SocrataCfg, now: Date): NicheRecord | null {
  let company = cfg.company_field ? String(row[cfg.company_field] ?? "").trim() : "";
  if (!company && cfg.company_pairs) {
    const re = new RegExp(cfg.company_pairs.match, "i");
    for (let i = 1; i <= cfg.company_pairs.max; i++) {
      if (re.test(String(row[cfg.company_pairs.type.replace("{i}", String(i))] ?? ""))) { company = String(row[cfg.company_pairs.name.replace("{i}", String(i))] ?? "").trim(); break; }
    }
  }
  company = company.replace(/\s+,/g, ",").replace(/\s+/g, " ").replace(/\s*(d\/b\/a|dba)\s.*$/i, "").trim();
  // people are "LAST, FIRST": never a company
  if (!company || new RegExp(cfg.skip_company, "i").test(company) || /^[a-z'-]+,\s*[a-z'-]+( [a-z]\.?)?$/i.test(company)) return null;
  const name = titleName(company);
  const at = (() => { const v = String(row[cfg.date_field] ?? ""); const m = v.match(/^(\d{4})-?(\d{2})-?(\d{2})/); return m ? new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`) : now; })();
  const fields = { ...row, company: name };
  const key = String(row[cfg.key_field] ?? "").trim();
  if (!key) return null;
  const url = cfg.url ? fillTemplate(cfg.url, fields) : `https://${cfg.domain}/resource/${cfg.dataset}.json?${encodeURIComponent(cfg.key_field)}=${encodeURIComponent(key)}`;
  const site = cfg.website ? fillTemplate(cfg.website, fields) : "";
  const contactName = cfg.contact ? fillTemplate(cfg.contact.name, fields) : "";
  return {
    source: `socrata_${cfg.id}`, name, query: fillTemplate(cfg.query, fields), segment: cfg.segment, regions: [cfg.region], knownRegion: cfg.region,
    mapsQuery: fillTemplate(cfg.maps_query ?? cfg.query, fields), ...(cfg.maps_first ? { mapsFirst: true } : {}),
    ...(site ? { website: site.includes("@") ? site.split("@")[1]!.trim() : site } : {}),
    ...(contactName ? { contacts: [{ name: contactName, role: cfg.contact!.role }] } : {}),
    ...(cfg.must_mention ? { mustMention: new RegExp(cfg.must_mention, "i") } : {}),
    signal: { type: cfg.signal_type, quote: fillTemplate(cfg.quote, fields), url, observedAt: at },
  };
}

const guard = (source: string, policy: string, enabled: boolean | undefined, deps: Deps): NicheResult | null => {
  if (!enabled) return { ...empty(source), skipped: "disabled in the pack" };
  if (!isSourceEnabled(policy)) return { ...empty(source), skipped: "disabled by source policy" };
  if (!deps.companies && !process.env.EXA_API_KEY) return { ...empty(source), skipped: "EXA_API_KEY not set" };
  applyPackIdentity(deps.pack);
  return null;
};

export async function runFda510k(deps: Deps & { fetch?: (since: Date) => Promise<DeviceClearance[]> }): Promise<NicheResult> {
  const cfg = deps.pack.sources.niche.fda_510k;
  const g = guard("fda_510k", "openfda", cfg?.enabled, deps); if (g) return g;
  const now = deps.now ?? new Date(), since = new Date(now.getTime() - cfg!.max_age_days * DAY);
  const res = empty("fda_510k");
  try { return await persistNicheRecords(clearanceRecords(await (deps.fetch ?? ((s) => fetchClearances(s, cfg!.countries, now)))(since), cfg!), deps, res); }
  catch { res.errors++; return res; }
}

export async function runAndaApprovals(deps: Deps & { fetch?: (since: Date) => Promise<AndaApproval[]> }): Promise<NicheResult> {
  const cfg = deps.pack.sources.niche.anda_approvals;
  const g = guard("anda_approvals", "openfda", cfg?.enabled, deps); if (g) return g;
  const now = deps.now ?? new Date(), since = new Date(now.getTime() - cfg!.max_age_days * DAY);
  const res = empty("anda_approvals");
  try { return await persistNicheRecords(approvalRecords(await (deps.fetch ?? ((s) => fetchAndaApprovals(s, now)))(since), cfg!), deps, res); }
  catch { res.errors++; return res; }
}

export async function runNewAwards(deps: Deps & { fetch?: (naics: string, since: Date) => Promise<NewAward[]> }): Promise<NicheResult> {
  const cfg = deps.pack.sources.niche.usaspending_awards;
  const g = guard("usaspending_awards", "usaspending", cfg?.enabled && !!cfg.groups.length, deps); if (g) return g;
  const now = deps.now ?? new Date(), since = new Date(now.getTime() - cfg!.max_age_days * DAY);
  const res = empty("usaspending_awards");
  const records: NicheRecord[] = [];
  for (const grp of cfg!.groups) for (const naics of grp.naics) {
    try {
      const aw = await (deps.fetch ?? ((n, s) => fetchNewAwards({ naics: n, setAsides: grp.set_asides ?? cfg!.set_asides, since: s, now, minAmount: cfg!.min_amount, maxPages: cfg!.max_pages })))(naics, since);
      records.push(...newAwardRecords(grp.max_amount != null ? aw.filter((a) => a.amount <= grp.max_amount!) : aw, grp.segment, cfg!.region, now));
    } catch { res.errors++; }
  }
  // biggest awards first across groups: the search cap goes to the winners with the most at stake
  records.sort((a, b) => (Number(b.signal.quote.match(/\$([\d.]+)M/)?.[1] ?? 0)) - (Number(a.signal.quote.match(/\$([\d.]+)M/)?.[1] ?? 0)));
  return persistNicheRecords(records, deps, res);
}

export async function runFormD(deps: Deps & { filings?: (days: number) => Promise<FormDFiling[]>; detail?: (f: FormDFiling) => Promise<FormDDetail | null> }): Promise<NicheResult> {
  const cfg = deps.pack.sources.niche.form_d;
  const g = guard("form_d", "sec_form_d", cfg?.enabled && Object.keys(cfg.industries).length > 0, deps); if (g) return g;
  if (!deps.filings && !process.env.SEC_USER_AGENT) return { ...empty("form_d"), skipped: "SEC_USER_AGENT not set" };
  const res = empty("form_d");
  const filings = (await (deps.filings ?? ((d) => fetchFormDFilings(d, deps.now)))(cfg!.days)).slice(0, cfg!.max_filings);
  const details: FormDDetail[] = [];
  for (const f of filings) {
    try { const d = await (deps.detail ?? ((x) => fetchFormDDetail(x.url, x.filedAt)))(f); if (d) details.push(d); } catch { res.errors++; }
    if (!deps.detail) await new Promise((r) => setTimeout(r, 150)); // SEC fair access: well under 10 requests/second
  }
  return persistNicheRecords(formDRecords(details, cfg!), deps, res);
}

export async function runSocrata(deps: Deps & { rows?: (cfg: SocrataCfg, where: string) => Promise<Record<string, unknown>[]> }): Promise<NicheResult[]> {
  const out: NicheResult[] = [];
  const now = deps.now ?? new Date();
  for (const cfg of deps.pack.sources.niche.socrata) {
    const src = `socrata_${cfg.id}`;
    const g = guard(src, "socrata", cfg.enabled, deps); if (g) { out.push(g); continue; }
    const since = new Date(now.getTime() - cfg.max_age_days * DAY);
    const where = cfg.where.replaceAll("{since}", since.toISOString().slice(0, 10)).replaceAll("{since_ymd}", since.toISOString().slice(0, 10).replace(/-/g, ""));
    const res = empty(src);
    try {
      const rows = await (deps.rows ?? ((c, w) => socrataRows(c.domain, c.dataset, w, c.order, c.limit)))(cfg, where);
      out.push(await persistNicheRecords(rows.flatMap((r) => socrataRecord(r, cfg, now) ?? []), deps, res));
    } catch { res.errors++; out.push(res); }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ queue + Maps

/** Strength first, then the largest amount in the quote ("$4.2M"): the most valuable records are looked up first. */
export function queuePriority(recs: NicheRecord[], pack: Pack): number {
  const strength = Math.max(...recs.map((r) => pack.signals.signals[r.signal.type]?.strength ?? 0));
  const amount = Math.max(0, ...recs.map((r) => { const m = r.signal.quote.match(/\$([\d.]+)([MBK])/); return m ? Number(m[1]) * (m[2] === "B" ? 1000 : m[2] === "K" ? 0.001 : 1) : 0; }));
  return strength * 1000 + Math.min(999, amount);
}

const toJson = (recs: NicheRecord[]) => recs.map((r) => ({ ...r, mustMention: r.mustMention?.source, signal: { ...r.signal, observedAt: r.signal.observedAt.toISOString() } }));
const fromJson = (rows: unknown): NicheRecord[] => (rows as (Omit<NicheRecord, "mustMention" | "signal"> & { mustMention?: string; signal: { type: string; quote: string; url: string; observedAt: string } })[])
  .map((r) => ({ ...r, mustMention: r.mustMention ? new RegExp(r.mustMention, "i") : undefined, signal: { ...r.signal, observedAt: new Date(r.signal.observedAt) } }));

let queuePack: Pack | null = null;
async function enqueue(source: string, key: string, recs: NicheRecord[]) {
  const priority = queuePack ? queuePriority(recs, queuePack) : 0;
  await getDb().insert(nicheQueue).values({ source, key, records: toJson(recs), priority })
    .onConflictDoUpdate({ target: [nicheQueue.source, nicheQueue.key], set: { records: toJson(recs), priority } });
}

/**
 * Every tick: look up the most valuable queued companies, within the per-run cap and the day's search budget
 * (sources.niche.daily_budget). Records a lookup can't reach today stay queued; a record older than 60 days is dropped.
 */
export async function drainNicheQueue(deps: Deps & { limit?: number }): Promise<NicheResult & { queued: number; dropped: number }> {
  const db = getDb();
  const now = deps.now ?? new Date();
  queuePack = deps.pack;
  const old = await db.delete(nicheQueue).where(sql`${nicheQueue.queuedAt} < ${new Date(now.getTime() - 60 * DAY)}`).returning({ k: nicheQueue.key });
  // each industry gets its turn: the most valuable names per industry, round-robin (one industry's backlog never
  // starves the others)
  const limit = deps.limit ?? deps.pack.sources.niche.per_run;
  const scope = deps.pack.meta.regions;
  // (names from paused regions stay queued, untouched, until their region is back in pack.yaml regions)
  const top = (await db.select().from(nicheQueue).orderBy(desc(nicheQueue.priority), nicheQueue.queuedAt).limit(limit * 60))
    .filter((r) => inScope(scope, fromJson(r.records)[0]?.regions ?? []));
  const rows = interleaveBySegment(top.map((r) => ({ r, segment: (fromJson(r.records)[0]?.segment ?? "") }))).slice(0, limit).map((x) => x.r);
  const res = { ...empty("queue"), queued: 0, dropped: old.length };
  for (const row of rows) await persistNicheRecords(fromJson(row.records), deps, res);
  res.queued = Number((await db.execute(sql`select count(*)::int as n from ${nicheQueue}`)).rows[0]?.n ?? 0);
  return res;
}

/** Haiku segment classifier for "auto" records, within the shared Haiku daily cap; null without a key or budget. */
async function makeClassifier(pack: Pack, usage: UsageStore): Promise<((name: string, domain: string, description: string) => Promise<string | null>) | null> {
  if (!process.env.ANTHROPIC_API_KEY || !Object.keys(pack.icp.segment_descriptions).length) return null;
  const cap = Number(process.env.HAIKU_DAILY_CAP_USD ?? 0.06);
  const left = cap - (await usage.spentToday("haiku"));
  if (left <= 0) return null;
  const llm = new HaikuClient({ capUsd: Math.min(left, 0.2) });
  const system = segmentPrompt(pack);
  return async (name, domain, description) => {
    const before = llm.spent;
    const seg = parseSegment(await llm.complete({ system, user: `Company: ${name}\nWebsite: ${domain}\nDescription: ${description}` }), pack);
    if (llm.spent > before) await usage.addSpend("haiku", llm.spent - before, cap);
    return seg && !pack.icp.industries[seg]?.excluded ? seg : null;
  };
}

/** Google Places (GOOGLE_MAPS_API_KEY, monthly cap) or Serper places (SERPER_API_KEY, daily cap): a website for a name. */
async function mapsClient(pack: Pack, usage: UsageStore, now: Date) {
  queuePack = pack;
  const cfg = pack.sources.niche.maps;
  if (!cfg.enabled) return null;
  const google = process.env.GOOGLE_MAPS_API_KEY, serper = process.env.SERPER_API_KEY;
  if (!google && !serper) return null;
  const month = now.toISOString().slice(0, 7);
  const monthUsed = async () => Number((await getDb().select({ n: sql<number>`coalesce(sum(${usageDaily.used}), 0)` }).from(usageDaily)
    .where(and(eq(usageDaily.service, "google_places"), sql`${usageDaily.day}::text like ${`${month}%`}`)))[0]?.n ?? 0);
  return {
    async lookup(query: string, region: string): Promise<PlaceHit | null> {
      const code = region === "India" ? "IN" : "US";
      let hits: PlaceHit[] = [];
      try {
        if (google && (await monthUsed()) < cfg.google_per_month) { await usage.addSpend("google_places", 1, cfg.google_per_month); hits = await googlePlaces(google, query, code); }
        else if (serper && (await usage.spentToday("serper_places")) < cfg.serper_per_day) { await usage.addSpend("serper_places", 1, cfg.serper_per_day); hits = await serperPlaces(serper, query, code.toLowerCase()); }
      } catch { return null; }
      return hits.find((h) => h.website) ?? null;
    },
  };
}

// ------------------------------------------------------------------------------------------------ NPPES, SAM, recalls, news, DMF

const HEALTH = /health|care|clinic|medical|hospice|home|nursing|therapy|dental|lab|pharmacy|hospital|physician|rehab|senior|living|supply|equipment|transport/i;

export function nppesRecords(ns: NewNpi[], cfg: NonNullable<Niche["nppes"]>): NicheRecord[] {
  return ns.flatMap((n) => {
    const t = cfg.taxonomies[n.taxonomy];
    if (!t) return [];
    return [{
      source: "nppes", mapsFirst: true, name: n.name, query: `${n.name} ${t.label} ${n.city} ${n.state}`, segment: t.segment, regions: ["United States of America"], knownRegion: "United States of America",
      mapsQuery: `${n.name} ${n.city} ${n.state}`, mustMention: HEALTH,
      contacts: n.official ? [{ name: n.official.name, role: n.official.title || "Authorized Official" }] : [],
      signal: { type: "new_provider_npi", quote: `${n.name} (${n.city}, ${n.state}) registered a new NPI as a ${t.label.toLowerCase()} on ${monthYear(n.enumeratedAt)} (${isoDay(n.enumeratedAt)}; NPI ${n.npi}).`, url: n.url, observedAt: n.enumeratedAt },
    }];
  });
}

export function samRecords(es: SamEntity[], cfg: NonNullable<Niche["sam_entities"]>): NicheRecord[] {
  const prefixes = Object.keys(cfg.naics_prefixes).sort((a, b) => b.length - a.length);
  return es.flatMap((e) => {
    const p = prefixes.find((x) => e.naics.startsWith(x));
    const region = cfg.countries[e.country];
    if (!p || !region) return [];
    const since = e.startedAt ? `; in business since ${e.startedAt.getUTCFullYear()}` : "";
    const where = [e.city, e.state].filter(Boolean).join(", ");
    return [{
      source: "sam_entities", name: e.name, query: `${e.name} ${e.city} company`, segment: cfg.naics_prefixes[p]!, regions: [region], knownRegion: region,
      website: e.website, mapsQuery: `${e.name} ${where}`,
      contacts: e.contact ? [{ name: e.contact.name, role: e.contact.title || "Business contact (SAM.gov)" }] : [],
      signal: { type: "new_federal_registrant", quote: `${e.name}${where ? ` (${where})` : ""} registered with SAM.gov to bid on US federal contracts on ${isoDay(e.registeredAt)} (primary NAICS ${e.naics}${since}).`,
        url: `https://sam.gov/entity/${e.uei}`, observedAt: e.registeredAt },
    }];
  });
}

/** The molecule a recall is about: openFDA's substance, else the leading words of the product description. */
export function recallSubstance(r: Recall): string | null {
  if (r.substances[0]) return r.substances[0];
  const m = r.product.toUpperCase().match(/^([A-Z][A-Z -]{3,40}?)(?=\s+(?:\d|USP|INJECTION|TABLETS?|CAPSULES?|ORAL|SOLUTION|FOR\b|EXTENDED|DELAYED|HCL|HYDROCHLORIDE|SODIUM|,|\())/);
  return m ? m[1]!.trim() : null;
}

export function recallRecords(r: Recall, holders: AndaHolder[], cfg: NonNullable<Niche["recalls"]>): NicheRecord[] {
  const firm = companyKey(r.firm).slice(0, 6);
  const substance = recallSubstance(r);
  if (!substance) return [];
  return holders.filter((h) => !companyKey(h.sponsor).startsWith(firm) && !h.labelers.some((l) => companyKey(l).startsWith(firm))).map((h) => {
    const name = fullName(h.labelers, titleName(h.sponsor));
    return {
      source: "fda_recalls", name, query: `${name} pharmaceutical company`, segment: cfg.segment, regions: cfg.regions, mustMention: PHARMA,
      signal: { type: "competitor_recall", quote: `${titleName(r.firm)} recalled ${shortDesc(r.product)} (FDA ${r.classification}: ${shortDesc(r.reason)}) on ${isoDay(r.reportedAt)} (recall ${r.recallNumber}). ${name} holds ANDA ${h.appNo} for ${title2(substance)}${h.marketed ? " and markets it" : ""}.`,
        url: `${h.url}#recall-${r.recallNumber}`, observedAt: r.reportedAt },
    };
  });
}
const title2 = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

type NewsCfg = Niche["news_events"][number];
export function newsRecords(items: NewsItem[], cfg: NewsCfg, now: Date): NicheRecord[] {
  const verbs = new RegExp(`\\s+(?:${cfg.verbs})\\b`, "i"), must = cfg.must ? new RegExp(cfg.must, "i") : null;
  const seen = new Set<string>();
  return items.flatMap((i) => {
    if (must && !must.test(i.title)) return [];
    const name = companyFromHeadline(i.title, verbs);
    if (!name || seen.has(companyKey(name))) return [];
    seen.add(companyKey(name));
    return [{
      source: `news_${cfg.id}`, name, query: cfg.segment === "auto" ? `${name} company ${cfg.region}` : `${name} ${cfg.segment.replace(/_/g, " ")} company ${cfg.region}`, segment: cfg.segment, regions: [cfg.region], knownRegion: cfg.region,
      ...(cfg.must_mention ? { mustMention: new RegExp(cfg.must_mention, "i") } : {}),
      signal: { type: cfg.signal_type, quote: `${i.title}${i.outlet ? ` (${i.outlet})` : ""}`, url: i.url, observedAt: i.postedAt && i.postedAt <= now ? i.postedAt : now },
    }];
  });
}

/** FDA's DMF list saved as CSV (DMF#, STATUS, TYPE, SUBMIT DATE, HOLDER, SUBJECT) x the shortage list (pure). */
export function dmfRecords(rows: Record<string, string>[], shortages: Shortage[], now: Date): NicheRecord[] {
  const col = (r: Record<string, string>, ...names: string[]) => { for (const n of names) for (const [k, v] of Object.entries(r)) if (k.toLowerCase().replace(/[^a-z]/g, "") === n) return v; return ""; };
  // the molecule's name, not its salt ("SODIUM BICARBONATE" needs both words; "LIDOCAINE HYDROCHLORIDE" just the first)
  const SALT = /^(SODIUM|POTASSIUM|CALCIUM|MAGNESIUM|ZINC|FERRIC|FERROUS|AMMONIUM|DEXTROSE|STERILE)$/;
  const subs = shortages.map((s) => { const w = s.substance.split(/\s+/).map((x) => x.replace(/[^A-Z0-9-]/g, "")); const core = SALT.test(w[0]!) ? w.slice(0, 2).join("\\s+") : w[0]!; return { s, rx: new RegExp(`\\b${core}\\b`, "i") }; });
  return rows.flatMap((r) => {
    if (!/^a/i.test(col(r, "status")) || !/^ii$/i.test(col(r, "type").trim())) return [];
    const subject = col(r, "subject"), holder = col(r, "holder").trim(), no = col(r, "dmf");
    const hit = subs.find((x) => x.rx.test(subject));
    if (!hit || !holder || !no) return [];
    const name = titleName(holder);
    return [{
      source: "fda_dmf", name, query: `${name} active pharmaceutical ingredient manufacturer`, segment: "pharma", regions: ["India", "United States of America"], mustMention: PHARMA,
      signal: { type: "shortage_dmf_holder", quote: `${hit.s.name} is on the FDA drug shortage list (${hit.s.availability.toLowerCase()}). ${name} holds active Type II DMF ${no} for ${subject.toLowerCase().slice(0, 120)}${col(r, "submitdate") ? ` (submitted ${col(r, "submitdate")})` : ""}.`,
        url: `https://www.fda.gov/drugs/drug-master-files-dmfs/list-drug-master-files-dmfs#dmf-${no}`, observedAt: now },
    }];
  });
}

export async function runNppes(deps: Deps & { fetch?: (tax: Set<string>, since: Date) => Promise<NewNpi[]> }): Promise<NicheResult> {
  const cfg = deps.pack.sources.niche.nppes;
  const g = guard("nppes", "nppes", cfg?.enabled && Object.keys(cfg.taxonomies).length > 0, deps); if (g) return g;
  const now = deps.now ?? new Date(), res = empty("nppes");
  try {
    const ns = await (deps.fetch ?? fetchNppesWeekly)(new Set(Object.keys(cfg!.taxonomies)), new Date(now.getTime() - cfg!.max_age_days * DAY));
    return await persistNicheRecords(nppesRecords(ns, cfg!), deps, res);
  } catch { res.errors++; return res; }
}

/** Two requests a day at most (personal SAM keys get 10): download yesterday's extract, request the next one. */
export async function runSamEntities(deps: Deps): Promise<NicheResult> {
  const cfg = deps.pack.sources.niche.sam_entities;
  const g = guard("sam_entities", "sam", cfg?.enabled && Object.keys(cfg.naics_prefixes).length > 0, deps); if (g) return g;
  const key = process.env.SAM_API_KEY;
  if (!key) return { ...empty("sam_entities"), skipped: "SAM_API_KEY not set" };
  const db = getDb(), now = deps.now ?? new Date(), res = empty("sam_entities");
  const state = { source: "sam_extract", sourceId: "pending" };
  const [pending] = await db.select().from(companySeeds).where(and(eq(companySeeds.source, state.source), eq(companySeeds.sourceId, state.sourceId))).limit(1);
  try {
    if (pending?.reason) {
      const es = await downloadSamExtract(key, pending.reason);
      if (!es) {
        if (pending.siteCheckedAt && now.getTime() - pending.siteCheckedAt.getTime() < 3 * DAY) return { ...res, skipped: "extract not ready yet" };
      } else await persistNicheRecords(samRecords(es, cfg!), deps, res);
    }
    const token = await requestSamExtract(key, new Date(now.getTime() - cfg!.days * DAY), new Date(now.getTime() - DAY));
    await db.insert(companySeeds).values({ ...state, fitPass: true, reason: token, siteCheckedAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: [companySeeds.source, companySeeds.sourceId], set: { reason: token, siteCheckedAt: now, updatedAt: now } });
  } catch { res.errors++; }
  return res;
}

export async function runRecalls(deps: Deps & { recalls?: (since: Date) => Promise<Recall[]>; holders?: (s: string) => Promise<AndaHolder[]> }): Promise<NicheResult> {
  const cfg = deps.pack.sources.niche.recalls;
  const g = guard("fda_recalls", "openfda", cfg?.enabled, deps); if (g) return g;
  const now = deps.now ?? new Date(), res = empty("fda_recalls");
  const records: NicheRecord[] = [];
  try {
    const rs = await (deps.recalls ?? ((s) => fetchRecalls("drug", s, now)))(new Date(now.getTime() - cfg!.max_age_days * DAY));
    const bySub = new Map<string, Recall>();
    for (const r of rs) { const s = recallSubstance(r); if (s && !bySub.has(s)) bySub.set(s, r); }
    for (const [s, r] of [...bySub].slice(0, 30)) {
      try { records.push(...recallRecords(r, await (deps.holders ?? ((x) => fetchAndaHolders(x, [])))(s), cfg!)); } catch { res.errors++; }
    }
  } catch { res.errors++; }
  return persistNicheRecords(records, deps, res);
}

export async function runNewsEvents(deps: Deps & { news?: (q: string, country: string) => Promise<NewsItem[]> }): Promise<NicheResult> {
  const n = deps.pack.sources.niche;
  const res = empty("news_events");
  if (!n.news_events.length || !n.news_per_day) return { ...res, skipped: "no news_events in the pack" };
  const key = process.env.SERPER_API_KEY;
  if (!deps.news && !key) return { ...res, skipped: "SERPER_API_KEY not set" };
  if (!deps.companies && !process.env.EXA_API_KEY) return { ...res, skipped: "EXA_API_KEY not set" };
  applyPackIdentity(deps.pack);
  const usage = deps.usage ?? neonUsage(), now = deps.now ?? new Date();
  const all = n.news_events.flatMap((e) => e.queries.map((q) => ({ e, q })));
  const used = await usage.spentToday("serper_news_events");
  // rotate through every event x query across days
  const day = Math.floor(now.getTime() / DAY);
  const picks = Array.from({ length: Math.max(0, Math.min(all.length, n.news_per_day - used)) }, (_, i) => all[(day * n.news_per_day + used + i) % all.length]!);
  const records: NicheRecord[] = [];
  for (const { e, q } of picks) {
    await usage.addSpend("serper_news_events", 1, n.news_per_day);
    try {
      const items = await (deps.news ?? ((qq, c) => serperNews({ apiKey: key!, country: c, timeRange: "w" })(qq)))(q, e.country);
      records.push(...newsRecords(items, e, now));
    } catch { res.errors++; }
  }
  return persistNicheRecords(records, deps, res);
}
