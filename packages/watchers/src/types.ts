import { z } from "zod";

/** A raw item as fetched by any watcher, before the precision cascade. */
export const RawItemSchema = z.object({
  sourceId: z.string(),
  externalId: z.string(),
  url: z.string().url(),
  title: z.string().optional(),
  text: z.string(),
  author: z.string().optional(),
  postedAt: z.coerce.date().optional(),
  meta: z.record(z.string(), z.unknown()).default({}),
});
export type RawItem = z.infer<typeof RawItemSchema>;

export interface Watcher {
  id: string;
  /** Primary fetch. Throw on failure so the runner can switch to the fallback. */
  fetch(since: Date): Promise<RawItem[]>;
  /** Automatic fallback when the primary fails (plan 5d). */
  fallback?(since: Date): Promise<RawItem[]>;
}

export interface WatcherResult {
  sourceId: string;
  items: RawItem[];
  usedFallback: boolean;
  error?: string;
}

export async function runWatcher(w: Watcher, since: Date): Promise<WatcherResult> {
  try {
    return { sourceId: w.id, items: await w.fetch(since), usedFallback: false };
  } catch (primaryErr) {
    if (!w.fallback) return { sourceId: w.id, items: [], usedFallback: false, error: String(primaryErr) };
    try {
      return { sourceId: w.id, items: await w.fallback(since), usedFallback: true };
    } catch (fbErr) {
      return { sourceId: w.id, items: [], usedFallback: true, error: String(fbErr) };
    }
  }
}
