import { createHash } from "node:crypto";
import type { Pack } from "@tell/config";
import { WriterClient, HaikuClient, SonnetClient, WRITER_MODEL, HAIKU_MODEL, writerEffort, analyzeLead, analystSystemPrompt, type Analysis, type AnalystInput, type LlmClient } from "@tell/extract";
import type { Contact } from "@tell/people";
import type { RankInput } from "@tell/intel";
import { getDb, analyses, and, inArray } from "@tell/db";
import { neonUsage, type UsageStore } from "./usage.js";
import { proofSample } from "./sample-list.js";
import { researchFor, marketPlay, playEvidence, briefText, type MarketPlay } from "./buyer-signals.js";
import type { LookupMemo } from "./market-lookups.js";
import type { ScoredAccount } from "./score.js";

/** Evidence items the analyst sees per lead (strongest first). */
export const ANALYST_MAX_EVIDENCE = 6;
/** usage_daily service for the writer's spend */
export const WRITER_USAGE = "sonnet";

/** The market play as short lines: each change with its first example (pure). */
const marketLines = (mp: MarketPlay | undefined) => (mp?.changes ?? []).map((c) => ({ title: c.title, example: c.examples[0] ? (c.examples[0].quote.toLowerCase().startsWith(c.examples[0].company.toLowerCase()) ? c.examples[0].quote : `${c.examples[0].company}: ${c.examples[0].quote}`) : "", url: c.examples[0]?.url ?? "" }));

export interface LeadAnalysis extends Analysis { cachedFrom?: Date | null; /** the intelligence brief (Sheet "Brief"), when a market play was built */ brief?: string;
  /** the changes in their market the brief shows, one example each (Telegram "Signals that would help them") */ market?: { title: string; example: string; url: string }[] }

function inputFor(l: RankInput<ScoredAccount>, contact: Contact | null | undefined, version: string, pack: Pack): { input: AnalystInput; key: string; refs: { kind: string; id: string; url: string }[] } {
  const a = l.account, s = l.score;
  const industry = a.segment ? pack.icp.industries[a.segment] : undefined;
  const ev = s.drivers.slice(0, ANALYST_MAX_EVIDENCE);
  const refs = ev.map((e) => ({ kind: e.ref.kind, id: e.ref.id, url: e.url }));
  const key = createHash("sha256").update(JSON.stringify([version, refs.map((r) => `${r.kind}:${r.id}`), s.plays.map((p) => p.id)])).digest("hex").slice(0, 24);
  return {
    key, refs,
    input: {
      company: a.name ?? a.domain, domain: a.domain, segment: a.segment,
      facts: [a.sizeBand && `${a.sizeBand} people`, a.segment?.toUpperCase(), a.region].filter(Boolean).join(", ") + (a.description ? `. What they do: ${a.description}` : ""),
      contactRole: contact?.person.role ?? contact?.persona ?? null,
      // a play without its own offer uses its industry's (industries.yaml), unless that industry gets the GTM review
      plays: s.plays.map((p) => { const offer = p.offer ?? (industry && industry.list !== "gtm" ? industry.offer : undefined); return { id: p.id, title: p.title, angle: p.angle, ...(offer ? { offer } : {}) }; }),
      evidence: ev.map((e) => ({ type: e.type, ageDays: e.ageDays, current: e.current, quote: e.quote, url: e.url, openDays: e.openDays })),
    },
  };
}

/**
 * Analyst for today's leads (not the watchlist). Same evidence + plays = cached analysis, so test sends and
 * re-runs don't pay twice. Written by Sonnet (WRITER_MODEL) at ANALYST_EFFORT (low|medium); spend counts against its own
 * persisted daily cap (usage_daily "sonnet", WRITER_DAILY_CAP_USD, default $1), apart from the tick's Haiku cap.
 */
export async function analyzeLeads(
  leads: RankInput<ScoredAccount>[], contacts: Map<string, Contact | null>, pack: Pack,
  opts: { write?: boolean; dailyCapUsd?: number; llm?: LlmClient; usage?: UsageStore } = {},
): Promise<{ analyses: Map<string, LeadAnalysis>; fresh: number; cached: number; failed: number; spentUsd: number; skipped?: string; /** drafts proved with their customers' signals */ buyerSamples?: number }> {
  const out = new Map<string, LeadAnalysis>();
  const res = { analyses: out, fresh: 0, cached: 0, failed: 0, spentUsd: 0 } as Awaited<ReturnType<typeof analyzeLeads>>;
  if (!leads.length) return res;
  const write = opts.write !== false;
  const db = getDb();
  // model + prompt in the key: a prompt change re-writes openers instead of serving stale cached ones
  const version = `${WRITER_MODEL}:${createHash("sha256").update(analystSystemPrompt(pack)).digest("hex").slice(0, 8)}`;
  const prepared = leads.map((l) => ({ l, ...inputFor(l, contacts.get(l.account.id), version, pack) }));

  // steps 2-4: research each lead's business, pick the changes in its market that would matter to it and find live
  // examples (Haiku once per account; examples from the database). The play joins the draft's cache key, so a new
  // play means a new email; the brief is rebuilt every run from current facts.
  const plays = new Map<string, MarketPlay>();
  const briefs = new Map<string, string>();
  // research: Haiku with thinking (effort medium), its own small daily cap (RESEARCH_DAILY_CAP_USD, usage_daily
  // "haiku_research"); once per company per 120 days. (Sonnet + web search reads their site better but costs ~15x:
  // set RESEARCH_MODEL=sonnet to use it.)
  let researcher: LlmClient & { spent: number } | null = null;
  const rcap = Number(process.env.RESEARCH_DAILY_CAP_USD ?? 0.03);
  if (pack.modules.modules.length && !opts.llm && process.env.ANTHROPIC_API_KEY) {
    const left = rcap - (await (opts.usage ?? neonUsage()).spentToday("haiku_research"));
    if (left > 0) researcher = process.env.RESEARCH_MODEL === "sonnet" ? new SonnetClient({ capUsd: left, effort: "medium", web: { searches: 3, fetches: 2 }, label: "research" }) : new HaikuClient({ capUsd: left });
  }
  const today = new Date().toISOString().slice(0, 10);
  const memo: LookupMemo = {}; // the shortage list, approvals and recalls: fetched once for every lead in the run
  for (const p of prepared) {
    try {
      const top = p.l.score.drivers[0];
      const r = await researchFor(p.l.account, top?.quote, pack, researcher, write);
      const mp = r ? await marketPlay(r, { id: p.l.account.id, name: p.l.account.name, region: p.l.account.region, segment: p.l.account.segment }, pack, memo) : null;
      if (!mp) continue;
      plays.set(p.l.account.id, mp);
      briefs.set(p.l.account.id, briefText(mp, { company: p.l.account.name ?? p.l.account.domain, ...(top ? { trigger: { quote: top.quote, url: top.url } } : {}) }, today));
      p.key = createHash("sha256").update(`${p.key}|${mp.module}|${mp.changes.map((c) => `${c.id}:${c.examples.map((e) => e.accountId).join(",")}`).join(";")}`).digest("hex").slice(0, 24);
    } catch { /* the lead goes without a market play */ }
  }
  if (researcher && researcher.spent > 0) await (opts.usage ?? neonUsage()).addSpend("haiku_research", researcher.spent, rcap);
  res.buyerSamples = plays.size;

  const prior = await db.select().from(analyses).where(and(
    inArray(analyses.accountId, prepared.map((p) => p.l.account.id)),
    inArray(analyses.evidenceKey, prepared.map((p) => p.key)),
  ));
  const todo: typeof prepared = [];
  for (const p of prepared) {
    const hit = prior.find((r) => r.accountId === p.l.account.id && r.evidenceKey === p.key);
    if (hit?.opener && hit.angle) {
      // rows written before Nov 21 could hold null for a citation of the proof sample (no stored ref): skip those
      const urls = ((hit.cited ?? []) as ({ url: string } | null)[]).flatMap((c) => (c?.url ? [c.url] : []));
      out.set(p.l.account.id, {
        hypothesis: hit.hypothesis, angle: hit.angle, opener: hit.opener, counterEvidence: hit.counterEvidence, confidence: hit.confidence ?? 0,
        email: hit.emailSubject && hit.emailBody ? { subject: hit.emailSubject, body: hit.emailBody } : null, linkedin: hit.linkedinMessage ?? null,
        citations: urls.map((u) => p.refs.findIndex((r) => r.url === u)).filter((i) => i >= 0), cachedFrom: hit.createdAt,
        ...(briefs.has(p.l.account.id) ? { brief: briefs.get(p.l.account.id)!, market: marketLines(plays.get(p.l.account.id)) } : {}),
      });
      res.cached++;
    } else todo.push(p);
  }
  if (!todo.length) return res;

  // drafts: Sonnet for the first few a day (WRITER_DAILY_CAP_USD, small), then Haiku with thinking (HAIKU_WRITER_DAILY_CAP_USD,
  // usage_daily "haiku_writer"), so every lead gets a draft on a few dollars a month
  let llm = opts.llm;
  let writer: WriterClient | null = null, haikuWriter: HaikuClient | null = null;
  const usage = opts.usage ?? (opts.llm ? null : neonUsage());
  const cap = opts.dailyCapUsd ?? Number(process.env.WRITER_DAILY_CAP_USD ?? 0.08);
  const hwCap = Number(process.env.HAIKU_WRITER_DAILY_CAP_USD ?? 0.03);
  let sonnetLeft = 0;
  if (!llm) {
    if (!process.env.ANTHROPIC_API_KEY) return { ...res, skipped: "no ANTHROPIC_API_KEY" };
    sonnetLeft = cap - (await usage!.spentToday(WRITER_USAGE));
    const haikuLeft = hwCap - (await usage!.spentToday("haiku_writer"));
    if (sonnetLeft > 0) writer = new WriterClient({ capUsd: sonnetLeft, effort: writerEffort() });
    if (haikuLeft > 0) haikuWriter = new HaikuClient({ capUsd: haikuLeft });
    if (!writer && !haikuWriter) return { ...res, skipped: "daily writer caps reached" };
  }
  /** Sonnet while a full draft (about $0.03 with rewrites) still fits its budget, else Haiku */
  const writerFor = (): { llm: LlmClient; model: string } | null => {
    if (opts.llm) return { llm: opts.llm, model: WRITER_MODEL };
    if (writer && sonnetLeft - writer.spent >= 0.03) return { llm: writer, model: WRITER_MODEL };
    return haikuWriter ? { llm: haikuWriter, model: HAIKU_MODEL } : null;
  };
  // the reply check runs on Haiku (fractions of a cent per draft), within the Haiku daily cap
  let critic: HaikuClient | null = null;
  if (!opts.llm && process.env.ANTHROPIC_API_KEY) {
    const hcap = Number(process.env.HAIKU_DAILY_CAP_USD ?? 0.06), left = hcap - (await (usage ?? neonUsage()).spentToday("haiku"));
    if (left > 0) critic = new HaikuClient({ capUsd: Math.min(left, 0.02) });
  }
  try {
    for (const p of todo) {
      // proof: a small real sample from the public list the play's free step names (2-3 rows + the true total)
      const free = p.l.score.plays.find((x) => x.free)?.free;
      const kind = free ? pack.capabilities.capabilities.find((c) => c.id === free)?.list : undefined;
      let proved = false;
      if (kind) {
        try {
          const sample = await proofSample(pack, kind, p.input.evidence.map((e) => e.quote));
          if (sample) { p.input.evidence.push({ type: "public_record_sample", ageDays: 0, current: true, quote: sample.quote, url: sample.url }); proved = true; }
        } catch { /* the email goes without a sample */ }
      }
      // every industry: the changes in their market with live examples (the play), and the brief the email offers
      const mp = plays.get(p.l.account.id);
      if (mp) {
        p.input.evidence.push(...playEvidence(mp));
        p.input.plays = [{ id: `market:${mp.module}`, title: mp.moduleTitle, angle: `Their business: ${mp.research.sells}, sold to ${mp.research.who}. The changes in their market: ${mp.changes.map((c) => `${c.title} (${c.why})`).join("; ")}.`,
          offer: `a short written brief on ${mp.changes.length} changes in their market, with the companies behind each (it is ready to send); then ${mp.offer}` }, ...p.input.plays];
      } else if (!proved) { /* no play and no list: the email stands on the lead's own signals */ }
      let a: Analysis | null = null;
      // TELL_DEBUG_DRAFTS=1 (local only: it prints lead details) shows why drafts were rejected
      const debug = process.env.TELL_DEBUG_DRAFTS && !process.env.CI ? (r: string) => console.error(`[draft rejected] ${p.input.company}: ${r}`) : undefined;
      const w = writerFor();
      if (!w) { res.failed++; continue; }
      try { a = await analyzeLead(w.llm, pack, p.input, debug, critic ?? undefined); } catch (e) { debug?.(`error: ${(e as Error).message}`); }
      if (!a) { res.failed++; continue; }
      out.set(p.l.account.id, { ...a, ...(briefs.has(p.l.account.id) ? { brief: briefs.get(p.l.account.id)!, market: marketLines(plays.get(p.l.account.id)) } : {}) });
      res.fresh++;
      if (write) {
        await db.insert(analyses).values({
          accountId: p.l.account.id, hypothesis: a.hypothesis, angle: a.angle, opener: a.opener, citations: [],
          // the proof sample is added to the evidence after refs were taken, so a citation of it has no ref: dropped
          cited: a.citations.flatMap((i) => (p.refs[i] ? [p.refs[i]!] : [])), counterEvidence: a.counterEvidence, confidence: a.confidence,
          evidenceKey: p.key, model: w.model, emailSubject: a.email?.subject ?? null, emailBody: a.email?.body ?? null, linkedinMessage: a.linkedin,
        }).onConflictDoNothing({ target: [analyses.accountId, analyses.evidenceKey] });
      }
    }
  } finally {
    if (writer) { res.spentUsd = writer.spent; await usage?.addSpend(WRITER_USAGE, writer.spent, cap); }
    if (haikuWriter && haikuWriter.spent > 0) { res.spentUsd += haikuWriter.spent; await usage?.addSpend("haiku_writer", haikuWriter.spent, hwCap); }
    if (critic && critic.spent > 0) await usage?.addSpend("haiku", critic.spent, Number(process.env.HAIKU_DAILY_CAP_USD ?? 0.06));
  }
  return res;
}

