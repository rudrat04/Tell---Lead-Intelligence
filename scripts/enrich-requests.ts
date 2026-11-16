/**
 * Answer "Find email" clicks (queued by the Worker) through Air Waterfall and write the results into the Sheet.
 * Dispatched by the Worker right after a click (enrich.yml); the daily run also picks up anything left.
 * Prints counts only (Actions logs are public).
 * Also fills a find-email link into older Sheet rows that have a contact but no email (empty cells only).
 *   pnpm enrich:requests
 */
import "dotenv/config";
import { loadPack } from "@tell/config";
import { runEnrichRequests, backfillEnrichLinks } from "@tell/deliver";

const pack = await loadPack();
const b = await backfillEnrichLinks(pack);
console.log(b.status === "skipped" ? `enrich links: skipped (${b.reason})` : `enrich links: ${b.cells} new Sheet links (${b.rows} rows without an email)`);
const r = await runEnrichRequests(pack);
console.log(r.status === "skipped"
  ? `enrich requests: skipped (${r.reason})`
  : `enrich requests: ${r.requests} queued, ${r.answered} answered ${JSON.stringify(r.byVerdict)}, ${r.credits} credits, ${r.sheetCells} Sheet cells`);
