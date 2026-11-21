/** Touch-backs: follow-up drafts from new facts (Sheet "Follow-up") for past leads (5 days to the re-delivery window). The digest runs this itself; counts only. pnpm followups [--dry] [--show] */
import "dotenv/config";
import { loadPack } from "@tell/config";
import { runFollowups } from "@tell/deliver";
const pack = await loadPack();
const r = await runFollowups({ pack, dryRun: process.argv.includes("--dry") });
console.log(`followups: due=${r.due} no_new_fact=${r.noNewFact} touch_back=${r.touched.length} written=${r.written} failed=${r.failed} sheet_cells=${r.sheet}${r.skipped ? ` (${r.skipped})` : ""}`);
if (process.argv.includes("--show")) {
  if (process.env.CI) { console.error("--show is local only"); process.exit(1); }
  for (const x of r.samples ?? []) console.log(`\n--- ${x.company}\nnew fact: ${x.fact}\n${x.body}`);
}
