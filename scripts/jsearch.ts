/** Daily JSearch run (Google for Jobs via RapidAPI): companies hiring the pack's roles. Counts only (public logs). pnpm jsearch */
import "dotenv/config";
import { loadPack } from "@tell/config";
import { runJSearch } from "@tell/pipeline";
import { jsearchProvider } from "@tell/watchers";

if (!jsearchProvider()) { console.log("jsearch: skipped (JSEARCH_API_KEY / RAPIDAPI_KEY not set)"); process.exit(0); }
const pack = await loadPack();
if (!pack.sources.jsearch.enabled) { console.log("jsearch: disabled in the pack"); process.exit(0); }
const r = await runJSearch({ pack });
console.log(`jsearch: via=${jsearchProvider()!.kind} requests=${r.requests} errors=${r.errors} month_used=${r.monthUsed}/${pack.sources.jsearch.per_month} hits=${r.hits} role_hits=${r.roleHits} employers=${r.employers} cached=${r.cached}`);
console.log(`  no_website=${r.noWebsite} bad_site=${r.badSite} staffing=${r.staffing} not_region=${r.notRegion} filtered=${r.filtered} resolved=${r.resolved} india=${r.india} own_boards=${r.ownBoards} jobs_seen=${r.jobsSeen} jobs_closed=${r.jobsClosed}`);
if (r.requests > 0 && r.errors === r.requests) process.exit(1);
