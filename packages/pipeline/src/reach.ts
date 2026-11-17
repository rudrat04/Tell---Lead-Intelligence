import { minScoreFor, type Pack } from "@tell/config";
import { rankAccounts, rankByRegionGroups, enterpriseTitle, displayScore, type Ranking, type RankInput } from "@tell/intel";
import type { Contact } from "@tell/people";
import type { ScoredAccount } from "./score.js";

/** Reach is on when any multiplier in the pack's icp.reach is below 1. */
export const reachEnabled = (pack: Pack) => Object.entries(pack.icp.reach).some(([k, v]) => (k === "warm_path" ? v > 1 : v < 1));

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
  // a past client who just joined (source "network") is the right person whatever their title
  if (owners.length && contact.person.source !== "network" && (!contact.persona || !owners.includes(contact.persona))) f *= r.off_persona;
  if (contact.warm?.length) f *= r.warm_path ?? 1;
  return f;
}

/**
 * Re-rank the pool (2x max_leads) by priority x reach, keeping the usual guarantees (fast lane, reserved slots).
 * A lead with no named contact is dropped, not shown: its slot goes to the next one in the pool.
 */
export function rerankByReach(pool: Ranking<ScoredAccount>, contacts: Map<string, Contact | null>, pack: Pack, max: number): { ranking: Ranking<ScoredAccount>; factors: Map<string, number>; noContact: number; enterprise: number } {
  const owners = preferredPersonas([...pool.leads, ...pool.watchlist]);
  const factors = new Map<string, number>();
  // size unknown and the contact holds a regional / business-unit title: an enterprise, never a lead
  const isEnterprise = (r: RankInput<ScoredAccount>) => !r.account.sizeBand && enterpriseTitle(contacts.get(r.account.id)?.person.role, pack);
  const enterprise = [...pool.leads, ...pool.watchlist].filter(isEnterprise).length;
  const rows = [...pool.leads, ...pool.watchlist].filter((r) => contacts.get(r.account.id) && !isEnterprise(r)).map((r) => {
    const f = reachFactor(contacts.get(r.account.id), owners.get(r.account.id) ?? [], pack.icp.reach);
    factors.set(r.account.id, f);
    return { ...r, score: { ...r.score, priority: r.score.priority * f } };
  }).filter((r) => displayScore(r.score) >= minScoreFor(pack, r.account.region)); // a hard-to-reach lead can fall under the threshold
  const rankOpts = { reserveNonHiring: pack.delivery.digest.reserved_non_hiring, freshDays: pack.signals.eligibility.fresh_days };
  const groups = pack.delivery.digest.region_groups;
  // with region groups, each group keeps its own top N after re-ranking (so one region never takes another's slots)
  const ranking = groups.length ? rankByRegionGroups(rows, groups, (a) => a.region, 1, 5, rankOpts) : rankAccounts(rows, max, 5, rankOpts);
  const noContact = [...pool.leads, ...pool.watchlist].filter((r) => !contacts.get(r.account.id)).length;
  return { ranking: { ...ranking, held: pool.held }, factors, noContact, enterprise };
}
