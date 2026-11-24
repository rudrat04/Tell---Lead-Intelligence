/**
 * Opportunity matching (pack opportunities.yaml), pure: no I/O.
 *
 * An event (a federal contract ending) is an opportunity for OTHER companies. A roster lists companies proven able to
 * take it by their own record (contracts they won in the same NAICS codes, for the same agencies, under the same
 * set-aside). Code decides every match; nothing here is guessed:
 *   - the company behind the event (the incumbent) never matches its own event (name key, UEI or same name)
 *   - NAICS: the same code, or the same 4-digit industry (weaker)
 *   - set-aside: an event set aside for a family (8(a), SDVOSB, ...) only matches members that won that family before
 *   - agency and size only change how good the fit is
 * The score is a sum of readable parts: opportunity 45 + fit 25 + timing 15 + buyer 15 = 100.
 */

/** Same key the niche resolvers seed names under (watchers companyKey): lowercase letters and digits only. */
export const entityKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "");

const SUFFIX = /\b(inc|incorporated|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|lp|llp|pllc|pc|the|dba)\b/g;
/** names equal once legal suffixes and punctuation go ("ACME TECHNOLOGIES, INC." = "Acme Technologies LLC") */
export const sameEntity = (a: string, b: string) => {
  const n = (s: string) => s.toLowerCase().replace(/[.,]/g, " ").replace(SUFFIX, " ").replace(/[^a-z0-9]+/g, "");
  const x = n(a), y = n(b);
  return x.length >= 3 && x === y;
};

const COMMON = new Set(["the", "and", "of", "for", "inc", "llc", "corp", "group", "global", "federal", "government", "national", "american", "united", "general",
  "systems", "system", "solutions", "services", "technologies", "technology", "tech", "consulting", "management", "data", "information", "digital", "enterprise",
  "integrated", "advanced", "applied", "strategic", "professional", "defense", "security", "international", "associates", "partners", "company", "first", "new"]);
/** first word that tells a name apart ("Wingtip" in "Wingtip IT Systems"); null when every word is common */
const firstDistinct = (name: string) => name.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).find((w) => w.length >= 4 && !COMMON.has(w)) ?? null;
/** sister companies under one parent (Alaska Native and tribal 8(a) families: "Wingtip IT Systems" and "Wingtip Operations
 *  Services") share their first distinctive word: an affiliate of the incumbent is not a new bidder */
export const affiliates = (a: string, b: string) => { const x = firstDistinct(a); return !!x && x === firstDistinct(b); };

export const SET_ASIDE_LABEL: Record<string, string> = { "8a": "8(a)", sdvosb: "SDVOSB", wosb: "WOSB", hubzone: "HUBZone", small_business: "small business" };
export const fmtUsd = (n: number) => (n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n / 1e3)}K`);
const day = (d: Date) => d.toISOString().slice(0, 10);
const titleCase = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\b(Llc|Inc|Lp|Llp|Pllc|Usa|It|Ii|Iii)\b/g, (m) => m.toUpperCase());
const shortDesc = (d: string) => { const t = d.toLowerCase().replace(/^igf::\w+::igf\s*/i, ""); return t.length <= 80 ? t : `${t.slice(0, 80).replace(/[\s,;:(]+\S*$/, "")}...`; };
const bump = (m: Record<string, number>, k: string) => { if (k) m[k] = (m[k] ?? 0) + 1; };

/** "Litware JV, LLP", "Acme-Beta Joint Venture", "Acme Mentor-Protege JV II" (pure) */
export const isJointVenture = (name: string) => /\b(jv|j\.v\.|joint venture|mentor[- ]prot[eé]g[eé])\b/i.test(name);

/** The award fields a roster or an event needs (watchers FedAward has these). */
export interface AwardLike {
  awardId: string; recipient: string; uei: string | null; amount: number; startDate: Date | null; endDate: Date | null;
  agency: string; subAgency: string; naics: string; naicsName?: string; psc?: string; description: string; state: string | null; setAside: string | null; url: string;
  /** the vehicle an order sits under (null = standalone contract) */
  parent?: string | null;
}

export interface MemberFacts {
  /** contracts won per NAICS code / agency / sub-agency */
  naics: Record<string, number>; agencies: Record<string, number>; subAgencies: Record<string, number>;
  /** set-aside families it has won under (proof of eligibility) */
  setAsides: string[];
  awards: number; total: number; largest: number; lastAwardAt: string | null;
  ueis: string[]; states: string[];
  /** its largest wins, as quotes with links: the proof shown on the lead */
  evidence: { quote: string; url: string }[];
  /** search and import rosters: what the company says it does, where it is, how it was found */
  description?: string | null; region?: string | null; found?: string;
  /** the company's own website (company search result, import, or its SAM.gov registration by UEI) */
  website?: string | null; samChecked?: boolean;
}

/** An empty fact sheet for a member found by search or import (pure). */
export const generalFacts = (o: { description?: string | null; region?: string | null; found: string; website: string; url?: string }): MemberFacts => ({
  naics: {}, agencies: {}, subAgencies: {}, setAsides: [], awards: 0, total: 0, largest: 0, lastAwardAt: null, ueis: [], states: [],
  evidence: o.description ? [{ quote: o.description, url: o.url ?? o.website }] : [], description: o.description ?? null, region: o.region ?? null, found: o.found, website: o.website,
});
export interface RosterMember { key: string; name: string; facts: MemberFacts; priority: number }

/** Awards -> roster members, one per company (pure). An award found under a set-aside query and without one is one
 *  award that carries the family. Companies under `minAwards` distinct awards are left out. */
export function rosterFromAwards(awards: AwardLike[], minAwards: number, opts: { smallBusinessOnly?: boolean } = {}): RosterMember[] {
  const byAward = new Map<string, AwardLike & { families: Set<string> }>();
  for (const a of awards) {
    const prev = byAward.get(a.awardId);
    if (prev) { if (a.setAside) prev.families.add(a.setAside); continue; }
    byAward.set(a.awardId, { ...a, families: new Set(a.setAside ? [a.setAside] : []) });
  }
  const byCo = new Map<string, (AwardLike & { families: Set<string> })[]>();
  for (const a of byAward.values()) { const k = entityKey(a.recipient); if (k.length >= 3) byCo.set(k, [...(byCo.get(k) ?? []), a]); }
  const out: RosterMember[] = [];
  for (const [key, list] of byCo) {
    if (list.length < minAwards) continue;
    // a joint venture has no website or staff of its own (name searches land on an unrelated brand): its partners are
    // the companies to reach, and they win under their own names too
    if (isJointVenture(list[0]!.recipient)) continue;
    const facts: MemberFacts = { naics: {}, agencies: {}, subAgencies: {}, setAsides: [], awards: list.length, total: 0, largest: 0, lastAwardAt: null, ueis: [], states: [], evidence: [] };
    const fam = new Set<string>(), ueis = new Set<string>(), states = new Set<string>();
    let last: Date | null = null;
    for (const a of list) {
      bump(facts.naics, a.naics); bump(facts.agencies, a.agency); bump(facts.subAgencies, a.subAgency);
      for (const f of a.families) fam.add(f);
      if (a.uei) ueis.add(a.uei);
      if (a.state) states.add(a.state);
      facts.total += a.amount; facts.largest = Math.max(facts.largest, a.amount);
      if (a.startDate && (!last || a.startDate > last)) last = a.startDate;
    }
    if (opts.smallBusinessOnly && !fam.size) continue;
    facts.setAsides = [...fam].sort(); facts.ueis = [...ueis]; facts.states = [...states].sort();
    facts.lastAwardAt = last ? day(last) : null;
    facts.evidence = [...list].sort((a, b) => b.amount - a.amount).slice(0, 3).map((a) => ({
      quote: `Won ${fmtUsd(a.amount)} from ${a.agency}${a.subAgency && a.subAgency !== a.agency ? ` (${a.subAgency})` : ""}${a.startDate ? ` in ${a.startDate.getUTCFullYear()}` : ""}: "${shortDesc(a.description)}" (NAICS ${a.naics}${[...a.families].length ? `, ${[...a.families].map((f) => SET_ASIDE_LABEL[f] ?? f).join(" / ")} set-aside` : ""})`,
      url: a.url,
    }));
    out.push({ key, name: titleCase(list[0]!.recipient), facts, priority: list.length * Math.log10(Math.max(10, facts.total)) });
  }
  return out.sort((a, b) => b.priority - a.priority);
}

/** An opportunity event: who it's about, who controls it, and the facts to match on. */
export interface OppEvent {
  key: string; entityName: string; entityKey: string; uei: string | null; amount: number; endDate: Date;
  naics: string; agency: string; subAgency: string; setAside: string | null; description: string; state: string | null; url: string;
}

/** Expiring awards -> events (pure). Ends outside [now + minDays, now + maxDays], under minAmount, or orders under a
 *  vehicle (unless includeOrders) are dropped; an award seen under a set-aside query keeps that family. */
export function expiringEvents(awards: AwardLike[], o: { minDays: number; maxDays: number; minAmount: number; includeOrders?: boolean }, now: Date): OppEvent[] {
  const from = now.getTime() + o.minDays * 86_400_000, to = now.getTime() + o.maxDays * 86_400_000;
  const by = new Map<string, OppEvent>();
  for (const a of awards) {
    if (!a.endDate || a.endDate.getTime() < from || a.endDate.getTime() > to || a.amount < o.minAmount) continue;
    // an order under someone's vehicle (IDIQ, GSA schedule) is recompeted among that vehicle's holders only: not an
    // opening for a company off it, so orders are left out unless the pack asks for them
    if (a.parent && !o.includeOrders) continue;
    const prev = by.get(a.awardId);
    if (prev) { prev.setAside ??= a.setAside; continue; }
    by.set(a.awardId, { key: a.awardId, entityName: titleCase(a.recipient), entityKey: entityKey(a.recipient), uei: a.uei, amount: a.amount, endDate: a.endDate,
      naics: a.naics, agency: a.agency, subAgency: a.subAgency, setAside: a.setAside, description: a.description, state: a.state, url: a.url });
  }
  return [...by.values()];
}

/** The event as one factual sentence (stored as the quote; drafts may only repeat its numbers). */
export function eventQuote(e: OppEvent): string {
  const who = e.subAgency && e.subAgency !== e.agency ? `${e.agency} (${e.subAgency})` : e.agency;
  return `${e.entityName}'s ${fmtUsd(e.amount)} ${who} contract for "${shortDesc(e.description)}" (NAICS ${e.naics}${e.setAside ? `, ${SET_ASIDE_LABEL[e.setAside] ?? e.setAside} set-aside` : ""}) ends ${day(e.endDate)}`;
}

export interface Match { fit: number; reasons: string[] }

/** Can this member take this event? null = no (pure). requireAgency: it must have won with the event's agency. */
export function matchEvent(e: OppEvent, m: Pick<RosterMember, "key" | "name" | "facts">, opts: { requireAgency?: boolean } = {}): Match | null {
  const f = m.facts;
  // the incumbent (and its sister companies) is the signal, never the prospect
  if (m.key === e.entityKey || (e.uei && f.ueis.includes(e.uei)) || sameEntity(m.name, e.entityName) || affiliates(m.name, e.entityName)) return null;
  const exact = f.naics[e.naics] ?? 0;
  const prefix = Object.entries(f.naics).filter(([c]) => c !== e.naics && c.slice(0, 4) === e.naics.slice(0, 4)).reduce((s, [, n]) => s + n, 0);
  if (!exact && !prefix) return null;
  if (e.setAside && !f.setAsides.includes(e.setAside)) return null;
  const reasons: string[] = [];
  const naicsFit = exact ? 1 : 0.6;
  reasons.push(exact ? `won ${exact} contract${exact === 1 ? "" : "s"} in NAICS ${e.naics}` : `won ${prefix} contract${prefix === 1 ? "" : "s"} in the same industry (NAICS ${e.naics.slice(0, 4)})`);
  const sub = e.subAgency ? f.subAgencies[e.subAgency] ?? 0 : 0, ag = f.agencies[e.agency] ?? 0;
  if (opts.requireAgency && !ag) return null;
  const agencyFit = sub ? 1 : ag ? 0.7 : 0.3;
  if (sub) reasons.push(`${sub} with ${e.subAgency}`); else if (ag) reasons.push(`${ag} with ${e.agency}`);
  if (e.setAside) reasons.push(`has won ${SET_ASIDE_LABEL[e.setAside] ?? e.setAside} set-asides`);
  const capacity = f.largest >= e.amount * 0.25 ? 1 : f.largest >= e.amount * 0.05 ? 0.6 : 0.3;
  if (capacity === 1) reasons.push(`largest win ${fmtUsd(f.largest)}`);
  return { fit: Math.round((0.45 * naicsFit + 0.35 * agencyFit + 0.2 * capacity) * 100) / 100, reasons };
}

/** largest: the beneficiary's largest win; an event far bigger than anything it has won counts as if it were
 *  4x that size (a $1.5B contract is not a $1.5B opportunity for a firm whose best win is $5M) */
export interface ScoredMatch {
  fit: number; amount: number; endDate: Date; largest?: number;
  /** the event is set aside for a family this beneficiary won before: fewer bidders */ setAside?: boolean;
  /** news / signal events: no amount; their weight is the event's strength (1-5) and timing is how fresh it is */
  strength?: number; observedAt?: Date;
}
/** a set-aside recompete only eligible firms can bid on weighs this much more */
export const SET_ASIDE_BONUS = 1.3;
/** one event's weight for one beneficiary (pure) */
export const matchValue = (m: ScoredMatch) => m.strength != null ? m.fit * (m.strength / 3) : m.fit * (m.setAside ? SET_ASIDE_BONUS : 1) * Math.min(1.5, Math.max(0.2, Math.log10(Math.max(1, m.largest ? Math.min(m.amount, 4 * m.largest) : m.amount) / 1e5) / 2));
export interface BeneficiaryScore { score: number; parts: { opportunity: number; fit: number; timing: number; buyer: number }; line: string }

/** Timing of one event: full inside the capture sweet spot, less when it is too close (late) or far (early). */
export function timingFor(endDate: Date, sweet: [number, number], now: Date): number {
  const d = (endDate.getTime() - now.getTime()) / 86_400_000;
  const [a, b] = sweet;
  if (d < 0) return 0;
  if (d >= a && d <= b) return 1;
  if (d < a) return 0.4 + 0.6 * (d / a);
  return Math.max(0.3, 1 - (d - b) / 365);
}

/** A beneficiary's score from all its matched events (pure). buyer: 0-1 decision power of the contact, null = unknown
 *  (half credit until contacts are found, as in lead scoring). */
/** events counted toward one beneficiary's opportunity part: its strongest few (a broad code matches hundreds) */
export const TOP_EVENTS = 5;
/** news / signal events: weight of the strongest one by its fact-checked stage (strength 2 early, 3.5 committed, 5
 *  buying), and freshness half-life by stage (a tender closes, a land deal's purchases are months away) */
export const stageWeight = (strength: number) => Math.max(0, Math.min(1, strength / 5));
export const halfLifeDays = (strength: number) => (strength >= 5 ? 14 : strength >= 3.5 ? 21 : 45);

export function scoreBeneficiary(ms: ScoredMatch[], sweet: [number, number], buyer: number | null, now: Date): BeneficiaryScore {
  const top = [...ms].sort((a, b) => matchValue(b) - matchValue(a)).slice(0, TOP_EVENTS);
  const b = 15 * (buyer == null ? 0.5 : Math.max(0, Math.min(1, buyer)));
  if (top.length && top.every((m) => m.strength != null)) {
    // a signal, not a contract: the strongest signal's stage, +10% for each more verified signal like it (up to 3);
    // fit = the best match (a proven fit is 1); timing = freshness at the stage's own half-life
    const best = Math.max(...top.map((m) => m.fit * stageWeight(m.strength!)));
    const opportunity = 45 * Math.min(1, best + 0.1 * Math.min(3, top.length - 1));
    const fit = 25 * Math.max(...top.map((m) => m.fit));
    const timing = 15 * Math.max(0, ...ms.map((m) => Math.pow(0.5, Math.max(0, now.getTime() - (m.observedAt ?? m.endDate).getTime()) / (halfLifeDays(m.strength ?? 3) * 86_400_000))));
    const parts = { opportunity: Math.round(opportunity), fit: Math.round(fit), timing: Math.round(timing), buyer: Math.round(b) };
    const score = parts.opportunity + parts.fit + parts.timing + parts.buyer;
    return { score, parts, line: `Score ${score} = opportunity ${parts.opportunity} · fit ${parts.fit} · timing ${parts.timing} · buyer ${parts.buyer}` };
  }
  const value = top.reduce((s, m) => s + matchValue(m), 0);
  const opportunity = 45 * (1 - Math.exp(-value / 6));
  // how well its strongest events fit, not its single best one (one lucky match shouldn't max the part)
  const fit = top.length ? 25 * (top.reduce((s, m) => s + m.fit, 0) / top.length) : 0;
  // contracts: how close the end date is to the capture sweet spot; news and signals: how fresh (half-life 14 days)
  const timing = 15 * Math.max(0, ...ms.map((m) => m.observedAt ? Math.pow(0.5, Math.max(0, now.getTime() - m.observedAt.getTime()) / (14 * 86_400_000)) : timingFor(m.endDate, sweet, now)));
  const parts = { opportunity: Math.round(opportunity), fit: Math.round(fit), timing: Math.round(timing), buyer: Math.round(b) };
  const score = parts.opportunity + parts.fit + parts.timing + parts.buyer;
  return { score, parts, line: `Score ${score} = opportunity ${parts.opportunity} · fit ${parts.fit} · timing ${parts.timing} · buyer ${parts.buyer}` };
}

/** events shown on an opportunity lead (Telegram, brief, draft: deliveries.context.events) */
export const SHOWN_EVENTS = 3;

/** What a past opportunity delivery covered (pure): the urls of its top events (`context.topEvents`, recorded since
 *  Nov 22 2026), else, for older rows, only the SHOWN_EVENTS it showed (`legacy`). */
export function deliveredEvents(ctx: unknown): { urls: Set<string>; legacy: boolean } {
  const c = (ctx ?? {}) as { topEvents?: unknown; events?: { url?: unknown }[] };
  if (Array.isArray(c.topEvents)) return { urls: new Set(c.topEvents.filter((u): u is string => typeof u === "string")), legacy: false };
  return { urls: new Set((c.events ?? []).map((e) => e?.url).filter((u): u is string => typeof u === "string")), legacy: true };
}

/** Is one of today's top events (urls, strongest first) new since that delivery? (pure) A legacy row is compared on
 *  the events it showed only: comparing TOP_EVENTS against 3 stored urls made events 4-5 look new every day, so a lead
 *  with 4+ events was sent again daily instead of being held back. */
export function hasNewTopEvent(todayUrls: string[], last: { urls: Set<string>; legacy: boolean }): boolean {
  return todayUrls.slice(0, last.legacy ? SHOWN_EVENTS : TOP_EVENTS).some((u) => !last.urls.has(u));
}

/** Held back from today's list? A delivered beneficiary returns after `holdDays`, or earlier when one of its top events
 *  was not on the lead it got (pure). */
export function heldBack(lastDelivered: Date | null, hasNewTopEvent: boolean, holdDays: number, now: Date): boolean {
  if (!lastDelivered) return false;
  if (hasNewTopEvent) return false;
  return now.getTime() - lastDelivered.getTime() < holdDays * 86_400_000;
}


// ------------------------------------------------------------------------------------------------ news and signal events

/** A news or signal event: who it is about (never the prospect), where, how strong, when. */
export interface GeneralEvent {
  key: string; entityName: string; entityKey: string;
  /** the signal's own account / domain (signal events): that company never benefits from its own event */
  entityAccountId?: string | null; entityDomain?: string | null;
  region: string | null; quote: string; url: string; strength: number; observedAt: Date;
}

const words = (s: string) => s.toLowerCase();
/** does the text name one of these words as a whole word (pure) */
export const mentionsAny = (text: string, ws: string[]) => { const t = words(text); return ws.find((w) => new RegExp(`(^|[^a-z0-9])${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`).test(t)) ?? null; };

/**
 * Can this search / import roster member benefit from this news or signal event? (pure). Never the company the event is
 * about (same account, domain, name or sister company); its HQ must be where beneficiaries may be (the event's own
 * region unless the opportunity names others); fit = 0.6, or 1 when its description names what the opportunity needs.
 */
export function matchGeneral(e: GeneralEvent, m: Pick<RosterMember, "key" | "name" | "facts"> & { accountId?: string | null; domain?: string | null }, opts: { regions?: string[]; keywords?: string[] } = {}): Match | null {
  if (m.key === e.entityKey || sameEntity(m.name, e.entityName) || affiliates(m.name, e.entityName)) return null;
  if ((e.entityAccountId && m.accountId === e.entityAccountId) || (e.entityDomain && m.domain === e.entityDomain)) return null;
  const allowed = opts.regions?.length ? opts.regions : e.region ? [e.region] : [];
  const region = m.facts.region ?? null;
  if (!region || !allowed.includes(region)) return null;
  const reasons = [`based in ${region}`];
  const kw = opts.keywords?.length ? mentionsAny(`${m.name} ${m.facts.description ?? ""}`, opts.keywords) : null;
  if (kw) reasons.push(`offers ${kw}`);
  return { fit: !opts.keywords?.length || kw ? 1 : 0.6, reasons };
}
