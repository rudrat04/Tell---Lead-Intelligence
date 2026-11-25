import { leadCap, type Pack } from "@tell/config";
import {
  runScoring, istDay, buildMissingPlays, judgeAccounts, nicheStats, contactsFor, attachEmails, upgradeEmails, keepSureEmails, domainContacts, fillCompanyFacts, analyzeLeads, rerankByReach, preferredPersonas, gigsForDigest, markGigsDelivered, regionInScopeSql,
  loadNetwork, attachWarmPaths, championsForDigest, markChampionsShown, checkRoleGaps, type ScoreRunResult, type ChampionMove,
} from "@tell/pipeline";
import { getDb, runs, deliveries, jobBoards, usageDaily, accounts, eq, and, sql } from "@tell/db";
import { renderDigest, leadSheetRow, emailDraft, type DigestHealth, type DigestEmail } from "./render.js";
import { sendTelegram, summaryMessage, leadMessage, storeTelegramTexts, telegramConfigured } from "./telegram.js";
import { runFollowups, type TouchBack } from "./followups.js";
import { appendPendingLeads } from "./sheet-sync.js";
import { assignDeliveryIds, labelLinks, enrichLink } from "./label-links.js";
import type { Sender } from "./gmail.js";

export interface DigestResult {
  status: "sent" | "skipped" | "dry-run" | "recorded";
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
    from ${jobBoards} join ${accounts} on ${accounts.id} = ${jobBoards.accountId}
    where ${jobBoards.status} = 'active' and ${jobBoards.source} <> 'jsearch' and ${regionInScopeSql(pack, accounts.region)}`)).rows as { total: number; checked: number; failing: number }[];
  const [t] = (await db.execute(sql`
    select count(*)::int as n, count(*) filter (where ${runs.status} <> 'ok')::int as errors
    from ${runs} where ${runs.task} like 'tick:%' and ${runs.startedAt} > ${since}`)).rows as { n: number; errors: number }[];
  const spend = await db.select({ used: usageDaily.used }).from(usageDaily).where(and(eq(usageDaily.day, istDay()), eq(usageDaily.service, "haiku")));
  const writer = await db.select({ used: usageDaily.used, limit: usageDaily.limit }).from(usageDaily).where(and(eq(usageDaily.day, istDay()), eq(usageDaily.service, "sonnet")));
  const [india] = (await db.execute(sql`select count(*)::int as n from ${accounts} where ${accounts.region} = 'India' and ${accounts.status} = 'active'`)).rows as { n: number }[];
  // latest usage-guard readings (written by the nightly upkeep step)
  const usage = ((await db.execute(sql`select distinct on (service) service, used, "limit" from usage_daily
    where service not in ('haiku', 'sonnet') and day > (now() - interval '3 days')::date order by service, day desc`)).rows as { service: string; used: number; limit: number }[])
    .map((u) => ({ service: u.service, pct: u.limit > 0 ? u.used / u.limit : 0 }));
  const [tp] = (await db.execute(sql`select count(*)::int as n from tuning_actions where status = 'proposed' and created_at > now() - interval '8 days'`)).rows as { n: number }[];
  const metrics = Object.fromEntries(((await db.execute(sql`select distinct on (metric) metric, value from eval_results
    where computed_at > now() - interval '3 days' order by metric, computed_at desc`)).rows as { metric: string; value: number }[]).map((r) => [r.metric, Number(r.value)]));
  return {
    boardsTotal: b?.total ?? 0, boardsChecked24h: b?.checked ?? 0, boardsFailing: b?.failing ?? 0,
    ticks24h: t?.n ?? 0, tickErrors24h: t?.errors ?? 0, haikuTodayUsd: spend[0]?.used ?? 0, haikuCapUsd: capUsd,
    writerTodayUsd: writer[0]?.used ?? 0, writerCapUsd: writer[0]?.limit ?? Number(process.env.WRITER_DAILY_CAP_USD ?? 0.08), indiaTracked: india?.n ?? 0, usage, metrics, tuningPending: tp?.n ?? 0,
  };
}

/**
 * Score, render and send the daily digest. Sends at most once per IST day (runs.idempotency_key = digest:<day>);
 * a failed send leaves the day open for a retry.
 */
/** `test`: send now with a [TEST] subject but record nothing (no scores, no deliveries, the day stays open).
 *  `sheetOnly`: no email and no run record (works after today's digest went out): record today's leads as delivered and append them to the Sheet. */
export async function runDigest(opts: { pack: Pack; sender: Sender | null; dryRun?: boolean; test?: boolean; sheetOnly?: boolean; haikuCapUsd?: number }): Promise<DigestResult> {
  const { pack } = opts;
  const db = getDb();
  const day = istDay();
  const key = `digest:${day}`;
  const to = pack.delivery.digest.to, from = pack.delivery.digest.from;

  if (!opts.dryRun && !opts.test && !opts.sheetOnly) {
    if (!to || !from) return { status: "skipped", reason: "delivery.digest.to / from not set in the pack", leads: 0, watchlist: 0, personLeads: 0 };
    const prior = await db.select({ status: runs.status }).from(runs).where(eq(runs.idempotencyKey, key)).limit(1);
    if (prior[0]?.status === "ok") return { status: "skipped", reason: `already sent for ${day}`, leads: 0, watchlist: 0, personLeads: 0 };
  }

  if (opts.test && (!to || !from)) return { status: "skipped", reason: "delivery.digest.to / from not set in the pack", leads: 0, watchlist: 0, personLeads: 0 };
  const max = leadCap(pack); // Infinity when max_leads is 0: every lead over min_score
  // score a pool of pool_multiplier x the leads, find who to contact there, drop leads with nobody to contact, re-rank by reach
  // judged mode: once the judge has worked this run, only judged accounts compete (requireJudged); if it couldn't run
  // at all (no credit, outage), every account keeps its legacy score so the digest never goes out empty
  let requireJudged = false;
  const scoreRun = (write: boolean) => runScoring({ pack, write, maxLeads: max * pack.delivery.digest.pool_multiplier, poolScale: pack.delivery.digest.pool_multiplier, requireJudged });
  // first pass without writes (scores are written once, by the final pass)
  let score = await scoreRun(false);
  // company size + segment for pool accounts no source gave them for (Exa company index); re-score when any changed,
  // so an enterprise or an off-ICP segment leaves the pool before contacts are looked up
  let factsNote = "company facts: none needed";
  try {
    // pool accounts first, then accounts under min_score only because size/segment is unknown (they may pass once known)
    const ids = [...new Set([...[...score.ranking.leads, ...score.ranking.watchlist].map((l) => l.account.id), ...score.factsCandidates])];
    const f = await fillCompanyFacts(ids, pack, { write: !opts.dryRun });
    factsNote = f.skipped ? `company facts: ${f.skipped}` : `company facts: ${f.looked} looked up, ${f.sized} sized, ${f.segmented} segmented, ${f.described} described`;
    if (f.changed.length) score = await scoreRun(false);
  } catch { factsNote = "company facts failed"; }
  // validate the need: who holds the GTM / Founder's Office / Product Marketing seats today (roles.yaml gaps). A gap
  // adds evidence (and can complete a play); a holder of a core role counts against the lead. Re-score when any changed.
  let gapNote = "need check: off";
  try {
    // owner check: only accounts hiring sellers or marketers (where "who runs the system?" decides the lead)
    const hiring = new Set(["adjacent_role_open", "first_role", "core_role_open", "core_role_open_45d", "contract_role", "role_reposted"]);
    const pool = [...score.ranking.leads, ...score.ranking.watchlist].filter((l) => l.score.evidence.some((e) => hiring.has(e.type))).map((l) => l.account.id);
    const g = await checkRoleGaps([...new Set([...pool, ...score.gapCandidates])], pack);
    gapNote = g.skipped ? `owner check: ${g.skipped}` : pack.signals.signals.role_gap ? `need check: ${g.checked} checked, ${g.gaps} with empty seats` : `owner check: ${g.checked} checked`;
    if (g.changed.length) score = await scoreRun(false);
  } catch { gapNote = "need check failed"; }
  // no pack play fits: build one from the evidence (plays.build); a qualifying play makes the lead, "no need" drops it
  let playNote = "";
  if (pack.signals.score.mode === "judged") {
    // one path: the judge rates every gate-passing account and writes its play (the builder doesn't run)
    try {
      const j = await judgeAccounts(score.judgeCandidates, pack);
      playNote = j.skipped ? `judged: ${j.skipped}` : `judged ${j.judged}: ${j.qualified} opportunities, ${j.rejected} no${j.failed ? `, ${j.failed} failed` : ""}${score.learnedLabels != null ? `; learned from ${score.learnedLabels} labelled leads` : ""}`;
      // the judge works today (it answered, or there was nothing new to judge): judged accounts only
      requireJudged = j.judged > 0 || (!j.failed && j.skipped === "nothing to judge");
      if (!requireJudged) playNote += " (legacy scores used)";
      if (j.judged || requireJudged) score = await scoreRun(false);
    } catch { playNote = "judge failed (legacy scores used)"; }
  } else if (pack.plays.build?.enabled) {
    try {
      const b = await buildMissingPlays(score.playCandidates, pack);
      playNote = b.skipped ? `plays built: ${b.skipped}` : `plays built ${b.built}: ${b.qualified} qualified, ${b.rejected} no need${b.failed ? `, ${b.failed} failed` : ""}`;
      if (b.built) score = await scoreRun(false);
    } catch { playNote = "play builder failed"; }
  }
  if (!opts.dryRun && !opts.test) score = await scoreRun(true);
  const preferred = preferredPersonas([...score.ranking.leads, ...score.ranking.watchlist]);
  // people search only for the leads (not the watchlist) to stay inside the search API's free tier
  const contacts = await contactsFor([...score.ranking.leads, ...score.ranking.watchlist].map((l) => l.account.id), pack, {
    write: !opts.dryRun, searchFor: score.ranking.leads.map((l) => l.account.id), preferred,
  });
  const enrich: string[] = [factsNote, gapNote, ...(playNote ? [playNote] : [])];
  // Hunter domain search: a lead nobody is known for gets one look at the people Hunter lists there (it would be dropped otherwise)
  try {
    const w = await domainContacts(contacts, score.ranking.leads.map((l) => l.account.id), pack, { write: !opts.dryRun, preferred });
    enrich.push(w.skipped ? `hunter people: ${w.skipped}` : `hunter people ${w.found}/${w.looked}`);
  } catch { enrich.push("hunter people failed"); }
  try { const e = await attachEmails(contacts, { write: !opts.dryRun }); enrich.push(`emails ${JSON.stringify(e.byStatus)} (${e.domains} domains checked)`); }
  catch { enrich.push("emails failed"); /* leads still go out with LinkedIn */ }
  // today's leads only: verify guessed addresses, and find one where there is none (QuickEmailVerification, Hunter, Prospeo)
  try { const u = await upgradeEmails(contacts, score.ranking.leads.map((l) => l.account.id), { write: !opts.dryRun }); enrich.push(u.skipped ? `email apis: ${u.skipped}` : `email apis: ${u.verified} verified, ${u.found} found, ${u.invalid} invalid`); }
  catch { enrich.push("email apis failed"); }
  // never a guess: whatever no verifier or finder confirmed is dropped (the Find email button stays for those)
  enrich.push(`unsure emails dropped: ${keepSureEmails(contacts)}`);
  // the full email waterfall for anyone still unsure runs only when you click "Find email" (digest button / Sheet column): pnpm enrich:requests
  // warm paths through your own network (pnpm network): shown on the lead, and a reach boost (icp.reach.warm_path)
  let champions: ChampionMove[] = [];
  try {
    const network = await loadNetwork();
    if (network.length) {
      const pool = [...score.ranking.leads, ...score.ranking.watchlist];
      const n = attachWarmPaths(contacts, new Map(pool.map((l) => [l.account.id, l.account])), network);
      enrich.push(`warm paths ${n}`);
    }
    champions = await championsForDigest();
  } catch { enrich.push("network failed"); }
  const r = rerankByReach(score.ranking, contacts, pack, max);
  score.ranking = r.ranking;
  const avg = r.factors.size ? [...r.factors.values()].reduce((a, b) => a + b, 0) / r.factors.size : 0;
  // weekly India import (GeM / RERA / customs exports via pnpm niche import): a nudge when it's been over a week
  try {
    const st = await nicheStats();
    if (st.daysSinceImport == null || st.daysSinceImport > 7) enrich.push(`India import: ${st.daysSinceImport == null ? "never run" : `last ${st.daysSinceImport} days ago`} (export GeM / RERA rows, then pnpm niche import file.csv)`);
    if (st.queued) enrich.push(`niche queue ${st.queued}`);
  } catch { /* stats are a nudge, never a failure */ }
  enrich.push(`buyer: average ${(avg * 100).toFixed(0)}% over ${r.factors.size} pool leads; ${r.noContact} dropped for no contact; ${r.enterprise} dropped as enterprise (contact title)`);
  // analyst only for today's leads; cached by evidence, so test sends and re-runs don't pay again
  let notes: Awaited<ReturnType<typeof analyzeLeads>>["analyses"] | undefined;
  try {
    const an = await analyzeLeads(score.ranking.leads, contacts, pack); // Sonnet writer, own daily cap (WRITER_DAILY_CAP_USD)
    notes = an.analyses;
    enrich.push(`analyst fresh=${an.fresh} cached=${an.cached} failed=${an.failed} buyer_samples=${an.buyerSamples ?? 0}${an.skipped ? ` (${an.skipped})` : ""}`);
  } catch (e) { enrich.push("analyst failed"); if (!process.env.CI) console.error("analyst:", (e as Error).message); /* code-written openers stand */ }
  // touch back: past leads with a new fact, after today's drafts (they get the writer budget first); a test or dry run
  // lists the facts without writing drafts
  let touched: TouchBack[] = [];
  try {
    const f = await runFollowups({ pack, dryRun: opts.dryRun || opts.test, draft: !opts.dryRun && !opts.test, exclude: new Set(score.ranking.leads.map((l) => l.account.id)) });
    touched = f.touched;
    enrich.push(`touch back ${f.touched.length} (${f.written} drafted)${f.skipped ? ` (${f.skipped})` : ""}`);
  } catch { enrich.push("touch back failed"); }
  const gigList = await gigsForDigest(pack);
  const h = await health(pack, opts.haikuCapUsd ?? Number(process.env.HAIKU_DAILY_CAP_USD ?? 0.06));
  h.indiaInLeads = score.ranking.leads.filter((l) => l.account.region === "India").length;
  // one-tap labels only on the real send (test and dry runs record no deliveries for the links to point at)
  const ids = assignDeliveryIds(score.ranking.leads.map((l) => l.account.id));
  const labelUrl = process.env.TELL_LABEL_URL, labelSecret = process.env.LABEL_SECRET;
  const taps = !opts.dryRun && !opts.test && labelUrl && labelSecret
    ? new Map([...ids].map(([a, d]) => [a, { ...labelLinks(labelUrl, labelSecret, d), enrich: enrichLink(labelUrl, labelSecret, d) }])) : undefined;
  const email = renderDigest(score, pack, h, day, contacts, gigList, notes, taps, champions, touched);
  const counts = { enrich: enrich.join("; "), leads: score.ranking.leads.length, watchlist: score.ranking.watchlist.length, personLeads: score.personLeads.length };
  if (opts.dryRun) return { status: "dry-run", email, score, ...counts };
  const deliveryRows = (at: Date) => score.ranking.leads.map((l) => ({
    id: ids.get(l.account.id)!, accountId: l.account.id, deliveredAt: at, kind: l.score.judged?.exploring ? "exploration" : l.score.lane === "fast" ? "fast" : "normal", configVersion: score.configVersion,
    sheetRow: leadSheetRow(l, contacts.get(l.account.id), day, notes?.get(l.account.id), pack.delivery.email.signature, pack.copy, pack.icp.calendar, taps?.get(l.account.id)?.enrich),
  }));
  if (opts.sheetOnly) {
    if (score.ranking.leads.length) await db.insert(deliveries).values(deliveryRows(new Date()));
    const n = pack.delivery.sheet.spreadsheet_id ? await appendPendingLeads(pack) : 0;
    return { status: "recorded", reason: "sheet only: no email sent", email, score, sheet: `appended ${n} lead${n === 1 ? "" : "s"}`, ...counts };
  }
  const useEmail = pack.delivery.channels.includes("email"), useTg = pack.delivery.channels.includes("telegram") && telegramConfigured();
  // no channel that can send yet: scores are written, nothing is sent, the day stays open
  if (!(useEmail && opts.sender) && !useTg) return { status: "skipped", reason: "no delivery channel configured (Gmail: pnpm gmail:auth; Telegram: TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)", email, score, ...counts };
  const tgMessages = (test: boolean) => [
    summaryMessage(score, day, { touchBacks: touched.length, health: email.text.split("\nHEALTH\n")[1]?.split("\n")[0]?.replace(/^- /, ""), test }),
    ...score.ranking.leads.map((l) => leadMessage(l, contacts.get(l.account.id), notes?.get(l.account.id), ids.get(l.account.id) ?? null, day, pack, test)),
  ];

  if (opts.test) {
    if (useEmail && opts.sender) await opts.sender.send({ from: from!, fromName: pack.delivery.digest.from_name, to: to!, subject: `[TEST] ${email.subject}`, html: email.html, text: email.text });
    if (useTg) await sendTelegram(tgMessages(true)).catch(() => 0);
    return { status: "sent", reason: "test: nothing recorded", email, score, ...counts };
  }

  const started = new Date();
  let tgNote = "";
  try {
    if (useEmail && opts.sender) await opts.sender.send({ from: from!, fromName: pack.delivery.digest.from_name, to: to!, subject: email.subject, html: email.html, text: email.text });
    if (useTg) {
      // the brief and the draft wait in the Worker for the Brief / Draft buttons; then the messages go out
      await storeTelegramTexts(score.ranking.leads.flatMap((l) => {
        const d = ids.get(l.account.id), n = notes?.get(l.account.id);
        return d ? [{ d, brief: n?.brief, draft: n?.email ? `${n.email.subject}\n\n${emailDraft(contacts.get(l.account.id), n, pack.delivery.email.signature, pack.copy.greeting)}` : undefined }] : [];
      })).catch(() => false);
      try { tgNote = `telegram: ${await sendTelegram(tgMessages(false))} messages`; }
      catch (e) { if (!(useEmail && opts.sender)) throw e; tgNote = `telegram failed: ${String(e).slice(0, 80)}`; }
    }
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
  if (score.ranking.leads.length) batch.push(db.insert(deliveries).values(deliveryRows(now)));
  await db.batch(batch as unknown as Parameters<typeof db.batch>[0]);
  await markGigsDelivered(gigList.map((g) => g.id), now);
  await markChampionsShown(champions.map((c) => c.name), now);

  // Sheet: append after the email is out; a Sheet problem never fails the digest (rows are retried next run)
  let sheet = "no sheet configured";
  if (pack.delivery.sheet.spreadsheet_id) {
    try {
      // (gigs no longer go to the Sheet: the Gigs tab was removed on Nov 22 2026)
      const n = await appendPendingLeads(pack);
      sheet = `appended ${n} lead${n === 1 ? "" : "s"}`;
    } catch (e) {
      sheet = `append failed (retried next run): ${String(e).slice(0, 160)}`;
    }
  }
  return { status: "sent", email, score, sheet: tgNote ? `${sheet}; ${tgNote}` : sheet, ...counts };
}
