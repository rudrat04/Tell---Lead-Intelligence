/** Weekly: seed YC companies through the ICP filter and discover their job boards; then Keka/Freshteam tenants
 * from Common Crawl (India coverage). Counts only (public logs). Flags: --yc-only, --cc-only. */
import "dotenv/config";
import { loadPack } from "@tell/config";
import { runDiscovery, runCcDiscovery } from "@tell/pipeline";

const pack = await loadPack();
const args = process.argv.slice(2);

if (!args.includes("--cc-only")) {
  const r = await runDiscovery({ pack, maxSiteChecks: process.env.MAX_SITE_CHECKS ? Number(process.env.MAX_SITE_CHECKS) : undefined });
  console.log(`discovery: companies=${r.companies} fit=${r.fitPass} hiring_fit=${r.hiringFit} yc_boards_new=${r.ycBoardsNew} sites_checked=${r.siteChecked} ats_boards_found=${r.atsBoardsFound}`);
}

if (!args.includes("--yc-only")) {
  // never fail the weekly run on Common Crawl: the index is often slow or down
  try {
    const c = await runCcDiscovery({ pack, maxTenants: process.env.MAX_CC_TENANTS ? Number(process.env.MAX_CC_TENANTS) : undefined });
    const listed = Object.entries(c.perAts).map(([a, v]) => `${a}=${v.listed}${v.complete ? "" : "(partial)"}`).join(" ");
    console.log(`cc discovery: index=${c.index ?? "unavailable"} listed: ${listed || "none"} due=${c.due} checked=${c.checked} no_portal=${c.noPortal} no_roles=${c.noRoles} staffing=${c.staffing} unresolved=${c.unresolved} filtered=${c.filtered} resolved=${c.resolved} india=${c.india} gtm_roles=${c.withGtmRoles} boards_new=${c.boardsNew}`);
  } catch (e) {
    console.log(`cc discovery: failed (${(e as Error).name})`);
  }
}
