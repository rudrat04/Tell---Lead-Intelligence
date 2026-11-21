import type { Contact } from "@tell/people";
import { verifyEmail, hunterFind, prospeoFind, type Verification, type Found } from "@tell/watchers";
import { getDb, accounts, people, emails, usageDaily, and, eq, inArray, sql } from "@tell/db";
import { neonUsage, type UsageStore } from "./usage.js";

/**
 * Better addresses for today's leads only (after the free pattern / site / DNS step):
 *   a likely or guessed address  -> QuickEmailVerification (QEV_PER_DAY, default 90): valid and not catch-all = verified;
 *                                    invalid = try a finder
 *   no address or an invalid one -> Hunter email-finder (HUNTER_PER_MONTH, default 45), then Prospeo (PROSPEO_PER_MONTH, 40)
 * Each call is counted in usage_daily (qev, hunter, prospeo) before it is made; a missing key skips that step.
 */
type Email = { address: string; status: "observed" | "verified" | "likely" | "guessed" | "invalid"; note: string };

/** The status a verification gives an address (pure; exported for tests). */
export function afterVerify(e: Email, v: Verification | null): Email {
  if (!v || v.result === "unknown") return e;
  if (v.result === "invalid" || v.disposable) return { ...e, status: "invalid", note: "failed verification" };
  return v.acceptAll ? { ...e, note: `${e.note} · catch-all domain (accepts any address)` } : { ...e, status: "verified", note: "verified (QuickEmailVerification)" };
}
/** A finder's answer as an email (pure; exported for tests). */
export function fromFinder(f: Found | null, source: string): Email | null {
  if (!f) return null;
  return { address: f.address, status: f.verified || (f.score ?? 0) >= 80 ? "verified" : "likely", note: `found by ${source}${f.score != null ? ` (score ${f.score})` : ""}` };
}
const splitName = (n: string) => { const w = n.replace(/\s+/g, " ").trim().split(" "); return w.length >= 2 ? { first: w[0]!, last: w[w.length - 1]! } : null; };

async function monthUsed(service: string): Promise<number> {
  const month = new Date().toISOString().slice(0, 7);
  return Number((await getDb().select({ n: sql<number>`coalesce(sum(${usageDaily.used}), 0)` }).from(usageDaily).where(and(eq(usageDaily.service, service), sql`${usageDaily.day}::text like ${`${month}%`}`)))[0]?.n ?? 0);
}

export async function upgradeEmails(contacts: Map<string, Contact | null>, leadIds: string[], opts: { write?: boolean; usage?: UsageStore } = {}): Promise<{ verified: number; found: number; invalid: number; skipped?: string }> {
  const res = { verified: 0, found: 0, invalid: 0 };
  const keys = { qev: !!process.env.QUICKEMAILVERIFICATION_API_KEY, hunter: !!process.env.HUNTER_API_KEY, prospeo: !!process.env.PROSPEO_API_KEY };
  if (!keys.qev && !keys.hunter && !keys.prospeo) return { ...res, skipped: "no email API keys" };
  const usage = opts.usage ?? neonUsage();
  const caps = { qev: Number(process.env.QEV_PER_DAY ?? 90), hunter: Number(process.env.HUNTER_PER_MONTH ?? 45), prospeo: Number(process.env.PROSPEO_PER_MONTH ?? 40) };
  const db = getDb();
  const ids = leadIds.filter((id) => contacts.get(id));
  if (!ids.length) return res;
  const accts = new Map((await db.select({ id: accounts.id, domain: accounts.domain }).from(accounts).where(inArray(accounts.id, ids))).map((a) => [a.id, a.domain]));
  const rows = await db.select({ id: people.id, a: people.accountId, n: people.fullName }).from(people).where(inArray(people.accountId, ids));
  for (const id of ids) {
    const c = contacts.get(id)!, domain = accts.get(id);
    const name = splitName(c.person.name);
    if (!domain || !name) continue;
    let e = c.person.email as Email | undefined;
    let source = "";
    if (e && (e.status === "observed" || e.status === "verified")) continue;
    if (e && (e.status === "likely" || e.status === "guessed") && keys.qev && (await usage.spentToday("qev")) < caps.qev) {
      await usage.addSpend("qev", 1, caps.qev);
      const next = afterVerify(e, await verifyEmail(e.address).catch(() => null));
      if (next.status !== e.status) { source = "quickemailverification"; next.status === "verified" ? res.verified++ : res.invalid++; }
      e = next;
    }
    if (!e || e.status === "invalid") {
      let f: Email | null = null;
      if (keys.hunter && (await monthUsed("hunter")) < caps.hunter) { await usage.addSpend("hunter", 1, caps.hunter); f = fromFinder(await hunterFind(name.first, name.last, domain).catch(() => null), "Hunter"); if (f) source = "hunter"; }
      if (!f && keys.prospeo && (await monthUsed("prospeo")) < caps.prospeo) { await usage.addSpend("prospeo", 1, caps.prospeo); f = fromFinder(await prospeoFind(name.first, name.last, domain).catch(() => null), "Prospeo"); if (f) source = "prospeo"; }
      if (f) { e = f; res.found++; }
    }
    if (!e || !source) continue;
    c.person.email = e;
    const pid = rows.find((r) => r.a === id && r.n === c.person.name)?.id;
    if (opts.write !== false && pid) {
      await db.insert(emails).values({ personId: pid, address: e.address, status: e.status, source, checkedAt: new Date() })
        .onConflictDoUpdate({ target: [emails.personId, emails.address], set: { status: sql`excluded.status`, source: sql`excluded.source`, checkedAt: sql`excluded.checked_at` } });
    }
  }
  return res;
}
