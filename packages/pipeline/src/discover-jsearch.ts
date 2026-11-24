import type { Pack } from "@tell/config";
import { searchJSearch, findBoardLinks, fetchBoardPostings, type JSearchJob, type JSearchQuery } from "@tell/watchers";
import { passesHardFilters, regionFromPostings, regionInScope, looksLikeStaffing, classifyJob, compileRoles, type JobClass } from "@tell/intel";
import { registrableDomain, checkHomepage, domainLists, nameMatchesDomain, type DomainLists } from "@tell/people";
import { getDb, accounts, jobBoards, jobs, companySeeds, usageDaily, and, eq, inArray, sql } from "@tell/db";
import { applyPackIdentity } from "./scheduled.js";
import { ownPages } from "./boards.js";
import { istDay } from "./usage.js";

/**
 * Daily: JSearch (Google for Jobs: LinkedIn, Naukri, Indeed, company sites) finds companies hiring the pack's roles,
 * mostly the Indian companies that have no Greenhouse/Lever/Ashby board. Their roles go into `jobs` as state:
 * - a company whose own site links a readable ATS board gets that board tracked (the daily diff takes over);
 * - otherwise the roles live on a "jsearch" board (slug = domain), refreshed whenever a search sees them again and
 *   closed once unseen for `close_after_days` (we can't re-check them, so they age out instead).
 * Never guessed: the domain is JSearch's employer website or the apply link's own site, and must match the
 * employer's name; region comes from the job locations.
 */

/** Job sites and ATS hosts: an apply link there says nothing about the employer's own domain. */
const JOB_SITES = new Set([
  "linkedin.com", "naukri.com", "indeed.com", "glassdoor.com", "glassdoor.co.in", "foundit.in", "monsterindia.com", "instahyre.com",
  "cutshort.io", "wellfound.com", "angel.co", "iimjobs.com", "hirist.tech", "hirist.com", "shine.com", "apna.co", "timesjobs.com",
  "freshersworld.com", "ziprecruiter.com", "jooble.org", "talent.com", "simplyhired.com", "updazz.com", "internshala.com", "workindia.in",
  "greenhouse.io", "lever.co", "ashbyhq.com", "keka.com", "freshteam.com", "workable.com", "zohorecruit.com", "zohorecruit.in",
  "darwinbox.in", "smartrecruiters.com", "recruitee.com", "myworkdayjobs.com", "bamboohr.com", "breezy.hr", "jobvite.com", "icims.com",
  "taleo.net", "oraclecloud.com", "successfactors.com", "teamtailor.com", "personio.de", "jobs.ashbyhq.com", "superset.com", "hirect.in",
]);

export interface JSearchRunResult {
  requests: number;
  monthUsed: number;
  errors: number;
  hits: number;
  roleHits: number;
  employers: number;
  cached: number;
  noWebsite: number;
  badSite: number;
  staffing: number;
  notRegion: number;
  filtered: number;
  resolved: number;
  india: number;
  ownBoards: number;
  jobsSeen: number;
  jobsClosed: number;
}

/** Day-rotated slice of the queries: `n` distinct ones, a different start each day. */
export function pickRotating<T>(items: T[], n: number, now: Date): T[] {
  if (!items.length || n <= 0) return [];
  const day = Math.floor(now.getTime() / 86_400_000);
  const k = Math.min(n, items.length);
  return Array.from({ length: k }, (_, i) => items[(day * k + i) % items.length]!);
}

/** Searches allowed this run: at most per_run, and paced so the month's quota is spread over its days
 *  (by day d of a 30-day month, at most per_month * d / 30 used). A small quota then runs every few days, not all at once. */
export function allowedRequests(perRun: number, perMonth: number, usedThisMonth: number, istDate: string): number {
  const [y, m, d] = istDate.split("-").map(Number) as [number, number, number];
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const paced = Math.floor((perMonth * d) / daysInMonth);
  return Math.max(0, Math.min(perRun, paced - usedThisMonth, perMonth - usedThisMonth));
}

/** The employer's own domain: JSearch's website, else the apply link's site. It must match the employer's name. */
export function employerDomain(j: Pick<JSearchJob, "employer" | "website" | "applyLink">, lists: DomainLists): string | null {
  for (const u of [j.website, j.applyLink]) {
    const d = u ? registrableDomain(u) : null;
    if (!d || JOB_SITES.has(d) || lists.neverCompany.has(d) || lists.freeMail.has(d)) continue;
    if (nameMatchesDomain(j.employer, d)) return d;
  }
  return null;
}

const employerKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

interface Employer { key: string; name: string; hits: (JSearchJob & { cls: JobClass })[] }

export function groupEmployers(hits: (JSearchJob & { cls: JobClass })[]): Employer[] {
  const by = new Map<string, Employer>();
  for (const h of hits) {
    const key = employerKey(h.employer);
    const e = by.get(key) ?? { key, name: h.employer, hits: [] };
    // the same role is often listed by several publishers (LinkedIn, Naukri, the company site): keep one per title
    if (!e.hits.some((x) => x.jobId === h.jobId || x.title.toLowerCase() === h.title.toLowerCase())) e.hits.push(h);
    by.set(key, e);
  }
  return [...by.values()];
}

export async function monthUsed(service: string, now: Date): Promise<number> {
  const month = istDay(now).slice(0, 7);
  const [r] = await getDb().select({ used: sql<number>`coalesce(sum(${usageDaily.used}), 0)` }).from(usageDaily)
    .where(and(eq(usageDaily.service, service), sql`to_char(${usageDaily.day}, 'YYYY-MM') = ${month}`));
  return Number(r?.used ?? 0);
}

export async function countRequest(service: string, limit: number, now: Date) {
  await getDb().insert(usageDaily).values({ day: istDay(now), service, used: 1, limit })
    .onConflictDoUpdate({ target: [usageDaily.day, usageDaily.service], set: { used: sql`${usageDaily.used} + 1`, limit } });
}

export async function runJSearch(opts: {
  pack: Pack;
  now?: Date;
  search?: (q: JSearchQuery) => Promise<JSearchJob[]>;
  recheckDays?: number;
}): Promise<JSearchRunResult> {
  const cfg = opts.pack.sources.jsearch;
  const now = opts.now ?? new Date();
  const res: JSearchRunResult = { requests: 0, monthUsed: 0, errors: 0, hits: 0, roleHits: 0, employers: 0, cached: 0, noWebsite: 0, badSite: 0, staffing: 0, notRegion: 0, filtered: 0, resolved: 0, india: 0, ownBoards: 0, jobsSeen: 0, jobsClosed: 0 };
  if (!cfg.enabled || !cfg.queries.length) return res;
  applyPackIdentity(opts.pack);
  const db = getDb();
  const lists = domainLists(opts.pack.domains);
  const roles = compileRoles(opts.pack.roles);
  const search = opts.search ?? ((q: JSearchQuery) => searchJSearch(q));

  // 1. Searches, inside the monthly quota (each counted before it is sent; failures are not retried)
  res.monthUsed = await monthUsed("jsearch", now);
  const n = allowedRequests(cfg.per_run, cfg.per_month, res.monthUsed, istDay(now));
  const found: JSearchJob[] = [];
  const places = cfg.locations.length ? cfg.locations : [{ location: cfg.location, country: cfg.country }];
  // place-major, so one run's consecutive picks are different queries (a place listed twice is searched twice as often)
  const pairs = places.flatMap((p) => cfg.queries.map((query) => ({ query, ...p })));
  for (const { query, location, country } of pickRotating(pairs, n, now)) {
    await countRequest("jsearch", cfg.per_month, now);
    res.requests++;
    try { found.push(...(await search({ query, location, country, datePosted: cfg.date_posted }))); }
    catch { res.errors++; }
  }
  res.monthUsed += res.requests;
  res.hits = found.length;

  // 2. Only the roles the pack cares about (same title rules as the job boards)
  const roleHits = found.flatMap((j) => { const cls = classifyJob(j.title, j.employmentType, roles); return cls ? [{ ...j, cls }] : []; });
  res.roleHits = roleHits.length;
  const employers = groupEmployers(roleHits);
  res.employers = employers.length;

  // 3. Resolution is cached 30 days per employer name (company_seeds); roles are refreshed on every sighting
  const recheck = new Date(now.getTime() - (opts.recheckDays ?? 30) * 86_400_000);
  const seeds = new Map<string, { domain: string | null; fitPass: boolean; reason: string | null; at: Date | null }>();
  if (employers.length) {
    for (const r of await db.select({ id: companySeeds.sourceId, domain: companySeeds.domain, fitPass: companySeeds.fitPass, reason: companySeeds.reason, at: companySeeds.siteCheckedAt })
      .from(companySeeds).where(and(eq(companySeeds.source, "jsearch"), inArray(companySeeds.sourceId, employers.map((e) => e.key))))) seeds.set(r.id, r);
  }

  for (const e of employers) {
    const seed = seeds.get(e.key);
    let v: { reason: string; domain?: string | null };
    if (seed?.at && seed.at > recheck) { v = { reason: seed.reason ?? (seed.fitPass ? "resolved" : "filtered"), domain: seed.domain }; res.cached++; }
    else {
      v = await resolve(e).catch(() => ({ reason: "bad-site" }));
      await db.insert(companySeeds).values({ source: "jsearch", sourceId: e.key, domain: v.domain ?? null, fitPass: v.reason === "resolved", reason: v.reason, siteCheckedAt: now, updatedAt: now })
        .onConflictDoUpdate({ target: [companySeeds.source, companySeeds.sourceId], set: { domain: v.domain ?? null, fitPass: v.reason === "resolved", reason: v.reason, siteCheckedAt: now, updatedAt: now } });
    }
    const k = v.reason;
    if (k === "no-website") res.noWebsite++;
    else if (k === "bad-site") res.badSite++;
    else if (k === "staffing") res.staffing++;
    else if (k === "not-region") res.notRegion++;
    else if (k.startsWith("filtered")) res.filtered++;
    else if (k === "resolved" && v.domain) {
      res.resolved++;
      await record(e, v.domain);
    }
  }

  // 4. Roles we can't re-check age out: closed once no search has seen them for close_after_days
  const stale = new Date(now.getTime() - cfg.close_after_days * 86_400_000);
  const closed = await db.update(jobs).set({ closedAt: now })
    .where(and(sql`${jobs.closedAt} is null`, sql`${jobs.lastSeenAt} < ${stale}`,
      sql`${jobs.boardId} in (select ${jobBoards.id} from ${jobBoards} where ${jobBoards.source} = 'jsearch')`))
    .returning({ id: jobs.id });
  res.jobsClosed = closed.length;
  return res;

  async function resolve(e: Employer): Promise<{ reason: string; domain?: string | null }> {
    if (looksLikeStaffing(e.name, e.hits.map((h) => h.description), e.hits.map((h) => h.title))) return { reason: "staffing" };
    const region = regionFromPostings(e.hits.map((h) => ({ location: h.location, countryCodes: h.countryCodes })));
    if (!regionInScope(region, opts.pack.icp)) return { reason: "not-region" };
    const site = e.hits.map((h) => employerDomain(h, lists)).find(Boolean) ?? null;
    if (!site) return { reason: "no-website" };
    const home = await checkHomepage(site);
    if (!home.ok) return { reason: "bad-site", domain: site };
    const domain = home.finalDomain ?? site;
    const fit = passesHardFilters({ domain, teamSize: null, industries: [], status: null }, opts.pack.icp);
    if (!fit.pass) return { reason: `filtered: ${fit.reason}`, domain };
    return { reason: "resolved", domain };
  }

  /** Once a real board tracks the account, its JSearch-only roles close (the board diff is exact; no double counting). */
  async function retireJSearchBoard(accountId: string) {
    const js = await db.update(jobBoards).set({ status: "dead" })
      .where(and(eq(jobBoards.accountId, accountId), eq(jobBoards.source, "jsearch"), eq(jobBoards.status, "active"))).returning({ id: jobBoards.id });
    if (js.length) await db.update(jobs).set({ closedAt: now }).where(and(inArray(jobs.boardId, js.map((b) => b.id)), sql`${jobs.closedAt} is null`));
  }

  async function record(e: Employer, domain: string) {
    const region = regionFromPostings(e.hits.map((h) => ({ location: h.location, countryCodes: h.countryCodes })));
    if (region === "India") res.india++;
    const [acc] = await db.insert(accounts).values({ domain, name: e.name, region })
      .onConflictDoUpdate({ target: accounts.domain, set: { name: sql`coalesce(${accounts.name}, excluded.name)`, region: sql`coalesce(${accounts.region}, excluded.region)` } })
      .returning({ id: accounts.id });
    const accountId = acc!.id;

    // A real board (ours already, or linked from the company's own site) is better: the daily diff tracks it exactly
    const boards = await db.select({ source: jobBoards.source }).from(jobBoards).where(and(eq(jobBoards.accountId, accountId), eq(jobBoards.status, "active")));
    if (boards.some((b) => b.source !== "jsearch")) return retireJSearchBoard(accountId);
    for (const p of await ownPages(`https://${domain}`).catch(() => [])) {
      for (const b of findBoardLinks(p.html).slice(0, 3)) {
        try {
          await fetchBoardPostings(b.ats, b.slug); // readable = real board
          const ins = await db.insert(jobBoards).values({ accountId, source: b.ats, slug: b.slug, proofUrl: p.url })
            .onConflictDoNothing({ target: [jobBoards.source, jobBoards.slug] }).returning({ id: jobBoards.id });
          if (ins.length) { res.ownBoards++; return retireJSearchBoard(accountId); }
        } catch { /* not a readable board */ }
      }
    }

    const [board] = await db.insert(jobBoards).values({ accountId, source: "jsearch", slug: domain, proofUrl: `https://${domain}`, baselineDone: true })
      .onConflictDoUpdate({ target: [jobBoards.source, jobBoards.slug], set: { lastCheckedAt: now } })
      .returning({ id: jobBoards.id });
    for (const h of e.hits) {
      await db.insert(jobs).values({
        boardId: board!.id, externalId: h.jobId, title: h.title, url: h.applyLink, employmentType: h.employmentType ?? null,
        family: h.cls.family, postedAt: h.postedAt && h.postedAt < now ? h.postedAt : null, firstSeenAt: now, lastSeenAt: now,
      }).onConflictDoUpdate({ target: [jobs.boardId, jobs.externalId], set: { lastSeenAt: now, closedAt: null } });
      res.jobsSeen++;
    }
  }
}
