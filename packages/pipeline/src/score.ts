import { createHash } from "node:crypto";
import { leadCap, minScoreFor, type Pack } from "@tell/config";
import {
  buildEvidence, scoreAccount, rankAccounts, rankByRegionGroups, compileRoles, critic, redelivery, regionInScope, type CriticVerdict, displayScore, bestCaseDisplayScore, type DeliveryHistory, timing as timingScore, matchPlays, icpRecheck,
  type JobRow, type SignalRow, type PersonRow, type AccountScore, type Ranking,
} from "@tell/intel";
import { getDb, accounts, jobBoards, jobs, signals, snapshots, people as peopleTable, scores, playsMatched, deliveries, labels, personLeads, companySeeds, eq, and, inArray, sql } from "@tell/db";

const chunk = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const DAY = 86_400_000;

export interface ScoredAccount {
  id: string;
  domain: string;
  name: string | null;
  sizeBand: string | null;
  region: string | null;
  segment: string | null;
}

export interface PersonLeadRank { platform: string; handle: string; type: string; quote: string; url: string; strength: number; score: number }

export interface ScoreRunResult {
  configVersion: string;
  scored: number;
  eligible: number;
  ranking: Ranking<ScoredAccount>;
  personLeads: PersonLeadRank[];
  playsMatched: number;
  /** eligible accounts the code critic dropped before ranking, by check */
  criticDropped: Record<string, number>;
  /** eligible accounts under delivery.digest.min_score (never sent) */
  belowMinScore: number;
  /** eligible accounts under the floor with unknown size or segment that could pass with full fit, closest first */
  factsCandidates: string[];
  /** accounts where an empty GTM / Founder's Office / Product Marketing seat would complete a play: worth a need check */
  gapCandidates: string[];
  /** account id -> critic checks it failed (eligible accounts only) */
  criticFailed?: Record<string, string[]>;
  /** every scored account (for tuning and evals; not rendered) */
  all?: { account: ScoredAccount; score: AccountScore }[];
}

/** Pack name + content hash: every score row says which config produced it (calibration, champion/challenger later). */
export function configVersion(pack: Pack): string {
  const h = createHash("sha256").update(JSON.stringify(pack)).digest("hex").slice(0, 10);
  return `${pack.meta.name}@${h}`;
}

/** Daily scoring run (plan 8d). Writes scores + plays and returns the ranking for the digest. */
/** poolScale: with region groups, each group's size is multiplied by this (the digest's pool_multiplier); maxLeads is
 *  the size of a single list when there are no groups. */
export async function runScoring(opts: { pack: Pack; now?: Date; maxLeads?: number; poolScale?: number; write?: boolean; minScore?: number }): Promise<ScoreRunResult> {
  const { pack } = opts;
  const now = opts.now ?? new Date();
  const db = getDb();
  const roles = compileRoles(pack.roles);
  const version = configVersion(pack);

  // Load everything once (small: thousands of rows)
  const jobRows = await db.select({
    id: jobs.id, title: jobs.title, url: jobs.url, employmentType: jobs.employmentType, family: jobs.family,
    postedAt: jobs.postedAt, firstSeenAt: jobs.firstSeenAt, closedAt: jobs.closedAt, accountId: jobBoards.accountId, boardSource: jobBoards.source,
  }).from(jobs).innerJoin(jobBoards, eq(jobs.boardId, jobBoards.id))
    .where(sql`${jobs.closedAt} is null or ${jobs.closedAt} > ${new Date(now.getTime() - 180 * DAY)}`);

  const sigRows = await db.select({
    id: signals.id, type: signals.type, evidenceQuote: signals.evidenceQuote, evidenceUrl: signals.evidenceUrl,
    observedAt: signals.observedAt, lastSeenAt: signals.lastSeenAt, accountId: signals.accountId,
  }).from(signals).where(and(sql`${signals.accountId} is not null`,
    // a state first seen long ago but still seen by the watch stays in
    sql`coalesce(${signals.lastSeenAt}, ${signals.observedAt}) > ${new Date(now.getTime() - 180 * DAY)}`));

  const byAccount = new Map<string, { jobs: JobRow[]; signals: SignalRow[]; people: PersonRow[] }>();
  const slot = (id: string) => byAccount.get(id) ?? (byAccount.set(id, { jobs: [], signals: [], people: [] }), byAccount.get(id)!);
  for (const j of jobRows) slot(j.accountId).jobs.push(j);
  for (const s of sigRows) slot(s.accountId!).signals.push(s);
  // known people (for "has an ops owner"): attached only to accounts that already have evidence
  const known = await db.select({ id: peopleTable.id, a: peopleTable.accountId, role: peopleTable.role, url: peopleTable.sourceUrl, fetchedAt: peopleTable.fetchedAt }).from(peopleTable);
  for (const p of known) byAccount.get(p.a)?.people.push({ id: p.id, role: p.role, url: p.url, fetchedAt: p.fetchedAt });

  const regionsAny = pack.icp.hard_filters.regions_any;
  const ids = [...byAccount.keys()];
  const accts = new Map<string, ScoredAccount>();
  for (const part of chunk(ids, 500)) {
    const rows = await db.select({ id: accounts.id, domain: accounts.domain, name: accounts.name, sizeBand: accounts.sizeBand, region: accounts.region, segment: accounts.segment, status: accounts.status })
      .from(accounts).where(inArray(accounts.id, part));
    for (const r of rows) if (r.status === "active" && regionInScope(r.region, pack.icp, r.segment)) accts.set(r.id, r);
  }

  // Evidence is incomplete when a board covering the account failed on its last check (plan 8d-2: outages are not evidence)
  const failing = new Set((await db.select({ a: jobBoards.accountId }).from(jobBoards)
    // failing, or not checked for a week: their open roles may have closed since (boards out of regions_any aren't
    // checked; widening it brings them back stale, and the YC cap gets through them in a few days)
    .where(and(eq(jobBoards.status, "active"), sql`${jobBoards.source} <> 'jsearch'`,
      sql`(${jobBoards.failCount} > 0 or ${jobBoards.lastCheckedAt} is null or ${jobBoards.lastCheckedAt} < now() - interval '7 days')`))).map((r) => r.a));

  // every account delivered before, with the latest label and outcome you gave it in the Sheet (any delivery):
  // a 👎 or a meeting holds it beyond the re-delivery window (redelivery())
  const history = new Map((await db.execute(sql`
    select d.account_id, max(d.delivered_at) as at,
      (array_agg(l.label order by d.delivered_at desc) filter (where l.label is not null))[1] as label,
      (array_agg(l.outcome order by d.delivered_at desc) filter (where l.outcome is not null))[1] as outcome
    from ${deliveries} d left join ${labels} l on l.delivery_id = d.id
    where d.account_id is not null group by d.account_id`)).rows
    .map((r) => { const x = r as { account_id: string; at: string; label: string | null; outcome: string | null }; return [x.account_id, { at: new Date(x.at), label: x.label, outcome: x.outcome } as DeliveryHistory] as const; }));
  const firstMatched = new Map((await db.select({ a: playsMatched.accountId, p: playsMatched.playId, at: playsMatched.matchedAt }).from(playsMatched))
    .map((r) => [`${r.a}:${r.p}`, r.at]));

  const results: { account: ScoredAccount; score: AccountScore; incomplete: boolean; recentlyDelivered: boolean; newSinceDelivery: boolean; backReason?: string }[] = [];
  for (const [id, data] of byAccount) {
    const account = accts.get(id);
    if (!account) continue;
    const score = scoreAccount(buildEvidence(data.jobs, data.signals, pack, roles, now, data.people), account, pack);
    // when each piece of evidence first existed: a role posted before the delivery but found later isn't new
    const firstSeen = new Map<string, Date>([
      ...data.jobs.map((j) => [j.id, j.postedAt && j.postedAt < j.firstSeenAt ? j.postedAt : j.firstSeenAt] as const),
      ...data.signals.map((x) => [x.id, x.observedAt] as const),
    ]);
    const r = redelivery(score, history.get(id), firstSeen, (p) => firstMatched.get(`${id}:${p}`), now, pack.delivery.redeliver_after_days, pack);
    results.push({ account, score, incomplete: failing.has(id), ...r });
  }

  // Code critic (plan 8f) before the cut, so a dropped account frees its slot for the next one
  const criticDropped: Record<string, number> = {};
  const eligibleIds = results.filter((r) => r.score.eligible).map((r) => r.account.id);
  const site = new Map<string, { title?: string; tools?: string[]; partnerBadge?: boolean }>();
  const dnsTools = new Map<string, string[]>();
  for (const part of chunk(eligibleIds, 500)) {
    const snaps = await db.execute(sql`
      select distinct on (account_id, kind) account_id, kind, extracted from ${snapshots}
      where ${inArray(snapshots.accountId, part)} and kind in ('site', 'dns')
      order by account_id, kind, taken_at desc`);
    for (const r of snaps.rows as { account_id: string; kind: string; extracted: { title?: string; tools?: string[]; partnerBadge?: boolean } | null }[]) {
      if (r.kind === "site") site.set(r.account_id, r.extracted ?? {});
      else dnsTools.set(r.account_id, r.extracted?.tools ?? []);
    }
  }
  // YC companies whose latest facts fail the hard filters (discovery records the verdict per YC entry, weekly)
  const ycFail = new Map<string, string>();
  const eligibleDomains = results.filter((r) => r.score.eligible).map((r) => r.account.domain);
  for (const part of chunk(eligibleDomains, 500)) {
    const rows = await db.execute(sql`select domain, bool_or(fit_pass) as ok, min(reason) as reason from ${companySeeds}
      where source = 'yc' and ${inArray(companySeeds.domain, part)} group by domain`);
    for (const r of rows.rows as { domain: string; ok: boolean; reason: string | null }[]) if (!r.ok) ycFail.set(r.domain, r.reason ?? "fails the hard filters");
  }
  const verdicts = new Map<string, CriticVerdict>();
  for (const r of results) {
    if (!r.score.eligible) continue;
    const sf = site.get(r.account.id);
    const v = critic({ name: r.account.name, domain: r.account.domain, siteTitle: sf?.title, partnerBadge: sf?.partnerBadge, tools: [...(sf?.tools ?? []), ...(dnsTools.get(r.account.id) ?? [])],
      sizeBand: r.account.sizeBand, segment: r.account.segment, ycFitFailed: ycFail.get(r.account.domain) ?? null, evidence: r.score.evidence }, pack);
    verdicts.set(r.account.id, v);
    if (!v.pass) for (const f of v.failed) criticDropped[f.check] = (criticDropped[f.check] ?? 0) + 1;
  }
  // the floor can differ per region group (delivery.digest.region_groups[].min_score); opts.minScore overrides all
  const floorOf = (r: { account: ScoredAccount }) => opts.minScore ?? minScoreFor(pack, r.account.region, r.account.segment);
  const criticPassed = results.filter((r) => verdicts.get(r.account.id)?.pass !== false);
  // score threshold: below it never reaches the email or Sheet (the next lead above it takes the slot)
  const passed = criticPassed.filter((r) => !r.score.eligible || displayScore(r.score) >= floorOf(r));
  const belowMinScore = criticPassed.length - passed.length;
  // below the floor only because size or segment is unknown: worth a company-facts lookup (the digest fills them and
  // re-scores). Without this, facts were looked up only for accounts already over the floor, so unknown facts kept
  // an account under it forever. Closest to the floor first, so the per-run lookup budget goes where it can matter.
  const factsCandidates = criticPassed
    .filter((r) => r.score.eligible && !(r.recentlyDelivered && !r.newSinceDelivery) && displayScore(r.score) < floorOf(r) && (!r.account.sizeBand || !r.account.segment)
      && bestCaseDisplayScore(r.score, pack.signals.score) >= floorOf(r))
    .sort((a, b) => b.score.intent - a.score.intent)
    .map((r) => r.account.id);

  // a role_gap would complete a play here (e.g. just raised + nobody in the GTM seat): check who holds the seats
  const gapPlays = Object.fromEntries(Object.entries(pack.plays.plays).filter(([, p]) => p.requires.includes("role_gap") || p.requires_any.includes("role_gap")));
  const probe = { type: "role_gap", class: "implicit", ageDays: 0, current: true, quote: "", url: "", ref: { kind: "signal" as const, id: "probe" } };
  const gapCandidates = Object.keys(gapPlays).length ? results
    .filter((r) => !(r.recentlyDelivered && !r.newSinceDelivery) && !r.score.evidence.some((e) => e.type === "role_gap")
      && !icpRecheck({ domain: r.account.domain, sizeBand: r.account.sizeBand, segment: r.account.segment, ycFitFailed: null }, pack)
      && matchPlays([...r.score.evidence, probe], gapPlays).length > 0)
    .sort((a, b) => b.score.intent - a.score.intent)
    .map((r) => r.account.id) : [];

  const rankOpts = { reserveNonHiring: pack.delivery.digest.reserved_non_hiring, freshDays: pack.signals.eligibility.fresh_days, segmentOf: (a: ScoredAccount) => a.segment };
  const groups = pack.delivery.digest.region_groups;
  const ranking = groups.length
    ? rankByRegionGroups(passed, groups, (a) => a.region, opts.poolScale ?? 1, 5, rankOpts)
    : rankAccounts(passed, opts.maxLeads ?? leadCap(pack), 5, rankOpts);

  // Person leads: no account, ranked on the post alone (plan 8a): strength x timing
  const pl = await db.select({
    platform: personLeads.platform, handle: personLeads.handle, type: signals.type, quote: signals.evidenceQuote, url: signals.evidenceUrl,
    strength: signals.strength, observedAt: signals.observedAt,
  }).from(personLeads).innerJoin(signals, eq(personLeads.signalId, signals.id))
    .where(and(sql`${personLeads.mappedAccountId} is null`, sql`${signals.observedAt} > ${new Date(now.getTime() - 30 * DAY)}`));
  // shown whatever regions_any says: a person lead has no account region, and the web search that finds them is already
  // scoped by country (sources.web_search.countries). Hiding them all under a region filter hid the strongest intent.
  const personRanked = pl.map((p) => ({ ...p, score: (p.strength / 5) * timingScore((now.getTime() - p.observedAt.getTime()) / DAY) }))
    .sort((a, b) => b.score - a.score).slice(0, 5)
    .map(({ observedAt: _o, ...rest }) => rest);

  let playsCount = 0;
  if (opts.write !== false) {
    for (const part of chunk(results, 400)) {
      await db.insert(scores).values(part.map((r) => ({
        accountId: r.account.id, configVersion: version, intentP: r.score.intent, fit: r.score.fit, timing: r.score.timing,
        priority: r.score.priority, lane: r.score.lane, createdAt: now,
      })));
    }
    const playRows = results.flatMap((r) => r.score.plays.map((p) => ({
      accountId: r.account.id, playId: p.id, evidenceSignalIds: [] as string[], matchedAt: now, lastMatchedAt: now,
      evidence: p.evidence.map((e) => ({ kind: e.ref.kind, id: e.ref.id, type: e.type, quote: e.quote, url: e.url })),
    })));
    for (const part of chunk(playRows, 300)) {
      await db.insert(playsMatched).values(part).onConflictDoUpdate({
        target: [playsMatched.accountId, playsMatched.playId],
        set: { lastMatchedAt: now, evidence: sql`excluded.evidence` }, // matched_at keeps the first time it fired
      });
    }
    playsCount = playRows.length;
  }

  return {
    configVersion: version, scored: results.length, eligible: results.filter((r) => r.score.eligible).length,
    ranking, personLeads: personRanked, playsMatched: playsCount, criticDropped, belowMinScore, factsCandidates, gapCandidates,
    criticFailed: Object.fromEntries([...verdicts].filter(([, v]) => !v.pass).map(([id, v]) => [id, v.failed.map((f) => f.check)])), all: results.map((r) => ({ account: r.account, score: r.score })),
  };
}
