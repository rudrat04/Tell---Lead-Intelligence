import { googleAccessToken } from "./gmail.js";

/**
 * Leads Sheet (plan section 10): one row per delivered lead + your Label / Reason / Outcome columns, synced back
 * nightly. Scope is drive.file: the app can only touch the spreadsheet it created.
 * Rows are written RAW (never as formulas): scraped text must not be able to run as a formula.
 */

const API = "https://sheets.googleapis.com/v4/spreadsheets";

/**
 * Lead columns, in vetting order: is it worth it (score, ICP fit, timing, company facts, why), who (person, how to
 * reach), your verdict, then the long drafts. The last one (ID) is hidden; every read and write finds columns by
 * header name and rows by ID, never by position, so you can move columns around.
 */
export const LEAD_COLUMNS = [
  "Date", "Company", "What they do", "Website", "Score", "ICP fit", "Timing", "Size", "Segment", "Region", "Why now", "Signals", "Plays",
  "Person", "Role", "LinkedIn", "Email", "Verified", "Risky", "Catch-all", "Enrich email",
  "Label", "Reason", "Outcome", "Notes",
  "Opener", "Angle", "Email draft", "LinkedIn message", "Brief", "Follow-up", "ID",
] as const;
export type LeadColumn = (typeof LEAD_COLUMNS)[number];
/** One lead row by column name (stored per delivery in deliveries.sheet_row, without ID). */
export type LeadRow = Partial<Record<LeadColumn, string>>;

/** The layout before 17 Nov 2026: stored rows were arrays in this order (without ID). */
const LEGACY_V1 = ["Date", "Person", "Role", "Profile", "Company", "Website", "Size", "Segment", "Region", "Plays", "Why now", "Opener", "Angle",
  "Priority", "Label", "Reason", "Outcome", "Notes", "Email draft", "Signals", "LinkedIn message", "Timing", "Enrich email"];

/** "jo@acme.test (likely)\nhttps://linkedin.com/in/jo" (the old Profile cell) -> Email / LinkedIn / Verified / Risky. */
export function splitProfile(profile: string): LeadRow {
  const out: LeadRow = {};
  for (const line of profile.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const m = line.match(/^(\S+@\S+)\s*(?:\((.+)\))?$/);
    if (m) Object.assign(out, emailCells(m[1]!, m[2] ?? ""));
    else if (/^https?:\/\//.test(line)) out.LinkedIn = line;
  }
  return out;
}

/** Email cells from an address and how sure we are ("seen in public", "verified", "likely", "guessed", "risky"). */
export function emailCells(address: string, status: string, catchAll?: boolean | null): LeadRow {
  const s = status.toLowerCase();
  const invalid = /invalid/.test(s);
  const verified = !invalid && /seen in public|verified|observed|valid/.test(s);
  const risky = invalid || /guess|risky/.test(s);
  return { Email: address, Verified: verified ? "yes" : "no", Risky: risky ? "yes" : "no", "Catch-all": catchAll == null ? "unknown" : catchAll ? "yes" : "no" };
}

/** A stored row (an old positional array, or a row by name) as a row by name. */
export function storedRow(v: unknown): LeadRow {
  if (Array.isArray(v)) {
    const old = Object.fromEntries(LEGACY_V1.map((c, i) => [c, typeof v[i] === "string" ? (v[i] as string) : ""])) as Record<string, string>;
    const { Profile, Priority, ...rest } = old;
    const row: LeadRow = {};
    for (const [k, val] of Object.entries(rest)) if ((LEAD_COLUMNS as readonly string[]).includes(k)) row[k as LeadColumn] = val;
    return { ...row, Score: Priority ?? "", ...splitProfile(Profile ?? "") };
  }
  return v && typeof v === "object" ? (v as LeadRow) : {};
}

/** Cells for a Sheet whose header row is `header` (unknown headers get ""), with the hidden ID. */
export const rowFor = (header: string[], r: LeadRow, id: string): string[] =>
  header.map((h) => (h.trim() === "ID" ? id : r[h.trim() as LeadColumn] ?? ""));
export const GIG_COLUMNS = ["Date", "Gig", "Company", "Type", "Location", "Apply", "Source", "Status", "Notes", "ID"] as const;

export const LABEL_VALUES = ["good", "bad"];
/** plan 11b: every "bad" label gets a reason */
export const REASON_VALUES = ["vendor", "too big", "already solved", "wrong person", "stale", "not B2B", "not ICP", "other"];
export const OUTCOME_VALUES = ["contacted", "replied", "meeting", "won", "lost", "no reply"];
export const GIG_STATUS_VALUES = ["applied", "skipped", "replied", "won", "lost"];

export async function sheetsCall<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await googleAccessToken();
  const res = await fetch(`${API}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) } });
  const j = (await res.json()) as T & { error?: { message?: string; status?: string } };
  if (!res.ok) throw new Error(`Sheets API ${res.status}: ${j.error?.status ?? ""} ${j.error?.message ?? ""}`.trim());
  return j;
}

const colLetter = (i: number) => a1Col(i);

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
  const created = await sheetsCall<{ spreadsheetId: string; spreadsheetUrl: string; sheets: { properties: { sheetId: number; title: string } }[] }>("", {
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
  await sheetsCall(`/${created.spreadsheetId}:batchUpdate`, {
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
  await formatLeadsTab(created.spreadsheetId);
  return { spreadsheetId: created.spreadsheetId, url: created.spreadsheetUrl };
}

/** Append rows (RAW: values are stored as typed text, never parsed as formulas). */
export async function appendRows(spreadsheetId: string, tab: "Leads" | "Gigs", rows: string[][]): Promise<void> {
  if (!rows.length) return;
  const width = Math.max(tab === "Leads" ? LEAD_COLUMNS.length : GIG_COLUMNS.length, ...rows.map((r) => r.length));
  await sheetsCall(`/${spreadsheetId}/values/${encodeURIComponent(`${tab}!A:${colLetter(width - 1)}`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
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
  const j = await sheetsCall<{ values?: string[][] }>(`/${spreadsheetId}/values/${encodeURIComponent("Leads!A:AZ")}`);
  return parseLabels(j.values ?? []);
}

export const a1Col = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : String.fromCharCode(64 + Math.floor(i / 26)) + String.fromCharCode(65 + (i % 26)));

/** Add any lead header missing from row 1 (a Sheet created before a column existed), at the end. Returns the full header. */
export async function ensureLeadHeaders(spreadsheetId: string): Promise<string[]> {
  const j = await sheetsCall<{ values?: string[][] }>(`/${spreadsheetId}/values/${encodeURIComponent("Leads!1:1")}`);
  const current = j.values?.[0] ?? [];
  const header = current.map((h) => h.trim().toLowerCase());
  const missing = LEAD_COLUMNS.filter((c) => !header.includes(c.toLowerCase()));
  if (!missing.length) return current;
  const start = header.length;
  // a Sheet has a fixed grid (29 columns when it was made): widen it first, or writing a 30th header is refused
  const meta = await sheetsCall<{ sheets: { properties: { sheetId: number; title: string; gridProperties: { columnCount: number } } }[] }>(`/${spreadsheetId}?fields=sheets.properties`);
  const tab = meta.sheets.find((x) => x.properties.title === "Leads")?.properties;
  const need = start + missing.length - (tab?.gridProperties.columnCount ?? 0);
  if (tab && need > 0) {
    await sheetsCall(`/${spreadsheetId}:batchUpdate`, { method: "POST", body: JSON.stringify({ requests: [{ appendDimension: { sheetId: tab.sheetId, dimension: "COLUMNS", length: need } }] }) });
  }
  await sheetsCall(`/${spreadsheetId}/values/${encodeURIComponent(`Leads!${a1Col(start)}1:${a1Col(start + missing.length - 1)}1`)}?valueInputOption=RAW`, {
    method: "PUT", body: JSON.stringify({ values: [missing] }),
  });
  await formatLeadsTab(spreadsheetId); // new columns get their dropdowns; nothing stays on an old position
  return [...current, ...missing];
}

/**
 * Fill one column (found by header name) for rows matched by hidden ID. Only empty cells are written unless
 * `overwrite` (for a column the code owns, e.g. Priority after a scale change; never your Label/Notes), where an empty
 * value clears the cell. Returns cells written.
 */
export async function fillColumnById(spreadsheetId: string, column: string, values: Map<string, string>, overwrite = false): Promise<number> {
  const j = await sheetsCall<{ values?: string[][] }>(`/${spreadsheetId}/values/${encodeURIComponent("Leads!A:AZ")}`);
  const [header, ...rows] = j.values ?? [];
  const idCol = header?.findIndex((h) => h.trim() === "ID") ?? -1;
  const col = header?.findIndex((h) => h.trim().toLowerCase() === column.toLowerCase()) ?? -1;
  if (idCol < 0 || col < 0) throw new Error(`Leads tab needs "ID" and "${column}" columns`);
  const data = rows.flatMap((r, i) => {
    const v = values.get((r[idCol] ?? "").trim());
    // with overwrite, "" clears a code-owned cell (a draft that no longer passes the checks); without it, only empty cells are filled
    const cur = (r[col] ?? "").trim();
    const write = v !== undefined && (overwrite ? cur !== v : !!v && !cur);
    return write ? [{ range: `Leads!${a1Col(col)}${i + 2}`, values: [[v]] }] : [];
  });
  if (data.length) await sheetsCall(`/${spreadsheetId}/values:batchUpdate`, { method: "POST", body: JSON.stringify({ valueInputOption: "RAW", data }) });
  return data.length;
}

/** Column widths in pixels (others 140); short yes/no and score columns stay narrow, reading columns wide. */
const COLUMN_WIDTH: Record<string, number> = {
  Date: 90, Company: 150, Website: 160, Score: 60, "ICP fit": 60, Timing: 220, Size: 70, Segment: 75, Region: 80,
  "Why now": 340, Signals: 240, Plays: 180, Person: 140, Role: 200, LinkedIn: 180, Email: 210, Verified: 70, Risky: 60,
  "Catch-all": 75, "Enrich email": 150, Label: 75, Reason: 110, Outcome: 100, Notes: 200, Opener: 300, Angle: 260,
  "Email draft": 340, "LinkedIn message": 300, "Follow-up": 320,
};
/** Columns whose text wraps (the reading columns); the rest clip to one line so rows stay short. */
const WRAPPED = ["Timing", "Why now", "Signals"];

/**
 * Formatting of the Leads tab, found by header name (never by position): clears every dropdown on the tab, then puts
 * Label / Reason / Outcome dropdowns and the yes-no ones on their columns, hides ID, bolds and freezes the header.
 * Safe to run any time (after columns move). Returns the columns that got a dropdown.
 */
export async function formatLeadsTab(spreadsheetId: string): Promise<string[]> {
  const meta = await sheetsCall<{ sheets: { properties: { sheetId: number; title: string; gridProperties: { rowCount: number; columnCount: number } } }[] }>(`/${spreadsheetId}?fields=sheets.properties`);
  const tab = meta.sheets.find((s) => s.properties.title === "Leads")?.properties;
  if (!tab) throw new Error("no Leads tab");
  const header = (await sheetsCall<{ values?: string[][] }>(`/${spreadsheetId}/values/${encodeURIComponent("Leads!1:1")}`)).values?.[0] ?? [];
  const at = (c: string) => header.findIndex((h) => h.trim().toLowerCase() === c.toLowerCase());
  const { rowCount, columnCount } = tab.gridProperties;
  const whole = { sheetId: tab.sheetId, startRowIndex: 0, endRowIndex: rowCount, startColumnIndex: 0, endColumnIndex: columnCount };
  const lists: [string, string[]][] = [["Label", LABEL_VALUES], ["Reason", REASON_VALUES], ["Outcome", OUTCOME_VALUES], ["Verified", ["yes", "no"]], ["Risky", ["yes", "no"]], ["Catch-all", ["yes", "no", "unknown"]]];
  const placed = lists.filter(([c]) => at(c) >= 0);
  const id = at("ID");
  await sheetsCall(`/${spreadsheetId}:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({
      requests: [
        { setDataValidation: { range: whole } }, // no rule = clear: removes dropdowns left on old column positions
        { updateDimensionProperties: { range: { sheetId: tab.sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: columnCount }, properties: { hiddenByUser: false }, fields: "hiddenByUser" } },
        ...placed.map(([c, vals]) => ({ setDataValidation: {
          range: { sheetId: tab.sheetId, startRowIndex: 1, endRowIndex: rowCount, startColumnIndex: at(c), endColumnIndex: at(c) + 1 },
          rule: { condition: { type: "ONE_OF_LIST", values: vals.map((v) => ({ userEnteredValue: v })) }, strict: false, showCustomUi: true },
        } })),
        ...(id >= 0 ? [{ updateDimensionProperties: { range: { sheetId: tab.sheetId, dimension: "COLUMNS", startIndex: id, endIndex: id + 1 }, properties: { hiddenByUser: true }, fields: "hiddenByUser" } }] : []),
        // formats left on old column positions (widths, wrapping) are reset, then set per column by name
        { repeatCell: { range: { ...whole, startRowIndex: 1 }, cell: { userEnteredFormat: { wrapStrategy: "CLIP", verticalAlignment: "TOP" } }, fields: "userEnteredFormat" } },
        { repeatCell: { range: { sheetId: tab.sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true }, wrapStrategy: "WRAP", verticalAlignment: "MIDDLE" } }, fields: "userEnteredFormat" } },
        ...header.map((h, i) => ({ updateDimensionProperties: { range: { sheetId: tab.sheetId, dimension: "COLUMNS", startIndex: i, endIndex: i + 1 }, properties: { pixelSize: COLUMN_WIDTH[h.trim()] ?? 140 }, fields: "pixelSize" } })),
        ...WRAPPED.filter((c) => at(c) >= 0).map((c) => ({ repeatCell: { range: { sheetId: tab.sheetId, startRowIndex: 1, endRowIndex: rowCount, startColumnIndex: at(c), endColumnIndex: at(c) + 1 }, cell: { userEnteredFormat: { wrapStrategy: "WRAP" } }, fields: "userEnteredFormat.wrapStrategy" } })),
        { updateSheetProperties: { properties: { sheetId: tab.sheetId, gridProperties: { frozenRowCount: 1, frozenColumnCount: Math.max(0, at("Company") + 1) } }, fields: "gridProperties.frozenRowCount,gridProperties.frozenColumnCount" } },
      ],
    }),
  });
  return placed.map(([c]) => c);
}
