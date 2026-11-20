/** Follow-up drafts from new facts (Sheet "Follow-up"), for leads delivered 5-10 days ago. Counts only. pnpm followups [--dry] [--show] */
import "dotenv/config";
import { loadPack } from "@tell/config";
import { runFollowups } from "@tell/deliver";
const pack = await loadPack();
const r = await runFollowups({ pack, dryRun: process.argv.includes("--dry") });
console.log(`followups: due=${r.due} no_new_fact=${r.noNewFact} written=${r.written} failed=${r.failed} sheet_cells=${r.sheet}${r.skipped ? ` (${r.skipped})` : ""}`);
if (process.argv.includes("--show")) {
  if (process.env.CI) { console.error("--show is local only"); process.exit(1); }
  for (const x of r.samples ?? []) console.log(`\n--- ${x.company}\nnew fact: ${x.fact}\n${x.body}`);
}
