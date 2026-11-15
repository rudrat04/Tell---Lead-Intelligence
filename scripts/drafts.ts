/**
 * Re-write the opener, email draft and LinkedIn message for every delivered lead with the current copy brief, and
 * update the Sheet (draft columns only; your labels are never touched).
 *   pnpm drafts:backfill [--dry] [--show] [--cap 3]
 * --dry: nothing written; --show: print a few drafts (local only, refuses in CI); --cap: USD of Haiku for this run.
 */
import "dotenv/config";
import { loadPack } from "@tell/config";
import { backfillDrafts } from "@tell/deliver";

const args = process.argv.slice(2);
const show = args.includes("--show");
if (show && process.env.CI) { console.error("--show prints lead details: local only"); process.exit(1); }
const capAt = args.indexOf("--cap");
const r = await backfillDrafts({ pack: await loadPack(), dryRun: args.includes("--dry"), capUsd: capAt >= 0 ? Number(args[capAt + 1]) : 3 });
const a = r.analyst;
console.log(`drafts: deliveries=${r.deliveries} scored=${r.scored} analyst fresh=${a.fresh} cached=${a.cached} failed=${a.failed} spent_usd=${a.spentUsd.toFixed(3)}${a.skipped ? ` (${a.skipped})` : ""}`);
console.log(`checked drafts: email=${r.drafts.email} linkedin=${r.drafts.linkedin}${r.sheet ? ` | sheet cells written: email=${r.sheet.email} opener=${r.sheet.opener} linkedin=${r.sheet.linkedin}` : ""}`);
if (show) for (const s of r.samples) console.log(`\n=== ${s.company}\n--- email\n${s.email || "(none)"}\n--- linkedin\n${s.linkedin || "(none)"}`);
