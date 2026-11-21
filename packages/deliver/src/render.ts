import type { Pack } from "@tell/config";
import { emailCells, type LeadRow } from "./sheets.js";
import type { Evidence } from "@tell/intel";
import type { ScoreRunResult, DigestGig, ChampionMove } from "@tell/pipeline";
import { firstName, personaSearchLinks, type Contact } from "@tell/people";
import { hasHiring, displayScore, sendWindow, sendWindowText, type SendWindow } from "@tell/intel";

/** Daily digest (plan section 10). "Why now" is written by code from cited evidence: free and deterministic. */

/** Services the nightly usage guard (ops/usage.ts) measures against a free-tier limit; 80%+ halves retention (janitor).
 * Every other usage_daily service is a spend cap a job counts against (serper, jsearch, exa_champion): reaching it
 * is the cap working, not a free-tier problem, and changes no retention. */
export const FREE_TIER_SERVICES = { neonStorage: "neon_storage_gb", r2Storage: "r2_storage_gb", exaSearches: "exa_searches_month" } as const;
const FREE_TIER = new Set<string>(Object.values(FREE_TIER_SERVICES));

export interface DigestHealth {
  boardsChecked24h: number;
  boardsTotal: number;
  boardsFailing: number;
  ticks24h: number;
  tickErrors24h: number;
  haikuTodayUsd: number;
  haikuCapUsd: number;
  /** the Sonnet writer (analyst drafts), its own daily cap */
  writerTodayUsd?: number;
  writerCapUsd?: number;
  /** India coverage (eval requirement): tracked Indian accounts, and how many made today's leads */
  indiaTracked?: number;
  indiaInLeads?: number;
  /** usage_daily readings, service -> share of limit: the nightly usage guard (FREE_TIER_SERVICES) and spend caps (serper, jsearch, ...) */
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
    case "tool_overlap": return `Overlapping tools: ${e.quote}`;
    case "role_reposted": return `Reposted: "${e.quote}"`;
    case "ops_owner_known": case "ops_team_2plus": case "leaky_capture": case "has_gtm_agency": case "new_gtm_leader": case "ops_person_left": case "marketing_subdomain": case "outbound_domain": return e.quote;
    case "jd_mentions": return `Job ad says: ${e.quote}`;
    case "role_gap": return `${e.quote} (people search: check their team page before you write)`;
    case "champion_moved": case "freeze_to_contract": case "email_auth_gap": case "attribution_gap": case "site_health_poor": case "content_motion": return e.quote;
    default: return `${e.type}: ${t}`;
  }
}

type Lead = ScoreRunResult["ranking"]["leads"][number];

/** The digest's day ("2026-11-16") as a date, at noon UTC so the calendar day is the same in IST. */
const dayDate = (date: string) => new Date(`${date}T12:00:00Z`);
const windowFor = (l: Lead, date: string, pack: Pack) => sendWindow(l.score.evidence, dayDate(date), pack.icp.calendar);
/** A contact worth a find-email click: named, and no address seen in public or verified yet. */
export const needsEmail = (c: Contact | null | undefined) => !!c && c.person.email?.status !== "observed" && c.person.email?.status !== "verified";
const WHEN_COLOR: Record<SendWindow["band"], string> = { now: "#047857", good: "#1d4ed8", wait: "#6b7280" };
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
export interface LeadNote { hypothesis: string; angle: string; opener: string; counterEvidence: string | null; confidence: number; email?: { subject: string; body: string } | null; linkedin?: string | null; /** the intelligence brief the email offers */ brief?: string }

/** The pack's greeting with the contact's first name ("hey {first}," -> "hey Asha,"); without a contact the name goes. */
export function greeting(template: string, c: Contact | null | undefined): string {
  return c ? template.replaceAll("{first}", firstName(c.person.name)) : template.replace(/\s*\{first\}/g, "");
}

/** The opening email as it goes in the Sheet: subject, greeting written by code, body, your signature. Empty without a draft. */
export function emailDraft(c: Contact | null | undefined, n: LeadNote | undefined, signature = "", hello = "Hi {first},"): string {
  if (!n?.email) return "";
  return [`Subject: ${n.email.subject}`, "", greeting(hello, c), "", n.email.body.trim(), ...(signature.trim() ? ["", signature.trim()] : [])].join("\n");
}

/** The first LinkedIn message (after they accept), greeting written by code. Empty without a checked draft. */
export function linkedinDraft(c: Contact | null | undefined, n: LeadNote | undefined, hello = "Hi {first},"): string {
  if (!n?.linkedin) return "";
  return `${greeting(hello, c)}\n\n${n.linkedin.trim()}`;
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

const EMAIL_LABEL: Record<NonNullable<Contact["person"]["email"]>["status"], string> = { observed: "seen in public", verified: "verified", likely: "likely", guessed: "guessed", invalid: "" };
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
    !e && !c.generic && `<span style="color:${C.faint}">No email found</span>`,
    c.person.linkedin && A(c.person.linkedin, "LinkedIn"),
    c.person.twitter && A(c.person.twitter, "X"),
  ].filter(Boolean);
  return parts.join(` <span style="color:${C.line}">|</span> `);
}

/** The need check's finding ("Missing: GTM, Product Marketing", "has Founder's Office: ..."), when there is one. */
export function gapLine(s: Lead["score"]): { missing: string; has: string } | null {
  const g = s.evidence.find((e) => e.type === "role_gap");
  if (!g) return null;
  const [missing, has] = g.quote.split(" · ");
  return { missing: missing ?? g.quote, has: has ?? "" };
}

/** "Score 68 = need 34 · fit 16 · timing 12 · buyer 6": what the number is made of. */
export const scoreLine = (s: Lead["score"]) => {
  const j = s.judged;
  if (j) {
    // judged mode: the ratings behind the number, the reply rate learned from your labels, exploration
    const r = j.rubric;
    const learned = j.learnedRate == null ? "learned: not enough labels yet" : `learned reply rate ${Math.round(j.learnedRate * 100)}%`;
    return `Score ${displayScore(s)} = opportunity ${Math.round(s.parts.need + s.parts.timing)} (specific ${r.specific} · urgent ${r.urgent} · prize ${r.prize} · deliverable ${r.deliverable}, of 5) · ${learned} (${Math.round(s.parts.fit)}) · reach ${Math.round(s.parts.buyer)}${j.exploring ? " · exploring a new industry" : ""}`;
  }
  return `Score ${displayScore(s)} = need ${Math.round(s.parts.need)} · fit ${Math.round(s.parts.fit)} · timing ${Math.round(s.parts.timing)} · buyer ${Math.round(s.parts.buyer)}`;
};

/** The buyer's department, from buyers.yaml, for the name line. */
const buyerDept = (c: Contact | null | undefined, personas: Pack["icp"]["personas"]) => (c?.persona ? personas.find((p) => p.title === c.persona)?.department : undefined);

function leadHtml(l: Lead, i: number, contacts?: Contacts, personas: Pack["icp"]["personas"] = [], notes?: Notes, tap?: { good: string; bad: string; enrich?: string }, when?: SendWindow): string {
  const a = l.account, s = l.score;
  const c = contacts?.get(a.id);
  const company = a.name ?? a.domain;
  const n = notes?.get(a.id);
  const open = leadOpener(c, company, s.drivers[0], n);
  const facts = [a.sizeBand && `${a.sizeBand} people`, regionShort(a.region)].filter(Boolean).join(" · ");
  const companyLine = `${A(`https://${a.domain}`, `<b style="color:${C.ink}">${esc(company)}</b>`)}${facts ? ` <span style="color:${C.muted}">· ${esc(facts)}</span>` : ""}`;

  const head = c
    ? `<div style="font-size:17px;font-weight:600;color:${C.ink}">${esc(c.person.name)} <span style="font-weight:400;color:${C.muted};font-size:14px">${esc(c.person.role ?? c.persona ?? "")}${buyerDept(c, personas) ? ` · ${esc(buyerDept(c, personas)!)}` : ""}</span></div>
       <div style="font-size:14px;margin-top:2px">${companyLine}</div>
       ${reachHtml(c) ? `<div style="font-size:13px;margin-top:6px">${reachHtml(c)}</div>` : ""}
       ${c.warm?.length ? `<div style="font-size:13px;margin-top:4px;color:${C.ink}">🤝 ${esc(c.warm[0]!.text)}</div>` : ""}
       ${(c.others ?? []).length ? `<div style="font-size:13px;margin-top:4px;color:${C.muted}">Also: ${(c.others ?? []).map((o) => `${o.person.linkedin ? A(o.person.linkedin, esc(o.person.name)) : esc(o.person.name)} (${esc(o.person.role ?? o.persona)})`).join(", ")}</div>` : ""}`
    : `<div style="font-size:17px;font-weight:600">${companyLine}</div>
       <div style="font-size:13px;margin-top:6px;color:${C.muted}">No contact yet. Search: ${personaSearchLinks(personas, a.sizeBand, company, null).slice(0, 2).map((x) => A(x.url, esc(x.persona))).join(", ") || "none"}</div>`;

  // the need check, as in "Missing: GTM, Product Marketing · has Founder's Office: ..."
  const gap = gapLine(s);
  const gapHtml = gap ? `<div style="font-size:14px;margin-top:8px"><b style="color:#b91c1c">${esc(gap.missing)}</b>${gap.has ? ` <span style="color:${C.muted}">· ${esc(gap.has)}</span>` : ""}</div>` : "";
  const scoreHtml = `<div style="font-size:12px;margin-top:6px;color:${C.faint}">${esc(scoreLine(s))}</div>`;
  // why now: the analyst's sentence with the evidence as sources, or (without it) the evidence itself
  const ev = s.drivers.filter((e) => e.type !== "role_gap").slice(0, 3);
  const why = n
    ? `<div style="font-size:14px;line-height:1.5;margin-top:12px;color:${C.ink}">${esc(n.hypothesis)}</div>
       <div style="font-size:12px;margin-top:4px;color:${C.muted}">Sources: ${ev.map((e, k) => A(e.url, `${k + 1}. ${esc(describe(e).slice(0, 60))}${describe(e).length > 60 ? "…" : ""}`)).join(" &nbsp; ")}</div>`
    : `<div style="font-size:14px;line-height:1.6;margin-top:12px">${ev.map((e) => `<div>• ${A(e.url, esc(describe(e)), `color:${C.ink}`)}</div>`).join("")}</div>`;

  const back = l.backReason ? `<div style="font-size:13px;margin-top:10px;color:${C.accent}"><b>Back on your list.</b> ${esc(l.backReason)}</div>` : "";
  // when to write: a separate label, not part of the score
  const whenCol = when ? WHEN_COLOR[when.band] : C.muted;
  const whenHtml = when ? `<div style="font-size:13px;margin-top:8px"><span style="display:inline-block;padding:1px 8px;border-radius:10px;border:1px solid ${whenCol};color:${whenCol};font-weight:600">${esc(when.label)}</span>${when.reasons.length ? ` <span style="color:${C.muted}">${esc(when.reasons.join("; "))}</span>` : ""}</div>` : "";
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
      ${head}${gapHtml}${scoreHtml}${whenHtml}${back}${why}${opener}${pitch}${warn}
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:10px"><tr>
        <td valign="middle">${tags}</td>
        ${tap ? `<td valign="middle" align="right" style="white-space:nowrap">${tap.enrich && needsEmail(c) ? btn(tap.enrich, "✉️&nbsp; Find email", "#1d4ed8") : ""}${btn(tap.good, "👍&nbsp; Good", "#047857")}${btn(tap.bad, "👎&nbsp; Bad", "#b91c1c")}</td>` : ""}
      </tr></table>
    </td>
  </tr></table>
</td></tr>`;
}

function leadText(l: Lead, i: number, contacts?: Contacts, personas: Pack["icp"]["personas"] = [], notes?: Notes, when?: SendWindow): string {
  const a = l.account, s = l.score;
  const c = contacts?.get(a.id);
  const n = notes?.get(a.id);
  const company = a.name ?? a.domain;
  const open = leadOpener(c, company, s.drivers[0], n);
  const facts = [a.sizeBand && `${a.sizeBand} people`, regionShort(a.region)].filter(Boolean).join(", ");
  const angle = n?.angle ?? s.plays[0]?.angle;
  return [
    c ? `${i + 1}. ${c.person.name}, ${c.person.role ?? c.persona ?? ""} at ${company} (${a.domain}${facts ? `, ${facts}` : ""})` : `${i + 1}. ${company} (${a.domain}${facts ? `, ${facts}` : ""}), no contact found yet`,
    c ? `   ${[emailText(c.person) ?? (c.generic ? `${c.generic} (shared inbox)` : "No email found"), c.person.linkedin, c.person.twitter].filter(Boolean).join(" | ")}` : "",
    c?.warm?.length ? `   Warm path: ${c.warm[0]!.text}` : "",
    ...(c?.others ?? []).map((o) => `   Also: ${o.person.name}, ${o.person.role ?? o.persona}${o.person.linkedin ? ` ${o.person.linkedin}` : ""}`),
    ...(c ? [] : personaSearchLinks(personas, a.sizeBand, company, null).slice(0, 2).map((x) => `   Search ${x.persona}: ${x.url}`)),
    gapLine(s) ? `   ${[gapLine(s)!.missing, gapLine(s)!.has].filter(Boolean).join(" · ")}` : "",
    `   ${scoreLine(s)}`,
    when ? `   When: ${sendWindowText(when)}` : "",
    l.backReason ? `   Back on your list. ${l.backReason}` : "",
    n ? `   Why now: ${n.hypothesis}` : "",
    ...s.drivers.filter((e) => e.type !== "role_gap").slice(0, 3).map((e) => `   - ${describe(e)}  ${e.url}`),
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

/** A past lead with a new fact (runFollowups' TouchBack, without the id). */
export interface TouchBackLine { company: string; domain: string; person: string; daysSince: number; fact: string; url: string; drafted: boolean }

export function renderDigest(r: ScoreRunResult, pack: Pack, health: DigestHealth, date: string, contacts?: Contacts, gigs: DigestGig[] = [], notes?: Notes, labels?: Map<string, { good: string; bad: string; enrich?: string }>, champions: ChampionMove[] = [], touchBacks: TouchBackLine[] = []): DigestEmail {
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
    health.writerCapUsd != null ? `Sonnet $${(health.writerTodayUsd ?? 0).toFixed(3)} of $${health.writerCapUsd.toFixed(2)}` : "",
    health.indiaTracked != null ? `India ${health.indiaTracked} tracked, ${health.indiaInLeads ?? 0} today` : "",
    pack.delivery.digest.min_score > 0 && r.belowMinScore ? `${r.belowMinScore} under score ${pack.delivery.digest.min_score} not sent` : "",
    `${m.label_count_30d ?? 0} labelled (30d)${(m.label_count_30d ?? 0) > 0 ? `, ${Math.round((m.precision_30d ?? 0) * 100)}% good` : ""}`,
    ...(health.usage ?? []).filter((u) => !FREE_TIER.has(u.service) && u.pct >= 1).map((u) => `${u.service.replace(/_/g, " ")} cap reached`),
  ].filter(Boolean).join(" · ");
  const alerts = [
    health.ticks24h < 40 ? `Only ${health.ticks24h} ticks in 24h (expected about 48: check the schedule)` : "",
    // a stray timeout is retried and caught up by the next tick: warn only when it is a pattern (10% or more of ticks)
    health.tickErrors24h && health.tickErrors24h >= Math.max(1, 0.1 * (health.ticks24h || 1)) ? `${health.tickErrors24h} ticks with errors in 24h` : "",
    health.boardsFailing && health.boardsTotal && health.boardsFailing / health.boardsTotal >= 0.05 ? `${health.boardsFailing} job boards failing` : "",
    r.ranking.held.incomplete ? `${r.ranking.held.incomplete} accounts held back (a source is down)` : "",
    ...(health.usage ?? []).filter((u) => FREE_TIER.has(u.service) && u.pct >= 0.8).map((u) => `${u.service.replace(/_/g, " ")} at ${Math.round(u.pct * 100)}% of the free tier (retention tightened)`),
    health.tuningPending ? `${health.tuningPending} weight change${health.tuningPending === 1 ? "" : "s"} proposed from your labels: run pnpm tune --show --dry` : "",
  ].filter(Boolean);
  const healthLines = [...alerts, summary, `Config ${r.configVersion}`];

  // region groups (delivery.digest.region_groups): a heading where each group's leads start
  const startsGroup = (i: number) => !!leads[i]?.group && leads[i]!.group !== leads[i - 1]?.group;
  const groupCount = (g?: string) => leads.filter((l) => l.group === g).length;
  const groupHeading = (l: (typeof leads)[number], i: number) => startsGroup(i)
    ? `<tr><td style="padding:20px 0 4px;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${C.muted}">${esc(l.group!)} (${groupCount(l.group)})</td></tr>`
    : "";
  const section = (title: string, body: string) => `<div style="margin-top:28px"><div style="font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${C.muted};margin-bottom:6px">${title}</div>${body}</div>`;
  const watchHtml = watch.length ? section("Watchlist", watch.map((w) =>
    `<div style="font-size:13px;margin:4px 0">${A(`https://${w.account.domain}`, esc(w.account.name ?? w.account.domain), `color:${C.ink};font-weight:600`)} <span style="color:${C.muted}">${esc(w.score.drivers[0] ? describe(w.score.drivers[0]) : "")}</span></div>`).join("")) : "";
  const peopleHtml = people.length ? section("People asking, no company yet", people.map((p) =>
    `<div style="font-size:13px;margin:4px 0">${esc(p.platform)}/${esc(p.handle)}: ${A(p.url, `"${esc(p.quote)}"`)}</div>`).join("")) : "";

  const month = (d: Date) => d.toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
  const championsHtml = champions.length ? section(`Past clients who moved (${champions.length})`, champions.map((m) =>
    `<div style="font-size:13px;margin:6px 0">${m.url ? A(m.url, `<b>${esc(m.name)}</b>`) : `<b>${esc(m.name)}</b>`}: was at ${esc(m.was)}, now ${esc(m.title)} at <b>${esc(m.company)}</b> (since ${esc(month(m.since))}). New role, new budget, and they already trust you.</div>`).join("")) : "";

  // past leads with a new fact: listed apart, so they never compete with today's leads for a slot
  const touchHtml = touchBacks.length ? section(`Touch back: new since you saw them (${touchBacks.length})`, touchBacks.map((t) =>
    `<div style="font-size:13px;margin:6px 0">${A(`https://${t.domain}`, `<b>${esc(t.company)}</b>`, `color:${C.ink}`)}${t.person ? ` · ${esc(t.person)}` : ""} <span style="color:${C.muted}">(sent ${t.daysSince} days ago)</span><br>${A(t.url, esc(t.fact.slice(0, 220)))}${t.drafted ? ` <span style="color:${C.muted}">· follow-up draft in the Sheet</span>` : ""}</div>`).join("")) : "";
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
  ${championsHtml}
  ${touchHtml}
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0">${leads.map((l, i) => groupHeading(l, i) + leadHtml(l, i, contacts, pack.icp.personas, notes, labels?.get(l.account.id), windowFor(l, date, pack))).join("")}</table>
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
    touchBacks.length ? `TOUCH BACK: NEW SINCE YOU SAW THEM\n${touchBacks.map((t) => `- ${t.company}${t.person ? ` (${t.person})` : ""}, sent ${t.daysSince} days ago: ${t.fact.slice(0, 220)} ${t.url}${t.drafted ? " [follow-up draft in the Sheet]" : ""}`).join("\n")}\n` : "",
    champions.length ? `PAST CLIENTS WHO MOVED\n${champions.map((m) => `- ${m.name}: was at ${m.was}, now ${m.title} at ${m.company} (since ${month(m.since)})${m.url ? ` ${m.url}` : ""}`).join("\n")}\n` : "",
    ...leads.map((l, i) => (startsGroup(i) ? `${(l.group ?? "").toUpperCase()} (${groupCount(l.group)})\n` : "") + leadText(l, i, contacts, pack.icp.personas, notes, windowFor(l, date, pack)) + "\n"),
    gigs.length ? `FREELANCE GIGS\n${gigs.map((g) => `- ${g.title}${g.company ? ` (${g.company})` : ""}: ${g.applyUrl ?? g.url} (via ${SOURCE_NAME[g.source] ?? g.source}: ${g.url})`).join("\n")}\n` : "",
    watch.length ? `WATCHLIST\n${watch.map((w) => `- ${w.account.name ?? w.account.domain} (${w.account.domain})`).join("\n")}\n` : "",
    people.length ? `PEOPLE ASKING, NO COMPANY YET\n${people.map((p) => `- ${p.platform}/${p.handle}: "${p.quote}" ${p.url}`).join("\n")}\n` : "",
    "HEALTH",
    ...healthLines.map((h) => `- ${h}`),
  ].join("\n");

  return { subject: subjectFull, html, text };
}

/** The Sheet row for a delivered lead, by column name (the hidden ID is added when the row is appended). */
export function leadSheetRow(l: Lead, contact: Contact | null | undefined, date: string, note?: LeadNote, signature = "", copy?: { greeting: string; linkedin: { greeting: string } }, calendar?: Pack["icp"]["calendar"], enrichUrl?: string): LeadRow {
  const a = l.account, s = l.score;
  const company = a.name ?? a.domain;
  const e = contact?.person.email;
  return {
    Date: date,
    Company: company,
    "What they do": a.description ?? "",
    Website: `https://${a.domain}`,
    Score: String(displayScore(s)), // 0-100 = need + fit + timing + buyer points (scoreLine in "Why now")
    "ICP fit": String(Math.round(s.fit * 100)), // 0-100: size and segment against your ICP
    Timing: calendar ? sendWindowText(sendWindow(s.evidence, dayDate(date), calendar)) : "",
    Size: a.sizeBand ?? "",
    Segment: a.segment ?? "",
    Region: a.region ?? "",
    "Why now": [scoreLine(s), gapLine(s) ? [gapLine(s)!.missing, gapLine(s)!.has].filter(Boolean).join(" · ") : "", l.backReason ? `Back: ${l.backReason}` : "", contact?.warm?.length ? `Warm path: ${contact.warm[0]!.text}` : "",
      ...s.drivers.filter((x) => x.type !== "role_gap").slice(0, 3).map((x) => `${describe(x)} (${x.url})`)].filter(Boolean).join("\n"),
    Signals: signalSummary(s.evidence),
    Plays: s.plays.map((p) => p.title).join(" + "),
    Person: contact?.person.name ?? "",
    Role: contact?.person.role ?? "",
    LinkedIn: contact?.person.linkedin ?? contact?.person.twitter ?? "",
    ...(e && e.status !== "invalid" ? emailCells(e.address, EMAIL_LABEL[e.status], /catch-all/i.test(e.note) ? true : null) : {}),
    "Enrich email": enrichUrl && needsEmail(contact) ? enrichUrl : "", // a link until clicked, then the result
    Opener: leadOpener(contact, company, s.drivers[0], note) ?? "",
    Angle: note?.angle ?? s.plays[0]?.angle ?? "",
    "Email draft": emailDraft(contact, note, signature, copy?.greeting),
    "LinkedIn message": linkedinDraft(contact, note, copy?.linkedin.greeting),
    Brief: note?.brief ?? "",
    // Label, Reason, Outcome, Notes: yours
  };
}

const SIGNAL_LABEL: Record<string, string> = {
  core_role_open_45d: "Core role open 45+ days", core_role_open: "Core role open", first_role: "Founding GTM hire",
  contract_role: "Contract/fractional role", adjacent_role_open: "Sales/marketing hiring", core_role_filled: "Core role filled (against)",
  explicit_hire_request: "Asked for help", pain_post: "Pain in public", funding_raise: "Recently raised", product_launch: "Product launch",
  cta_sales_led: "Site went sales-led", pricing_page_added: "Pricing page added", gtm_tool_added: "New GTM tool", stack_sprawl: "Tool sprawl",
  tool_overlap: "Overlapping tools", role_reposted: "Role reposted", role_gap: "Empty GTM seats", ops_owner_known: "Has an ops owner (against)", ops_team_2plus: "Ops team of 2+ (against)",
  jd_mentions: "Job ad names the pain", leaky_capture: "Leaky lead capture", has_gtm_agency: "Credits a GTM agency (against)",
  new_gtm_leader: "New leader with budget", ops_person_left: "Ops person left", marketing_subdomain: "New marketing subdomain", outbound_domain: "Cold-email domain set up",
  champion_moved: "Past client joined", freeze_to_contract: "Couldn't hire, now contract", email_auth_gap: "Cold email without DMARC/SPF",
  attribution_gap: "Demo form skips the source", site_health_poor: "Slow site", content_motion: "New content channel",
};

/** "Core role open 45+ days, Founding GTM hire, Recently raised ×2": every signal type behind a lead, strongest kinds first. */
export function signalSummary(evidence: Evidence[]): string {
  const counts = new Map<string, number>();
  for (const e of evidence) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  const order = Object.keys(SIGNAL_LABEL);
  return [...counts].sort((a, b) => (order.indexOf(a[0]) + 1 || 99) - (order.indexOf(b[0]) + 1 || 99))
    .map(([t, n]) => `${SIGNAL_LABEL[t] ?? t.replace(/_/g, " ")}${n > 1 ? ` ×${n}` : ""}`).join(", ");
}

export function gigSheetRow(g: DigestGig, date: string): string[] {
  return [date, g.title, g.company ?? "", g.employmentType ?? "", g.location ?? "", g.applyUrl ?? g.url, `${SOURCE_NAME[g.source] ?? g.source}: ${g.url}`, "", "", g.id];
}
