/**
 * Weekly self-tuning proposals (never applied automatically). Counts only by default (Actions logs are public);
 * --show prints the proposed values locally and refuses to run in CI (likelihood ratios are private pack content).
 *   pnpm tune [--show] [--dry]
 */
import "dotenv/config";
import { loadPack } from "@tell/config";
import { runTuning } from "@tell/pipeline";

const show = process.argv.includes("--show"), dry = process.argv.includes("--dry");
if (show && process.env.CI) { console.error("--show prints pack values: run it locally, not in CI"); process.exit(1); }
const r = await runTuning({ pack: await loadPack(), write: !dry });
console.log(`tuning: labelled=${r.labelled} proposals=${r.proposals.length} recorded=${r.recorded} champion=${r.champion.agreement} challenger=${r.challenger.agreement} pairs=${r.champion.pairs}${r.skipped ? ` (skipped: ${r.skipped})` : ""}`);
if (show) for (const p of r.proposals) console.log(`  ${p.type}: lr ${p.before} -> ${p.after} (${p.reason})`);
if (show && r.proposals.length) console.log(`\nTo adopt: edit the lr values in your pack's signals.yaml, then pnpm pack:push. Adopt only if challenger > champion.`);
