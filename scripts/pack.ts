/**
 * Config pack commands.
 *   pnpm pack:check [dir]            validate a pack folder (default: TELL_PACK_DIR or packs/example-gtm)
 *   pnpm pack:check --r2             validate the private pack at TELL_PACK_R2_PREFIX
 *   pnpm pack:map [dir|--r2]         each industry: what feeds it, which signals count, which plays fire, what it's offered
 *   pnpm pack:push <dir> <prefix>    upload a pack folder to a private R2 prefix
 */
import "dotenv/config";
import { resolve } from "node:path";
import { loadPack, packSourceFromEnv, pushPackToR2, PackError, packWarnings, formatIndustryMap, type Pack } from "@tell/config";

const [cmd, a, b] = process.argv.slice(2);

function summary(p: Pack) {
  const s = Object.keys(p.signals.signals).length, plays = Object.keys(p.plays.plays).length;
  return `pack "${p.meta.name}" is valid: ${s} signal types, ${plays} plays, ${p.roles.core.length} core role patterns, ` +
    `sources: ${[p.sources.hn.enabled && "hn", p.sources.reddit.enabled && "reddit", p.sources.yc.enabled && "yc", p.sources.web_search.enabled && `web_search (${p.sources.web_search.queries.length} queries, ${p.sources.web_search.per_day}/day)`, p.sources.jsearch.enabled && `jsearch (${p.sources.jsearch.queries.length} queries, ${p.sources.jsearch.per_run}/run, ${p.sources.jsearch.per_month}/month)`].filter(Boolean).join(", ")}` +
    `${p.delivery.digest.to ? "" : " (warning: delivery.digest.to not set)"}`;
}

try {
  if (cmd === "check" || cmd === "map") {
    const src = a === "--r2" ? packSourceFromEnv() : a ? { kind: "dir" as const, dir: resolve(a) } : packSourceFromEnv();
    if (a === "--r2" && src.kind !== "r2") throw new PackError(`set TELL_PACK_R2_PREFIX to ${cmd} the private pack`);
    const p = await loadPack(src);
    if (cmd === "map") {
      if (process.env.CI) throw new PackError("pack:map prints the pack's industries and plays: run it locally, not in CI (public logs)");
      console.log(formatIndustryMap(p));
    }
    else {
      console.log(summary(p));
      // wiring warnings never fail the check (the daily chain runs it); pnpm pack:map shows them in context
      const w = packWarnings(p);
      // in CI only the count: Actions logs are public and the warnings name the private pack's industries and plays
      if (w.length) console.log(`${w.length} wiring warning${w.length === 1 ? "" : "s"} (pnpm pack:map for the full picture)${process.env.CI ? "" : `:\n${w.map((x) => `  - ${x}`).join("\n")}`}`);
    }
  } else if (cmd === "push") {
    if (!a || !b) throw new PackError("usage: pnpm pack:push <dir> <r2-prefix>");
    const p = await loadPack({ kind: "dir", dir: resolve(a) }); // never upload an invalid pack
    const files = await pushPackToR2(resolve(a), b);
    console.log(`uploaded ${files.length} files of "${p.meta.name}" to r2://${process.env.R2_BUCKET}/${b}`);
  } else {
    throw new PackError("usage: pnpm pack:check [dir|--r2] | pnpm pack:map [dir|--r2] | pnpm pack:push <dir> <r2-prefix>");
  }
} catch (e) {
  console.error(e instanceof PackError ? e.message : e);
  process.exit(1);
}
