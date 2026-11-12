import type { Pack } from "@tell/config";
import { runScoring, istDay, contactsFor, gigsForDigest, markGigsDelivered, type ScoreRunResult } from "@tell/pipeline";
import { getDb, runs, deliveries, jobBoards, usageDaily, accounts, eq, and, sql } from "@tell/db";
import { renderDigest, leadSheetRow, gigSheetRow, type DigestHealth, type DigestEmail } from "./render.js";
import { appendPendingLeads } from "./sheet-sync.js";
import { appendRows } from "./sheets.js";
import type { Sender } from "./gmail.js";

export interface DigestResult {
  status: "sent" | "skipped" | "dry-run";
  reason?: string;
  /** Sheet outcome after a real send: rows appended, or why not (never fails the digest) */
  sheet?: string;
  leads: number;
  watchlist: number;
  personLeads: number;
  email?: DigestEmail;
  score?: ScoreRunResult;
}

async function health(pack: Pack, capUsd: number): Promise<DigestHealth> {
  const db = getDb();
  const since = new Date(Date.now() - 24 * 3_600_000);
  const [b] = (await db.execute(sql`
    select count(*)::int as total,
           count(*) filter (where ${jobBoards.lastCheckedAt} > ${since})::int as checked,
           count(*) filter (where ${jobBoards.failCount} > 0)::int as failing
    from ${jobBoards} where ${jobBoards.status} = 'active'`)).rows as { total: number; checked: number; failing: number }[];
  const [t] = (await db.execute(sql`
    select count(*)::int as n, count(*) filter (where ${runs.status} <> 'ok')::int as errors
    from ${runs} where ${runs.task} like 'tick:%' and ${runs.startedAt} > ${since}`)).rows as { n: number; errors: number }[];
  const spend = await db.select({ used: usageDaily.used }).from(usageDaily).where(and(eq(usageDaily.day, istDay()), eq(usageDaily.service, "haiku")));
  const [india] = (await db.execute(sql`select count(*)::int as n from ${accounts} where ${accounts.region} = 'India' and ${accounts.status} = 'active'`)).rows as { n: number }[];
  void pack;
  return {
    boardsTotal: b?.total ?? 0, boardsChecked24h: b?.checked ?? 0, boardsFailing: b?.failing ?? 0,
    ticks24h: t?.n ?? 0, tickErrors24h: t?.errors ?? 0, haikuTodayUsd: spend[0]?.used ?? 0, haikuCapUsd: capUsd, indiaTracked: india?.n ?? 0,
  };
}

/**
 * Score, render and send the daily digest. Sends at most once per IST day (runs.idempotency_key = digest:<day>);
 * a failed send leaves the day open for a retry.
 */
/** `test`: send now with a [TEST] subject but record nothing (no scores, no deliveries, the day stays open). */
export async function runDigest(opts: { pack: Pack; sender: Sender | null; dryRun?: boolean; test?: boolean; haikuCapUsd?: number }): Promise<DigestResult> {
  const { pack } = opts;
  const db = getDb();
  const day = istDay();
  const key = `digest:${day}`;
  const to = pack.delivery.digest.to, from = pack.delivery.digest.from;

  if (!opts.dryRun && !opts.test) {
    if (!to || !from) return { status: "skipped", reason: "delivery.digest.to / from not set in the pack", leads: 0, watchlist: 0, personLeads: 0 };
    const prior = await db.select({ status: runs.status }).from(runs).where(eq(runs.idempotencyKey, key)).limit(1);
    if (prior[0]?.status === "ok") return { status: "skipped", reason: `already sent for ${day}`, leads: 0, watchlist: 0, personLeads: 0 };
  }

  if (opts.test && (!to || !from)) return { status: "skipped", reason: "delivery.digest.to / from not set in the pack", leads: 0, watchlist: 0, personLeads: 0 };
  const score = await runScoring({ pack, write: !opts.dryRun && !opts.test });
  const contacts = await contactsFor([...score.ranking.leads, ...score.ranking.watchlist].map((l) => l.account.id), pack, { write: !opts.dryRun });
  const gigList = await gigsForDigest(pack);
  const h = await health(pack, opts.haikuCapUsd ?? Number(process.env.HAIKU_DAILY_CAP_USD ?? 1));
  h.indiaInLeads = score.ranking.leads.filter((l) => l.account.region === "India").length;
  const email = renderDigest(score, pack, h, day, contacts, gigList);
  const counts = { leads: score.ranking.leads.length, watchlist: score.ranking.watchlist.length, personLeads: score.personLeads.length };
  if (opts.dryRun) return { status: "dry-run", email, score, ...counts };
  // no sender configured yet: scores are written, nothing is sent, the day stays open
  if (!opts.sender) return { status: "skipped", reason: "Gmail not configured (run pnpm gmail:auth, then add the GitHub secrets)", email, score, ...counts };

  if (opts.test) {
    await opts.sender.send({ from: from!, fromName: pack.delivery.digest.from_name, to: to!, subject: `[TEST] ${email.subject}`, html: email.html, text: email.text });
    return { status: "sent", reason: "test: nothing recorded", email, score, ...counts };
  }

  const started = new Date();
  try {
    await opts.sender.send({ from: from!, fromName: pack.delivery.digest.from_name, to: to!, subject: email.subject, html: email.html, text: email.text });
  } catch (e) {
    await db.insert(runs).values({ task: "digest", idempotencyKey: key, status: "error", error: String(e).slice(0, 500), startedAt: started, finishedAt: new Date() })
      .onConflictDoUpdate({ target: runs.idempotencyKey, set: { status: "error", error: String(e).slice(0, 500), finishedAt: new Date() } });
    throw e;
  }

  const now = new Date();
  const batch: unknown[] = [
    db.insert(runs).values({ task: "digest", idempotencyKey: key, status: "ok", yieldCount: counts.leads, startedAt: started, finishedAt: now })
      .onConflictDoUpdate({ target: runs.idempotencyKey, set: { status: "ok", error: null, yieldCount: counts.leads, finishedAt: now } }),
  ];
  if (score.ranking.leads.length) {
    batch.push(db.insert(deliveries).values(score.ranking.leads.map((l) => ({
      accountId: l.account.id, deliveredAt: now, kind: l.score.lane === "fast" ? "fast" : "normal", configVersion: score.configVersion,
      sheetRow: leadSheetRow(l, contacts.get(l.account.id), day),
    }))));
  }
  await db.batch(batch as unknown as Parameters<typeof db.batch>[0]);
  await markGigsDelivered(gigList.map((g) => g.id), now);

  // Sheet: append after the email is out; a Sheet problem never fails the digest (rows are retried next run)
  let sheet = "no sheet configured";
  if (pack.delivery.sheet.spreadsheet_id) {
    try {
      const n = await appendPendingLeads(pack);
      if (gigList.length) await appendRows(pack.delivery.sheet.spreadsheet_id, "Gigs", gigList.map((g) => gigSheetRow(g, day)));
      sheet = `appended ${n} lead${n === 1 ? "" : "s"}${gigList.length ? ` + ${gigList.length} gig${gigList.length === 1 ? "" : "s"}` : ""}`;
    } catch (e) {
      sheet = `append failed (retried next run): ${String(e).slice(0, 160)}`;
    }
  }
  return { status: "sent", email, score, sheet, ...counts };
}
