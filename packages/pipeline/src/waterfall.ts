import { createHash } from "node:crypto";
import { toRegex, type Pack } from "@tell/config";
import { pickContact, titleFitsCompany, type Contact, type Person } from "@tell/people";
import { hunterDomainSearch, type DomainPerson } from "@tell/watchers";
import { getDb, accounts, people, peopleSearches, emails, suppressionList, and, eq, inArray, sql } from "@tell/db";
import { findSureEmail, isSureEmail, finderMonthUsed as monthUsed, hunterHasRoom, hunterSpent, type WaterfallDeps } from "./email-apis.js";
import { neonUsage, type UsageStore } from "./usage.js";
import { othersFor } from "./contacts.js";

/**
 * People and emails beyond the free steps (Tell's own; Air Waterfall was removed Nov 26 2026):
 *   people:  a lead with nobody to contact (it would be dropped) gets one Hunter domain search: the people Hunter lists
 *            at the domain whose title matches a buyer become contacts (people source "hunter"), and an address Hunter
 *            verified comes with them, so it is often the email too. Cached REFRESH_DAYS (people_searches), capped per
 *            run (HUNTER_DOMAIN_PER_RUN) and inside Hunter's monthly allowance (usage "hunter").
 *   enrich:  only on a "Find emails" click (Telegram / Sheet link -> Worker -> enrich.yml -> enrichContact): each person
 *            through findSureEmail; only a verified address is returned.
 */
const REFRESH_DAYS = 30;
const DAY = 86_400_000;
const SOURCE = "hunter";

/** Hunter's people at a domain as Tell people, kept only when the title matches a buyer and names no other company
 *  (pure; exported for tests). An address Hunter verified rides along as the person's verified email. */
export function domainPeople(list: DomainPerson[], pack: Pick<Pack, "icp">, company: string, domain: string): Person[] {
  const rx = pack.icp.personas.flatMap((p) => p.patterns.map(toRegex));
  return list.filter((h) => h.position && rx.some((r) => r.test(h.position!)) && titleFitsCompany(h.position, company, domain) && h.address.endsWith(`@${domain.toLowerCase()}`))
    .map((h) => ({ name: `${h.firstName} ${h.lastName}`.trim(), role: h.position, source: SOURCE, linkedin: h.linkedin,
      ...(h.verified ? { email: { address: h.address, status: "verified" as const, note: "verified (Hunter)" } } : {}) }));
}

/** Contacts for leads nobody is known for (they'd be dropped), from Hunter's domain search. Mutates `contacts`. */
export async function domainContacts(
  contacts: Map<string, Contact | null>, targets: string[], pack: Pack,
  opts: { write?: boolean; search?: typeof hunterDomainSearch; max?: number; preferred?: Map<string, string[]>; usage?: UsageStore; hunterLeft?: () => Promise<number | null> } = {},
): Promise<{ looked: number; found: number; skipped?: string }> {
  if (!process.env.HUNTER_API_KEY && !opts.search) return { looked: 0, found: 0, skipped: "HUNTER_API_KEY not set" };
  const write = opts.write !== false, usage = opts.usage ?? neonUsage(), cap = Number(process.env.HUNTER_PER_MONTH ?? 45);
  const todo = targets.filter((id) => !contacts.get(id));
  if (!todo.length) return { looked: 0, found: 0 };
  const db = getDb();
  const recent = new Set((await db.select({ a: peopleSearches.accountId }).from(peopleSearches).where(and(
    inArray(peopleSearches.accountId, todo), eq(peopleSearches.provider, "hunter-domain"), sql`${peopleSearches.searchedAt} > ${new Date(Date.now() - REFRESH_DAYS * DAY)}`,
  ))).map((r) => r.a));
  const accts = await db.select({ id: accounts.id, domain: accounts.domain, size: accounts.sizeBand, name: accounts.name }).from(accounts).where(inArray(accounts.id, todo));
  let budget = opts.max ?? Number(process.env.HUNTER_DOMAIN_PER_RUN ?? 5), looked = 0, found = 0;
  for (const a of accts) {
    if (recent.has(a.id) || budget <= 0) continue;
    if (!(await hunterHasRoom(monthUsed, cap, opts.hunterLeft))) return { looked, found, skipped: "Hunter's credits are spent" };
    budget--; looked++;
    const r = await (opts.search ?? hunterDomainSearch)(a.domain).catch(() => null);
    if (!r) continue; // down: try again next run
    // (Hunter charges a domain search only when it lists someone)
    if (r.people.length) { await usage.addSpend("hunter", 1, cap); hunterSpent(); }
    const list = domainPeople(r.people, pack, a.name ?? a.domain, a.domain);
    if (write) {
      for (const p of list) {
        const [row] = await db.insert(people).values({ accountId: a.id, fullName: p.name, role: p.role, source: SOURCE, confidence: 0.7, profileUrls: { linkedin: p.linkedin ?? undefined }, fetchedAt: new Date() })
          .onConflictDoUpdate({ target: [people.accountId, people.fullName, people.source], set: { role: sql`excluded.role`, fetchedAt: sql`excluded.fetched_at` } }).returning({ id: people.id }).catch(() => []);
        if (row && p.email) await db.insert(emails).values({ personId: row.id, address: p.email.address, status: "verified", source: "hunter", checkedAt: new Date() })
          .onConflictDoUpdate({ target: [emails.personId, emails.address], set: { status: sql`excluded.status`, source: sql`excluded.source`, checkedAt: sql`excluded.checked_at` } }).catch(() => undefined);
      }
      await db.insert(peopleSearches).values({ accountId: a.id, persona: "*", provider: "hunter-domain", found: list.length, searchedAt: new Date() })
        .onConflictDoUpdate({ target: [peopleSearches.accountId, peopleSearches.persona, peopleSearches.provider], set: { found: list.length, searchedAt: new Date() } });
    }
    const c = pickContact(list, pack.icp.personas, a.size, opts.preferred?.get(a.id) ?? []);
    if (c) { c.others = othersFor(c, list, pack.icp.personas, opts.preferred?.get(a.id) ?? []); contacts.set(a.id, c); found++; }
  }
  return { looked, found };
}

/** A sure address after a click: the address and who vouched for it (null = nothing we can stand behind). */
export type SureEmail = { address: string; status: "verified" | "observed"; note: string } | null;

/** What the "Enrich email" cell says after a click (the address itself goes in Email, only when it is sure). Pure;
 *  exported for tests. */
export function enrichStatus(sure: SureEmail, suppressed = false, r?: { catchAll?: boolean; email?: { status: string } | null }): string {
  if (suppressed) return "suppressed (do not contact)";
  if (sure) {
    const by = sure.note.match(/^verified \((.+)\)$/)?.[1] ?? sure.note.match(/^found by (\S+)/)?.[1] ?? (sure.status === "observed" ? "published" : "");
    return `done: verified${by ? ` (${by})` : ""}`;
  }
  if (r?.catchAll) return "no verified address (catch-all domain)";
  return r?.email?.status === "invalid" ? "no deliverable address" : "not found";
}

/** The person's stored addresses: a sure one ends the search, a bounced / operator-marked one is never tried again,
 *  anything else is a candidate to check. */
async function storedEmail(accountId: string, name: string): Promise<{ address: string; status: "observed" | "verified" | "likely" | "guessed" | "invalid"; note: string } | null> {
  const rows = await getDb().select({ address: emails.address, status: emails.status, source: emails.source }).from(emails).innerJoin(people, eq(people.id, emails.personId))
    .where(and(eq(people.accountId, accountId), eq(people.fullName, name)));
  const pick = rows.find((r) => r.status === "verified") ?? rows.find((r) => r.status === "invalid" && (r.source === "bounce" || r.source?.startsWith("operator")))
    ?? rows.find((r) => r.status === "observed") ?? rows.find((r) => r.status === "likely");
  return pick ? { address: pick.address, status: pick.status as "verified", note: pick.status === "invalid" ? "marked invalid" : pick.source ?? "" } : null;
}

/**
 * One find-email click for one person: Tell's waterfall (findSureEmail: finders that only answer with verified
 * addresses first, the verifiers only for addresses still unsure). Stored in `emails`; suppressed addresses are never
 * returned.
 */
export async function enrichContact(
  p: { accountId: string; name: string; role?: string | null; linkedin?: string | null }, opts: { deps?: WaterfallDeps } = {},
): Promise<{ sure: SureEmail; suppressed: boolean; catchAll: boolean; steps: string[] }> {
  const db = getDb();
  const [a] = await db.select({ domain: accounts.domain }).from(accounts).where(eq(accounts.id, p.accountId));
  if (!a) throw new Error("account not found");
  const current = await storedEmail(p.accountId, p.name);
  const r = await findSureEmail({ name: p.name, domain: a.domain, linkedin: p.linkedin ?? null, current }, opts.deps ?? {});
  const e = r.email;
  const sup = await db.select().from(suppressionList);
  const suppressed = !!e && sup.some((s) => s.hashedEmail === createHash("sha256").update(e.address.trim().toLowerCase()).digest("hex") || s.domain === e.address.split("@")[1]);
  if (e && r.source && !suppressed) {
    const [person] = await db.select({ id: people.id }).from(people).where(and(eq(people.accountId, p.accountId), eq(people.fullName, p.name))).limit(1);
    if (person) await db.insert(emails).values({ personId: person.id, address: e.address, status: e.status, source: r.source, checkedAt: new Date() })
      .onConflictDoUpdate({ target: [emails.personId, emails.address], set: { status: sql`excluded.status`, source: sql`excluded.source`, checkedAt: sql`excluded.checked_at` } });
  }
  const sure: SureEmail = e && isSureEmail(e) && !suppressed ? { address: e.address, status: e.status as "verified" | "observed", note: e.note } : null;
  return { sure, suppressed, catchAll: r.catchAll, steps: r.steps };
}
