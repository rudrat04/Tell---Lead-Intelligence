import type { Pack } from "@tell/config";
import {
  ccLatestIndex, ccUrls, tenantsFromUrls, fetchKekaTenant, fetchFreshteamTenant, kekaPortal, findBoardLinks, robotsAllows, userAgent,
  type AtsTenant, type Ats,
} from "@tell/watchers";
import { passesHardFilters, regionFromPostings, looksLikeStaffing, classifyJob, compileRoles } from "@tell/intel";
import { domainLists, rawCandidates, filterCandidates, nameMatchesDomain, registrableDomain, type DomainLists } from "@tell/people";
import { getDb, accounts, jobBoards, companySeeds, eq, and, sql } from "@tell/db";
import { applyPackIdentity } from "./scheduled.js";
import { ownPages } from "./boards.js";

/**
 * Weekly discovery beyond YC: ATS tenants common with Indian companies (Keka, Freshteam), listed from Common Crawl.
 * A tenant becomes an account only when its company is proven: some candidate website's own pages must link back
 * to that exact board (the same ownership proof as own-site discovery). Tenant names and slugs only suggest which
 * sites to check; nothing is accepted on a name match alone.
 */

interface CcAts {
  ats: Extract<Ats, "keka" | "freshteam">;
  suffix: string;
  fetchTenant: (t: string) => Promise<AtsTenant | null>;
  portal: (t: string) => string;
}

const SOURCES: CcAts[] = [
  { ats: "keka", suffix: "keka.com", fetchTenant: fetchKekaTenant, portal: kekaPortal },
  { ats: "freshteam", suffix: "freshteam.com", fetchTenant: fetchFreshteamTenant, portal: (t) => `https://${t}.freshteam.com/jobs` },
];

/** Registrable domain a site's homepage ends up on after redirects, or null if it doesn't load. */
async function landingDomain(domain: string): Promise<string | null> {
  try {
    const r = await fetch(`https://${domain}`, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(10_000), headers: { "user-agent": userAgent() } });
    await r.body?.cancel();
    return r.ok ? registrableDomain(r.url) : null;
  } catch { return null; }
}

const TLDS = ["com", "in", "co.in", "io", "ai", "co", "tech", "app"];
const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");

/** Websites to check for a backlink, most likely first. Exported for tests. */
export function siteCandidates(tenant: string, name: string | null, links: string[], lists: DomainLists, max = 12): string[] {
  const out: string[] = [];
  const add = (d: string | null) => { if (d && !out.includes(d)) out.push(d); };
  // links on the portal itself, if they look like the company
  const { company } = filterCandidates(links.flatMap((l) => rawCandidates(l)), lists);
  for (const c of company) if (!name || nameMatchesDomain(name, c.domain) || nameMatchesDomain(tenant, c.domain)) add(c.domain);
  // a name that is itself a domain ("Attentive.ai")
  if (name && /^[a-z0-9-]+(\.[a-z]{2,})+$/i.test(name.trim())) add(registrableDomain(name.trim()));
  const bases = new Set([tenant, tenant.replace(/-?(careers?|jobs|team|talent|hr|hiring|recruit\w*|india|in)$/, ""), tenant.replace(/-/g, ""), name ? norm(name) : ""]);
  for (const b of bases) {
    if (b.length < 3) continue;
    for (const t of TLDS) add(registrableDomain(`${b}.${t}`));
  }
  return out.filter((d) => !lists.neverCompany.has(d)).slice(0, max);
}

export interface CcDiscoveryResult {
  index: string | null;
  perAts: Record<string, { listed: number; complete: boolean }>;
  due: number;
  checked: number;
  noPortal: number;
  noRoles: number;
  staffing: number;
  unresolved: number;
  filtered: number;
  resolved: number;
  india: number;
  withGtmRoles: number;
  boardsNew: number;
}

export async function runCcDiscovery(opts: { pack: Pack; maxTenants?: number; recheckDays?: number }): Promise<CcDiscoveryResult> {
  applyPackIdentity(opts.pack);
  const db = getDb();
  const lists = domainLists(opts.pack.domains);
  const roles = compileRoles(opts.pack.roles);
  const now = new Date();
  const res: CcDiscoveryResult = { index: null, perAts: {}, due: 0, checked: 0, noPortal: 0, noRoles: 0, staffing: 0, unresolved: 0, filtered: 0, resolved: 0, india: 0, withGtmRoles: 0, boardsNew: 0 };

  try { res.index = await ccLatestIndex(); } catch { return res; } // index down: YC-only this week

  // 1. list tenants per ATS into company_seeds (one Common Crawl request at a time)
  for (const s of SOURCES) {
    const { urls, complete } = await ccUrls(res.index, `*.${s.suffix}`);
    const tenants = tenantsFromUrls(urls, s.suffix);
    res.perAts[s.ats] = { listed: tenants.length, complete };
    for (let i = 0; i < tenants.length; i += 500) {
      await db.insert(companySeeds)
        .values(tenants.slice(i, i + 500).map((t) => ({ source: `cc-${s.ats}`, sourceId: t, fitPass: false, reason: "unchecked", updatedAt: now })))
        .onConflictDoNothing();
    }
  }

  // 2. check due tenants (never checked, or not in the last recheckDays), bounded per run
  const recheck = `${opts.recheckDays ?? 30} days`;
  const due = (await db.execute(sql`select source, source_id from company_seeds
    where source in ('cc-keka', 'cc-freshteam') and (site_checked_at is null or site_checked_at < now() - ${recheck}::interval)
    order by site_checked_at asc nulls first, source_id limit ${opts.maxTenants ?? 300}`)).rows as { source: string; source_id: string }[];
  res.due = due.length;

  const queue = [...due];
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const { source, source_id: tenant } = queue.shift()!;
      const s = SOURCES.find((x) => `cc-${x.ats}` === source)!;
      const verdict = await checkTenant(s, tenant).catch(() => ({ reason: "error" } as Verdict));
      res.checked++;
      if (verdict.reason === "no-portal" || verdict.reason === "robots" || verdict.reason === "error") res.noPortal++;
      else if (verdict.reason === "no-roles") res.noRoles++;
      else if (verdict.reason === "staffing") res.staffing++;
      else if (verdict.reason === "no-backlink") res.unresolved++;
      else if (verdict.reason.startsWith("filtered")) res.filtered++;
      else if (verdict.reason === "resolved") {
        res.resolved++;
        if (verdict.region === "India") res.india++;
        if (verdict.gtmRoles) res.withGtmRoles++;
        if (verdict.boardNew) res.boardsNew++;
      }
      await db.update(companySeeds).set({ domain: verdict.domain ?? null, fitPass: verdict.reason === "resolved", reason: verdict.reason, siteCheckedAt: now, updatedAt: now })
        .where(and(eq(companySeeds.source, source), eq(companySeeds.sourceId, tenant)));
    }
  }));
  return res;

  type Verdict = { reason: string; domain?: string; region?: string | null; gtmRoles?: boolean; boardNew?: boolean };

  async function checkTenant(s: CcAts, tenant: string): Promise<Verdict> {
    if (!(await robotsAllows(s.portal(tenant)))) return { reason: "robots" };
    const t = await s.fetchTenant(tenant);
    if (!t) return { reason: "no-portal" };
    if (!t.postings.length) return { reason: "no-roles" };
    if (looksLikeStaffing(t.name, t.postings.map((p) => p.text))) return { reason: "staffing" };

    let proof: { domain: string; url: string } | null = null;
    const tried = new Set<string>();
    for (const cand of siteCandidates(tenant, t.name, t.links, lists)) {
      // follow the homepage redirect first (asint.com -> asint.net): the proof must be on the site it lands on
      const d = await landingDomain(cand);
      if (!d || tried.has(d) || lists.neverCompany.has(d)) continue;
      tried.add(d);
      for (const page of await ownPages(`https://${d}`)) {
        if (findBoardLinks(page.html).some((b) => b.ats === s.ats && b.slug === tenant)) { proof = { domain: registrableDomain(page.url) ?? d, url: page.url }; break; }
      }
      if (proof) break;
    }
    if (!proof) return { reason: "no-backlink" };

    const fit = passesHardFilters({ domain: proof.domain, teamSize: null, industries: [], status: null }, opts.pack.icp);
    if (!fit.pass) return { reason: `filtered: ${fit.reason}`, domain: proof.domain };

    const region = regionFromPostings(t.postings);
    const [acc] = await db.insert(accounts).values({ domain: proof.domain, name: t.name, region })
      .onConflictDoUpdate({ target: accounts.domain, set: { name: sql`coalesce(${accounts.name}, excluded.name)`, region: sql`coalesce(${accounts.region}, excluded.region)` } })
      .returning({ id: accounts.id });
    const board = await db.insert(jobBoards).values({ accountId: acc!.id, source: s.ats, slug: t.slug, proofUrl: proof.url })
      .onConflictDoNothing({ target: [jobBoards.source, jobBoards.slug] }).returning({ id: jobBoards.id });
    const gtmRoles = t.postings.some((p) => classifyJob(p.title, p.employmentType, roles));
    return { reason: "resolved", domain: proof.domain, region, gtmRoles, boardNew: board.length > 0 };
  }
}
