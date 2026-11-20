/**
 * Niche public-record discovery (pack sources.niche): FDA shortages x ANDA holders, expiring federal contracts, new
 * Medicare-certified providers. Counts only (Actions logs are public).
 *   pnpm niche [fda|govcon|cms]                       (no argument = every enabled source)
 *   pnpm niche import <file.csv> [--region India] [--segment pharma]   (local only: your own exports, e.g. GeM / RERA / customs)
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { loadPack } from "@tell/config";
import { runFdaShortage, runUsaSpending, runCmsNewProviders, persistNicheRecords, parseCsv, importRecords, type NicheResult } from "@tell/pipeline";

const pack = await loadPack();
const [cmd, file] = process.argv.slice(2);
const flag = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] ?? d : d; };
const line = (r: NicheResult) => r.skipped ? `${r.source}: skipped (${r.skipped})`
  : `${r.source}: records=${r.records} companies=${r.companies} looked_up=${r.looked} resolved=${r.resolved} accounts_new=${r.accountsNew} signals=${r.signals} no_match=${r.noMatch} not_region=${r.notRegion} filtered=${r.filtered} bad_site=${r.badSite} capped=${r.capped} errors=${r.errors}`;

if (cmd === "import") {
  if (process.env.CI) { console.error("niche import is local only (your exports never go through CI)"); process.exit(1); }
  if (!file) { console.error("usage: pnpm niche import <file.csv> [--region India] [--segment pharma]"); process.exit(1); }
  const { records, skipped } = importRecords(parseCsv(readFileSync(file, "utf8")), pack, { region: flag("region", "India"), segment: flag("segment", "manufacturing") });
  const r = await persistNicheRecords(records, { pack }, { source: "niche_import", records: 0, companies: 0, looked: 0, resolved: 0, accountsNew: 0, signals: 0, noMatch: 0, notRegion: 0, filtered: 0, badSite: 0, capped: 0, errors: 0 });
  console.log(`${line(r)} rows_skipped=${skipped}`);
  process.exit(0);
}

const runs: Record<string, () => Promise<NicheResult>> = {
  fda: () => runFdaShortage({ pack }), govcon: () => runUsaSpending({ pack }), cms: () => runCmsNewProviders({ pack }),
};
let failed = 0;
for (const [name, run] of Object.entries(runs)) {
  if (cmd && cmd !== name) continue;
  try { const r = await run(); console.log(line(r)); if (!r.skipped && r.records === 0 && r.errors > 0) failed++; }
  catch (e) { console.log(`${name}: failed (${(e as Error).message.slice(0, 120)})`); failed++; }
}
process.exit(failed ? 1 : 0);
