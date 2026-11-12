/**
 * Leads Sheet commands.
 *   pnpm sheet:setup <pack-dir>   create the Sheet (Leads + Gigs tabs) and save its id into <pack-dir>/delivery.yaml
 *                                 (then `pnpm pack:push <pack-dir> <prefix>` so the daily run uses it)
 *   pnpm sheet:sync               append pending lead rows + read your labels back (counts only: safe for CI)
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseDocument } from "yaml";
import { loadPack, loadPackFromDir } from "@tell/config";
import { createLeadsSheet, runSheetSync } from "@tell/deliver";

const [cmd, dir] = process.argv.slice(2);

if (cmd === "setup") {
  if (!dir) { console.error("usage: pnpm sheet:setup <pack-dir>"); process.exit(1); }
  if (process.env.CI) { console.error("sheet:setup is a one-time local command"); process.exit(1); }
  const packDir = resolve(dir);
  const pack = await loadPackFromDir(packDir);
  if (pack.delivery.sheet.spreadsheet_id) { console.error(`pack already has a sheet (${pack.delivery.sheet.spreadsheet_id}); remove it first to create a new one`); process.exit(1); }
  const s = await createLeadsSheet(`${pack.meta.name} leads`);
  const file = join(packDir, "delivery.yaml");
  const doc = parseDocument(readFileSync(file, "utf8"));
  doc.setIn(["sheet", "spreadsheet_id"], s.spreadsheetId);
  writeFileSync(file, doc.toString());
  console.log(`created: ${s.url}\nsaved spreadsheet_id to ${file}\nnext: pnpm pack:push ${dir} <your R2 prefix>`);
} else if (cmd === "sync") {
  const r = await runSheetSync(await loadPack());
  console.log(`sheet: appended=${r.appended} labels_synced=${r.labelsSynced}${r.skipped ? ` (skipped: ${r.skipped})` : ""}`);
} else {
  console.error("usage: pnpm sheet:setup <pack-dir> | pnpm sheet:sync");
  process.exit(1);
}
