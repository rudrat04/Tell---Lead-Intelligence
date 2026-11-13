import { gzipSync, gunzipSync } from "node:zlib";
import { r2 } from "@tell/config";
import { getDb, sql } from "@tell/db";

/**
 * Nightly backup of the data that can't be re-derived (plan section 12): your labels, what was delivered, people and
 * their provenance, plays, signals (evidence), accounts, suppression list, config versions.
 * Raw items, candidates, scores and snapshots are re-derivable and not backed up.
 * Layout: backups/daily/YYYY-MM-DD/<table>.json.gz (30 kept) + backups/monthly/YYYY-MM/ (copied on the 1st, kept).
 */
export const BACKUP_TABLES = [
  "labels", "deliveries", "people", "people_searches", "plays_matched", "signals", "accounts",
  "suppression_list", "deletion_requests", "config_versions", "exemplars", "analyses", "gigs",
] as const;

const DAILY_KEEP = 30;

export interface BackupResult { day: string; tables: Record<string, number>; bytes: number; prunedDaily: number; monthly: boolean; verified: boolean }

export async function runBackup(opts: { now?: Date } = {}): Promise<BackupResult> {
  const now = opts.now ?? new Date();
  const day = now.toISOString().slice(0, 10);
  const db = getDb();
  const bucket = r2();
  const res: BackupResult = { day, tables: {}, bytes: 0, prunedDaily: 0, monthly: false, verified: false };

  const blobs: [string, Uint8Array][] = [];
  for (const t of BACKUP_TABLES) {
    const rows = (await db.execute(sql.raw(`select * from "${t}"`))).rows;
    res.tables[t] = rows.length;
    const gz = gzipSync(Buffer.from(JSON.stringify({ table: t, exportedAt: now.toISOString(), rows })));
    res.bytes += gz.length;
    blobs.push([t, gz]);
    await bucket.put(`backups/daily/${day}/${t}.json.gz`, gz, "application/gzip");
  }

  // verify: read every file back and compare row counts
  let ok = true;
  for (const [t] of blobs) {
    const got = await bucket.get(`backups/daily/${day}/${t}.json.gz`);
    const n = got ? (JSON.parse(gunzipSync(got).toString()) as { rows: unknown[] }).rows.length : -1;
    if (n !== res.tables[t]) ok = false;
  }
  res.verified = ok;
  if (!ok) throw new Error(`backup verification failed for ${day}`);

  // monthly copy on the 1st (kept indefinitely: small)
  if (now.getUTCDate() === 1) {
    const month = day.slice(0, 7);
    for (const [t, gz] of blobs) await bucket.put(`backups/monthly/${month}/${t}.json.gz`, gz, "application/gzip");
    res.monthly = true;
  }

  // keep the newest DAILY_KEEP daily backups
  const days = [...new Set((await bucket.list("backups/daily/")).map((o) => o.key.split("/")[2]!))].sort();
  for (const old of days.slice(0, Math.max(0, days.length - DAILY_KEEP))) {
    for (const o of await bucket.list(`backups/daily/${old}/`)) await bucket.del(o.key);
    res.prunedDaily++;
  }
  return res;
}
