import type { Pack } from "@tell/config";
import { getDb, deliveries, inArray, eq, sql } from "@tell/db";
import { airWaterfall } from "@tell/watchers";
import { enrichContact, enrichStatus } from "@tell/pipeline";
import { fetchEnrichRequests, ackEnrichRequests, enrichLink } from "./label-links.js";
import { fillColumnById, ensureLeadHeaders, sheetsCall, storedRow, emailCells, type LeadRow, type LeadColumn } from "./sheets.js";


/**
 * Find-email clicks (digest button / Sheet "Enrich email" link, queued by the Worker): each delivery's contact goes
 * through Air Waterfall once: the address goes in Email (address only), Verified / Risky / Catch-all get yes or no, and
 * the link in "Enrich email" becomes a short status (done, not found). A request is acked only once answered,
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
  // per column: delivery id -> new cell (Email + the yes/no columns; "Enrich email" turns from a link into a status)
  const cols = new Map<LeadColumn, Map<string, string>>();
  const put = (id: string, r: LeadRow) => { for (const [k, v] of Object.entries(r)) (cols.get(k as LeadColumn) ?? cols.set(k as LeadColumn, new Map()).get(k as LeadColumn)!).set(id, v ?? ""); };
  const done: string[] = [];
  for (const req of reqs) {
    const d = rows.find((r) => r.id === req.d);
    const row = storedRow(d?.row ?? null);
    if (!d?.accountId || !row.Person) { put(req.d, { "Enrich email": "no contact to look up" }); done.push(req.d); continue; }
    try {
      const { result, suppressed } = await enrichContact({ accountId: d.accountId, name: row.Person, role: row.Role || null }, client);
      out.byVerdict[result.verdict] = (out.byVerdict[result.verdict] ?? 0) + 1;
      out.credits += result.credits;
      const cells: LeadRow = { "Enrich email": enrichStatus(result, suppressed), ...(result.email ? emailCells(result.email, result.verdict, result.catchAll) : {}) };
      put(req.d, cells);
      await getDb().update(deliveries).set({ sheetRow: { ...row, ...cells } }).where(eq(deliveries.id, req.d));
      done.push(req.d);
      out.answered++;
    } catch { /* service asleep or down: left queued for the next run */ }
  }
  const sheetId = pack.delivery.sheet.spreadsheet_id;
  if (sheetId && cols.size) {
    await ensureLeadHeaders(sheetId);
    // a link can carry another delivery's id than its row (same account delivered twice): map link id -> row ID
    const grid = (await sheetsCall<{ values?: string[][] }>(`/${sheetId}/values/${encodeURIComponent("Leads!A:AZ")}`)).values ?? [];
    const [h = [], ...body] = grid;
    const ei = h.findIndex((x) => x.trim() === "Enrich email"), ii = h.findIndex((x) => x.trim() === "ID");
    const rowOf = new Map<string, string>();
    for (const r of body) { const m = (r[ei] ?? "").match(/[?&]d=([0-9a-f-]{36})/i); if (m && r[ii]) rowOf.set(m[1]!, r[ii]!.trim()); }
    for (const [col, values] of cols) cols.set(col, new Map([...values].map(([d, v]) => [rowOf.get(d) ?? d, v])));
    for (const [col, values] of cols) {
      const n = await fillColumnById(sheetId, col, values, true);
      if (col === "Enrich email") out.sheetCells = n;
    }
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
    const row = storedRow(r.row);
    if (row.Person && !row.Email) links.set(r.id, enrichLink(base, secret, r.id));
  }
  if (!links.size) return { status: "ok", rows: 0, cells: 0 };
  await ensureLeadHeaders(sheetId);
  return { status: "ok", rows: links.size, cells: await fillColumnById(sheetId, "Enrich email", links) };
}
