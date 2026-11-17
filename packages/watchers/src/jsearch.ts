/**
 * JSearch: Google for Jobs results, i.e. listings from LinkedIn, Naukri, Indeed and company sites, through a paid
 * aggregator's free tier (200 requests a month). We never touch those sites ourselves. Two ways in, same data:
 * JSEARCH_API_KEY = OpenWeb Ninja's own API (api.openwebninja.com, `ak_` keys; preferred), else RAPIDAPI_KEY = RapidAPI.
 * Requests are never retried: every attempt counts against the monthly quota.
 */

export interface JSearchJob {
  jobId: string;
  title: string;
  employer: string;
  /** the employer's website, when JSearch knows it */
  website: string | null;
  applyLink: string;
  publisher: string | null;
  employmentType?: string;
  postedAt?: Date;
  location: string;
  countryCodes: string[];
  description?: string;
}

interface RawJob {
  job_id?: string;
  job_title?: string;
  employer_name?: string;
  employer_website?: string | null;
  job_publisher?: string;
  job_employment_type?: string;
  job_apply_link?: string;
  job_posted_at_datetime_utc?: string;
  job_city?: string;
  job_state?: string;
  job_country?: string;
  job_location?: string;
  job_description?: string;
}

/** /search-v2 nests jobs under data.jobs; the older /search returned data as the array. Accept both. */
export function parseJSearch(body: unknown): JSearchJob[] {
  const d = (body as { data?: unknown })?.data;
  const raw: RawJob[] = Array.isArray(d) ? d : Array.isArray((d as { jobs?: unknown })?.jobs) ? (d as { jobs: RawJob[] }).jobs : [];
  const out: JSearchJob[] = [];
  for (const r of raw) {
    if (!r.job_id || !r.job_title || !r.employer_name || !r.job_apply_link) continue;
    const posted = r.job_posted_at_datetime_utc ? new Date(r.job_posted_at_datetime_utc) : undefined;
    const country = (r.job_country ?? "").trim();
    out.push({
      jobId: r.job_id,
      title: r.job_title.trim(),
      employer: r.employer_name.trim(),
      website: r.employer_website?.trim() || null,
      applyLink: r.job_apply_link,
      publisher: r.job_publisher ?? null,
      employmentType: r.job_employment_type,
      postedAt: posted && !Number.isNaN(posted.getTime()) ? posted : undefined,
      location: [r.job_city, r.job_state, country].filter(Boolean).join(", ") || (r.job_location ?? ""),
      countryCodes: /^[A-Z]{2}$/i.test(country) ? [country.toUpperCase()] : [],
      description: r.job_description,
    });
  }
  return out;
}

export interface JSearchQuery { query: string; location: string; country: string; datePosted: "today" | "3days" | "week" | "month" }

/** Which JSearch account a run uses: OpenWeb Ninja's direct key first, else RapidAPI; null = none set. */
export function jsearchProvider(env: NodeJS.ProcessEnv = process.env): { kind: "openwebninja" | "rapidapi"; key: string } | null {
  if (env.JSEARCH_API_KEY) return { kind: "openwebninja", key: env.JSEARCH_API_KEY };
  if (env.RAPIDAPI_KEY) return { kind: "rapidapi", key: env.RAPIDAPI_KEY };
  return null;
}

export async function searchJSearch(q: JSearchQuery, provider = jsearchProvider()): Promise<JSearchJob[]> {
  if (!provider) throw new Error("JSEARCH_API_KEY / RAPIDAPI_KEY is not set");
  const params = new URLSearchParams({ query: `${q.query} in ${q.location}`, num_pages: "1", country: q.country, date_posted: q.datePosted });
  const res = provider.kind === "openwebninja"
    ? await fetch(`https://api.openwebninja.com/jsearch/search?${params}`, { headers: { "x-api-key": provider.key }, signal: AbortSignal.timeout(30_000) })
    : await fetch(`https://jsearch.p.rapidapi.com/search-v2?${params}`, {
      headers: { "x-rapidapi-key": provider.key, "x-rapidapi-host": "jsearch.p.rapidapi.com" },
      signal: AbortSignal.timeout(30_000),
    });
  if (!res.ok) throw new Error(`jsearch -> ${res.status}`);
  return parseJSearch(await res.json());
}
