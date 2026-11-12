/** Manual smoke test: one tick against real Neon + Haiku, capped at a few items per source. Usage: pnpm smoke [maxItems] */
import "dotenv/config";
import { loadPack } from "@tell/config";
import { runScheduledTick } from "@tell/pipeline";

const res = await runScheduledTick({
  pack: await loadPack(),
  dailyCapUsd: Number(process.env.HAIKU_DAILY_CAP_USD ?? 1),
  maxPerSource: Number(process.argv[2] ?? 3),
});
console.log(JSON.stringify(res, null, 2));
