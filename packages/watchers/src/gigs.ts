import * as cheerio from "cheerio";
import { getJson } from "./http.js";
import { RawItemSchema, type RawItem, type Watcher } from "./types.js";

/** A gig posting from a remote job board, normalised (same shape as @tell/intel GigPosting). */
export interface GigFeedItem {
  source: string;
  externalId: string;
  title: string;
  company: string | null;
  url: string;
  applyUrl: string | null;
  employmentType: string | null;
  location: string | null;
  tags: string[];
  description: string | null;
  postedAt: Date | null;
  expiresAt: Date | null;
}

const strip = (html?: string | null) => (html ? cheerio.load(html).text().replace(/\s+/g, " ").trim() : "");

interface RemoteOkJob { id: string; position?: string; company?: string; tags?: string[]; location?: string; date?: string; url?: string; apply_url?: string; description?: string }

/**
 * Remote OK public API. Its terms: link back to the job's Remote OK URL and mention Remote OK as the source
 * (the digest shows "via Remote OK" with that link).
 */
export async function fetchRemoteOk(): Promise<GigFeedItem[]> {
  const d = await getJson<(RemoteOkJob & { legal?: string })[]>("https://remoteok.com/api", 2000);
  return d.filter((j) => j.id && j.position && !j.legal).map((j) => ({
    source: "remoteok", externalId: String(j.id), title: j.position!.trim(), company: j.company ?? null,
    url: j.url ?? `https://remoteok.com/remote-jobs/${j.id}`, applyUrl: j.url ?? null, employmentType: null,
    location: j.location ?? null, tags: j.tags ?? [], description: strip(j.description).slice(0, 4000) || null,
    postedAt: j.date ? new Date(j.date) : null, expiresAt: null,
  }));
}

interface HimalayasJob { guid: string; title: string; companyName?: string; employmentType?: string; locationRestrictions?: string[]; categories?: string[]; pubDate?: number; expiryDate?: number; applicationLink?: string; excerpt?: string }

/**
 * Himalayas public API (newest first, 20 per page). Bounded: stops at `since` or `maxPages`.
 * Terms (section 113): apply via the API's applicationLink, credit Himalayas with a link, show only to ourselves,
 * remove expired jobs.
 */
export async function fetchHimalayas(since: Date, maxPages = 40): Promise<GigFeedItem[]> {
  const out: GigFeedItem[] = [];
  for (let page = 0; page < maxPages; page++) {
    const d = await getJson<{ jobs: HimalayasJob[] }>(`https://himalayas.app/jobs/api?limit=20&offset=${page * 20}`, 1000);
    if (!d.jobs?.length) break;
    for (const j of d.jobs) {
      out.push({
        source: "himalayas", externalId: j.guid, title: j.title.trim(), company: j.companyName ?? null, url: j.guid,
        applyUrl: j.applicationLink ?? j.guid, employmentType: j.employmentType ?? null,
        location: (j.locationRestrictions ?? []).join(", ") || null,
        tags: (j.categories ?? []).map((c) => c.replace(/-/g, " ")), description: j.excerpt ?? null,
        postedAt: j.pubDate ? new Date(j.pubDate * 1000) : null, expiresAt: j.expiryDate ? new Date(j.expiryDate * 1000) : null,
      });
    }
    const oldest = d.jobs[d.jobs.length - 1]!.pubDate;
    if (oldest && oldest * 1000 < since.getTime()) break;
  }
  return out;
}

interface AlgoliaHit { objectID: string; title?: string | null; comment_text?: string | null; author?: string; created_at: string; parent_id?: number; story_id?: number }

/** The newest "Ask HN: Who is hiring?" thread, matched by title (the old monthly freelancer thread ended in 2016). */
export async function findHnHiringThread(): Promise<{ id: string; title: string } | null> {
  const d = await getJson<{ hits: AlgoliaHit[] }>("https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=10");
  const hit = d.hits.find((h) => /^Ask HN: Who is hiring\?/i.test(h.title ?? ""));
  return hit ? { id: hit.objectID, title: hit.title! } : null;
}

/**
 * Contract/freelance posts in the monthly HN "Who is hiring" thread. Top-level comments follow
 * "Company | Role | Location | Type"; they're job ads, so code rules (gigVerdict) decide, not an LLM.
 */
export async function fetchHnHiringGigs(since: Date): Promise<GigFeedItem[]> {
  const thread = await findHnHiringThread();
  if (!thread) return [];
  const ts = Math.floor(since.getTime() / 1000);
  const d = await getJson<{ hits: AlgoliaHit[] }>(`https://hn.algolia.com/api/v1/search_by_date?tags=comment,story_${thread.id}&numericFilters=created_at_i>${ts}&hitsPerPage=1000`);
  const out: GigFeedItem[] = [];
  for (const h of d.hits) {
    if (String(h.parent_id) !== thread.id || !h.comment_text) continue; // top-level posts only
    const $ = cheerio.load(h.comment_text);
    const text = $.root().text().replace(/\s+/g, " ").trim();
    const firstLine = (cheerio.load(h.comment_text.split(/<p>/i)[0] ?? "").root().text() || text).trim().slice(0, 200);
    if (!/\b(contract(or)?|freelance|part[- ]time|fractional)\b/i.test(firstLine)) continue;
    const parts = firstLine.split("|").map((x) => x.trim());
    const remote = parts.find((x) => /remote/i.test(x)) ?? null;
    out.push({
      source: "hn", externalId: h.objectID, title: firstLine, company: parts[0] || null,
      url: `https://news.ycombinator.com/item?id=${h.objectID}`, applyUrl: `https://news.ycombinator.com/item?id=${h.objectID}`,
      employmentType: parts.find((x) => /\b(contract|freelance|part[- ]time|fractional)\b/i.test(x)) ?? null,
      location: remote, tags: [], description: text.slice(0, 4000), postedAt: new Date(h.created_at), expiresAt: null,
    });
  }
  return out;
}
