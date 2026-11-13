import type { Pack } from "@tell/config";
import { makeHn, makeReddit, makeForhire, isSourceEnabled, setBotIdentity, type Watcher, type RawItem } from "@tell/watchers";
import { HaikuClient, type PostExtraction } from "@tell/extract";
import { gate2Decide, featurize, type Exemplar } from "@tell/intel";
import { getDb, exemplars } from "@tell/db";
import { gate1, gate1Rules } from "@tell/intel";
import {
  resolveItem, recordConfirmed, domainLists, neonLeadStore,
  checkHomepage, expandShortUrl, fetchHnAbout, type ResolverNet, type Resolution, type LeadStore,
} from "@tell/people";
import { runTick, type Store, type TickSummary } from "./ingest.js";
import { neonStore } from "./neon-store.js";
import { neonUsage, type UsageStore } from "./usage.js";

/** Call once at startup: every crawler request identifies as this copy's operator. */
export function applyPackIdentity(pack: Pack): void {
  setBotIdentity(pack.meta.operator.bot_name, pack.meta.operator.contact_url);
}

/** Watchers for the 30-minute tick: enabled in the pack AND allowed by source policy (terms of use). */
export function tickWatchers(pack: Pack): Watcher[] {
  const s = pack.sources;
  const all: Watcher[] = [];
  if (s.reddit.enabled) all.push(makeReddit(s.reddit.subs), makeForhire(s.reddit.hiring_subs));
  if (s.hn.enabled) all.push(makeHn(s.hn.queries));
  return all.filter((w) => isSourceEnabled(w.id));
}

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
export function makeOnConfirmed(pack: Pack, leads: LeadStore, net: ResolverNet) {
  const lists = domainLists(pack.domains);
  const specs = pack.signals.signals;
  return async (item: RawItem, x: PostExtraction) => {
    let res: Resolution;
    try {
      res = await resolveItem(item, x, lists, net);
    } catch {
      const platform = item.sourceId.startsWith("hn") ? "hn" : "reddit";
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
  pack: Pack;
  dailyCapUsd: number;
  maxPerSource?: number;
  store?: Store;
  usage?: UsageStore;
  leads?: LeadStore;
  net?: ResolverNet;
  watchers?: Watcher[];
  /** Gate 2 example bank (tests); loaded from the pack seeds + exemplars table when omitted */
  gate2Bank?: Exemplar[];
}): Promise<ScheduledTickResult> {
  const { pack } = opts;
  applyPackIdentity(pack);
  const usage = opts.usage ?? neonUsage();
  const spentBefore = await usage.spentToday("haiku");
  const remaining = opts.dailyCapUsd - spentBefore;
  if (remaining <= 0) {
    return { skipped: "daily Haiku cap reached", summaries: [], spentThisRunUsd: 0, spentTodayUsd: spentBefore, dailyCapUsd: opts.dailyCapUsd };
  }

  const rules = gate1Rules(pack);
  const llm = new HaikuClient({ capUsd: remaining });
  const bank = opts.gate2Bank ?? await loadGate2Bank(pack);
  const g2 = pack.signals.gate2;
  try {
    const summaries = await runTick({
      store: opts.store ?? neonStore(),
      gates: {
        llm, gate1: (t) => gate1(t, rules.never, rules.required), extractor: pack.extractor, minStrength: pack.signals.min_post_strength,
        gate2: async (t) => gate2Decide(t, bank, g2),
      },
      watchers: opts.watchers ?? tickWatchers(pack),
      maxPerSource: opts.maxPerSource ?? 50,
      onConfirmed: makeOnConfirmed(pack, opts.leads ?? neonLeadStore(), opts.net ?? liveNet),
    });
    return { summaries, spentThisRunUsd: llm.spent, spentTodayUsd: spentBefore + llm.spent, dailyCapUsd: opts.dailyCapUsd };
  } finally {
    // record spend even if the tick failed partway
    await usage.addSpend("haiku", llm.spent, opts.dailyCapUsd);
  }
}

/** Gate 2 bank: the pack's seed examples plus examples from your labelled posts. A DB problem means seeds only. */
export async function loadGate2Bank(pack: Pack): Promise<Exemplar[]> {
  const seeds: Exemplar[] = [
    ...pack.signals.gate2.seeds.pos.map((t) => ({ vec: featurize(t), label: "pos" as const })),
    ...pack.signals.gate2.seeds.neg.map((t) => ({ vec: featurize(t), label: "neg" as const })),
  ];
  try {
    const rows = await getDb().select({ text: exemplars.text, label: exemplars.label }).from(exemplars);
    return [...seeds, ...rows.map((r) => ({ vec: featurize(r.text), label: (r.label === "pos" ? "pos" : "neg") as "pos" | "neg" }))];
  } catch {
    return seeds;
  }
}
