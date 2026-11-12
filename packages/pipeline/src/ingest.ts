import { runWatcher, contentHash, type RawItem, type Watcher } from "@tell/watchers";
import { runCascade, type CascadeResult, type GateDeps } from "@tell/extract";

/** Persistence boundary, so the tick is testable without a database. */
export interface Store {
  /** Returns the subset of hashes not seen before and records them (90-day dedupe). */
  claimNewHashes(hashes: string[]): Promise<Set<string>>;
  saveBatch(batch: {
    sourceId: string;
    usedFallback: boolean;
    error?: string;
    fetched: number;
    items: { item: RawItem; hash: string; result: CascadeResult }[];
  }): Promise<void>;
  lastRunAt(sourceId: string): Promise<Date | null>;
}

export interface TickDeps {
  store: Store;
  gates: GateDeps;
  watchers: Watcher[];
  /** max items per source per tick sent through the cascade (cost guard) */
  maxPerSource?: number;
  defaultLookbackMs?: number;
}

export interface TickSummary {
  sourceId: string;
  fetched: number;
  newItems: number;
  confirmed: number;
  rejected: number;
  uncertain: number;
  usedFallback: boolean;
  error?: string;
}

/** One 30-minute tick: fetch -> skip seen content (before any parsing/LLM) -> cascade -> save in one batch per source. */
export async function runTick(deps: TickDeps): Promise<TickSummary[]> {
  const out: TickSummary[] = [];
  for (const w of deps.watchers) {
    const since = (await deps.store.lastRunAt(w.id)) ?? new Date(Date.now() - (deps.defaultLookbackMs ?? 3_600_000));
    const res = await runWatcher(w, since);
    const hashed = res.items.map((item) => ({ item, hash: contentHash(`${item.sourceId}:${item.externalId}:${item.text}`) }));
    const fresh = await deps.store.claimNewHashes(hashed.map((h) => h.hash));
    const todo = hashed.filter((h) => fresh.has(h.hash)).slice(0, deps.maxPerSource ?? 50);

    const processed: { item: RawItem; hash: string; result: CascadeResult }[] = [];
    for (const { item, hash } of todo) {
      try {
        processed.push({ item, hash, result: await runCascade(deps.gates, item.text) });
      } catch (e) {
        // e.g. daily spend cap reached: stop spending, keep what we have
        res.error = res.error ?? String(e);
        break;
      }
    }
    await deps.store.saveBatch({ sourceId: w.id, usedFallback: res.usedFallback, error: res.error, fetched: res.items.length, items: processed });
    const count = (s: CascadeResult["status"]) => processed.filter((p) => p.result.status === s).length;
    out.push({ sourceId: w.id, fetched: res.items.length, newItems: todo.length, confirmed: count("confirmed"), rejected: count("rejected"), uncertain: count("uncertain"), usedFallback: res.usedFallback, error: res.error });
  }
  return out;
}
