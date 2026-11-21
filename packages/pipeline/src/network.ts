import type { Pack } from "@tell/config";
import { exaPeopleSearch, normCompany, type PeopleSearch } from "@tell/watchers";
import { warmPaths, championMove, type Contact, type NetworkRow } from "@tell/people";
import { getDb, networkContacts, accounts, people, signals, usageDaily, and, eq, inArray, isNull, sql } from "@tell/db";
import { applyPackIdentity } from "./scheduled.js";

const DAY = 86_400_000;
type Row = NetworkRow & { id: string; currentCompany: string | null };

/** Your imported network (pnpm network). Empty when nothing was imported: warm paths are then simply off. */
export async function loadNetwork(): Promise<Row[]> {
  const rows = await getDb().select({
    id: networkContacts.id, kind: networkContacts.kind, fullName: networkContacts.fullName, company: networkContacts.company,
    position: networkContacts.position, profileUrl: networkContacts.profileUrl, currentCompany: networkContacts.currentCompany,
  }).from(networkContacts);
  return rows.map((r) => ({ ...r, kind: r.kind as Row["kind"], company: r.company || null }));
}

/**
 * Warm paths for each lead's contact (mutates contact.warm). A past client who just joined is a warm path of their own.
 * Returns how many leads have one.
 */
export function attachWarmPaths(contacts: Map<string, Contact | null>, accts: Map<string, { name: string | null; domain: string }>, network: Row[]): number {
  let n = 0;
  for (const [id, c] of contacts) {
    const a = accts.get(id);
    if (!a || !c) continue;
    const paths = warmPaths({ name: c.person.name, linkedin: c.person.linkedin, workHistory: c.person.workHistory }, a, network);
    if (c.person.source === "network") paths.unshift({ kind: "champion", text: `${c.person.name} was your client: they just joined` });
    if (paths.length) { c.warm = paths; n++; }
  }
  return n;
}

export interface ChampionResult { checked: number; moved: number; matchedAccounts: number; skipped?: string }

/**
 * Champion watch (weekly): people search for your past clients, a few per run, least recently checked first. When one
 * started at a new company in the last 90 days:
 *  - the move is stored (shown once in the digest's "Past clients who moved", whatever the company or region);
 *  - if exactly one tracked account has that company name (never guess), it gets `champion_moved` (if the pack defines it)
 *    and the client becomes that account's contact (people, source "network").
 * Searches are capped per run and per month (usage_daily "exa_champion"), separate from contact searches.
 */
export async function runChampionWatch(opts: { pack: Pack; now?: Date; search?: PeopleSearch | null; perRun?: number; perMonth?: number }): Promise<ChampionResult> {
  applyPackIdentity(opts.pack);
  const now = opts.now ?? new Date();
  const db = getDb();
  const res: ChampionResult = { checked: 0, moved: 0, matchedAccounts: 0 };
  const search = opts.search === undefined ? (process.env.EXA_API_KEY ? exaPeopleSearch() : null) : opts.search;
  if (!search) return { ...res, skipped: "EXA_API_KEY not set" };

  const month = now.toISOString().slice(0, 7);
  const [used] = (await db.execute(sql`select coalesce(sum(used), 0)::int as n from ${usageDaily} where service = 'exa_champion' and to_char(day, 'YYYY-MM') = ${month}`)).rows as { n: number }[];
  const perMonth = opts.perMonth ?? Number(process.env.CHAMPION_PER_MONTH ?? 10);
  let budget = Math.min(opts.perRun ?? Number(process.env.CHAMPION_PER_RUN ?? 10), perMonth - (used?.n ?? 0));
  if (budget <= 0) return { ...res, skipped: "monthly champion search cap reached" };

  // re-check each client at most every 21 days
  const due = await db.select().from(networkContacts)
    .where(and(eq(networkContacts.kind, "client"), sql`(${networkContacts.checkedAt} is null or ${networkContacts.checkedAt} < ${new Date(now.getTime() - 21 * DAY)})`))
    .orderBy(sql`${networkContacts.checkedAt} asc nulls first`).limit(budget);
  if (!due.length) return res;

  const day = now.toISOString().slice(0, 10);
  const specs = opts.pack.signals.signals;
  for (const c of due) {
    if (budget-- <= 0) break;
    await db.insert(usageDaily).values({ day, service: "exa_champion", used: 1, limit: perMonth })
      .onConflictDoUpdate({ target: [usageDaily.day, usageDaily.service], set: { used: sql`${usageDaily.used} + 1` } });
    let hits;
    try { hits = await search.search(`${c.fullName} ${c.company ?? ""}`.trim(), 3); } catch { continue; }
    res.checked++;
    const move = hits.map((h) => championMove({ fullName: c.fullName, company: c.company ?? "" }, h, now)).find(Boolean) ?? null;
    const isNew = move && normCompany(move.company) !== normCompany(c.currentCompany ?? c.company ?? "");
    await db.update(networkContacts).set({
      checkedAt: now,
      ...(move && isNew ? { currentCompany: move.company, currentTitle: move.title, movedAt: move.from, moveUrl: move.url, shownAt: null } : {}),
    }).where(eq(networkContacts.id, c.id));
    if (!move || !isNew) continue;
    res.moved++;

    // the new company as a tracked account: exactly one account with that name, never a guess
    const key = normCompany(move.company);
    if (key.length < 3) continue;
    const candidates = (await db.select({ id: accounts.id, name: accounts.name }).from(accounts).where(eq(accounts.status, "active")))
      .filter((a) => a.name && normCompany(a.name) === key);
    if (candidates.length !== 1) continue;
    const accountId = candidates[0]!.id;
    res.matchedAccounts++;
    await db.insert(people).values({
      accountId, fullName: c.fullName, role: `${move.title} at ${move.company}`.slice(0, 120), source: "network", confidence: 0.9, sourceUrl: move.url,
      profileUrls: { linkedin: /linkedin\.com\/in\//i.test(move.url) ? move.url : c.profileUrl ?? undefined }, fetchedAt: now,
    }).onConflictDoUpdate({ target: [people.accountId, people.fullName, people.source], set: { role: sql`excluded.role`, fetchedAt: sql`excluded.fetched_at` } });
    if (specs.champion_moved) {
      await db.insert(signals).values({
        accountId, class: specs.champion_moved.class, type: "champion_moved", strength: specs.champion_moved.strength,
        evidenceQuote: `${c.fullName}, your past client at ${c.company}, joined as ${move.title} (${move.from.toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" })})`.slice(0, 500),
        // dated when we found it: start dates are month-granular and found weeks later (championMove already caps them at 90 days)
        evidenceUrl: `${move.url}#champion`, observedAt: now, halfLifeDays: specs.champion_moved.half_life_days,
      }).onConflictDoNothing({ target: [signals.evidenceUrl, signals.type] });
    }
  }
  return res;
}

export interface ChampionMove { name: string; was: string; title: string; company: string; since: Date; url: string | null }

/** Moves not shown in a digest yet (any company, any region). `markShown` after a real send. */
export async function championsForDigest(): Promise<ChampionMove[]> {
  const rows = await getDb().select().from(networkContacts)
    .where(and(eq(networkContacts.kind, "client"), sql`${networkContacts.movedAt} is not null`, isNull(networkContacts.shownAt)));
  return rows.map((r) => ({ name: r.fullName, was: r.company ?? "", title: r.currentTitle ?? "", company: r.currentCompany ?? "", since: r.movedAt!, url: r.moveUrl }));
}

export async function markChampionsShown(names: string[], now = new Date()): Promise<void> {
  if (!names.length) return;
  await getDb().update(networkContacts).set({ shownAt: now })
    .where(and(eq(networkContacts.kind, "client"), inArray(networkContacts.fullName, names), isNull(networkContacts.shownAt)));
}

/** Local import (pnpm network): replace one kind's rows with the given list. */
export async function importNetwork(kind: Row["kind"], rows: NetworkRow[]): Promise<{ before: number; after: number }> {
  const db = getDb();
  const before = (await db.select({ id: networkContacts.id }).from(networkContacts).where(eq(networkContacts.kind, kind))).length;
  const seen = new Set<string>();
  const uniq = rows.filter((r) => { const k = `${r.fullName}|${r.company ?? ""}`; if (seen.has(k)) return false; seen.add(k); return true; });
  // clients keep their tracking (checked/moved) across re-imports; connections and employers are replaced
  if (kind !== "client") await db.delete(networkContacts).where(eq(networkContacts.kind, kind));
  for (let i = 0; i < uniq.length; i += 500) {
    await db.insert(networkContacts).values(uniq.slice(i, i + 500).map((r) => ({
      kind, fullName: r.fullName, company: r.company ?? "", position: r.position, profileUrl: r.profileUrl,
    }))).onConflictDoUpdate({
      target: [networkContacts.kind, networkContacts.fullName, networkContacts.company],
      set: { position: sql`excluded.position`, profileUrl: sql`excluded.profile_url`, importedAt: sql`now()` },
    });
  }
  if (kind === "client") {
    const keep = new Set(uniq.map((r) => `${r.fullName}|${r.company ?? ""}`));
    const all = await db.select({ id: networkContacts.id, n: networkContacts.fullName, c: networkContacts.company }).from(networkContacts).where(eq(networkContacts.kind, "client"));
    const gone = all.filter((r) => !keep.has(`${r.n}|${r.c ?? ""}`)).map((r) => r.id);
    if (gone.length) await db.delete(networkContacts).where(inArray(networkContacts.id, gone));
  }
  const after = (await db.select({ id: networkContacts.id }).from(networkContacts).where(eq(networkContacts.kind, kind))).length;
  return { before, after };
}
