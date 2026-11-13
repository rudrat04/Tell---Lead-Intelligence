import type { Pack } from "@tell/config";
import { intentProbability, timing as timingScore, type ScoredSignal } from "./scoring.js";
import { corroborated, type ConfirmedSignal } from "./gate5.js";
import { classifyJob, type RoleRules } from "./jobs.js";

/**
 * Account scoring (plan 8d), month-one version: rank, don't threshold.
 *
 * Evidence comes from two places:
 *  - job state (the `jobs` table): an open role is a *state*, not a one-off event. Core roles that are still open
 *    count as current (age 0); adjacent/founding/contract roles age from when they were posted, but while still open
 *    they never decay past OPEN_ROLE_MAX_AGE. Closed roles age from when they closed.
 *  - stored signals (posts, the negative "filled" signal). Job-derived signal rows are ignored here because job state
 *    already covers them (otherwise one role would count twice).
 */

const DAY = 86_400_000;
export const OPEN_ROLE_MAX_AGE_DAYS = 45;
export const FAST_LANE_MAX_AGE_DAYS = 14;

export interface JobRow {
  id: string;
  title: string;
  url: string;
  employmentType: string | null;
  family: string;
  postedAt: Date | null;
  firstSeenAt: Date;
  closedAt: Date | null;
}

export interface SignalRow {
  id: string;
  type: string;
  evidenceQuote: string;
  evidenceUrl: string;
  observedAt: Date;
}

export interface Evidence {
  type: string;
  class: string;
  ageDays: number;
  /** still true today (open role) */
  current: boolean;
  /** for roles: days since the board says it was posted (or we first saw it) */
  openDays?: number;
  quote: string;
  url: string;
  /** what this came from, for citations */
  ref: { kind: "job" | "signal"; id: string };
}

/** Signal types derived from job state; rows of these types in `signals` are not double-counted. */
export const JOB_STATE_TYPES = new Set(["contract_role", "first_role", "core_role_open", "core_role_open_45d", "adjacent_role_open"]);
/** Everything that comes from hiring (job state + the "filled" negative). */
export const HIRING_TYPES = new Set([...JOB_STATE_TYPES, "core_role_filled"]);

/** Does this account carry hiring evidence / a fresh non-hiring positive signal? */
export const hasHiring = (s: { evidence: Evidence[] }) => s.evidence.some((e) => HIRING_TYPES.has(e.type));
export const hasFreshNonHiring = (s: { drivers: Evidence[] }, freshDays: number) =>
  s.drivers.some((e) => !HIRING_TYPES.has(e.type) && e.class !== "negative" && (e.current || e.ageDays <= freshDays));

const normTitle = (t: string) => t.toLowerCase().replace(/\(.*?\)|\[.*?\]/g, " ").replace(/[^a-z0-9]+/g, " ").trim();

/** Turn an account's jobs + signals into deduplicated evidence (one per real-world role or post). */
export function buildEvidence(jobs: JobRow[], signals: SignalRow[], pack: Pack, roles: RoleRules, now: Date): Evidence[] {
  const specs = pack.signals.signals;
  const out = new Map<string, Evidence>();
  const keep = (key: string, e: Evidence) => {
    const prev = out.get(key);
    // same role on two boards (YC + Ashby) or a re-post: keep the most current copy
    if (!prev || (e.current && !prev.current) || (e.current === prev.current && e.ageDays < prev.ageDays)) out.set(key, e);
  };

  for (const j of jobs) {
    const cls = classifyJob(j.title, j.employmentType ?? undefined, roles);
    if (!cls) continue;
    const open = !j.closedAt;
    const since = j.postedAt ?? j.firstSeenAt;
    const daysOpen = Math.max(0, (now.getTime() - since.getTime()) / DAY);
    let type: string;
    // a contract *core* role means they want outside help for exactly what you do; a contract sales hire does not
    if (cls.contract && cls.family === "core") type = "contract_role";
    else if (cls.founding) type = "first_role";
    else if (cls.family === "core") type = open && daysOpen >= 45 ? "core_role_open_45d" : "core_role_open";
    else type = "adjacent_role_open";
    if (!specs[type]) continue;

    let ageDays: number;
    if (!open) ageDays = (now.getTime() - j.closedAt!.getTime()) / DAY;
    else if (cls.family === "core" && type !== "contract_role" && type !== "first_role") ageDays = 0; // unmet core need: current
    else ageDays = Math.min(daysOpen, OPEN_ROLE_MAX_AGE_DAYS);

    keep(`role:${cls.family}:${normTitle(j.title)}`, {
      type, class: specs[type]!.class, ageDays, current: open, openDays: Math.round(daysOpen), quote: j.title.replace(/\s+/g, " ").trim(), url: j.url, ref: { kind: "job", id: j.id },
    });
  }

  for (const s of signals) {
    if (JOB_STATE_TYPES.has(s.type) || !specs[s.type]) continue;
    keep(`signal:${s.type}:${s.evidenceUrl}`, {
      type: s.type, class: specs[s.type]!.class, ageDays: Math.max(0, (now.getTime() - s.observedAt.getTime()) / DAY),
      current: false, quote: s.evidenceQuote, url: s.evidenceUrl, ref: { kind: "signal", id: s.id },
    });
  }
  return [...out.values()];
}

export interface AccountFacts { sizeBand: string | null; region: string | null; segment: string | null }

/** Soft fit from the pack's weights (hard filters were applied at discovery). Missing facts get the defaults. */
export function softFit(a: AccountFacts, icp: Pack["icp"]): number {
  const f = icp.soft_fit;
  const parts: Record<string, number> = {
    size_band: a.sizeBand ? f.size_band[a.sizeBand] ?? 0.5 : 0.5,
    region: a.region ? f.region[a.region] ?? f.region_default : f.region_default,
    segment: a.segment ? f.segment[a.segment] ?? f.segment_default : f.segment_default,
  };
  return Object.entries(f.weights).reduce((sum, [k, w]) => sum + w * (parts[k] ?? 0.5), 0);
}

export interface PlayMatch { id: string; title: string; angle: string; evidence: Evidence[] }

/**
 * A play fires when every required signal type is present within its window (current evidence always is) and none
 * of its `absent` types is (e.g. "just raised" + no RevOps role open).
 */
export function matchPlays(ev: Evidence[], plays: Pack["plays"]["plays"]): PlayMatch[] {
  const out: PlayMatch[] = [];
  for (const [id, p] of Object.entries(plays)) {
    const inWindow = (e: Evidence) => e.current || e.ageDays <= p.window_days;
    if ((p.absent ?? []).some((t) => ev.some((e) => e.type === t && inWindow(e)))) continue;
    const used: Evidence[] = [];
    const ok = p.requires.every((t) => {
      const hit = ev.filter((e) => e.type === t && (e.current || e.ageDays <= p.window_days)).sort((a, b) => a.ageDays - b.ageDays)[0];
      if (hit) used.push(hit);
      return !!hit;
    });
    if (ok) out.push({ id, title: p.title, angle: p.angle, evidence: used });
  }
  return out;
}

export interface AccountScore {
  intent: number;
  fit: number;
  timing: number;
  priority: number;
  lane: "fast" | "combined";
  /** has at least one current (or recent) explicit/implicit signal: required to be delivered in month one */
  eligible: boolean;
  evidence: Evidence[];
  plays: PlayMatch[];
  /** evidence that counted, strongest first (for "why now" and citations) */
  drivers: Evidence[];
}

/** Score one account. Pure: same inputs, same output. */
export function scoreAccount(ev: Evidence[], facts: AccountFacts, pack: Pack): AccountScore {
  const specs = pack.signals.signals;
  const cap = pack.signals.max_events_per_type;

  // Gate 5: classes listed in eligibility.corroborate need another signal behind them
  const asConfirmed = (e: Evidence, i: number): ConfirmedSignal => ({
    class: e.class as ConfirmedSignal["class"], type: e.type, observedAt: new Date(Date.now() - e.ageDays * DAY), fastLane: specs[e.type]?.fast_lane, clusterId: `${i}`,
  });
  const confirmed = ev.map(asConfirmed);
  const elig = pack.signals.eligibility;
  const usable = ev.filter((e, i) => corroborated(confirmed[i]!, confirmed.filter((_, k) => k !== i), 30, elig.corroborate));

  // at most `cap` events per type (a hiring spree of 10 SDRs is one story, not ten)
  const perType = new Map<string, Evidence[]>();
  for (const e of [...usable].sort((a, b) => a.ageDays - b.ageDays)) {
    const list = perType.get(e.type) ?? [];
    if (list.length < (specs[e.type]?.max_events ?? cap)) list.push(e);
    perType.set(e.type, list);
  }
  const counted = [...perType.values()].flat();

  // within one type, the freshest event counts in full and each further one at repeat_dampening of the one before
  const rank = new Map<string, number>();
  const scored: ScoredSignal[] = [...counted].sort((a, b) => a.ageDays - b.ageDays).map((e) => {
    const k = rank.get(e.type) ?? 0;
    rank.set(e.type, k + 1);
    return { lr: specs[e.type]!.lr, ageDays: e.ageDays, halfLifeDays: specs[e.type]!.half_life_days, weight: pack.signals.repeat_dampening ** k };
  });
  const intent = intentProbability(pack.signals.base_rate, scored);
  const positives = counted.filter((e) => e.class !== "negative");
  const newestAge = positives.length ? Math.min(...positives.map((e) => e.ageDays)) : Infinity;
  const timing = Number.isFinite(newestAge) ? timingScore(newestAge) : 0;
  const fit = softFit(facts, pack.icp);

  const plays = matchPlays(counted, pack.plays.plays);
  // fast lane = one strong, fresh signal is enough to deliver (plan 8d-2); stale "strong" signals aren't urgent
  const fast = counted.some((e) => (specs[e.type]?.fast_lane || specs[e.type]?.strength === 5) && e.ageDays <= FAST_LANE_MAX_AGE_DAYS);
  // eligible: one fresh signal of a class the pack trusts alone, or enough independent fresh triggers
  const fresh = counted.filter((e) => e.class !== "negative" && (e.current || e.ageDays <= elig.fresh_days));
  // strong enough to stand alone, or enough independent weaker ones (triggers + below-strength "alone" classes)
  const strong = (e: Evidence) => (elig.alone as string[]).includes(e.class) && (specs[e.type]?.strength ?? 3) >= (elig.alone_min_strength ?? 1);
  const weakTypes = new Set(fresh.filter((e) => !strong(e) && (e.class === "trigger" || (elig.alone as string[]).includes(e.class))).map((e) => e.type));
  const eligible = fresh.some(strong) || weakTypes.size >= elig.triggers_needed;
  const drivers = [...positives].sort((a, b) => Math.log(specs[b.type]!.lr) * 0.5 ** (b.ageDays / specs[b.type]!.half_life_days) - Math.log(specs[a.type]!.lr) * 0.5 ** (a.ageDays / specs[a.type]!.half_life_days));

  return { intent, fit, timing, priority: intent * fit * timing, lane: fast ? "fast" : "combined", eligible, evidence: ev, plays, drivers };
}

export interface RankInput<A> { account: A; score: AccountScore; incomplete: boolean; recentlyDelivered: boolean; newPlaySinceDelivery: boolean }

export interface Ranking<A> { leads: RankInput<A>[]; watchlist: RankInput<A>[]; held: { incomplete: number; recentlyDelivered: number } }

/**
 * Month one: rank, don't threshold (probabilities aren't calibrated yet).
 * Up to `max` eligible accounts by priority. Fast-lane accounts are guaranteed a slot (up to half the list) even if
 * the combined score would bury them, but don't jump ahead of stronger leads. Never padded. Accounts with incomplete
 * evidence (a source outage) or delivered within the re-delivery window (unless a new play fired) are held back.
 */
export function rankAccounts<A>(rows: RankInput<A>[], max: number, watchlistSize = 5, opts: { reserveNonHiring?: number; freshDays?: number } = {}): Ranking<A> {
  const held = { incomplete: 0, recentlyDelivered: 0 };
  const pool = rows.filter((r) => {
    if (!r.score.eligible) return false;
    if (r.incomplete) { held.incomplete++; return false; }
    if (r.recentlyDelivered && !r.newPlaySinceDelivery) { held.recentlyDelivered++; return false; }
    return true;
  });
  const byPriority = (a: RankInput<A>, b: RankInput<A>) => b.score.priority - a.score.priority;
  const sorted = [...pool].sort(byPriority);
  const guaranteed = sorted.filter((r) => r.score.lane === "fast").slice(0, Math.ceil(max / 2));
  // reserved slots for non-hiring reasons: companies with no hiring evidence first, then mixed ones
  const reserve = Math.min(opts.reserveNonHiring ?? 0, Math.max(0, max - guaranteed.length));
  if (reserve > 0) {
    const fresh = opts.freshDays ?? 30;
    const candidates = sorted.filter((r) => !guaranteed.includes(r) && hasFreshNonHiring(r.score, fresh));
    const pick = [...candidates.filter((r) => !hasHiring(r.score)), ...candidates.filter((r) => hasHiring(r.score))].slice(0, reserve);
    guaranteed.push(...pick);
  }
  const rest = sorted.filter((r) => !guaranteed.includes(r));
  const leads = [...guaranteed, ...rest.slice(0, Math.max(0, max - guaranteed.length))].sort(byPriority);
  const watchlist = sorted.filter((r) => !leads.includes(r)).slice(0, watchlistSize);
  return { leads, watchlist, held };
}
