import type { Pack } from "@tell/config";
import { runScoring, istDay, contactsFor, attachEmails, analyzeLeads, rerankByReach, preferredPersonas, gigsForDigest, markGigsDelivered, type ScoreRunResult } from "@tell/pipeline";
import { getDb, runs, deliveries, jobBoards, usageDaily, accounts, eq, and, sql } from "@tell/db";
import { renderDigest, leadSheetRow, gigSheetRow, type DigestHealth, type DigestEmail } from "./render.js";
import { appendPendingLeads } from "./sheet-sync.js";
import { assignDeliveryIds, labelLinks } from "./label-links.js";
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
  /** counts only (safe for public CI logs): emails by status, analyst fresh/cached/failed */
  enrich?: string;
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
  // latest usage-guard readings (written by the nightly upkeep step)
  const usage = ((await db.execute(sql`select distinct on (service) service, used, "limit" from usage_daily
    where service <> 'haiku' and day > (now() - interval '3 days')::date order by service, day desc`)).rows as { service: string; used: number; limit: number }[])
    .map((u) => ({ service: u.service, pct: u.limit > 0 ? u.used / u.limit : 0 }));
  const [tp] = (await db.execute(sql`select count(*)::int as n from tuning_actions where status = 'proposed' and created_at > now() - interval '8 days'`)).rows as { n: number }[];
  const metrics = Object.fromEntries(((await db.execute(sql`select distinct on (metric) metric, value from eval_results
    where computed_at > now() - interval '3 days' order by metric, computed_at desc`)).rows as { metric: string; value: number }[]).map((r) => [r.metric, Number(r.value)]));
  void pack;
  return {
    boardsTotal: b?.total ?? 0, boardsChecked24h: b?.checked ?? 0, boardsFailing: b?.failing ?? 0,
    ticks24h: t?.n ?? 0, tickErrors24h: t?.errors ?? 0, haikuTodayUsd: spend[0]?.used ?? 0, haikuCapUsd: capUsd, indiaTracked: india?.n ?? 0, usage, metrics, tuningPending: tp?.n ?? 0,
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
  const max = pack.delivery.digest.max_leads;
  // score a pool of 2x the leads, find who to contact there, drop leads with nobody to contact, re-rank by reach
  const score = await runScoring({ pack, write: !opts.dryRun && !opts.test, maxLeads: max * 2 });
  const preferred = preferredPersonas([...score.ranking.leads, ...score.ranking.watchlist]);
  // people search only for the leads (not the watchlist) to stay inside the search API's free tier
  const contacts = await contactsFor([...score.ranking.leads, ...score.ranking.watchlist].map((l) => l.account.id), pack, {
    write: !opts.dryRun, searchFor: score.ranking.leads.map((l) => l.account.id), preferred,
  });
  const enrich: string[] = [];
  try { const e = await attachEmails(contacts, { write: !opts.dryRun }); enrich.push(`emails ${JSON.stringify(e.byStatus)} (${e.domains} domains checked)`); }
  catch { enrich.push("emails failed"); /* leads still go out with LinkedIn */ }
  const r = rerankByReach(score.ranking, contacts, pack, max);
  score.ranking = r.ranking;
  enrich.push(`reach: ${[...r.factors.values()].filter((f) => f < 1).length} of ${r.factors.size} pool leads down-weighted; ${r.noContact} dropped for no contact`);
  // analyst only for today's leads; cached by evidence, so test sends and re-runs don't pay again
  let notes: Awaited<ReturnType<typeof analyzeLeads>>["analyses"] | undefined;
  try {
    const an = await analyzeLeads(score.ranking.leads, contacts, pack, { dailyCapUsd: opts.haikuCapUsd ?? Number(process.env.HAIKU_DAILY_CAP_USD ?? 1) });
    notes = an.analyses;
    enrich.push(`analyst fresh=${an.fresh} cached=${an.cached} failed=${an.failed}${an.skipped ? ` (${an.skipped})` : ""}`);
  } catch { enrich.push("analyst failed"); /* code-written openers stand */ }
  const gigList = await gigsForDigest(pack);
  const h = await health(pack, opts.haikuCapUsd ?? Number(process.env.HAIKU_DAILY_CAP_USD ?? 1));
  h.indiaInLeads = score.ranking.leads.filter((l) => l.account.region === "India").length;
  // one-tap labels only on the real send (test and dry runs record no deliveries for the links to point at)
  const ids = assignDeliveryIds(score.ranking.leads.map((l) => l.account.id));
  const labelUrl = process.env.TELL_LABEL_URL, labelSecret = process.env.LABEL_SECRET;
  const taps = !opts.dryRun && !opts.test && labelUrl && labelSecret
    ? new Map([...ids].map(([a, d]) => [a, labelLinks(labelUrl, labelSecret, d)])) : undefined;
  const email = renderDigest(score, pack, h, day, contacts, gigList, notes, taps);
  const counts = { enrich: enrich.join("; "), leads: score.ranking.leads.length, watchlist: score.ranking.watchlist.length, personLeads: score.personLeads.length };
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
      id: ids.get(l.account.id)!, accountId: l.account.id, deliveredAt: now, kind: l.score.lane === "fast" ? "fast" : "normal", configVersion: score.configVersion,
      sheetRow: leadSheetRow(l, contacts.get(l.account.id), day, notes?.get(l.account.id), pack.delivery.email.signature),
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
