import { isSameCompany } from "./contacts.js";

/**
 * The operator's own network (imported locally, never scraped): who they can get introduced to, and past clients who
 * changed jobs. Pure functions; the import script and the digest do the I/O.
 */

export interface NetworkRow {
  kind: "connection" | "client" | "employer";
  fullName: string;
  company: string | null;
  position: string | null;
  profileUrl: string | null;
}

export interface WarmPath {
  kind: "connected" | "client_there" | "connection_there" | "shared_employer" | "champion";
  /** shown in the digest and the Sheet */
  text: string;
}

const normName = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim();
/** linkedin.com/in/<slug>, lowercased, without query or trailing slash */
export const linkedinSlug = (url: string | null | undefined) => url?.match(/linkedin\.com\/in\/([^/?#]+)/i)?.[1]?.toLowerCase() ?? null;

/**
 * How the operator can reach this lead through people they know, strongest first. Rules (never guess):
 *  - the contact is a connection: same LinkedIn profile, or the same full name with the connection's company = this company;
 *  - a past client works there now (their company, or their tracked current company, is this company);
 *  - a connection works there (company match by name or domain label only);
 *  - the contact worked at one of the operator's own past employers (people-search work history).
 */
export function warmPaths(
  contact: { name: string; linkedin?: string | null; workHistory?: { company: string }[] | null } | null,
  account: { name: string | null; domain: string },
  network: (NetworkRow & { currentCompany?: string | null })[],
): WarmPath[] {
  const company = account.name ?? account.domain;
  const here = (c: string | null | undefined) => !!c && isSameCompany(c, company, account.domain);
  const out: WarmPath[] = [];
  if (contact) {
    const slug = linkedinSlug(contact.linkedin);
    const n = normName(contact.name);
    const direct = network.find((r) => r.kind === "connection" && ((slug && linkedinSlug(r.profileUrl) === slug) || (normName(r.fullName) === n && here(r.company))));
    if (direct) out.push({ kind: "connected", text: `You're connected with ${contact.name} on LinkedIn` });
  }
  const notContact = (r: NetworkRow) => !contact || normName(r.fullName) !== normName(contact.name);
  const client = network.find((r) => r.kind === "client" && notContact(r) && (here(r.currentCompany) || (!r.currentCompany && here(r.company))));
  if (client) out.push({ kind: "client_there", text: `Your past client ${client.fullName} works there${client.position ? ` (${client.position})` : ""}: ask for an intro` });
  const conns = network.filter((r) => r.kind === "connection" && notContact(r) && here(r.company));
  if (conns.length) {
    const c = conns[0]!;
    out.push({ kind: "connection_there", text: `You know ${c.fullName}${c.position ? ` (${c.position})` : ""} there${conns.length > 1 ? ` and ${conns.length - 1} more` : ""}: ask for an intro` });
  }
  if (contact?.workHistory?.length) {
    const employers = network.filter((r) => r.kind === "employer");
    for (const e of employers) {
      const hit = contact.workHistory.find((w) => isSameCompany(w.company, e.fullName, e.company ?? ""));
      if (hit) { out.push({ kind: "shared_employer", text: `${contact.name.split(/\s+/)[0]} also worked at ${hit.company}, like you` }); break; }
    }
  }
  return out;
}

type Role = { title: string; company: string; current: boolean; from?: string | null; to?: string | null };

/**
 * A past client's people-search result -> did they move? The hit must be them (same full name, and a role at the
 * company they were your client at), and hold a current role at a different company that started within `maxDays`.
 */
export function championMove(
  client: { fullName: string; company: string },
  hit: { name: string | null; url: string; roles: Role[] },
  now: Date, maxDays = 90,
): { company: string; title: string; from: Date; url: string } | null {
  if (!hit.name || normName(hit.name) !== normName(client.fullName)) return null;
  const was = hit.roles.some((r) => isSameCompany(r.company, client.company, ""));
  if (!was) return null;
  const moves = hit.roles
    .filter((r) => r.current && !isSameCompany(r.company, client.company, "") && r.from)
    .map((r) => ({ company: r.company, title: r.title, from: new Date(r.from!), url: hit.url }))
    .filter((m) => !Number.isNaN(m.from.getTime()) && m.from <= now && now.getTime() - m.from.getTime() <= maxDays * 86_400_000)
    .sort((a, b) => b.from.getTime() - a.from.getTime());
  return moves[0] ?? null;
}

/** Minimal CSV parser (quoted fields, doubled quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') q = false;
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

/**
 * LinkedIn's Connections.csv (Settings > Data privacy > Get a copy of your data): a few "Notes" lines, then a header row
 * First Name, Last Name, URL, Email Address, Company, Position, Connected On. Email addresses are dropped, never stored.
 */
export function parseLinkedInConnections(text: string): NetworkRow[] {
  const rows = parseCsv(text.replace(/^﻿/, ""));
  const h = rows.findIndex((r) => r.some((c) => /^first name$/i.test(c.trim())) && r.some((c) => /^last name$/i.test(c.trim())));
  if (h < 0) throw new Error("no 'First Name,Last Name' header row: is this LinkedIn's Connections.csv?");
  const header = rows[h]!.map((c) => c.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const [fi, li, ui, ci, pi] = [col("first name"), col("last name"), col("url"), col("company"), col("position")];
  return rows.slice(h + 1).map((r) => ({
    kind: "connection" as const,
    fullName: `${r[fi] ?? ""} ${r[li] ?? ""}`.replace(/\s+/g, " ").trim(),
    company: (ci >= 0 ? r[ci]?.trim() : "") || null,
    position: (pi >= 0 ? r[pi]?.trim() : "") || null,
    profileUrl: (ui >= 0 ? r[ui]?.trim() : "") || null,
  })).filter((r) => r.fullName.length >= 2);
}

/** Past clients CSV: header with name, company, and optionally title / linkedin. */
export function parseClients(text: string): NetworkRow[] {
  const [header, ...rows] = parseCsv(text.replace(/^﻿/, ""));
  if (!header) return [];
  const hd = header.map((c) => c.trim().toLowerCase());
  const col = (...names: string[]) => hd.findIndex((c) => names.includes(c));
  const [ni, ci, ti, ui] = [col("name", "full name"), col("company"), col("title", "position", "role"), col("linkedin", "url", "profile")];
  if (ni < 0 || ci < 0) throw new Error("clients CSV needs 'name' and 'company' columns");
  return rows.map((r) => ({
    kind: "client" as const, fullName: (r[ni] ?? "").trim(), company: (r[ci] ?? "").trim() || null,
    position: (ti >= 0 ? r[ti]?.trim() : "") || null, profileUrl: (ui >= 0 ? r[ui]?.trim() : "") || null,
  })).filter((r) => r.fullName.length >= 2 && r.company);
}
