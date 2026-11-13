/** Nightly upkeep: usage guard -> janitor (tight at 80%) -> backup to R2. Counts only (public logs). pnpm ops */
import "dotenv/config";
import { runUsageGuard, runJanitor, runBackup } from "@tell/ops";

const u = await runUsageGuard();
console.log(`usage: ${u.readings.map((r) => `${r.service}=${Math.round(r.pct * 100)}%`).join(" ")}${u.tight ? " (TIGHT: retention halved)" : ""}`);
const j = await runJanitor({ tight: u.tight });
console.log(`janitor: ${Object.entries(j.deleted).map(([k, v]) => `${k}=${v}`).join(" ")} compacted_signals=${j.compactedSignals} dropped_partitions=${j.droppedPartitions.length}`);
const b = await runBackup();
console.log(`backup: ${b.day} tables=${Object.keys(b.tables).length} rows=${Object.values(b.tables).reduce((a, n) => a + n, 0)} kb=${Math.round(b.bytes / 1024)} verified=${b.verified} pruned_days=${b.prunedDaily}${b.monthly ? " +monthly" : ""}`);
