import { getJson } from "./http.js";
import type { JobPosting } from "./yc.js";

/**
 * Workable (India coverage). Terms checked Nov 2026: robots.txt on jobs.workable.com and apply.workable.com does not
 * block these APIs and declares `ai-input=yes, ai-train=no`; neither terms page bans automated access. We read
 * public job data only, keep titles + locations (no descriptions), and link back to Workable's own job pages.
 *
 * - Job search (jobs.workable.com) spans every company hiring through Workable, with the company's own website.
 * - Each company's full board is the public widget API (apply.workable.com/api/v1/widget/accounts/<subdomain>).
 * - Ownership proof: the account API (apply.workable.com/api/v1/accounts/<subdomain>) returns the account's `uid`,
 *   the same id the job search gives for the company. A subdomain is accepted only on an exact uid match.
 */

export interface WorkableHit {
  jobId: string;
  title: string;
  url: string;
  countryName: string | null;
  city: string | null;
  createdAt?: Date;
  companyId: string;
  companyName: string;
  website: string | null;
}

interface SearchJob {
  id: string; title: string; url: string; created?: string;
  location?: { city?: string; countryName?: string };
  company?: { id?: string; title?: string; website?: string | null };
}

/** One search query, up to `maxPages` pages of 20. Polite: one request at a time with a gap per host. */
export async function searchWorkable(query: string, location: string, opts: { dayRange?: number; maxPages?: number } = {}): Promise<WorkableHit[]> {
  const out: WorkableHit[] = [];
  let token: string | undefined;
  for (let page = 0; page < (opts.maxPages ?? 5); page++) {
    const p = new URLSearchParams({ query, location });
    if (opts.dayRange) p.set("day_range", String(opts.dayRange));
    if (token) p.set("pageToken", token);
    const d = await getJson<{ jobs?: SearchJob[]; nextPageToken?: string }>(`https://jobs.workable.com/api/v1/jobs?${p}`, 800);
    for (const j of d.jobs ?? []) {
      if (!j.company?.id || !j.company.title) continue;
      out.push({
        jobId: j.id, title: j.title.trim(), url: j.url,
        countryName: j.location?.countryName ?? null, city: j.location?.city ?? null,
        createdAt: j.created ? new Date(j.created) : undefined,
        companyId: j.company.id, companyName: j.company.title.trim(), website: j.company.website ?? null,
      });
    }
    token = d.nextPageToken;
    if (!token) break;
  }
  return out;
}

export interface WorkableAccount { uid: string; subdomain: string; name: string; url: string | null }

/** The account behind a board subdomain, or null if there is none. */
export async function fetchWorkableAccount(subdomain: string): Promise<WorkableAccount | null> {
  try {
    const a = await getJson<{ uid?: string; subdomain?: string; name?: string; url?: string | null }>(`https://apply.workable.com/api/v1/accounts/${encodeURIComponent(subdomain)}`, 500);
    return a.uid && a.subdomain ? { uid: a.uid, subdomain: a.subdomain, name: a.name ?? subdomain, url: a.url ?? null } : null;
  } catch {
    return null;
  }
}

interface WidgetJob {
  description?: string;
  shortcode: string; title: string; url?: string; employment_type?: string; published_on?: string; created_at?: string;
  country?: string; city?: string; locations?: { country?: string; countryCode?: string; city?: string; hidden?: boolean }[];
}

/** Normalise the widget API's jobs (exported for tests). */
export function workablePostings(subdomain: string, jobs: WidgetJob[]): JobPosting[] {
  return jobs.map((j) => {
    const locs = (j.locations ?? []).filter((l) => !l.hidden);
    const date = j.published_on ?? j.created_at;
    return {
      externalId: j.shortcode,
      title: j.title.trim(),
      url: j.url ?? `https://apply.workable.com/${subdomain}/j/${j.shortcode}/`,
      employmentType: j.employment_type,
      postedAt: date ? new Date(`${date}T00:00:00Z`) : undefined,
      location: (locs.length ? locs.map((l) => [l.city, l.country].filter(Boolean).join(", ")) : [[j.city, j.country].filter(Boolean).join(", ")]).filter(Boolean).join(" / ") || undefined,
      countryCodes: locs.map((l) => l.countryCode).filter((c): c is string => !!c),
      text: j.description ? j.description.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim().slice(0, 20000) : undefined,
    };
  });
}

/** All open roles on a company's Workable board. Throws if the board can't be read. */
export async function fetchWorkablePostings(subdomain: string): Promise<JobPosting[]> {
  const d = await getJson<{ jobs: WidgetJob[] }>(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(subdomain)}?details=true`, 500);
  return workablePostings(subdomain, d.jobs ?? []);
}

/** Board subdomains to try for a company, best evidence first: links from its own site, then forms of its name. */
export function subdomainCandidates(ownSiteSlugs: string[], name: string, domain: string): string[] {
  const words = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter(Boolean);
  const label = domain.split(".")[0]!.toLowerCase();
  const fromName = words.length ? [words.join(""), words.join("-")] : [];
  return [...new Set([...ownSiteSlugs, label, ...fromName, `${label}-1`].filter((s) => /^[a-z0-9][a-z0-9-]{1,62}$/.test(s)))].slice(0, 6);
}
