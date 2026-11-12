/**
 * Config pack commands.
 *   pnpm pack:check [dir]            validate a pack folder (default: TELL_PACK_DIR or packs/example-gtm)
 *   pnpm pack:check --r2             validate the private pack at TELL_PACK_R2_PREFIX
 *   pnpm pack:push <dir> <prefix>    upload a pack folder to a private R2 prefix
 */
import "dotenv/config";
import { resolve } from "node:path";
import { loadPack, packSourceFromEnv, pushPackToR2, PackError, type Pack } from "@tell/config";

const [cmd, a, b] = process.argv.slice(2);

function summary(p: Pack) {
  const s = Object.keys(p.signals.signals).length, plays = Object.keys(p.plays.plays).length;
  return `pack "${p.meta.name}" is valid: ${s} signal types, ${plays} plays, ${p.roles.core.length} core role patterns, ` +
    `sources: ${[p.sources.hn.enabled && "hn", p.sources.reddit.enabled && "reddit", p.sources.yc.enabled && "yc"].filter(Boolean).join(", ")}` +
    `${p.delivery.digest.to ? "" : " (warning: delivery.digest.to not set)"}`;
}

try {
  if (cmd === "check") {
    const src = a === "--r2" ? packSourceFromEnv() : a ? { kind: "dir" as const, dir: resolve(a) } : packSourceFromEnv();
    if (a === "--r2" && src.kind !== "r2") throw new PackError("set TELL_PACK_R2_PREFIX to check the private pack");
    console.log(summary(await loadPack(src)));
  } else if (cmd === "push") {
    if (!a || !b) throw new PackError("usage: pnpm pack:push <dir> <r2-prefix>");
    const p = await loadPack({ kind: "dir", dir: resolve(a) }); // never upload an invalid pack
    const files = await pushPackToR2(resolve(a), b);
    console.log(`uploaded ${files.length} files of "${p.meta.name}" to r2://${process.env.R2_BUCKET}/${b}`);
  } else {
    throw new PackError("usage: pnpm pack:check [dir|--r2] | pnpm pack:push <dir> <r2-prefix>");
  }
} catch (e) {
  console.error(e instanceof PackError ? e.message : e);
  process.exit(1);
}
