import type { Pack } from "@tell/config";
import { fetchCtSubdomains, newGtmSubdomains, provenLookalikes, fetchFormDFilings, normCompany } from "@tell/watchers";
import { getDb, accounts, jobBoards, snapshots, signals, and, eq, sql } from "@tell/db";
import { applyPackIdentity } from "./scheduled.js";

export interface InfraWatchResult {
  ct: { checked: number; baselines: number; failed: number };
  lookalike: { checked: number; baselines: number };
  formD: { filings: number; matched: number; skipped?: string };
  signals: Record<string, number>;
}

/**
 * Weekly infrastructure and filings watch (tracked accounts only):
 *   #8  new GTM subdomains in certificates (go., lp., demo., partners. ...), via Cert Spotter, rotating under its limit
 *   #9  proven lookalike sending domains (redirect to the account's own site), rotating
 *   #10 SEC Form D filings matched to accounts by exact unique name -> funding_raise (skipped if one in the last 14 days)
 * The first check of an account is a baseline (no signals). Only types the pack defines are emitted.
 */
export async function runInfraWatch(opts: { pack: Pack; now?: Date; ctPerRun?: number; lookalikePerRun?: number }): Promise<InfraWatchResult> {
  const { pack } = opts;
  applyPackIdentity(pack);
  const now = opts.now ?? new Date();
  const db = getDb();
  const specs = pack.signals.signals;
  const res: InfraWatchResult = { ct: { checked: 0, baselines: 0, failed: 0 }, lookalike: { checked: 0, baselines: 0 }, formD: { filings: 0, matched: 0 }, signals: {} };

  const emit = async (accountId: string, type: string, quote: string, url: string) => {
    if (!specs[type]) return;
    const ins = await db.insert(signals).values({ accountId, class: specs[type]!.class, type, strength: specs[type]!.strength, evidenceQuote: quote.slice(0, 500), evidenceUrl: url, observedAt: now, halfLifeDays: specs[type]!.half_life_days })
      .onConflictDoNothing({ target: [signals.evidenceUrl, signals.type] }).returning({ id: signals.id });
    if (ins.length) res.signals[type] = (res.signals[type] ?? 0) + 1;
  };

  // tracked accounts, least recently checked for this kind first
  const due = async (kind: string, limit: number) => (await db.execute(sql`
    select a.id, a.domain, s.extracted from ${accounts} a
    join (select distinct account_id from ${jobBoards} where status = 'active') b on b.account_id = a.id
    left join lateral (select extracted, taken_at from ${snapshots} where account_id = a.id and kind = ${kind} order by taken_at desc limit 1) s on true
    where a.status = 'active'
    order by s.taken_at asc nulls first, a.id limit ${limit}`)).rows as { id: string; domain: string; extracted: { items?: string[] } | null }[];

  if (specs.marketing_subdomain) {
    // Cert Spotter reports a limit of 10 lookups with or without a free key: 9 per run unless CERTSPOTTER_PER_RUN says more
    const cap = opts.ctPerRun ?? Number(process.env.CERTSPOTTER_PER_RUN ?? 9);
    let refusedInRow = 0;
    for (const a of await due("ct", cap)) {
      const subs = await fetchCtSubdomains(a.domain);
      if (!subs) {
        res.ct.failed++;
        if (++refusedInRow >= 2) break; // rate limit reached: the rest wait for next week (they stay first in line)
        continue;
      }
      refusedInRow = 0;
      res.ct.checked++;
      if (!a.extracted) res.ct.baselines++;
      else for (const s of newGtmSubdomains(a.extracted.items ?? [], subs)) await emit(a.id, "marketing_subdomain", `New subdomain ${s}.${a.domain}`, `https://${s}.${a.domain}/`);
      await db.insert(snapshots).values({ accountId: a.id, kind: "ct", extracted: { items: subs }, takenAt: now });
    }
  }

  if (specs.outbound_domain) {
    for (const a of await due("lookalike", opts.lookalikePerRun ?? 80)) {
      const found = await provenLookalikes(a.domain);
      res.lookalike.checked++;
      if (!a.extracted) res.lookalike.baselines++;
      else for (const d of found.filter((x) => !(a.extracted!.items ?? []).includes(x))) await emit(a.id, "outbound_domain", `Sending domain ${d} redirects to ${a.domain}`, `https://${d}/`);
      await db.insert(snapshots).values({ accountId: a.id, kind: "lookalike", extracted: { items: found }, takenAt: now });
    }
  }

  if (specs.funding_raise) {
    if (!process.env.SEC_USER_AGENT) res.formD.skipped = "SEC_USER_AGENT not set";
    else {
      const filings = await fetchFormDFilings(7, now);
      res.formD.filings = filings.length;
      const names = new Map<string, string[]>();
      for (const r of await db.select({ id: accounts.id, name: accounts.name }).from(accounts).where(eq(accounts.status, "active"))) {
        if (!r.name) continue;
        const k = normCompany(r.name);
        if (k.length >= 4) names.set(k, [...(names.get(k) ?? []), r.id]);
      }
      for (const f of filings) {
        const ids = names.get(normCompany(f.company));
        if (ids?.length !== 1) continue; // no match, or ambiguous: never guess
        const recent = await db.select({ id: signals.id }).from(signals)
          .where(and(eq(signals.accountId, ids[0]!), eq(signals.type, "funding_raise"), sql`${signals.observedAt} > ${new Date(now.getTime() - 14 * 86_400_000)}`)).limit(1);
        if (recent.length) continue; // the same raise already seen elsewhere
        res.formD.matched++;
        await emit(ids[0]!, "funding_raise", `SEC Form D filed ${f.filedAt.toISOString().slice(0, 10)}: new private securities offering`, f.url);
      }
    }
  }
  return res;
}
