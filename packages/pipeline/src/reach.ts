import type { Pack } from "@tell/config";
import { rankAccounts, type Ranking, type RankInput } from "@tell/intel";
import type { Contact } from "@tell/people";
import type { ScoredAccount } from "./score.js";

/** Reach is on when any multiplier in the pack's icp.reach is below 1. */
export const reachEnabled = (pack: Pack) => Object.values(pack.icp.reach).some((v) => v < 1);

/** Persona titles that own each lead's problem, from its strongest play that names any. */
export function preferredPersonas(rows: RankInput<ScoredAccount>[]): Map<string, string[]> {
  return new Map(rows.flatMap((r) => { const p = r.score.plays.find((x) => x.personas?.length); return p ? [[r.account.id, p.personas!]] : []; }));
}

/**
 * How reachable a lead is: a named contact who owns the problem (the play's persona) with an email we've seen or that
 * follows the company's pattern scores 1; each gap multiplies by the pack's factor. Exported for tests.
 */
export function reachFactor(contact: Contact | null | undefined, owners: string[], r: Pack["icp"]["reach"]): number {
  if (!contact) return r.no_contact;
  let f = 1;
  const e = contact.person.email;
  if (!e || e.status === "invalid") f *= contact.generic ? r.guessed_email : r.no_email;
  else if (e.status === "guessed") f *= r.guessed_email;
  if (owners.length && (!contact.persona || !owners.includes(contact.persona))) f *= r.off_persona;
  return f;
}

/** Re-rank the pool (2x max_leads) by priority x reach, keeping the usual guarantees (fast lane, reserved slots). */
export function rerankByReach(pool: Ranking<ScoredAccount>, contacts: Map<string, Contact | null>, pack: Pack, max: number): { ranking: Ranking<ScoredAccount>; factors: Map<string, number> } {
  const owners = preferredPersonas([...pool.leads, ...pool.watchlist]);
  const factors = new Map<string, number>();
  const rows = [...pool.leads, ...pool.watchlist].map((r) => {
    const f = reachFactor(contacts.get(r.account.id), owners.get(r.account.id) ?? [], pack.icp.reach);
    factors.set(r.account.id, f);
    return { ...r, score: { ...r.score, priority: r.score.priority * f } };
  });
  const ranking = rankAccounts(rows, max, 5, { reserveNonHiring: pack.delivery.digest.reserved_non_hiring, freshDays: pack.signals.eligibility.fresh_days });
  return { ranking: { ...ranking, held: pool.held }, factors };
}
