import { getDb, sql } from "@tell/db";

/**
 * Nightly janitor (plan section 12): raw data is temporary, evidence and learning data are permanent,
 * everything in between is compacted. `tight` (usage guard at 80% of a free-tier limit) halves the windows.
 */
export interface JanitorResult { deleted: Record<string, number>; compactedSignals: number; droppedPartitions: string[]; tight: boolean }

export async function runJanitor(opts: { tight?: boolean } = {}): Promise<JanitorResult> {
  const db = getDb();
  const tight = !!opts.tight;
  const d = (days: number) => `${tight ? Math.ceil(days / 2) : days} days`;
  const res: JanitorResult = { deleted: {}, compactedSignals: 0, droppedPartitions: [], tight };
  const count = async (name: string, q: ReturnType<typeof sql>) => {
    const r = await db.execute(q);
    res.deleted[name] = (res.deleted[name] ?? 0) + (r.rowCount ?? r.rows.length ?? 0);
  };

  // content hashes for dedupe: 90 days
  await count("seen_hashes", sql`delete from seen_hashes where first_seen < now() - ${d(90)}::interval`);
  // rejected at Gate 1: 14 days, no sample
  await count("candidates", sql`delete from candidates where gate_results->>'status' = 'rejected' and gate_results->>'gate' = '1' and created_at < now() - ${d(14)}::interval`);
  // other non-confirmed candidates: 30 days (false-negative audit window), keep a random 1% for evals
  await count("candidates", sql`delete from candidates where coalesce(gate_results->>'status', '') <> 'confirmed' and created_at < now() - ${d(30)}::interval and random() >= 0.01`);
  // raw items whose candidate is gone
  await count("raw_items", sql`delete from raw_items r where r.fetched_at < now() - ${d(14)}::interval and not exists (select 1 from candidates c where c.raw_item_id = r.id)`);
  // daily scores: 30 days, kept for accounts ever delivered (calibration)
  await count("scores", sql`delete from scores s where s.created_at < now() - ${d(30)}::interval and not exists (select 1 from deliveries dl where dl.account_id = s.account_id)`);

  // signals older than 180 days: compact into per-account counts, then delete (people leads / deliveries keep theirs)
  const old = sql`s.observed_at < now() - ${d(180)}::interval and s.account_id is not null
    and not exists (select 1 from person_leads p where p.signal_id = s.id)`;
  await db.execute(sql`
    insert into signal_summaries (account_id, type, count, first_at, last_at)
    select s.account_id, s.type, count(*), min(s.observed_at), max(s.observed_at) from signals s where ${old} group by 1, 2
    on conflict (account_id, type) do update set count = signal_summaries.count + excluded.count,
      first_at = least(signal_summaries.first_at, excluded.first_at), last_at = greatest(signal_summaries.last_at, excluded.last_at)`);
  const compacted = await db.execute(sql`delete from signals s where ${old}`);
  res.compactedSignals = compacted.rowCount ?? 0;

  // people at accounts never delivered: 90 days (privacy: don't keep names we never used)
  await count("people", sql`delete from people p where p.fetched_at < now() - ${d(90)}::interval
    and not exists (select 1 from deliveries dl where dl.account_id = p.account_id)
    and not exists (select 1 from emails e where e.person_id = p.id)`);
  await count("people_searches", sql`delete from people_searches where searched_at < now() - ${d(90)}::interval`);
  // run logs: 90 days
  await count("runs", sql`delete from runs where started_at < now() - ${d(90)}::interval and task not like 'digest%'`);
  // snapshots: keep the latest per account and kind; older changed snapshots after 180 days
  await count("snapshots", sql`delete from snapshots s where s.taken_at < now() - ${d(180)}::interval
    and s.taken_at < (select max(s2.taken_at) from snapshots s2 where s2.account_id = s.account_id and s2.kind = s.kind)`);

  // drop raw_items / candidates partitions older than 2 months once they're empty (frees space at once; deletes don't)
  const parts = (await db.execute(sql`
    select c.relname as name from pg_inherits i join pg_class c on c.oid = i.inhrelid join pg_class p on p.oid = i.inhparent
    where p.relname in ('raw_items', 'candidates') and c.relkind = 'r'`)).rows as { name: string }[];
  const cutoff = new Date();
  cutoff.setUTCMonth(cutoff.getUTCMonth() - (tight ? 1 : 2));
  const cutoffKey = `${cutoff.getUTCFullYear()}_${String(cutoff.getUTCMonth() + 1).padStart(2, "0")}`;
  for (const { name } of parts) {
    const m = name.match(/_(\d{4}_\d{2})$/);
    if (!m || m[1]! >= cutoffKey) continue;
    // only empty partitions: confirmed candidates and the 1% eval sample must survive
    const rows = (await db.execute(sql.raw(`select exists (select 1 from "${name}") as has`))).rows as { has: boolean }[];
    if (rows[0]?.has) continue;
    await db.execute(sql.raw(`drop table if exists "${name}"`));
    res.droppedPartitions.push(name);
  }
  return res;
}
