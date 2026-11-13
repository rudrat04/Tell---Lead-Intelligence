import type { Pack } from "@tell/config";
import { getDb, deliveries, labels, inArray, sql } from "@tell/db";
import { appendRows, readLabels, ensureLeadHeaders, LEAD_CELLS_BEFORE_ID } from "./sheets.js";

export interface SheetSyncResult { appended: number; labelsSynced: number; skipped?: string }

/** Append every delivered lead whose row isn't in the Sheet yet (retries earlier failures without resending email). */
export async function appendPendingLeads(pack: Pack): Promise<number> {
  const id = pack.delivery.sheet.spreadsheet_id;
  if (!id) return 0;
  const db = getDb();
  const pending = await db.select({ id: deliveries.id, row: deliveries.sheetRow }).from(deliveries)
    .where(sql`${deliveries.sheetRow} is not null and ${deliveries.sheetAppendedAt} is null`).orderBy(deliveries.deliveredAt).limit(500);
  if (!pending.length) return 0;
  await ensureLeadHeaders(id); // e.g. "Email draft" on a Sheet made before it existed
  // stored rows are the cells before ID, then any cells after it (older rows end before ID)
  await appendRows(id, "Leads", pending.map((p) => { const r = p.row as string[]; return [...r.slice(0, LEAD_CELLS_BEFORE_ID), p.id, ...r.slice(LEAD_CELLS_BEFORE_ID)]; }));
  await db.update(deliveries).set({ sheetAppendedAt: new Date() }).where(inArray(deliveries.id, pending.map((p) => p.id)));
  return pending.length;
}

/** Nightly: read your Label / Reason / Outcome / Notes back into the labels table (by hidden ID, never by row). */
export async function syncLabels(pack: Pack): Promise<number> {
  const id = pack.delivery.sheet.spreadsheet_id;
  if (!id) return 0;
  const rows = await readLabels(id);
  if (!rows.length) return 0;
  const db = getDb();
  const known = new Set((await db.select({ id: deliveries.id }).from(deliveries).where(inArray(deliveries.id, rows.map((r) => r.id)))).map((r) => r.id));
  const valid = rows.filter((r) => known.has(r.id));
  if (!valid.length) return 0;
  const now = new Date();
  await db.insert(labels).values(valid.map((r) => ({ deliveryId: r.id, label: r.label, reason: r.reason, outcome: r.outcome, notes: r.notes, updatedAt: now })))
    .onConflictDoUpdate({
      target: labels.deliveryId,
      set: { label: sql`excluded.label`, reason: sql`excluded.reason`, outcome: sql`excluded.outcome`, notes: sql`excluded.notes`, updatedAt: now },
    });
  return valid.length;
}

export async function runSheetSync(pack: Pack): Promise<SheetSyncResult> {
  if (!pack.delivery.sheet.spreadsheet_id) return { appended: 0, labelsSynced: 0, skipped: "no delivery.sheet.spreadsheet_id in the pack" };
  const appended = await appendPendingLeads(pack);
  const labelsSynced = await syncLabels(pack);
  return { appended, labelsSynced };
}
