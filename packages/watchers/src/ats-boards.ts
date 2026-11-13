import { getJson } from "./http.js";
import { RawItemSchema, type RawItem } from "./types.js";
import type { JobPosting } from "./yc.js";
import { fetchKekaPostings, fetchFreshteamPostings } from "./india-ats.js";
import { fetchWorkablePostings } from "./workable.js";

export type Ats = "greenhouse" | "lever" | "ashby" | "keka" | "freshteam" | "workable";
export interface TrackedBoard { ats: Ats; slug: string; domain: string }

const GTM_TITLE = /(revops|revenue operations|marketing ops|sales ops|gtm|growth|crm|hubspot|salesforce|demand gen|account executive|sdr|bdr)/i;

interface GhJob { id: number; title: string; absolute_url: string; updated_at: string; content?: string; location?: { name: string } }
interface LeverJob { id: string; text: string; hostedUrl: string; createdAt: number; descriptionPlain?: string; categories?: { location?: string; commitment?: string } }
interface AshbyResp { jobs: { id: string; title: string; jobUrl: string; publishedAt: string; descriptionPlain?: string; employmentType?: string }[] }

/** All open roles on a public ATS board, normalised (titles only; no descriptions). Throws if the board can't be read. */
export async function fetchBoardPostings(ats: Ats, slug: string): Promise<JobPosting[]> {
  if (ats === "keka") return fetchKekaPostings(slug);
  if (ats === "freshteam") return fetchFreshteamPostings(slug);
  if (ats === "workable") return fetchWorkablePostings(slug);
  if (ats === "greenhouse") {
    const d = await getJson<{ jobs: (GhJob & { first_published?: string })[] }>(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`);
    return d.jobs.map((j) => ({ externalId: String(j.id), title: j.title, url: j.absolute_url, postedAt: j.first_published ? new Date(j.first_published) : undefined, text: htmlText(j.content) }));
  }
  if (ats === "lever") {
    const d = await getJson<LeverJob[]>(`https://api.lever.co/v0/postings/${slug}?mode=json`);
    return d.map((j) => ({ externalId: j.id, title: j.text, url: j.hostedUrl, employmentType: j.categories?.commitment, postedAt: new Date(j.createdAt), text: j.descriptionPlain }));
  }
  const d = await getJson<AshbyResp>(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
  return d.jobs.map((j) => ({ externalId: j.id, title: j.title, url: j.jobUrl, employmentType: j.employmentType, postedAt: j.publishedAt ? new Date(j.publishedAt) : undefined, text: j.descriptionPlain }));
}

/** Greenhouse returns escaped HTML: unescape, drop tags, collapse spaces. */
function htmlText(s?: string): string | undefined {
  if (!s) return undefined;
  const un = s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
  return un.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 20000);
}

/** Fetch GTM-relevant open roles from one company's public ATS board. */
export async function fetchBoard(b: TrackedBoard): Promise<RawItem[]> {
  const src = `ats-${b.ats}`;
  const mk = (externalId: string, url: string, title: string, text: string, postedAt: Date | string, meta: Record<string, unknown> = {}) =>
    RawItemSchema.parse({ sourceId: src, externalId: `${b.slug}:${externalId}`, url, title, text, postedAt, meta: { domain: b.domain, slug: b.slug, ...meta } });

  if (b.ats === "keka" || b.ats === "freshteam" || b.ats === "workable") return []; // tracked through the daily board diff only
  if (b.ats === "greenhouse") {
    const d = await getJson<{ jobs: GhJob[] }>(`https://boards-api.greenhouse.io/v1/boards/${b.slug}/jobs?content=true`);
    return d.jobs.filter((j) => GTM_TITLE.test(j.title)).map((j) => mk(String(j.id), j.absolute_url, j.title, j.content ?? j.title, j.updated_at, { location: j.location?.name }));
  }
  if (b.ats === "lever") {
    const d = await getJson<LeverJob[]>(`https://api.lever.co/v0/postings/${b.slug}?mode=json`);
    return d.filter((j) => GTM_TITLE.test(j.text)).map((j) => mk(j.id, j.hostedUrl, j.text, j.descriptionPlain ?? j.text, new Date(j.createdAt), { commitment: j.categories?.commitment }));
  }
  const d = await getJson<AshbyResp>(`https://api.ashbyhq.com/posting-api/job-board/${b.slug}`);
  return d.jobs.filter((j) => GTM_TITLE.test(j.title)).map((j) => mk(j.id, j.jobUrl, j.title, j.descriptionPlain ?? j.title, j.publishedAt, { employmentType: j.employmentType }));
}
