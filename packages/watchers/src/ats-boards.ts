import { getJson } from "./http.js";
import { RawItemSchema, type RawItem } from "./types.js";

export type Ats = "greenhouse" | "lever" | "ashby";
export interface TrackedBoard { ats: Ats; slug: string; domain: string }

const GTM_TITLE = /(revops|revenue operations|marketing ops|sales ops|gtm|growth|crm|hubspot|salesforce|demand gen|account executive|sdr|bdr)/i;

interface GhJob { id: number; title: string; absolute_url: string; updated_at: string; content?: string; location?: { name: string } }
interface LeverJob { id: string; text: string; hostedUrl: string; createdAt: number; descriptionPlain?: string; categories?: { location?: string; commitment?: string } }
interface AshbyResp { jobs: { id: string; title: string; jobUrl: string; publishedAt: string; descriptionPlain?: string; employmentType?: string }[] }

/** Fetch GTM-relevant open roles from one company's public ATS board. */
export async function fetchBoard(b: TrackedBoard): Promise<RawItem[]> {
  const src = `ats-${b.ats}`;
  const mk = (externalId: string, url: string, title: string, text: string, postedAt: Date | string, meta: Record<string, unknown> = {}) =>
    RawItemSchema.parse({ sourceId: src, externalId: `${b.slug}:${externalId}`, url, title, text, postedAt, meta: { domain: b.domain, slug: b.slug, ...meta } });

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
