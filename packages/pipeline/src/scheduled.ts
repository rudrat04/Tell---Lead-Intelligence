import { hn, reddit, forhireSubs, isSourceEnabled, type Watcher } from "@tell/watchers";
import { HaikuClient } from "@tell/extract";
import { gate1, loadGate1Rules } from "@tell/intel";
import { runTick, type Store, type TickSummary } from "./ingest.js";
import { neonStore } from "./neon-store.js";
import { neonUsage, type UsageStore } from "./usage.js";

export const TICK_WATCHERS: Watcher[] = [reddit, forhireSubs, hn];

export interface ScheduledTickResult {
  skipped?: string;
  summaries: TickSummary[];
  spentThisRunUsd: number;
  spentTodayUsd: number;
  dailyCapUsd: number;
}

/**
 * The 30-minute tick, independent of the scheduler (GitHub Actions now, Trigger.dev later).
 * Enforces a real daily Haiku cap by persisting spend per IST day.
 */
export async function runScheduledTick(opts: {
  configPath: string;
  dailyCapUsd: number;
  maxPerSource?: number;
  store?: Store;
  usage?: UsageStore;
}): Promise<ScheduledTickResult> {
  const usage = opts.usage ?? neonUsage();
  const spentBefore = await usage.spentToday("haiku");
  const remaining = opts.dailyCapUsd - spentBefore;
  if (remaining <= 0) {
    return { skipped: "daily Haiku cap reached", summaries: [], spentThisRunUsd: 0, spentTodayUsd: spentBefore, dailyCapUsd: opts.dailyCapUsd };
  }

  const rules = loadGate1Rules(opts.configPath);
  const llm = new HaikuClient({ capUsd: remaining });
  try {
    const summaries = await runTick({
      store: opts.store ?? neonStore(),
      gates: { llm, gate1: (t) => gate1(t, rules.never, rules.required) },
      watchers: TICK_WATCHERS.filter((w) => isSourceEnabled(w.id)),
      maxPerSource: opts.maxPerSource ?? 50,
    });
    return { summaries, spentThisRunUsd: llm.spent, spentTodayUsd: spentBefore + llm.spent, dailyCapUsd: opts.dailyCapUsd };
  } finally {
    // record spend even if the tick failed partway
    await usage.addSpend("haiku", llm.spent, opts.dailyCapUsd);
  }
}
