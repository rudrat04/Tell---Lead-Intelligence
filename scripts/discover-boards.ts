/** Weekly: seed YC companies through the ICP filter and discover their job boards. Counts only (public logs). */
import "dotenv/config";
import { loadPack } from "@tell/config";
import { runDiscovery } from "@tell/pipeline";

const r = await runDiscovery({
  pack: await loadPack(),
  maxSiteChecks: process.env.MAX_SITE_CHECKS ? Number(process.env.MAX_SITE_CHECKS) : undefined,
});
console.log(`discovery: companies=${r.companies} fit=${r.fitPass} hiring_fit=${r.hiringFit} yc_boards_new=${r.ycBoardsNew} sites_checked=${r.siteChecked} ats_boards_found=${r.atsBoardsFound}`);
