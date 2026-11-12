/** Weekly account watch: funding/launches (YC pages), website changes, tools (site + DNS). Counts only (public logs). */
import "dotenv/config";
import { loadPack } from "@tell/config";
import { runAccountWatch } from "@tell/pipeline";

const limit = process.env.WATCH_LIMIT ? Number(process.env.WATCH_LIMIT) : undefined;
const r = await runAccountWatch({ pack: await loadPack(), limit });
const sig = Object.entries(r.signals).map(([k, v]) => `${k}=${v}`).join(" ") || "none";
console.log(`watch: accounts=${r.accounts} yc_pages=${r.ycPages} sites=${r.sites} dns=${r.dns} baselines(site=${r.baselines.site} dns=${r.baselines.dns}) people=${r.peopleSaved} failures(yc=${r.failures.yc} site=${r.failures.site} dns=${r.failures.dns})`);
console.log(`signals: ${sig}`);
