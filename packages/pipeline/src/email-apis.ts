import type { Contact } from "@tell/people";
import { verifyEmail, hunterFind, prospeoFind, inboxTrueVerify, apolloFind, webEmailSearch, type Verification, type Found } from "@tell/watchers";
import { localPart, patternsFor, isRoleAddress, type Pattern } from "@tell/people";
import { getDb, accounts, people, emails, usageDaily, domainMail, and, eq, inArray, sql } from "@tell/db";
import { neonUsage, type UsageStore } from "./usage.js";

/**
 * Better addresses for today's leads only (after the free pattern / site / DNS step):
 *   any address but a verified one -> QuickEmailVerification (QEV_PER_DAY, default 90): valid and not catch-all = verified;
 *                                    invalid = try a finder (a published address stays unless it fails)
 *   no sure address                -> Hunter email-finder (HUNTER_PER_MONTH, default 45), then Prospeo (PROSPEO_PER_MONTH, 40),
 *                                    then Apollo; a finder's unverified answer goes through the verifiers too
 * Callers then drop whatever isn't sure (keepSureEmails): a guess is never shown.
 * Each call is counted in usage_daily (qev, hunter, prospeo) before it is made; a missing key skips that step.
 */
type Email = { address: string; status: "observed" | "verified" | "likely" | "guessed" | "invalid"; note: string };

/** The status a verification gives an address (pure; exported for tests). `by` names the verifier in the note. */
export function afterVerify(e: Email, v: Verification | null, by = "QuickEmailVerification"): Email {
  if (!v || v.result === "unknown") return e;
  if (v.result === "invalid" || v.disposable) return { ...e, status: "invalid", note: "failed verification" };
  return v.acceptAll ? { ...e, note: `${e.note} · catch-all domain (accepts any address)` } : { ...e, status: "verified", note: `verified (${by})` };
}
/** Ask the second verifier? Only when the first gave no verdict (no key, cap spent, failed, "unknown"); a catch-all is a
 *  verdict (a second service sees the same catch-all), so it isn't asked again (pure; exported for tests). */
export const needsSecondCheck = (v: Verification | null) => !v || v.result === "unknown";
/** A finder's answer as an email (pure; exported for tests): verified only when the finder itself verified the mailbox;
 *  a score alone is a guess, which goes through the verifiers like any other. */
export function fromFinder(f: Found | null, source: string): Email | null {
  if (!f) return null;
  return { address: f.address, status: f.verified ? "verified" : "likely", note: `found by ${source}${f.score != null ? ` (score ${f.score})` : ""}` };
}
/** Sure = an address we can stand behind: verified by a mailbox check or a finder that verified it, or published in
 *  public for this exact name and not failed by a verifier (pure; exported for tests). Nothing else is ever shown. */
export const isSureEmail = (e: Email | null | undefined): boolean => !!e && (e.status === "verified" || e.status === "observed");
/** Drop every address that isn't sure (pattern guesses, "likely", catch-alls, invalid) from the contacts, the main
 *  person and everyone under them, so no display can show one (mutates; returns how many were dropped). */
export function keepSureEmails(contacts: Map<string, Contact | null>): number {
  let dropped = 0;
  for (const c of contacts.values()) {
    if (!c) continue;
    for (const p of [c.person, ...(c.others ?? []).map((o) => o.person)]) if (p.email && !isSureEmail(p.email as Email)) { p.email = null; dropped++; }
  }
  return dropped;
}
const splitName = (n: string) => { const w = n.replace(/\s+/g, " ").trim().split(" "); return w.length >= 2 ? { first: w[0]!, last: w[w.length - 1]! } : null; };

async function monthUsed(service: string): Promise<number> {
  const month = new Date().toISOString().slice(0, 7);
  return Number((await getDb().select({ n: sql<number>`coalesce(sum(${usageDaily.used}), 0)` }).from(usageDaily).where(and(eq(usageDaily.service, service), sql`${usageDaily.day}::text like ${`${month}%`}`)))[0]?.n ?? 0);
}

/** The usual company formats, most common first (a pattern learned from the domain goes ahead of them). */
const PERMUTATIONS: Pattern[] = ["first.last", "first", "firstlast", "flast", "f.last", "first_last", "firstl", "last.first"];
/** Addresses to try for a name at a domain, learned pattern first, at most `n` (pure; exported for tests). These are
 *  never shown as they are: each one only counts once a verifier says that mailbox exists. */
export function candidateAddresses(fullName: string, domain: string, learned: Pattern | null = null, n = 4): string[] {
  const out: string[] = [];
  for (const p of [...(learned ? [learned] : []), ...PERMUTATIONS]) {
    const l = localPart(p, fullName);
    const a = l ? `${l}@${domain.toLowerCase()}` : null;
    if (a && !out.includes(a)) out.push(a);
    if (out.length >= n) break;
  }
  return out;
}

export interface WaterfallKeys { qev: boolean; hunter: boolean; prospeo: boolean; inboxtrue: boolean; apollo: boolean; web: boolean }
const envKeys = (): WaterfallKeys => ({ qev: !!process.env.QUICKEMAILVERIFICATION_API_KEY, hunter: !!process.env.HUNTER_API_KEY, prospeo: !!process.env.PROSPEO_API_KEY,
  inboxtrue: !!process.env.INBOXTRUE_API_KEY, apollo: !!process.env.APOLLO_API_KEY, web: !!(process.env.SERPER_API_KEY || process.env.TAVILY_API_KEY) });
const envCaps = () => ({ qev: Number(process.env.QEV_PER_DAY ?? 90), hunter: Number(process.env.HUNTER_PER_MONTH ?? 45), prospeo: Number(process.env.PROSPEO_PER_MONTH ?? 40),
  inboxtrue: Number(process.env.INBOXTRUE_PER_DAY ?? 50), apollo: Number(process.env.APOLLO_PER_MONTH ?? 40), web: Number(process.env.EMAIL_WEB_PER_DAY ?? 20),
  permutations: Number(process.env.EMAIL_PERMUTATIONS ?? 4) });

/** The step calls (tests pass fakes). */
export interface WaterfallDeps {
  verify?: typeof verifyEmail; inboxTrue?: typeof inboxTrueVerify; hunter?: typeof hunterFind; prospeo?: typeof prospeoFind; apollo?: typeof apolloFind;
  web?: typeof webEmailSearch; usage?: UsageStore; monthUsed?: (service: string) => Promise<number>; keys?: WaterfallKeys;
}
export interface WaterfallResult { email: Email | null; source: string; steps: string[]; catchAll: boolean }

/**
 * Tell's own email waterfall for one person: the first SURE address, or the best unsure one for the record (never shown).
 *   1. the address we already have (published, pattern, Air Waterfall's guess) -> QuickEmailVerification, then InboxTrue
 *   2. web search: the quoted name + "@domain" in public pages (Serper, Tavily when it fails) -> verified
 *   3. the usual formats (learned pattern first, EMAIL_PERMUTATIONS of them) -> each verified until one exists; stopped
 *      at once on a catch-all domain (it accepts any address, so no check there means anything)
 *   4. finders: Hunter, Prospeo (Enrich Person, verified only; by LinkedIn when we have it), Apollo; a finder's
 *      unverified answer goes through the verifiers too
 * Every call is counted in usage_daily before it is made (qev, inboxtrue, serper_email, hunter, prospeo, apollo); a
 * missing key skips that step. Free steps first, the finders' small monthly allowances last.
 */
export async function findSureEmail(
  p: { name: string; domain: string; linkedin?: string | null; current?: Email | null; learned?: Pattern | null }, deps: WaterfallDeps = {},
): Promise<WaterfallResult> {
  const keys = deps.keys ?? envKeys(), caps = envCaps(), usage = deps.usage ?? neonUsage(), month = deps.monthUsed ?? monthUsed;
  const steps: string[] = [];
  const name = splitName(p.name), domain = p.domain.toLowerCase();
  let best: Email | null = p.current ?? null, source = "", catchAll = false;
  const sure = (e: Email, src: string): WaterfallResult => ({ email: e, source: src, steps, catchAll });
  // one address through QEV, then InboxTrue only where QEV gave no verdict
  const check = async (x: Email): Promise<{ next: Email; src: string } | null> => {
    let v: Verification | null = null, by = "QuickEmailVerification", src = "quickemailverification";
    if (keys.qev && (await usage.spentToday("qev")) < caps.qev) { await usage.addSpend("qev", 1, caps.qev); v = await (deps.verify ?? verifyEmail)(x.address).catch(() => null); }
    if (needsSecondCheck(v) && keys.inboxtrue && (await usage.spentToday("inboxtrue")) < caps.inboxtrue) {
      await usage.addSpend("inboxtrue", 1, caps.inboxtrue);
      const v2 = await (deps.inboxTrue ?? inboxTrueVerify)(x.address).catch(() => null);
      if (!needsSecondCheck(v2)) { v = v2; by = "InboxTrue"; src = "inboxtrue"; }
    }
    if (v?.acceptAll) catchAll = true;
    const next = afterVerify(x, v, by);
    return next.status === x.status && next.note === x.note ? null : { next, src };
  };
  const tried = new Set<string>();
  /** verify one candidate; a sure answer ends the waterfall */
  const attempt = async (x: Email, src: string): Promise<Email | null> => {
    if (tried.has(x.address)) return null;
    tried.add(x.address);
    if (x.status === "verified") return x;
    const r = await check(x);
    if (r?.next.status === "verified") { source = r.src; return r.next; }
    if (r?.next.status === "invalid") { if (!best || best.address === x.address) { best = r.next; source = r.src; } return null; }
    if (!best) { best = r?.next ?? x; source = src; }
    return null;
  };

  // a bounced (or operator-marked) address is never tried again
  if (p.current?.status === "invalid") tried.add(p.current.address);
  // 1. what we have
  if (p.current && p.current.status !== "invalid") {
    steps.push("current");
    if (p.current.status === "verified") return sure(p.current, "");
    const r = await check(p.current);
    if (r?.next.status === "invalid") { best = r.next; source = r.src; }
    else if (p.current.status === "observed") return sure(p.current, ""); // published for this name, not failed
    else if (r?.next.status === "verified") return sure(r.next, r.src);
    tried.add(p.current.address);
  }
  if (!name) return { email: best, source, steps, catchAll };

  // 2. public web pages that show this person's address
  if (keys.web && (await usage.spentToday("serper_email")) < caps.web) {
    steps.push("web");
    await usage.addSpend("serper_email", 1, caps.web);
    const found = (await (deps.web ?? webEmailSearch)(p.name, domain).catch(() => [])).filter((a) => !isRoleAddress(a.address) && patternsFor(a.address.split("@")[0]!, p.name).length);
    for (const f of found.slice(0, 2)) {
      const e = await attempt({ address: f.address, status: "likely", note: `on a public page (${f.url})` }, "web");
      if (e) return sure(e, source || "web");
    }
  }

  // 3. the usual formats, each checked by a verifier (stops on a catch-all domain)
  if (keys.qev || keys.inboxtrue) {
    steps.push("formats");
    for (const a of candidateAddresses(p.name, domain, p.learned ?? null, caps.permutations)) {
      if (catchAll) break;
      const e = await attempt({ address: a, status: "likely", note: "company format" }, "format");
      if (e) return sure({ ...e, note: `${e.note} · company format` }, source);
    }
  }

  // 4. the finders (small monthly allowances)
  const finders: [keyof WaterfallKeys, string, () => Promise<Found | null>][] = [
    ["hunter", "Hunter", () => (deps.hunter ?? hunterFind)(name.first, name.last, domain)],
    ["prospeo", "Prospeo", () => (deps.prospeo ?? prospeoFind)(name.first, name.last, domain, undefined, { linkedin: p.linkedin ?? null })],
    ["apollo", "Apollo", () => (deps.apollo ?? apolloFind)(name.first, name.last, domain)],
  ];
  for (const [k, label, call] of finders) {
    if (!keys[k] || (await month(k)) >= caps[k as "hunter" | "prospeo" | "apollo"]) continue;
    steps.push(k);
    await usage.addSpend(k, 1, caps[k as "hunter" | "prospeo" | "apollo"]);
    const f = fromFinder(await call().catch(() => null), label);
    // a finder's address on another domain (an old employer, a personal mailbox) is not this company's
    if (!f || f.address.split("@")[1] !== domain) continue;
    const e = await attempt(f, k);
    if (e) return sure(e, source || k);
  }
  return { email: best, source, steps, catchAll };
}

export async function upgradeEmails(contacts: Map<string, Contact | null>, leadIds: string[], opts: { write?: boolean; usage?: UsageStore; deps?: WaterfallDeps } = {}): Promise<{ verified: number; found: number; invalid: number; skipped?: string }> {
  const res = { verified: 0, found: 0, invalid: 0 };
  const keys = opts.deps?.keys ?? envKeys();
  if (!Object.values(keys).some(Boolean)) return { ...res, skipped: "no email API keys" };
  const deps: WaterfallDeps = { ...opts.deps, keys, usage: opts.usage ?? opts.deps?.usage ?? neonUsage() };
  const db = getDb();
  const ids = leadIds.filter((id) => contacts.get(id));
  if (!ids.length) return res;
  const accts = new Map((await db.select({ id: accounts.id, domain: accounts.domain }).from(accounts).where(inArray(accounts.id, ids))).map((a) => [a.id, a.domain]));
  const learned = new Map((await db.select({ d: domainMail.domain, p: domainMail.pattern }).from(domainMail).where(inArray(domainMail.domain, [...accts.values()]))).map((r) => [r.d, r.p as Pattern | null]));
  const rows = await db.select({ id: people.id, a: people.accountId, n: people.fullName }).from(people).where(inArray(people.accountId, ids));
  for (const id of ids) {
    const c = contacts.get(id)!, domain = accts.get(id);
    if (!domain) continue;
    const before = c.person.email as Email | null | undefined;
    if (before?.status === "verified") continue;
    // a bounced (or operator-marked) address stays invalid, and the waterfall looks for another one
    const r = await findSureEmail({ name: c.person.name, domain, linkedin: c.person.linkedin ?? null, current: before ?? null, learned: learned.get(domain) ?? null }, deps);
    const e = r.email;
    if (!e) continue;
    if (isSureEmail(e)) { if (e.address !== before?.address) res.found++; else if (e.status !== before?.status) res.verified++; }
    else if (e.status === "invalid" && before?.status !== "invalid") res.invalid++;
    c.person.email = e;
    const pid = rows.find((x) => x.a === id && x.n === c.person.name)?.id;
    if (opts.write !== false && pid && r.source) {
      await db.insert(emails).values({ personId: pid, address: e.address, status: e.status, source: r.source, checkedAt: new Date() })
        .onConflictDoUpdate({ target: [emails.personId, emails.address], set: { status: sql`excluded.status`, source: sql`excluded.source`, checkedAt: sql`excluded.checked_at` } });
    }
  }
  return res;
}
