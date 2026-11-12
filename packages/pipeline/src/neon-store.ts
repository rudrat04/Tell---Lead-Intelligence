import { getDb, eq, inArray, rawItems, candidates, seenHashes, sources, runs } from "@tell/db";
import type { Store } from "./ingest.js";

/** Neon-backed store. Writes per source go through one `batch` call (one HTTP round trip, one short connection). */
export function neonStore(url = process.env.DATABASE_URL): Store {
  const db = getDb(url);

  return {
    async claimNewHashes(hashes) {
      if (hashes.length === 0) return new Set();
      const seen = await db.select({ h: seenHashes.contentHash }).from(seenHashes).where(inArray(seenHashes.contentHash, hashes));
      const seenSet = new Set(seen.map((s) => s.h));
      const fresh = hashes.filter((h) => !seenSet.has(h));
      if (fresh.length) await db.insert(seenHashes).values(fresh.map((contentHash) => ({ contentHash }))).onConflictDoNothing();
      return new Set(fresh);
    },

    async lastRunAt(sourceId) {
      const r = await db.select({ t: sources.lastRunAt }).from(sources).where(eq(sources.id, sourceId)).limit(1);
      return r[0]?.t ?? null;
    },

    async saveBatch(b) {
      const now = new Date();
      const rawRows = b.items.map(({ item, hash }) => ({
        id: crypto.randomUUID(),
        sourceId: item.sourceId,
        externalId: item.externalId,
        url: item.url,
        contentHash: hash,
      }));
      const ok = !b.error;
      const stmts = [
        db.insert(sources).values({ id: b.sourceId, kind: "watcher", healthy: ok, fallbackActive: b.usedFallback, lastRunAt: now })
          .onConflictDoUpdate({ target: sources.id, set: { healthy: ok, fallbackActive: b.usedFallback, lastRunAt: now } }),
        db.insert(runs).values({ task: `tick:${b.sourceId}`, idempotencyKey: `tick:${b.sourceId}:${now.toISOString()}`, status: ok ? "ok" : "error", yieldCount: b.fetched, error: b.error, finishedAt: now }),
      ] as const;
      const itemStmts = rawRows.length
        ? [
            db.insert(rawItems).values(rawRows),
            db.insert(candidates).values(
              b.items.map(({ result }, i) => ({
                rawItemId: rawRows[i]!.id,
                extractor: "post",
                output: result.status === "confirmed" ? result.extraction : null,
                gateResults: { status: result.status, log: result.log },
              })),
            ),
          ]
        : [];
      await db.batch([...stmts, ...itemStmts] as unknown as Parameters<typeof db.batch>[0]);
    },
  };
}
