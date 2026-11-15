/**
 * Production 30-minute tick, run by GitHub Actions (.github/workflows/tick.yml) or by hand: `pnpm tick`.
 * This repo is public, so Actions logs are public: print counts only, never post text or secrets.
 */
import "dotenv/config";
import { loadPack } from "@tell/config";
import { runScheduledTick } from "@tell/pipeline";
import { getDb, runs, sql } from "@tell/db";

// --if-stale-minutes N: only run when no tick has run in the last N minutes (the daily chain's fallback,
// so it never overlaps a regular tick and processes the same items twice).
const i = process.argv.indexOf("--if-stale-minutes");
if (i > 0) {
  const minutes = Number(process.argv[i + 1] ?? 120);
  const [row] = await getDb().select({ last: sql<Date | null>`max(${runs.startedAt})` }).from(runs).where(sql`${runs.task} like 'tick:%'`);
  const last = row?.last ? new Date(row.last) : null;
  if (last && Date.now() - last.getTime() < minutes * 60_000) {
    console.log(`tick skipped: last tick ${Math.round((Date.now() - last.getTime()) / 60_000)} min ago (< ${minutes})`);
    process.exit(0);
  }
}

const res = await runScheduledTick({
  pack: await loadPack(),
  dailyCapUsd: Number(process.env.HAIKU_DAILY_CAP_USD ?? 1),
  maxPerSource: process.env.TICK_MAX_PER_SOURCE ? Number(process.env.TICK_MAX_PER_SOURCE) : undefined,
});

if (res.skipped) console.log(`skipped: ${res.skipped}`);
for (const s of res.summaries) {
  console.log(
    `${s.sourceId}: fetched=${s.fetched} new=${s.newItems} confirmed=${s.confirmed} rejected=${s.rejected} uncertain=${s.uncertain}` +
      ` | accounts=${s.account} person_leads=${s.person} unresolved=${s.unresolved}${s.recordErrors ? ` record_errors=${s.recordErrors}` : ""}` +
      `${s.usedFallback ? " (fallback)" : ""}${s.error ? ` ERROR=${s.error.slice(0, 200)}` : ""}`,
  );
}
console.log(`haiku: run=$${res.spentThisRunUsd.toFixed(4)} today=$${res.spentTodayUsd.toFixed(4)} cap=$${res.dailyCapUsd}`);

// Fail the job (visible in the Actions tab, and an email) when every source errored two ticks in a row. One failed tick
// is usually a network blip (a source timing out); the next tick catches up because lastRunAt only moves on a clean run.
if (res.summaries.length && res.summaries.every((s) => s.error)) {
  const prev = await getDb().execute(sql`
    select status from (select status, row_number() over (partition by task order by started_at desc) as n
      from ${runs} where task in (${sql.join(res.summaries.map((s) => sql`${`tick:${s.sourceId}`}`), sql`, `)})) r where n = 2`);
  const prevOk = (prev.rows as { status: string }[]).some((r) => r.status === "ok");
  if (prevOk) console.log("every source errored this tick, but the previous tick was fine: treating it as a blip");
  else process.exit(1);
}
