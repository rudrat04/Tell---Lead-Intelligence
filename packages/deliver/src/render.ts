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
  /** latest nightly eval metrics: metric -> value */
  metrics?: Record<string, number>;
}

export interface DigestEmail { subject: string; html: string; text: string }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/** Link targets come from scraped pages: only http(s) and mailto, never javascript: or data: URLs. */
export const safeHref = (u: string | null | undefined): string => (u && /^(https?:\/\/|mailto:)/i.test(u.trim()) ? esc(u.trim()) : "#");
const pct = (x: number) => `${Math.round(x * 100)}%`;
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

function othersHtml(c: Contact | null | undefined): string {
  const others = c?.others ?? [];
  if (!others.length) return "";
  return `<div style="font-size:13px;margin-top:4px">Also: ${others.map((o) => `${o.person.linkedin ? `<a href="${safeHref(o.person.linkedin)}" style="color:#1a56db">${esc(o.person.name)}</a>` : esc(o.person.name)}, ${esc(o.person.role ?? o.persona)}`).join(" · ")}</div>`;
}

function alsoHtml(links: { persona: string; url: string }[]): string {
  if (!links.length) return "";
  return `<div style="font-size:12px;color:#6b7280;margin-top:4px">Also reach: ${links.map((x) => `<a href="${safeHref(x.url)}" style="color:#1a56db">${esc(x.persona)}</a>`).join(" · ")} <span style="color:#9ca3af">(LinkedIn search)</span></div>`;
}

const EMAIL_LABEL = { observed: "seen in public", likely: "likely", guessed: "guessed, unverified", invalid: "" } as const;
/** "jo@acme.com (likely)" for usable addresses; nothing for invalid ones. */
export function emailText(p: Contact["person"]): string | null {
  const e = p.email;
  return e && e.status !== "invalid" ? `${e.address} (${EMAIL_LABEL[e.status]})` : null;
}

function contactLinks(c: Contact): string {
  const e = c.person.email && c.person.email.status !== "invalid" ? c.person.email : null;
  const links = [e && `<a href="mailto:${esc(e.address)}" style="color:#1a56db">${esc(e.address)}</a> <span style="color:#9ca3af">(${EMAIL_LABEL[e.status]})</span>`,
    !e && c.generic && `<a href="mailto:${esc(c.generic)}" style="color:#1a56db">${esc(c.generic)}</a> <span style="color:#9ca3af">(shared inbox)</span>`, c.person.linkedin && `<a href="${safeHref(c.person.linkedin)}" style="color:#1a56db">LinkedIn</a>`, c.person.twitter && `<a href="${safeHref(c.person.twitter)}" style="color:#1a56db">X</a>`].filter(Boolean);
  return links.join(" · ");
}

function leadHtml(l: Lead, i: number, contacts?: Contacts, personas: Pack["icp"]["personas"] = [], notes?: Notes): string {
  const a = l.account, s = l.score;
  const play = s.plays[0];
  const c = contacts?.get(a.id);
  const company = a.name ?? a.domain;
  const n = notes?.get(a.id);
  const open = leadOpener(c, company, s.drivers[0], n);
  const facts = [a.sizeBand && `${a.sizeBand} people`, a.segment?.toUpperCase(), a.region].filter(Boolean).join(" · ");
  const who = c
    ? `<div style="font-size:16px;font-weight:600">${i + 1}. ${esc(c.person.name)}<span style="font-weight:400">, ${esc(c.person.role ?? "")} at</span> <a href="https://${esc(a.domain)}" style="color:#111827;text-decoration:none">${esc(company)}</a></div>
  <div style="font-size:13px;color:#6b7280;margin-top:2px">${contactLinks(c)}${contactLinks(c) ? " · " : ""}${esc(c.persona ?? c.note)} · ${esc(a.domain)}${facts ? ` · ${esc(facts)}` : ""}</div>`
    : `<div style="font-size:16px;font-weight:600">${i + 1}. <a href="https://${esc(a.domain)}" style="color:#111827;text-decoration:none">${esc(company)}</a>
    <span style="font-weight:400;color:#6b7280;font-size:13px">${esc(a.domain)}${facts ? ` · ${esc(facts)}` : ""} · no contact found yet</span></div>`;
  const why = s.drivers.slice(0, 4).map((e) => `<li style="margin:2px 0"><a href="${safeHref(e.url)}" style="color:#1a56db;text-decoration:none">${esc(describe(e))}</a></li>`).join("");
  const plays = s.plays.map((p) => esc(p.title)).join(" + ");
  return `
<tr><td style="padding:16px 0;border-top:1px solid #e5e7eb">
  ${who}
  ${othersHtml(c)}${alsoHtml(personaSearchLinks(personas, a.sizeBand, company, c ?? null))}
  ${open ? `<div style="margin-top:8px;padding:8px 12px;background:#f3f4f6;border-left:3px solid #6366f1;font-size:14px">${esc(open)}</div>` : ""}
  ${plays || !hasHiring(s) ? `<div style="margin-top:4px;font-size:13px">${plays ? `<span style="background:#eef2ff;color:#3730a3;padding:2px 8px;border-radius:10px">${plays}</span>` : ""}${!hasHiring(s) ? ` <span style="background:#ecfdf5;color:#065f46;padding:2px 8px;border-radius:10px">non-hiring signal</span>` : ""}${s.lane === "fast" ? ` <span style="background:#fef3c7;color:#92400e;padding:2px 8px;border-radius:10px">single-source</span>` : ""}</div>` : ""}
  ${n ? `<div style="margin-top:8px;font-size:14px;color:#111827"><b>Why now:</b> ${esc(n.hypothesis)}</div>` : ""}
  <ul style="margin:8px 0 0 18px;padding:0;font-size:14px;color:#111827">${why}</ul>
  ${n || play ? `<div style="margin-top:8px;font-size:14px;color:#374151"><b>Angle:</b> ${esc(n?.angle ?? play!.angle)}</div>` : ""}
  ${n?.counterEvidence ? `<div style="margin-top:4px;font-size:13px;color:#b45309"><b>Watch out:</b> ${esc(n.counterEvidence)}</div>` : ""}
  <div style="margin-top:6px;font-size:12px;color:#9ca3af">priority ${s.priority.toFixed(2)} · intent ${pct(s.intent)} · fit ${pct(s.fit)} · timing ${pct(s.timing)}</div>
</td></tr>`;
}

function leadText(l: Lead, i: number, contacts?: Contacts, personas: Pack["icp"]["personas"] = [], notes?: Notes): string {
  const a = l.account, s = l.score;
  const c = contacts?.get(a.id);
  const n = notes?.get(a.id);
  const open = leadOpener(c, a.name ?? a.domain, s.drivers[0], n);
  return [
    c ? `${i + 1}. ${c.person.name}, ${c.person.role ?? ""} at ${a.name ?? a.domain} (${a.domain})` : `${i + 1}. ${a.name ?? a.domain} (${a.domain}), no contact found yet`,
    c ? `   ${[emailText(c.person) ?? (c.generic ? `${c.generic} (shared inbox)` : null), c.person.linkedin, c.person.twitter].filter(Boolean).join(" | ")}${c.persona ? "" : ` (${c.note})`}` : "",
    `   ${[a.sizeBand && `${a.sizeBand} people`, a.segment, a.region].filter(Boolean).join(", ")}`,
    open ? `   Opener: ${open}` : "",
    ...(c?.others ?? []).map((o) => `   Also: ${o.person.name}, ${o.person.role ?? o.persona}${o.person.linkedin ? ` ${o.person.linkedin}` : ""}`),
    ...personaSearchLinks(personas, a.sizeBand, a.name ?? a.domain, c ?? null).map((x) => `   Also reach ${x.persona}: ${x.url}`),
    !hasHiring(s) ? "   [non-hiring signal]" : "",
    s.plays.length ? `   Plays: ${s.plays.map((p) => p.title).join(" + ")}${s.lane === "fast" ? " [single-source]" : ""}` : "",
    n ? `   Why now: ${n.hypothesis}` : "",
    ...s.drivers.slice(0, 4).map((e) => `   - ${describe(e)}  ${e.url}`),
    n || s.plays[0] ? `   Angle: ${n?.angle ?? s.plays[0]!.angle}` : "",
    n?.counterEvidence ? `   Watch out: ${n.counterEvidence}` : "",
    `   priority ${s.priority.toFixed(2)} | intent ${pct(s.intent)} | fit ${pct(s.fit)} | timing ${pct(s.timing)}`,
  ].filter(Boolean).join("\n");
}

const SOURCE_NAME: Record<string, string> = { remoteok: "Remote OK", himalayas: "Himalayas", hn: "Hacker News", yc: "YC" };

function gigHtml(g: DigestGig): string {
  const meta = [g.company, g.employmentType, g.location].filter(Boolean).map((x) => esc(x!)).join(" · ");
  const via = `via <a href="${safeHref(g.url)}" style="color:#6b7280">${esc(SOURCE_NAME[g.source] ?? g.source)}</a>`;
  return `<li style="margin:6px 0"><a href="${safeHref(g.applyUrl ?? g.url)}" style="color:#111827;font-weight:600">${esc(g.title)}</a><div style="font-size:12px;color:#6b7280">${meta}${meta ? " · " : ""}${via}</div></li>`;
}

export function renderDigest(r: ScoreRunResult, pack: Pack, health: DigestHealth, date: string, contacts?: Contacts, gigs: DigestGig[] = [], notes?: Notes): DigestEmail {
  const leads = r.ranking.leads, watch = r.ranking.watchlist, people = r.personLeads;
  const named = (l: Lead) => { const c = contacts?.get(l.account.id); const co = l.account.name ?? l.account.domain; return c ? `${firstName(c.person.name)} at ${co}` : co; };
  const subject = leads.length
    ? `${leads.length} ${contacts ? (leads.length === 1 ? "person to contact" : "people to contact") : `lead${leads.length === 1 ? "" : "s"}`} for ${date}: ${leads.slice(0, 3).map(named).join(", ")}`
    : `No new leads for ${date}`;
  const subjectFull = gigs.length ? `${subject} + ${gigs.length} gig${gigs.length === 1 ? "" : "s"}` : subject;

  const healthLines = [
    `Job boards checked in the last 24h: ${health.boardsChecked24h} of ${health.boardsTotal}${health.boardsFailing ? ` (${health.boardsFailing} failing)` : ""}`,
    `30-minute ticks in the last 24h: ${health.ticks24h}${health.tickErrors24h ? ` (${health.tickErrors24h} with errors)` : ""}${health.ticks24h < 40 ? " (expected about 48: check the schedule)" : ""}`,
    `Haiku spend today: $${health.haikuTodayUsd.toFixed(3)} of $${health.haikuCapUsd} cap`,
    `Accounts scored: ${r.scored} · held back (source outage): ${r.ranking.held.incomplete} · already sent recently: ${r.ranking.held.recentlyDelivered}`,
    health.indiaTracked != null ? `India: ${health.indiaTracked} Indian companies tracked, ${health.indiaInLeads ?? 0} in today's leads` : "",
    health.usage?.length ? `Free-tier usage: ${health.usage.map((u) => `${u.service.replace(/_/g, " ")} ${Math.round(u.pct * 100)}%${u.pct >= 0.8 ? " (high: retention tightened)" : ""}`).join(", ")}` : "",
    health.metrics && Object.keys(health.metrics).length ? (() => {
      const m = health.metrics!; const p = (k: string) => `${Math.round((m[k] ?? 0) * 100)}%`;
      return `Last 30 days: named contacts ${p("named_contact_rate_30d")}, non-founder ${p("non_founder_contact_rate_30d")}, non-hiring leads ${p("non_hiring_lead_share_30d")}, India ${p("india_share_delivered_30d")} of leads (${p("india_share_tracked")} of tracked), labelled ${m.label_count_30d ?? 0}${(m.label_count_30d ?? 0) > 0 ? `, precision ${p("precision_30d")}` : ""}`;
    })() : "",
    `Config: ${r.configVersion}`,
  ].filter(Boolean);

  const watchHtml = watch.length
    ? `<h3 style="font-size:15px;margin:24px 0 4px">Watchlist</h3><ul style="margin:0 0 0 18px;padding:0;font-size:14px">${watch.map((w) =>
        `<li style="margin:4px 0"><a href="https://${esc(w.account.domain)}" style="color:#111827">${esc(w.account.name ?? w.account.domain)}</a> <span style="color:#6b7280">${esc(w.score.drivers[0] ? describe(w.score.drivers[0]) : "")}</span></li>`).join("")}</ul>`
    : "";
  const peopleHtml = people.length
    ? `<h3 style="font-size:15px;margin:24px 0 4px">Person leads (no company yet; reply in the thread)</h3><ul style="margin:0 0 0 18px;padding:0;font-size:14px">${people.map((p) =>
        `<li style="margin:4px 0">${esc(p.platform)}/${esc(p.handle)}: <a href="${safeHref(p.url)}" style="color:#1a56db">"${esc(p.quote)}"</a></li>`).join("")}</ul>`
    : "";

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f9fafb">
<div style="max-width:680px;margin:0 auto;padding:24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827;background:#ffffff">
  <div style="font-size:13px;color:#6b7280">${esc(pack.meta.name)} · ${esc(date)}</div>
  <h2 style="font-size:20px;margin:4px 0 4px">${leads.length ? `${leads.length} ${leads.length === 1 ? "person" : "people"} to contact today` : "No leads today"}</h2>
  <div style="font-size:13px;color:#6b7280">Ranked by need now × ICP fit × timing. Month one: trust the order more than the percentages, and label what you see.</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:8px">${leads.map((l, i) => leadHtml(l, i, contacts, pack.icp.personas, notes)).join("")}</table>
  ${gigs.length ? `<h3 style="font-size:15px;margin:24px 0 4px">Freelance gigs (${gigs.length})</h3><ul style="margin:0 0 0 18px;padding:0;font-size:14px">${gigs.map(gigHtml).join("")}</ul>` : ""}
  ${watchHtml}${peopleHtml}
  <h3 style="font-size:15px;margin:24px 0 4px">Health</h3>
  <ul style="margin:0 0 0 18px;padding:0;font-size:13px;color:#374151">${healthLines.map((h) => `<li style="margin:2px 0">${esc(h)}</li>`).join("")}</ul>
</div></body></html>`;

  const text = [
    `${pack.meta.name} · ${date}`,
    leads.length ? `TOP ${leads.length} LEADS` : "NO LEADS TODAY",
    "",
    ...leads.map((l, i) => leadText(l, i, contacts, pack.icp.personas, notes) + "\n"),
    gigs.length ? `FREELANCE GIGS\n${gigs.map((g) => `- ${g.title}${g.company ? ` (${g.company})` : ""}: ${g.applyUrl ?? g.url} (via ${SOURCE_NAME[g.source] ?? g.source}: ${g.url})`).join("\n")}\n` : "",
    watch.length ? `WATCHLIST\n${watch.map((w) => `- ${w.account.name ?? w.account.domain} (${w.account.domain})`).join("\n")}\n` : "",
    people.length ? `PERSON LEADS\n${people.map((p) => `- ${p.platform}/${p.handle}: "${p.quote}" ${p.url}`).join("\n")}\n` : "",
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
