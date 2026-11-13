import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { r2, type Pack } from "@tell/config";
import { getDb, people, emails, deliveries, suppressionList, deletionRequests, accounts, and, eq, inArray, sql } from "@tell/db";
import { googleAccessToken } from "@tell/deliver";

/**
 * Deletion request (plan section 9; GDPR / India DPDP): remove a person's data everywhere we hold it, then suppress
 * them. Neon (people, emails, names inside stored Sheet rows), the leads Sheet (their cells are cleared), and every
 * R2 backup. Their email is kept only as a SHA-256 hash in suppression_list, so we never contact them again without
 * keeping their details.
 */
export interface ForgetRequest { name?: string; email?: string; domain?: string; suppressDomain?: boolean }
export interface ForgetResult { people: number; emails: number; deliveryRows: number; sheetCells: number; backupFiles: number; suppressed: boolean }

export const hashEmail = (e: string) => createHash("sha256").update(e.trim().toLowerCase()).digest("hex");

/** Replace a name inside a stored Sheet row (array of cells). Exported for tests. */
export function scrubRow(row: unknown, name: string): unknown {
  if (!Array.isArray(row)) return row;
  return row.map((c) => (typeof c === "string" && c.includes(name) ? c.split(name).join("[removed]") : c));
}

export async function forgetPerson(req: ForgetRequest, pack: Pack): Promise<ForgetResult> {
  if (!req.name && !req.email) throw new Error("give --name (with --domain) and/or --email");
  const db = getDb();
  const res: ForgetResult = { people: 0, emails: 0, deliveryRows: 0, sheetCells: 0, backupFiles: 0, suppressed: false };

  // which people rows
  const accountIds = req.domain ? (await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.domain, req.domain.toLowerCase()))).map((r) => r.id) : [];
  const byEmail = req.email ? (await db.select({ pid: emails.personId }).from(emails).where(sql`lower(${emails.address}) = ${req.email.toLowerCase()}`)).map((r) => r.pid) : [];
  const byName = req.name
    ? (await db.select({ id: people.id }).from(people).where(accountIds.length ? and(eq(people.fullName, req.name), inArray(people.accountId, accountIds)) : eq(people.fullName, req.name))).map((r) => r.id)
    : [];
  const ids = [...new Set([...byEmail, ...byName])];
  const names = ids.length ? (await db.select({ n: people.fullName }).from(people).where(inArray(people.id, ids))).map((r) => r.n) : [];
  if (req.name) names.push(req.name);
  const allNames = [...new Set(names)];

  if (ids.length) {
    res.emails = (await db.delete(emails).where(inArray(emails.personId, ids)).returning({ id: emails.id })).length;
    res.people = (await db.delete(people).where(inArray(people.id, ids)).returning({ id: people.id })).length;
  }
  if (req.email) res.emails += (await db.delete(emails).where(sql`lower(${emails.address}) = ${req.email.toLowerCase()}`).returning({ id: emails.id })).length;

  // names inside stored Sheet rows
  for (const n of allNames) {
    const rows = await db.select({ id: deliveries.id, row: deliveries.sheetRow }).from(deliveries).where(sql`${deliveries.sheetRow}::text like ${"%" + n + "%"}`);
    for (const r of rows) {
      await db.update(deliveries).set({ sheetRow: scrubRow(r.row, n) }).where(eq(deliveries.id, r.id));
      res.deliveryRows++;
    }
  }

  // the leads Sheet: clear cells that contain the name
  const sheetId = pack.delivery.sheet.spreadsheet_id;
  if (sheetId && allNames.length) {
    const token = await googleAccessToken();
    const api = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values`;
    for (const tab of ["Leads", "Gigs"]) {
      const j = (await (await fetch(`${api}/${encodeURIComponent(`${tab}!A:Z`)}`, { headers: { authorization: `Bearer ${token}` } })).json()) as { values?: string[][] };
      const data: { range: string; values: string[][] }[] = [];
      (j.values ?? []).forEach((row, ri) => row.forEach((cell, ci) => {
        if (ri > 0 && allNames.some((n) => cell.includes(n))) data.push({ range: `${tab}!${String.fromCharCode(65 + ci)}${ri + 1}`, values: [[allNames.reduce((c, n) => c.split(n).join("[removed]"), cell)]] });
      }));
      if (data.length) {
        await fetch(`${api}:batchUpdate`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ valueInputOption: "RAW", data }) });
        res.sheetCells += data.length;
      }
    }
  }

  // every R2 backup (daily + monthly): drop their people/email rows, scrub names in stored rows
  try {
    const bucket = r2();
    const files = (await bucket.list("backups/")).filter((o) => /\/(people|deliveries|emails)\.json\.gz$/.test(o.key));
    for (const f of files) {
      const raw = await bucket.get(f.key);
      if (!raw) continue;
      const doc = JSON.parse(gunzipSync(raw).toString()) as { rows: Record<string, unknown>[] };
      const before = JSON.stringify(doc.rows);
      doc.rows = doc.rows
        .filter((r) => !(ids.includes(String(r.id)) || ids.includes(String(r.person_id)) || (req.email && String(r.address ?? "").toLowerCase() === req.email.toLowerCase())))
        .map((r) => (r.sheet_row ? { ...r, sheet_row: allNames.reduce((row, n) => scrubRow(row, n), r.sheet_row as unknown) } : r));
      if (JSON.stringify(doc.rows) !== before) {
        await bucket.put(f.key, gzipSync(Buffer.from(JSON.stringify(doc))), "application/gzip");
        res.backupFiles++;
      }
    }
  } catch { /* R2 not configured */ }

  // suppress (hash only) and record the request
  if (req.email || req.suppressDomain) {
    await db.insert(suppressionList).values({ hashedEmail: req.email ? hashEmail(req.email) : null, domain: req.suppressDomain ? req.domain?.toLowerCase() ?? null : null }).onConflictDoNothing();
    res.suppressed = true;
  }
  await db.insert(deletionRequests).values({ hashedEmail: hashEmail(req.email ?? `name:${req.name}@${req.domain ?? ""}`), completedAt: new Date() });
  return res;
}
