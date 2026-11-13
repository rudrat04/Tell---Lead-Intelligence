/** Intent scoring (plan section 8d). Log-odds with decay and 70% dampening of non-strongest signals. */

export interface ScoredSignal {
  /** likelihood ratio; >1 raises intent, <1 lowers it (negative signals) */
  lr: number;
  ageDays: number;
  halfLifeDays: number;
  /** extra multiplier (repeats of one type count less); default 1 */
  weight?: number;
}

export const DAMPENING = 0.7;

export const logit = (p: number) => Math.log(p / (1 - p));
export const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export function decayed(s: ScoredSignal): number {
  return Math.log(s.lr) * Math.pow(0.5, s.ageDays / s.halfLifeDays) * (s.weight ?? 1);
}

/**
 * Strongest positive signal counts in full, other positives at 70%.
 * Negative signals subtract in full. Missing evidence contributes 0.
 */
export function intentProbability(baseRate: number, signals: ScoredSignal[]): number {
  const contribs = signals.map(decayed);
  const pos = contribs.filter((c) => c > 0).sort((a, b) => b - a);
  const neg = contribs.filter((c) => c < 0);
  const posSum = pos.reduce((acc, c, i) => acc + (i === 0 ? c : c * DAMPENING), 0);
  const negSum = neg.reduce((a, c) => a + c, 0);
  return sigmoid(logit(baseRate) + posSum + negSum);
}

/** 0.5^(days since newest confirmed signal / 14) */
export function timing(daysSinceNewest: number, halfLife = 14): number {
  return Math.pow(0.5, daysSinceNewest / halfLife);
}

export const priority = (intent: number, fit: number, timingScore: number) => intent * fit * timingScore;

export interface FastLaneInput {
  explicitIntent: boolean;
  maxStrength: number;
  provenPlayPrecision?: number; // best matched play's measured precision
}

/** Fast lane (8d-2): strong single signals skip the combined threshold. Still must pass fit + critic. */
export function isFastLane(i: FastLaneInput): boolean {
  return i.explicitIntent || i.maxStrength >= 5 || (i.provenPlayPrecision ?? 0) > 0.6;
}
