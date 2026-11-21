/**
 * Answer "Create draft" clicks (Telegram button / Sheet link, queued by the Worker): one checked opening email per
 * click, written into the Sheet's "Email draft" cell and sent to Telegram. Dispatched by the Worker (drafts.yml).
 * Prints counts only (Actions logs are public).
 *   pnpm drafts:requests
 */
import "dotenv/config";
import { loadPack } from "@tell/config";
import { runDraftRequests } from "@tell/deliver";

const r = await runDraftRequests(await loadPack());
console.log(r.status === "skipped" ? `draft requests: skipped (${r.reason})` : `draft requests: ${r.requests} queued, ${r.written} written, ${r.cached} already written, ${r.failed} failed the checks`);
