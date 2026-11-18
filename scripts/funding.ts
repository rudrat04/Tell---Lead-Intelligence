/** Daily funding-news discovery: freshly funded companies (headlines) become accounts once their website is proven. Counts only (public logs). pnpm funding */
import "dotenv/config";
import { loadPack } from "@tell/config";
import { runFundingDiscovery } from "@tell/pipeline";

const pack = await loadPack();
const r = await runFundingDiscovery({ pack });
if (r.skipped) { console.log(`funding: skipped (${r.skipped})`); process.exit(0); }
console.log(`funding: searches=${r.searches} errors=${r.errors} headlines=${r.headlines} companies=${r.companies} new_names=${r.fresh} looked_up=${r.looked}`);
console.log(`  no_match=${r.noMatch} not_region=${r.notRegion} bad_site=${r.badSite} filtered=${r.filtered} resolved=${r.resolved} accounts_new=${r.accountsNew}`);
if (r.searches > 0 && r.errors === r.searches) process.exit(1);
