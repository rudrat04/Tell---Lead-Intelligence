import type { Pack } from "@tell/config";
import { getDb, deliveries, inArray, eq, sql } from "@tell/db";
import { airWaterfall } from "@tell/watchers";
import { enrichContact, enrichStatus, enrichSignalPeople } from "@tell/pipeline";
import { signalSideText, type OppContext } from "./opportunities.js";
import { sendTelegram, tgEsc, type TgMessage } from "./telegram.js";
import { fetchEnrichRequests, ackEnrichRequests, enrichLink } from "./label-links.js";
import { fillColumnById, ensureLeadHeaders, sheetsCall, storedRow, emailCells, type LeadRow, type LeadColumn } from "./sheets.js";


/**
 * Find-email clicks (digest button / Sheet "Enrich email" link, queued by the Worker): each delivery's contact goes
 * through Air Waterfall once (then our verifiers and finders when its answer is a guess): only a verified address goes in
 * Email (address only; never a guess, so a risky or likely answer leaves Email empty), Verified gets yes or no, and
 * the link in "Enrich email" becomes a short status (done, not found). A request is acked only once answered,
 * so an Air Waterfall outage is retried by the next run. Returns counts only (Actions logs are public).
 */
export async function runEnrichRequests(pack: Pack): Promise<{ status: "ok" | "skipped"; reason?: string; requests: number; answered: number; byVerdict: Record<string, number>; credits: number; sheetCells: number; signalFound?: number }> {
  const out: { status: "ok"; requests: number; answered: number; byVerdict: Record<string, number>; credits: number; sheetCells: number; signalFound?: number } = { status: "ok" as const, requests: 0, answered: 0, byVerdict: {} as Record<string, number>, credits: 0, sheetCells: 0 };
  const base = process.env.TELL_LABEL_URL, secret = process.env.LABEL_SECRET;
  if (!base || !secret) return { ...out, status: "skipped", reason: "TELL_LABEL_URL / LABEL_SECRET not set" };
  // Air Waterfall when configured, then our own waterfall (verifiers, web search, formats, Hunter, Prospeo, Apollo)
  const client = airWaterfall();
  const reqs = await fetchEnrichRequests(base, secret);
  out.requests = reqs.length;
  if (!reqs.length) return out;
  const rows = await getDb().select({ id: deliveries.id, accountId: deliveries.accountId, row: deliveries.sheetRow, context: deliveries.context }).from(deliveries).where(inArray(deliveries.id, reqs.map((r) => r.d)));
  const tg: TgMessage[] = [];
  // per column: delivery id -> new cell (Email + the yes/no columns; "Enrich email" turns from a link into a status)
  const cols = new Map<LeadColumn, Map<string, string>>();
  const put = (id: string, r: LeadRow) => { for (const [k, v] of Object.entries(r)) (cols.get(k as LeadColumn) ?? cols.set(k as LeadColumn, new Map()).get(k as LeadColumn)!).set(id, v ?? ""); };
  const done: string[] = [];
  for (const req of reqs) {
    const d = rows.find((r) => r.id === req.d);
    const row = storedRow(d?.row ?? null);
    // the people at the signal's company (es: button / "Signal-side email" link)
    if (req.signal) {
      const ctx = d?.context as OppContext | null | undefined;
      if (!ctx?.signal?.people.length) put(req.d, { "Signal-side email": "nobody on the signal's side to look up" } as LeadRow);
      else {
        try {
          const r = await enrichSignalPeople(ctx.signal);
          const found = r.people.filter((p) => p.email).length;
          out.signalFound = (out.signalFound ?? 0) + found;
          put(req.d, { "Signal-side contact": `${ctx.signal.entity}: ${signalSideText(r.people)}`, "Signal-side email": found ? `done: ${found} of ${r.people.length} verified` : r.domain ? "no verified address" : "their website wasn't found" } as LeadRow);
          await getDb().update(deliveries).set({ context: { ...ctx, signal: { ...ctx.signal, people: r.people } } }).where(eq(deliveries.id, req.d));
          tg.push({ text: [`🔎 <b>${tgEsc(ctx.signal.full)}</b> (the signal's side, for ${tgEsc(ctx.company)})`,
            ...r.people.map((p) => `• ${tgEsc(p.name)}, ${tgEsc(p.role)}: ${p.email ? `✉️ ${tgEsc(p.email.address)} (verified)` : "no verified address"}`),
            ...(r.domain ? [] : ["Their website wasn't found, so no address could be checked."])].join("\n") });
        } catch { continue; /* left queued for the next run */ }
      }
      if (req.person !== true) { done.push(req.d); continue; }
    }
    if (!d?.accountId || !row.Person) { put(req.d, { "Enrich email": "no contact to look up" }); done.push(req.d); continue; }
    try {
      const { result, suppressed, sure } = await enrichContact({ accountId: d.accountId, name: row.Person, role: row.Role || null, linkedin: /linkedin\.com\/in\//i.test(row.LinkedIn ?? "") ? row.LinkedIn! : null }, client);
      const k = sure ? "verified" : result.verdict;
      out.byVerdict[k] = (out.byVerdict[k] ?? 0) + 1;
      out.credits += result.credits;
      // only a sure address goes in Email; a guess leaves Email empty (and clears one written before this rule)
      const cells: LeadRow = { "Enrich email": enrichStatus(result, suppressed, sure), ...(sure ? emailCells(sure.address, "verified", false) : row.Verified === "yes" ? {} : { Email: "", Verified: "no", Risky: "", "Catch-all": "" }) };
      put(req.d, cells);
      await getDb().update(deliveries).set({ sheetRow: { ...row, ...cells } }).where(eq(deliveries.id, req.d));
      done.push(req.d);
      out.answered++;
    } catch { /* service asleep or down: left queued for the next run */ }
  }
  const sheetId = pack.delivery.sheet.spreadsheet_id;
  if (sheetId && cols.size) {
    await ensureLeadHeaders(sheetId);
    try { await ensureLeadHeaders(sheetId, "Opportunities"); } catch { /* no such tab yet */ }
    // a link can carry another delivery's id than its row (same account delivered twice): map link id -> row ID
    const grid = (await sheetsCall<{ values?: string[][] }>(`/${sheetId}/values/${encodeURIComponent("Leads!A:AZ")}`)).values ?? [];
    const [h = [], ...body] = grid;
    const ei = h.findIndex((x) => x.trim() === "Enrich email"), ii = h.findIndex((x) => x.trim() === "ID");
    const rowOf = new Map<string, string>();
    for (const r of body) { const m = (r[ei] ?? "").match(/[?&]d=([0-9a-f-]{36})/i); if (m && r[ii]) rowOf.set(m[1]!, r[ii]!.trim()); }
    for (const [col, values] of cols) cols.set(col, new Map([...values].map(([d, v]) => [rowOf.get(d) ?? d, v])));
    for (const [col, values] of cols) {
      // (signal-side columns exist on the Opportunities tab only)
      let n = await fillColumnById(sheetId, col, values, true).catch(() => 0);
      // opportunity leads sit on their own tab (the same ID finds their row there)
      try { n += await fillColumnById(sheetId, col, values, true, "Opportunities"); } catch { /* no such tab or column */ }
      if (col === "Enrich email") out.sheetCells = n;
    }
  }
  if (tg.length) await sendTelegram(tg).catch(() => 0);
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
