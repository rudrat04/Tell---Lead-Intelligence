import type { Pack } from "@tell/config";
import { HaikuClient, buildPlay, type LlmClient, type BuilderEvidence } from "@tell/extract";
import { getDb, builtPlays } from "@tell/db";
import { neonUsage, type UsageStore } from "./usage.js";
import type { ScoreRunResult, StoredPlay } from "./score.js";

/** Evidence items the builder reads per account (strongest first). */
export const BUILDER_MAX_EVIDENCE = 8;

/**
 * Digest step (plays.build): for pool accounts whose evidence fits no pack play, build one from the evidence (Haiku,
 * checked in code) and store it keyed by the evidence; the digest re-scores after this, so a qualifying play makes the
 * lead and "no need" drops it. Written on dry runs too (facts, not deliveries), so a re-run doesn't pay again.
 */
export async function buildMissingPlays(candidates: ScoreRunResult["playCandidates"], pack: Pack, opts: { llm?: LlmClient; usage?: UsageStore } = {}):
  Promise<{ built: number; qualified: number; rejected: number; failed: number; skipped?: string; reasons: Record<string, number> }> {
  const res = { built: 0, qualified: 0, rejected: 0, failed: 0, reasons: {} as Record<string, number> };
  if (!pack.plays.build?.enabled || !candidates.length) return { ...res, ...(candidates.length ? {} : { skipped: "nothing to build" }) };
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
  try {
    for (const c of candidates.slice(0, pack.plays.build.per_run)) {
      const drivers = c.score.drivers.slice(0, BUILDER_MAX_EVIDENCE);
      const ev: BuilderEvidence[] = drivers.map((e) => ({ type: e.type, quote: e.quote, ageDays: e.ageDays, current: e.current, strength: pack.signals.signals[e.type]?.strength ?? 3 }));
      const facts = [c.account.sizeBand && `${c.account.sizeBand} people`, c.account.segment, c.account.region].filter(Boolean).join(", ");
      let r;
      const ind = c.account.segment ? pack.icp.industries[c.account.segment] : undefined;
      const industry = ind ? { label: ind.label, opportunity: ind.hint ?? ind.opportunity, offer: ind.offer, buyers: ind.buyers } : undefined;
      if (res.failed >= 3 && res.built === 0) break; // the API is refusing: don't spend the run failing
      try { r = await buildPlay(llm, pack, c.account.name ?? c.account.domain, facts, ev, industry); } catch { res.failed++; continue; }
      res.built++;
      const play: StoredPlay | null = r.qualifies
        ? { title: r.play.title, need: r.play.need, angle: r.play.angle, offer: r.play.offer, personas: r.play.personas, cited: r.play.citations.map((i) => ({ type: drivers[i]!.type, url: drivers[i]!.url })) }
        : null;
      if (r.qualifies) res.qualified++;
      else { res.rejected++; const k = r.reason.split(/[(:]/)[0]!.trim().slice(0, 40); res.reasons[k] = (res.reasons[k] ?? 0) + 1; }
      await db.insert(builtPlays).values({ accountId: c.account.id, evidenceKey: c.evidenceKey, play, reason: r.qualifies ? null : r.reason })
        .onConflictDoUpdate({ target: [builtPlays.accountId, builtPlays.evidenceKey], set: { play, reason: r.qualifies ? null : r.reason, createdAt: new Date() } });
    }
  } finally {
    if (haiku && haiku.spent > 0) await usage?.addSpend("haiku", haiku.spent, cap);
  }
  return res;
}
