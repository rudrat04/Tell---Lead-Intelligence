import { getDb, companySeeds, nicheQueue, usageDaily, deliveries, labels, playsMatched, accounts, sql, and, eq } from "@tell/db";

const DAY = 86_400_000;

/**
 * `pnpm niche stats`: how the niche sources are doing, counts only (safe for public logs). Per source: names looked
 * up and the share proven; queue size; Exa / Maps spend; named-contact coverage of delivered leads by digest list
 * and industry; days since your last import.
 */
export async function nicheStats(now = new Date()) {
  const db = getDb();
  const seeds = (await db.execute(sql`select source, count(*)::int as n, sum(case when fit_pass then 1 else 0 end)::int as ok from ${companySeeds} where source like 'niche:%' group by source order by n desc`)).rows as { source: string; n: number; ok: number }[];
  const queue = (await db.execute(sql`select source, count(*)::int as n from ${nicheQueue} group by source order by n desc`)).rows as { source: string; n: number }[];
  const since = new Date(now.getTime() - 7 * DAY).toISOString().slice(0, 10);
  const spend = (await db.execute(sql`select service, sum(used)::float as used from ${usageDaily} where day >= ${since} and service in ('exa_niche','google_places','serper_places','serper_news_events') group by service`)).rows as { service: string; used: number }[];
  // delivered in the last 30 days: did the row name a person? (sheet_row is by column name)
  const delivered = (await db.execute(sql`select coalesce(d.sheet_row->>'Segment', a.segment, '?') as segment, (coalesce(d.sheet_row->>'Person', '') <> '') as has_person, count(*)::int as n
    from ${deliveries} d left join ${accounts} a on a.id = d.account_id where d.delivered_at > ${new Date(now.getTime() - 30 * DAY)} and d.kind <> 'alert' group by 1, 2`)).rows as { segment: string; has_person: boolean; n: number }[];
  const coverage = new Map<string, { n: number; named: number }>();
  for (const r of delivered) { const c = coverage.get(r.segment) ?? { n: 0, named: 0 }; c.n += r.n; if (r.has_person) c.named += r.n; coverage.set(r.segment, c); }
  const lastImport = (await db.select({ at: sql<Date | null>`max(${companySeeds.updatedAt})` }).from(companySeeds).where(eq(companySeeds.source, "niche:niche_import")))[0]?.at ?? null;
  return {
    sources: seeds.map((s) => ({ source: s.source.replace(/^niche:/, ""), lookedUp: s.n, proven: s.ok, rate: s.n ? s.ok / s.n : 0 })),
    queue, queued: queue.reduce((n, q) => n + q.n, 0),
    spend7d: Object.fromEntries(spend.map((s) => [s.service, Math.round(s.used)])),
    contacts: [...coverage].map(([segment, c]) => ({ segment, delivered: c.n, named: c.named })),
    daysSinceImport: lastImport ? Math.floor((now.getTime() - new Date(lastImport).getTime()) / DAY) : null,
  };
}

/**
 * `pnpm plays:report`: what each play (and industry) delivered and how you labelled it, from the Sheet's Label and
 * Outcome columns (synced by sheet:sync). Built plays are grouped as "built" per industry. Counts only.
 */
export async function playReport(days = 90, now = new Date()) {
  const db = getDb();
  const rows = (await db.execute(sql`
    select coalesce(case when pm.play_id like 'built:%' then 'built' else pm.play_id end, 'none') as play, coalesce(a.segment, '?') as segment,
      count(distinct d.id)::int as delivered,
      count(distinct d.id) filter (where l.label = 'good')::int as good, count(distinct d.id) filter (where l.label = 'bad')::int as bad,
      count(distinct d.id) filter (where l.outcome in ('replied','meeting','won'))::int as replied,
      count(distinct d.id) filter (where l.outcome in ('meeting','won'))::int as meetings, count(distinct d.id) filter (where l.outcome = 'won')::int as won
    from ${deliveries} d join ${accounts} a on a.id = d.account_id
    left join ${playsMatched} pm on pm.account_id = d.account_id and pm.matched_at <= d.delivered_at + interval '1 day'
    left join ${labels} l on l.delivery_id = d.id
    where d.delivered_at > ${new Date(now.getTime() - days * DAY)}
    group by 1, 2 order by delivered desc`)).rows as { play: string; segment: string; delivered: number; good: number; bad: number; replied: number; meetings: number; won: number }[];
  return rows.map((r) => ({ ...r, verdict: verdict(r) }));
}

/** Cut, keep or double down: only with enough deliveries to say (pure; exported for tests). */
export function verdict(r: { delivered: number; good: number; bad: number; replied: number; meetings: number }): string {
  if (r.delivered < 8) return "too early";
  const replyRate = r.replied / r.delivered, badRate = r.bad / r.delivered;
  if (r.meetings >= 2 || replyRate >= 0.15) return "double down";
  if (r.replied === 0 && (r.delivered >= 15 || badRate >= 0.5)) return "cut?";
  return "keep";
}
