/** Weekly: seed YC companies through the ICP filter and discover their job boards; then Keka/Freshteam tenants
 * from Common Crawl and Workable job search (India coverage). Counts only (public logs). Flags: --yc-only, --cc-only, --workable-only, --portfolios-only. */
import "dotenv/config";
import { loadPack } from "@tell/config";
import { runDiscovery, runCcDiscovery, runWorkableDiscovery, runPortfolioDiscovery } from "@tell/pipeline";

const pack = await loadPack();
const args = process.argv.slice(2);

const only = args.find((a) => a.endsWith("-only"));
if (!only || only === "--yc-only") {
  const r = await runDiscovery({ pack, maxSiteChecks: process.env.MAX_SITE_CHECKS ? Number(process.env.MAX_SITE_CHECKS) : undefined });
  console.log(`discovery: companies=${r.companies} fit=${r.fitPass} hiring_fit=${r.hiringFit} yc_boards_new=${r.ycBoardsNew} sites_checked=${r.siteChecked} ats_boards_found=${r.atsBoardsFound}`);
}

if (!only || only === "--cc-only") {
  // never fail the weekly run on Common Crawl: the index is often slow or down
  try {
    const c = await runCcDiscovery({ pack, maxTenants: process.env.MAX_CC_TENANTS ? Number(process.env.MAX_CC_TENANTS) : undefined });
    const listed = Object.entries(c.perAts).map(([a, v]) => `${a}=${v.listed}${v.complete ? "" : "(partial)"}`).join(" ");
    console.log(`cc discovery: index=${c.index ?? "unavailable"} listed: ${listed || "none"} due=${c.due} checked=${c.checked} no_portal=${c.noPortal} no_roles=${c.noRoles} staffing=${c.staffing} unresolved=${c.unresolved} filtered=${c.filtered} resolved=${c.resolved} india=${c.india} gtm_roles=${c.withGtmRoles} boards_new=${c.boardsNew}`);
  } catch (e) {
    console.log(`cc discovery: failed (${(e as Error).name})`);
  }
}

if (!only || only === "--workable-only") {
  try {
    const w = await runWorkableDiscovery({ pack });
    console.log(`workable discovery: queries=${w.queries} hits=${w.hits} companies=${w.companies} due=${w.due} checked=${w.checked} no_website=${w.noWebsite} bad_site=${w.badSite} no_board=${w.noBoard} staffing=${w.staffing} not_region=${w.notRegion} filtered=${w.filtered} resolved=${w.resolved} india=${w.india} gtm_roles=${w.withGtmRoles} boards_new=${w.boardsNew}`);
  } catch (e) {
    console.log(`workable discovery: failed (${(e as Error).name})`);
  }
}

if (!only || only === "--portfolios-only") {
  try {
    const p = await runPortfolioDiscovery({ pack });
    console.log(`portfolio discovery: sources=${p.sources} listed=${p.listed} due=${p.due} checked=${p.checked} no_website=${p.noWebsite} bad_site=${p.badSite} filtered=${p.filtered} accounts_new=${p.accountsNew} with_board=${p.withBoard} india=${p.india}`);
  } catch (e) {
    console.log(`portfolio discovery: failed (${(e as Error).name})`);
  }
}
