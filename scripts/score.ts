/**
 * Daily scoring run.
 *   pnpm score              score + write (counts only: safe for public Actions logs)
 *   pnpm score --dry        don't write
 *   pnpm score --show       also print the ranked leads (local only; refused in CI because the logs are public)
 */
import "dotenv/config";
import { loadPack } from "@tell/config";
import { runScoring } from "@tell/pipeline";

const dry = process.argv.includes("--dry");
const show = process.argv.includes("--show");
if (show && process.env.CI) {
  console.error("--show prints lead details; refused in CI (public logs)");
  process.exit(1);
}

const r = await runScoring({ pack: await loadPack(), write: !dry });
const lanes = r.ranking.leads.reduce((m, l) => ((m[l.score.lane] = (m[l.score.lane] ?? 0) + 1), m), {} as Record<string, number>);
console.log(`scoring: config=${r.configVersion} scored=${r.scored} eligible=${r.eligible} leads=${r.ranking.leads.length} (fast=${lanes.fast ?? 0} combined=${lanes.combined ?? 0}) watchlist=${r.ranking.watchlist.length} person_leads=${r.personLeads.length} held_incomplete=${r.ranking.held.incomplete} held_recent=${r.ranking.held.recentlyDelivered} plays=${r.playsMatched} critic_dropped=${JSON.stringify(r.criticDropped)}${dry ? " (dry run)" : ""}`);

if (show) {
  const line = (l: (typeof r.ranking.leads)[number], i: number) => {
    const s = l.score;
    const plays = s.plays.map((p) => p.title).join(", ") || "-";
    const why = s.drivers.slice(0, 3).map((e) => `${e.type}: "${e.quote}"${e.current ? "" : ` (${Math.round(e.ageDays)}d)`}`).join(" | ");
    return `${String(i + 1).padStart(2)}. ${l.account.name ?? l.account.domain} (${l.account.domain}) [${l.account.sizeBand ?? "?"}, ${l.account.segment ?? "?"}, ${l.account.region ?? "?"}]\n` +
      `    priority=${s.priority.toFixed(3)} intent=${s.intent.toFixed(2)} fit=${s.fit.toFixed(2)} timing=${s.timing.toFixed(2)} lane=${s.lane}\n    plays: ${plays}\n    why: ${why}`;
  };
  console.log("\nTOP LEADS"); r.ranking.leads.forEach((l, i) => console.log(line(l, i)));
  console.log("\nWATCHLIST"); r.ranking.watchlist.forEach((l, i) => console.log(line(l, i)));
}
