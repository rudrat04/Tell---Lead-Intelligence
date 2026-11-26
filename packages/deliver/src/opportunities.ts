import type { Pack } from "@tell/config";
import { collectOpportunities, rankOpportunityLeads, activeTrades, withTrades, timingLine, istDay, neonUsage, WRITER_USAGE, type OppLead, type OppRunStats } from "@tell/pipeline";
import { WriterClient, HaikuClient, writerEffort, writeOpportunityDraft, type OppDraftInput, type LlmClient } from "@tell/extract";
import { firstName, type Contact } from "@tell/people";
import { SHOWN_EVENTS, TOP_EVENTS } from "@tell/intel";
import { getDb, deliveries, runs, eq, and, inArray, sql } from "@tell/db";
import { assignDeliveryIds, enrichLink, enrichSignalLink, draftLink, fetchDraftRequests, ackDraftRequests } from "./label-links.js";
import type { SignalPerson } from "@tell/intel";
import { emailCells, fillColumnById, ensureLeadHeaders, type OppRow } from "./sheets.js";
import { appendPendingLeads } from "./sheet-sync.js";
import { sendTelegram, telegramConfigured, tgEsc, type TgMessage } from "./telegram.js";
import { greeting, emailText, sureEmail } from "./render.js";
import { gmailSender, type Sender } from "./gmail.js";

/**
 * Opportunity leads out (`pnpm opps`): Telegram (summary + one message per lead with Good / Bad / Find email /
 * Create draft / Brief) and the Sheet's Opportunities tab. No email is drafted here: "Create draft" queues one through the Worker
 * and `pnpm drafts:requests` writes it on click. Once per IST day (runs `opps:<day>`); --test records nothing.
 * Prints counts only (CI logs are public).
 */

/** What the on-click draft needs, stored on the delivery (deliveries.context). */
export interface OppContext {
  kind: "opportunity";
  company: string; domain: string; description: string | null;
  opportunity: string; angle: string;
  contact: { name: string; role: string | null; persona: string | null; linkedin?: string | null } | null;
  /** the other people to reach at the company (Find email looks them up too) */
  others?: { name: string; role: string | null; linkedin: string | null }[];
  events: { quote: string; url: string; reasons: string[]; about?: string }[];
  /** urls of the lead's top events (TOP_EVENTS, beyond the ones shown), so the hold-back sees what is really new */
  topEvents?: string[];
  record: string[];
  brief: string;
  /** the event kind (contract recompete vs news / signal), so the draft speaks about it the right way */
  kindOf?: string;
  draft?: { subject: string; body: string; at: string } | null;
  /** the people at the signal's company (its headline name, its full name), for the signal-side Find email click */
  signal?: { entity: string; full: string; people: SignalPerson[] } | null;
}

const MAX_EVENTS = SHOWN_EVENTS;

/** "What could follow" when the pack says nothing (pure; exported for tests): careful, never a promise. */
export function followText(l: Pick<OppLead, "opportunity">): string {
  if (l.opportunity.follow) return l.opportunity.follow;
  return l.opportunity.kind === "usaspending_expiring"
    ? "A contract ending means the agency may buy this work again (a recompete). It is not a confirmed RFP: watch SAM.gov for a sources-sought or pre-solicitation notice."
    : "These events can create work for companies like them; none of it is promised. Reach the company behind the event early, before its vendors are chosen.";
}

const DAY = 86_400_000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
/** When the signal happened, or (a contract) when it ends (pure; exported for tests). */
export function signalWhen(l: Pick<OppLead, "opportunity">, e: { endDate: Date }, now: Date): string {
  const days = Math.round((e.endDate.getTime() - now.getTime()) / DAY);
  if (l.opportunity.kind === "usaspending_expiring") return `ends ${isoDay(e.endDate)} (in ${days} days)`;
  const ago = Math.max(0, -days);
  return `${isoDay(e.endDate)} (${ago === 0 ? "today" : `${ago} day${ago === 1 ? "" : "s"} ago`})`;
}
/** How this company benefits, in one line: why it fits the signal, from its own record or what it sells (pure). */
export const howTheyBenefit = (l: Pick<OppLead, "events" | "proof">) => [...new Set(l.events.slice(0, MAX_EVENTS).flatMap((e) => e.reasons).filter((r) => !r.startsWith("their site:") && !r.startsWith("stage:")))].join("; ")
  + (l.proof ? `; proven: they offer ${l.proof.need} ("${l.proof.quote}")` : "");

const STAGE_LABEL = { early: "early (plans, land, MoUs)", committed: "committed (approved, funded, building, ordering)", buying: "buying now (tender, RFQ, hiring drive)" } as const;
/** The fact-check of the lead's top event, in one or two lines (pure; exported for tests): what happened and the stage,
 *  each from the article's own words. Empty for federal recompetes (their record is the fact). */
export function checkedLines(e: OppLead["events"][number] | undefined): string[] {
  if (!e?.stage) return [];
  return [`Fact-checked: ${e.happened || e.quote}`, `Stage: ${STAGE_LABEL[e.stage]}${e.stageQuote ? `: "${e.stageQuote}"` : ""}`];
}

/** "Headline (Outlet)" -> the headline and the outlet (pure; exported for tests). */
export function splitSource(quote: string): { headline: string; outlet: string | null } {
  const m = quote.match(/^(.*\S)\s*\(([^()]{3,60})\)\s*$/);
  return m ? { headline: m[1]!, outlet: m[2]!.trim() } : { headline: quote, outlet: null };
}
const hostOf = (url: string) => url.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "");

export interface SignalStrength { level: 1 | 2 | 3 | 4 | 5; band: string; bar: string; why: string[] }
const BANDS = ["", "Weak", "Early", "Moderate", "Strong", "Very strong"] as const;
/**
 * How strong a signal is, 1-5 with a band (pure; exported for tests): the fact-checked stage sets the base (buying now
 * 4, committed 3, early 2), then fresh news (a week or less) +0.5, old news (over 30 days) -0.5, two or more verified
 * needs +0.5, three or more businesses that can act on it +0.5, a single job post -1 (one hire is a small purchase);
 * halves round down. How well a buyer fits is the lead's score, not the signal's strength. Federal recompetes have no
 * stage: null.
 */
export function signalStrength(group: Pick<OppLead, "events" | "opportunity">[], now: Date): SignalStrength | null {
  const l = group[0], e = l?.events[0];
  if (!l || !e?.stage || l.opportunity.kind === "usaspending_expiring") return null;
  const days = Math.max(0, Math.round((now.getTime() - e.endDate.getTime()) / DAY));
  const needs = new Set(group.map((x) => x.events[0]?.need?.what).filter(Boolean)).size;
  let s = { buying: 4, committed: 3, early: 2 }[e.stage];
  const why: string[] = [{ buying: "buying now", committed: "committed (funded / building / ordering)", early: "early (plans, land, MoUs)" }[e.stage]];
  if (days <= 7) { s += 0.5; why.push(days === 0 ? "today's news" : `${days} day${days === 1 ? "" : "s"} old`); } else if (days > 30) { s -= 0.5; why.push(`${days} days old`); } else why.push(`${days} days old`);
  if (needs >= 2) { s += 0.5; why.push(`${needs} things to buy`); }
  if (group.length >= 3) { s += 0.5; why.push(`${group.length} businesses fit`); }
  if (l.opportunity.kind === "jobs") { s -= 1; why.push("a single job post"); }
  const level = Math.max(1, Math.min(5, Math.floor(s))) as SignalStrength["level"];
  return { level, band: BANDS[level], bar: "▰".repeat(level) + "▱".repeat(5 - level), why };
}

/** Why them / the play / the next step: written for this lead when the explainer ran, else the pack's lines (pure). */
export const whyThem = (l: OppLead) => l.explain?.why ?? howTheyBenefit({ events: l.events });
export const thePlay = (l: OppLead) => l.explain?.play ?? l.opportunity.angle;
export const nextStep = (l: OppLead) => l.explain?.next ?? followText(l);

/** Everyone to reach at the lead's company, the contact first (pure). */
export const reachList = (c: OppLead["contact"]) => (c ? [c.person, ...(c.others ?? []).map((o) => o.person)] : []);
const personText = (p: Contact["person"]) => `${p.name}${p.role ? `, ${p.role}` : ""}${emailText(p) ? ` · ${emailText(p)}` : ""}${p.linkedin ? ` (${p.linkedin})` : ""}`;

/**
 * The one-page brief, written by code from the facts only (pure; exported for tests), in the order you'd pitch it:
 * the signal (what happened), the company that can benefit and how, the play, the opportunity (what could follow and
 * when), then who to reach on both sides and the sources.
 */
export function oppBrief(l: OppLead, now: Date): string {
  const a = l.account, e0 = l.events[0], t = timingLine(l, now), st = signalStrength([l], now);
  return [
    "1. THE SIGNAL",
    ...(e0 ? [e0.quote, `${signalWhen(l, e0, now)} · ${e0.url}`, ...(st ? [`Strength: ${st.level}/5 ${st.band} (${st.why.join(", ")})`] : []), ...checkedLines(e0)] : []),
    ...(l.events.length > 1 ? ["", `More signals like it (${l.events.length - 1}):`, ...l.events.slice(1, 6).map((e) => `- ${e.quote} (${signalWhen(l, e, now)})\n  ${e.url}`)] : []),
    "",
    "2. WHO CAN BENEFIT, AND HOW",
    `${a.name ?? a.domain} (${a.domain})${[a.region, a.sizeBand && `${a.sizeBand} people`].filter(Boolean).length ? ` · ${[a.region, a.sizeBand && `${a.sizeBand} people`].filter(Boolean).join(" · ")}` : ""}`,
    ...(a.description ? [a.description] : []),
    `Why them: ${whyThem(l)}`,
    ...(l.proof ? [`Proven from their own site: they offer ${l.proof.need}: "${l.proof.quote}" (${l.proof.url})`] : []),
    ...l.evidence.slice(0, 3).map((e) => `- ${e.quote}\n  ${e.url}`),
    "",
    `3. THE PLAY: ${l.opportunity.label}`,
    ...(thePlay(l) ? [thePlay(l)] : []),
    "",
    "4. THE OPPORTUNITY",
    ...(e0?.need ? [`They will need: ${e0.need.what} (from: "${e0.need.quote}")`] : []),
    `Next step: ${nextStep(l)}`,
    ...(t ? [`Timing: ${t}`] : []),
    l.score.line,
    "",
    "5. WHO TO REACH",
    ...(reachList(l.contact).length ? reachList(l.contact).map((p) => `- ${personText(p)}`) : ["nobody found yet"]),
    ...(l.signalContacts?.length && e0?.entityName ? ["", `On the signal's side (${l.signalEntity ?? e0.entityName}${l.signalOwner?.department ? `, ${l.signalOwner.department}` : ""}${l.signalOwner?.location ? `, ${l.signalOwner.location}` : ""}):`,
      ...l.signalContacts.map((p) => `- ${p.name}, ${p.role}${p.email ? ` · ${p.email.address} (verified)` : ""}${p.linkedin ? ` (${p.linkedin})` : ""}`)] : []),
  ].join("\n");
}

/** The Opportunities tab row (pure; exported for tests): signal first, then the play, the company and why, the people.
 *  The Email draft cell holds the Create draft link until you click it. */
export function oppSheetRow(l: OppLead, day: string, now: Date, links: { enrich?: string; draft?: string; enrichSignal?: string }): OppRow {
  const a = l.account, c = l.contact, e0 = l.events[0], st = signalStrength([l], now);
  const email = c ? sureEmail(c.person) : null;
  const cells = email ? emailCells(email.address, email.status) : {};
  const others = (c?.others ?? []).map((o) => personText(o.person));
  return {
    Date: day,
    Signal: e0?.quote ?? "", "Signal link": e0?.url ?? "", "Signal date": e0 ? signalWhen(l, e0, now) : "", ...(st ? { "Signal strength": `${st.level}/5 ${st.band}` } : {}), About: e0?.entityName ?? "",
    "More signals": l.events.slice(1, MAX_EVENTS).map((e) => `${e.quote} ${e.url}`).join("\n"),
    Opportunity: l.opportunity.label, "The play": thePlay(l),
    Company: a.name ?? a.domain, Website: `https://${a.domain}`, "What they do": a.description ?? "", "Why they benefit": whyThem(l), "Next step": nextStep(l),
    Score: l.score.line, Timing: timingLine(l, now), Region: a.region ?? "",
    Person: c?.person.name ?? "", Role: c?.person.role ?? "", LinkedIn: c?.person.linkedin ?? "", ...(others.length ? { "Other contacts": others.join("\n") } : {}),
    ...(l.signalContacts?.length ? { "Signal-side contact": `${e0?.entityName ? `${e0.entityName}: ` : ""}${signalSideText(l.signalContacts)}`,
      ...(links.enrichSignal && l.signalContacts.some((p) => !p.email) ? { "Signal-side email": links.enrichSignal } : {}) } : {}),
    ...(cells.Email ? { Email: cells.Email, Verified: cells.Verified } : {}),
    ...(links.enrich && c && reachList(c).some((p) => !sureEmail(p)) ? { "Enrich email": links.enrich } : {}),
    Brief: oppBrief(l, now), ...(links.draft ? { "Email draft": links.draft } : {}),
  };
}

const tgLink = (url: string, text: string) => (/^https?:\/\//i.test(url) ? `<a href="${tgEsc(url)}">${tgEsc(text)}</a>` : tgEsc(text));
/** a short name for a button ("Find emails · Contoso Pow…"): Telegram buttons stay on one line */
const short = (s: string, n = 18) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const personTg = (p: { name: string; role?: string | null; linkedin?: string | null; email?: { address: string } | null }, sure: { address: string } | null) =>
  `• ${p.linkedin ? tgLink(p.linkedin, p.name) : `<b>${tgEsc(p.name)}</b>`}${p.role ? ` · ${tgEsc(p.role)}` : ""}${sure ? `\n   ✉️ <code>${tgEsc(sure.address)}</code>` : ""}`;

/** The signal block (pure): headline, source and date, strength, what happened and the stage. */
function signalBlock(group: OppLead[], now: Date): string[] {
  const l = group[0]!, e0 = l.events[0];
  if (!e0) return [];
  const { headline, outlet } = splitSource(e0.quote), st = signalStrength(group, now);
  return [
    "📡 <b>SIGNAL</b>",
    `<b>${tgEsc(headline)}</b>`,
    [outlet ?? hostOf(e0.url), signalWhen(l, e0, now)].map(tgEsc).join(" · ") + ` · ${tgLink(e0.url, "source")}`,
    ...(st ? ["", `${st.bar}  <b>${st.band}</b> (${st.level}/5)`, `<i>${tgEsc(st.why.join(" · "))}</i>`] : []),
    ...(e0.happened ? ["", "<b>What happened</b>", tgEsc(e0.happened)] : []),
    ...(e0.stage && e0.stageQuote ? [`<i>“${tgEsc(e0.stageQuote)}”</i>`] : []),
  ];
}
/** Who owns the purchase at the signal's company (pure). */
function signalPeopleBlock(l: OppLead): string[] {
  if (!l.signalContacts?.length) return [];
  const where = [l.signalOwner?.department, l.signalOwner?.location].filter(Boolean).join(" · ");
  return [`🤝 <b>Who owns it at ${tgEsc(l.signalEntity ?? l.events[0]?.entityName ?? "the signal's company")}</b>`, ...(where ? [`<i>${tgEsc(where)}</i>`] : []),
    ...l.signalContacts.map((p) => personTg(p, p.email ?? null))];
}

/** One lead as a Telegram message (pure; exported for tests): who can benefit and why, the play, the next step, the
 *  score, the people to reach. `compact` = sent under its signal's own message (the signal isn't repeated). */
export function oppMessage(l: OppLead, deliveryId: string | null, now: Date, test = false, compact = false): TgMessage {
  const a = l.account, c = l.contact, t = timingLine(l, now);
  const facts = [a.region, a.sizeBand && `${a.sizeBand} people`, a.domain].filter(Boolean).map((x) => tgEsc(String(x))).join(" · ");
  const people = reachList(c);
  const lines = [
    ...(compact ? [] : [...signalBlock([l], now), ...(l.events[0]?.need ? ["", "🛒 <b>What it makes them buy</b>", `• ${tgEsc(l.events[0].need.what)}`] : []), ...(l.signalContacts?.length ? ["", ...signalPeopleBlock(l)] : []), "", "━━━━━━━━━━", ""]),
    `🏭 <b>${tgLink(`https://${a.domain}`, a.name ?? a.domain)}</b>`,
    ...(facts ? [`<i>${facts}</i>`] : []),
    ...(a.description ? [tgEsc(a.description)] : []),
    "",
    "💡 <b>Why them</b>",
    tgEsc(whyThem(l)),
    ...(l.proof ? [`✅ <i>From their site:</i> “${tgEsc(l.proof.quote)}” ${tgLink(l.proof.url, "↗")}`] : []),
    ...(l.evidence[0] && l.opportunity.kind === "usaspending_expiring" ? [`Their record: ${tgLink(l.evidence[0].url, l.evidence[0].quote)}`] : []),
    "",
    `🎯 <b>The play</b> · <i>${tgEsc(l.opportunity.label)}</i>`,
    ...(thePlay(l) ? [tgEsc(thePlay(l))] : []),
    "",
    "➡️ <b>Next step</b>",
    tgEsc(nextStep(l)),
    "",
    `📊 <b>Score ${l.score.score}</b>/100${t ? ` · ⏱ ${tgEsc(t)}` : ""}`,
    `<i>${tgEsc(l.score.line.replace(/^Score \d+ = /, ""))}</i>`,
    ...(l.events.length > 1 ? [`+ ${l.events.length - 1} more signal${l.events.length === 2 ? "" : "s"} like it: ${l.events.slice(1, MAX_EVENTS).map((e, i) => tgLink(e.url, `#${i + 2}`)).join(" ")}`] : []),
    "",
    `👥 <b>People to reach at ${tgEsc(short(a.name ?? a.domain, 40))}</b>`,
    ...(people.length ? people.map((p) => personTg(p, sureEmail(p))) : ["nobody found yet"]),
    ...(people.length && !people.some((p) => sureEmail(p)) ? ["<i>No verified email yet: tap Find emails.</i>"] : []),
  ];
  const text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!deliveryId || test) return { text };
  const leadEmails = people.some((p) => !sureEmail(p));
  const signalEmails = !!l.signalContacts?.some((p) => !p.email);
  const finds = [...(leadEmails ? [{ text: `🔎 Find emails · ${short(a.name ?? a.domain)}`, data: `e:${deliveryId}` }] : []),
    ...(signalEmails ? [{ text: `🔎 Find emails · ${short(l.signalEntity ?? l.events[0]?.entityName ?? "signal side")}`, data: `es:${deliveryId}` }] : [])];
  return { text, buttons: [[{ text: "✍️ Draft email (to your inbox)", data: `cd:${deliveryId}` }], [{ text: "👍 Good", data: `g:${deliveryId}` }, { text: "👎 Bad", data: `b:${deliveryId}` }],
    ...finds.map((b) => [b])] };
}

/** Leads grouped by their lead signal (pure; exported for tests): the strongest group first, each group's leads
 *  strongest first. One signal, several businesses that can act on it. */
export function bySignal(leads: OppLead[]): OppLead[][] {
  const groups = new Map<string, OppLead[]>();
  for (const l of [...leads].sort((a, b) => b.score.score - a.score.score)) {
    const k = l.events[0]?.url ?? l.account.id;
    groups.set(k, [...(groups.get(k) ?? []), l]);
  }
  return [...groups.values()];
}

/** People at the signal's company who deal with it, for the brief and the Sheet: "Jo Doe, Head of Procurement
 *  (linkedin url) · ..." (pure). An email only when verified. */
export const signalSideText = (ps: SignalPerson[]) => ps.map((p) => `${p.name}, ${p.role}${p.email ? ` · ${p.email.address} (verified)` : ""}${p.linkedin ? ` (${p.linkedin})` : ""}`).join(" · ");

/** The signal on its own message (pure; exported for tests): the signal, its strength, what it makes them buy, who owns
 *  it there, and the businesses below it that can act on it. */
export function signalMessage(group: OppLead[], now: Date): TgMessage {
  const l = group[0]!;
  const needs = [...new Set(group.map((x) => x.events[0]?.need?.what).filter((x): x is string => !!x))];
  return { text: [
    ...signalBlock(group, now),
    ...(needs.length ? ["", "🛒 <b>What it makes them buy</b>", ...needs.map((n) => `• ${tgEsc(n)}`)] : []),
    ...(l.signalContacts?.length ? ["", ...signalPeopleBlock(l)] : []),
    "",
    `🏭 <b>${group.length} business${group.length === 1 ? "" : "es"} can act on it</b> (one message each below)`,
    ...group.map((x, i) => `${i + 1}. ${tgEsc(x.account.name ?? x.account.domain)}${x.events[0]?.need?.what ? ` <i>· ${tgEsc(short(x.events[0].need.what, 50))}</i>` : ""}`),
  ].join("\n").replace(/\n{3,}/g, "\n\n").trim() };
}

export function oppContext(l: OppLead, now: Date): OppContext {
  const a = l.account, c = l.contact;
  return {
    kind: "opportunity", company: a.name ?? a.domain, domain: a.domain, description: a.description, opportunity: l.opportunity.label, angle: l.opportunity.angle,
    contact: c ? { name: c.person.name, role: c.person.role, persona: c.persona, linkedin: c.person.linkedin ?? null } : null, kindOf: l.opportunity.kind,
    others: (c?.others ?? []).map((o) => ({ name: o.person.name, role: o.person.role, linkedin: o.person.linkedin ?? null })),
    events: l.events.slice(0, MAX_EVENTS).map((e) => ({ quote: e.quote, url: e.url, reasons: e.reasons, ...(e.entityName ? { about: e.entityName } : {}) })),
    topEvents: l.events.slice(0, TOP_EVENTS).map((e) => e.url), record: l.evidence.map((e) => e.quote), brief: oppBrief(l, now),
    ...(l.signalContacts?.length && l.events[0]?.entityName ? { signal: { entity: l.events[0].entityName, full: l.signalEntity ?? l.events[0].entityName, people: l.signalContacts } } : {}),
  };
}

export interface OppDigestResult extends Partial<OppRunStats> { status: "sent" | "dry" | "skipped" | "empty"; reason?: string; telegram?: number; sheetRows?: number; leads: number; shown?: OppLead[] }

export async function runOpportunityDigest(opts: { pack: Pack; dryRun?: boolean; test?: boolean; skipCollect?: boolean; only?: "roster" | "events" | "match"; force?: boolean; again?: boolean }): Promise<OppDigestResult> {
  const { pack } = opts;
  if (!pack.opportunities.enabled) return { status: "skipped", reason: "opportunities.enabled is false", leads: 0 };
  const db = getDb(), now = new Date(), day = istDay(now), key = `opps:${day}`;
  const real = !opts.dryRun && !opts.test;
  if (real) {
    const [prior] = await db.select({ status: runs.status }).from(runs).where(eq(runs.idempotencyKey, key)).limit(1);
    if (prior?.status === "ok" && !opts.again) return { status: "skipped", reason: `already sent today (${key})`, leads: 0 };
  }
  // (the collection hands back the pack with today's trades in it; never spread into the counts: CI logs are public)
  const { pack: withT, ...collected } = opts.skipCollect ? { pack: withTrades(pack, await activeTrades(pack, now)) } : await collectOpportunities(pack, { now, only: opts.only, force: opts.force });
  if (opts.only) return { status: "dry", ...collected, leads: 0 };
  const ranked = await rankOpportunityLeads(withT, { now, write: !opts.dryRun });
  const base = { ...collected, ...ranked.stats, leads: ranked.leads.length };
  if (opts.dryRun) return { status: "dry", ...base, shown: ranked.leads };
  if (!ranked.leads.length) {
    if (real) await db.insert(runs).values({ task: "opps", idempotencyKey: key, status: "ok", yieldCount: 0, finishedAt: now }).onConflictDoNothing();
    return { status: "empty", ...base };
  }
  const ids = assignDeliveryIds(ranked.leads.map((l) => l.account.id));
  const url = process.env.TELL_LABEL_URL, secret = process.env.LABEL_SECRET;
  let sheetRows = 0;
  if (real) {
    const rows = ranked.leads.map((l) => {
      const id = ids.get(l.account.id)!;
      const links = url && secret ? { enrich: enrichLink(url, secret, id), draft: draftLink(url, secret, id), enrichSignal: enrichSignalLink(url, secret, id) } : {};
      return { id, accountId: l.account.id, deliveredAt: now, kind: "opportunity", configVersion: `opps:${pack.meta.name}`, sheetRow: oppSheetRow(l, day, now, links), context: oppContext(l, now) };
    });
    // one lead per account per IST day (unique index deliveries_opp_day_uq): a retry skips what an earlier attempt wrote
    const written = new Set((await db.insert(deliveries).values(rows).onConflictDoNothing().returning({ id: deliveries.id })).map((r) => r.id));
    const skipped = rows.filter((r) => !written.has(r.id)).map((r) => r.accountId);
    if (skipped.length) {
      // the earlier attempt's delivery ids go to Telegram, so its buttons and stored texts match the rows
      const dayStart = new Date(`${day}T00:00:00+05:30`);
      const prior = await db.select({ id: deliveries.id, accountId: deliveries.accountId }).from(deliveries)
        .where(and(eq(deliveries.kind, "opportunity"), inArray(deliveries.accountId, skipped), sql`${deliveries.deliveredAt} >= ${dayStart}`));
      for (const p of prior) if (p.accountId) ids.set(p.accountId, p.id);
    }
    try { sheetRows = await appendPendingLeads(pack); } catch { /* the nightly sheet:sync retries */ }
  }
  let telegram = 0;
  if (pack.delivery.channels.includes("telegram") && telegramConfigured()) {
    const head: TgMessage = { text: `${opts.test ? "[TEST] " : ""}<b>${ranked.leads.length} opportunit${ranked.leads.length === 1 ? "y lead" : "y leads"} for ${tgEsc(day)}</b>\n<i>Each signal, then the businesses that can act on it. Tap Create draft to write the email.</i>` };
    // one message per signal, then each business that can act on it (federal recompetes: one message each, as before)
    const msgs: TgMessage[] = [head];
    for (const g of bySignal(ranked.leads)) {
      const grouped = g[0]!.opportunity.kind !== "usaspending_expiring";
      if (grouped) msgs.push(signalMessage(g, now));
      for (const l of g) msgs.push(oppMessage(l, real ? ids.get(l.account.id)! : null, now, !!opts.test, grouped));
    }
    telegram = await sendTelegram(msgs);
  }
  if (real) await db.insert(runs).values({ task: "opps", idempotencyKey: key, status: "ok", yieldCount: ranked.leads.length, finishedAt: new Date() })
    .onConflictDoUpdate({ target: runs.idempotencyKey, set: { status: "ok", yieldCount: ranked.leads.length, finishedAt: new Date() } });
  return { status: "sent", ...base, telegram, sheetRows };
}

// ------------------------------------------------------------------------------------------------ drafts on click

/** The writer for on-click drafts: Sonnet while its daily cap lasts (usage_daily "sonnet"), then Haiku with thinking. */
async function draftWriter(): Promise<{ llm: LlmClient & { spent: number }; service: string; cap: number } | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const usage = neonUsage();
  const sCap = Number(process.env.WRITER_DAILY_CAP_USD ?? 0.08), hCap = Number(process.env.HAIKU_WRITER_DAILY_CAP_USD ?? 0.03);
  const sLeft = sCap - (await usage.spentToday(WRITER_USAGE));
  if (sLeft > 0.01) return { llm: new WriterClient({ capUsd: sLeft, effort: writerEffort() }), service: WRITER_USAGE, cap: sCap };
  const hLeft = hCap - (await usage.spentToday("haiku_writer"));
  return hLeft > 0.002 ? { llm: new HaikuClient({ capUsd: hLeft }), service: "haiku_writer", cap: hCap } : null;
}

/**
 * The draft as an email to you (pure; exported for tests): who it's for (name, role, the verified address when there
 * is one, else the people you could try), the draft itself ready to copy, then the signal behind it.
 * `d` null = no draft passed the checks: the mail says so and gives the facts.
 */
export function draftMail(ctx: OppContext, d: { subject: string } | null, text: string, row: OppRow): { subject: string; text: string; html: string } {
  const verified = row.Verified === "yes" && row.Email ? row.Email : null;
  const who = ctx.contact ? `${ctx.contact.name}${ctx.contact.role ? `, ${ctx.contact.role}` : ""} at ${ctx.company}` : ctx.company;
  const others = (ctx.others ?? []).map((o) => `${o.name}${o.role ? `, ${o.role}` : ""}${o.linkedin ? ` (${o.linkedin})` : ""}`);
  const head = [`For: ${who}`, verified ? `Send to: ${verified} (verified)` : "Send to: no verified email yet (tap Find emails on the lead)", ...(ctx.contact?.linkedin ? [`LinkedIn: ${ctx.contact.linkedin}`] : []),
    ...(others.length ? ["Also at the company:", ...others.map((o) => `- ${o}`)] : [])];
  const signal = ctx.events[0] ? [`Signal: ${ctx.events[0].quote}`, ctx.events[0].url] : [];
  const body = d ? text : "No draft passed the checks for this lead: write this one yourself. The brief below has the facts.";
  const plain = [...head, "", "------------------------------------------------------------", body, "------------------------------------------------------------", "", ...signal, ...(d ? [] : ["", ctx.brief])].join("\n");
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;color:#111827;max-width:640px">
<p style="color:#6b7280;margin:0 0 4px">${head.map(esc).join("<br>")}</p>
<div style="border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin:16px 0;white-space:pre-wrap;font-size:15px">${esc(body)}</div>
<p style="color:#6b7280;font-size:13px">${signal.map(esc).join("<br>")}</p>${d ? "" : `<pre style="white-space:pre-wrap;font-size:13px">${esc(ctx.brief)}</pre>`}</div>`;
  return { subject: d ? `Draft · ${ctx.company}: ${d.subject}` : `Draft · ${ctx.company}: write this one yourself`, text: plain, html };
}

/** The finished email as it goes in the Sheet and Telegram: subject, code-written greeting, body, signature (pure). */
export function draftText(ctx: Pick<OppContext, "contact">, d: { subject: string; body: string }, pack: Pick<Pack, "copy" | "delivery">): string {
  const c: Contact | null = ctx.contact ? { person: { name: ctx.contact.name, role: ctx.contact.role, source: "context" }, persona: ctx.contact.persona, note: "" } : null;
  const sig = pack.delivery.email.signature.trim();
  return [`Subject: ${d.subject}`, "", greeting(pack.copy.greeting, c), "", d.body.trim(), ...(sig ? ["", sig] : [])].join("\n");
}

/**
 * Create-draft clicks (Telegram button / Sheet link, queued by the Worker): each delivery gets one checked draft,
 * written into the Sheet's "Email draft" cell, sent to Telegram, and stored for the Draft button. A request is acked
 * once answered (a writer outage leaves it queued). Counts only.
 */
export async function runDraftRequests(pack: Pack, opts: { writer?: LlmClient; sender?: Sender | null } = {}): Promise<{ status: "ok" | "skipped"; reason?: string; requests: number; written: number; failed: number; cached: number; mailed?: number }> {
  const out: { status: "ok"; requests: number; written: number; failed: number; cached: number; mailed?: number } = { status: "ok" as const, requests: 0, written: 0, failed: 0, cached: 0 };
  // drafts go to your own inbox (delivery.digest.to, sent from delivery.digest.from); Telegram only when mail isn't set up
  const to = pack.delivery.digest.to, from = pack.delivery.digest.from;
  const sender = opts.sender === undefined ? (to && from && process.env.GMAIL_REFRESH_TOKEN ? gmailSender : null) : opts.sender;
  const mails: { subject: string; text: string; html: string }[] = [];
  const base = process.env.TELL_LABEL_URL, secret = process.env.LABEL_SECRET;
  if (!base || !secret) return { ...out, status: "skipped", reason: "TELL_LABEL_URL / LABEL_SECRET not set" };
  const reqs = await fetchDraftRequests(base, secret);
  out.requests = reqs.length;
  if (!reqs.length) return out;
  const db = getDb();
  const rows = await db.select({ id: deliveries.id, row: deliveries.sheetRow, context: deliveries.context }).from(deliveries).where(inArray(deliveries.id, reqs.map((r) => r.d)));
  const w = opts.writer ? { llm: opts.writer as LlmClient & { spent: number }, service: "", cap: 0 } : await draftWriter();
  const cells = new Map<string, string>(), done: string[] = [], tg: TgMessage[] = [];
  for (const req of reqs) {
    const r = rows.find((x) => x.id === req.d);
    const ctx = r?.context as OppContext | null | undefined;
    if (!ctx || ctx.kind !== "opportunity") { done.push(req.d); continue; } // not an opportunity lead: nothing to write
    let d = ctx.draft ?? null;
    if (d) out.cached++;
    else {
      if (!w) break; // no writer budget today: requests stay queued for tomorrow
      const input: OppDraftInput = { company: ctx.company, description: ctx.description, contactRole: ctx.contact?.role ?? ctx.contact?.persona ?? null, opportunity: ctx.opportunity, angle: ctx.angle, events: ctx.events, record: ctx.record, contract: (ctx.kindOf ?? "usaspending_expiring") === "usaspending_expiring" };
      const before = w.llm.spent ?? 0;
      try {
        const res = await writeOpportunityDraft(w.llm, pack, input);
        if (w.service) await neonUsage().addSpend(w.service, (w.llm.spent ?? 0) - before, w.cap);
        d = res.draft ? { ...res.draft, at: new Date().toISOString() } : null;
        if (!d) {
          out.failed++; cells.set(req.d, "no draft passed the checks (write this one yourself)");
          if (sender) mails.push(draftMail(ctx, null, "", ((r!.row ?? {}) as OppRow)));
          else tg.push({ text: `✍️ No draft passed the checks for <b>${tgEsc(ctx.company)}</b>: write this one yourself (the brief has the facts).` });
          done.push(req.d); continue;
        }
      } catch { if (w.service) await neonUsage().addSpend(w.service, (w.llm.spent ?? 0) - before, w.cap).catch(() => {}); break; }
      await db.update(deliveries).set({ context: { ...ctx, draft: d } }).where(eq(deliveries.id, req.d));
      out.written++;
    }
    const text = draftText(ctx, d, pack);
    cells.set(req.d, text);
    await db.update(deliveries).set({ sheetRow: { ...((r!.row ?? {}) as OppRow), "Email draft": text } }).where(eq(deliveries.id, req.d));
    if (sender) mails.push(draftMail(ctx, d, text, ((r!.row ?? {}) as OppRow)));
    else tg.push({ text: `✍️ <b>Draft for ${tgEsc(ctx.company)}</b>${ctx.contact ? ` (to ${tgEsc(firstName(ctx.contact.name))})` : ""}\n\n${tgEsc(text)}` });
    done.push(req.d);
  }
  const sheetId = pack.delivery.sheet.spreadsheet_id;
  if (sheetId && cells.size) { try { await ensureLeadHeaders(sheetId, "Opportunities"); await fillColumnById(sheetId, "Email draft", cells, true, "Opportunities"); } catch { /* the stored row keeps it */ } }
  for (const m of mails) {
    try { await sender!.send({ from: from!, fromName: pack.delivery.digest.from_name, to: to!, ...m }); out.mailed = (out.mailed ?? 0) + 1; }
    catch { tg.push({ text: m.text.slice(0, 3500) }); } // mail failed: the draft still reaches you
  }
  if (tg.length && telegramConfigured()) await sendTelegram(tg).catch(() => 0);
  await ackDraftRequests(base, secret, done);
  return out;
}
