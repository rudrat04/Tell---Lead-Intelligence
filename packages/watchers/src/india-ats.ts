import { politeGet, getJson } from "./http.js";
import type { JobPosting } from "./yc.js";

/**
 * Job boards on ATS products common with Indian companies, found through Common Crawl (no public directory).
 *
 * Keka (<tenant>.keka.com): robots.txt allows only /careers; the careers portal's own JSON API lives under it
 * (/careers/api/...). Freshteam (<tenant>.freshteam.com): robots.txt allows only /jobs; the listing is server-rendered.
 * Darwinbox is a JS app without a plain listing API, so it is not used.
 */

export interface AtsTenant {
  /** what job_boards.slug stores: keka "tenant/guid" (one API call per daily check), freshteam "tenant" */
  slug: string;
  name: string | null;
  /** outbound links on the portal (company site candidates) */
  links: string[];
  postings: JobPosting[];
}

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

interface KekaInfo { name?: string; shortName?: string; logoPath?: string; careersBackgroundPath?: string; socialLinks?: { url: string }[] }
interface KekaJob {
  id: string | number; title: string; excerpt?: string; publishedOn?: string; jobType?: string | number;
  jobLocations?: { city?: string; countryCode?: string; countryName?: string }[];
}

export const kekaPortal = (tenant: string) => `https://${tenant}.keka.com/careers/`;

export function kekaPostings(tenant: string, jobs: KekaJob[]): JobPosting[] {
  return jobs.map((j) => {
    const locs = j.jobLocations ?? [];
    return {
      externalId: String(j.id),
      title: j.title,
      url: `https://${tenant}.keka.com/careers/jobdetails/${j.id}`,
      postedAt: j.publishedOn ? new Date(j.publishedOn) : undefined,
      location: locs.map((l) => [l.city, l.countryName].filter(Boolean).join(", ")).join("; ") || undefined,
      countryCodes: locs.map((l) => l.countryCode).filter((c): c is string => !!c),
      text: j.excerpt,
    };
  });
}

/** Discovery: portal name, tenant GUID (needed by the jobs API) and open roles. Null when the tenant has no portal. */
export async function fetchKekaTenant(tenant: string): Promise<AtsTenant | null> {
  let info: KekaInfo;
  try { info = await getJson<KekaInfo>(`https://${tenant}.keka.com/careers/api/organization/default/careerportalinfo`); } catch { return null; }
  let guid = (info.careersBackgroundPath ?? info.logoPath ?? "").match(GUID)?.[0];
  if (!guid) {
    try { guid = (await politeGet(kekaPortal(tenant))).match(GUID)?.[0]; } catch { /* no page */ }
  }
  if (!guid) return null;
  const jobs = await getJson<KekaJob[]>(`https://${tenant}.keka.com/careers/api/embedjobs/default/active/${guid}`);
  return { slug: `${tenant}/${guid}`, name: info.name ?? info.shortName ?? null, links: (info.socialLinks ?? []).map((s) => s.url), postings: kekaPostings(tenant, jobs) };
}

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

/** Parse a Freshteam /jobs listing. Exported for tests. */
export function parseFreshteamJobs(html: string, tenant: string): { name: string | null; links: string[]; postings: JobPosting[] } {
  const postings: JobPosting[] = [];
  const re = /<a href="\/jobs\/([A-Za-z0-9_-]+)\/([^"]*)"[^>]*class="heading"[^>]*?data-portal-location="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  for (const m of html.matchAll(re)) {
    const body = m[4]!;
    const title = decode(body.match(/class="job-title">([^<]*)</)?.[1] ?? "");
    if (!title) continue;
    const info = decode((body.match(/class="location-info">([\s\S]*?)<\/div>/)?.[1] ?? "").replace(/<br\s*\/?>/g, " | ").replace(/<[^>]+>/g, ""));
    const type = info.split("|").pop()?.trim();
    postings.push({
      externalId: m[1]!,
      title,
      url: `https://${tenant}.freshteam.com/jobs/${m[1]}/${m[2]}`,
      employmentType: type || undefined,
      location: decode(m[3]!) || undefined,
      text: decode((body.match(/class="job-desc text">([\s\S]*?)<\/div>/)?.[1] ?? "").replace(/<[^>]+>/g, " ")),
    });
  }
  const name = decode(html.match(/<title>([^<]*)<\/title>/i)?.[1] ?? "").replace(/\s*[-|–]\s*(careers?|jobs).*$/i, "").replace(/^(careers?|jobs)\s*(at|@|[-|–])\s*/i, "") || null;
  const links = [...html.matchAll(/href="(https?:\/\/[^"]+)"/g)].map((x) => x[1]!).filter((u) => !/freshteam\.com|freshworks\.com|cdnjs|googleapis|gstatic/.test(u));
  return { name, links, postings };
}

export async function fetchFreshteamTenant(tenant: string): Promise<AtsTenant | null> {
  let html: string;
  try { html = await politeGet(`https://${tenant}.freshteam.com/jobs`); } catch { return null; }
  if (!html.includes("job-role-list") && !html.includes('class="heading"')) return null;
  return { slug: tenant, ...parseFreshteamJobs(html, tenant) };
}

/** Daily board check: open roles for a stored slug. Throws if the board can't be read. */
export async function fetchKekaPostings(slug: string): Promise<JobPosting[]> {
  const [tenant, guid] = slug.split("/");
  return kekaPostings(tenant!, await getJson<KekaJob[]>(`https://${tenant}.keka.com/careers/api/embedjobs/default/active/${guid}`));
}

export async function fetchFreshteamPostings(tenant: string): Promise<JobPosting[]> {
  const html = await politeGet(`https://${tenant}.freshteam.com/jobs`);
  if (!html.includes("job-role-list") && !html.includes('class="heading"')) throw new Error(`freshteam ${tenant}: no listing`);
  return parseFreshteamJobs(html, tenant).postings;
}
