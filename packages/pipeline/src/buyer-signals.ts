import type { Pack } from "@tell/config";
import { buyerProfile, type BuyerProfile, type LlmClient } from "@tell/extract";
import { getDb, accounts, eq, sql } from "@tell/db";

/**
 * "Your customers are showing demand right now": for a lead, the companies in ITS market (the industries that buy from
 * it) with a fresh signal that means new demand for what it sells. The draft names two or three of them as proof of
 * what the operator finds every day. Profiles are worked out once per account (accounts.buyers) from its description.
 */
const DAY = 86_400_000;
/** a profile is re-worked after this long (the description or the pack's industries may have changed) */
const PROFILE_DAYS = 120;
export const SAMPLE_DAYS = 60;

export interface BuyerRow { accountId: string; company: string; region: string | null; type: string; quote: string; url: string; observedAt: Date; strength: number }
export interface BuyerSample { who: string; total: number; rows: BuyerRow[] }

/** The best few rows (pure; exported for tests): one per company, same region first, then strongest and newest. */
export function pickSample(rows: BuyerRow[], region: string | null, n = 3): BuyerRow[] {
  const best = new Map<string, BuyerRow>();
  const rank = (r: BuyerRow) => [r.region === region ? 1 : 0, r.strength, r.observedAt.getTime()];
  const better = (a: BuyerRow, b: BuyerRow) => { const x = rank(a), y = rank(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i]! > y[i]!; return false; };
  for (const r of rows) { const p = best.get(r.accountId); if (!p || better(r, p)) best.set(r.accountId, r); }
  return [...best.values()].sort((a, b) => (better(a, b) ? -1 : better(b, a) ? 1 : 0)).slice(0, n);
}

/** Evidence items for the draft: one per company ("Contoso Foods: ...") plus the count, every number from the rows. */
export function sampleEvidence(s: BuyerSample): { type: string; ageDays: number; current: boolean; quote: string; url: string }[] {
  const now = Date.now();
  return [
    ...s.rows.map((r) => ({ type: "buyer_signal", ageDays: Math.round((now - r.observedAt.getTime()) / DAY), current: false, quote: `${r.company}: ${r.quote}`, url: r.url })),
    { type: "buyer_signals_count", ageDays: 0, current: true, quote: `In the last ${SAMPLE_DAYS} days, ${s.total} ${s.who} showed signs of new demand in public records and news.`, url: s.rows[0]!.url },
  ];
}

/** The account's buyer profile: stored, else worked out now (Haiku) and stored. Null without a description. */
export async function profileFor(account: { id: string; name: string | null; domain: string; description?: string | null }, pack: Pack, llm: LlmClient | null, write = true): Promise<BuyerProfile | null> {
  const db = getDb();
  const [row] = await db.select({ buyers: accounts.buyers, description: accounts.description }).from(accounts).where(eq(accounts.id, account.id)).limit(1);
  const stored = row?.buyers as (BuyerProfile & { at?: string }) | null | undefined;
  if (stored?.industries?.length && stored.at && Date.now() - new Date(stored.at).getTime() < PROFILE_DAYS * DAY) return stored;
  const description = account.description ?? row?.description;
  if (!description || !llm) return stored?.industries?.length ? stored : null;
  const p = await buyerProfile(llm, pack, { name: account.name ?? account.domain, domain: account.domain, description }).catch(() => null);
  if (p && write) await db.update(accounts).set({ buyers: { ...p, at: new Date().toISOString() } }).where(eq(accounts.id, account.id));
  return p;
}

/** Companies in the lead's market with a fresh demand signal (the lead itself and its own industry's peers excluded). */
export async function buyerSample(p: BuyerProfile, lead: { id: string; region: string | null }, n = 3): Promise<BuyerSample | null> {
  const db = getDb();
  const since = new Date(Date.now() - SAMPLE_DAYS * DAY);
  const rows = (await db.execute(sql`
    select s.account_id, a.name, a.domain, a.region, s.type, s.evidence_quote, s.evidence_url, s.observed_at, s.strength
    from signals s join accounts a on a.id = s.account_id
    where a.status = 'active' and a.id <> ${lead.id} and a.segment in (${sql.join(p.industries.map((x) => sql`${x}`), sql`, `)})
      and s.type in (${sql.join(p.signals.map((x) => sql`${x}`), sql`, `)}) and s.observed_at > ${since}
    order by s.strength desc, s.observed_at desc limit 300`)).rows as { account_id: string; name: string | null; domain: string; region: string | null; type: string; evidence_quote: string; evidence_url: string; observed_at: string; strength: number }[];
  if (rows.length < 2) return null;
  const all: BuyerRow[] = rows.map((r) => ({ accountId: r.account_id, company: r.name ?? r.domain, region: r.region, type: r.type, quote: r.evidence_quote, url: r.evidence_url, observedAt: new Date(r.observed_at), strength: r.strength }));
  const picked = pickSample(all, lead.region, n);
  return picked.length >= 2 ? { who: p.who, total: new Set(all.map((r) => r.accountId)).size, rows: picked } : null;
}
