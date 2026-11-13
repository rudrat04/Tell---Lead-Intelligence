import type { Pack } from "@tell/config";
import type { Evidence } from "@tell/intel";
import type { ScoreRunResult, DigestGig } from "@tell/pipeline";
import { firstName, personaSearchLinks, type Contact } from "@tell/people";
import { hasHiring } from "@tell/intel";

/** Daily digest (plan section 10). "Why now" is written by code from cited evidence: free and deterministic. */

export interface DigestHealth {
  boardsChecked24h: number;
  boardsTotal: number;
  boardsFailing: number;
  ticks24h: number;
  tickErrors24h: number;
  haikuTodayUsd: number;
  haikuCapUsd: number;
  /** India coverage (eval requirement): tracked Indian accounts, and how many made today's leads */
  indiaTracked?: number;
  indiaInLeads?: number;
  /** free-tier usage from the nightly usage guard: service -> share of limit */
  usage?: { service: string; pct: number }[];
  /** self-tuning proposals waiting for you (weekly; never applied automatically) */
  tuningPending?: number;
  /** latest nightly eval metrics: metric -> value */
  metrics?: Record<string, number>;
}

export interface DigestEmail { subject: string; html: string; text: string }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/** Link targets come from scraped pages: only http(s) and mailto, never javascript: or data: URLs. */
export const safeHref = (u: string | null | undefined): string => (u && /^(https?:\/\/|mailto:)/i.test(u.trim()) ? esc(u.trim()) : "#");
const ago = (d: number) => (d >= 60 ? `${Math.round(d / 30)} months` : `${Math.round(d)} days`);

/** One human line per piece of evidence. */
export function describe(e: Evidence): string {
  const t = `"${e.quote}"`;
  switch (e.type) {
    case "core_role_open_45d": return `${t} open ${ago(e.openDays ?? 45)}`;
    case "core_role_open": return `Hiring ${t}${e.openDays != null ? `, open ${ago(e.openDays)}` : ""}`;
    case "first_role": return `Founding hire: ${t}`;
    case "contract_role": return `Contract role: ${t}`;
    case "adjacent_role_open": return `Hiring ${t}`;
    case "explicit_hire_request": return `Asked for help: ${t}`;
    case "pain_post": return `Pain in public: ${t}`;
    case "funding_raise": return `Just raised: ${t}`;
    case "product_launch": return e.quote;
    case "cta_sales_led": return e.quote;
    case "pricing_page_added": return e.quote;
    case "gtm_tool_added": return e.quote;
    case "stack_sprawl": return `Tool sprawl: ${e.quote}`;
    default: return `${e.type}: ${t}`;
  }
}

type Lead = ScoreRunResult["ranking"]["leads"][number];
export type Contacts = Map<string, Contact | null>;

/** The opening line, written by code from the strongest evidence: "Hi Riya, saw Bluejay has had a "GTM Engineer" role open for 4 months." */
export function opener(c: Contact | null | undefined, company: string, e: Evidence | undefined): string | null {
  if (!e) return null;
  const t = `"${e.quote}"`;
  const phrase = {
    core_role_open_45d: `saw ${company} has had a ${t} role open for ${ago(e.openDays ?? 45)}`,
    core_role_open: `saw ${company} is hiring a ${t}`,
    first_role: `saw ${company} is making a founding GTM hire (${t})`,
    contract_role: `saw ${company} is looking for a contract ${t}`,
    adjacent_role_open: `saw ${company} is hiring ${t}`,
    explicit_hire_request: `saw your post asking for help: ${t}`,
    pain_post: `saw your post: ${t}`,
    funding_raise: `congrats on the raise (${t})`,
    product_launch: `saw ${company} just launched (${t.replace(/^"Launched: /, '"')})`,
    cta_sales_led: `saw ${company} just switched its site to sales-led (${e.quote.replace(/^Homepage now says /, "")})`,
    pricing_page_added: `saw ${company} just put pricing on the site`,
    gtm_tool_added: `saw ${company} just ${e.quote.replace(/^Added /, "added ").replace(/ \((website|DNS record)\)$/, "")}`,
    stack_sprawl: `noticed ${company} runs ${e.quote.replace(/:.*/, "")}`,
  }[e.type] ?? `saw ${company}: ${t}`;
  return c ? `Hi ${firstName(c.person.name)}, ${phrase}.` : `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}.`;
}

/** Analyst output for a lead (cited, validated in code); absent when Haiku was unavailable or failed validation. */
export interface LeadNote { hypothesis: string; angle: string; opener: string; counterEvidence: string | null; confidence: number; email?: { subject: string; body: string } | null }

/** The opening email as it goes in the Sheet: subject, greeting written by code, body, your signature. Empty without a draft. */
export function emailDraft(c: Contact | null | undefined, n: LeadNote | undefined, signature = ""): string {
  if (!n?.email) return "";
  const hi = c ? `Hi ${firstName(c.person.name)},` : "Hi,";
  return [`Subject: ${n.email.subject}`, "", hi, "", n.email.body.trim(), ...(signature.trim() ? ["", signature.trim()] : [])].join("\n");
}
export type Notes = Map<string, LeadNote>;

/** The analyst's opener when there is one, else the code-written one. The greeting is always written by code. */
export function leadOpener(c: Contact | null | undefined, company: string, e: Evidence | undefined, n: LeadNote | undefined): string | null {
  if (!n) return opener(c, company, e);
  const body = n.opener.replace(/\s+$/, "");
  // lowercase after "Hi X," unless the sentence starts with "I"/"I'm"... or a proper noun such as the company name
  const keepCase = /^I\b/.test(body) || body.toLowerCase().startsWith(company.toLowerCase());
  return c ? `Hi ${firstName(c.person.name)}, ${keepCase ? body : body.charAt(0).toLowerCase() + body.slice(1)}` : `${body.charAt(0).toUpperCase()}${body.slice(1)}`;
}

// ---- digest layout: email-safe (tables, inline styles), one card per lead, nothing said twice ----
const C = { ink: "#18181b", muted: "#71717a", faint: "#a1a1aa", line: "#e4e4e7", link: "#2563eb", bg: "#f4f4f5", card: "#ffffff", quote: "#f4f4f5", accent: "#6366f1", warn: "#b45309" };
const A = (href: string, text: string, style = "") => `<a href="${safeHref(href)}" style="color:${C.link};text-decoration:none;${style}">${text}</a>`;
const regionShort = (r: string | null) => (r === "United States of America" ? "US" : r === "United Kingdom" ? "UK" : r === "United Arab Emirates" ? "UAE" : r);

const EMAIL_LABEL = { observed: "seen in public", likely: "likely", guessed: "guessed", invalid: "" } as const;
/** "jo@acme.com (likely)" for usable addresses; nothing for invalid ones. */
export function emailText(p: Contact["person"]): string | null {
  const e = p.email;
  return e && e.status !== "invalid" ? `${e.address} (${EMAIL_LABEL[e.status]})` : null;
}

/** Ways to reach the contact: email (with how sure we are), shared inbox, LinkedIn, X. */
function reachHtml(c: Contact): string {
  const e = c.person.email && c.person.email.status !== "invalid" ? c.person.email : null;
  const parts = [
    e && `${A(`mailto:${e.address}`, esc(e.address))} <span style="color:${C.faint}">${EMAIL_LABEL[e.status]}</span>`,
    !e && c.generic && `${A(`mailto:${c.generic}`, esc(c.generic))} <span style="color:${C.faint}">shared inbox</span>`,
    c.person.linkedin && A(c.person.linkedin, "LinkedIn"),
    c.person.twitter && A(c.person.twitter, "X"),
  ].filter(Boolean);
  return parts.join(` <span style="color:${C.line}">|</span> `);
}

function leadHtml(l: Lead, i: number, contacts?: Contacts, personas: Pack["icp"]["personas"] = [], notes?: Notes, tap?: { good: string; bad: string }): string {
  const a = l.account, s = l.score;
  const c = contacts?.get(a.id);
  const company = a.name ?? a.domain;
  const n = notes?.get(a.id);
  const open = leadOpener(c, company, s.drivers[0], n);
  const facts = [a.sizeBand && `${a.sizeBand} people`, regionShort(a.region)].filter(Boolean).join(" · ");
  const companyLine = `${A(`https://${a.domain}`, `<b style="color:${C.ink}">${esc(company)}</b>`)}${facts ? ` <span style="color:${C.muted}">· ${esc(facts)}</span>` : ""}`;

  const head = c
    ? `<div style="font-size:17px;font-weight:600;color:${C.ink}">${esc(c.person.name)} <span style="font-weight:400;color:${C.muted};font-size:14px">${esc(c.person.role ?? c.persona ?? "")}</span></div>
       <div style="font-size:14px;margin-top:2px">${companyLine}</div>
       ${reachHtml(c) ? `<div style="font-size:13px;margin-top:6px">${reachHtml(c)}</div>` : ""}
       ${(c.others ?? []).length ? `<div style="font-size:13px;margin-top:4px;color:${C.muted}">Also: ${(c.others ?? []).map((o) => `${o.person.linkedin ? A(o.person.linkedin, esc(o.person.name)) : esc(o.person.name)} (${esc(o.person.role ?? o.persona)})`).join(", ")}</div>` : ""}`
    : `<div style="font-size:17px;font-weight:600">${companyLine}</div>
       <div style="font-size:13px;margin-top:6px;color:${C.muted}">No contact yet. Search: ${personaSearchLinks(personas, a.sizeBand, company, null).slice(0, 2).map((x) => A(x.url, esc(x.persona))).join(", ") || "none"}</div>`;

  // why now: the analyst's sentence with the evidence as sources, or (without it) the evidence itself
  const ev = s.drivers.slice(0, 3);
  const why = n
    ? `<div style="font-size:14px;line-height:1.5;margin-top:12px;color:${C.ink}">${esc(n.hypothesis)}</div>
       <div style="font-size:12px;margin-top:4px;color:${C.muted}">Sources: ${ev.map((e, k) => A(e.url, `${k + 1}. ${esc(describe(e).slice(0, 60))}${describe(e).length > 60 ? "…" : ""}`)).join(" &nbsp; ")}</div>`
    : `<div style="font-size:14px;line-height:1.6;margin-top:12px">${ev.map((e) => `<div>• ${A(e.url, esc(describe(e)), `color:${C.ink}`)}</div>`).join("")}</div>`;

  const opener = open ? `<div style="margin-top:12px;padding:10px 12px;background:${C.quote};border-left:3px solid ${C.accent};border-radius:4px;font-size:14px;line-height:1.5;color:${C.ink}">${esc(open)}</div>` : "";
  const angle = n?.angle ?? s.plays[0]?.angle;
  const pitch = angle ? `<div style="font-size:13px;margin-top:8px;color:${C.muted}"><b style="color:${C.ink}">Pitch:</b> ${esc(angle)}</div>` : "";
  const warn = n?.counterEvidence ? `<div style="font-size:13px;margin-top:4px;color:${C.warn}"><b>Watch out:</b> ${esc(n.counterEvidence)}</div>` : "";
  const chip = (t: string, bg: string, fg: string) => `<span style="display:inline-block;margin:2px 4px 0 0;padding:2px 8px;border-radius:10px;background:${bg};color:${fg};font-size:12px">${esc(t)}</span>`;
  const tags = [...s.plays.map((p) => chip(p.title, "#eef2ff", "#3730a3")), !hasHiring(s) ? chip("not hiring-based", "#ecfdf5", "#065f46") : "", s.lane === "fast" ? chip("single source", "#fef3c7", "#92400e") : ""].join("");
  const btn = (href: string, t: string, col: string) => `<a href="${safeHref(href)}" style="display:inline-block;padding:6px 14px;margin-left:6px;border:1px solid ${col};border-radius:16px;color:${col};text-decoration:none;font-size:13px;font-weight:600">${t}</a>`;

  return `
<tr><td style="padding:20px 0;border-top:1px solid ${C.line}">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
    <td width="28" valign="top" style="font-size:13px;font-weight:700;color:${C.faint};padding-top:3px">${i + 1}</td>
    <td valign="top">
      ${head}${why}${opener}${pitch}${warn}
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:10px"><tr>
        <td valign="middle">${tags}</td>
        ${tap ? `<td valign="middle" align="right" style="white-space:nowrap">${btn(tap.good, "👍&nbsp; Good", "#047857")}${btn(tap.bad, "👎&nbsp; Bad", "#b91c1c")}</td>` : ""}
      </tr></table>
    </td>
  </tr></table>
</td></tr>`;
}

function leadText(l: Lead, i: number, contacts?: Contacts, personas: Pack["icp"]["personas"] = [], notes?: Notes): string {
  const a = l.account, s = l.score;
  const c = contacts?.get(a.id);
  const n = notes?.get(a.id);
  const company = a.name ?? a.domain;
  const open = leadOpener(c, company, s.drivers[0], n);
  const facts = [a.sizeBand && `${a.sizeBand} people`, regionShort(a.region)].filter(Boolean).join(", ");
  const angle = n?.angle ?? s.plays[0]?.angle;
  return [
    c ? `${i + 1}. ${c.person.name}, ${c.person.role ?? c.persona ?? ""} at ${company} (${a.domain}${facts ? `, ${facts}` : ""})` : `${i + 1}. ${company} (${a.domain}${facts ? `, ${facts}` : ""}), no contact found yet`,
    c ? `   ${[emailText(c.person) ?? (c.generic ? `${c.generic} (shared inbox)` : null), c.person.linkedin, c.person.twitter].filter(Boolean).join(" | ")}` : "",
    ...(c?.others ?? []).map((o) => `   Also: ${o.person.name}, ${o.person.role ?? o.persona}${o.person.linkedin ? ` ${o.person.linkedin}` : ""}`),
    ...(c ? [] : personaSearchLinks(personas, a.sizeBand, company, null).slice(0, 2).map((x) => `   Search ${x.persona}: ${x.url}`)),
    n ? `   Why now: ${n.hypothesis}` : "",
    ...s.drivers.slice(0, 3).map((e) => `   - ${describe(e)}  ${e.url}`),
    open ? `   Opener: ${open}` : "",
    angle ? `   Angle: ${angle}` : "",
    n?.counterEvidence ? `   Watch out: ${n.counterEvidence}` : "",
    s.plays.length ? `   Plays: ${s.plays.map((p) => p.title).join(" + ")}${s.lane === "fast" ? " [single source]" : ""}` : "",
  ].filter(Boolean).join("\n");
}

const SOURCE_NAME: Record<string, string> = { remoteok: "Remote OK", himalayas: "Himalayas", hn: "Hacker News", yc: "YC" };

function gigHtml(g: DigestGig): string {
  const meta = [g.company, g.employmentType, g.location].filter(Boolean).map((x) => esc(x!)).join(" · ");
  const via = `via <a href="${safeHref(g.url)}" style="color:${C.muted}">${esc(SOURCE_NAME[g.source] ?? g.source)}</a>`;
  return `<div style="margin:8px 0">${A(g.applyUrl ?? g.url, esc(g.title), `color:${C.ink};font-weight:600`)}<div style="font-size:12px;color:${C.muted}">${meta}${meta ? " · " : ""}${via}</div></div>`;
}

export function renderDigest(r: ScoreRunResult, pack: Pack, health: DigestHealth, date: string, contacts?: Contacts, gigs: DigestGig[] = [], notes?: Notes, labels?: Map<string, { good: string; bad: string }>): DigestEmail {
  const leads = r.ranking.leads, watch = r.ranking.watchlist, people = r.personLeads;
  const named = (l: Lead) => { const c = contacts?.get(l.account.id); const co = l.account.name ?? l.account.domain; return c ? `${firstName(c.person.name)} at ${co}` : co; };
  const subject = leads.length
    ? `${leads.length} ${contacts ? (leads.length === 1 ? "person to contact" : "people to contact") : `lead${leads.length === 1 ? "" : "s"}`} for ${date}: ${leads.slice(0, 3).map(named).join(", ")}`
    : `No new leads for ${date}`;
  const subjectFull = gigs.length ? `${subject} + ${gigs.length} gig${gigs.length === 1 ? "" : "s"}` : subject;

  // health: one quiet summary line; separate lines only for things that need attention
  const m = health.metrics ?? {};
  const summary = [
    `${health.boardsChecked24h}/${health.boardsTotal} job boards checked`,
    `${health.ticks24h} ticks`,
    `Haiku $${health.haikuTodayUsd.toFixed(3)} of $${health.haikuCapUsd.toFixed(2)}`,
    health.indiaTracked != null ? `India ${health.indiaTracked} tracked, ${health.indiaInLeads ?? 0} today` : "",
    `${m.label_count_30d ?? 0} labelled (30d)${(m.label_count_30d ?? 0) > 0 ? `, ${Math.round((m.precision_30d ?? 0) * 100)}% good` : ""}`,
  ].filter(Boolean).join(" · ");
  const alerts = [
    health.ticks24h < 40 ? `Only ${health.ticks24h} ticks in 24h (expected about 48: check the schedule)` : "",
    health.tickErrors24h ? `${health.tickErrors24h} ticks with errors in 24h` : "",
    health.boardsFailing && health.boardsTotal && health.boardsFailing / health.boardsTotal >= 0.05 ? `${health.boardsFailing} job boards failing` : "",
    r.ranking.held.incomplete ? `${r.ranking.held.incomplete} accounts held back (a source is down)` : "",
    ...(health.usage ?? []).filter((u) => u.pct >= 0.8).map((u) => `${u.service.replace(/_/g, " ")} at ${Math.round(u.pct * 100)}% of the free tier (retention tightened)`),
    health.tuningPending ? `${health.tuningPending} weight change${health.tuningPending === 1 ? "" : "s"} proposed from your labels: run pnpm tune --show --dry` : "",
  ].filter(Boolean);
  const healthLines = [...alerts, summary, `Config ${r.configVersion}`];

  const section = (title: string, body: string) => `<div style="margin-top:28px"><div style="font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${C.muted};margin-bottom:6px">${title}</div>${body}</div>`;
  const watchHtml = watch.length ? section("Watchlist", watch.map((w) =>
    `<div style="font-size:13px;margin:4px 0">${A(`https://${w.account.domain}`, esc(w.account.name ?? w.account.domain), `color:${C.ink};font-weight:600`)} <span style="color:${C.muted}">${esc(w.score.drivers[0] ? describe(w.score.drivers[0]) : "")}</span></div>`).join("")) : "";
  const peopleHtml = people.length ? section("People asking, no company yet", people.map((p) =>
    `<div style="font-size:13px;margin:4px 0">${esc(p.platform)}/${esc(p.handle)}: ${A(p.url, `"${esc(p.quote)}"`)}</div>`).join("")) : "";

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(subjectFull)}</title></head>
<body style="margin:0;padding:0;background:${C.bg}">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${C.bg}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:${C.card};border-radius:12px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${C.ink}">
<tr><td style="padding:24px 24px 4px">
  <div style="font-size:12px;color:${C.muted}">${esc(pack.meta.name)} · ${esc(date)}</div>
  <div style="font-size:22px;font-weight:700;margin-top:4px">${leads.length ? `${leads.length} ${leads.length === 1 ? "person" : "people"} to contact` : "No new leads today"}</div>
  ${labels?.size ? `<div style="font-size:13px;color:${C.muted};margin-top:4px">Tap 👍&nbsp;or&nbsp;👎 on each lead. It teaches the ranking what you want.</div>` : ""}
</td></tr>
<tr><td style="padding:8px 24px 0">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0">${leads.map((l, i) => leadHtml(l, i, contacts, pack.icp.personas, notes, labels?.get(l.account.id))).join("")}</table>
  ${gigs.length ? section(`Freelance gigs (${gigs.length})`, gigs.map(gigHtml).join("")) : ""}
  ${watchHtml}${peopleHtml}
</td></tr>
<tr><td style="padding:24px;font-size:11px;line-height:1.6;color:${C.faint}">
  ${alerts.map((x) => `<div style="color:${C.warn};font-size:12px">⚠ ${esc(x)}</div>`).join("")}
  <div>${esc(summary)}</div>
  <div>${esc(`Config ${r.configVersion}`)}</div>
</td></tr>
</table></td></tr></table></body></html>`;

  const text = [
    `${pack.meta.name} · ${date}`,
    leads.length ? `${leads.length} ${leads.length === 1 ? "PERSON" : "PEOPLE"} TO CONTACT` : "NO NEW LEADS TODAY",
    "",
    ...leads.map((l, i) => leadText(l, i, contacts, pack.icp.personas, notes) + "\n"),
    gigs.length ? `FREELANCE GIGS\n${gigs.map((g) => `- ${g.title}${g.company ? ` (${g.company})` : ""}: ${g.applyUrl ?? g.url} (via ${SOURCE_NAME[g.source] ?? g.source}: ${g.url})`).join("\n")}\n` : "",
    watch.length ? `WATCHLIST\n${watch.map((w) => `- ${w.account.name ?? w.account.domain} (${w.account.domain})`).join("\n")}\n` : "",
    people.length ? `PEOPLE ASKING, NO COMPANY YET\n${people.map((p) => `- ${p.platform}/${p.handle}: "${p.quote}" ${p.url}`).join("\n")}\n` : "",
    "HEALTH",
    ...healthLines.map((h) => `- ${h}`),
  ].join("\n");

  return { subject: subjectFull, html, text };
}

/** The Sheet row for a delivered lead, in LEAD_COLUMNS order minus ID (appended when the delivery id exists). */
export function leadSheetRow(l: Lead, contact: Contact | null | undefined, date: string, note?: LeadNote, signature = ""): string[] {
  const a = l.account, s = l.score;
  const company = a.name ?? a.domain;
  return [
    date,
    contact?.person.name ?? "",
    contact?.person.role ?? "",
    [contact && emailText(contact.person), contact?.person.linkedin ?? contact?.person.twitter].filter(Boolean).join("\n"),
    company,
    `https://${a.domain}`,
    a.sizeBand ?? "",
    a.segment ?? "",
    a.region ?? "",
    s.plays.map((p) => p.title).join(" + "),
    s.drivers.slice(0, 3).map((e) => `${describe(e)} (${e.url})`).join("\n"),
    leadOpener(contact, company, s.drivers[0], note) ?? "",
    note?.angle ?? s.plays[0]?.angle ?? "",
    s.priority.toFixed(3),
    "", "", "", "", // Label, Reason, Outcome, Notes: yours
    // (the hidden ID column is inserted here when the row is appended)
    emailDraft(contact, note, signature),
  ];
}

export function gigSheetRow(g: DigestGig, date: string): string[] {
  return [date, g.title, g.company ?? "", g.employmentType ?? "", g.location ?? "", g.applyUrl ?? g.url, `${SOURCE_NAME[g.source] ?? g.source}: ${g.url}`, "", "", g.id];
}
