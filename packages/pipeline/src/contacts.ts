import type { Pack } from "@tell/config";
import { fetchYcCompanyProfile, exaPeopleSearch, type YcCompanyProfile, type PeopleSearch } from "@tell/watchers";
import { toRegex } from "@tell/config";
import { applyPackIdentity } from "./scheduled.js";
import { pickContact, acceptPeopleHit, type Contact, type Person } from "@tell/people";
import { getDb, people, peopleSearches, jobBoards, accounts, and, eq, inArray, sql } from "@tell/db";

const DAY = 86_400_000;
export const PEOPLE_REFRESH_DAYS = 30;

/**
 * Contacts for the accounts going into the digest (plan section 9, people only; emails come later).
 * Source today: founders listed publicly on the company's YC page (fetched at most every 30 days, provenance stored).
 */
export async function contactsFor(
  accountIds: string[], pack: Pack,
  opts: { write?: boolean; search?: PeopleSearch | null; searchFor?: string[]; maxSearches?: number; preferred?: Map<string, string[]> } = {},
): Promise<Map<string, Contact | null>> {
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
  const acctRows = await db.select({ id: accounts.id, size: accounts.sizeBand, name: accounts.name, domain: accounts.domain }).from(accounts).where(inArray(accounts.id, accountIds));
  const sizes = new Map(acctRows.map((r) => [r.id, r.size]));

  for (const { a, slug } of slugs) {
    if (freshYc.has(a)) continue;
    try {
      const prof = await fetchYcCompanyProfile(slug);
      const founders = prof.founders.filter((f) => f.active);
      const list = byAccount.get(a)?.filter((p) => p.source !== "yc") ?? [];
      for (const f of founders) list.push({ name: f.name, role: f.title, linkedin: f.linkedin, twitter: f.twitter, source: "yc", sourceUrl: prof.url });
      byAccount.set(a, list);
      if (write) await saveYcFounders(a, prof);
    } catch {
      /* page unavailable: use what we already have */
    }
  }

  // People search (Exa people index) for personas nobody is known for yet, on the accounts going out today.
  // Cached per account + persona for PEOPLE_REFRESH_DAYS; capped per run to stay inside the free tier.
  const search = opts.search === undefined ? (process.env.EXA_API_KEY ? exaPeopleSearch() : null) : opts.search;
  if (search) {
    let budget = opts.maxSearches ?? 25;
    const targets = new Set(opts.searchFor ?? accountIds);
    const memo = new Set((await db.select({ a: peopleSearches.accountId, p: peopleSearches.persona }).from(peopleSearches)
      .where(and(inArray(peopleSearches.accountId, [...targets]), sql`${peopleSearches.searchedAt} > ${new Date(Date.now() - PEOPLE_REFRESH_DAYS * DAY)}`)))
      .map((r) => `${r.a}:${r.p}`));
    for (const acct of acctRows) {
      if (!targets.has(acct.id)) continue;
      const company = acct.name ?? acct.domain;
      const pref = opts.preferred?.get(acct.id) ?? [];
      const order = [...pref.map((t) => pack.icp.personas.find((p) => p.title === t)).filter((p): p is (typeof pack.icp.personas)[number] => !!p), ...pack.icp.personas.filter((p) => !pref.includes(p.title))];
      for (const persona of order) {
        if (budget <= 0) break;
        if (!pref.includes(persona.title) && persona.size_bands.length && acct.size && !persona.size_bands.includes(acct.size)) continue;
        const rx = persona.patterns.map(toRegex);
        const have = (byAccount.get(acct.id) ?? []).some((p) => p.role && rx.some((r) => r.test(p.role!)));
        if (have || memo.has(`${acct.id}:${persona.title}`)) continue;
        budget--;
        let found: Person[] = [];
        try {
          const hits = await search.search(`${persona.search ?? persona.title.split("/")[0]!.trim()} at ${company}`, 5);
          found = hits.map((h) => acceptPeopleHit(h, company, acct.domain, rx)).filter((x): x is Person => !!x).slice(0, 2);
        } catch { /* provider down or out of credit: try again next run */ continue; }
        const list = byAccount.get(acct.id) ?? [];
        for (const f of found) if (!list.some((p) => p.name === f.name)) list.push(f);
        byAccount.set(acct.id, list);
        if (write) {
          if (found.length) {
            await db.insert(people).values(found.map((f) => ({
              accountId: acct.id, fullName: f.name, role: f.role, source: "exa", confidence: 0.7, sourceUrl: f.sourceUrl,
              profileUrls: { linkedin: f.linkedin ?? undefined }, fetchedAt: new Date(),
            }))).onConflictDoUpdate({ target: [people.accountId, people.fullName, people.source], set: { role: sql`excluded.role`, fetchedAt: sql`excluded.fetched_at` } });
          }
          await db.insert(peopleSearches).values({ accountId: acct.id, persona: persona.title, provider: "exa", found: found.length, searchedAt: new Date() })
            .onConflictDoUpdate({ target: [peopleSearches.accountId, peopleSearches.persona, peopleSearches.provider], set: { found: found.length, searchedAt: new Date() } });
        }
      }
    }
  }

  for (const id of accountIds) {
    const list = byAccount.get(id) ?? [];
    const contact = pickContact(list, pack.icp.personas, sizes.get(id) ?? null, opts.preferred?.get(id) ?? []);
    if (contact) {
      // other named people matching your personas, for "Also reach"
      contact.others = pack.icp.personas
        .filter((p) => p.title !== contact.persona)
        .flatMap((p) => {
          const rx = p.patterns.map(toRegex);
          const hit = list.find((x) => x !== contact.person && x.role && rx.some((r) => r.test(x.role!)));
          return hit ? [{ persona: p.title, person: hit }] : [];
        });
    }
    out.set(id, contact);
  }
  return out;
}

/** Store a YC page's active founders as people (provenance: the YC page). Shared with the weekly account watch. */
export async function saveYcFounders(accountId: string, prof: YcCompanyProfile): Promise<number> {
  const founders = prof.founders.filter((f) => f.active);
  if (!founders.length) return 0;
  await getDb().insert(people).values(founders.map((f) => ({
    accountId, fullName: f.name, role: f.title, source: "yc", confidence: 0.95, sourceUrl: prof.url,
    profileUrls: { linkedin: f.linkedin ?? undefined, twitter: f.twitter ?? undefined }, fetchedAt: new Date(),
  }))).onConflictDoUpdate({
    target: [people.accountId, people.fullName, people.source],
    set: { role: sql`excluded.role`, profileUrls: sql`excluded.profile_urls`, sourceUrl: sql`excluded.source_url`, fetchedAt: sql`excluded.fetched_at` },
  });
  return founders.length;
}
