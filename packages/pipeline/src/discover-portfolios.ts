import type { Pack } from "@tell/config";
import { listPortfolio, fetchPortfolioCompany, findBoardLinks, fetchBoardPostings, isSourceEnabled, type Ats } from "@tell/watchers";
import { passesHardFilters, regionFromPostings, looksLikeStaffing } from "@tell/intel";
import { registrableDomain, checkHomepage, domainLists } from "@tell/people";
import { getDb, accounts, jobBoards, companySeeds, and, eq, inArray, sql } from "@tell/db";
import { applyPackIdentity } from "./scheduled.js";
import { ownPages } from "./boards.js";

export interface PortfolioDiscoveryResult {
  sources: number;
  listed: number;
  due: number;
  checked: number;
  noWebsite: number;
  badSite: number;
  filtered: number;
  accountsNew: number;
  withBoard: number;
  india: number;
}

/**
 * Weekly: companies on the pack's portfolio pages become accounts, and their job boards are found on their own sites.
 * The domain is the website the portfolio page states (homepage must load on the same brand). The account's region
 * comes from its board's job locations; without a board it stays unknown (never inferred from the investor).
 */
export async function runPortfolioDiscovery(opts: { pack: Pack; recheckDays?: number; maxCompanies?: number }): Promise<PortfolioDiscoveryResult> {
  const res: PortfolioDiscoveryResult = { sources: 0, listed: 0, due: 0, checked: 0, noWebsite: 0, badSite: 0, filtered: 0, accountsNew: 0, withBoard: 0, india: 0 };
  const sources = opts.pack.sources.portfolios;
  if (!sources.length || !isSourceEnabled("portfolio")) return res;
  applyPackIdentity(opts.pack);
  const db = getDb();
  const lists = domainLists(opts.pack.domains);
  const now = new Date();
  const recheck = new Date(now.getTime() - (opts.recheckDays ?? 30) * 86_400_000);
  let budget = opts.maxCompanies ?? 200;

  for (const src of sources) {
    let pages: string[];
    try { pages = await listPortfolio(src); res.sources++; } catch { continue; }
    res.listed += pages.length;
    const key = `portfolio:${src.id}`;
    const seen = new Map((await db.select({ id: companySeeds.sourceId, at: companySeeds.siteCheckedAt }).from(companySeeds)
      .where(and(eq(companySeeds.source, key), pages.length ? inArray(companySeeds.sourceId, pages) : sql`false`))).map((r) => [r.id, r.at]));
    const due = pages.filter((p) => { const at = seen.get(p); return !at || at < recheck; }).slice(0, Math.max(0, budget));
    budget -= due.length;
    res.due += due.length;

    for (const url of due) {
      const v = await check(url, src.website_labels).catch(() => ({ reason: "error" } as Verdict));
      res.checked++;
      if (v.reason === "no-website") res.noWebsite++;
      else if (v.reason === "bad-site" || v.reason === "error") res.badSite++;
      else if (v.reason.startsWith("filtered")) res.filtered++;
      else if (v.reason === "resolved") {
        if (v.isNew) res.accountsNew++;
        if (v.boards) res.withBoard++;
        if (v.region === "India") res.india++;
      }
      await db.insert(companySeeds).values({ source: key, sourceId: url, domain: v.domain ?? null, fitPass: v.reason === "resolved", reason: v.reason, siteCheckedAt: now, updatedAt: now })
        .onConflictDoUpdate({ target: [companySeeds.source, companySeeds.sourceId], set: { domain: v.domain ?? null, fitPass: v.reason === "resolved", reason: v.reason, siteCheckedAt: now, updatedAt: now } });
    }
  }
  return res;

  type Verdict = { reason: string; domain?: string; isNew?: boolean; boards?: number; region?: string | null };

  async function check(url: string, labels: string[]): Promise<Verdict> {
    const c = await fetchPortfolioCompany(url, labels);
    const site = c?.website ? registrableDomain(c.website) : null;
    if (!c || !site || lists.neverCompany.has(site) || lists.freeMail.has(site)) return { reason: "no-website" };
    if (looksLikeStaffing(c.name, [])) return { reason: "filtered: staffing", domain: site };
    const home = await checkHomepage(site);
    if (!home.ok) return { reason: "bad-site", domain: site };
    const domain = home.finalDomain ?? site;
    const fit = passesHardFilters({ domain, teamSize: null, industries: [], status: null }, opts.pack.icp);
    if (!fit.pass) return { reason: `filtered: ${fit.reason}`, domain };

    // boards linked from the company's own pages (readable = real), region from their job locations
    const boards: { ats: Ats; slug: string; proofUrl: string }[] = [];
    const postings = [];
    for (const p of await ownPages(`https://${domain}`)) {
      for (const b of findBoardLinks(p.html).slice(0, 3)) {
        if (boards.some((x) => x.ats === b.ats && x.slug === b.slug)) continue;
        try { postings.push(...(await fetchBoardPostings(b.ats, b.slug))); boards.push({ ...b, proofUrl: p.url }); } catch { /* not a readable board */ }
      }
    }
    const region = regionFromPostings(postings);
    const before = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.domain, domain)).limit(1);
    const [acc] = await db.insert(accounts).values({ domain, name: c.name, region })
      .onConflictDoUpdate({ target: accounts.domain, set: { name: sql`coalesce(${accounts.name}, excluded.name)`, region: sql`coalesce(${accounts.region}, excluded.region)` } })
      .returning({ id: accounts.id });
    if (boards.length) {
      await db.insert(jobBoards).values(boards.map((b) => ({ accountId: acc!.id, source: b.ats, slug: b.slug, proofUrl: b.proofUrl })))
        .onConflictDoNothing({ target: [jobBoards.source, jobBoards.slug] });
    }
    return { reason: "resolved", domain, isNew: before.length === 0, boards: boards.length, region };
  }
}
