import { createHash } from "node:crypto";
import { fetchMxHosts, fetchSitePages, fetchGithubOrgAddresses } from "@tell/watchers";
import { emailFor, learnPattern, extractAddresses, genericAddress, mailProvider, isRoleAddress, type SeenAddress, type DomainMailInfo, type EmailGuess, type Contact, type Pattern } from "@tell/people";
import { getDb, people, emails, domainMail, accounts, suppressionList, inArray, sql } from "@tell/db";

const DAY = 86_400_000;
export const MAIL_REFRESH_DAYS = 30;

export interface DomainEvidence { mail: DomainMailInfo; seen: SeenAddress[] }

/** Gather public evidence for one domain: MX, addresses on its own site, its GitHub org's commit authors. */
export async function gatherDomainEvidence(domain: string, companyName: string | null, knownNames: string[]): Promise<DomainEvidence> {
  const mx = await fetchMxHosts(domain);
  const seen: SeenAddress[] = [];
  const names = [...knownNames];
  if (mx === null || mx.length) {
    for (const page of await fetchSitePages(domain)) {
      for (const a of extractAddresses(page.text, domain)) if (!seen.some((s) => s.address === a)) seen.push({ address: a, sourceUrl: page.url });
    }
    const label = domain.split(".")[0]!;
    const candidates = [label, companyName ?? "", (companyName ?? "").replace(/\s+/g, "-"), `${label}hq`, `${label}-hq`];
    for (const c of await fetchGithubOrgAddresses(domain, candidates)) {
      if (!seen.some((s) => s.address === c.address)) seen.push({ address: c.address, sourceUrl: c.sourceUrl });
      if (c.name) names.push(c.name); // commit authors teach the pattern; they are not stored as people
    }
  }
  return {
    mail: { acceptsMail: mx === null ? null : mx.length > 0, provider: mx ? mailProvider(mx) : null, pattern: learnPattern(seen, names, domain) },
    seen,
  };
}

/**
 * Attach an email to each contact (and "Also" person) going into the digest, plan 9b.
 * Domain evidence is cached in `domain_mail` for MAIL_REFRESH_DAYS; addresses are stored in `emails` with status + source.
 * Suppressed addresses are never shown.
 */
export async function attachEmails(
  contacts: Map<string, Contact | null>,
  opts: { write?: boolean; gather?: typeof gatherDomainEvidence; maxDomains?: number } = {},
): Promise<{ domains: number; byStatus: Record<string, number> }> {
  const write = opts.write !== false;
  const gather = opts.gather ?? gatherDomainEvidence;
  const ids = [...contacts.entries()].filter(([, c]) => c).map(([id]) => id);
  const byStatus: Record<string, number> = {};
  if (!ids.length) return { domains: 0, byStatus };
  const db = getDb();
  const accts = await db.select({ id: accounts.id, domain: accounts.domain, name: accounts.name, size: accounts.sizeBand }).from(accounts).where(inArray(accounts.id, ids));
  const cached = new Map((await db.select().from(domainMail).where(inArray(domainMail.domain, accts.map((a) => a.domain)))).map((r) => [r.domain, r]));
  const sup = await db.select().from(suppressionList);
  const hashes = new Set(sup.map((r) => r.hashedEmail).filter(Boolean));
  const supDomains = new Set(sup.map((r) => r.domain).filter(Boolean));
  const suppressed = { has: (addr: string) => hashes.has(createHash("sha256").update(addr.trim().toLowerCase()).digest("hex")) || supDomains.has(addr.split("@")[1] ?? "") };
  const personRows = await db.select({ id: people.id, a: people.accountId, n: people.fullName }).from(people).where(inArray(people.accountId, ids));
  const stored = personRows.length ? await db.select().from(emails).where(inArray(emails.personId, personRows.map((p) => p.id))) : [];
  let budget = opts.maxDomains ?? 40, domains = 0;

  for (const a of accts) {
    const c = contacts.get(a.id)!;
    const everyone = [c.person, ...(c.others ?? []).map((o) => o.person)];
    const rows = personRows.filter((p) => p.a === a.id);
    const pid = (name: string) => rows.find((r) => r.n === name)?.id;
    const c0 = cached.get(a.domain);
    let ev: DomainEvidence;
    if (c0?.checkedAt && Date.now() - c0.checkedAt.getTime() < MAIL_REFRESH_DAYS * DAY) {
      // fresh: rebuild from what we stored (observed addresses live in `emails`)
      const seen = stored.filter((e) => rows.some((r) => r.id === e.personId) && e.status === "observed").map((e) => ({ address: e.address, sourceUrl: e.source ?? "" }));
      const generic = c0.genericAddress;
      ev = {
        mail: {
          acceptsMail: c0.mxProvider === "none" ? false : c0.mxProvider ? true : null,
          provider: c0.mxProvider === "none" ? null : c0.mxProvider,
          pattern: c0.pattern ? { pattern: c0.pattern as Pattern, confidence: c0.patternConfidence ?? 0, support: c0.patternSupport ?? 1 } : null,
        },
        seen: generic ? [...seen, { address: generic, sourceUrl: `https://${a.domain}/` }] : seen,
      };
    } else {
      if (budget-- <= 0) continue;
      domains++;
      try { ev = await gather(a.domain, a.name, rows.map((r) => r.n)); } catch { continue; }
      if (write) {
        const set = {
          mxProvider: ev.mail.acceptsMail === false ? "none" : ev.mail.provider,
          pattern: ev.mail.pattern?.pattern ?? null, patternConfidence: ev.mail.pattern?.confidence ?? null,
          patternSupport: ev.mail.pattern?.support ?? null, genericAddress: genericAddress(ev.seen, a.domain)?.address ?? null,
          checkedAt: new Date(),
        };
        await db.insert(domainMail).values({ domain: a.domain, ...set }).onConflictDoUpdate({ target: domainMail.domain, set });
      }
    }

    for (const p of everyone) {
      // a bounce marked this person's address invalid: keep it that way, don't offer another guess silently
      const id = pid(p.name);
      const bounced = stored.find((e) => e.personId === id && e.status === "invalid" && e.source === "bounce");
      const g: EmailGuess | null = bounced
        ? { address: bounced.address, status: "invalid", source: "bounce", note: "bounced" }
        : emailFor(p.name, a.domain, ev.mail, ev.seen, a.size);
      if (!g || suppressed.has(g.address)) continue;
      p.email = { address: g.address, status: g.status, note: g.note };
      byStatus[g.status] = (byStatus[g.status] ?? 0) + 1;
      if (write && id && g.source !== "bounce") {
        await db.insert(emails).values({ personId: id, address: g.address, status: g.status, source: g.source, checkedAt: new Date() })
          .onConflictDoUpdate({ target: [emails.personId, emails.address], set: { status: sql`excluded.status`, source: sql`excluded.source`, checkedAt: sql`excluded.checked_at` } });
      }
    }
    const generic = genericAddress(ev.seen, a.domain);
    if (generic && !suppressed.has(generic.address) && !isRoleAddress(c.person.email?.address ?? "x")) c.generic = generic.address;
  }
  return { domains, byStatus };
}

/** Mark an address invalid after a bounce (called by whatever reads bounces; Gmail bounce reading needs gmail.readonly). */
export async function markBounced(address: string): Promise<number> {
  const db = getDb();
  return (await db.update(emails).set({ status: "invalid", source: "bounce", checkedAt: new Date() })
    .where(sql`lower(${emails.address}) = ${address.toLowerCase()}`).returning({ id: emails.id })).length;
}
