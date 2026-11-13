import type { Pack } from "@tell/config";
import { searchWorkable, fetchWorkableAccount, fetchWorkablePostings, subdomainCandidates, findBoardLinks, type WorkableHit } from "@tell/watchers";
import { passesHardFilters, regionFromPostings, looksLikeStaffing, classifyJob, compileRoles } from "@tell/intel";
import { registrableDomain, checkHomepage, domainLists } from "@tell/people";
import { getDb, accounts, jobBoards, companySeeds, and, eq, inArray, sql } from "@tell/db";
import { applyPackIdentity } from "./scheduled.js";
import { ownPages } from "./boards.js";

export interface WorkableDiscoveryResult {
  queries: number;
  hits: number;
  companies: number;
  due: number;
  checked: number;
  noWebsite: number;
  badSite: number;
  noBoard: number;
  staffing: number;
  notRegion: number;
  filtered: number;
  resolved: number;
  india: number;
  withGtmRoles: number;
  boardsNew: number;
}

interface Company { id: string; name: string; website: string | null; hits: WorkableHit[] }

/** Group search hits by Workable company (exported for tests). */
export function groupHits(hits: WorkableHit[]): Company[] {
  const by = new Map<string, Company>();
  for (const h of hits) {
    const c = by.get(h.companyId) ?? { id: h.companyId, name: h.companyName, website: h.website, hits: [] };
    if (!c.hits.some((x) => x.jobId === h.jobId)) c.hits.push(h);
    c.website ??= h.website;
    by.set(h.companyId, c);
  }
  return [...by.values()];
}

/**
 * Weekly: companies hiring the pack's roles in its Workable location become accounts with a tracked Workable board.
 * Never guessed: the domain is the website the company set in Workable (its homepage must load on the same brand);
 * the board subdomain is accepted only when Workable's account API returns the same account id as the search.
 * Region comes from the board's job locations, never from the search filter.
 */
export async function runWorkableDiscovery(opts: { pack: Pack; recheckDays?: number }): Promise<WorkableDiscoveryResult> {
  const cfg = opts.pack.sources.workable;
  const res: WorkableDiscoveryResult = { queries: 0, hits: 0, companies: 0, due: 0, checked: 0, noWebsite: 0, badSite: 0, noBoard: 0, staffing: 0, notRegion: 0, filtered: 0, resolved: 0, india: 0, withGtmRoles: 0, boardsNew: 0 };
  if (!cfg.enabled || !cfg.queries.length) return res;
  applyPackIdentity(opts.pack);
  const db = getDb();
  const lists = domainLists(opts.pack.domains);
  const roles = compileRoles(opts.pack.roles);
  const now = new Date();

  const hits: WorkableHit[] = [];
  for (const q of cfg.queries) {
    try { hits.push(...(await searchWorkable(q, cfg.location, { dayRange: cfg.day_range, maxPages: cfg.max_pages }))); res.queries++; }
    catch { /* one query failing doesn't stop the rest */ }
  }
  res.hits = hits.length;
  const companies = groupHits(hits);
  res.companies = companies.length;

  // skip companies checked recently (company_seeds keyed by Workable's company id)
  const recheck = new Date(now.getTime() - (opts.recheckDays ?? 30) * 86_400_000);
  const seen = new Map<string, Date | null>();
  for (let i = 0; i < companies.length; i += 500) {
    const part = companies.slice(i, i + 500).map((c) => c.id);
    for (const r of await db.select({ id: companySeeds.sourceId, at: companySeeds.siteCheckedAt }).from(companySeeds)
      .where(and(eq(companySeeds.source, "workable"), inArray(companySeeds.sourceId, part)))) seen.set(r.id, r.at);
  }
  const due = companies.filter((c) => { const at = seen.get(c.id); return !at || at < recheck; }).slice(0, cfg.max_companies);
  res.due = due.length;

  for (const c of due) {
    const v = await check(c).catch(() => ({ reason: "error" } as Verdict));
    res.checked++;
    const k = v.reason;
    if (k === "no-website") res.noWebsite++;
    else if (k === "bad-site" || k === "error") res.badSite++;
    else if (k === "no-board") res.noBoard++;
    else if (k === "staffing") res.staffing++;
    else if (k === "not-region") res.notRegion++;
    else if (k.startsWith("filtered")) res.filtered++;
    else if (k === "resolved") {
      res.resolved++;
      if (v.region === "India") res.india++;
      if (v.gtmRoles) res.withGtmRoles++;
      if (v.boardNew) res.boardsNew++;
    }
    await db.insert(companySeeds).values({ source: "workable", sourceId: c.id, domain: v.domain ?? null, fitPass: k === "resolved", reason: k, siteCheckedAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: [companySeeds.source, companySeeds.sourceId], set: { domain: v.domain ?? null, fitPass: k === "resolved", reason: k, siteCheckedAt: now, updatedAt: now } });
  }
  return res;

  type Verdict = { reason: string; domain?: string; region?: string | null; gtmRoles?: boolean; boardNew?: boolean };

  async function check(c: Company): Promise<Verdict> {
    if (looksLikeStaffing(c.name, [])) return { reason: "staffing" };
    const site = c.website ? registrableDomain(c.website) : null;
    if (!site || lists.neverCompany.has(site) || lists.freeMail.has(site)) return { reason: "no-website" };
    const home = await checkHomepage(site);
    if (!home.ok) return { reason: "bad-site", domain: site };
    const domain = home.finalDomain ?? site;

    // board subdomain: own-site links first, then forms of the name; accepted only on an exact account-id match
    const linked = (await ownPages(`https://${domain}`)).flatMap((p) => findBoardLinks(p.html)).filter((b) => b.ats === "workable").map((b) => b.slug);
    let sub: string | null = null;
    for (const cand of subdomainCandidates(linked, c.name, domain)) {
      const acct = await fetchWorkableAccount(cand);
      if (acct?.uid === c.id) { sub = acct.subdomain; break; }
    }
    if (!sub) return { reason: "no-board", domain };

    const postings = await fetchWorkablePostings(sub);
    // regionFromPostings only recognises India: for an India search, require at least half the board's roles there
    const region = regionFromPostings(postings);
    if (cfg.location.toLowerCase() === "india" && region !== "India") return { reason: "not-region", domain };

    const fit = passesHardFilters({ domain, teamSize: null, industries: [], status: null }, opts.pack.icp);
    if (!fit.pass) return { reason: `filtered: ${fit.reason}`, domain };

    const [acc] = await db.insert(accounts).values({ domain, name: c.name, region })
      .onConflictDoUpdate({ target: accounts.domain, set: { name: sql`coalesce(${accounts.name}, excluded.name)`, region: sql`coalesce(${accounts.region}, excluded.region)` } })
      .returning({ id: accounts.id });
    const board = await db.insert(jobBoards).values({ accountId: acc!.id, source: "workable", slug: sub, proofUrl: `https://apply.workable.com/api/v1/accounts/${sub}` })
      .onConflictDoNothing({ target: [jobBoards.source, jobBoards.slug] }).returning({ id: jobBoards.id });
    const gtmRoles = postings.some((p) => classifyJob(p.title, p.employmentType, roles));
    return { reason: "resolved", domain, region, gtmRoles, boardNew: board.length > 0 };
  }
}
