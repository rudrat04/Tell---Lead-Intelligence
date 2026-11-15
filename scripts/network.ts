/**
 * Your own network, imported locally into Neon (never committed, never run in CI: it holds other people's names).
 *   pnpm network connections <Connections.csv>   LinkedIn export (Settings > Data privacy > Get a copy of your data); emails are dropped
 *   pnpm network clients <clients.csv>           past clients: columns name, company[, title, linkedin]; watched for job moves
 *   pnpm network employers "Contoso:contoso.com, Fabrikam"   your own past employers (shared-employer warm path)
 *   pnpm network stats                           counts only
 *   pnpm network champions                       run the champion watch now (also weekly in boards.yml)
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { loadPack } from "@tell/config";
import { parseLinkedInConnections, parseClients } from "@tell/people";
import { importNetwork, runChampionWatch } from "@tell/pipeline";
import { getDb, networkContacts, sql } from "@tell/db";

const [cmd, arg] = process.argv.slice(2);
const local = () => { if (process.env.CI) { console.error("network import is local only (it holds other people's names; Actions logs are public)"); process.exit(1); } };

if (cmd === "connections" && arg) {
  local();
  const rows = parseLinkedInConnections(readFileSync(arg, "utf8"));
  const r = await importNetwork("connection", rows);
  console.log(`connections: ${r.before} -> ${r.after} (${rows.filter((x) => x.company).length} with a company)`);
} else if (cmd === "clients" && arg) {
  local();
  const r = await importNetwork("client", parseClients(readFileSync(arg, "utf8")));
  console.log(`clients: ${r.before} -> ${r.after}`);
} else if (cmd === "employers" && arg) {
  local();
  const rows = arg.split(",").map((x) => x.trim()).filter(Boolean).map((x) => {
    const [name, domain] = x.split(":").map((y) => y.trim());
    return { kind: "employer" as const, fullName: name!, company: domain || name!, position: null, profileUrl: null };
  });
  const r = await importNetwork("employer", rows);
  console.log(`employers: ${r.before} -> ${r.after}`);
} else if (cmd === "stats") {
  const rows = (await getDb().execute(sql`select kind, count(*)::int as n, count(moved_at)::int as moved from ${networkContacts} group by kind order by kind`)).rows as { kind: string; n: number; moved: number }[];
  console.log(rows.map((r) => `${r.kind}=${r.n}${r.kind === "client" ? ` (moved ${r.moved})` : ""}`).join(" ") || "nothing imported");
} else if (cmd === "champions") {
  const r = await runChampionWatch({ pack: await loadPack() });
  console.log(`champions: checked=${r.checked} moved=${r.moved} matched_accounts=${r.matchedAccounts}${r.skipped ? ` (${r.skipped})` : ""}`);
} else {
  console.error('usage: pnpm network connections <file.csv> | clients <file.csv> | employers "Name:domain, ..." | stats | champions');
  process.exit(1);
}
