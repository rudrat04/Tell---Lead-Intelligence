/** Gate 5: corroboration (plan section 7).
 * Trigger/pain signals need one intent signal, or two independent trigger/pain signals within 30 days.
 * Explicit intent and fast-lane signals pass alone. */

export interface ConfirmedSignal {
  class: "explicit" | "implicit" | "trigger" | "pain" | "negative";
  type: string;
  observedAt: Date;
  fastLane?: boolean;
  /** event cluster id: copies of one event must not corroborate each other */
  clusterId: string;
}

const DAY = 86_400_000;

/** `needs`: which classes require corroboration (pack signals.eligibility.corroborate; default trigger + pain). */
export function corroborated(candidate: ConfirmedSignal, others: ConfirmedSignal[], windowDays = 30, needs: readonly string[] = ["trigger", "pain"]): boolean {
  if (candidate.class === "explicit" || candidate.class === "implicit" || candidate.fastLane) return true;
  if (!needs.includes(candidate.class)) return true; // negatives always recorded; classes the pack trusts alone
  const near = others.filter(
    (o) => o.clusterId !== candidate.clusterId && Math.abs(o.observedAt.getTime() - candidate.observedAt.getTime()) <= windowDays * DAY,
  );
  if (near.some((o) => o.class === "explicit" || o.class === "implicit")) return true;
  const independent = new Set(near.filter((o) => o.class === "trigger" || o.class === "pain").map((o) => o.clusterId));
  return independent.size >= 1; // candidate + one more independent trigger/pain = two
}
