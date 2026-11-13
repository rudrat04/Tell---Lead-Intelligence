import type { Pack } from "@tell/config";
import { proposeLrs, pairwiseAgreement, scoreAccount, featurize, type LabelledLead, type LrProposal } from "@tell/intel";
import { getDb, deliveries, labels, tuningActions, exemplars, eq, sql } from "@tell/db";
import { runScoring } from "./score.js";

export interface TuningResult {
  labelled: number;
  proposals: LrProposal[];
  /** offline check on the same labelled leads: how often good ranks above bad (0.5 = chance) */
  champion: { agreement: number; pairs: number };
  challenger: { agreement: number; pairs: number };
  recorded: number;
  /** Gate 2 examples rebuilt from labelled posts */
  exemplars?: { pos: number; neg: number };
  skipped?: string;
}

/**
 * Gate 2 examples from your labels: the post quotes (explicit asks, pain posts) behind leads you marked Good (pos)
 * or Bad (neg). Rebuilt each week, so a changed label moves its example. Seeds in the pack are separate.
 */
export async function refreshExemplars(pack: Pack): Promise<{ pos: number; neg: number }> {
  const postTypes = Object.entries(pack.signals.signals).filter(([, s]) => s.class === "explicit" || s.class === "pain").map(([t]) => t);
  if (!postTypes.length) return { pos: 0, neg: 0 };
  const db = getDb();
  const rows = (await db.execute(sql`
    select l.id as label_id, l.label, s.type, s.evidence_quote as quote
    from labels l join deliveries d on d.id = l.delivery_id
    join signals s on s.account_id = d.account_id and s.observed_at <= d.delivered_at + interval '1 day'
    where l.label in ('good', 'bad') and s.type in (${sql.join(postTypes.map((t) => sql`${t}`), sql`, `)})`)).rows as { label_id: string; label: string; type: string; quote: string }[];
  await db.delete(exemplars).where(sql`${exemplars.sourceLabelId} is not null`);
  if (rows.length) {
    await db.insert(exemplars).values(rows.map((r) => ({
      text: r.quote, embedding: featurize(r.quote), signalType: r.type, label: r.label === "good" ? "pos" : "neg", sourceLabelId: r.label_id,
    })));
  }
  return { pos: rows.filter((r) => r.label === "good").length, neg: rows.filter((r) => r.label === "bad").length };
}

/** Labels count once there are this many labelled leads with at least one good and one bad. */
export const MIN_LABELLED = 20;

/**
 * Weekly (Sunday): propose new likelihood ratios from your labels and outcomes, and check them offline against the
 * current config by pairwise agreement. Proposals go to `tuning_actions` (status "proposed") and the digest health
 * line; they are never applied automatically. Evidence is today's evidence for each labelled account.
 */
export async function runTuning(opts: { pack: Pack; write?: boolean }): Promise<TuningResult> {
  const { pack } = opts;
  const db = getDb();
  const rows = (await db.select({ accountId: deliveries.accountId, label: labels.label, outcome: labels.outcome })
    .from(labels).innerJoin(deliveries, eq(labels.deliveryId, deliveries.id))
    .where(sql`${deliveries.accountId} is not null and (${labels.label} is not null or ${labels.outcome} is not null)`)) as { accountId: string; label: string | null; outcome: string | null }[];
  const ex = opts.write !== false ? await refreshExemplars(pack).catch(() => undefined) : undefined;
  const empty = { agreement: 0.5, pairs: 0 };
  const base: TuningResult = { labelled: rows.length, proposals: [], champion: empty, challenger: empty, recorded: 0, exemplars: ex };
  if (rows.length < MIN_LABELLED) return { ...base, skipped: `${rows.length}/${MIN_LABELLED} labelled leads` };

  const scored = await runScoring({ pack, write: false });
  const byId = new Map((scored.all ?? []).map((r) => [r.account.id, r]));
  const leads: (LabelledLead & { accountId: string })[] = rows.flatMap((r) => {
    const s = byId.get(r.accountId);
    return s ? [{ accountId: r.accountId, types: [...new Set(s.score.evidence.map((e) => e.type))], label: (r.label === "good" || r.label === "bad" ? r.label : null), outcome: r.outcome }] : [];
  });
  const proposals = proposeLrs(pack.signals.signals, leads);

  // challenger = the pack with the proposed LRs; both scored on the same evidence
  const challenger: Pack = { ...pack, signals: { ...pack.signals, signals: { ...pack.signals.signals } } };
  for (const p of proposals) challenger.signals.signals[p.type] = { ...challenger.signals.signals[p.type]!, lr: p.after };
  const judged = leads.filter((l) => l.label);
  const rank = (p: Pack) => pairwiseAgreement(judged.map((l) => {
    const s = byId.get(l.accountId)!;
    return { good: l.label === "good", priority: scoreAccount(s.score.evidence, s.account, p).priority };
  }));
  const res: TuningResult = { ...base, proposals, champion: rank(pack), challenger: rank(challenger) };

  if (opts.write !== false && proposals.length) {
    await db.insert(tuningActions).values(proposals.map((p) => ({
      action: "propose_lr", target: p.type, reason: p.reason, before: { lr: p.before }, after: { lr: p.after }, status: "proposed",
    })));
    res.recorded = proposals.length;
  }
  return res;
}
