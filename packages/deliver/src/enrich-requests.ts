import type { Pack } from "@tell/config";
import { getDb, deliveries, inArray, sql } from "@tell/db";
import { airWaterfall } from "@tell/watchers";
import { enrichContact, enrichCellText } from "@tell/pipeline";
import { fetchEnrichRequests, ackEnrichRequests, enrichLink } from "./label-links.js";
import { fillColumnById, ensureLeadHeaders, LEAD_COLUMNS, LEAD_CELLS_BEFORE_ID } from "./sheets.js";

/** Stored Sheet row cell for a column (rows are stored without the hidden ID). */
const cell = (row: string[], c: (typeof LEAD_COLUMNS)[number]) => { const i = LEAD_COLUMNS.indexOf(c); return row[i < LEAD_CELLS_BEFORE_ID ? i : i - 1] ?? ""; };

/**
 * Find-email clicks (digest button / Sheet "Enrich email" link, queued by the Worker): each delivery's contact goes
 * through Air Waterfall once and the answer replaces the link in the Sheet. A request is acked only once answered,
 * so an Air Waterfall outage is retried by the next run. Returns counts only (Actions logs are public).
 */
export async function runEnrichRequests(pack: Pack): Promise<{ status: "ok" | "skipped"; reason?: string; requests: number; answered: number; byVerdict: Record<string, number>; credits: number; sheetCells: number }> {
  const out = { status: "ok" as const, requests: 0, answered: 0, byVerdict: {} as Record<string, number>, credits: 0, sheetCells: 0 };
  const base = process.env.TELL_LABEL_URL, secret = process.env.LABEL_SECRET;
  if (!base || !secret) return { ...out, status: "skipped", reason: "TELL_LABEL_URL / LABEL_SECRET not set" };
  const client = airWaterfall();
  if (!client) return { ...out, status: "skipped", reason: "AIR_WATERFALL_URL / AIR_WATERFALL_API_KEY not set" };
  const reqs = await fetchEnrichRequests(base, secret);
  out.requests = reqs.length;
  if (!reqs.length) return out;
  const rows = await getDb().select({ id: deliveries.id, accountId: deliveries.accountId, row: deliveries.sheetRow }).from(deliveries).where(inArray(deliveries.id, reqs.map((r) => r.d)));
  const cells = new Map<string, string>(), done: string[] = [];
  for (const req of reqs) {
    const d = rows.find((r) => r.id === req.d);
    const row = (d?.row ?? null) as string[] | null;
    const name = row ? cell(row, "Person") : "";
    if (!d?.accountId || !name) { cells.set(req.d, "no contact to look up"); done.push(req.d); continue; }
    try {
      const { result, suppressed } = await enrichContact({ accountId: d.accountId, name, role: cell(row!, "Role") || null }, client);
      out.byVerdict[result.verdict] = (out.byVerdict[result.verdict] ?? 0) + 1;
      out.credits += result.credits;
      cells.set(req.d, enrichCellText(result, suppressed));
      done.push(req.d);
      out.answered++;
    } catch { /* service asleep or down: left queued for the next run */ }
  }
  const sheetId = pack.delivery.sheet.spreadsheet_id;
  if (sheetId && cells.size) {
    await ensureLeadHeaders(sheetId);
    out.sheetCells = await fillColumnById(sheetId, "Enrich email", cells, true);
  }
  await ackEnrichRequests(base, secret, done);
  return out;
}

/**
 * Put a find-email link in the "Enrich email" cell of delivered rows that have a contact but no email yet (rows made
 * before the column existed). Only empty cells are written, so answers already there stay. Returns cells written.
 */
export async function backfillEnrichLinks(pack: Pack): Promise<{ status: "ok" | "skipped"; reason?: string; rows: number; cells: number }> {
  const base = process.env.TELL_LABEL_URL, secret = process.env.LABEL_SECRET, sheetId = pack.delivery.sheet.spreadsheet_id;
  if (!base || !secret || !sheetId) return { status: "skipped", reason: "TELL_LABEL_URL / LABEL_SECRET / sheet not set", rows: 0, cells: 0 };
  const rows = await getDb().select({ id: deliveries.id, row: deliveries.sheetRow }).from(deliveries).where(sql`${deliveries.sheetAppendedAt} is not null`);
  const links = new Map<string, string>();
  for (const r of rows) {
    const row = (r.row ?? null) as string[] | null;
    if (row && cell(row, "Person") && !cell(row, "Profile").includes("@")) links.set(r.id, enrichLink(base, secret, r.id));
  }
  if (!links.size) return { status: "ok", rows: 0, cells: 0 };
  await ensureLeadHeaders(sheetId);
  return { status: "ok", rows: links.size, cells: await fillColumnById(sheetId, "Enrich email", links) };
}
