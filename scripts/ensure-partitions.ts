/** Creates this month's and the next two months' partitions for raw_items, candidates and scores. Safe to repeat. */
import "dotenv/config";
import { getDb, sql } from "@tell/db";

const db = getDb();
await db.execute(sql`select create_month_partitions(2)`);
const r = await db.execute(sql`
  select max(c.relname) as latest from pg_inherits i
  join pg_class c on c.oid = i.inhrelid join pg_class p on p.oid = i.inhparent
  where p.relname = 'scores' and c.relkind = 'r'`);
console.log(`partitions ok; latest scores partition: ${(r.rows[0] as { latest: string }).latest}`);
