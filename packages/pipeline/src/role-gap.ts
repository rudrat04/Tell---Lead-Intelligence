import { industryCounts, type Pack } from "@tell/config";
import { exaPeopleSearch, type PeopleSearch } from "@tell/watchers";
import { gapVerdict, gapQuote, interleave, rolePattern } from "@tell/intel";
import { acceptPeopleHit, type Person } from "@tell/people";
import { getDb, accounts, people, peopleSearches, signals, and, eq, inArray, sql } from "@tell/db";

const DAY = 86_400_000;
/** Re-checked this often while the account stays in the pool (a state is current for 15 days after it was seen). */
export const GAP_RECHECK_DAYS = 14;
const PERSONA = "gap:check";

/**
 * Validate the need before a lead goes out (roles.yaml `gaps`): one people search per account for anyone currently in
 * the role groups you fill. Nobody in a group = a `role_gap` state signal ("Missing: GTM · has Founder's Office: ...");
 * holders are saved as people, so a known ops owner counts against the lead and contacts can use them.
 * Pool accounts only, at most `max` searches a run (Exa, ~$0.007 each, counted in the usage guard via people_searches).
 * Findings are facts, not deliveries: they are written on dry runs too, so a re-run never pays twice.
 */
export async function checkRoleGaps(
  accountIds: string[], pack: Pack, opts: { search?: PeopleSearch | null; max?: number; now?: Date } = {},
): Promise<{ checked: number; gaps: number; changed: string[]; skipped?: string }> {
  const groups = pack.roles.gaps;
  // owner check (Nov 2026): with roles.gaps set but no role_gap signal in the pack, the search only looks for people who
  // already run the system; holders are saved (a core-role holder counts against the lead), absence says nothing
  if (!Object.keys(groups).length) return { checked: 0, gaps: 0, changed: [], skipped: "off (no roles.gaps)" };
  const emitGaps = !!pack.signals.signals.role_gap;
  const search = opts.search === undefined ? (process.env.EXA_API_KEY ? exaPeopleSearch() : null) : opts.search;
  if (!search || !accountIds.length) return { checked: 0, gaps: 0, changed: [], skipped: search ? "no accounts" : "no EXA_API_KEY" };
  const db = getDb();
  const now = opts.now ?? new Date();
  const recent = new Set((await db.select({ a: peopleSearches.accountId }).from(peopleSearches)
    .where(and(eq(peopleSearches.persona, PERSONA), inArray(peopleSearches.accountId, accountIds), sql`${peopleSearches.searchedAt} > ${new Date(now.getTime() - GAP_RECHECK_DAYS * DAY)}`)))
    .map((r) => r.a));
  const rows = await db.select({ id: accounts.id, name: accounts.name, domain: accounts.domain, segment: accounts.segment }).from(accounts).where(inArray(accounts.id, accountIds));
  // a GTM-seat search says nothing about a drug maker or a contractor: only industries that count what it writes
  const byId = new Map(rows.filter((r) => industryCounts(pack, r.segment, "role_gap") || industryCounts(pack, r.segment, "ops_owner_known")).map((r) => [r.id, r]));
  const due = accountIds.filter((id) => byId.has(id) && !recent.has(id)).slice(0, opts.max ?? Number(process.env.ROLE_GAP_PER_RUN ?? 3));

  const allTitles = Object.values(groups).flat();
  const anyRole = [rolePattern(allTitles)];
  // the main titles of every group first (an Exa query reads the start best)
  const query = interleave(Object.values(groups)).slice(0, 12).join(", ");
  const spec = pack.signals.signals.role_gap;
  const changed: string[] = [];
  let gaps = 0, checked = 0;
  for (const id of due) {
    const a = byId.get(id)!;
    const company = a.name ?? a.domain;
    let holders: Person[];
    try {
      const hits = await search.search(`${query} at ${company}`, 15);
      holders = hits.flatMap((h) => { const p = acceptPeopleHit(h, company, a.domain, anyRole); return p ? [p] : []; });
    } catch { continue; /* provider down or out of credit: try again next run */ }
    checked++;
    // people already known at the account (founders, earlier searches) count too
    const known = await db.select({ name: people.fullName, role: people.role }).from(people).where(eq(people.accountId, id));
    const v = gapVerdict(groups, [...holders.map((h) => ({ name: h.name, role: h.role })), ...known]);
    if (holders.length) {
      await db.insert(people).values(holders.map((f) => ({
        accountId: id, fullName: f.name, role: f.role, source: "exa", confidence: 0.7, sourceUrl: f.sourceUrl,
        profileUrls: { linkedin: f.linkedin ?? undefined }, fetchedAt: now,
      }))).onConflictDoUpdate({ target: [people.accountId, people.fullName, people.source], set: { role: sql`excluded.role`, fetchedAt: sql`excluded.fetched_at` } });
    }
    const url = `https://${a.domain}/#role_gap`;
    if (!emitGaps || !spec) { /* owner check only */ }
    else if (v.missing.length) {
      gaps++;
      // a state: first detection keeps observed_at, every detection moves last_seen_at (current while seen)
      await db.insert(signals).values({ accountId: id, class: spec.class, type: "role_gap", strength: spec.strength, evidenceQuote: gapQuote(v).slice(0, 500),
        evidenceUrl: url, observedAt: now, lastSeenAt: now, halfLifeDays: spec.half_life_days })
        .onConflictDoUpdate({ target: [signals.evidenceUrl, signals.type], set: { lastSeenAt: now, evidenceQuote: gapQuote(v).slice(0, 500) } });
    } else {
      // every seat filled now: the old gap is no longer true
      await db.delete(signals).where(and(eq(signals.evidenceUrl, url), eq(signals.type, "role_gap")));
    }
    changed.push(id);
    await db.insert(peopleSearches).values({ accountId: id, persona: PERSONA, provider: "exa", found: holders.length, searchedAt: now })
      .onConflictDoUpdate({ target: [peopleSearches.accountId, peopleSearches.persona, peopleSearches.provider], set: { found: holders.length, searchedAt: now } });
  }
  return { checked, gaps, changed };
}
