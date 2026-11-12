/**
 * One-off coverage measurement (local only): of a sample of B2B YC companies that are hiring,
 * how many link a readable ATS board from their own site, and how many GTM roles those boards hold?
 * Also checks how many list jobs on YC's own company jobs page. Prints aggregates only.
 */
import { findBoardLinks, fetchBoard, robotsAllows, type BoardRef } from "@tell/watchers";
import { registrableDomain } from "@tell/people";

type Yc = { name: string; slug: string; website: string; team_size: number | null; industries: string[]; industry: string; regions: string[] };
const UA = "TellLeadIntelligence/0.1 (research bot; respects robots.txt)";
const N = Number(process.argv[2] ?? 100);

const all = (await (await fetch("https://yc-oss.github.io/api/companies/hiring.json")).json()) as Yc[];
const b2b = all.filter((c) => (c.industries?.includes("B2B") || c.industry === "B2B") && c.website && (c.team_size ?? 999) <= 150);
// deterministic sample spread across the list
const step = Math.max(1, Math.floor(b2b.length / N));
const sample = b2b.filter((_, i) => i % step === 0).slice(0, N);

async function getText(url: string): Promise<{ html: string; finalUrl: string } | null> {
  if (!(await robotsAllows(url))) return null;
  try {
    const r = await fetch(url, { headers: { "user-agent": UA }, redirect: "follow", signal: AbortSignal.timeout(12_000) });
    if (!r.ok) return null;
    return { html: (await r.text()).slice(0, 1_500_000), finalUrl: r.url };
  } catch { return null; }
}

const stats = { companies: sample.length, siteReachable: 0, boardFound: 0, byAts: { greenhouse: 0, lever: 0, ashby: 0 } as Record<string, number>, boardReadable: 0, withGtmRoles: 0, gtmRoles: 0, ycJobsPage: 0, ycJobsOnlyNoBoard: 0, robotsBlocked: 0 };

async function one(c: Yc) {
  const base = c.website.replace(/\/+$/, "");
  const pages: string[] = [];
  let reachable = false;
  for (const path of ["", "/careers", "/jobs"]) {
    const url = base + path;
    if (!(await robotsAllows(url))) { if (path === "") stats.robotsBlocked++; continue; }
    const p = await getText(url);
    if (p) {
      reachable = true;
      // only count pages that stayed on the company's own registrable domain
      if (registrableDomain(p.finalUrl) === registrableDomain(base) || path === "") pages.push(p.html);
    }
  }
  if (reachable) stats.siteReachable++;
  const boards: BoardRef[] = findBoardLinks(pages.join("\n"));
  let gtm = 0, readable = false;
  if (boards.length) {
    stats.boardFound++;
    stats.byAts[boards[0]!.ats] = (stats.byAts[boards[0]!.ats] ?? 0) + 1;
    for (const b of boards.slice(0, 2)) {
      try {
        const items = await fetchBoard({ ats: b.ats, slug: b.slug, domain: registrableDomain(base) ?? base });
        readable = true;
        gtm += items.length;
      } catch { /* unreadable board */ }
    }
  }
  if (readable) stats.boardReadable++;
  if (gtm) { stats.withGtmRoles++; stats.gtmRoles += gtm; }
  const yc = await getText(`https://www.ycombinator.com/companies/${c.slug}/jobs`);
  const ycJobs = yc ? new Set(yc.html.match(new RegExp(`/companies/${c.slug}/jobs/[A-Za-z0-9-]+`, "g")) ?? []).size : 0;
  if (ycJobs) { stats.ycJobsPage++; if (!boards.length) stats.ycJobsOnlyNoBoard++; }
}

// small worker pool; each company is a different host
const queue = [...sample];
await Promise.all(Array.from({ length: 6 }, async () => { while (queue.length) await one(queue.shift()!); }));
console.log(JSON.stringify({ population: { hiring: all.length, b2bUpTo150: b2b.length }, ...stats }, null, 2));
