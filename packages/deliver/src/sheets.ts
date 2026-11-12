import { googleAccessToken } from "./gmail.js";

/**
 * Leads Sheet (plan section 10): one row per delivered lead + your Label / Reason / Outcome columns, synced back
 * nightly. Scope is drive.file: the app can only touch the spreadsheet it created.
 * Rows are written RAW (never as formulas): scraped text must not be able to run as a formula.
 */

const API = "https://sheets.googleapis.com/v4/spreadsheets";

/** Lead columns. The last one (ID) is hidden; sync matches rows by it, never by position. */
export const LEAD_COLUMNS = [
  "Date", "Person", "Role", "Profile", "Company", "Website", "Size", "Segment", "Region",
  "Plays", "Why now", "Opener", "Angle", "Priority",
  "Label", "Reason", "Outcome", "Notes", "ID",
] as const;
export const GIG_COLUMNS = ["Date", "Gig", "Company", "Type", "Location", "Apply", "Source", "Status", "Notes", "ID"] as const;

export const LABEL_VALUES = ["good", "bad"];
/** plan 11b: every "bad" label gets a reason */
export const REASON_VALUES = ["vendor", "too big", "already solved", "wrong person", "stale", "not B2B", "not ICP", "other"];
export const OUTCOME_VALUES = ["contacted", "replied", "meeting", "won", "lost", "no reply"];
export const GIG_STATUS_VALUES = ["applied", "skipped", "replied", "won", "lost"];

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await googleAccessToken();
  const res = await fetch(`${API}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) } });
  const j = (await res.json()) as T & { error?: { message?: string; status?: string } };
  if (!res.ok) throw new Error(`Sheets API ${res.status}: ${j.error?.status ?? ""} ${j.error?.message ?? ""}`.trim());
  return j;
}

const colLetter = (i: number) => String.fromCharCode(65 + i); // < 26 columns

function dropdown(sheetId: number, col: number, values: string[]) {
  return {
    setDataValidation: {
      range: { sheetId, startRowIndex: 1, startColumnIndex: col, endColumnIndex: col + 1 },
      rule: { condition: { type: "ONE_OF_LIST", values: values.map((v) => ({ userEnteredValue: v })) }, strict: false, showCustomUi: true },
    },
  };
}

/** Create the spreadsheet with both tabs, headers, dropdowns, a frozen header row and hidden ID columns. */
export async function createLeadsSheet(title: string): Promise<{ spreadsheetId: string; url: string }> {
  const created = await call<{ spreadsheetId: string; spreadsheetUrl: string; sheets: { properties: { sheetId: number; title: string } }[] }>("", {
    method: "POST",
    body: JSON.stringify({
      properties: { title },
      sheets: [
        { properties: { title: "Leads", gridProperties: { frozenRowCount: 1 } }, data: [{ startRow: 0, startColumn: 0, rowData: [{ values: LEAD_COLUMNS.map((c) => ({ userEnteredValue: { stringValue: c }, userEnteredFormat: { textFormat: { bold: true } } })) }] }] },
        { properties: { title: "Gigs", gridProperties: { frozenRowCount: 1 } }, data: [{ startRow: 0, startColumn: 0, rowData: [{ values: GIG_COLUMNS.map((c) => ({ userEnteredValue: { stringValue: c }, userEnteredFormat: { textFormat: { bold: true } } })) }] }] },
      ],
    }),
  });
  const leads = created.sheets.find((s) => s.properties.title === "Leads")!.properties.sheetId;
  const gigs = created.sheets.find((s) => s.properties.title === "Gigs")!.properties.sheetId;
  const hide = (sheetId: number, col: number) => ({ updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: col, endIndex: col + 1 }, properties: { hiddenByUser: true }, fields: "hiddenByUser" } });
  await call(`/${created.spreadsheetId}:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({
      requests: [
        dropdown(leads, LEAD_COLUMNS.indexOf("Label"), LABEL_VALUES),
        dropdown(leads, LEAD_COLUMNS.indexOf("Reason"), REASON_VALUES),
        dropdown(leads, LEAD_COLUMNS.indexOf("Outcome"), OUTCOME_VALUES),
        dropdown(gigs, GIG_COLUMNS.indexOf("Status"), GIG_STATUS_VALUES),
        hide(leads, LEAD_COLUMNS.indexOf("ID")),
        hide(gigs, GIG_COLUMNS.indexOf("ID")),
      ],
    }),
  });
  return { spreadsheetId: created.spreadsheetId, url: created.spreadsheetUrl };
}

/** Append rows (RAW: values are stored as typed text, never parsed as formulas). */
export async function appendRows(spreadsheetId: string, tab: "Leads" | "Gigs", rows: string[][]): Promise<void> {
  if (!rows.length) return;
  const width = tab === "Leads" ? LEAD_COLUMNS.length : GIG_COLUMNS.length;
  await call(`/${spreadsheetId}/values/${encodeURIComponent(`${tab}!A:${colLetter(width - 1)}`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: "POST",
    body: JSON.stringify({ values: rows }),
  });
}

export interface SheetLabel { id: string; label: string | null; reason: string | null; outcome: string | null; notes: string | null }

/** Parse the Leads tab by header name (you may reorder or add columns) and return rows you've labelled. */
export function parseLabels(values: string[][]): SheetLabel[] {
  const [header, ...rows] = values;
  if (!header) return [];
  const at = (name: string) => header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
  const idx = { id: at("ID"), label: at("Label"), reason: at("Reason"), outcome: at("Outcome"), notes: at("Notes") };
  if (idx.id < 0) throw new Error('Leads tab has no "ID" column');
  const cell = (r: string[], i: number) => (i >= 0 ? (r[i] ?? "").trim() || null : null);
  return rows
    .map((r) => ({ id: cell(r, idx.id) ?? "", label: cell(r, idx.label)?.toLowerCase() ?? null, reason: cell(r, idx.reason), outcome: cell(r, idx.outcome)?.toLowerCase() ?? null, notes: cell(r, idx.notes) }))
    .filter((r) => /^[0-9a-f-]{36}$/i.test(r.id) && (r.label || r.reason || r.outcome || r.notes));
}

export async function readLabels(spreadsheetId: string): Promise<SheetLabel[]> {
  const j = await call<{ values?: string[][] }>(`/${spreadsheetId}/values/${encodeURIComponent("Leads!A:Z")}`);
  return parseLabels(j.values ?? []);
}
