import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/neon-http/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { sql } from "drizzle-orm";
import { getDb } from "./index.js";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

/**
 * Apply pending migrations with Drizzle's migrator (records each in drizzle.__drizzle_migrations).
 * `baselineThrough`: for a database migrated by hand (psql) before the migrator was used, first record
 * migrations up to and including that tag as already applied. Only ever runs when the record table is empty.
 */
export async function migrateDb(opts: { url?: string; baselineThrough?: string } = {}): Promise<{ baselined: number; applied: string[] }> {
  const db = getDb(opts.url);
  const files = readMigrationFiles({ migrationsFolder: MIGRATIONS_DIR });
  const tags = (await import(`${MIGRATIONS_DIR}/meta/_journal.json`, { with: { type: "json" } })).default.entries.map((e: { tag: string }) => e.tag) as string[];

  await db.execute(sql`create schema if not exists drizzle`);
  await db.execute(sql`create table if not exists drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)`);
  const before = (await db.execute(sql`select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1`)).rows as { created_at: string }[];

  let baselined = 0;
  if (opts.baselineThrough) {
    if (before.length) throw new Error("baseline refused: this database already has migration records");
    const upto = tags.indexOf(opts.baselineThrough);
    if (upto < 0) throw new Error(`unknown migration tag ${opts.baselineThrough}`);
    for (const m of files.slice(0, upto + 1)) {
      await db.execute(sql`insert into drizzle.__drizzle_migrations (hash, created_at) values (${m.hash}, ${m.folderMillis})`);
      baselined++;
    }
  }

  const last = before[0] ? Number(before[0].created_at) : baselined ? files[baselined - 1]!.folderMillis : -1;
  const pending = files.map((m, i) => ({ m, tag: tags[i]! })).filter(({ m }) => m.folderMillis > last).map(({ tag }) => tag);
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return { baselined, applied: pending };
}
