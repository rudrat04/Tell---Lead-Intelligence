import { createHash } from "node:crypto";
import type { Pack } from "@tell/config";
import { WriterClient, WRITER_MODEL, writerEffort, analyzeLead, analystSystemPrompt, type Analysis, type AnalystInput, type LlmClient } from "@tell/extract";
import type { Contact } from "@tell/people";
import type { RankInput } from "@tell/intel";
import { getDb, analyses, and, inArray } from "@tell/db";
import { neonUsage, type UsageStore } from "./usage.js";
import type { ScoredAccount } from "./score.js";

/** Evidence items the analyst sees per lead (strongest first). */
export const ANALYST_MAX_EVIDENCE = 6;
/** usage_daily service for the writer's spend */
export const WRITER_USAGE = "sonnet";

export interface LeadAnalysis extends Analysis { cachedFrom?: Date | null }

function inputFor(l: RankInput<ScoredAccount>, contact: Contact | null | undefined, version: string, pack: Pack): { input: AnalystInput; key: string; refs: { kind: string; id: string; url: string }[] } {
  const a = l.account, s = l.score;
  const industry = a.segment ? pack.icp.industries[a.segment] : undefined;
  const ev = s.drivers.slice(0, ANALYST_MAX_EVIDENCE);
  const refs = ev.map((e) => ({ kind: e.ref.kind, id: e.ref.id, url: e.url }));
  const key = createHash("sha256").update(JSON.stringify([version, refs.map((r) => `${r.kind}:${r.id}`), s.plays.map((p) => p.id)])).digest("hex").slice(0, 24);
  return {
    key, refs,
    input: {
      company: a.name ?? a.domain, domain: a.domain,
      facts: [a.sizeBand && `${a.sizeBand} people`, a.segment?.toUpperCase(), a.region].filter(Boolean).join(", "),
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
): Promise<{ analyses: Map<string, LeadAnalysis>; fresh: number; cached: number; failed: number; spentUsd: number; skipped?: string }> {
  const out = new Map<string, LeadAnalysis>();
  const res = { analyses: out, fresh: 0, cached: 0, failed: 0, spentUsd: 0 } as Awaited<ReturnType<typeof analyzeLeads>>;
  if (!leads.length) return res;
  const write = opts.write !== false;
  const db = getDb();
  // model + prompt in the key: a prompt change re-writes openers instead of serving stale cached ones
  const version = `${WRITER_MODEL}:${createHash("sha256").update(analystSystemPrompt(pack)).digest("hex").slice(0, 8)}`;
  const prepared = leads.map((l) => ({ l, ...inputFor(l, contacts.get(l.account.id), version, pack) }));

  const prior = await db.select().from(analyses).where(and(
    inArray(analyses.accountId, prepared.map((p) => p.l.account.id)),
    inArray(analyses.evidenceKey, prepared.map((p) => p.key)),
  ));
  const todo: typeof prepared = [];
  for (const p of prepared) {
    const hit = prior.find((r) => r.accountId === p.l.account.id && r.evidenceKey === p.key);
    if (hit?.opener && hit.angle) {
      const urls = ((hit.cited ?? []) as { url: string }[]).map((c) => c.url);
      out.set(p.l.account.id, {
        hypothesis: hit.hypothesis, angle: hit.angle, opener: hit.opener, counterEvidence: hit.counterEvidence, confidence: hit.confidence ?? 0,
        email: hit.emailSubject && hit.emailBody ? { subject: hit.emailSubject, body: hit.emailBody } : null, linkedin: hit.linkedinMessage ?? null,
        citations: urls.map((u) => p.refs.findIndex((r) => r.url === u)).filter((i) => i >= 0), cachedFrom: hit.createdAt,
      });
      res.cached++;
    } else todo.push(p);
  }
  if (!todo.length) return res;

  let llm = opts.llm;
  let writer: WriterClient | null = null;
  const usage = opts.usage ?? (opts.llm ? null : neonUsage());
  const cap = opts.dailyCapUsd ?? Number(process.env.WRITER_DAILY_CAP_USD ?? 1);
  if (!llm) {
    if (!process.env.ANTHROPIC_API_KEY) return { ...res, skipped: "no ANTHROPIC_API_KEY" };
    const remaining = cap - (await usage!.spentToday(WRITER_USAGE));
    if (remaining <= 0) return { ...res, skipped: "daily writer cap reached" };
    llm = writer = new WriterClient({ capUsd: remaining, effort: writerEffort() });
  }
  try {
    for (const p of todo) {
      let a: Analysis | null = null;
      // TELL_DEBUG_DRAFTS=1 (local only: it prints lead details) shows why drafts were rejected
      const debug = process.env.TELL_DEBUG_DRAFTS && !process.env.CI ? (r: string) => console.error(`[draft rejected] ${p.input.company}: ${r}`) : undefined;
      try { a = await analyzeLead(llm, pack, p.input, debug); } catch (e) { debug?.(`error: ${(e as Error).message}`); }
      if (!a) { res.failed++; continue; }
      out.set(p.l.account.id, a);
      res.fresh++;
      if (write) {
        await db.insert(analyses).values({
          accountId: p.l.account.id, hypothesis: a.hypothesis, angle: a.angle, opener: a.opener, citations: [],
          cited: a.citations.map((i) => p.refs[i]!), counterEvidence: a.counterEvidence, confidence: a.confidence,
          evidenceKey: p.key, model: WRITER_MODEL, emailSubject: a.email?.subject ?? null, emailBody: a.email?.body ?? null, linkedinMessage: a.linkedin,
        }).onConflictDoNothing({ target: [analyses.accountId, analyses.evidenceKey] });
      }
    }
  } finally {
    if (writer) { res.spentUsd = writer.spent; await usage?.addSpend(WRITER_USAGE, writer.spent, cap); }
  }
  return res;
}

