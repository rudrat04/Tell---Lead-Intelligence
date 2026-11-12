import type { Pack } from "@tell/config";
import { fetchYcCompanyProfile } from "@tell/watchers";
import { applyPackIdentity } from "./scheduled.js";
import { pickContact, type Contact, type Person } from "@tell/people";
import { getDb, people, jobBoards, accounts, and, eq, inArray, sql } from "@tell/db";

const DAY = 86_400_000;
export const PEOPLE_REFRESH_DAYS = 30;

/**
 * Contacts for the accounts going into the digest (plan section 9, people only; emails come later).
 * Source today: founders listed publicly on the company's YC page (fetched at most every 30 days, provenance stored).
 */
export async function contactsFor(accountIds: string[], pack: Pack, opts: { write?: boolean } = {}): Promise<Map<string, Contact | null>> {
  applyPackIdentity(pack);
  const out = new Map<string, Contact | null>();
  if (accountIds.length === 0) return out;
  const db = getDb();
  const write = opts.write !== false;

  const known = await db.select().from(people).where(inArray(people.accountId, accountIds));
  const byAccount = new Map<string, Person[]>();
  const freshYc = new Set<string>();
  for (const r of known) {
    const urls = (r.profileUrls ?? {}) as { linkedin?: string; twitter?: string };
    (byAccount.get(r.accountId) ?? byAccount.set(r.accountId, []).get(r.accountId)!).push({
      name: r.fullName, role: r.role, linkedin: urls.linkedin ?? null, twitter: urls.twitter ?? null, source: r.source, sourceUrl: r.sourceUrl,
    });
    if (r.source === "yc" && Date.now() - r.fetchedAt.getTime() < PEOPLE_REFRESH_DAYS * DAY) freshYc.add(r.accountId);
  }

  const slugs = await db.select({ a: jobBoards.accountId, slug: jobBoards.slug }).from(jobBoards)
    .where(and(eq(jobBoards.source, "yc"), inArray(jobBoards.accountId, accountIds)));
  const sizes = new Map((await db.select({ id: accounts.id, size: accounts.sizeBand }).from(accounts).where(inArray(accounts.id, accountIds))).map((r) => [r.id, r.size]));

  for (const { a, slug } of slugs) {
    if (freshYc.has(a)) continue;
    try {
      const prof = await fetchYcCompanyProfile(slug);
      const founders = prof.founders.filter((f) => f.active);
      const list = byAccount.get(a)?.filter((p) => p.source !== "yc") ?? [];
      for (const f of founders) list.push({ name: f.name, role: f.title, linkedin: f.linkedin, twitter: f.twitter, source: "yc", sourceUrl: prof.url });
      byAccount.set(a, list);
      if (write && founders.length) {
        await db.insert(people).values(founders.map((f) => ({
          accountId: a, fullName: f.name, role: f.title, source: "yc", confidence: 0.95, sourceUrl: prof.url,
          profileUrls: { linkedin: f.linkedin ?? undefined, twitter: f.twitter ?? undefined }, fetchedAt: new Date(),
        }))).onConflictDoUpdate({
          target: [people.accountId, people.fullName, people.source],
          set: { role: sql`excluded.role`, profileUrls: sql`excluded.profile_urls`, sourceUrl: sql`excluded.source_url`, fetchedAt: sql`excluded.fetched_at` },
        });
      }
    } catch {
      /* page unavailable: use what we already have */
    }
  }

  for (const id of accountIds) out.set(id, pickContact(byAccount.get(id) ?? [], pack.icp.personas, sizes.get(id) ?? null));
  return out;
}
