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

// Fail the job (visible in the Actions tab) when every source errored.
if (res.summaries.length && res.summaries.every((s) => s.error)) process.exit(1);
