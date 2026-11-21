import { industryCounts, type Pack } from "@tell/config";
import { WriterClient, writerEffort, analyzeLead, type AnalystInput } from "@tell/extract";
import { getDb, deliveries, labels, accounts, signals, jobs, jobBoards, eq, and, sql } from "@tell/db";
import { neonUsage } from "@tell/pipeline";
import { ensureLeadHeaders, fillColumnById, storedRow, sheetsCall } from "./sheets.js";

const DAY = 86_400_000;
/** a touch-back goes at least 5 days after the first email, and up to the re-delivery window (delivery.redeliver_after_days):
 *  after that the lead is simply eligible again */
export const FOLLOWUP_MIN_DAYS = 5;
/** drafts per run: they share the writer's daily cap with today's leads */
export const FOLLOWUPS_PER_RUN = 8;

/** A past lead with a new fact: listed in the digest's "Touch back" section, with a follow-up draft in the Sheet when written. */
export interface TouchBack { deliveryId: string; company: string; domain: string; person: string; daysSince: number; fact: string; url: string; drafted: boolean }
export interface FollowupResult { due: number; noNewFact: number; written: number; failed: number; sheet: number; skipped?: string; touched: TouchBack[]; samples?: { company: string; fact: string; body: string }[] }

/**
 * Touch back from a NEW fact (digest "Touch back" section + Sheet "Follow-up" column): every lead delivered 5 days to
 * the re-delivery window ago (its latest delivery only), not 👎, not replied / in a meeting / won, with evidence first
 * seen after the delivery that its industry counts (a new signal or a newly posted role). No new fact = no touch-back:
 * never a "just bumping this". The draft is checked like every email (facts only, ends on a question). Runs inside the
 * digest, after today's drafts (they get the writer budget first); `draft: false` lists the facts without writing.
 */
export async function runFollowups(opts: { pack: Pack; dryRun?: boolean; now?: Date; draft?: boolean; exclude?: Set<string> }): Promise<FollowupResult> {
  const { pack } = opts;
  const now = opts.now ?? new Date();
  const db = getDb();
  const res: FollowupResult = { due: 0, noNewFact: 0, written: 0, failed: 0, sheet: 0, touched: [] };
  const windowDays = pack.delivery.redeliver_after_days;
  const due = (await db.execute(sql`
    select d.id, d.account_id, d.delivered_at, d.sheet_row, a.name, a.domain, a.segment, a.size_band, a.region, a.description
    from ${deliveries} d join ${accounts} a on a.id = d.account_id left join ${labels} l on l.delivery_id = d.id
    where d.kind <> 'alert' and d.sheet_row is not null
      and d.delivered_at between ${new Date(now.getTime() - windowDays * DAY)} and ${new Date(now.getTime() - FOLLOWUP_MIN_DAYS * DAY)}
      and coalesce(d.sheet_row->>'Follow-up', '') = ''
      and not exists (select 1 from ${deliveries} d2 where d2.account_id = d.account_id and d2.delivered_at > d.delivered_at)
      and coalesce(l.label, '') <> 'bad' and coalesce(l.outcome, '') not in ('replied', 'meeting', 'won')
    order by d.delivered_at desc`)).rows as
    { id: string; account_id: string; delivered_at: string; sheet_row: unknown; name: string | null; domain: string; segment: string | null; size_band: string | null; region: string | null; description: string | null }[];
  // only leads still in your Sheet (a rebuild removes rows off the ICP): a follow-up for a row you can't see is wasted
  const sheetId = pack.delivery.sheet.spreadsheet_id;
  if (sheetId) {
    const j = await sheetsCall<{ values?: string[][] }>(`/${sheetId}/values/${encodeURIComponent("Leads!A:AZ")}`);
    const [header, ...rows] = j.values ?? [];
    const idCol = header?.findIndex((h) => h.trim() === "ID") ?? -1;
    if (idCol >= 0) { const inSheet = new Set(rows.map((r) => (r[idCol] ?? "").trim())); due.splice(0, due.length, ...due.filter((d) => inSheet.has(d.id))); }
  }
  // an account on today's list is back already (its new delivery carries the new fact)
  if (opts.exclude?.size) due.splice(0, due.length, ...due.filter((d) => !opts.exclude!.has(d.account_id)));
  res.due = due.length;
  if (!due.length) return res;
  const usage = neonUsage();
  const cap = Number(process.env.WRITER_DAILY_CAP_USD ?? 1);
  let writer: WriterClient | null = null;
  if (opts.draft === false) res.skipped = "facts only";
  else if (!process.env.ANTHROPIC_API_KEY) res.skipped = "no ANTHROPIC_API_KEY";
  else {
    const left = cap - (await usage.spentToday("sonnet"));
    if (left <= 0) res.skipped = "daily writer cap reached";
    else writer = new WriterClient({ capUsd: Math.min(left, 0.4), effort: writerEffort() });
  }
  const written = new Map<string, string>();
  try {
    for (const d of due) {
      const at = new Date(d.delivered_at);
      // new facts: signals first seen after the delivery, roles first seen after it
      const sig = await db.select({ type: signals.type, quote: signals.evidenceQuote, url: signals.evidenceUrl, observedAt: signals.observedAt }).from(signals)
        .where(and(eq(signals.accountId, d.account_id), sql`${signals.observedAt} > ${at}`)).limit(6);
      const roles = await db.select({ title: jobs.title, url: jobs.url, firstSeenAt: jobs.firstSeenAt }).from(jobs).innerJoin(jobBoards, eq(jobs.boardId, jobBoards.id))
        .where(and(eq(jobBoards.accountId, d.account_id), sql`${jobs.firstSeenAt} > ${at}`, sql`${jobs.closedAt} is null`, sql`${jobs.family} in ('core', 'adjacent')`)).limit(4);
      const evidence: AnalystInput["evidence"] = [
        ...sig.filter((x) => pack.signals.signals[x.type] && industryCounts(pack, d.segment, x.type)).map((x) => ({ type: x.type, ageDays: (now.getTime() - x.observedAt.getTime()) / DAY, current: false, quote: x.quote, url: x.url })),
        ...roles.map((r) => ({ type: "new_role_posted", ageDays: (now.getTime() - r.firstSeenAt.getTime()) / DAY, current: true, quote: `Now hiring: ${r.title}`, url: r.url })),
      ];
      if (!evidence.length) { res.noNewFact++; continue; }
      const row = storedRow(d.sheet_row);
      const days = Math.round((now.getTime() - at.getTime()) / DAY);
      const touch: TouchBack = { deliveryId: d.id, company: d.name ?? d.domain, domain: d.domain, person: row.Person ?? "", daysSince: days, fact: evidence[0]!.quote, url: evidence[0]!.url, drafted: false };
      res.touched.push(touch);
      if (!writer || written.size >= FOLLOWUPS_PER_RUN) continue;
      const playTitle = (row.Plays ?? "").split(/[,;\n]/)[0]?.trim();
      const play = Object.values(pack.plays.plays).find((p) => p.title === playTitle);
      const ind = d.segment ? pack.icp.industries[d.segment] : undefined;
      const offer = play?.offer ?? (ind && ind.list !== "gtm" ? ind.offer : undefined);
      const input: AnalystInput = {
        company: d.name ?? d.domain, domain: d.domain, facts: [d.size_band && `${d.size_band} people`, d.segment, d.region].filter(Boolean).join(", ") + (d.description ? `. What they do: ${d.description}` : ""),
        contactRole: row.Role || null,
        plays: [{ id: "follow_up", title: "Follow-up with a new fact", angle: `This is a SECOND, shorter message, ${days} days after the first email${row["Email draft"] ? ` (it said, in short: "${row["Email draft"]!.split("\n")[0]!.slice(0, 120)}")` : ""}. Open with the new fact in the evidence, say plainly why it matters to the first point, and end with one easy question. Don't repeat the first email; never "just following up", "bumping this" or "circling back".`, ...(offer ? { offer } : {}) }],
        evidence,
      };
      let a = null;
      try { a = await analyzeLead(writer, pack, input); } catch { /* cap or API: try tomorrow */ }
      if (!a?.email) { res.failed++; continue; }
      written.set(d.id, a.email.body);
      touch.drafted = true;
      if ((res.samples ??= []).length < 3) res.samples.push({ company: d.name ?? d.domain, fact: evidence[0]!.quote.slice(0, 160), body: a.email.body });
      if (!opts.dryRun) await db.update(deliveries).set({ sheetRow: { ...row, "Follow-up": a.email.body } }).where(eq(deliveries.id, d.id));
    }
  } finally {
    if (writer && writer.spent > 0 && !opts.dryRun) await usage.addSpend("sonnet", writer.spent, cap);
  }
  res.written = written.size;
  if (sheetId && written.size && !opts.dryRun) { await ensureLeadHeaders(sheetId); res.sheet = await fillColumnById(sheetId, "Follow-up", written); }
  return res;
}
