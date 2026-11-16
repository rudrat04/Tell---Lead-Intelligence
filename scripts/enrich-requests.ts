/**
 * Answer "Find email" clicks (queued by the Worker) through Air Waterfall and write the results into the Sheet.
 * Dispatched by the Worker right after a click (enrich.yml); the daily run also picks up anything left.
 * Prints counts only (Actions logs are public).
 *   pnpm enrich:requests
 */
import "dotenv/config";
import { loadPack } from "@tell/config";
import { runEnrichRequests } from "@tell/deliver";

const r = await runEnrichRequests(await loadPack());
console.log(r.status === "skipped"
  ? `enrich requests: skipped (${r.reason})`
  : `enrich requests: ${r.requests} queued, ${r.answered} answered ${JSON.stringify(r.byVerdict)}, ${r.credits} credits, ${r.sheetCells} Sheet cells`);
