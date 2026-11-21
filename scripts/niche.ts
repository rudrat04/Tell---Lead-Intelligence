/**
 * Niche public-record discovery (pack sources.niche): FDA shortages x ANDA holders, expiring federal contracts, new
 * Medicare-certified providers. Counts only (Actions logs are public).
 *   pnpm niche [fda|govcon|cms|510k|anda|awards|formd|nppes|sam|recalls|news|trials|socrata|keyword]   (no argument = every enabled source)
 *   pnpm niche stats                                  (resolve rate per source, queue, spend, contact coverage)
 *   pnpm niche drain                                  (every tick: look up queued companies within the daily budget)
 *   pnpm niche dmf <dmf-list.csv>                     (FDA's DMF list saved as CSV x the shortage list; local only)
 *   pnpm niche import <file.csv> [--region India] [--segment pharma]   (local only: your own exports, e.g. GeM / RERA / customs)
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { fetchShortages } from "@tell/watchers";
import { loadPack } from "@tell/config";
import { runFdaShortage, runUsaSpending, runCmsNewProviders, runFda510k, runAndaApprovals, runNewAwards, runFormD, runSocrata,
  runNppes, runSamEntities, runRecalls, runNewsEvents, runClinicalTrials, runKeywordAwards, drainNicheQueue, dmfRecords, nicheStats, persistNicheRecords, parseCsv, importRecords, type NicheResult } from "@tell/pipeline";

const pack = await loadPack();
const [cmd, file] = process.argv.slice(2);
const flag = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] ?? d : d; };
const line = (r: NicheResult) => r.skipped ? `${r.source}: skipped (${r.skipped})`
  : `${r.source}: records=${r.records} contacts=${r.contacts ?? 0} companies=${r.companies} looked_up=${r.looked} resolved=${r.resolved} accounts_new=${r.accountsNew} signals=${r.signals} no_match=${r.noMatch} not_region=${r.notRegion} filtered=${r.filtered} bad_site=${r.badSite} capped=${r.capped} errors=${r.errors}`;

if (cmd === "stats") {
  const st = await nicheStats();
  console.log("names looked up per source (proven = became an account):");
  for (const x of st.sources) console.log(`  ${x.source.padEnd(28)} ${String(x.lookedUp).padStart(5)} looked up  ${String(x.proven).padStart(4)} proven  ${(x.rate * 100).toFixed(0)}%`);
  console.log(`queue: ${st.queued} names waiting (${st.queue.slice(0, 6).map((q) => `${q.source.replace(/^niche:/, "")} ${q.n}`).join(", ")})`);
  console.log(`spend, last 7 days: ${Object.entries(st.spend7d).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
  console.log(`named contacts on delivered leads (30 days): ${st.contacts.map((c) => `${c.segment} ${c.named}/${c.delivered}`).join(", ") || "no deliveries yet"}`);
  console.log(`your last import (pnpm niche import): ${st.daysSinceImport == null ? "never" : `${st.daysSinceImport} days ago`}`);
  // coverage: every industry should have companies with a fresh signal it counts
  const { getDb, sql } = await import("@tell/db");
  const cov = (await getDb().execute(sql`select a.segment, count(distinct a.id)::int as accounts,
      count(distinct s.account_id) filter (where s.observed_at > now() - interval '30 days')::int as fresh
    from accounts a left join signals s on s.account_id = a.id where a.status = 'active' and a.segment is not null group by 1`)).rows as { segment: string; accounts: number; fresh: number }[];
  const by = new Map(cov.map((c) => [c.segment, c]));
  console.log("coverage per industry (companies / with a signal in 30 days):");
  for (const [seg, ind] of Object.entries(pack.icp.industries)) {
    if (ind.excluded) continue;
    const c = by.get(seg);
    console.log(`  ${seg.padEnd(20)} ${String(c?.accounts ?? 0).padStart(5)} / ${String(c?.fresh ?? 0).padStart(4)}${!c?.fresh ? "  <- nothing fresh" : ""}`);
  }
  process.exit(0);
}
if (cmd === "drain") {
  const r = await drainNicheQueue({ pack });
  console.log(`${line(r)} still_queued=${r.queued} dropped_old=${r.dropped}`);
  process.exit(0);
}
if (cmd === "dmf") {
  if (process.env.CI) { console.error("niche dmf is local only"); process.exit(1); }
  if (!file) { console.error("usage: pnpm niche dmf <dmf-list.csv> (FDA's DMF list xlsx, saved as CSV)"); process.exit(1); }
  const recs = dmfRecords(parseCsv(readFileSync(file, "utf8")), await fetchShortages(), new Date());
  const r = await persistNicheRecords(recs, { pack }, { source: "fda_dmf", records: 0, companies: 0, looked: 0, resolved: 0, accountsNew: 0, signals: 0, noMatch: 0, notRegion: 0, filtered: 0, badSite: 0, capped: 0, errors: 0 });
  console.log(`${line(r)} (capped names are queued: pnpm niche drain)`);
  process.exit(0);
}
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
  "510k": () => runFda510k({ pack }), anda: () => runAndaApprovals({ pack }), awards: () => runNewAwards({ pack }), formd: () => runFormD({ pack }),
  nppes: () => runNppes({ pack }), sam: () => runSamEntities({ pack }), recalls: () => runRecalls({ pack }), news: () => runNewsEvents({ pack }),
  trials: () => runClinicalTrials({ pack }),
};
let failed = 0;
for (const [name, run] of Object.entries(runs)) {
  if (cmd && cmd !== name) continue;
  try { const r = await run(); console.log(line(r)); if (!r.skipped && r.records === 0 && r.errors > 0) failed++; }
  catch (e) { console.log(`${name}: failed (${(e as Error).message.slice(0, 120)})`); failed++; }
}
if (!cmd || cmd === "keyword") {
  try { for (const r of await runKeywordAwards({ pack })) { console.log(line(r)); if (!r.skipped && r.records === 0 && r.errors > 0) failed++; } }
  catch (e) { console.log(`keyword awards: failed (${(e as Error).message.slice(0, 120)})`); failed++; }
}
if (!cmd || cmd === "socrata") {
  try { for (const r of await runSocrata({ pack })) { console.log(line(r)); if (!r.skipped && r.records === 0 && r.errors > 0) failed++; } }
  catch (e) { console.log(`socrata: failed (${(e as Error).message.slice(0, 120)})`); failed++; }
}
process.exit(failed ? 1 : 0);
