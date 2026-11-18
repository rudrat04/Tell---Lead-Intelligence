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
/** freeze_to_contract: a core role open at least this long before it was removed, then a contract ask within this many days */
export const FREEZE_MIN_OPEN_DAYS = 45;
export const FREEZE_CONTRACT_DAYS = 45;
export const FAST_LANE_MAX_AGE_DAYS = 14;
/**
 * Website/DNS findings the weekly watch re-checks are states, like open roles: "two CRMs" is still true while the watch
 * keeps seeing it (signals.last_seen_at). Seen within STATE_SEEN_DAYS (a weekly watch plus one missed run) = current, and
 * its age stops at STATE_MAX_AGE_DAYS. Once it stops being seen it ages from the last time it was.
 */
export const STATE_SIGNAL_TYPES = new Set(["tool_overlap", "stack_sprawl", "leaky_capture", "has_gtm_agency", "email_auth_gap", "attribution_gap", "site_health_poor", "role_gap"]);
export const STATE_SEEN_DAYS = 15;
export const STATE_MAX_AGE_DAYS = 30;

export interface JobRow {
  id: string;
  title: string;
  url: string;
  employmentType: string | null;
  family: string;
  postedAt: Date | null;
  firstSeenAt: Date;
  closedAt: Date | null;
  /** the board's source ("greenhouse", "jsearch"...): JSearch roles close when unseen, which proves nothing about removal */
  boardSource?: string | null;
}

export interface SignalRow {
  id: string;
  type: string;
  evidenceQuote: string;
  evidenceUrl: string;
  observedAt: Date;
  /** states (STATE_SIGNAL_TYPES): the last watch that still saw it */
  lastSeenAt?: Date | null;
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
export const HIRING_TYPES = new Set([...JOB_STATE_TYPES, "core_role_filled", "freeze_to_contract"]);

/** Does this account carry hiring evidence / a fresh non-hiring positive signal? */
export const hasHiring = (s: { evidence: Evidence[] }) => s.evidence.some((e) => HIRING_TYPES.has(e.type));
export const hasFreshNonHiring = (s: { drivers: Evidence[] }, freshDays: number) =>
  s.drivers.some((e) => !HIRING_TYPES.has(e.type) && e.class !== "negative" && (e.current || e.ageDays <= freshDays));

const normTitle = (t: string) => t.toLowerCase().replace(/\(.*?\)|\[.*?\]/g, " ").replace(/[^a-z0-9]+/g, " ").trim();

/** Turn an account's jobs + signals into deduplicated evidence (one per real-world role or post). */
export interface PersonRow { id: string; role: string | null; url: string | null; fetchedAt: Date }

/**
 * Evidence: open/closed roles (state), stored signals, and known people. A known person in a core (ops) role means the
 * system has an owner: `ops_owner_known`, and two or more `ops_team_2plus` (both only if the pack defines them).
 * Coverage is partial (founders from YC, people search for the leads that go out), so absence proves nothing.
 */
export function buildEvidence(jobs: JobRow[], signals: SignalRow[], pack: Pack, roles: RoleRules, now: Date, people: PersonRow[] = []): Evidence[] {
  const specs = pack.signals.signals;
  const out = new Map<string, Evidence>();
  const keep = (key: string, e: Evidence) => {
    const prev = out.get(key);
    // same role on two boards (YC + Ashby) or a re-post: keep the most current copy
    if (!prev || (e.current && !prev.current) || (e.current === prev.current && e.ageDays < prev.ageDays)) out.set(key, e);
  };

  // for freeze_to_contract: core roles removed after a long time open, and contract asks that came after
  const longClosed: { title: string; closedAt: Date; openDays: number }[] = [];
  const contractAsks: { title: string; at: Date; e: Evidence }[] = [];

  for (const j of jobs) {
    const cls = classifyJob(j.title, j.employmentType ?? undefined, roles);
    if (!cls) continue;
    const open = !j.closedAt;
    // a stored placeholder date (year 1, or after we first saw it) is no date: fall back to when we first saw the role
    const posted = j.postedAt && j.postedAt.getUTCFullYear() >= 2000 && j.postedAt <= j.firstSeenAt ? j.postedAt : null;
    const since = posted ?? j.firstSeenAt;
    const daysOpen = Math.max(0, (now.getTime() - since.getTime()) / DAY);
    let type: string;
    // a contract *core* role means they want outside help for exactly what you do; a contract sales hire does not
    if (cls.contract && cls.family === "core") type = "contract_role";
    else if (cls.founding) type = "first_role";
    else if (cls.family === "core") type = open && daysOpen >= 45 ? "core_role_open_45d" : "core_role_open";
    else type = "adjacent_role_open";
    if (!specs[type]) continue;

    // age while open: an unmet core need is current (0); other roles age from posting, never past the cap.
    // A closed role keeps that age and adds the days since it closed: closing never makes a role look fresher.
    const openAge = (days: number) => (cls.family === "core" && type !== "contract_role" && type !== "first_role" ? 0 : Math.min(days, OPEN_ROLE_MAX_AGE_DAYS));
    let ageDays: number;
    if (!open) {
      const sinceClosed = Math.max(0, (now.getTime() - j.closedAt!.getTime()) / DAY);
      ageDays = openAge(Math.max(0, daysOpen - sinceClosed)) + sinceClosed;
    } else ageDays = openAge(daysOpen);

    const ev: Evidence = {
      type, class: specs[type]!.class, ageDays, current: open, openDays: Math.round(daysOpen), quote: j.title.replace(/\s+/g, " ").trim(), url: j.url, ref: { kind: "job", id: j.id },
    };
    keep(`role:${cls.family}:${normTitle(j.title)}`, ev);
    if (type === "contract_role") contractAsks.push({ title: ev.quote, at: since, e: ev });
    if (!open && cls.family === "core" && !cls.contract && !cls.founding && j.boardSource !== "jsearch") {
      const openDays = (j.closedAt!.getTime() - since.getTime()) / DAY;
      if (openDays >= FREEZE_MIN_OPEN_DAYS) longClosed.push({ title: ev.quote, closedAt: j.closedAt!, openDays });
    }
  }

  for (const s of signals) {
    if (JOB_STATE_TYPES.has(s.type) || !specs[s.type]) continue;
    const since = (d: Date) => Math.max(0, (now.getTime() - d.getTime()) / DAY);
    let ageDays = since(s.observedAt);
    let current = false;
    if (STATE_SIGNAL_TYPES.has(s.type)) {
      const seen = since(s.lastSeenAt ?? s.observedAt);
      if (seen <= STATE_SEEN_DAYS) { current = true; ageDays = Math.min(ageDays, STATE_MAX_AGE_DAYS); }
      else ageDays = seen; // no longer seen: it was last true then
    }
    keep(`signal:${s.type}:${s.evidenceUrl}`, {
      type: s.type, class: specs[s.type]!.class, ageDays, current, quote: s.evidenceQuote, url: s.evidenceUrl, ref: { kind: "signal", id: s.id },
    });
  }
  // Hiring freeze turned contract: a core role removed after a long time open (not filled: a fill is removed fast), then
  // within FREEZE_CONTRACT_DAYS a contract version of the role or a public ask for outside help. They tried to hire,
  // couldn't, and are now open to an outside expert. One event per account, dated by the contract ask.
  if (specs.freeze_to_contract && longClosed.length) {
    for (const s of signals) if (s.type === "explicit_hire_request") contractAsks.push({ title: s.evidenceQuote.slice(0, 80), at: s.observedAt, e: {
      type: s.type, class: "explicit", ageDays: Math.max(0, (now.getTime() - s.observedAt.getTime()) / DAY), current: false, quote: s.evidenceQuote, url: s.evidenceUrl, ref: { kind: "signal", id: s.id },
    } });
    let best: { c: (typeof longClosed)[number]; a: (typeof contractAsks)[number] } | null = null;
    for (const c of longClosed) for (const a of contractAsks) {
      const gap = (a.at.getTime() - c.closedAt.getTime()) / DAY;
      // the ask comes after the close (a week's slack: boards publish and remove on different days)
      if (gap >= -7 && gap <= FREEZE_CONTRACT_DAYS && (!best || a.e.ageDays < best.a.e.ageDays)) best = { c, a };
    }
    if (best) {
      const gap = Math.max(0, Math.round((best.a.at.getTime() - best.c.closedAt.getTime()) / DAY));
      out.set("freeze:contract", {
        type: "freeze_to_contract", class: specs.freeze_to_contract.class, ageDays: best.a.e.ageDays, current: best.a.e.current,
        quote: `Removed "${best.c.title}" after ${Math.round(best.c.openDays)} days unfilled; ${gap ? `${gap} days later` : "then"} posted "${best.a.title}"`,
        url: best.a.e.url, ref: best.a.e.ref,
      });
    }
  }
  const ops = people.filter((p) => p.role && roles.core.some((r) => r.test(p.role!)) && !roles.exclude.some((r) => r.test(p.role!)));
  const add = (type: string, p: PersonRow, quote: string) => {
    if (!specs[type]) return;
    out.set(`person:${type}`, { type, class: specs[type]!.class, ageDays: Math.max(0, (now.getTime() - p.fetchedAt.getTime()) / DAY), current: true, quote, url: p.url ?? "#", ref: { kind: "signal", id: p.id } });
  };
  if (ops.length >= 2) add("ops_team_2plus", ops[0]!, `${ops.length} people in ops roles: ${ops.slice(0, 3).map((p) => p.role).join("; ")}`);
  else if (ops.length === 1) add("ops_owner_known", ops[0]!, `Known ops owner: ${ops[0]!.role}`);
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

export interface PlayMatch { id: string; title: string; angle: string; evidence: Evidence[]; personas?: string[]; qualifies?: boolean }

/**
 * A play fires when every required signal type is present within its window (current evidence always is), at least
 * one of its `requires_any` types is (when it lists any), and none of its `absent` types is (e.g. "just raised" + no RevOps role open).
 */
export function matchPlays(ev: Evidence[], plays: Pack["plays"]["plays"]): PlayMatch[] {
  const out: PlayMatch[] = [];
  for (const [id, p] of Object.entries(plays)) {
    const inWindow = (e: Evidence) => e.current || e.ageDays <= p.window_days;
    if ((p.absent ?? []).some((t) => ev.some((e) => e.type === t && inWindow(e)))) continue;
    const used: Evidence[] = [];
    const ok = p.requires.every((t) => {
      const hits = ev.filter((e) => e.type === t && (e.current || e.ageDays <= p.window_days)).sort((a, b) => a.ageDays - b.ageDays);
      const need = p.min_count?.[t] ?? 1;
      if (hits.length >= need) used.push(...hits.slice(0, need));
      return hits.length >= need;
    });
    if (!ok) continue;
    // requires_any: at least one of these types too (the freshest one is cited)
    if ((p.requires_any ?? []).length) {
      const any = ev.filter((e) => p.requires_any!.includes(e.type) && inWindow(e)).sort((a, b) => a.ageDays - b.ageDays)[0];
      if (!any) continue;
      used.push(any);
    }
    out.push({ id, title: p.title, angle: p.angle, evidence: used, personas: p.personas ?? [], qualifies: p.qualifies ?? false });
  }
  return out;
}

export interface ScoreParts { need: number; fit: number; timing: number; buyer: number }

/** Need as 0..1: log lift of intent over the base rate, full at `fullLift` x (negative signals can take it to 0). */
export function needLevel(intent: number, baseRate: number, fullLift: number): number {
  const odds = (p: number) => p / (1 - p);
  const lift = Math.log(odds(intent) / odds(baseRate));
  return Math.max(0, Math.min(1, lift / Math.log(fullLift)));
}

/** Points for each part (rounded to 0.1) from 0..1 levels and the pack's weights. */
export function scoreParts(levels: { need: number; fit: number; timing: number; buyer: number }, w: Pack["signals"]["score"]): ScoreParts {
  const r = (x: number) => Math.round(x * 10) / 10;
  return { need: r(levels.need * w.need), fit: r(levels.fit * w.fit), timing: r(levels.timing * w.timing), buyer: r(levels.buyer * w.buyer) };
}
export const partsTotal = (p: ScoreParts) => p.need + p.fit + p.timing + p.buyer;

/** Buyer level before contacts are looked up: half (unknown). */
export const UNKNOWN_BUYER = 0.5;

/** The same score with a new buyer level (0..1), after the contact and email are known. */
export function withBuyer<S extends Pick<AccountScore, "parts" | "priority">>(s: S, buyer: number, w: Pack["signals"]["score"]): S {
  const parts = { ...s.parts, buyer: Math.round(Math.max(0, Math.min(1, buyer)) * w.buyer * 10) / 10 };
  return { ...s, parts, priority: partsTotal(parts) / 100 };
}

export interface AccountScore {
  intent: number;
  fit: number;
  /** freshness of the newest positive signal (0.5^(days/14)): for display and the fast lane, not multiplied into priority */
  timing: number;
  /** ranking value: the 0-100 score / 100 (need + fit + timing + buyer points); the reach step fills in the buyer part */
  priority: number;
  /** the score's parts in points (signals.score weights): what the 0-100 is made of, shown on every lead */
  parts: ScoreParts;
  /** the pack's base rate, to show priority as a 0-100 score (displayScore) */
  baseRate: number;
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
    // Gate 5 only compares signals' dates with each other: a fixed origin keeps this pure (no clock)
    class: e.class as ConfirmedSignal["class"], type: e.type, observedAt: new Date(-e.ageDays * DAY), fastLane: specs[e.type]?.fast_lane, clusterId: `${i}`,
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
  // timing = how fresh the newest *event* is: a state that is still true (two CRMs, an empty seat) is not news, so it
  // only sets timing when there is nothing else (otherwise every account with a state looked brand new)
  const events = positives.filter((e) => !STATE_SIGNAL_TYPES.has(e.type));
  const newestAge = (events.length ? events : positives).length ? Math.min(...(events.length ? events : positives).map((e) => e.ageDays)) : Infinity;
  const timing = Number.isFinite(newestAge) ? timingScore(newestAge) : 0;
  const fit = softFit(facts, pack.icp);

  const plays = matchPlays(counted, pack.plays.plays).sort((a, b) => playStrength(b) - playStrength(a));
  function playStrength(p: PlayMatch) { return p.evidence.reduce((n, e) => n + Math.log(specs[e.type]?.lr ?? 1) * 0.5 ** (e.ageDays / (specs[e.type]?.half_life_days ?? 30)), 0); }
  // fast lane = one strong, fresh signal is enough to deliver (plan 8d-2); stale "strong" signals aren't urgent
  const fast = counted.some((e) => (specs[e.type]?.fast_lane || specs[e.type]?.strength === 5) && e.ageDays <= FAST_LANE_MAX_AGE_DAYS);
  // eligible: one fresh signal of a class the pack trusts alone, or enough independent fresh triggers
  const fresh = counted.filter((e) => e.class !== "negative" && (e.current || e.ageDays <= elig.fresh_days));
  // strong enough to stand alone, or enough independent weaker ones (triggers + below-strength "alone" classes)
  const strong = (e: Evidence) => (elig.alone as string[]).includes(e.class) && (specs[e.type]?.strength ?? 3) >= (elig.alone_min_strength ?? 1);
  const weakTypes = new Set(fresh.filter((e) => !strong(e) && (e.class === "trigger" || (elig.alone as string[]).includes(e.class))).map((e) => e.type));
  // a play marked `qualifies` is a need on its own (e.g. 3+ sales roles open and no ops role or owner)
  const eligibleBySignals = fresh.some(strong) || weakTypes.size >= elig.triggers_needed || plays.some((p) => p.qualifies && p.evidence.some((e) => e.current || e.ageDays <= elig.fresh_days));
  // no play = no angle: with plays.require_play, signals alone never make a lead
  const eligible = eligibleBySignals && (!pack.plays.require_play || plays.length > 0);
  const drivers = [...positives].sort((a, b) => Math.log(specs[b.type]!.lr) * 0.5 ** (b.ageDays / specs[b.type]!.half_life_days) - Math.log(specs[a.type]!.lr) * 0.5 ** (a.ageDays / specs[a.type]!.half_life_days));

  // The score is a sum of readable parts, not a product: a strong need at an unknown-size company still ranks, and a
  // perfect-fit company with one weak signal doesn't. Each signal already decays by its own half-life inside need;
  // timing adds a small bonus for the freshest one (a still-true state is fresh).
  const w = pack.signals.score;
  const parts = scoreParts({ need: needLevel(intent, pack.signals.base_rate, w.full_need_lift), fit, timing, buyer: UNKNOWN_BUYER }, w);
  return {
    intent, fit, timing, priority: partsTotal(parts) / 100, parts, baseRate: pack.signals.base_rate,
    lane: fast ? "fast" : "combined", eligible, evidence: ev, plays, drivers,
  };
}

/** The 0-100 score people see: need + fit + timing + buyer points (same order as priority). */
export function displayScore(s: { priority: number }): number {
  return Math.round(Math.max(0, Math.min(1, s.priority)) * 100);
}

/**
 * Best score this account could reach once its unknown company facts are filled in: fit at full points.
 * Used to pick which below-floor accounts are worth a company-facts lookup.
 */
export function bestCaseDisplayScore(s: { priority: number; parts: ScoreParts }, w: { fit: number }): number {
  return displayScore({ priority: s.priority + (w.fit - s.parts.fit) / 100 });
}

export interface RankInput<A> {
  account: A; score: AccountScore; incomplete: boolean;
  /** held by a past delivery: inside the re-delivery window, or labelled 👎, or in a meeting / won (redelivery()) */
  recentlyDelivered: boolean;
  /** something worth a second look since that delivery (a new play, or new strong evidence): delivered again */
  newSinceDelivery: boolean;
  /** shown on a lead that is back: why */
  backReason?: string;
  /** the region group this lead was ranked in (delivery.digest.region_groups), for the digest heading */
  group?: string;
}

/** The account's last delivery and what you said about it in the Sheet. */
export interface DeliveryHistory { at: Date; label: string | null; outcome: string | null }

/** outcomes that mean you're already talking to them: the digest never brings them back */
export const ENGAGED_OUTCOMES = new Set(["meeting", "won"]);

/**
 * Should a lead you've seen before come back? Rules:
 *  - never delivered: nothing held;
 *  - in a meeting / won: held for good (you don't need the digest for them);
 *  - 👎 (label "bad"): held past the re-delivery window too; only a play that wasn't there before brings it back
 *    (more of what you already turned down isn't news);
 *  - otherwise held for `windowDays`, and back early when a new play fires or new strong evidence appears: positive,
 *    first seen after the delivery, and either strong enough to stand alone or of a type the account didn't have.
 * `firstSeen` maps evidence ref ids to when that evidence first existed (job posted / first seen, signal observed).
 */
export function redelivery(
  s: AccountScore, h: DeliveryHistory | undefined, firstSeen: Map<string, Date>, playFirstMatched: (playId: string) => Date | undefined,
  now: Date, windowDays: number, pack: Pack,
): { recentlyDelivered: boolean; newSinceDelivery: boolean; backReason?: string } {
  if (!h) return { recentlyDelivered: false, newSinceDelivery: false };
  if (h.outcome && ENGAGED_OUTCOMES.has(h.outcome)) return { recentlyDelivered: true, newSinceDelivery: false };
  const bad = h.label === "bad";
  const inWindow = now.getTime() - h.at.getTime() < windowDays * DAY;
  if (!inWindow && !bad) return { recentlyDelivered: false, newSinceDelivery: false };

  const play = s.plays.find((p) => { const t = playFirstMatched(p.id); return !t || t > h.at; });
  if (play) return { recentlyDelivered: true, newSinceDelivery: true, backReason: `New play since you saw it: ${play.title}` };
  if (bad) return { recentlyDelivered: true, newSinceDelivery: false };

  const specs = pack.signals.signals;
  const minStrength = pack.signals.eligibility.alone_min_strength ?? 4;
  const isNew = (e: Evidence) => { const t = firstSeen.get(e.ref.id); return !!t && t > h.at; };
  const positives = s.evidence.filter((e) => e.class !== "negative");
  const oldTypes = new Set(positives.filter((e) => !isNew(e)).map((e) => e.type));
  const fresh = positives.filter(isNew).find((e) => (specs[e.type]?.strength ?? 3) >= minStrength || !oldTypes.has(e.type));
  return fresh
    ? { recentlyDelivered: true, newSinceDelivery: true, backReason: `New since you saw it: ${fresh.quote}` }
    : { recentlyDelivered: true, newSinceDelivery: false };
}

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
    if (r.recentlyDelivered && !r.newSinceDelivery) { held.recentlyDelivered++; return false; }
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

export interface RegionGroup { name: string; regions: string[]; max_leads: number }

/**
 * One ranking per region group, each the usual top-N by score (fast lane kept), concatenated in group order and tagged
 * with the group name. `regions: []` takes every region no other group names (unknown region included). `scale`
 * multiplies each group's size (the digest scores a pool of pool_multiplier x the leads). Watchlist: the best
 * not-chosen accounts across all groups.
 */
export function rankByRegionGroups<A>(rows: RankInput<A>[], groups: RegionGroup[], regionOf: (a: A) => string | null, scale = 1, watchlistSize = 5,
  opts: { reserveNonHiring?: number; freshDays?: number } = {}): Ranking<A> {
  const named = new Set(groups.flatMap((g) => g.regions));
  const held = { incomplete: 0, recentlyDelivered: 0 };
  const leads: RankInput<A>[] = [];
  const rest: RankInput<A>[] = [];
  for (const g of groups) {
    const inGroup = rows.filter((r) => { const reg = regionOf(r.account); return g.regions.length ? reg != null && g.regions.includes(reg) : reg == null || !named.has(reg); });
    const r = rankAccounts(inGroup, g.max_leads * scale, inGroup.length, opts);
    held.incomplete += r.held.incomplete;
    held.recentlyDelivered += r.held.recentlyDelivered;
    leads.push(...r.leads.map((l) => ({ ...l, group: g.name })));
    rest.push(...r.watchlist);
  }
  const watchlist = rest.sort((a, b) => b.score.priority - a.score.priority).slice(0, watchlistSize);
  return { leads, watchlist, held };
}
