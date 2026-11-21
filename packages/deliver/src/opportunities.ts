import type { Pack } from "@tell/config";
import { collectOpportunities, rankOpportunityLeads, timingLine, istDay, neonUsage, WRITER_USAGE, type OppLead, type OppRunStats } from "@tell/pipeline";
import { WriterClient, HaikuClient, writerEffort, writeOpportunityDraft, type OppDraftInput, type LlmClient } from "@tell/extract";
import { firstName, type Contact } from "@tell/people";
import { getDb, deliveries, runs, eq, inArray } from "@tell/db";
import { assignDeliveryIds, enrichLink, draftLink, fetchDraftRequests, ackDraftRequests } from "./label-links.js";
import { emailCells, fillColumnById, ensureLeadHeaders, type OppRow } from "./sheets.js";
import { appendPendingLeads } from "./sheet-sync.js";
import { sendTelegram, storeTelegramTexts, telegramConfigured, tgEsc, type TgMessage } from "./telegram.js";
import { greeting, emailText } from "./render.js";

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
  contact: { name: string; role: string | null; persona: string | null } | null;
  events: { quote: string; url: string; reasons: string[] }[];
  record: string[];
  brief: string;
  /** the event kind (contract recompete vs news / signal), so the draft speaks about it the right way */
  kindOf?: string;
  draft?: { subject: string; body: string; at: string } | null;
}

const MAX_EVENTS = 3;

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
export const howTheyBenefit = (l: Pick<OppLead, "events">) => [...new Set(l.events.slice(0, MAX_EVENTS).flatMap((e) => e.reasons))].join("; ");

/**
 * The one-page brief, written by code from the facts only (pure; exported for tests), in the order you'd pitch it:
 * the signal (what happened), the company that can benefit and how, the play, the opportunity (what could follow and
 * when), then who to reach and the sources.
 */
export function oppBrief(l: OppLead, now: Date): string {
  const a = l.account, e0 = l.events[0], c = l.contact, t = timingLine(l, now);
  return [
    "1. THE SIGNAL",
    ...(e0 ? [e0.quote, `${signalWhen(l, e0, now)} · ${e0.url}`] : []),
    ...(l.events.length > 1 ? ["", `More signals like it (${l.events.length - 1}):`, ...l.events.slice(1, 6).map((e) => `- ${e.quote} (${signalWhen(l, e, now)})\n  ${e.url}`)] : []),
    "",
    "2. WHO CAN BENEFIT, AND HOW",
    `${a.name ?? a.domain} (${a.domain})${[a.region, a.sizeBand && `${a.sizeBand} people`].filter(Boolean).length ? ` · ${[a.region, a.sizeBand && `${a.sizeBand} people`].filter(Boolean).join(" · ")}` : ""}`,
    ...(a.description ? [a.description] : []),
    `Why them: ${howTheyBenefit(l)}`,
    ...l.evidence.slice(0, 3).map((e) => `- ${e.quote}\n  ${e.url}`),
    "",
    `3. THE PLAY: ${l.opportunity.label}`,
    ...(l.opportunity.angle ? [l.opportunity.angle] : []),
    "",
    "4. THE OPPORTUNITY",
    followText(l),
    ...(t ? [`Timing: ${t}`] : []),
    l.score.line,
    "",
    "5. WHO TO REACH",
    c ? `${c.person.name}${c.person.role ? `, ${c.person.role}` : ""}${c.person.email ? ` · ${c.person.email.address} (${c.person.email.status})` : ""}${c.person.linkedin ? ` · ${c.person.linkedin}` : ""}` : "nobody found yet",
  ].join("\n");
}

/** The Opportunities tab row (pure; exported for tests): signal first, then the play, the company and why, the person.
 *  The Email draft cell holds the Create draft link until you click it. */
export function oppSheetRow(l: OppLead, day: string, now: Date, links: { enrich?: string; draft?: string }): OppRow {
  const a = l.account, c = l.contact, e0 = l.events[0];
  const email = c?.person.email;
  const cells = email ? emailCells(email.address, email.note || email.status) : {};
  return {
    Date: day,
    Signal: e0?.quote ?? "", "Signal link": e0?.url ?? "", "Signal date": e0 ? signalWhen(l, e0, now) : "", About: e0?.entityName ?? "",
    "More signals": l.events.slice(1, MAX_EVENTS).map((e) => `${e.quote} ${e.url}`).join("\n"),
    Opportunity: l.opportunity.label, "The play": l.opportunity.angle,
    Company: a.name ?? a.domain, Website: `https://${a.domain}`, "What they do": a.description ?? "", "Why they benefit": howTheyBenefit(l),
    Score: l.score.line, Timing: timingLine(l, now), Region: a.region ?? "",
    Person: c?.person.name ?? "", Role: c?.person.role ?? "", LinkedIn: c?.person.linkedin ?? "",
    ...(cells.Email ? { Email: cells.Email, Verified: cells.Verified } : {}),
    ...(links.enrich && c && (!email || !["observed", "verified"].includes(email.status)) ? { "Enrich email": links.enrich } : {}),
    Brief: oppBrief(l, now), ...(links.draft ? { "Email draft": links.draft } : {}),
  };
}

/** One lead as a Telegram message (pure; exported for tests), in pitch order: the signal, who can benefit and how,
 *  the play, the opportunity, then who to reach. */
export function oppMessage(l: OppLead, deliveryId: string | null, now: Date, test = false): TgMessage {
  const a = l.account, c = l.contact, e0 = l.events[0], t = timingLine(l, now);
  const link = (url: string, text: string) => (/^https?:\/\//i.test(url) ? `<a href="${tgEsc(url)}">${tgEsc(text)}</a>` : tgEsc(text));
  const facts = [a.region, a.sizeBand && `${a.sizeBand} people`].filter(Boolean).map((x) => tgEsc(String(x))).join(" · ");
  const lines = [
    "📡 <b>THE SIGNAL</b>",
    ...(e0 ? [`<b>${link(e0.url, e0.quote)}</b>`, `<i>${tgEsc(signalWhen(l, e0, now))}</i>`] : []),
    ...(l.events.length > 1 ? [`+ ${l.events.length - 1} more like it: ${l.events.slice(1, MAX_EVENTS).map((e, i) => link(e.url, `#${i + 2}`)).join(" ")}`] : []),
    "",
    "🏭 <b>WHO CAN BENEFIT</b>",
    `<b>${link(`https://${a.domain}`, a.name ?? a.domain)}</b>${facts ? ` · ${facts}` : ""}`,
    ...(a.description ? [`<i>${tgEsc(a.description)}</i>`] : []),
    `<b>How:</b> ${tgEsc(howTheyBenefit(l))}`,
    ...(l.evidence[0] && l.opportunity.kind === "usaspending_expiring" ? [`Their record: ${link(l.evidence[0].url, l.evidence[0].quote)}`] : []),
    "",
    `🎯 <b>THE PLAY: ${tgEsc(l.opportunity.label)}</b>`,
    ...(l.opportunity.angle ? [tgEsc(l.opportunity.angle)] : []),
    "",
    "💰 <b>THE OPPORTUNITY</b>",
    tgEsc(followText(l)),
    ...(t ? [`⏱ ${tgEsc(t)}`] : []),
    `<i>${tgEsc(l.score.line)}</i>`,
    "",
    `👤 <b>Reach:</b> ${c ? `${tgEsc(c.person.name)}${c.person.role ? `, ${tgEsc(c.person.role)}` : ""}` : "nobody found yet"}`,
    ...(c && emailText(c.person) ? [`✉️ ${tgEsc(emailText(c.person)!)}`] : []),
    ...(c?.person.linkedin ? [link(c.person.linkedin, "LinkedIn profile")] : []),
  ];
  const text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!deliveryId || test) return { text };
  const needsEmail = !!c && (!c.person.email || !["observed", "verified"].includes(c.person.email.status));
  return { text, buttons: [[{ text: "✍️ Create draft", data: `cd:${deliveryId}` }, { text: "📄 Brief", data: `br:${deliveryId}` }, ...(needsEmail ? [{ text: "🔎 Find email", data: `e:${deliveryId}` }] : [])],
    [{ text: "👍 Good", data: `g:${deliveryId}` }, { text: "👎 Bad", data: `b:${deliveryId}` }]] };
}

export function oppContext(l: OppLead, now: Date): OppContext {
  const a = l.account, c = l.contact;
  return {
    kind: "opportunity", company: a.name ?? a.domain, domain: a.domain, description: a.description, opportunity: l.opportunity.label, angle: l.opportunity.angle,
    contact: c ? { name: c.person.name, role: c.person.role, persona: c.persona } : null, kindOf: l.opportunity.kind,
    events: l.events.slice(0, MAX_EVENTS).map((e) => ({ quote: e.quote, url: e.url, reasons: e.reasons })), record: l.evidence.map((e) => e.quote), brief: oppBrief(l, now),
  };
}

export interface OppDigestResult extends Partial<OppRunStats> { status: "sent" | "dry" | "skipped" | "empty"; reason?: string; telegram?: number; sheetRows?: number; leads: number; shown?: OppLead[] }

export async function runOpportunityDigest(opts: { pack: Pack; dryRun?: boolean; test?: boolean; skipCollect?: boolean; only?: "roster" | "events" | "match"; force?: boolean }): Promise<OppDigestResult> {
  const { pack } = opts;
  if (!pack.opportunities.enabled) return { status: "skipped", reason: "opportunities.enabled is false", leads: 0 };
  const db = getDb(), now = new Date(), day = istDay(now), key = `opps:${day}`;
  const real = !opts.dryRun && !opts.test;
  if (real) {
    const [prior] = await db.select({ status: runs.status }).from(runs).where(eq(runs.idempotencyKey, key)).limit(1);
    if (prior?.status === "ok") return { status: "skipped", reason: `already sent today (${key})`, leads: 0 };
  }
  const collected = opts.skipCollect ? {} : await collectOpportunities(pack, { now, only: opts.only, force: opts.force });
  if (opts.only) return { status: "dry", ...collected, leads: 0 };
  const ranked = await rankOpportunityLeads(pack, { now, write: !opts.dryRun });
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
    await db.insert(deliveries).values(ranked.leads.map((l) => {
      const id = ids.get(l.account.id)!;
      const links = url && secret ? { enrich: enrichLink(url, secret, id), draft: draftLink(url, secret, id) } : {};
      return { id, accountId: l.account.id, deliveredAt: now, kind: "opportunity", configVersion: `opps:${pack.meta.name}`, sheetRow: oppSheetRow(l, day, now, links), context: oppContext(l, now) };
    }));
    try { sheetRows = await appendPendingLeads(pack); } catch { /* the nightly sheet:sync retries */ }
  }
  let telegram = 0;
  if (pack.delivery.channels.includes("telegram") && telegramConfigured()) {
    if (real) await storeTelegramTexts(ranked.leads.map((l) => ({ d: ids.get(l.account.id)!, brief: oppBrief(l, now) }))).catch(() => false);
    const head: TgMessage = { text: `${opts.test ? "[TEST] " : ""}<b>${ranked.leads.length} opportunit${ranked.leads.length === 1 ? "y lead" : "y leads"} for ${tgEsc(day)}</b>\n<i>Companies that can act on events we found. Tap Create draft to write the email.</i>` };
    telegram = await sendTelegram([head, ...ranked.leads.map((l) => oppMessage(l, real ? ids.get(l.account.id)! : null, now, !!opts.test))]);
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
export async function runDraftRequests(pack: Pack, opts: { writer?: LlmClient } = {}): Promise<{ status: "ok" | "skipped"; reason?: string; requests: number; written: number; failed: number; cached: number }> {
  const out = { status: "ok" as const, requests: 0, written: 0, failed: 0, cached: 0 };
  const base = process.env.TELL_LABEL_URL, secret = process.env.LABEL_SECRET;
  if (!base || !secret) return { ...out, status: "skipped", reason: "TELL_LABEL_URL / LABEL_SECRET not set" };
  const reqs = await fetchDraftRequests(base, secret);
  out.requests = reqs.length;
  if (!reqs.length) return out;
  const db = getDb();
  const rows = await db.select({ id: deliveries.id, row: deliveries.sheetRow, context: deliveries.context }).from(deliveries).where(inArray(deliveries.id, reqs.map((r) => r.d)));
  const w = opts.writer ? { llm: opts.writer as LlmClient & { spent: number }, service: "", cap: 0 } : await draftWriter();
  const cells = new Map<string, string>(), done: string[] = [], tg: TgMessage[] = [], store: { d: string; brief?: string; draft?: string }[] = [];
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
        if (!d) { out.failed++; cells.set(req.d, "no draft passed the checks (write this one yourself)"); tg.push({ text: `✍️ No draft passed the checks for <b>${tgEsc(ctx.company)}</b>: write this one yourself (the brief has the facts).` }); done.push(req.d); continue; }
      } catch { if (w.service) await neonUsage().addSpend(w.service, (w.llm.spent ?? 0) - before, w.cap).catch(() => {}); break; }
      await db.update(deliveries).set({ context: { ...ctx, draft: d } }).where(eq(deliveries.id, req.d));
      out.written++;
    }
    const text = draftText(ctx, d, pack);
    cells.set(req.d, text);
    await db.update(deliveries).set({ sheetRow: { ...((r!.row ?? {}) as OppRow), "Email draft": text } }).where(eq(deliveries.id, req.d));
    store.push({ d: req.d, brief: ctx.brief, draft: text });
    tg.push({ text: `✍️ <b>Draft for ${tgEsc(ctx.company)}</b>${ctx.contact ? ` (to ${tgEsc(firstName(ctx.contact.name))})` : ""}\n\n${tgEsc(text)}` });
    done.push(req.d);
  }
  const sheetId = pack.delivery.sheet.spreadsheet_id;
  if (sheetId && cells.size) { try { await ensureLeadHeaders(sheetId, "Opportunities"); await fillColumnById(sheetId, "Email draft", cells, true, "Opportunities"); } catch { /* the stored row keeps it */ } }
  if (store.length) await storeTelegramTexts(store).catch(() => false);
  if (tg.length && telegramConfigured()) await sendTelegram(tg).catch(() => 0);
  await ackDraftRequests(base, secret, done);
  return out;
}
