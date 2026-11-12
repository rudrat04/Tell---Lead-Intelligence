import { dirname, join } from "node:path";
import { hn, reddit, forhireSubs, isSourceEnabled, type Watcher, type RawItem } from "@tell/watchers";
import { HaikuClient, type PostExtraction } from "@tell/extract";
import { gate1, loadGate1Rules } from "@tell/intel";
import {
  resolveItem, recordConfirmed, loadDomainLists, loadSignalSpecs, neonLeadStore,
  checkHomepage, expandShortUrl, fetchHnAbout, type ResolverNet, type Resolution, type LeadStore,
} from "@tell/people";
import { runTick, type Store, type TickSummary } from "./ingest.js";
import { neonStore } from "./neon-store.js";
import { neonUsage, type UsageStore } from "./usage.js";

export const TICK_WATCHERS: Watcher[] = [reddit, forhireSubs, hn];

export const liveNet: ResolverNet = {
  checkHomepage,
  expandShortUrl,
  fetchProfileText: async (platform, handle) => (platform === "hn" ? fetchHnAbout(handle) : null),
};

export interface ScheduledTickResult {
  skipped?: string;
  summaries: TickSummary[];
  spentThisRunUsd: number;
  spentTodayUsd: number;
  dailyCapUsd: number;
}

/** Resolve a confirmed item and write it. Network failures degrade to a person lead, never lose the item. */
export function makeOnConfirmed(configDir: string, leads: LeadStore, net: ResolverNet) {
  const lists = loadDomainLists(join(configDir, "domains.yaml"));
  const specs = loadSignalSpecs(join(configDir, "signals.yaml"));
  return async (item: RawItem, x: PostExtraction) => {
    let res: Resolution;
    try {
      res = await resolveItem(item, x, lists, net);
    } catch {
      const platform = item.sourceId === "hn" ? "hn" : "reddit";
      res = item.author ? { kind: "person", platform, handle: item.author, reason: "resolution failed" } : { kind: "unresolved", reason: "resolution failed" };
    }
    return recordConfirmed(item, x, res, specs, leads);
  };
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
  leads?: LeadStore;
  net?: ResolverNet;
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
      onConfirmed: makeOnConfirmed(dirname(opts.configPath), opts.leads ?? neonLeadStore(), opts.net ?? liveNet),
    });
    return { summaries, spentThisRunUsd: llm.spent, spentTodayUsd: spentBefore + llm.spent, dailyCapUsd: opts.dailyCapUsd };
  } finally {
    // record spend even if the tick failed partway
    await usage.addSpend("haiku", llm.spent, opts.dailyCapUsd);
  }
}
