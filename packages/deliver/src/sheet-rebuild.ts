import { minScoreFor, type Pack } from "@tell/config";
import { runScoring } from "@tell/pipeline";
import { displayScore, icpRecheck, sendWindow, sendWindowText } from "@tell/intel";
import { getDb, deliveries, inArray, eq } from "@tell/db";
import { syncLabels } from "./sheet-sync.js";
import {
  sheetsCall, LEAD_COLUMNS, splitProfile, emailCells, storedRow, a1Col, formatLeadsTab,
  type LeadRow, type LeadColumn,
} from "./sheets.js";

export interface SheetRebuildResult {
  rows: number;
  kept: number;
  /** kept only because you recorded an outcome (contacted, replied, ...) */
  keptForOutcome: number;
  removed: { notIcp: number; belowScore: number; outOfScope: number; noId: number };
  backupTab?: string;
}

/** An old "Enrich email" answer ("jo@acme.test (risky guess 40%: verify before sending)") as email cells. */
function oldEnrichAnswer(cell: string): LeadRow | null {
  const m = cell.trim().match(/^(\S+@\S+)\s*\((.*)\)$/);
  if (!m) return null;
  const status = m[2]!.startsWith("verified") ? "valid" : m[2]!.startsWith("likely") ? "likely" : "risky";
  return { ...emailCells(m[1]!, status, /catch-all/i.test(m[2]!) ? true : null), "Enrich email": `done: ${status}` };
}

/**
 * One-time rebuild of the Leads tab into the current column order (LEAD_COLUMNS), dropping rows whose account no
 * longer matches the ICP (critic icp/enterprise/vendor, or stored facts outside the pack) or scores under
 * delivery.digest.min_score today. Rows where you recorded an Outcome always stay. Your labels are synced to the
 * database first, the old tab is kept as a backup tab, columns you added yourself move to the end, and Score /
 * ICP fit / Timing are refreshed. Returns counts only.
 */
export async function rebuildLeadsSheet(pack: Pack, opts: { dryRun?: boolean; now?: Date; backup?: boolean } = {}): Promise<SheetRebuildResult> {
  const id = pack.delivery.sheet.spreadsheet_id;
  if (!id) throw new Error("delivery.sheet.spreadsheet_id is not set");
  const now = opts.now ?? new Date();
  if (!opts.dryRun) await syncLabels(pack); // labels you typed are in the database before any row moves

  const j = await sheetsCall<{ values?: string[][] }>(`/${id}/values/${encodeURIComponent("Leads!A:AZ")}`);
  const [header = [], ...values] = j.values ?? [];
  const known = new Set<string>([...LEAD_COLUMNS, "Profile", "Priority"]);
  const extra = header.map((h) => h.trim()).filter((h) => h && !known.has(h)); // your own columns: kept, at the end
  const newHeader = [...LEAD_COLUMNS, ...extra];

  const score = await runScoring({ pack, write: false, now, minScore: 0 });
  const byAccount = new Map((score.all ?? []).map((x) => [x.account.id, x]));
  const failed = score.criticFailed ?? {};
  const ids = values.map((r) => (r[header.findIndex((h) => h.trim() === "ID")] ?? "").trim()).filter(Boolean);
  const dels = ids.length ? await getDb().select({ id: deliveries.id, accountId: deliveries.accountId, row: deliveries.sheetRow }).from(deliveries).where(inArray(deliveries.id, ids)) : [];
  const delOf = new Map(dels.map((d) => [d.id, d]));

  const res: SheetRebuildResult = { rows: values.length, kept: 0, keptForOutcome: 0, removed: { notIcp: 0, belowScore: 0, outOfScope: 0, noId: 0 } };
  const out: { row: LeadRow; extra: Record<string, string>; id: string }[] = [];
  for (const r of values) {
    const old: Record<string, string> = Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? "").toString()]));
    const rid = (old.ID ?? "").trim();
    if (!rid) { res.removed.noId++; continue; }
    // the old row by name: Profile splits into Email / LinkedIn / yes-no columns; Priority becomes Score
    let row: LeadRow = {};
    for (const c of LEAD_COLUMNS) if (old[c] !== undefined && c !== "ID") row[c as LeadColumn] = old[c];
    if (old.Profile !== undefined) row = { ...row, ...splitProfile(old.Profile) };
    if (old.Priority !== undefined && !row.Score) row.Score = old.Priority;
    const answer = oldEnrichAnswer(row["Enrich email"] ?? "");
    if (answer) row = { ...row, ...answer };

    const d = delOf.get(rid);
    const x = d?.accountId ? byAccount.get(d.accountId) : undefined;
    const hasOutcome = !!(row.Outcome ?? "").trim();
    let drop: keyof SheetRebuildResult["removed"] | null = null;
    if (!x) drop = "outOfScope";
    else if ((failed[x.account.id] ?? []).some((c) => c === "icp" || c === "enterprise" || c === "vendor") || icpRecheck(x.account, pack)) drop = "notIcp";
    else if (displayScore(x.score) < minScoreFor(pack, x.account.region)) drop = "belowScore";
    if (drop && !hasOutcome) { res.removed[drop]++; continue; }
    if (drop) res.keptForOutcome++;
    if (x) {
      row.Score = String(displayScore(x.score));
      row["ICP fit"] = String(Math.round(x.score.fit * 100));
      row.Timing = sendWindowText(sendWindow(x.score.evidence, now, pack.icp.calendar));
      row.Size = x.account.sizeBand ?? ""; // stored facts, filled from the Exa company index when no source gave them
      row.Segment = x.account.segment ?? "";
    }
    out.push({ row, extra: Object.fromEntries(extra.map((h) => [h, old[h] ?? ""])), id: rid });
    res.kept++;
  }
  if (opts.dryRun) return res;

  // backup tab first: nothing is cleared until the old rows exist somewhere else in the same spreadsheet
  const meta = await sheetsCall<{ sheets: { properties: { sheetId: number; title: string } }[] }>(`/${id}?fields=sheets.properties`);
  const leads = meta.sheets.find((s) => s.properties.title === "Leads")?.properties.sheetId;
  if (leads === undefined) throw new Error("no Leads tab");
  if (opts.backup !== false) {
    let backup = `Leads backup ${now.toISOString().slice(0, 10)}`;
    for (let n = 2; meta.sheets.some((s) => s.properties.title === backup); n++) backup = `Leads backup ${now.toISOString().slice(0, 10)} (${n})`;
    await sheetsCall(`/${id}:batchUpdate`, { method: "POST", body: JSON.stringify({ requests: [{ duplicateSheet: { sourceSheetId: leads, newSheetName: backup, insertSheetIndex: meta.sheets.length } }] }) });
    res.backupTab = backup;
  }

  await sheetsCall(`/${id}/values/${encodeURIComponent("Leads!A:AZ")}:clear`, { method: "POST", body: "{}" });
  const grid = [newHeader, ...out.map((o) => newHeader.map((h) => (h === "ID" ? o.id : (o.row[h as LeadColumn] ?? o.extra[h] ?? ""))))];
  await sheetsCall(`/${id}/values/${encodeURIComponent(`Leads!A1:${a1Col(newHeader.length - 1)}${grid.length}`)}?valueInputOption=RAW`, { method: "PUT", body: JSON.stringify({ values: grid }) });
  await formatLeadsTab(id); // dropdowns, widths, hidden ID: all by header name
  // stored rows follow the Sheet (by column name), so later appends and fills line up
  const db = getDb();
  for (const o of out) await db.update(deliveries).set({ sheetRow: { ...storedRow(delOf.get(o.id)?.row ?? null), ...o.row } }).where(eq(deliveries.id, o.id));
  return res;
}
