import type { Pack } from "@tell/config";
import { WriterClient, writerEffort, analyzeLead, type AnalystInput } from "@tell/extract";
import { getDb, deliveries, labels, accounts, signals, jobs, jobBoards, eq, and, sql } from "@tell/db";
import { neonUsage } from "@tell/pipeline";
import { ensureLeadHeaders, fillColumnById, storedRow, sheetsCall } from "./sheets.js";

const DAY = 86_400_000;
/** a follow-up goes 5 to 10 days after the first email */
export const FOLLOWUP_MIN_DAYS = 5, FOLLOWUP_MAX_DAYS = 10;
/** drafts per run: they share the writer's daily cap with today's leads */
export const FOLLOWUPS_PER_RUN = 8;

export interface FollowupResult { due: number; noNewFact: number; written: number; failed: number; sheet: number; skipped?: string; samples?: { company: string; fact: string; body: string }[] }

/**
 * Second touch from a NEW fact (Sheet "Follow-up" column): leads delivered 5-10 days ago, not 👎, not replied / in a
 * meeting / won, with evidence first seen after the delivery (a new signal or a newly posted role). No new fact = no
 * follow-up: never a "just bumping this". The draft is checked like every email (facts only, ends on a question).
 */
export async function runFollowups(opts: { pack: Pack; dryRun?: boolean; now?: Date }): Promise<FollowupResult> {
  const { pack } = opts;
  const now = opts.now ?? new Date();
  const db = getDb();
  const res: FollowupResult = { due: 0, noNewFact: 0, written: 0, failed: 0, sheet: 0 };
  const due = (await db.execute(sql`
    select d.id, d.account_id, d.delivered_at, d.sheet_row, a.name, a.domain, a.segment, a.size_band, a.region
    from ${deliveries} d join ${accounts} a on a.id = d.account_id left join ${labels} l on l.delivery_id = d.id
    where d.kind <> 'alert' and d.sheet_row is not null
      and d.delivered_at between ${new Date(now.getTime() - FOLLOWUP_MAX_DAYS * DAY)} and ${new Date(now.getTime() - FOLLOWUP_MIN_DAYS * DAY)}
      and coalesce(d.sheet_row->>'Follow-up', '') = ''
      and coalesce(l.label, '') <> 'bad' and coalesce(l.outcome, '') not in ('replied', 'meeting', 'won')`)).rows as
    { id: string; account_id: string; delivered_at: string; sheet_row: unknown; name: string | null; domain: string; segment: string | null; size_band: string | null; region: string | null }[];
  // only leads still in your Sheet (a rebuild removes rows off the ICP): a follow-up for a row you can't see is wasted
  const sheetId = pack.delivery.sheet.spreadsheet_id;
  if (sheetId) {
    const j = await sheetsCall<{ values?: string[][] }>(`/${sheetId}/values/${encodeURIComponent("Leads!A:AZ")}`);
    const [header, ...rows] = j.values ?? [];
    const idCol = header?.findIndex((h) => h.trim() === "ID") ?? -1;
    if (idCol >= 0) { const inSheet = new Set(rows.map((r) => (r[idCol] ?? "").trim())); due.splice(0, due.length, ...due.filter((d) => inSheet.has(d.id))); }
  }
  res.due = due.length;
  if (!due.length) return res;
  if (!process.env.ANTHROPIC_API_KEY) return { ...res, skipped: "no ANTHROPIC_API_KEY" };
  const usage = neonUsage();
  const cap = Number(process.env.WRITER_DAILY_CAP_USD ?? 1);
  const left = cap - (await usage.spentToday("sonnet"));
  if (left <= 0) return { ...res, skipped: "daily writer cap reached" };
  const writer = new WriterClient({ capUsd: Math.min(left, 0.4), effort: writerEffort() });
  const written = new Map<string, string>();
  try {
    for (const d of due) {
      if (written.size >= FOLLOWUPS_PER_RUN) break;
      const at = new Date(d.delivered_at);
      // new facts: signals first seen after the delivery, roles first seen after it
      const sig = await db.select({ type: signals.type, quote: signals.evidenceQuote, url: signals.evidenceUrl, observedAt: signals.observedAt }).from(signals)
        .where(and(eq(signals.accountId, d.account_id), sql`${signals.observedAt} > ${at}`)).limit(6);
      const roles = await db.select({ title: jobs.title, url: jobs.url, firstSeenAt: jobs.firstSeenAt }).from(jobs).innerJoin(jobBoards, eq(jobs.boardId, jobBoards.id))
        .where(and(eq(jobBoards.accountId, d.account_id), sql`${jobs.firstSeenAt} > ${at}`, sql`${jobs.closedAt} is null`, sql`${jobs.family} in ('core', 'adjacent')`)).limit(4);
      const evidence: AnalystInput["evidence"] = [
        ...sig.filter((x) => pack.signals.signals[x.type]).map((x) => ({ type: x.type, ageDays: (now.getTime() - x.observedAt.getTime()) / DAY, current: false, quote: x.quote, url: x.url })),
        ...roles.map((r) => ({ type: "new_role_posted", ageDays: (now.getTime() - r.firstSeenAt.getTime()) / DAY, current: true, quote: `Now hiring: ${r.title}`, url: r.url })),
      ];
      if (!evidence.length) { res.noNewFact++; continue; }
      const row = storedRow(d.sheet_row);
      const playTitle = (row.Plays ?? "").split(/[,;\n]/)[0]?.trim();
      const play = Object.values(pack.plays.plays).find((p) => p.title === playTitle);
      const ind = d.segment ? pack.icp.industries[d.segment] : undefined;
      const offer = play?.offer ?? (ind && ind.list !== "gtm" ? ind.offer : undefined);
      const days = Math.round((now.getTime() - at.getTime()) / DAY);
      const input: AnalystInput = {
        company: d.name ?? d.domain, domain: d.domain, facts: [d.size_band && `${d.size_band} people`, d.segment, d.region].filter(Boolean).join(", "),
        contactRole: row.Role || null,
        plays: [{ id: "follow_up", title: "Follow-up with a new fact", angle: `This is a SECOND, shorter message, ${days} days after the first email${row["Email draft"] ? ` (it said, in short: "${row["Email draft"]!.split("\n")[0]!.slice(0, 120)}")` : ""}. Open with the new fact in the evidence, say plainly why it matters to the first point, and end with one easy question. Don't repeat the first email; never "just following up", "bumping this" or "circling back".`, ...(offer ? { offer } : {}) }],
        evidence,
      };
      let a = null;
      try { a = await analyzeLead(writer, pack, input); } catch { /* cap or API: try tomorrow */ }
      if (!a?.email) { res.failed++; continue; }
      written.set(d.id, a.email.body);
      if ((res.samples ??= []).length < 3) res.samples.push({ company: d.name ?? d.domain, fact: evidence[0]!.quote.slice(0, 160), body: a.email.body });
      if (!opts.dryRun) await db.update(deliveries).set({ sheetRow: { ...row, "Follow-up": a.email.body } }).where(eq(deliveries.id, d.id));
    }
  } finally {
    if (writer.spent > 0 && !opts.dryRun) await usage.addSpend("sonnet", writer.spent, cap);
  }
  res.written = written.size;
  if (sheetId && written.size && !opts.dryRun) { await ensureLeadHeaders(sheetId); res.sheet = await fillColumnById(sheetId, "Follow-up", written); }
  return res;
}
