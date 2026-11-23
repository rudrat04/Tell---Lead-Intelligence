import { createHash } from "node:crypto";
import { SET_ASIDE_CODES, toRegex, inScope, type Pack, type Roster, type OpportunityDef, type SetAsideFamily } from "@tell/config";
import { searchFedAwards, companyKey, samWebsitesByUei, SAM_UEIS_PER_REQUEST, exaCompanySearch, serperNews, companyFromHeadline, type FedAward, type CompanyHit, type NewsItem } from "@tell/watchers";
import { registrableDomain, domainLists } from "@tell/people";
import { regionName } from "./niche.js";
import { profileLine } from "./company-facts.js";
import { neonUsage, type UsageStore } from "./usage.js";
import {
  rosterFromAwards, isJointVenture, sameEntity, affiliates, expiringEvents, eventQuote, matchEvent, matchGeneral, matchValue, scoreBeneficiary, heldBack, hasNewTopEvent, deliveredEvents, timingFor, generalFacts, TOP_EVENTS,
  type MemberFacts, type OppEvent, type BeneficiaryScore, type GeneralEvent, type ScoredMatch,
} from "@tell/intel";
import type { Contact } from "@tell/people";
import { getDb, accounts, companySeeds, deliveries, marketEvents, rosterMembers, opportunityMatches, and, eq, inArray, sql } from "@tell/db";
import { persistNicheRecords, type NicheRecord, type NicheResult } from "./niche.js";
import { contactsFor } from "./contacts.js";
import { attachEmails } from "./emails.js";
import { decisionPower } from "./reach.js";
import { waterfallContacts } from "./waterfall.js";
import { readSite, type SitePage } from "@tell/watchers";
import { HaikuClient, checkFit, STAGE_STRENGTH, stageRank, needFor, EVENT_CHECK_VERSION, type FitVerdict, type LlmClient, type EventNeed, type Stage } from "@tell/extract";
import { eventChecksFor, gateEvent, type EventCheckDeps, type EventToCheck, type GateResult } from "./event-checks.js";
import type { EventCheck } from "@tell/extract";
import { eventChecks } from "@tell/db";
import { tradeId, isTrade, tradesFrom, upsertTrades, activeTrades, withTrades } from "./trades.js";
import { fitChecks } from "@tell/db";

/**
 * Opportunity-led leads (pack opportunities.yaml, `pnpm opps`): find the event first, then the companies that can
 * benefit from it. Event kinds: usaspending_expiring (a federal contract ending = a recompete for other contractors),
 * news (headlines: a plant, land, mass hiring, layoffs, a new leader, a new hospital; the company in the headline is
 * never resolved), signals (what the sources already collect: funding, approvals, permits, importers). Roster kinds:
 * usaspending_awardees, company_search (Exa company search: machinery makers, staffing firms, customs brokers ...),
 * import (your list).
 *   1. roster   past winners per NAICS code (and set-aside family) from USASpending, refreshed every refresh_days;
 *               names resolve to websites through the niche resolvers (free ways first, Exa inside its budget)
 *   2. events   contracts ending in the window, the incumbent stored by name only
 *   3. match    in code (intel/opportunity.ts): NAICS, set-aside gate, agency, size; the incumbent never matches
 *   4. rank     per beneficiary over all its events: opportunity + fit + timing + buyer
 *   5. people   the opportunity's buyers (Head of BD / Capture first) at the top of the pool
 * Prints counts only (CI logs are public).
 */

const DAY = 86_400_000;
/** an event is live while it was seen in the last few refreshes (a contract whose end date moved is re-read by then),
 *  never longer than window_days */
export const liveSince = (op: Pick<OpportunityDef, "refresh_days">, windowDays: number, now: Date) => new Date(now.getTime() - Math.min(windowDays, 3 * op.refresh_days) * DAY);
const families = (xs: SetAsideFamily[]): (SetAsideFamily | null)[] => [null, ...xs];
type FedRoster = Extract<Roster, { kind: "usaspending_awardees" }>;
type FedOpp = Extract<OpportunityDef, { kind: "usaspending_expiring" }>;
type GenOpp = Exclude<OpportunityDef, FedOpp>;
/** the opportunity whose stored events this one reads (events_from shares another's news / signals) */
export const eventsOpp = (id: string, op: OpportunityDef) => (op.kind !== "usaspending_expiring" && op.events_from) || id;
/** is a stored event still live for this opportunity (pure) */
export function isLive(op: OpportunityDef, row: { lastSeenAt: Date; eventDate: Date | null }, windowDays: number, now: Date): boolean {
  if (!row.eventDate) return false;
  if (op.kind === "usaspending_expiring") return new Date(row.lastSeenAt) >= liveSince(op, windowDays, now) && new Date(row.eventDate) > now;
  return now.getTime() - new Date(row.eventDate).getTime() <= op.max_age_days * DAY;
}
const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** Which of these queries are due (not run in the last `days`), using company_seeds as the log (`source`, id = hash). */
async function dueQueries(source: string, qs: string[], days: number, now: Date): Promise<string[]> {
  if (!qs.length) return [];
  const db = getDb();
  const seen = new Map((await db.select({ id: companySeeds.sourceId, at: companySeeds.siteCheckedAt }).from(companySeeds)
    .where(and(eq(companySeeds.source, source), inArray(companySeeds.sourceId, qs.map(hash))))).map((r) => [r.id, r.at]));
  return qs.filter((q) => { const at = seen.get(hash(q)); return !at || now.getTime() - new Date(at).getTime() >= days * DAY; });
}
async function markQuery(source: string, q: string, now: Date) {
  await getDb().insert(companySeeds).values({ source, sourceId: hash(q), fitPass: true, reason: "query", siteCheckedAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: [companySeeds.source, companySeeds.sourceId], set: { siteCheckedAt: now, updatedAt: now } });
}

export interface OppRunStats {
  rosters: Record<string, { refreshed: boolean; awards: number; members: number; looked: number; resolved: number; pending: number; sam?: { requests: number; checked: number; withSite: number } }>;
  events: Record<string, { fetched: number; stored: number; errors: number; skipped?: boolean }>;
  matches: number; beneficiaries: number; held: number; pool: number; noContact: number; leads: number;
  proven?: number; unproven?: number; fitChecks?: number;
  /** the trades verified needs named this run, and how many are active (searched and matched) */
  trades?: { named: number; active: number; checks: number };
  /** event fact-checks made this run, and news / signal events dropped by the check, by reason */
  eventChecks?: number; eventDropped?: Partial<Record<Exclude<GateResult, { ok: true }>["why"], number>>;
}

export interface OppLead {
  account: { id: string; domain: string; name: string | null; description: string | null; region: string | null; sizeBand: string | null; segment: string | null };
  opportunity: { id: string; kind: OpportunityDef["kind"]; label: string; angle: string; follow: string; buyers: string[] };
  score: BeneficiaryScore;
  /** endDate: the contract's end date (federal), else the event's date */
  events: { id: string; quote: string; url: string; amount: number; endDate: Date; agency: string; naics: string; setAside: string | null; strength?: number; entityName: string; fit: number; reasons: string[]; firstSeenAt: Date;
    /** news / signal events, after the fact-check: the need this company can serve, the stage, what happened */
    need?: EventNeed; stage?: Stage; happened?: string; stageQuote?: string | null; entitySells?: string;
    /** where the event was found (the news search's country, the signalling company's region) */
    region?: string | null }[];
  evidence: MemberFacts["evidence"];
  facts: MemberFacts;
  contact: Contact | null;
  /** the fit proven from their own site (news / signal leads): what the event needs, and the sentence that shows they offer it */
  proof?: { need: string; quote: string; url: string } | null;
}

type Fetch = typeof searchFedAwards;

// ------------------------------------------------------------------------------------------------ 1. roster

/** Refresh a roster when due: federal awardees from USASpending, company_search from Exa (queries rotate inside
 *  search_per_day), import rosters only through `pnpm opps import`. Members keep their resolution status. */
export async function refreshRoster(id: string, r: Roster, opts: { now?: Date; fetch?: Fetch; force?: boolean; pack?: Pack; search?: (q: string, n: number) => Promise<CompanyHit[]>; usage?: UsageStore } = {}): Promise<{ refreshed: boolean; awards: number; members: number }> {
  if (r.kind === "usaspending_awardees") return refreshFedRoster(id, r, opts);
  if (r.kind === "company_search" && opts.pack) return refreshSearchRoster(id, r, opts.pack, opts);
  return { refreshed: false, awards: 0, members: 0 };
}

/** Upsert general members (search / import), keeping a member's status and account. */
async function upsertGeneral(id: string, ms: { key: string; name: string; facts: MemberFacts; priority: number }[], now: Date) {
  const db = getDb();
  for (let i = 0; i < ms.length; i += 200) {
    await db.insert(rosterMembers).values(ms.slice(i, i + 200).map((m) => ({ roster: id, key: m.key, name: m.name, facts: m.facts, priority: m.priority, refreshedAt: now })))
      .onConflictDoUpdate({ target: [rosterMembers.roster, rosterMembers.key], set: { refreshedAt: sql`excluded.refreshed_at`, facts: sql`excluded.facts` } });
  }
}

/** A country-code domain that says the company is elsewhere (woodgrove.se in an India roster): .in counts for India,
 *  .us for the US; generic ones (.com, .net, .io, .co, .ai ...) say nothing (pure; exported for tests). */
export function foreignDomain(domain: string, region: string): boolean {
  const tld = domain.split(".").pop()!.toLowerCase();
  if (tld.length !== 2 || ["io", "co", "ai", "me", "tv", "cc", "ly", "gg", "so", "to", "sh", "xyz"].includes(tld)) return false;
  return !((region === "India" && tld === "in") || (region === "United States of America" && tld === "us"));
}

/** Company search results -> members (pure; exported for tests): HQ in the roster's regions, the description says what
 *  they sell (`must`, not `exclude`), a real company domain (no directories, marketplaces, free mail). */
export function searchMembers(hits: CompanyHit[], r: Extract<Roster, { kind: "company_search" }>, q: string, lists: ReturnType<typeof domainLists>): { key: string; name: string; facts: MemberFacts; priority: number }[] {
  const must = r.must ? toRegex(r.must) : null, exclude = r.exclude ? toRegex(r.exclude) : null;
  const out = new Map<string, { key: string; name: string; facts: MemberFacts; priority: number }>();
  for (const h of hits) {
    const domain = registrableDomain(h.url), region = regionName(h.country);
    if (!domain || lists.neverCompany.has(domain) || lists.freeMail.has(domain) || /indiamart|tradeindia|justdial|alibaba|linkedin|crunchbase|zaubacorp|tracxn|yelp|thomasnet|clutch\.co/i.test(domain)) continue;
    if (!region || !r.regions.includes(region) || foreignDomain(domain, region)) continue;
    const text = `${h.name} ${h.description}`;
    if ((must && !must.test(text)) || (exclude && exclude.test(text))) continue;
    const key = companyKey(h.name);
    if (key.length < 3 || out.has(key)) continue;
    out.set(key, { key, name: h.name.trim(), priority: 1, facts: generalFacts({ description: h.description ? profileLine(h.description) : null, region, found: q, website: `https://${domain}` }) });
  }
  return [...out.values()];
}

async function refreshSearchRoster(id: string, r: Extract<Roster, { kind: "company_search" }>, pack: Pack, opts: { now?: Date; force?: boolean; search?: (q: string, n: number) => Promise<CompanyHit[]>; usage?: UsageStore }): Promise<{ refreshed: boolean; awards: number; members: number }> {
  const now = opts.now ?? new Date(), usage = opts.usage ?? neonUsage(), cap = pack.opportunities.search_per_day;
  const search = opts.search ?? (process.env.EXA_API_KEY ? (q: string, n: number) => exaCompanySearch(q, process.env.EXA_API_KEY, n) : null);
  if (!search) return { refreshed: false, awards: 0, members: 0 };
  const due = opts.force ? r.queries : await dueQueries(`roster-query:${id}`, r.queries, r.refresh_days, now);
  const lists = domainLists(pack.domains);
  let hits = 0, members = 0;
  for (const q of due) {
    if ((await usage.spentToday("exa_roster")) >= cap) break;
    await usage.addSpend("exa_roster", 1, cap);
    let found: CompanyHit[];
    try { found = await search(q, r.results_per_query); } catch { continue; }
    hits += found.length;
    const ms = searchMembers(found, r, q, lists);
    await upsertGeneral(id, ms, now);
    await markQuery(`roster-query:${id}`, q, now);
    members += ms.length;
  }
  return { refreshed: due.length > 0, awards: hits, members };
}

/** Your own list into a roster (`pnpm opps import <roster> <file.csv>`, local only): name, website, region, description. */
export async function importRoster(id: string, r: Roster, rows: Record<string, string>[], now = new Date()): Promise<{ members: number; skipped: number }> {
  let skipped = 0;
  const ms = rows.flatMap((row) => {
    const name = (row.name ?? row.company ?? "").trim(), site = (row.website ?? row.domain ?? "").trim();
    const domain = site ? registrableDomain(/^https?:/i.test(site) ? site : `https://${site}`) : null;
    const region = (row.region ?? "").trim() || (r.kind !== "usaspending_awardees" ? r.regions[0] : "") || null;
    if (!name || !domain) { skipped++; return []; }
    return [{ key: companyKey(name), name, priority: 2, facts: generalFacts({ description: row.description?.trim() || null, region, found: "your list", website: `https://${domain}` }) }];
  });
  await upsertGeneral(id, ms, now);
  return { members: ms.length, skipped };
}

async function refreshFedRoster(id: string, r: FedRoster, opts: { now?: Date; fetch?: Fetch; force?: boolean }): Promise<{ refreshed: boolean; awards: number; members: number }> {
  const db = getDb(), now = opts.now ?? new Date(), fetch = opts.fetch ?? searchFedAwards;
  const [last] = await db.select({ at: sql<Date | null>`max(${rosterMembers.refreshedAt})` }).from(rosterMembers).where(eq(rosterMembers.roster, id));
  const lastAt = last?.at ? new Date(last.at) : null;
  if (!opts.force && lastAt && now.getTime() - lastAt.getTime() < r.refresh_days * DAY) return { refreshed: false, awards: 0, members: 0 };
  const awards: FedAward[] = [];
  for (const naics of r.naics) for (const fam of families(r.set_asides)) {
    try {
      awards.push(...await fetch({ naics, setAside: fam, setAsideCodes: fam ? SET_ASIDE_CODES[fam] : [], start: new Date(now.getTime() - r.lookback_days * DAY), end: now,
        dateType: "date_signed", sort: "Award Amount", maxPages: r.max_pages, minAmount: r.min_amount }));
    } catch { /* one code failing never stops the rest */ }
  }
  const members = rosterFromAwards(awards, r.min_awards, { smallBusinessOnly: r.small_business_only });
  for (let i = 0; i < members.length; i += 200) {
    const chunk = members.slice(i, i + 200);
    await db.insert(rosterMembers).values(chunk.map((m) => ({ roster: id, key: m.key, name: m.name, facts: m.facts, priority: m.priority, refreshedAt: now })))
      // keep what SAM said about the website (asked once per member)
      .onConflictDoUpdate({ target: [rosterMembers.roster, rosterMembers.key], set: { name: sql`excluded.name`, priority: sql`excluded.priority`, refreshedAt: sql`excluded.refreshed_at`,
        facts: sql`excluded.facts || jsonb_strip_nulls(jsonb_build_object('website', ${rosterMembers.facts}->'website', 'samChecked', ${rosterMembers.facts}->'samChecked'))` } });
  }
  return { refreshed: true, awards: awards.length, members: members.length };
}

/** Seed source the niche resolvers store roster names under (company_seeds `niche:roster_<id>`). */
const rosterSource = (id: string) => `roster_${id}`;

/** Roster members -> NicheRecords for the resolvers (pure; exported for tests). The signal type "roster" is not a pack
 *  signal, so resolving a member writes an account and never a signal: the member's facts live on the roster. */
export function rosterRecords(id: string, r: Roster, ms: { name: string; facts: MemberFacts & { website?: string | null } }[], now: Date): NicheRecord[] {
  const fed = r.kind === "usaspending_awardees";
  return ms.map((m) => ({
    source: rosterSource(id), name: m.name, query: fed ? `${m.name} government contractor` : m.name, segment: r.segment,
    regions: fed ? ["United States of America"] : r.regions, ...(!fed && m.facts.region ? { knownRegion: m.facts.region } : {}),
    // the website the company registered in SAM.gov (by its UEI): checked like any candidate, tried first
    ...(m.facts.website ? { website: m.facts.website } : {}),
    signal: { type: "roster", quote: m.facts.evidence[0]?.quote ?? m.name, url: m.facts.evidence[0]?.url ?? "", observedAt: now },
  }));
}

/** SAM requests a day for roster websites (usage_daily "sam_uei"); personal keys get 10 a day and the SAM extract
 *  (niche sam_entities) uses 2 */
export const SAM_UEI_PER_DAY = () => Number(process.env.SAM_UEI_PER_DAY ?? 7);

/**
 * The website each pending member registered in SAM.gov, looked up by UEI (8 per request, inside SAM_UEI_PER_DAY).
 * Stored on the member (`facts.website`, null = SAM lists none; `facts.samChecked`) so it is asked once.
 */
export async function samWebsites(id: string, opts: { usage?: UsageStore; lookup?: (ueis: string[]) => Promise<Map<string, string | null>>; limit?: number; maxRequests?: number } = {}): Promise<{ requests: number; checked: number; withSite: number }> {
  const key = process.env.SAM_API_KEY, out = { requests: 0, checked: 0, withSite: 0 };
  const lookup = opts.lookup ?? (key ? (u: string[]) => samWebsitesByUei(key, u) : null);
  if (!lookup) return out;
  const db = getDb(), usage = opts.usage ?? neonUsage(), cap = SAM_UEI_PER_DAY();
  const todo = await db.select({ key: rosterMembers.key, facts: rosterMembers.facts }).from(rosterMembers)
    .where(and(eq(rosterMembers.roster, id), eq(rosterMembers.status, "pending"), sql`not (${rosterMembers.facts} ? 'samChecked')`))
    .orderBy(sql`${rosterMembers.priority} desc`).limit(opts.limit ?? cap * SAM_UEIS_PER_REQUEST);
  for (let i = 0; i < todo.length; i += SAM_UEIS_PER_REQUEST) {
    if ((await usage.spentToday("sam_uei")) >= cap || (opts.maxRequests != null && out.requests >= opts.maxRequests)) break;
    const batch = todo.slice(i, i + SAM_UEIS_PER_REQUEST);
    await usage.addSpend("sam_uei", 1, cap);
    out.requests++;
    let sites: Map<string, string | null>;
    try { sites = await lookup(batch.flatMap((m) => (m.facts as MemberFacts).ueis)); } catch { break; } // quota or outage: try tomorrow
    for (const m of batch) {
      const f = m.facts as MemberFacts & { website?: string | null };
      const site = f.ueis.map((u) => sites.get(u)).find((s) => s) ?? null;
      await db.update(rosterMembers).set({ facts: { ...f, website: site, samChecked: true } }).where(and(eq(rosterMembers.roster, id), eq(rosterMembers.key, m.key)));
      out.checked++; if (site) out.withSite++;
    }
  }
  return out;
}

/** Resolve pending members to accounts: seeds already proven are linked for free; up to per_run more are looked up
 *  (members with a SAM-registered website first: they need no paid search). */
export async function resolveRoster(id: string, r: Roster, pack: Pack, opts: { now?: Date; persist?: typeof persistNicheRecords } = {}): Promise<{ looked: number; resolved: number; pending: number }> {
  const db = getDb(), now = opts.now ?? new Date();
  const seedSrc = `niche:${rosterSource(id)}`;
  const link = async () => {
    const pend = await db.select({ key: rosterMembers.key, name: rosterMembers.name }).from(rosterMembers).where(and(eq(rosterMembers.roster, id), eq(rosterMembers.status, "pending")));
    if (!pend.length) return 0;
    const byKey = new Map(pend.map((p) => [companyKey(p.name), p.key]));
    const seeds = await db.select().from(companySeeds).where(and(eq(companySeeds.source, seedSrc), inArray(companySeeds.sourceId, [...byKey.keys()])));
    let n = 0;
    for (const s of seeds) {
      const key = byKey.get(s.sourceId);
      if (!key) continue;
      if (s.fitPass && s.domain) {
        const [a] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.domain, s.domain)).limit(1);
        if (a) { await db.update(rosterMembers).set({ accountId: a.id, status: "resolved" }).where(and(eq(rosterMembers.roster, id), eq(rosterMembers.key, key))); n++; }
      } else if (!s.reason?.startsWith("deferred")) {
        await db.update(rosterMembers).set({ status: "miss" }).where(and(eq(rosterMembers.roster, id), eq(rosterMembers.key, key)));
      }
    }
    return n;
  };
  let resolved = await link();
  let looked = 0;
  if (r.per_run > 0) {
    // members whose seed is still unknown or deferred, strongest record first
    const todo = await db.select({ key: rosterMembers.key, name: rosterMembers.name, facts: rosterMembers.facts }).from(rosterMembers)
      .where(and(eq(rosterMembers.roster, id), eq(rosterMembers.status, "pending")))
      .orderBy(sql`(${rosterMembers.facts}->>'website') is null`, sql`${rosterMembers.priority} desc`).limit(r.per_run);
    if (todo.length) {
      const res: NicheResult = { source: rosterSource(id), records: 0, companies: 0, looked: 0, resolved: 0, accountsNew: 0, signals: 0, noMatch: 0, notRegion: 0, filtered: 0, badSite: 0, capped: 0, errors: 0 };
      await (opts.persist ?? persistNicheRecords)(rosterRecords(id, r, todo.map((t) => ({ name: t.name, facts: t.facts as MemberFacts & { website?: string | null } })), now), { pack, now }, res);
      looked = res.looked;
      resolved += await link();
    }
  }
  const [p] = await db.select({ n: sql<number>`count(*)::int` }).from(rosterMembers).where(and(eq(rosterMembers.roster, id), eq(rosterMembers.status, "pending")));
  return { looked, resolved, pending: p?.n ?? 0 };
}

/** Where a roster's companies are (federal awardees are US companies). */
export const rosterRegions = (r: Roster): string[] => (r.kind === "usaspending_awardees" ? ["United States of America"] : r.regions);
/** Is an opportunity inside the pack's working regions (pure)? Its roster's companies, a news opportunity's own region and
 *  its beneficiary regions must all be in scope (federal recompetes are US). Out of scope = paused: no events, matches
 *  or leads. */
export function oppInScope(op: OpportunityDef, pack: Pack): boolean {
  const scope = pack.meta.regions, r = op.roster ? pack.opportunities.rosters[op.roster] : undefined;
  if (!scope.length) return true;
  // a signals-only collector (no roster): its own region decides
  if (!op.roster && op.kind !== "usaspending_expiring") return op.kind !== "news" || inScope(scope, [op.region]);
  if (!r || !inScope(scope, rosterRegions(r))) return false;
  if (op.kind === "usaspending_expiring") return inScope(scope, ["United States of America"]);
  if (op.kind === "news" && !inScope(scope, [op.region])) return false;
  return !op.beneficiary_regions.length || inScope(scope, op.beneficiary_regions);
}

// ------------------------------------------------------------------------------------------------ 2. events

type EventOpts = { now?: Date; fetch?: Fetch; force?: boolean; pack?: Pack; news?: (q: string, country: string) => Promise<NewsItem[]>; usage?: UsageStore };

/** Collect one opportunity's events (an opportunity with events_from collects none of its own). */
export async function collectEvents(id: string, op: OpportunityDef, r: Roster | undefined, opts: EventOpts = {}): Promise<{ fetched: number; stored: number; errors: number; skipped?: boolean }> {
  if (op.kind === "usaspending_expiring") return r?.kind === "usaspending_awardees" ? collectFedEvents(id, op, r, opts) : { fetched: 0, stored: 0, errors: 0, skipped: true };
  if (op.events_from) return { fetched: 0, stored: 0, errors: 0, skipped: true };
  if (op.kind === "news") return opts.pack ? collectNewsEvents(id, op, opts.pack, opts) : { fetched: 0, stored: 0, errors: 0, skipped: true };
  if (!op.types.length) return { fetched: 0, stored: 0, errors: 0, skipped: true }; // a trade: its events come through their needs
  return collectSignalEvents(id, op, opts);
}

/** Headlines -> events (pure; exported for tests): the headline must match `must` and not `exclude`; the company before
 *  the verb is who it is about (kept by name only); a headline naming no company is not an event. */
export function newsEvents(items: NewsItem[], op: Extract<OpportunityDef, { kind: "news" }>, now: Date): { key: string; entityName: string; quote: string; url: string; at: Date }[] {
  const verbs = new RegExp(`\\s+(?:${op.verbs})\\b`, "i"), must = op.must ? toRegex(op.must) : null, exclude = op.exclude ? toRegex(op.exclude) : null;
  const seen = new Set<string>();
  return items.flatMap((i) => {
    if ((must && !must.test(i.title)) || (exclude && exclude.test(i.title)) || seen.has(i.url)) return [];
    seen.add(i.url);
    const at = i.postedAt && i.postedAt <= now ? i.postedAt : now;
    if (now.getTime() - at.getTime() > op.max_age_days * DAY) return [];
    // a headline that names no company before the verb is a roundup or a press note ("Manufacturing Momentum: ..."), not an event
    const entityName = companyFromHeadline(i.title, verbs);
    if (!entityName) return [];
    return [{ key: i.url, entityName, quote: `${i.title}${i.outlet ? ` (${i.outlet})` : ""}`, url: i.url, at }];
  });
}

async function storeGeneral(id: string, evs: { key: string; entityName: string; quote: string; url: string; at: Date; facts: Record<string, unknown> }[], now: Date) {
  const db = getDb();
  for (const e of evs) {
    await db.insert(marketEvents).values({ opportunity: id, key: e.key, entityName: e.entityName || "?", entityKey: e.entityName ? companyKey(e.entityName) : null, quote: e.quote.slice(0, 500), url: e.url, eventDate: e.at, facts: e.facts, firstSeenAt: now, lastSeenAt: now })
      .onConflictDoUpdate({ target: [marketEvents.opportunity, marketEvents.key], set: { lastSeenAt: now, facts: sql`excluded.facts` } });
  }
}

async function dropOld(id: string, maxAgeDays: number, now: Date) {
  await getDb().delete(marketEvents).where(and(eq(marketEvents.opportunity, id), sql`${marketEvents.eventDate} < ${new Date(now.getTime() - (maxAgeDays + 30) * DAY)}`));
}

async function collectNewsEvents(id: string, op: Extract<OpportunityDef, { kind: "news" }>, pack: Pack, opts: EventOpts): Promise<{ fetched: number; stored: number; errors: number; skipped?: boolean }> {
  const now = opts.now ?? new Date(), usage = opts.usage ?? neonUsage(), cap = pack.opportunities.news_per_day, key = process.env.SERPER_API_KEY;
  const news = opts.news ?? (key ? (q: string, c: string) => serperNews({ apiKey: key, country: c, timeRange: "w" })(q) : null);
  if (!news) return { fetched: 0, stored: 0, errors: 0, skipped: true };
  const due = opts.force ? op.queries : await dueQueries(`opp-query:${id}`, op.queries, op.refresh_days, now);
  let fetched = 0, stored = 0, errors = 0;
  for (const q of due) {
    if ((await usage.spentToday("serper_opps")) >= cap) break;
    await usage.addSpend("serper_opps", 1, cap);
    try {
      const items = await news(q, op.country);
      fetched += items.length;
      const evs = newsEvents(items, op, now);
      await storeGeneral(id, evs.map((e) => ({ ...e, facts: { kind: "news", region: op.region, strength: op.strength } })), now);
      stored += evs.length;
      await markQuery(`opp-query:${id}`, q, now);
    } catch { errors++; }
  }
  await dropOld(id, op.max_age_days, now);
  return { fetched, stored, errors };
}

/** Signals the sources already collected -> events. The account that has the signal is the entity (excluded). */
async function collectSignalEvents(id: string, op: Extract<OpportunityDef, { kind: "signals" }>, opts: EventOpts): Promise<{ fetched: number; stored: number; errors: number }> {
  const db = getDb(), now = opts.now ?? new Date();
  const rows = (await db.execute(sql`
    select s.id, s.type, s.strength, s.evidence_quote as quote, s.evidence_url as url, s.observed_at as at, a.id as account_id, a.domain, a.name, a.region, a.segment
    from signals s join accounts a on a.id = s.account_id
    where s.type in (${sql.join(op.types.map((t) => sql`${t}`), sql`, `)}) and s.observed_at >= ${new Date(now.getTime() - op.max_age_days * DAY)}
    order by s.observed_at desc limit 2000`)).rows as { id: string; type: string; strength: number; quote: string; url: string; at: string; account_id: string; domain: string; name: string | null; region: string | null; segment: string | null }[];
  const scope = opts.pack?.meta.regions ?? [];
  const keep = rows.filter((r) => (!op.entity_regions.length || (r.region && op.entity_regions.includes(r.region))) && (!op.entity_segments.length || (r.segment && op.entity_segments.includes(r.segment)))
    && inScope(scope, [r.region]));
  await storeGeneral(id, keep.map((r) => ({ key: r.id, entityName: r.name ?? r.domain, quote: r.quote, url: r.url, at: new Date(r.at),
    facts: { kind: "signal", type: r.type, region: r.region, segment: r.segment, strength: r.strength, accountId: r.account_id, domain: r.domain } })), now);
  await dropOld(id, op.max_age_days, now);
  return { fetched: rows.length, stored: keep.length, errors: 0 };
}

/** A stored news / signal event as the matcher's event (pure; exported for tests). */
export function storedGeneral(row: { key: string; entityName: string; entityKey: string | null; eventDate: Date | null; facts: unknown; quote: string; url: string }): GeneralEvent | null {
  const f = (row.facts ?? {}) as { region?: string | null; strength?: number; accountId?: string; domain?: string };
  if (!row.eventDate) return null;
  return { key: row.key, entityName: row.entityName === "?" ? "" : row.entityName, entityKey: row.entityKey ?? "", entityAccountId: f.accountId ?? null, entityDomain: f.domain ?? null,
    region: f.region ?? null, quote: row.quote, url: row.url, strength: f.strength ?? 3, observedAt: new Date(row.eventDate) };
}

/** Contracts ending in the opportunity's window -> market_events (one row per award; re-runs refresh it). */
async function collectFedEvents(id: string, op: FedOpp, r: FedRoster, opts: EventOpts = {}): Promise<{ fetched: number; stored: number; errors: number; skipped?: boolean }> {
  const db = getDb(), now = opts.now ?? new Date(), fetch = opts.fetch ?? searchFedAwards;
  const [last] = await db.select({ at: sql<Date | null>`max(${marketEvents.lastSeenAt})` }).from(marketEvents).where(eq(marketEvents.opportunity, id));
  if (!opts.force && last?.at && now.getTime() - new Date(last.at).getTime() < op.refresh_days * DAY) return { fetched: 0, stored: 0, errors: 0, skipped: true };
  const awards: FedAward[] = [];
  let errors = 0;
  for (const naics of op.naics.length ? op.naics : r.naics) for (const fam of families(op.set_asides)) {
    try {
      awards.push(...await fetch({ naics, setAside: fam, setAsideCodes: fam ? SET_ASIDE_CODES[fam] : [], start: new Date(now.getTime() - 2 * 365 * DAY), end: now,
        sort: "End Date", maxPages: op.max_pages, minAmount: op.min_amount, endAfter: new Date(now.getTime() + op.min_days * DAY) }));
    } catch { errors++; }
  }
  const evs = expiringEvents(awards, { minDays: op.min_days, maxDays: op.max_days, minAmount: op.min_amount, includeOrders: op.include_orders }, now);
  for (const e of evs) {
    const facts = { naics: e.naics, agency: e.agency, subAgency: e.subAgency, setAside: e.setAside, state: e.state, uei: e.uei, description: e.description, parent: awards.find((a) => a.awardId === e.key)?.parent ?? null };
    await db.insert(marketEvents).values({ opportunity: id, key: e.key, entityName: e.entityName, entityKey: e.entityKey, owner: e.agency, quote: eventQuote(e), url: e.url, amount: e.amount, eventDate: e.endDate, facts, firstSeenAt: now, lastSeenAt: now })
      .onConflictDoUpdate({ target: [marketEvents.opportunity, marketEvents.key], set: {
        lastSeenAt: now, quote: sql`excluded.quote`, amount: sql`excluded.amount`, eventDate: sql`excluded.event_date`,
        // a set-aside found once stays (a later query may miss the family page)
        // (->'setAside' is a JSON null, not SQL NULL, when this run missed it: nullif makes coalesce see it)
        facts: sql`excluded.facts || jsonb_build_object('setAside', coalesce(nullif(excluded.facts->'setAside', 'null'::jsonb), ${marketEvents.facts}->'setAside', 'null'::jsonb))`,
      } });
  }
  // a complete re-read is the truth: events it no longer returns (end date moved out, now an order) go, with their matches
  if (!errors) await db.delete(marketEvents).where(and(eq(marketEvents.opportunity, id), sql`${marketEvents.lastSeenAt} < ${now}`));
  return { fetched: awards.length, stored: evs.length, errors };
}

/** A stored event row as the matcher's event (pure; exported for tests). */
export function storedEvent(row: { key: string; entityName: string; entityKey: string | null; amount: number | null; eventDate: Date | null; facts: unknown; url: string }): OppEvent | null {
  const f = (row.facts ?? {}) as { naics?: string; agency?: string; subAgency?: string; setAside?: string | null; uei?: string | null; description?: string; state?: string | null };
  if (!row.eventDate || !f.naics) return null;
  return { key: row.key, entityName: row.entityName, entityKey: row.entityKey ?? companyKey(row.entityName), uei: f.uei ?? null, amount: row.amount ?? 0, endDate: new Date(row.eventDate),
    naics: f.naics, agency: f.agency ?? "", subAgency: f.subAgency ?? "", setAside: f.setAside ?? null, description: f.description ?? "", state: f.state ?? null, url: row.url };
}

// ------------------------------------------------------------------------------------------------ 3. match

/** Matches kept per beneficiary and opportunity (its strongest; a broad NAICS code matches hundreds of events). */
export const MATCHES_PER_ACCOUNT = 20;

/** Every live event of the opportunity x every resolved roster member -> opportunity_matches (replaced each run). */
export async function matchOpportunity(id: string, op: OpportunityDef, pack: Pack, opts: { now?: Date } = {}): Promise<number> {
  const rosterId = op.roster;
  if (!rosterId) return 0; // a signals-only collector: its events reach companies through their needs (trades)
  const db = getDb(), now = opts.now ?? new Date();
  const all = await db.select().from(marketEvents).where(eq(marketEvents.opportunity, eventsOpp(id, op)));
  const own = all.filter((e) => isLive(op, e, pack.opportunities.window_days, now));
  const cross = op.kind !== "usaspending_expiring" ? await crossEvents(id, op, pack, new Set(own.map((e) => e.url)), now) : [];
  const evs = [...own, ...cross];
  const members = await db.select({ m: rosterMembers, domain: accounts.domain }).from(rosterMembers).innerJoin(accounts, eq(accounts.id, rosterMembers.accountId))
    .where(and(eq(rosterMembers.roster, rosterId), eq(rosterMembers.status, "resolved")));
  const byAccount = new Map<string, { row: typeof opportunityMatches.$inferInsert; v: number }[]>();
  for (const row of evs) {
    const fed = op.kind === "usaspending_expiring" ? storedEvent(row) : null, gen = op.kind !== "usaspending_expiring" ? storedGeneral(row) : null;
    if (!fed && !gen) continue;
    if (gen && !gen.entityName) continue; // (news stored before headlines had to name a company)
    for (const { m, domain } of members) {
      if (!m.accountId || isJointVenture(m.name)) continue; // (members stored before JVs were left off rosters)
      const facts = m.facts as MemberFacts;
      const hit = fed && op.kind === "usaspending_expiring" ? matchEvent(fed, { key: m.key, name: m.name, facts }, { requireAgency: op.require_agency })
        : gen && op.kind !== "usaspending_expiring" ? matchGeneral(gen, { key: m.key, name: m.name, facts, accountId: m.accountId, domain }, { regions: op.beneficiary_regions, keywords: op.keywords }) : null;
      if (!hit) continue;
      const list = byAccount.get(m.accountId) ?? byAccount.set(m.accountId, []).get(m.accountId)!;
      const v = fed ? matchValue({ fit: hit.fit, amount: fed.amount, endDate: fed.endDate, largest: facts.largest, setAside: !!fed.setAside })
        : matchValue({ fit: hit.fit, amount: 0, endDate: gen!.observedAt, strength: gen!.strength, observedAt: gen!.observedAt });
      list.push({ row: { eventId: row.id, accountId: m.accountId, roster: rosterId, fit: hit.fit, reasons: hit.reasons, matchedAt: now }, v });
    }
  }
  // two roster entries can resolve to one company ("X Pvt Ltd" and "X Limited", one website): one match per event
  const rows = [...byAccount.values()].flatMap((l) => {
    const seen = new Set<string>();
    return l.sort((a, b) => b.v - a.v).filter((x) => !seen.has(x.row.eventId) && !!seen.add(x.row.eventId)).slice(0, MATCHES_PER_ACCOUNT).map((x) => x.row);
  });
  // this opportunity's matches (its events x its roster) are rebuilt from scratch: a member loses matches it no longer earns
  const mine = [...all, ...cross].map((e) => e.id);
  for (let i = 0; i < mine.length; i += 1000) await db.delete(opportunityMatches).where(and(inArray(opportunityMatches.eventId, mine.slice(i, i + 1000)), eq(opportunityMatches.roster, rosterId)));
  for (let i = 0; i < rows.length; i += 300) {
    await db.insert(opportunityMatches).values(rows.slice(i, i + 300))
      .onConflictDoUpdate({ target: [opportunityMatches.eventId, opportunityMatches.accountId], set: { fit: sql`excluded.fit`, reasons: sql`excluded.reasons` } });
  }
  return rows.length;
}

/**
 * One signal, several businesses: events another opportunity collected whose fact-check names a need this roster's
 * trade serves (a new API plant: machinery for the machinery makers, cleanrooms for the HVAC firms, workers for the
 * staffing agencies). Only checked events (verdict ok) travel, each once, while live under its own opportunity; the
 * ranking gate still checks stage, place and peer for every company.
 */
async function crossEvents(id: string, op: Extract<OpportunityDef, { kind: "news" | "signals" }>, pack: Pack, ownUrls: Set<string>, now: Date): Promise<(typeof marketEvents.$inferSelect)[]> {
  const cfg = pack.opportunities, roster = op.roster ? cfg.rosters[op.roster] : undefined;
  if (!roster || roster.kind === "usaspending_awardees" || !op.verify) return [];
  const sources = Object.entries(cfg.opportunities).filter(([oid, o]) => o.kind !== "usaspending_expiring" && !o.events_from && oid !== eventsOpp(id, op)
    && (oppInScope(o, pack) || Object.entries(cfg.opportunities).some(([x, y]) => oppInScope(y, pack) && eventsOpp(x, y) === oid)));
  if (!sources.length) return [];
  const db = getDb();
  const rows = await db.select({ e: marketEvents, needs: eventChecks.needs, where: eventChecks.where }).from(marketEvents).innerJoin(eventChecks, eq(eventChecks.url, marketEvents.url))
    .where(and(inArray(marketEvents.opportunity, sources.map(([oid]) => oid)), eq(eventChecks.verdict, "ok"), eq(eventChecks.version, EVENT_CHECK_VERSION)));
  const srcOp = new Map(sources);
  const group = { id: op.roster, segment: roster.segment, must: "must" in roster && roster.must ? toRegex(roster.must) : null, keywords: op.keywords };
  const seen = new Set(ownUrls), out: (typeof marketEvents.$inferSelect)[] = [];
  const trade = isTrade(op.roster!);
  for (const { e, needs, where } of rows) {
    const so = srcOp.get(e.opportunity);
    if (!so || seen.has(e.url) || !isLive(so, e, cfg.window_days, now)) continue;
    const place = where ?? ((e.facts ?? {}) as { region?: string | null }).region ?? "";
    const ns = (needs as EventNeed[]) ?? [];
    if (trade ? !ns.some((n) => tradeId(n, place) === op.roster) : !needFor(ns, group)) continue;
    seen.add(e.url);
    out.push(e);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ 4-5. rank + people

/**
 * The day's opportunity leads: every beneficiary with live matched events, scored, held back when delivered recently
 * with nothing new, the pool searched for the opportunity's buyers, re-scored with the contact, cut at max_leads.
 */
export async function rankOpportunityLeads(pack: Pack, opts: { now?: Date; write?: boolean; contacts?: typeof contactsFor; emails?: typeof attachEmails; waterfall?: typeof waterfallContacts; fit?: FitDeps; events?: EventCheckDeps } = {}): Promise<{ leads: OppLead[]; stats: Pick<OppRunStats, "beneficiaries" | "held" | "pool" | "noContact" | "leads" | "proven" | "unproven" | "fitChecks" | "eventChecks" | "eventDropped"> }> {
  const db = getDb(), now = opts.now ?? new Date(), cfg = pack.opportunities;
  const since = new Date(now.getTime() - cfg.window_days * DAY);
  // a match belongs to the opportunity that reads its event's opportunity with its roster (events_from shares events)
  const oppOf = new Map(Object.entries(cfg.opportunities).filter(([, op]) => oppInScope(op, pack)).map(([id, op]) => [`${eventsOpp(id, op)}:${op.roster}`, id]));
  // a fact-checked event routed to another roster by its needs (matchOpportunity's cross matches): the first
  // news / signal opportunity of that roster owns the lead
  const byRoster = new Map<string, string>();
  for (const [id, op] of Object.entries(cfg.opportunities)) if (op.kind !== "usaspending_expiring" && op.roster && oppInScope(op, pack) && !byRoster.has(op.roster)) byRoster.set(op.roster, id);
  const rows0 = await db.select({
    eventId: marketEvents.id, opportunity: marketEvents.opportunity, quote: marketEvents.quote, url: marketEvents.url, amount: marketEvents.amount, eventDate: marketEvents.eventDate,
    facts: marketEvents.facts, entityName: marketEvents.entityName, firstSeenAt: marketEvents.firstSeenAt, lastSeenAt: marketEvents.lastSeenAt, accountId: opportunityMatches.accountId, roster: opportunityMatches.roster, fit: opportunityMatches.fit, reasons: opportunityMatches.reasons,
  }).from(opportunityMatches).innerJoin(marketEvents, eq(marketEvents.id, opportunityMatches.eventId))
    .where(sql`${marketEvents.lastSeenAt} >= ${new Date(since.getTime() - 365 * DAY)}`);
  const live = rows0.flatMap((r) => {
    const oid = oppOf.get(`${r.opportunity}:${r.roster}`) ?? byRoster.get(r.roster), op = oid ? cfg.opportunities[oid] : undefined;
    return op && isLive(op, { lastSeenAt: r.lastSeenAt, eventDate: r.eventDate }, cfg.window_days, now) ? [{ ...r, opportunity: oid! }] : [];
  });
  const ids = [...new Set(live.map((r) => r.accountId))];
  if (!ids.length) return { leads: [], stats: { beneficiaries: 0, held: 0, pool: 0, noContact: 0, leads: 0, eventChecks: 0 } };
  const accts = new Map((await db.select().from(accounts).where(and(inArray(accounts.id, ids), eq(accounts.status, "active")))).map((a) => [a.id, a]));
  const members = new Map((await db.select().from(rosterMembers).where(inArray(rosterMembers.accountId, ids))).map((m) => [`${m.roster}:${m.accountId}`, m]));
  // the last opportunity delivery per account, with the events it showed (a lead returns early only with a new top event)
  const lastDelivered = new Map<string, { at: Date; urls: Set<string>; legacy: boolean }>();
  for (const r of await db.select({ a: deliveries.accountId, at: deliveries.deliveredAt, ctx: deliveries.context }).from(deliveries)
    .where(and(inArray(deliveries.accountId, ids), eq(deliveries.kind, "opportunity"))).orderBy(sql`${deliveries.deliveredAt} desc`)) {
    if (!r.a || lastDelivered.has(r.a)) continue;
    lastDelivered.set(r.a, { at: new Date(r.at), ...deliveredEvents(r.ctx) });
  }

  // one lead per beneficiary and opportunity kind (its strongest opportunity when it has several)
  const byAccount = new Map<string, typeof live>();
  for (const r of live) if (accts.has(r.accountId)) byAccount.set(r.accountId, [...(byAccount.get(r.accountId) ?? []), r]);
  // every company x opportunity it matched is a candidate: the fact-check decides which events stand, and only then
  // is each company's best opportunity picked (a packaging firm whose strongest match fails the check may still have
  // a beverage plant that passes)
  const cands: OppLead[] = [];
  for (const [aid, rs] of byAccount) {
    const byOpp = new Map<string, typeof rs>();
    for (const r of rs) byOpp.set(r.opportunity, [...(byOpp.get(r.opportunity) ?? []), r]);
    for (const [oid, list] of byOpp) {
      const op = cfg.opportunities[oid]!;
      const m = members.get(`${op.roster}:${aid}`);
      const facts = (m?.facts ?? {}) as MemberFacts;
      const s = scoreBeneficiary(list.map((r) => asScored(op, { fit: r.fit, amount: r.amount ?? 0, date: new Date(r.eventDate!), facts: r.facts }, facts)), sweet(op), null, now);
      const a = accts.get(aid)!;
      cands.push({
        account: { id: a.id, domain: a.domain, name: a.name, description: a.description, region: a.region, sizeBand: a.sizeBand, segment: a.segment },
        opportunity: { id: oid, kind: op.kind, label: op.label, angle: op.angle, follow: op.follow, buyers: op.buyers }, score: s, facts, evidence: facts.evidence ?? [], contact: null,
        events: list.map((r) => {
          const f = (r.facts ?? {}) as { agency?: string; naics?: string; setAside?: string | null; strength?: number; region?: string | null };
          return { id: r.eventId, quote: r.quote, url: r.url, amount: r.amount ?? 0, endDate: new Date(r.eventDate!), agency: f.agency ?? "", naics: f.naics ?? "", setAside: f.setAside ?? null,
            strength: f.strength, entityName: r.entityName === "?" ? "" : r.entityName, fit: r.fit, reasons: (r.reasons as string[]) ?? [], firstSeenAt: new Date(r.firstSeenAt), region: f.region ?? null };
        }).sort((x, y) => matchValue(asScored(op, { ...y, date: y.endDate, facts: y }, facts)) - matchValue(asScored(op, { ...x, date: x.endDate, facts: x }, facts))),
      });
    }
  }
  cands.sort((a, b) => b.score.score - a.score.score);
  const max = cfg.max_leads || cands.length;
  // news / signal events must survive the fact-check first: a quoted need this company's trade can serve, at the
  // stage the opportunity asks for, where the company works, from an event company that isn't its peer
  // (checks are facts about an article, not deliveries: kept on dry runs too, so nothing is paid for twice)
  const gated = await gateLeads(cands, pack, { now, write: true, want: max * cfg.pool_multiplier * 3, ...(opts.events ? { deps: opts.events } : {}) });
  let held = 0;
  const scored: OppLead[] = [];
  const picked = new Set<string>();
  for (const best of gated.leads) { // strongest first: the first one per company is its best
    if (picked.has(best.account.id)) continue;
    picked.add(best.account.id);
    // new = one of its top events wasn't on the lead you got (a weekly refresh brings far-off contracts into the window,
    // which alone is no reason to send the same company again)
    const last = lastDelivered.get(best.account.id);
    const fresh = !!last && hasNewTopEvent(best.events.map((e) => e.url), last);
    if (heldBack(last?.at ?? null, fresh, cfg.redeliver_after_days, now)) { held++; continue; }
    scored.push(best);
  }
  // news / signal leads must prove the fit from the company's own site before they take a slot (federal leads carry
  // their proof: the contracts they won)
  const proven = await proveFits(scored, pack, { now, write: opts.write !== false, want: max * cfg.pool_multiplier * 2, ...(opts.fit ? { fit: opts.fit } : {}) });
  const pool = roundRobin(proven.leads, max * cfg.pool_multiplier, cfg.max_per_opportunity * cfg.pool_multiplier);

  // the opportunity's buyers first (Head of BD / Capture for a recompete), searched only for the pool
  const preferred = new Map(pool.map((l) => [l.account.id, l.opportunity.buyers]));
  // only the opportunity's buyers are searched (one or two searches a company, not every buyer type), so the budget
  // reaches the whole pool; Air Waterfall's people lookup then tries the companies still without anyone
  const contacts = await (opts.contacts ?? contactsFor)(pool.map((l) => l.account.id), pack, { write: opts.write !== false, searchFor: pool.map((l) => l.account.id), maxSearches: cfg.max_people_searches, preferred, onlyPreferred: true });
  try { await (opts.waterfall ?? waterfallContacts)(contacts, pool.map((l) => l.account.id), pack, { write: opts.write !== false, preferred }); } catch { /* not configured or down */ }
  try { await (opts.emails ?? attachEmails)(contacts, { write: opts.write !== false }); } catch { /* leads still go out with LinkedIn */ }
  let noContact = 0;
  const leads: OppLead[] = [];
  for (const l of pool) {
    const c = contacts.get(l.account.id) ?? null;
    if (!c) { noContact++; continue; } // every lead names a person
    const op = cfg.opportunities[l.opportunity.id]!;
    const s = scoreBeneficiary(l.events.map((e) => asScored(op, { fit: e.fit, amount: e.amount, date: e.endDate, facts: e }, l.facts)), sweet(op), decisionPower(c, pack), now);
    if (cfg.min_score && s.score < cfg.min_score) continue;
    leads.push({ ...l, contact: c, score: s });
  }
  leads.sort((a, b) => b.score.score - a.score.score);
  const out = roundRobin(leads, max, cfg.max_per_opportunity).sort((a, b) => b.score.score - a.score.score);
  return { leads: out, stats: { beneficiaries: byAccount.size, held, pool: pool.length, noContact, leads: out.length, proven: proven.proven, unproven: proven.unproven, fitChecks: proven.checks, eventChecks: gated.made, eventDropped: gated.dropped } };
}

// ------------------------------------------------------------------------------------------------ event fact-check

/** a lead's events that are fact-checked: all it matched (checks are cached per article, so only new ones cost) */
const EVENTS_GATED = MATCHES_PER_ACCOUNT;

/**
 * Keep only the news / signal events that pass the fact-check (pipeline/event-checks.ts `gateEvent`), re-scored by
 * their stage (buying > committed > early); a lead with none left is dropped. Federal recompetes and opportunities
 * with `verify: false` pass as they are. Checks are made for the first `want` candidates' events, strongest first.
 */
export async function gateLeads(cands: OppLead[], pack: Pack, opts: { now: Date; write: boolean; want: number; deps?: EventCheckDeps }): Promise<{ leads: OppLead[]; made: number; dropped: NonNullable<OppRunStats["eventDropped"]>; checks: Map<string, EventCheck>; entities: Map<string, string> }> {
  const cfg = pack.opportunities;
  const general = (c: OppLead) => { const op = cfg.opportunities[c.opportunity.id]; return op && op.kind !== "usaspending_expiring" && op.verify ? op : null; };
  const toCheck: EventToCheck[] = [];
  // every candidate's top events, strongest lead first: many companies share one event, so the run's new checks
  // (EVENT_CHECKS_PER_RUN) go to distinct articles down the list, never to the same few
  for (const c of cands) if (general(c)) for (const e of c.events.slice(0, EVENTS_GATED)) toCheck.push({ url: e.url, quote: e.quote, entityName: e.entityName });
  const { checks, made } = await eventChecksFor(toCheck, pack, { now: opts.now, write: opts.write, ...(opts.deps ? { deps: opts.deps } : {}) });
  const dropped: NonNullable<OppRunStats["eventDropped"]> = {};
  const out: OppLead[] = [];
  for (const c of cands) {
    const op = general(c);
    if (!op) { out.push(c); continue; }
    const roster = op.roster ? cfg.rosters[op.roster] : undefined;
    if (!roster) continue;
    const kept: OppLead["events"] = [];
    for (const e of c.events.slice(0, EVENTS_GATED)) {
      const ck = checks.get(e.url), g = gateEvent(ck, op, roster, c.account.region, cfg.min_stage, e.region ?? null, op.roster, cfg.exclude_entity_industries);
      if (!g.ok) { dropped[g.why] = (dropped[g.why] ?? 0) + 1; continue; }
      kept.push({ ...e, strength: STAGE_STRENGTH[g.stage], need: g.need, stage: g.stage, happened: ck!.happened, stageQuote: ck!.stageQuote, entitySells: ck!.entitySells,
        reasons: [...e.reasons.filter((r) => r.startsWith("based in")), `they will need ${g.need.what}`, `stage: ${g.stage}${ck!.stageQuote ? ` ("${ck!.stageQuote}")` : ""}`] });
    }
    if (!kept.length) continue;
    // a request you can answer now leads; then the newest
    kept.sort((x, y) => stageRank(y.stage) - stageRank(x.stage) || y.endDate.getTime() - x.endDate.getTime());
    const score = scoreBeneficiary(kept.map((e) => asScored(op, { fit: e.fit, amount: 0, date: e.endDate, facts: e }, c.facts)), sweet(op), null, opts.now);
    out.push({ ...c, events: kept, score });
  }
  out.sort((a, b) => b.score.score - a.score.score);
  const entities = new Map(toCheck.map((e) => [e.url, e.entityName]));
  return { leads: out, made, dropped, checks, entities };
}

// ------------------------------------------------------------------------------------------------ proof of fit

/** a proof check is reused this long (sites change slowly) */
export const FIT_CHECK_DAYS = 60;
/** events tried per lead before giving up on it */
const EVENTS_TRIED = 2;
export interface FitDeps {
  /** site reader and checker (tests pass fakes) */
  read?: (domain: string, words: string[], rendered: boolean) => Promise<{ pages: SitePage[]; usedFirecrawl: boolean }>;
  llm?: LlmClient | null;
  usage?: UsageStore;
}

/** the words worth looking for on their site: the opportunity's keywords and the event's longer words (pure) */
export const siteWords = (quote: string, keywords: string[]) => [...new Set([...keywords, ...(quote.match(/\b[A-Za-z][a-z]{4,}\b/g) ?? [])].map((w) => w.toLowerCase()))].slice(0, 20);

/**
 * Keep the leads whose fit is proven (pure ordering, I/O through deps): federal leads and opportunities with
 * `verify: false` pass as they are; a news / signal lead passes when one of its top events gets a "yes" with a quote
 * from the company's own site (cached in fit_checks for FIT_CHECK_DAYS). Checks are capped per run (FIT_CHECKS_PER_RUN),
 * Haiku by FIT_DAILY_CAP_USD (usage_daily "haiku_fit"), Firecrawl renders by FIRECRAWL_PER_DAY ("firecrawl").
 * Unproven leads are dropped: without a site that shows the fit, the email would be a guess.
 */
export async function proveFits(cands: OppLead[], pack: Pack, opts: { now: Date; write: boolean; want: number; fit?: FitDeps }): Promise<{ leads: OppLead[]; proven: number; unproven: number; checks: number }> {
  const db = getDb(), usage = opts.fit?.usage ?? neonUsage();
  const cap = Number(process.env.FIT_DAILY_CAP_USD ?? 0.03), perRun = Number(process.env.FIT_CHECKS_PER_RUN ?? 30), fcCap = Number(process.env.FIRECRAWL_PER_DAY ?? 10);
  let llm: (LlmClient & { spent?: number }) | null | undefined = opts.fit?.llm;
  if (llm === undefined) {
    const left = cap - (await usage.spentToday("haiku_fit"));
    llm = process.env.ANTHROPIC_API_KEY && left > 0.001 ? new HaikuClient({ capUsd: left }) : null;
  }
  const read = opts.fit?.read ?? ((d: string, w: string[], r: boolean) => readSite(d, w, { rendered: r }));
  const ids = [...new Set(cands.map((c) => c.account.id))];
  const cached = new Map((ids.length ? await db.select().from(fitChecks).where(and(inArray(fitChecks.accountId, ids), sql`${fitChecks.checkedAt} > ${new Date(opts.now.getTime() - FIT_CHECK_DAYS * DAY)}`)) : [])
    .map((r) => [`${r.accountId}|${r.eventKey}`, r]));
  const sites = new Map<string, SitePage[]>();
  const out: OppLead[] = [];
  let proven = 0, unproven = 0, checks = 0;
  // `want` counts the leads that need proving: federal recompetes (which carry their proof) never use up the room,
  // or their high scores would keep every news / signal lead from being checked
  let tried = 0;
  for (const c of cands) {
    const op = pack.opportunities.opportunities[c.opportunity.id];
    if (!op || op.kind === "usaspending_expiring" || !op.verify) { out.push(c); continue; }
    if (tried++ >= opts.want) continue;
    let hit: { event: OppLead["events"][number]; v: { need: string; proof: string; url: string } } | null = null;
    for (const e of c.events.slice(0, EVENTS_TRIED)) {
      // (a check against the event's verified need is a different question from the old play-label one)
      const eventKey = e.need ? `${e.url}#need` : e.url, k = `${c.account.id}|${eventKey}`;
      const prior = cached.get(k);
      let v: FitVerdict | null = prior ? { verdict: prior.verdict as FitVerdict["verdict"], need: prior.need ?? "", proof: prior.proof, url: prior.proofUrl, reason: prior.reason ?? "" } : null;
      if (!v) {
        if (!llm || checks >= perRun) break;
        let pages = sites.get(c.account.domain);
        if (!pages) {
          const rendered = (await usage.spentToday("firecrawl")) < fcCap;
          const r = await read(c.account.domain, siteWords(`${e.need?.what ?? ""} ${e.quote}`, op.keywords), rendered).catch(() => ({ pages: [] as SitePage[], usedFirecrawl: false }));
          if (r.usedFirecrawl) await usage.addSpend("firecrawl", 1, fcCap);
          pages = r.pages;
          sites.set(c.account.domain, pages);
        }
        checks++;
        const before = llm.spent ?? 0;
        v = await checkFit(llm, { event: e.happened || e.quote, opportunity: e.need ? `${e.need.what} (sold by: ${e.need.supplier})` : c.opportunity.label, angle: e.need ? "" : c.opportunity.angle,
          company: c.account.name ?? c.account.domain, description: c.account.description, pages, ...(e.entitySells ? { peer: e.entitySells } : {}) })
          .catch(() => null);
        if (llm.spent != null) await usage.addSpend("haiku_fit", llm.spent - before, cap);
        if (!v) break; // the checker failed (cap, outage): this lead stays unproven today
        if (opts.write) await db.insert(fitChecks).values({ accountId: c.account.id, eventKey, verdict: v.verdict, need: v.need || null, proof: v.proof, proofUrl: v.url, reason: v.reason || null, checkedAt: opts.now })
          .onConflictDoUpdate({ target: [fitChecks.accountId, fitChecks.eventKey], set: { verdict: v.verdict, need: v.need || null, proof: v.proof, proofUrl: v.url, reason: v.reason || null, checkedAt: opts.now } });
      }
      if (v.verdict === "yes" && v.proof && v.url) { hit = { event: e, v: { need: v.need, proof: v.proof, url: v.url } }; break; }
    }
    if (!hit) { unproven++; continue; }
    proven++;
    // the proven event leads; the proof joins the reasons and the evidence the brief and the draft use
    const events = [hit.event, ...c.events.filter((x) => x !== hit!.event)];
    events[0] = { ...events[0]!, reasons: [...events[0]!.reasons, `their site: "${hit.v.proof}"`] };
    out.push({ ...c, events, proof: { need: hit.v.need, quote: hit.v.proof, url: hit.v.url }, evidence: [{ quote: `Their site: "${hit.v.proof}"`, url: hit.v.url }, ...c.evidence] });
  }
  return { leads: out, proven, unproven, checks };
}

/** Up to `n` leads taken in turns across opportunities (each list strongest first), at most `per` from one (pure;
 *  exported for tests): every vertical gets its best leads in, whatever its score scale. */
export function roundRobin<T extends { opportunity: { id: string }; score: { score: number } }>(xs: T[], n: number, per: number): T[] {
  const by = new Map<string, T[]>();
  for (const x of [...xs].sort((a, b) => b.score.score - a.score.score)) by.set(x.opportunity.id, [...(by.get(x.opportunity.id) ?? []), x]);
  const lists = [...by.values()].sort((a, b) => b[0]!.score.score - a[0]!.score.score), out: T[] = [];
  for (let i = 0; i < per && out.length < n; i++) for (const l of lists) { if (out.length >= n) break; if (l[i]) out.push(l[i]!); }
  return out;
}

const sweet = (op: OpportunityDef): [number, number] => (op.kind === "usaspending_expiring" ? op.sweet_spot_days : [0, 0]);
/** one matched event as the scorer sees it (pure) */
function asScored(op: OpportunityDef, e: { fit: number; amount: number; date: Date; facts: unknown }, member: MemberFacts): ScoredMatch {
  const f = (e.facts ?? {}) as { setAside?: string | null; strength?: number };
  return op.kind === "usaspending_expiring" ? { fit: e.fit, amount: e.amount, endDate: e.date, largest: member.largest, setAside: !!f.setAside }
    : { fit: e.fit, amount: 0, endDate: e.date, strength: f.strength ?? 3, observedAt: e.date };
}

/** The lead's timing line (pure): days to the nearest end date for contracts, else how fresh the newest event is. */
export function timingLine(l: Pick<OppLead, "events" | "opportunity">, now: Date): string {
  if (l.opportunity.kind === "usaspending_expiring") { const e = nearestEnd(l, now); return e ? `ends ${e.date} (${e.days} days)` : ""; }
  const newest = [...l.events].sort((a, b) => b.endDate.getTime() - a.endDate.getTime())[0];
  if (!newest) return "";
  const d = Math.max(0, Math.round((now.getTime() - newest.endDate.getTime()) / DAY));
  return `newest event ${d === 0 ? "today" : `${d} day${d === 1 ? "" : "s"} ago`} (${newest.endDate.toISOString().slice(0, 10)})`;
}

/** Days to the nearest end date, for the lead's timing line (pure). */
export function nearestEnd(l: Pick<OppLead, "events">, now: Date): { days: number; date: string } | null {
  const e = [...l.events].sort((a, b) => a.endDate.getTime() - b.endDate.getTime())[0];
  return e ? { days: Math.round((e.endDate.getTime() - now.getTime()) / DAY), date: e.endDate.toISOString().slice(0, 10) } : null;
}
export { timingFor };

/** Live news / signal events of the opportunities in scope, newest first (the ones the fact-check reads). */
async function liveGeneralEvents(pack: Pack, now: Date): Promise<{ url: string; quote: string; entityName: string; region: string | null }[]> {
  const cfg = pack.opportunities;
  const src = Object.entries(cfg.opportunities).filter(([id, op]) => op.kind !== "usaspending_expiring" && !op.events_from
    && (oppInScope(op, pack) || Object.entries(cfg.opportunities).some(([x, y]) => oppInScope(y, pack) && eventsOpp(x, y) === id)));
  if (!src.length) return [];
  const ops = new Map(src);
  const rows = await getDb().select().from(marketEvents).where(inArray(marketEvents.opportunity, src.map(([id]) => id))).orderBy(sql`${marketEvents.eventDate} desc nulls last`);
  const seen = new Set<string>();
  return rows.filter((r) => !seen.has(r.url) && !!seen.add(r.url) && isLive(ops.get(r.opportunity)!, r, cfg.window_days, now) && r.entityName !== "?")
    .map((r) => ({ url: r.url, quote: r.quote, entityName: r.entityName, region: ((r.facts ?? {}) as { region?: string | null }).region ?? null }));
}

/**
 * The whole collection side: rosters (when due) and their resolution, events, the fact-check of live events (whose
 * verified needs name trades: pipeline/trades.ts), the trades' own company searches and resolution, then matches.
 * Returns the pack with the active trades in it: ranking needs the same rosters and opportunities.
 */
export async function collectOpportunities(pack0: Pack, opts: { now?: Date; fetch?: Fetch; only?: "roster" | "events" | "match"; force?: boolean; events?: EventCheckDeps } = {}): Promise<Pick<OppRunStats, "rosters" | "events" | "matches" | "trades"> & { pack: Pack }> {
  const now = opts.now ?? new Date(), cfg0 = pack0.opportunities, scope = pack0.meta.regions;
  const out: Pick<OppRunStats, "rosters" | "events" | "matches" | "trades"> = { rosters: {}, events: {}, matches: 0 };
  const refresh = async (p: Pack, rosters: [string, Roster][]) => {
    for (const [id, r] of rosters) {
      if (!inScope(scope, rosterRegions(r))) continue; // a paused region: no searches, no lookups
      const f = await refreshRoster(id, r, { ...opts, pack: p }).catch(() => ({ refreshed: false, awards: 0, members: 0 }));
      // the day's SAM requests shared between rosters (the first one would otherwise take them all for weeks)
      const fedCount = Object.values(p.opportunities.rosters).filter((x) => x.kind === "usaspending_awardees").length || 1;
      const share = Math.max(1, Math.ceil(SAM_UEI_PER_DAY() / fedCount));
      const sam = r.kind === "usaspending_awardees" ? await samWebsites(id, { maxRequests: share }).catch(() => ({ requests: 0, checked: 0, withSite: 0 })) : undefined;
      const res = await resolveRoster(id, r, p, opts).catch(() => ({ looked: 0, resolved: 0, pending: 0 }));
      out.rosters![id] = { ...f, ...res, sam };
    }
  };
  if (!opts.only || opts.only === "events") for (const [id, op] of Object.entries(cfg0.opportunities)) {
    // (an in-scope opportunity may read events another one collects: collect those too)
    const used = Object.entries(cfg0.opportunities).some(([oid, o]) => oppInScope(o, pack0) && eventsOpp(oid, o) === id);
    if (!oppInScope(op, pack0) && !used) continue;
    const r = op.roster ? cfg0.rosters[op.roster] : undefined;
    if (r || op.kind !== "usaspending_expiring") out.events![id] = await collectEvents(id, op, r, { ...opts, pack: pack0 }).catch(() => ({ fetched: 0, stored: 0, errors: 1 }));
  }
  // fact-check the live events (cached per article; new ones inside EVENT_CHECKS_PER_RUN) and record the trades their
  // verified needs name, so a need no roster covers finds its own companies this same run
  let named = 0, made = 0;
  if (!opts.only || opts.only === "events") {
    const evs = await liveGeneralEvents(pack0, now);
    const r = await eventChecksFor(evs, pack0, { now, write: true, ...(opts.events ? { deps: opts.events } : {}) }).catch(() => null);
    if (r) {
      made = r.made;
      const region = new Map(evs.map((e) => [e.url, e.region]));
      const ts = tradesFrom([...r.checks].map(([url, check]) => ({ check, eventRegion: region.get(url) ?? null })), pack0);
      if (pack0.opportunities.trades.enabled) named = await upsertTrades(ts, now);
    }
  }
  const trades = await activeTrades(pack0, now);
  const pack = withTrades(pack0, trades);
  // the trades' company searches first (they answer today's signals; inside search_per_day, each every
  // trades.refresh_days), then the pack's own rosters with what's left of the day's searches
  if (!opts.only || opts.only === "roster" || opts.only === "events") await refresh(pack, trades.map((t) => [t.id, pack.opportunities.rosters[t.id]!] as [string, Roster]));
  if (!opts.only || opts.only === "roster") await refresh(pack0, Object.entries(cfg0.rosters));
  out.trades = { named, active: trades.length, checks: made };
  if (!opts.only || opts.only === "match") for (const [id, op] of Object.entries(pack.opportunities.opportunities)) if (oppInScope(op, pack)) out.matches! += await matchOpportunity(id, op, pack, opts);
  return { ...out, pack };
}
