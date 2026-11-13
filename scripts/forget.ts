/**
 * Delete a person's data everywhere (Neon, the leads Sheet, R2 backups) and suppress them.
 *   pnpm forget --name "Jane Doe" --domain acme.com
 *   pnpm forget --email jane@acme.com [--suppress-domain --domain acme.com]
 * Prints counts only.
 */
import "dotenv/config";
import { loadPack } from "@tell/config";
import { forgetPerson } from "@tell/ops";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const r = await forgetPerson({ name: arg("--name"), email: arg("--email"), domain: arg("--domain"), suppressDomain: process.argv.includes("--suppress-domain") }, await loadPack());
console.log(`forgot: people=${r.people} emails=${r.emails} stored_rows=${r.deliveryRows} sheet_cells=${r.sheetCells} backup_files=${r.backupFiles} suppressed=${r.suppressed}`);
