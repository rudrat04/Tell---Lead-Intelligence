import type { Pack } from "@tell/config";
import {
  fetchYcCompanies, fetchYcJobs, fetchBoardPostings, findBoardLinks, robotsAllows,
  userAgent, type YcCompany, type JobPosting, type Ats,
} from "@tell/watchers";
import { classifyJob, compileRoles, diffBoard, passesHardFilters, segmentFor, sizeBand, type OpenJobRow, type FetchedJob, type JobFamily } from "@tell/intel";
import { registrableDomain } from "@tell/people";
import { applyPackIdentity } from "./scheduled.js";
import { getDb, accounts, jobBoards, jobs, signals, companySeeds, eq, and, inArray, sql } from "@tell/db";

const chunk = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));


// ---------------------------------------------------------------- discovery (weekly)

export interface DiscoveryResult {
  companies: number;
  fitPass: number;
  hiringFit: number;
  ycBoardsNew: number;
  siteChecked: number;
  atsBoardsFound: number;
}

async function ownPages(website: string): Promise<{ html: string; url: string }[]> {
  const base = website.replace(/\/+$/, "");
  const own = registrableDomain(base);
  const out: { html: string; url: string }[] = [];
  for (const path of ["", "/careers", "/jobs"]) {
    const url = base + path;
    if (!(await robotsAllows(url))) continue;
    try {
      const r = await fetch(url, { headers: { "user-agent": userAgent() }, redirect: "follow", signal: AbortSignal.timeout(12_000) });
      if (!r.ok) continue;
      // a board link only proves ownership if the page is on the company's own domain
      if (registrableDomain(r.url) !== own) continue;
      out.push({ html: (await r.text()).slice(0, 1_500_000), url: r.url });
    } catch { /* skip page */ }
  }
  return out;
}

/** Seed accounts from YC through the ICP hard filters, track their YC jobs page, and find ATS boards they link. */
export async function runDiscovery(opts: { pack: Pack; maxSiteChecks?: number; companies?: YcCompany[] }): Promise<DiscoveryResult> {
  applyPackIdentity(opts.pack);
  const db = getDb();
  const icp = opts.pack.icp;
  const companies = opts.companies ?? (await fetchYcCompanies());
  const now = new Date();

  const evaluated = companies.map((c) => {
    const domain = c.website ? registrableDomain(c.website) : null;
    const fit = passesHardFilters({ domain, teamSize: c.team_size, industries: [c.industry, ...(c.industries ?? [])], status: c.status }, icp);
    return { c, domain, fit };
  });

  for (const part of chunk(evaluated, 500)) {
    await db.insert(companySeeds)
      .values(part.map((e) => ({ source: "yc", sourceId: String(e.c.id), domain: e.domain, fitPass: e.fit.pass, reason: e.fit.reason, updatedAt: now })))
      .onConflictDoUpdate({
        target: [companySeeds.source, companySeeds.sourceId],
        set: { domain: sql`excluded.domain`, fitPass: sql`excluded.fit_pass`, reason: sql`excluded.reason`, updatedAt: now },
      });
  }

  const hiringFit = evaluated.filter((e) => e.fit.pass && e.c.isHiring && e.domain);
  // one account per domain (two YC entries can share a domain)
  const byDomain = new Map(hiringFit.map((e) => [e.domain!, e]));
  const accountIds = new Map<string, string>();
  for (const part of chunk([...byDomain.values()], 300)) {
    const rows = await db.insert(accounts)
      .values(part.map((e) => ({ domain: e.domain!, name: e.c.name, segment: segmentFor([e.c.industry, ...(e.c.industries ?? [])], icp), sizeBand: sizeBand(e.c.team_size, icp), region: e.c.regions?.[0] ?? null })))
      .onConflictDoUpdate({
        target: accounts.domain,
        set: { name: sql`coalesce(${accounts.name}, excluded.name)`, segment: sql`excluded.segment`, sizeBand: sql`excluded.size_band`, region: sql`coalesce(${accounts.region}, excluded.region)` },
      })
      .returning({ id: accounts.id, domain: accounts.domain });
    for (const r of rows) accountIds.set(r.domain, r.id);
  }

  let ycBoardsNew = 0;
  for (const part of chunk(hiringFit, 300)) {
    const rows = await db.insert(jobBoards)
      .values(part.map((e) => ({ accountId: accountIds.get(e.domain!)!, source: "yc", slug: e.c.slug, proofUrl: `https://www.ycombinator.com/companies/${e.c.slug}` })))
      .onConflictDoNothing({ target: [jobBoards.source, jobBoards.slug] })
      .returning({ id: jobBoards.id });
    ycBoardsNew += rows.length;
  }

  // Own-site ATS board discovery, oldest-checked first, bounded per run
  const seeds = await db.select({ sourceId: companySeeds.sourceId, checked: companySeeds.siteCheckedAt }).from(companySeeds)
    .where(and(eq(companySeeds.source, "yc"), eq(companySeeds.fitPass, true)));
  const lastChecked = new Map(seeds.map((s) => [s.sourceId, s.checked]));
  const due = hiringFit
    .filter((e) => { const t = lastChecked.get(String(e.c.id)); return !t || now.getTime() - t.getTime() > 30 * 86_400_000; })
    .slice(0, opts.maxSiteChecks ?? 1000); // ~100 sites/min with 6 workers, so one weekly run covers every hiring company

  const found: { accountId: string; ats: Ats; slug: string; proofUrl: string }[] = [];
  const queue = [...due];
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const e = queue.shift()!;
      const pages = await ownPages(e.c.website);
      for (const p of pages) {
        for (const b of findBoardLinks(p.html).slice(0, 3)) {
          try {
            await fetchBoardPostings(b.ats, b.slug); // readable = real board
            found.push({ accountId: accountIds.get(e.domain!)!, ats: b.ats, slug: b.slug, proofUrl: p.url });
          } catch { /* not a readable board */ }
        }
      }
    }
  }));

  const uniqueFound = [...new Map(found.map((f) => [`${f.ats}:${f.slug}`, f])).values()];
  for (const part of chunk(uniqueFound, 300)) {
    await db.insert(jobBoards).values(part.map((f) => ({ accountId: f.accountId, source: f.ats, slug: f.slug, proofUrl: f.proofUrl })))
      .onConflictDoNothing({ target: [jobBoards.source, jobBoards.slug] });
  }
  for (const part of chunk(due.map((e) => String(e.c.id)), 500)) {
    await db.update(companySeeds).set({ siteCheckedAt: now }).where(and(eq(companySeeds.source, "yc"), inArray(companySeeds.sourceId, part)));
  }

  return {
    companies: companies.length,
    fitPass: evaluated.filter((e) => e.fit.pass).length,
    hiringFit: hiringFit.length,
    ycBoardsNew,
    siteChecked: due.length,
    atsBoardsFound: uniqueFound.length,
  };
}

// ---------------------------------------------------------------- board check (daily)

export interface BoardCheckResult {
  boards: number;
  checked: number;
  failed: number;
  suspect: number;
  baselines: number;
  newRoles: number;
  closedRoles: number;
  signals: Record<string, number>;
}

type BoardRow = { id: string; accountId: string; source: string; slug: string; baselineDone: boolean; failCount: number };

async function fetchPostings(b: BoardRow): Promise<JobPosting[]> {
  return b.source === "yc" ? fetchYcJobs(b.slug) : fetchBoardPostings(b.source as Ats, b.slug);
}

/** Daily diff of every tracked board's GTM/ops roles into jobs + signals. Dead boards (7 straight failures) stop being checked. */
export async function runBoardCheck(opts: { pack: Pack; maxBoards?: number }): Promise<BoardCheckResult> {
  applyPackIdentity(opts.pack);
  const db = getDb();
  const specs = opts.pack.signals.signals;
  const roles = compileRoles(opts.pack.roles);
  const now = new Date();

  const boards: BoardRow[] = await db.select({
    id: jobBoards.id, accountId: jobBoards.accountId, source: jobBoards.source, slug: jobBoards.slug, baselineDone: jobBoards.baselineDone, failCount: jobBoards.failCount,
  }).from(jobBoards).where(eq(jobBoards.status, "active"))
    .orderBy(sql`${jobBoards.lastCheckedAt} asc nulls first`).limit(opts.maxBoards ?? 2000);

  const openRows = boards.length
    ? await db.select().from(jobs).where(and(inArray(jobs.boardId, boards.map((b) => b.id)), sql`${jobs.closedAt} is null`))
    : [];
  const openByBoard = new Map<string, OpenJobRow[]>();
  for (const r of openRows) {
    const list = openByBoard.get(r.boardId) ?? [];
    list.push({ id: r.id, externalId: r.externalId, title: r.title, url: r.url, family: r.family as JobFamily, postedAt: r.postedAt, firstSeenAt: r.firstSeenAt });
    openByBoard.set(r.boardId, list);
  }

  const res: BoardCheckResult = { boards: boards.length, checked: 0, failed: 0, suspect: 0, baselines: 0, newRoles: 0, closedRoles: 0, signals: {} };

  async function checkOne(b: BoardRow) {
    let postings: JobPosting[];
    try {
      postings = await fetchPostings(b);
    } catch {
      res.failed++;
      const failCount = b.failCount + 1;
      await db.update(jobBoards).set({ failCount, lastCheckedAt: now, status: failCount >= 7 ? "dead" : "active" }).where(eq(jobBoards.id, b.id));
      return;
    }
    const fetched: FetchedJob[] = postings.flatMap((p) => {
      const cls = classifyJob(p.title, p.employmentType, roles);
      return cls ? [{ externalId: p.externalId, title: p.title, url: p.url, employmentType: p.employmentType, postedAt: p.postedAt, cls }] : [];
    });
    const d = diffBoard(openByBoard.get(b.id) ?? [], fetched, now, b.baselineDone);

    const stmts: unknown[] = [];
    if (d.insert.length) {
      stmts.push(db.insert(jobs).values(d.insert.map((f) => ({
        boardId: b.id, externalId: f.externalId, title: f.title, url: f.url, employmentType: f.employmentType ?? null, family: f.cls.family, postedAt: f.postedAt ?? null, firstSeenAt: now, lastSeenAt: now,
      }))).onConflictDoNothing({ target: [jobs.boardId, jobs.externalId] }));
    }
    if (d.touch.length) stmts.push(db.update(jobs).set({ lastSeenAt: now }).where(inArray(jobs.id, d.touch)));
    if (d.close.length) stmts.push(db.update(jobs).set({ closedAt: now }).where(inArray(jobs.id, d.close)));
    const signalStmt = stmts.length;
    if (d.signals.length) {
      stmts.push(db.insert(signals).values(d.signals.map((s) => ({
        accountId: b.accountId, class: specs[s.type]!.class, type: s.type, strength: specs[s.type]!.strength,
        evidenceQuote: s.quote, evidenceUrl: s.url, observedAt: s.observedAt, halfLifeDays: specs[s.type]!.half_life_days,
      }))).onConflictDoNothing({ target: [signals.evidenceUrl, signals.type] }).returning({ type: signals.type }));
    }
    stmts.push(db.update(jobBoards).set({ baselineDone: true, failCount: 0, lastCheckedAt: now }).where(eq(jobBoards.id, b.id)));
    const results = (await db.batch(stmts as unknown as Parameters<typeof db.batch>[0])) as readonly unknown[];
    // count only signals actually inserted (re-emitted 45-day drafts hit the unique key and are skipped)
    const inserted = d.signals.length ? (results[signalStmt] as { type: string }[]) : [];

    res.checked++;
    if (!b.baselineDone) res.baselines++;
    if (d.suspect) res.suspect++;
    if (b.baselineDone) res.newRoles += d.insert.length;
    res.closedRoles += d.close.length;
    for (const s of inserted) res.signals[s.type] = (res.signals[s.type] ?? 0) + 1;
  }

  // YC pages share one host: one at a time (politeGet spaces them). ATS APIs are other hosts: separate lane.
  const lanes = [boards.filter((b) => b.source === "yc"), boards.filter((b) => b.source !== "yc")];
  await Promise.all(lanes.map(async (lane) => { for (const b of lane) await checkOne(b); }));
  return res;
}
