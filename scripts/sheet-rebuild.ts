/**
 * One-time: rebuild the Leads tab in the current column order and drop rows that no longer match the ICP or the
 * score threshold (rows with an Outcome always stay). The old tab is kept as "Leads backup <date>".
 * Prints counts only.
 *   pnpm sheet:rebuild --dry   # counts, no writes
 *   pnpm sheet:rebuild
 */
import "dotenv/config";
import { loadPack } from "@tell/config";
import { rebuildLeadsSheet } from "@tell/deliver";

const dry = process.argv.includes("--dry");
const r = await rebuildLeadsSheet(await loadPack(), { dryRun: dry });
console.log(`sheet rebuild${dry ? " (dry run)" : ""}: rows=${r.rows} kept=${r.kept} (outcome kept ${r.keptForOutcome}) removed=${JSON.stringify(r.removed)}${r.backupTab ? ` backup tab="${r.backupTab}"` : ""}`);
