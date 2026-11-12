/**
 * One-off measurement (local only): of public Greenhouse / Lever / Ashby boards found in Common Crawl,
 * how many hire in India, how many have GTM/core roles there, and how many link the company's own site.
 * Prints aggregates only.
 */
import "dotenv/config";
import { loadPack } from "@tell/config";
import { compileRoles, classifyJob } from "@tell/intel";
import { registrableDomain } from "@tell/people";

const UA = "TellLeadIntelligence/0.1 (+https://github.com/rudrat04/Tell---Lead-Intelligence; respects robots.txt)";
const IDX = "CC-MAIN-2026-43";
const PER_ATS = Number(process.argv[2] ?? 120);
const INDIA = /\b(india|bengaluru|bangalore|mumbai|pune|hyderabad|chennai|gurgaon|gurugram|noida|delhi|new delhi|kolkata|ahmedabad|jaipur|kochi|indore|chandigarh)\b/i;
const pack = await loadPack();
const roles = compileRoles(pack.roles);

async function getJson<T>(u: string): Promise<T | null> {
  try { const r = await fetch(u, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(20_000) }); return r.ok ? ((await r.json()) as T) : null; } catch { return null; }
}
async function getText(u: string): Promise<string | null> {
  try { const r = await fetch(u, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(20_000) }); return r.ok ? await r.text() : null; } catch { return null; }
}
/** The Common Crawl index often times out (HTTP 504): fetch page by page with retries, and say so when it fails. */
async function slugs(pattern: string, rx: RegExp): Promise<string[]> {
  let t = "";
  for (let page = 0; page < 3; page++) {
    let got: string | null = null;
    for (let attempt = 0; attempt < 3 && got == null; attempt++) {
      got = await getText(`https://index.commoncrawl.org/${IDX}-index?url=${encodeURIComponent(pattern)}&output=json&fl=url&page=${page}`);
      if (got == null) await new Promise((r) => setTimeout(r, 15_000));
    }
    if (got == null) { console.error(`common crawl index unavailable for ${pattern} page ${page}`); break; }
    t += got + "\n";
  }
  const set = new Set<string>();
  for (const line of (t ?? "").split("\n")) { try { const m = (JSON.parse(line).url as string).match(rx); if (m && !["embed", "api", "v1"].includes(m[1]!.toLowerCase())) set.add(m[1]!.toLowerCase()); } catch { /* skip */ } }
  return [...set];
}
const sample = <T>(xs: T[], n: number) => { const step = Math.max(1, Math.floor(xs.length / n)); return xs.filter((_, i) => i % step === 0).slice(0, n); };

type Job = { title: string; location: string };
const ats = {
  greenhouse: { pattern: "boards.greenhouse.io/*", rx: /boards\.greenhouse\.io\/([a-z0-9_-]+)/i,
    jobs: async (s: string) => (await getJson<{ jobs: { title: string; location?: { name: string } }[] }>(`https://boards-api.greenhouse.io/v1/boards/${s}/jobs`))?.jobs.map((j) => ({ title: j.title, location: j.location?.name ?? "" })),
    page: (s: string) => `https://boards.greenhouse.io/${s}` },
  lever: { pattern: "jobs.lever.co/*", rx: /jobs\.lever\.co\/([a-z0-9_.-]+)/i,
    jobs: async (s: string) => (await getJson<{ text: string; categories?: { location?: string; allLocations?: string[] } }[]>(`https://api.lever.co/v0/postings/${s}?mode=json`))?.map((j) => ({ title: j.text, location: [j.categories?.location, ...(j.categories?.allLocations ?? [])].join(" ") })),
    page: (s: string) => `https://jobs.lever.co/${s}` },
  ashby: { pattern: "jobs.ashbyhq.com/*", rx: /jobs\.ashbyhq\.com\/([a-z0-9_.%-]+)/i,
    jobs: async (s: string) => (await getJson<{ jobs: { title: string; location?: string; secondaryLocations?: { location: string }[] }[] }>(`https://api.ashbyhq.com/posting-api/job-board/${s}`))?.jobs.map((j) => ({ title: j.title, location: [j.location, ...(j.secondaryLocations ?? []).map((x) => x.location)].join(" ") })),
    page: (s: string) => `https://jobs.ashbyhq.com/${s}` },
};

for (const [name, a] of Object.entries(ats)) {
  const all = await slugs(a.pattern, a.rx);
  const pick = sample(all, PER_ATS);
  const st = { slugsInIndex: all.length, sampled: pick.length, readable: 0, hiresInIndia: 0, indiaGtmOrCore: 0, indiaCore: 0, ownSiteLinked: 0 };
  const queue = [...pick];
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const s = queue.shift()!;
      const jobs: Job[] | undefined = await a.jobs(s);
      if (!jobs) continue;
      st.readable++;
      const india = jobs.filter((j) => INDIA.test(j.location));
      if (!india.length) continue;
      st.hiresInIndia++;
      const cls = india.map((j) => classifyJob(j.title, undefined, roles)).filter(Boolean);
      if (cls.length) st.indiaGtmOrCore++;
      if (cls.some((c) => c!.family === "core")) st.indiaCore++;
      const html = await getText(a.page(s));
      const links = [...(html ?? "").matchAll(/href="(https?:\/\/[^"]+)"/g)].map((m) => registrableDomain(m[1]!)).filter((d) => d && !/greenhouse|lever|ashbyhq|google|linkedin|twitter|x\.com|facebook|instagram|youtube|glassdoor/.test(d));
      if (links.length) st.ownSiteLinked++;
    }
  }));
  console.log(name, JSON.stringify(st));
}
