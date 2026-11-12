/**
 * Apply database migrations.
 *   pnpm db:migrate                         fresh or already-tracked database
 *   pnpm db:migrate --baseline <tag>        one-time, for a database migrated by hand up to <tag>
 */
import "dotenv/config";
import { migrateDb } from "@tell/db/migrate";

const i = process.argv.indexOf("--baseline");
const baselineThrough = i > 0 ? process.argv[i + 1] : undefined;
const r = await migrateDb({ baselineThrough });
console.log(`migrations: baselined=${r.baselined} applied=${r.applied.length ? r.applied.join(", ") : "none (up to date)"}`);
