import type { Pack } from "@tell/config";
import { getDb, deliveries, labels, inArray, sql } from "@tell/db";
import { appendRows, readLabels, ensureLeadHeaders, fillColumnById, LEAD_CELLS_BEFORE_ID } from "./sheets.js";
import { fetchTaps, ackTaps } from "./label-links.js";

export interface SheetSyncResult { appended: number; labelsSynced: number; taps?: number; tapsNote?: string; skipped?: string }

/**
 * One-tap labels from the digest: write each tap into the Sheet's empty Label cells (a label you typed there wins),
 * so the Sheet stays the one place labels are read from. Returns taps applied.
 */
export async function applyTaps(pack: Pack): Promise<{ taps: number; note?: string }> {
  const url = process.env.TELL_LABEL_URL, secret = process.env.LABEL_SECRET, id = pack.delivery.sheet.spreadsheet_id;
  if (!url || !secret || !id) return { taps: 0, note: "label links not configured" };
  const taps = await fetchTaps(url, secret);
  if (!taps.length) return { taps: 0 };
  const known = new Set((await getDb().select({ id: deliveries.id }).from(deliveries).where(inArray(deliveries.id, taps.map((t) => t.d)))).map((r) => r.id));
  const latest = new Map<string, string>();
  for (const t of [...taps].sort((a, b) => a.at.localeCompare(b.at))) if (known.has(t.d)) latest.set(t.d, t.v);
  const written = await fillColumnById(id, "Label", latest);
  // acknowledged once the Sheet has them (or a label was already there); unknown ids (test sends) are cleared too
  await ackTaps(url, secret, taps.map((t) => t.d));
  return { taps: written };
}

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
  let tapped: { taps: number; note?: string } = { taps: 0 };
  try { tapped = await applyTaps(pack); } catch (e) { tapped = { taps: 0, note: `taps unavailable (${(e as Error).message.slice(0, 40)})` }; }
  const labelsSynced = await syncLabels(pack); // reads the Sheet, including the taps just written
  return { appended, labelsSynced, taps: tapped.taps, tapsNote: tapped.note };
}
