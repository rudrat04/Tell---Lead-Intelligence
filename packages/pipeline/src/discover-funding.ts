import type { Pack } from "@tell/config";
import {
  serperNews, isFundingHeadline, companiesFromNews, companyKey, exaCompanySearch, isSourceEnabled, pickQueries,
  type NewsItem, type CompanyHit, type FundedCompany,
} from "@tell/watchers";
import { passesHardFilters, regionInScope, INDIA_LOCATION } from "@tell/intel";
import { registrableDomain, nameMatchesDomain, checkHomepage, domainLists, type DomainLists } from "@tell/people";
import { getDb, accounts, signals, companySeeds, and, eq, inArray, sql } from "@tell/db";
import { applyPackIdentity } from "./scheduled.js";
import { neonUsage, type UsageStore } from "./usage.js";
import { bandForHeadcount } from "./company-facts.js";

const SOURCE = "funding_news";
/** A company name seen again is re-tried after this long (a failed match may resolve once Exa indexes the site). */
const RETRY_DAYS = 30;
const DAY = 86_400_000;

export interface FundingDiscoveryResult {
  searches: number; errors: number; headlines: number; companies: number; fresh: number; looked: number;
  noMatch: number; notRegion: number; badSite: number; filtered: number; resolved: number; accountsNew: number; skipped?: string;
}

/** Normalise an Exa country ("IN", "India", "Republic of India") to the region names scoring uses. */
const regionName = (c: string | null) => (c && /^(in|ind|india|republic of india)$/i.test(c.trim()) ? "India" : c);

/**
 * The company record for a funding headline's company (pure; exported for tests). Two independent matches, never a
 * name alone: the record's company name is the headline's name, AND its website's domain carries that name
 * (nameMatchesDomain). Tool, vendor, ATS and free-mail domains are never a company.
 */
/** "Arborum Labs", "Arborum Labs Pvt Ltd" and "Arborum" are one name: legal and generic suffixes are dropped. */
export const nameKey = (name: string) =>
  companyKey(name.replace(/\b(private|pvt\.?|limited|ltd\.?|llp|inc\.?|llc|corp\.?|technologies|technology|tech|labs?|solutions|india|ai|hq)\b/gi, " ")) || companyKey(name);

export function companyForName(name: string, hits: CompanyHit[], lists: DomainLists): { hit: CompanyHit; domain: string } | null {
  const key = nameKey(name);
  const ok = hits.flatMap((h) => {
    const domain = registrableDomain(h.url);
    if (!domain || /linkedin\.com|crunchbase\.com|tracxn\.com/i.test(domain)) return [];
    if (lists.neverCompany.has(domain) || lists.freeMail.has(domain)) return [];
    return nameKey(h.name) === key && nameMatchesDomain(name, domain) ? [{ hit: h, domain }] : [];
  });
  // two different domains for one name: ambiguous, never guess
  return new Set(ok.map((x) => x.domain)).size === 1 ? ok[0]! : null;
}

/**
 * Daily: freshly funded companies from news headlines (pack sources.funding_news) become accounts with a funding_raise
 * signal (quote = headline, URL = the article). Each new name costs one or two Exa company searches (name, then name + headline; counted in usage_daily `exa_funding`); the domain must match the
 * name, the homepage must load on the same brand, and the HQ must be in a region the ICP targets. Names are remembered
 * in company_seeds, so a story reported by five outlets is looked up once.
 */
export async function runFundingDiscovery(opts: {
  pack: Pack; news?: (q: string) => Promise<NewsItem[]>; companies?: (q: string) => Promise<CompanyHit[]>; usage?: UsageStore; now?: Date;
}): Promise<FundingDiscoveryResult> {
  const res: FundingDiscoveryResult = { searches: 0, errors: 0, headlines: 0, companies: 0, fresh: 0, looked: 0, noMatch: 0, notRegion: 0, badSite: 0, filtered: 0, resolved: 0, accountsNew: 0 };
  const cfg = opts.pack.sources.funding_news;
  if (!cfg.enabled || !cfg.queries.length) return { ...res, skipped: "disabled in the pack" };
  if (!isSourceEnabled(SOURCE)) return { ...res, skipped: "disabled by source policy" };
  const apiKey = process.env.SERPER_API_KEY;
  if (!opts.news && !apiKey) return { ...res, skipped: "SERPER_API_KEY not set" };
  if (!opts.companies && !process.env.EXA_API_KEY) return { ...res, skipped: "EXA_API_KEY not set" };
  applyPackIdentity(opts.pack);
  const db = getDb();
  const now = opts.now ?? new Date();
  const usage = opts.usage ?? neonUsage();
  const lists = domainLists(opts.pack.domains);
  const news = opts.news ?? serperNews({ apiKey: apiKey!, country: cfg.country, timeRange: cfg.time_range });
  const search = opts.companies ?? ((q: string) => exaCompanySearch(q));
  // every company search counts in the Exa usage guard (usage_daily "exa_funding"), before the request
  const companies = async (q: string) => { await usage.addSpend("exa_funding", 1, cfg.per_run * 2); return search(q); };

  // 1. headlines (rotating queries, counted before each request so a failure still counts)
  const used = await usage.spentToday("serper_news");
  const items: NewsItem[] = [];
  for (const q of pickQueries(cfg.queries, cfg.per_day, used, cfg.per_day, now)) {
    await usage.addSpend("serper_news", 1, cfg.per_day);
    res.searches++;
    try { items.push(...(await news(q)).filter((i) => isFundingHeadline(i.title, cfg.keywords, cfg.exclude))); }
    catch { res.errors++; }
  }
  res.headlines = items.length;
  const found = companiesFromNews(items);
  res.companies = found.length;

  // 2. names not looked up recently
  const keys = found.map((c) => companyKey(c.name));
  const seen = new Map((await db.select({ id: companySeeds.sourceId, at: companySeeds.siteCheckedAt }).from(companySeeds)
    .where(and(eq(companySeeds.source, SOURCE), keys.length ? inArray(companySeeds.sourceId, keys) : sql`false`))).map((r) => [r.id, r.at]));
  const due = found.filter((c) => { const at = seen.get(companyKey(c.name)); return !at || now.getTime() - at.getTime() > RETRY_DAYS * DAY; });
  res.fresh = due.length;

  for (const c of due.slice(0, cfg.per_run)) {
    res.looked++;
    const v = await check(c).catch(() => ({ reason: "error" } as Verdict));
    if (v.reason === "no-match" || v.reason === "error") res.noMatch++;
    else if (v.reason === "not-region") res.notRegion++;
    else if (v.reason === "bad-site") res.badSite++;
    else if (v.reason.startsWith("filtered")) res.filtered++;
    else if (v.reason === "resolved") { res.resolved++; if (v.isNew) res.accountsNew++; }
    await db.insert(companySeeds).values({ source: SOURCE, sourceId: companyKey(c.name), domain: v.domain ?? null, fitPass: v.reason === "resolved", reason: v.reason, siteCheckedAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: [companySeeds.source, companySeeds.sourceId], set: { domain: v.domain ?? null, fitPass: v.reason === "resolved", reason: v.reason, siteCheckedAt: now, updatedAt: now } });
  }
  return res;

  type Verdict = { reason: string; domain?: string; isNew?: boolean };

  async function check(c: FundedCompany): Promise<Verdict> {
    // the name alone finds the company's own record best; the headline helps when the name is common
    const m = companyForName(c.name, await companies(c.name), lists) ?? companyForName(c.name, await companies(`${c.name}. ${c.headline}`), lists);
    if (!m) return { reason: "no-match" };
    // HQ from the company record; with none, India only when its own description or the headline names an Indian
    // place ("Bengaluru-based", "Indian startup"); otherwise unknown, which is out (as in scoring)
    const region = regionName(m.hit.country) ?? (INDIA_LOCATION.test(`${m.hit.description} ${c.headline}`) ? "India" : null);
    if (!region || !regionInScope(region, opts.pack.icp)) return { reason: "not-region", domain: m.domain };
    const home = await checkHomepage(m.domain);
    if (!home.ok) return { reason: "bad-site", domain: m.domain };
    const domain = home.finalDomain ?? m.domain;
    if (domain !== m.domain && !nameMatchesDomain(c.name, domain)) return { reason: "bad-site", domain };
    const fit = passesHardFilters({ domain, teamSize: m.hit.employees, industries: [], status: null }, opts.pack.icp);
    if (!fit.pass) return { reason: `filtered: ${fit.reason}`, domain };
    const sizeBand = m.hit.employees ? bandForHeadcount(m.hit.employees, opts.pack.icp) : null;
    const before = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.domain, domain)).limit(1);
    const [acc] = await db.insert(accounts).values({ domain, name: c.name, region, sizeBand })
      .onConflictDoUpdate({ target: accounts.domain, set: {
        name: sql`coalesce(${accounts.name}, excluded.name)`, region: sql`coalesce(${accounts.region}, excluded.region)`, sizeBand: sql`coalesce(${accounts.sizeBand}, excluded.size_band)`,
      } })
      .returning({ id: accounts.id });
    const spec = opts.pack.signals.signals.funding_raise!;
    await db.insert(signals).values({ accountId: acc!.id, class: spec.class, type: "funding_raise", strength: spec.strength, evidenceQuote: c.headline.slice(0, 500),
      evidenceUrl: c.url, observedAt: c.postedAt ?? now, halfLifeDays: spec.half_life_days })
      .onConflictDoNothing({ target: [signals.evidenceUrl, signals.type] });
    return { reason: "resolved", domain, isNew: before.length === 0 };
  }
}
