import { runWatcher, contentHash, type RawItem, type Watcher } from "@tell/watchers";
import { runCascade, type CascadeResult, type GateDeps, type PostExtraction } from "@tell/extract";

/** Persistence boundary, so the tick is testable without a database. */
export interface Store {
  /** Returns the subset of hashes not seen before (90-day dedupe). Read-only. */
  filterUnseen(hashes: string[]): Promise<Set<string>>;
  /** Saves processed items and marks only those as seen. */
  saveBatch(batch: {
    sourceId: string;
    usedFallback: boolean;
    error?: string;
    /** true when new items were left unprocessed (per-tick cap or spend cap), so the window must be re-fetched */
    incomplete: boolean;
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
  /** resolve + persist a confirmed item; returns where it landed */
  onConfirmed?: (item: RawItem, extraction: PostExtraction) => Promise<"account" | "person" | "unresolved">;
}

export interface TickSummary {
  sourceId: string;
  fetched: number;
  newItems: number;
  confirmed: number;
  rejected: number;
  uncertain: number;
  /** confirmed items resolved to an account / kept as a person lead / neither */
  account: number;
  person: number;
  unresolved: number;
  recordErrors: number;
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
    const fresh = await deps.store.filterUnseen(hashed.map((h) => h.hash));
    const allFresh = [...new Map(hashed.filter((h) => fresh.has(h.hash)).map((h) => [h.hash, h])).values()];
    const todo = allFresh.slice(0, deps.maxPerSource ?? 50);

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
    const incomplete = processed.length < allFresh.length;
    await deps.store.saveBatch({ sourceId: w.id, usedFallback: res.usedFallback, error: res.error, incomplete, fetched: res.items.length, items: processed });

    // Entity resolution + signal writes for confirmed items, while the post text is still in memory.
    const outcomes = { account: 0, person: 0, unresolved: 0, recordErrors: 0 };
    if (deps.onConfirmed) {
      for (const p of processed) {
        if (p.result.status !== "confirmed") continue;
        try {
          outcomes[await deps.onConfirmed(p.item, p.result.extraction)]++;
        } catch {
          outcomes.recordErrors++; // never fatal: the rest of the tick still runs
        }
      }
    }

    const count = (s: CascadeResult["status"]) => processed.filter((p) => p.result.status === s).length;
    out.push({ sourceId: w.id, fetched: res.items.length, newItems: allFresh.length, confirmed: count("confirmed"), rejected: count("rejected"), uncertain: count("uncertain"), ...outcomes, usedFallback: res.usedFallback, error: res.error });
  }
  return out;
}
