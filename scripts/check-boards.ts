/** Daily: diff every tracked job board into jobs + signals. Counts only (public logs). */
import "dotenv/config";
import { loadPack } from "@tell/config";
import { runBoardCheck } from "@tell/pipeline";

const r = await runBoardCheck({
  pack: await loadPack(),
  maxBoards: process.env.MAX_BOARDS ? Number(process.env.MAX_BOARDS) : undefined,
});
const sig = Object.entries(r.signals).map(([k, v]) => `${k}=${v}`).join(" ") || "none";
console.log(`boards: total=${r.boards} checked=${r.checked} failed=${r.failed} host_down=${r.hostDown} suspect=${r.suspect} baselines=${r.baselines} new_roles=${r.newRoles} closed=${r.closedRoles}`);
console.log(`signals: ${sig}`);
if (r.boards > 0 && r.failed + r.hostDown === r.boards) process.exit(1);
