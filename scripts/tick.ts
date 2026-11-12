/**
 * Production 30-minute tick, run by GitHub Actions (.github/workflows/tick.yml) or by hand: `pnpm tick`.
 * This repo is public, so Actions logs are public: print counts only, never post text or secrets.
 */
import "dotenv/config";
import { resolve } from "node:path";
import { runScheduledTick } from "@tell/pipeline";

const res = await runScheduledTick({
  configPath: resolve(process.cwd(), "config/signals.yaml"),
  dailyCapUsd: Number(process.env.HAIKU_DAILY_CAP_USD ?? 1),
  maxPerSource: process.env.TICK_MAX_PER_SOURCE ? Number(process.env.TICK_MAX_PER_SOURCE) : undefined,
});

if (res.skipped) console.log(`skipped: ${res.skipped}`);
for (const s of res.summaries) {
  console.log(
    `${s.sourceId}: fetched=${s.fetched} new=${s.newItems} confirmed=${s.confirmed} rejected=${s.rejected} uncertain=${s.uncertain}` +
      `${s.usedFallback ? " (fallback)" : ""}${s.error ? ` ERROR=${s.error.slice(0, 200)}` : ""}`,
  );
}
console.log(`haiku: run=$${res.spentThisRunUsd.toFixed(4)} today=$${res.spentTodayUsd.toFixed(4)} cap=$${res.dailyCapUsd}`);

// Fail the job (visible in the Actions tab) when every source errored.
if (res.summaries.length && res.summaries.every((s) => s.error)) process.exit(1);
