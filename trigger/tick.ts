import { schedules } from "@trigger.dev/sdk";
import { fileURLToPath } from "node:url";
import { runTick, neonStore } from "@tell/pipeline";
import { hn, reddit, forhireSubs, isSourceEnabled } from "@tell/watchers";
import { HaikuClient } from "@tell/extract";
import { gate1, loadGate1Rules } from "@tell/intel";

/** Every 30 minutes (plan section 14). Per-tick Haiku spend is capped; the daily cap lives in the usage guard. */
export const tick = schedules.task({
  id: "tick-30min",
  cron: "*/30 * * * *",
  maxDuration: 240,
  run: async () => {
    const rules = loadGate1Rules(fileURLToPath(new URL("../config/signals.yaml", import.meta.url)));
    const summaries = await runTick({
      store: neonStore(),
      gates: { llm: new HaikuClient({ dailyCapUsd: Number(process.env.HAIKU_DAILY_CAP_USD ?? 1) }), gate1: (t) => gate1(t, rules.never, rules.required) },
      // Reddit watchers stay disabled by policy until API access is approved (see packages/watchers/src/policy.ts)
      watchers: [reddit, forhireSubs, hn].filter((w) => isSourceEnabled(w.id)),
    });
    return summaries;
  },
});
