import type { Pack } from "@tell/config";
import { fetchRemoteOk, fetchHimalayas, fetchHnHiringGigs, type GigFeedItem } from "@tell/watchers";
import { compileGigRules, gigVerdict, gigDedupeKey } from "@tell/intel";
import { getDb, gigs, jobs, jobBoards, accounts, eq, and, inArray, sql } from "@tell/db";
import { applyPackIdentity } from "./scheduled.js";

const DAY = 86_400_000;
/** sources whose posts carry the company itself win when the same gig appears on several boards */
const SOURCE_RANK: Record<string, number> = { hn: 0, yc: 1, himalayas: 2, remoteok: 3 };

export interface GigRunResult {
  fetched: Record<string, number>;
  errors: Record<string, string>;
  matched: number;
  added: number;
  removedExpired: number;
}

/** YC jobs already tracked by the daily board check that are contract roles. */
async function ycContractGigs(since: Date): Promise<GigFeedItem[]> {
  const db = getDb();
  const rows = await db.select({
    id: jobs.id, title: jobs.title, url: jobs.url, type: jobs.employmentType, postedAt: jobs.postedAt, firstSeen: jobs.firstSeenAt,
    company: accounts.name, domain: accounts.domain,
  }).from(jobs).innerJoin(jobBoards, eq(jobs.boardId, jobBoards.id)).innerJoin(accounts, eq(jobBoards.accountId, accounts.id))
    .where(and(sql`${jobs.closedAt} is null`, sql`${jobs.employmentType} ilike '%contract%'`, sql`coalesce(${jobs.postedAt}, ${jobs.firstSeenAt}) > ${since}`));
  return rows.map((r) => ({
    source: "yc", externalId: r.id, title: r.title.trim(), company: r.company ?? r.domain, url: r.url, applyUrl: r.url,
    employmentType: r.type, location: null, tags: [], description: null, postedAt: r.postedAt ?? r.firstSeen, expiresAt: null,
  }));
}

/** Fetch gigs from every enabled source, keep those matching the pack's gig rules, store new ones. */
export async function runGigs(opts: { pack: Pack; now?: Date }): Promise<GigRunResult> {
  const { pack } = opts;
  const now = opts.now ?? new Date();
  const res: GigRunResult = { fetched: {}, errors: {}, matched: 0, added: 0, removedExpired: 0 };
  if (!pack.gigs.enabled) return res;
  applyPackIdentity(pack);
  const db = getDb();
  const since = new Date(now.getTime() - pack.gigs.max_age_days * DAY);
  const rules = compileGigRules(pack.gigs);
  const s = pack.gigs.sources;

  const sources: [string, boolean, () => Promise<GigFeedItem[]>][] = [
    ["remoteok", s.remoteok, () => fetchRemoteOk()],
    ["himalayas", s.himalayas, () => fetchHimalayas(new Date(now.getTime() - 2 * DAY))],
    ["hn", s.hn_hiring_thread, () => fetchHnHiringGigs(since)],
    ["yc", s.yc, () => ycContractGigs(since)],
  ];
  const all: GigFeedItem[] = [];
  for (const [name, on, fetchFn] of sources) {
    if (!on) continue;
    try {
      const items = await fetchFn();
      res.fetched[name] = items.length;
      all.push(...items);
    } catch (e) {
      res.errors[name] = String(e).slice(0, 200);
    }
  }

  const keep = all.filter((g) => gigVerdict(g, rules, now).ok)
    .map((g) => ({ ...g, dedupeKey: gigDedupeKey(g.company, g.title) }))
    .sort((a, b) => (SOURCE_RANK[a.source] ?? 9) - (SOURCE_RANK[b.source] ?? 9));
  res.matched = keep.length;

  // one row per real-world gig: skip keys already stored from any source
  const keys = [...new Set(keep.map((g) => g.dedupeKey))];
  const existing = new Set(keys.length ? (await db.select({ k: gigs.dedupeKey }).from(gigs).where(inArray(gigs.dedupeKey, keys))).map((r) => r.k) : []);
  const seen = new Set<string>();
  const fresh = keep.filter((g) => !existing.has(g.dedupeKey) && !seen.has(g.dedupeKey) && seen.add(g.dedupeKey));
  if (fresh.length) {
    const rows = await db.insert(gigs).values(fresh.map((g) => ({
      source: g.source, externalId: g.externalId, title: g.title, company: g.company, url: g.url, applyUrl: g.applyUrl,
      employmentType: g.employmentType, location: g.location, tags: g.tags, dedupeKey: g.dedupeKey, postedAt: g.postedAt, expiresAt: g.expiresAt, firstSeenAt: now,
    }))).onConflictDoNothing({ target: [gigs.source, gigs.externalId] }).returning({ id: gigs.id });
    res.added = rows.length;
  }

  // Himalayas terms: remove expired jobs; drop old undelivered gigs too
  const removed = await db.delete(gigs).where(sql`(${gigs.expiresAt} is not null and ${gigs.expiresAt} < ${now})
    or (${gigs.deliveredAt} is null and ${gigs.firstSeenAt} < ${new Date(now.getTime() - 60 * DAY)})`).returning({ id: gigs.id });
  res.removedExpired = removed.length;
  return res;
}

export interface DigestGig { id: string; source: string; title: string; company: string | null; url: string; applyUrl: string | null; employmentType: string | null; location: string | null; postedAt: Date | null }

/** Undelivered gigs for today's digest, newest first. */
export async function gigsForDigest(pack: Pack, now = new Date()): Promise<DigestGig[]> {
  if (!pack.gigs.enabled || pack.gigs.max_in_digest === 0) return [];
  const db = getDb();
  const since = new Date(now.getTime() - pack.gigs.max_age_days * DAY);
  return db.select({
    id: gigs.id, source: gigs.source, title: gigs.title, company: gigs.company, url: gigs.url, applyUrl: gigs.applyUrl,
    employmentType: gigs.employmentType, location: gigs.location, postedAt: gigs.postedAt,
  }).from(gigs).where(and(sql`${gigs.deliveredAt} is null`, sql`coalesce(${gigs.postedAt}, ${gigs.firstSeenAt}) > ${since}`))
    .orderBy(sql`coalesce(${gigs.postedAt}, ${gigs.firstSeenAt}) desc`).limit(pack.gigs.max_in_digest);
}

export async function markGigsDelivered(ids: string[], at = new Date()): Promise<void> {
  if (ids.length) await getDb().update(gigs).set({ deliveredAt: at }).where(inArray(gigs.id, ids));
}
