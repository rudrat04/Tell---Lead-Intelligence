/**
 * Self-tuning (plan 11c), proposals only: suggests new likelihood ratios for signal types from your labels and
 * outcomes. Nothing is applied automatically; you approve a change by editing your pack.
 *
 * Method: for each signal type, compare the good-rate of labelled leads that had it with the overall good-rate,
 * shrunk toward "no change" by a Beta prior worth `priorWeight` labels, so a handful of labels barely moves anything
 * and zero labels changes nothing. Each weekly move is capped at ±maxStep. Replies and meetings weigh more than
 * a Good tap; "no reply" counts as half a Bad.
 */

export interface LabelledLead {
  /** signal types in the lead's evidence when it was delivered (or now, if that's all we have) */
  types: string[];
  label: "good" | "bad" | null;
  outcome: string | null;
}

export interface TuningOptions { priorWeight?: number; maxStep?: number; minLeads?: number }

export interface LrProposal { type: string; before: number; after: number; leads: number; goodRate: number; baseRate: number; reason: string }

/** How much a lead counts as good (positive) or bad (negative) evidence. */
export function leadWeight(l: LabelledLead): { good: number; bad: number } {
  const o = (l.outcome ?? "").toLowerCase();
  if (o === "won") return { good: 4, bad: 0 };
  if (o === "meeting") return { good: 3, bad: 0 };
  if (o === "replied") return { good: 2, bad: 0 };
  if (l.label === "good") return { good: 1, bad: o === "no reply" ? 0.5 : 0 };
  if (l.label === "bad") return { good: 0, bad: 1 };
  if (o === "no reply" || o === "lost") return { good: 0, bad: 0.5 };
  return { good: 0, bad: 0 };
}

export function proposeLrs(current: Record<string, { lr: number }>, leads: LabelledLead[], opts: TuningOptions = {}): LrProposal[] {
  const k = opts.priorWeight ?? 10, step = opts.maxStep ?? 0.25, minLeads = opts.minLeads ?? 5;
  const w = leads.map((l) => ({ ...leadWeight(l), types: new Set(l.types) })).filter((x) => x.good + x.bad > 0);
  const G = w.reduce((a, x) => a + x.good, 0), N = w.reduce((a, x) => a + x.good + x.bad, 0);
  if (N === 0) return [];
  const p0 = G / N;
  if (p0 <= 0 || p0 >= 1) return []; // all good or all bad: nothing to compare against
  const out: LrProposal[] = [];
  for (const [type, spec] of Object.entries(current)) {
    const with_ = w.filter((x) => x.types.has(type));
    if (with_.length < minLeads) continue;
    const g = with_.reduce((a, x) => a + x.good, 0), n = with_.reduce((a, x) => a + x.good + x.bad, 0);
    const pt = (g + k * p0) / (n + k); // shrunk toward the overall rate
    const ratio = Math.min(1 + step, Math.max(1 - step, pt / p0));
    const after = Math.round(spec.lr * ratio * 100) / 100;
    if (Math.abs(after - spec.lr) / spec.lr < 0.03) continue; // under 3%: not worth a change
    out.push({
      type, before: spec.lr, after, leads: with_.length, goodRate: Math.round((g / n) * 100) / 100, baseRate: Math.round(p0 * 100) / 100,
      reason: `${Math.round((g / n) * 100)}% good with it vs ${Math.round(p0 * 100)}% overall, ${with_.length} leads`,
    });
  }
  return out.sort((a, b) => Math.abs(b.after / b.before - 1) - Math.abs(a.after / a.before - 1));
}

/**
 * Offline champion/challenger check: of every (good, bad) pair of labelled leads, how often does a config rank the
 * good one higher? 0.5 = chance. A challenger is worth adopting only if it beats the champion on the same pairs.
 */
export function pairwiseAgreement(items: { good: boolean; priority: number }[]): { agreement: number; pairs: number } {
  const goods = items.filter((x) => x.good), bads = items.filter((x) => !x.good);
  let agree = 0, pairs = 0;
  for (const g of goods) for (const b of bads) { pairs++; agree += g.priority > b.priority ? 1 : g.priority === b.priority ? 0.5 : 0; }
  return { agreement: pairs ? Math.round((agree / pairs) * 1000) / 1000 : 0.5, pairs };
}
