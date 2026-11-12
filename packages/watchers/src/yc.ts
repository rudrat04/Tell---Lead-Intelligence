import { robotsAllows } from "./robots.js";
import { politeGet } from "./http.js";

/** One job on any tracked board, normalised. */
export interface JobPosting {
  externalId: string;
  title: string;
  url: string;
  employmentType?: string;
  role?: string;
  postedAt?: Date;
}

/** Fields we use from the public YC company dataset (yc-oss/api, built from YC's public directory). */
export interface YcCompany {
  id: number;
  name: string;
  slug: string;
  website: string;
  team_size: number | null;
  industry: string;
  industries: string[];
  regions: string[];
  status: string;
  isHiring: boolean;
  batch: string;
}

export const YC_DATASET_URL = "https://yc-oss.github.io/api/companies/all.json";

export async function fetchYcCompanies(): Promise<YcCompany[]> {
  const res = await fetch(YC_DATASET_URL, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`YC dataset -> ${res.status}`);
  return (await res.json()) as YcCompany[];
}

/** "7 months", "about 1 month", "3 days", "1 year" -> approximate date (YC shows relative ages only). */
export function relativeAgeToDate(s: string | null | undefined, now = new Date()): Date | undefined {
  if (!s) return undefined;
  const m = s.match(/(\d+|an?|about an?)\s*(minute|hour|day|week|month|year)s?/i);
  if (!m) return undefined;
  const n = /^\d+$/.test(m[1]!) ? Number(m[1]) : 1;
  const days = { minute: 0, hour: 0, day: 1, week: 7, month: 30, year: 365 }[m[2]!.toLowerCase() as "day"] * n;
  return new Date(now.getTime() - days * 86_400_000);
}

interface YcJobJson { id: number; title: string; url: string; type?: string; role?: string; createdAt?: string }

/** Parse a YC company jobs page (structured data embedded in the page). Throws if the page shape is unexpected. */
export function parseYcJobsPage(html: string, now = new Date()): JobPosting[] {
  const m = html.match(/data-page="([^"]+)"/);
  if (!m) throw new Error("YC jobs page: no data-page payload");
  const decoded = m[1]!.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const page = JSON.parse(decoded) as { props?: { jobPostings?: YcJobJson[] } };
  const list = page.props?.jobPostings;
  if (!Array.isArray(list)) throw new Error("YC jobs page: jobPostings missing");
  return list.map((j) => ({
    externalId: String(j.id),
    title: j.title,
    url: `https://www.ycombinator.com${j.url}`,
    employmentType: j.type ?? undefined,
    role: j.role ?? undefined,
    postedAt: relativeAgeToDate(j.createdAt, now),
  }));
}

export async function fetchYcJobs(slug: string): Promise<JobPosting[]> {
  const url = `https://www.ycombinator.com/companies/${encodeURIComponent(slug)}/jobs`;
  if (!(await robotsAllows(url))) throw new Error("robots.txt disallows YC jobs page");
  return parseYcJobsPage(await politeGet(url, 1000));
}
