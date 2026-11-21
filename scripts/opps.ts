/**
 * Opportunity-led leads (pack opportunities.yaml): the event first, then the companies that can benefit from it.
 *   pnpm opps                    rosters (when due) -> events -> matches -> rank -> people -> Telegram + Sheet (once per IST day)
 *   pnpm opps roster|events|match   one collection step only (no delivery)
 *   pnpm opps --dry [--show]     everything but delivery; --show prints the leads (local only: lead names never go to CI logs)
 *   pnpm opps --test             sends to Telegram with [TEST], no buttons, records nothing
 *   pnpm opps --force            re-read rosters and events now (they normally refresh every refresh_days)
 *   pnpm opps import <roster> <file.csv>   your own list into a roster (name, website, region, description; local only)
 * Prints counts only (Actions logs are public).
 */
import "dotenv/config";
import { loadPack } from "@tell/config";
import { runOpportunityDigest } from "@tell/deliver";

const args = process.argv.slice(2);
if (args[0] === "import") {
  if (process.env.CI) { console.error("opps import is local only (your lists never go through CI)"); process.exit(1); }
  const [, roster, file] = args;
  const { readFileSync } = await import("node:fs");
  const { importRoster, parseCsv } = await import("@tell/pipeline");
  const p = await loadPack();
  const r = roster ? p.opportunities.rosters[roster] : undefined;
  if (!r || !file) { console.error(`usage: pnpm opps import <roster> <file.csv> (rosters: ${Object.keys(p.opportunities.rosters).join(", ")})`); process.exit(1); }
  const res = await importRoster(roster!, r, parseCsv(readFileSync(file, "utf8")));
  console.log(`imported ${res.members} companies into ${roster} (${res.skipped} rows without a name or website); they resolve on the next pnpm opps`);
  process.exit(0);
}
const has = (f: string) => args.includes(f);
if ((has("--show") || has("--test")) && process.env.CI) { console.error("--show / --test print or send lead details: local only"); process.exit(1); }
const only = (["roster", "events", "match"] as const).find((c) => args.includes(c));
const pack = await loadPack();
const r = await runOpportunityDigest({ pack, dryRun: has("--dry") || has("--show"), test: has("--test"), only, skipCollect: has("--no-collect"), force: has("--force") });
const { shown, ...counts } = r;
console.log(JSON.stringify(counts, null, 2));
if (has("--show") && shown) {
  for (const l of shown) {
    console.log(`\n${l.score.line}  ${l.account.name ?? l.account.domain} (${l.account.domain})  [${l.opportunity.label}]`);
    console.log(`  reach: ${l.contact ? `${l.contact.person.name}, ${l.contact.person.role ?? "?"}${l.contact.person.email ? ` <${l.contact.person.email.address}> ${l.contact.person.email.status}` : ""}` : "nobody"}`);
    for (const e of l.events.slice(0, 3)) console.log(`  - ${e.quote}\n    fits: ${e.reasons.join("; ")}\n    ${e.url}`);
    for (const e of l.evidence.slice(0, 2)) console.log(`  record: ${e.quote}`);
  }
}
