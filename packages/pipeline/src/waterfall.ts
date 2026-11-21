import { createHash } from "node:crypto";
import { toRegex, type Pack } from "@tell/config";
import { pickContact, titleFitsCompany, type Contact, type Person } from "@tell/people";
import { airWaterfall, type AirWaterfall, type WaterfallEmail } from "@tell/watchers";
import { getDb, accounts, people, peopleSearches, emails, suppressionList, and, eq, inArray, sql } from "@tell/db";

/**
 * Air Waterfall (the operator's own lookup + email service) in the digest, after Tell's free steps:
 *   lookup:  a lead with nobody to contact (it would be dropped) gets one /people/discover call with the pack's
 *            persona titles; a person whose title matches a persona becomes the contact (people source "air-waterfall")
 *   enrich:  only on a "Find email" click (digest button / Sheet link -> Worker -> enrich.yml -> enrichContact):
 *            the answer goes into the Sheet's "Enrich email" column and `emails` (never automatic: it spends credits)
 * Lookups are cached for REFRESH_DAYS (people_searches), capped per run, and off without AIR_WATERFALL_URL + key.
 */
const REFRESH_DAYS = 30;
const DAY = 86_400_000;
const SOURCE = "air-waterfall";
/** waterfall verdict -> the status stored in `emails` (the verdict itself is kept in source, "air-waterfall:<verdict>") */
const STORED_STATUS: Record<WaterfallEmail["verdict"], string> = { valid: "verified", likely: "likely", risky: "guessed", invalid: "invalid", not_found: "guessed" };

const splitName = (name: string) => { const parts = name.trim().split(/\s+/); return { firstName: parts[0]!, lastName: parts.slice(1).join(" ") }; };

/** Contacts for leads nobody is known for (they'd be dropped). Mutates `contacts`. */
export async function waterfallContacts(
  contacts: Map<string, Contact | null>, targets: string[], pack: Pack,
  opts: { write?: boolean; client?: AirWaterfall | null; max?: number; preferred?: Map<string, string[]> } = {},
): Promise<{ looked: number; found: number; skipped?: string }> {
  const client = opts.client === undefined ? airWaterfall() : opts.client;
  if (!client) return { looked: 0, found: 0, skipped: "not configured" };
  const write = opts.write !== false;
  const todo = targets.filter((id) => !contacts.get(id));
  if (!todo.length) return { looked: 0, found: 0 };
  const db = getDb();
  const recent = new Set((await db.select({ a: peopleSearches.accountId }).from(peopleSearches).where(and(
    inArray(peopleSearches.accountId, todo), eq(peopleSearches.provider, SOURCE), sql`${peopleSearches.searchedAt} > ${new Date(Date.now() - REFRESH_DAYS * DAY)}`,
  ))).map((r) => r.a));
  const accts = await db.select({ id: accounts.id, domain: accounts.domain, size: accounts.sizeBand, name: accounts.name }).from(accounts).where(inArray(accounts.id, todo));
  const titles = [...new Set(pack.icp.personas.map((p) => p.search ?? p.title.split("/")[0]!.trim()))];
  let budget = opts.max ?? Number(process.env.AIR_WATERFALL_MAX_LOOKUPS ?? 10), looked = 0, found = 0;
  for (const a of accts) {
    if (recent.has(a.id) || budget-- <= 0) continue;
    looked++;
    let list: Person[] = [];
    try {
      const hits = await client.discover(a.domain, titles);
      const rx = pack.icp.personas.flatMap((p) => p.patterns.map(toRegex));
      // a title naming another company ("Founder | Studio Harbor Design") is someone else with a similar name
      list = hits.filter((h) => !h.nameShared && h.title && rx.some((r) => r.test(h.title)) && titleFitsCompany(h.title, a.name ?? a.domain, a.domain)).map((h) => ({
        name: `${h.firstName} ${h.lastName}`.trim(), role: h.title, source: SOURCE, sourceUrl: h.sourceUrl,
        linkedin: h.sourceUrl && /linkedin\.com\/in\//i.test(h.sourceUrl) ? h.sourceUrl : null,
      }));
    } catch { continue; /* service asleep or down: the lead keeps no contact, try again next run */ }
    if (write) {
      if (list.length) {
        await db.insert(people).values(list.map((p) => ({ accountId: a.id, fullName: p.name, role: p.role, source: SOURCE, confidence: 0.6, sourceUrl: p.sourceUrl,
          profileUrls: { linkedin: p.linkedin ?? undefined }, fetchedAt: new Date() })))
          .onConflictDoUpdate({ target: [people.accountId, people.fullName, people.source], set: { role: sql`excluded.role`, fetchedAt: sql`excluded.fetched_at` } });
      }
      await db.insert(peopleSearches).values({ accountId: a.id, persona: "*", provider: SOURCE, found: list.length, searchedAt: new Date() })
        .onConflictDoUpdate({ target: [peopleSearches.accountId, peopleSearches.persona, peopleSearches.provider], set: { found: list.length, searchedAt: new Date() } });
    }
    const c = pickContact(list, pack.icp.personas, a.size, opts.preferred?.get(a.id) ?? []);
    if (c) { contacts.set(a.id, c); found++; }
  }
  return { looked, found };
}

/** What the "Enrich email" cell says after a click (the address itself goes in Email). Pure; exported for tests. */
export function enrichStatus(r: WaterfallEmail, suppressed = false): string {
  if (suppressed) return "suppressed (do not contact)";
  if (r.email) return `done: ${r.verdict}, ${Math.round(r.confidence * 100)}%${r.foundAt ? ` (${r.foundAt})` : ""}`;
  return r.verdict === "invalid" ? "no deliverable address" : "not found";
}

/**
 * One find-email click: the delivery's contact through /enrich, stored in `emails` (status by verdict, source
 * "air-waterfall:<verdict>"). Suppressed addresses are never returned.
 */
export async function enrichContact(
  p: { accountId: string; name: string; role?: string | null }, client: AirWaterfall,
): Promise<{ result: WaterfallEmail; suppressed: boolean }> {
  const db = getDb();
  const [a] = await db.select({ domain: accounts.domain }).from(accounts).where(eq(accounts.id, p.accountId));
  if (!a) throw new Error("account not found");
  const result = await client.enrich({ ...splitName(p.name), domain: a.domain, role: p.role });
  let suppressed = false;
  if (result.email) {
    const sup = await db.select().from(suppressionList);
    const hash = createHash("sha256").update(result.email).digest("hex");
    suppressed = sup.some((r) => r.hashedEmail === hash || r.domain === result.email!.split("@")[1]);
    const [person] = await db.select({ id: people.id }).from(people).where(and(eq(people.accountId, p.accountId), eq(people.fullName, p.name))).limit(1);
    if (person && !suppressed) {
      await db.insert(emails).values({ personId: person.id, address: result.email, status: STORED_STATUS[result.verdict], source: `${SOURCE}:${result.verdict}`, checkedAt: new Date() })
        .onConflictDoUpdate({ target: [emails.personId, emails.address], set: { status: sql`excluded.status`, source: sql`excluded.source`, checkedAt: sql`excluded.checked_at` } });
    }
  }
  return { result: suppressed ? { ...result, email: null } : result, suppressed };
}
