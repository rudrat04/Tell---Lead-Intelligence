import type { Ranking, RankInput } from "./rank.js";

/**
 * Exploration slots (judged mode): in each digest list, up to `share` of the leads go to industries the system has
 * little outcome data for (`underTested`), so it keeps learning instead of serving the same niche forever. The best
 * under-tested candidates over the floor replace the lowest-ranked well-tested leads of the same list, and are marked
 * `exploring` (recorded as delivery kind "exploration"); under-tested leads that ranked in on their own count toward the share but aren't marked. Pure; exported for tests.
 */
export function applyExploration<A extends { id: string }>(ranking: Ranking<A>, candidates: RankInput<A>[], opts: {
  share: number; underTested: (r: RankInput<A>) => boolean; groupOf: (r: RankInput<A>) => string; capOf: (group: string) => number;
}): Ranking<A> {
  if (opts.share <= 0) return ranking;
  const leads = [...ranking.leads];
  const inLeads = new Set(leads.map((l) => l.account.id));
  const groups = [...new Set(leads.map((l) => l.group ?? opts.groupOf(l)))];
  for (const g of groups) {
    const want = Math.max(1, Math.round(opts.capOf(g) * opts.share));
    const mine = leads.filter((l) => (l.group ?? opts.groupOf(l)) === g);
    let have = mine.filter(opts.underTested).length;
    const pool = candidates.filter((c) => !inLeads.has(c.account.id) && c.score.eligible && !c.recentlyDelivered && opts.underTested(c) && opts.groupOf(c) === g)
      .sort((a, b) => b.score.priority - a.score.priority);
    // swap out the lowest-ranked well-tested leads of this list
    const swappable = mine.filter((l) => !opts.underTested(l)).sort((a, b) => a.score.priority - b.score.priority);
    while (have < want && pool.length && swappable.length) {
      const out = swappable.shift()!, inn = pool.shift()!;
      const i = leads.indexOf(out);
      const judged = inn.score.judged ? { ...inn.score.judged, exploring: true } : undefined;
      leads[i] = { ...inn, group: out.group, score: { ...inn.score, ...(judged ? { judged } : {}) } };
      inLeads.add(inn.account.id);
      have++;
    }
  }
  return { ...ranking, leads };
}
