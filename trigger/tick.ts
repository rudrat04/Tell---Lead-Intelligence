import { schedules } from "@trigger.dev/sdk";
import { loadPack } from "@tell/config";
import { runScheduledTick } from "@tell/pipeline";

/**
 * Every 30 minutes (plan section 14). Not deployed yet: Trigger.dev blocked deployments for this org,
 * so the same runner currently runs from GitHub Actions (.github/workflows/tick.yml).
 */
export const tick = schedules.task({
  id: "tick-30min",
  cron: "*/30 * * * *",
  maxDuration: 240,
  run: async () => runScheduledTick({ pack: await loadPack(), dailyCapUsd: Number(process.env.HAIKU_DAILY_CAP_USD ?? 1) }),
});
