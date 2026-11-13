/** Weekly account watch: funding/launches (YC pages), website changes, tools (site + DNS). Counts only (public logs). */
import "dotenv/config";
import { loadPack } from "@tell/config";
import { runAccountWatch } from "@tell/pipeline";

const limit = process.env.WATCH_LIMIT ? Number(process.env.WATCH_LIMIT) : undefined;
const r = await runAccountWatch({ pack: await loadPack(), limit });
const sig = Object.entries(r.signals).map(([k, v]) => `${k}=${v}`).join(" ") || "none";
console.log(`watch: accounts=${r.accounts} yc_pages=${r.ycPages} sites=${r.sites} dns=${r.dns} baselines(site=${r.baselines.site} dns=${r.baselines.dns}) people=${r.peopleSaved} failures(yc=${r.failures.yc} site=${r.failures.site} dns=${r.failures.dns})`);
console.log(`signals: ${sig}`);

// infrastructure + filings (#8 subdomains, #9 lookalike sending domains, #10 SEC Form D): counts only
try {
  const { runInfraWatch } = await import("@tell/pipeline");
  const i = await runInfraWatch({ pack: await loadPack() });
  console.log(`infra: ct checked=${i.ct.checked} baselines=${i.ct.baselines} failed=${i.ct.failed} | lookalike checked=${i.lookalike.checked} baselines=${i.lookalike.baselines} | form_d filings=${i.formD.filings} matched=${i.formD.matched}${i.formD.skipped ? ` (${i.formD.skipped})` : ""} | signals: ${Object.entries(i.signals).map(([k, v]) => `${k}=${v}`).join(" ") || "none"}`);
} catch (e) {
  console.log(`infra: failed (${(e as Error).name})`);
}
