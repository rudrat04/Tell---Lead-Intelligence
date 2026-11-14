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

/**
 * A posting date only if it's believable: ATS APIs send placeholders for "no date" (Keka: 0001-01-01, .NET's
 * DateTime.MinValue), and an epoch or future date would make a role look years old or not yet posted.
 */
export function postedDate(v: string | number | Date | null | undefined, now = new Date()): Date | undefined {
  if (v == null || v === "") return undefined;
  const d = v instanceof Date ? v : new Date(v);
  const t = d.getTime();
  if (Number.isNaN(t) || d.getUTCFullYear() < 2000 || t > now.getTime() + 86_400_000) return undefined;
  return d;
}
