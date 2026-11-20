/**
 * The free list a niche email promises, from public data (local only: it names companies).
 *   pnpm freelist <domain> [--kind federal_buyers|anda_holders|hospitals|permits|recompetes] [--state TX]
 * Writes lists/<domain>-<kind>-<date>.csv (git-ignored) and prints the count.
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { loadPack } from "@tell/config";
import { sampleList, toCsv, type ListKind } from "@tell/pipeline";

if (process.env.CI) { console.error("pnpm freelist is local only (it names companies)"); process.exit(1); }
const domain = process.argv[2];
if (!domain) { console.error("usage: pnpm freelist <domain> [--kind federal_buyers|anda_holders|hospitals|permits|recompetes] [--state TX]"); process.exit(1); }
const ki = process.argv.indexOf("--kind"), si = process.argv.indexOf("--state");
const pack = await loadPack();
try {
  const l = await sampleList(pack, domain, ki > 0 ? (process.argv[ki + 1] as ListKind) : undefined, si > 0 ? { state: process.argv[si + 1] } : {});
  mkdirSync("lists", { recursive: true });
  const file = `lists/${domain}-${l.kind}-${new Date().toISOString().slice(0, 10)}.csv`;
  writeFileSync(file, toCsv(l.rows));
  console.log(`${l.kind} list for ${l.input}: ${l.rows.length} rows from ${l.source} -> ${file}`);
} catch (e) { console.error(`list: ${(e as Error).message}`); process.exit(1); }
