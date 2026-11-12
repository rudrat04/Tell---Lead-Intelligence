import { schedules } from "@trigger.dev/sdk";
import { runTick, neonStore } from "@tell/pipeline";
import { hn, reddit, forhireSubs, isSourceEnabled } from "@tell/watchers";
import { HaikuClient } from "@tell/extract";
import { gate1, loadNeverPatterns } from "@tell/intel";

/** Every 30 minutes (plan section 14). Per-tick Haiku spend is capped; the daily cap lives in the usage guard. */
export const tick = schedules.task({
  id: "tick-30min",
  cron: "*/30 * * * *",
  maxDuration: 240,
  run: async () => {
    const never = loadNeverPatterns(new URL("../config/signals.yaml", import.meta.url).pathname);
    const summaries = await runTick({
      store: neonStore(),
      gates: { llm: new HaikuClient({ dailyCapUsd: Number(process.env.HAIKU_DAILY_CAP_USD ?? 1) }), gate1: (t) => gate1(t, never) },
      // Reddit watchers stay disabled by policy until API access is approved (see packages/watchers/src/policy.ts)
      watchers: [reddit, forhireSubs, hn].filter((w) => isSourceEnabled(w.id)),
    });
    return summaries;
  },
});
