import type { Pack } from "@tell/config";
import { HaikuClient, judgeOpportunity, type LlmClient, type JudgeEvidence, type JudgeContext } from "@tell/extract";
import { getDb, builtPlays, deliveries, labels, accounts, sql } from "@tell/db";
import { neonUsage, type UsageStore } from "./usage.js";
import { listInputs } from "./sample-list.js";
import type { ScoreRunResult, StoredPlay } from "./score.js";

export const JUDGE_MAX_EVIDENCE = 8;
/** a past play becomes an example for the judge only after this many positive outcomes (one lucky reply isn't a pattern) */
export const LIBRARY_MIN_POSITIVE = 2;

/** Does a list generator have its inputs in these quotes? (what `pnpm freelist` would need) */
export function listReady(list: string, quotes: string[]): boolean {
  const i = listInputs(quotes);
  switch (list) {
    case "federal_buyers": return !!(i.drug || i.device);
    case "anda_holders": return !!i.drug;
    case "hospitals": return !!i.state;
    case "permits": return !!i.city;
    case "recompetes": return !!i.naics;
    default: return false;
  }
}

/** The play library: judged plays in this industry whose leads got replies (👍 or replied / meeting / won). */
async function libraryExamples(pack: Pack): Promise<Map<string, JudgeContext["examples"]>> {
  const rows = (await getDb().execute(sql`
    select a.segment, bp.play, count(distinct d.id) filter (where l.label = 'good' or l.outcome in ('replied','meeting','won'))::int as pos
    from ${builtPlays} bp join ${accounts} a on a.id = bp.account_id
    join ${deliveries} d on d.account_id = bp.account_id and d.delivered_at >= bp.created_at
    left join ${labels} l on l.delivery_id = d.id
    where bp.play is not null group by a.segment, bp.play`)).rows as { segment: string | null; play: StoredPlay; pos: number }[];
  const out = new Map<string, JudgeContext["examples"]>();
  for (const r of rows.filter((x) => x.pos >= LIBRARY_MIN_POSITIVE).sort((a, b) => b.pos - a.pos)) {
    const k = r.segment ?? "?";
    const list = out.get(k) ?? [];
    if (list.length < 3) list.push({ title: r.play.title, angle: r.play.angle, offer: r.play.offer });
    out.set(k, list);
  }
  void pack;
  return out;
}

/**
 * Digest step (signals.score.mode: judged): judge the accounts with no judgement for their current evidence (freshest
 * first, up to judge.per_run), store the play + ratings keyed by evidence and prompt version, or the "no" with its
 * reason. The digest re-scores after this. Written on dry runs too (facts, not deliveries).
 */
export async function judgeAccounts(candidates: ScoreRunResult["judgeCandidates"], pack: Pack, opts: { llm?: LlmClient; usage?: UsageStore } = {}):
  Promise<{ judged: number; qualified: number; rejected: number; failed: number; skipped?: string; reasons: Record<string, number> }> {
  const res = { judged: 0, qualified: 0, rejected: 0, failed: 0, reasons: {} as Record<string, number> };
  if (pack.signals.score.mode !== "judged") return { ...res, skipped: "legacy scoring" };
  if (!candidates.length) return { ...res, skipped: "nothing to judge" };
  let llm = opts.llm ?? null, haiku: HaikuClient | null = null;
  const usage = opts.usage ?? (opts.llm ? null : neonUsage());
  const cap = Number(process.env.HAIKU_DAILY_CAP_USD ?? 1);
  if (!llm) {
    if (!process.env.ANTHROPIC_API_KEY) return { ...res, skipped: "no ANTHROPIC_API_KEY" };
    const left = cap - (await usage!.spentToday("haiku"));
    if (left <= 0) return { ...res, skipped: "Haiku daily cap reached" };
    llm = haiku = new HaikuClient({ capUsd: left });
  }
  const db = getDb();
  const library = await libraryExamples(pack).catch(() => new Map<string, JudgeContext["examples"]>());
  try {
    for (const c of candidates.slice(0, pack.signals.score.judge.per_run)) {
      const drivers = c.score.drivers.slice(0, JUDGE_MAX_EVIDENCE);
      const ev: JudgeEvidence[] = drivers.map((e) => ({ type: e.type, quote: e.quote, ageDays: e.ageDays, current: e.current, strength: pack.signals.signals[e.type]?.strength ?? 3 }));
      const ind = c.account.segment ? pack.icp.industries[c.account.segment] : undefined;
      const ctx: JudgeContext = {
        ...(ind ? { industry: { label: ind.label, description: ind.description, hint: ind.hint ?? ind.opportunity, buyers: ind.buyers } } : {}),
        fixedHints: c.score.plays.filter((p) => !p.id.startsWith("built:") && !p.id.startsWith("judged:")).slice(0, 2).map((p) => ({ title: p.title, angle: p.angle })),
        examples: library.get(c.account.segment ?? "?") ?? [],
      };
      const facts = [c.account.sizeBand && `${c.account.sizeBand} people`, c.account.segment, c.account.region].filter(Boolean).join(", ");
      let r;
      try { r = await judgeOpportunity(llm, pack, c.account.name ?? c.account.domain, facts, ev, ctx, listReady); } catch { res.failed++; continue; }
      res.judged++;
      const play: StoredPlay | null = r.qualifies
        ? { title: r.judged.title, need: r.judged.need, angle: r.judged.angle, offer: r.judged.offer, personas: r.judged.personas, cited: r.judged.citations.map((i) => ({ type: drivers[i]!.type, url: drivers[i]!.url })), rubric: r.judged.rubric, free: r.judged.free, paid: r.judged.paid }
        : null;
      if (r.qualifies) res.qualified++;
      else { res.rejected++; const k = r.reason.split(/[(:,]/)[0]!.trim().slice(0, 40); res.reasons[k] = (res.reasons[k] ?? 0) + 1; }
      await db.insert(builtPlays).values({ accountId: c.account.id, evidenceKey: c.evidenceKey, play, reason: r.qualifies ? null : r.reason })
        .onConflictDoUpdate({ target: [builtPlays.accountId, builtPlays.evidenceKey], set: { play, reason: r.qualifies ? null : r.reason, createdAt: new Date() } });
    }
  } finally {
    if (haiku && haiku.spent > 0) await usage?.addSpend("haiku", haiku.spent, cap);
  }
  return res;
}
