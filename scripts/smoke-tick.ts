/** Manual smoke test: one HN tick against real Neon + Haiku, capped at a few items. Usage: pnpm smoke [maxItems] */
import "dotenv/config";
import { fileURLToPath } from "node:url";
import { runTick, neonStore } from "@tell/pipeline";
import { hn } from "@tell/watchers";
import { HaikuClient } from "@tell/extract";
import { gate1, loadGate1Rules } from "@tell/intel";

const max = Number(process.argv[2] ?? 3);
const rules = loadGate1Rules(fileURLToPath(new URL("../config/signals.yaml", import.meta.url)));
const llm = new HaikuClient({ dailyCapUsd: 0.05 });
const out = await runTick({
  store: neonStore(),
  gates: { llm, gate1: (t) => gate1(t, rules.never, rules.required) },
  watchers: [hn],
  maxPerSource: max,
  defaultLookbackMs: 24 * 3_600_000,
});
console.log(JSON.stringify(out, null, 2));
console.log("haiku spend (est): $" + llm.spent.toFixed(4));
