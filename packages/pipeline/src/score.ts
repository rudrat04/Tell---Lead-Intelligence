import { createHash } from "node:crypto";
import { leadCap, minScoreFor, type Pack } from "@tell/config";
import {
  buildEvidence, scoreAccount, rankAccounts, rankByRegionGroups, compileRoles, critic, redelivery, regionInScope, type CriticVerdict, displayScore, bestCaseDisplayScore, type DeliveryHistory, timing as timingScore, matchPlays, icpRecheck,
  type JobRow, type SignalRow, type PersonRow, type AccountScore, type Ranking,
} from "@tell/intel";
import { getDb, accounts, jobBoards, jobs, signals, snapshots, people as peopleTable, scores, playsMatched, deliveries, labels, personLeads, companySeeds, builtPlays, eq, and, inArray, sql } from "@tell/db";
import { applyExploration, type Evidence, type PlayMatch, type LearnedFit, type RankInput as RI } from "@tell/intel";
import { regionGroupFor } from "@tell/config";
import { judgeSystem, playBuilderSystem } from "@tell/extract";

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
  /** pool accounts with no matching play whose play is still to be built from their evidence (plays.build) */
  playCandidates: { account: ScoredAccount; score: AccountScore; evidenceKey: string }[];
  /** judged mode: gate-passing accounts with no judgement for their current evidence, freshest first (wider than the pool) */
  judgeCandidates: { account: ScoredAccount; score: AccountScore; evidenceKey: string }[];
  /** judged mode: learned fit inputs (labelled leads overall), for the health line */
  learnedLabels?: number;
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
/** requireJudged (judged mode, set by the digest once the judge has worked today): accounts not judged yet can't be
 *  leads, so legacy and judged scores never compete in one list; they're judged on a later run. */
export async function runScoring(opts: { pack: Pack; now?: Date; maxLeads?: number; poolScale?: number; write?: boolean; minScore?: number; requireJudged?: boolean }): Promise<ScoreRunResult> {
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

  // plays built from evidence (plays.build), keyed by account + evidence: rebuilt only when the evidence changes
  const built = new Map<string, StoredPlay | null>();
  const evidenceKeys = new Map<string, string>();
  const judgedMode = pack.signals.score.mode === "judged";
  const playVer = playVersion(pack);
  if (pack.plays.build?.enabled || judgedMode) {
    for (const part of chunk([...accts.keys()], 500)) {
      for (const r of await db.select().from(builtPlays).where(inArray(builtPlays.accountId, part))) built.set(`${r.accountId}:${r.evidenceKey}`, (r.play as StoredPlay | null) ?? null);
    }
  }
  const learned = judgedMode ? await loadLearned(pack) : null;
  const results: { account: ScoredAccount; score: AccountScore; incomplete: boolean; recentlyDelivered: boolean; newSinceDelivery: boolean; backReason?: string }[] = [];
  for (const [id, data] of byAccount) {
    const account = accts.get(id);
    if (!account) continue;
    const ev = buildEvidence(data.jobs, data.signals, pack, roles, now, data.people);
    // the key carries the prompt / catalog / industries version: editing any of them re-judges (re-builds) the play
    const key = `${evidenceKey(ev)}:${playVer}`;
    const b = built.get(`${id}:${key}`);
    const stored = b === undefined ? undefined : b && (!judgedMode || b.rubric) ? playFromStored(b, ev) : null;
    const score = scoreAccount(ev, account, pack, stored, judgedMode && stored ? learnedFor(learned, account.segment, stored.id) : undefined);
    evidenceKeys.set(id, key);
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
  const overFloor = criticPassed.filter((r) => !r.score.eligible || displayScore(r.score) >= floorOf(r));
  const belowMinScore = criticPassed.length - overFloor.length;
  const passed = overFloor.filter((r) => !(opts.requireJudged && r.score.needsJudge));
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
      && matchPlays([...r.score.evidence, probe], gapPlays, r.account.segment).length > 0)
    .sort((a, b) => b.score.intent - a.score.intent)
    .map((r) => r.account.id) : [];

  const rankOpts = { reserveNonHiring: pack.delivery.digest.reserved_non_hiring, freshDays: pack.signals.eligibility.fresh_days, segmentOf: (a: ScoredAccount) => a.segment };
  const groups = pack.delivery.digest.region_groups;
  let ranking = groups.length
    ? rankByRegionGroups(passed, groups, (a) => a.region, opts.poolScale ?? 1, 5, rankOpts)
    : rankAccounts(passed, opts.maxLeads ?? leadCap(pack), 5, rankOpts);
  // judged mode: exploration slots for industries with too few labelled leads (only once there's data to compare to)
  if (judgedMode && learned) ranking = exploreFor(ranking, passed, pack, learned, opts.poolScale ?? 1);

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
    playCandidates: [...ranking.leads, ...ranking.watchlist].filter((l) => l.score.needsPlay).map((l) => ({ account: l.account, score: l.score, evidenceKey: evidenceKeys.get(l.account.id)! })),
    // wider than the pool: every gate-passing account not judged yet, freshest evidence first, so the old weights
    // decide only the order of judging, not who gets a chance
    judgeCandidates: criticPassed.filter((r) => r.score.needsJudge && !(r.recentlyDelivered && !r.newSinceDelivery))
      .sort((a, b) => Math.min(...a.score.drivers.map((e) => e.ageDays), 999) - Math.min(...b.score.drivers.map((e) => e.ageDays), 999) || b.score.priority - a.score.priority)
      .map((r) => ({ account: r.account, score: r.score, evidenceKey: evidenceKeys.get(r.account.id)! })),
    ...(learned ? { learnedLabels: learned.total } : {}),
    criticFailed: Object.fromEntries([...verdicts].filter(([, v]) => !v.pass).map(([id, v]) => [id, v.failed.map((f) => f.check)])), all: results.map((r) => ({ account: r.account, score: r.score })),
  };
}

/** A built play as stored (built_plays.play): the evidence it cites by type + URL. */
export interface StoredPlay { title: string; need: string; angle: string; offer: string; personas: string[]; cited: { type: string; url: string }[];
  /** judged mode */ rubric?: { specific: number; urgent: number; prize: number; deliverable: number }; free?: string; paid?: string[] }

/** The account's positive evidence, as a stable key: a built play is reused until this changes. */
export function evidenceKey(ev: Evidence[]): string {
  const items = ev.filter((e) => e.class !== "negative").map((e) => `${e.type}|${e.url}`).sort();
  return createHash("sha256").update(items.join("\n")).digest("hex").slice(0, 24);
}

export function playFromStored(p: StoredPlay, ev: Evidence[]): PlayMatch {
  const cited = ev.filter((e) => p.cited.some((c) => c.type === e.type && c.url === e.url));
  const evidence = cited.length ? cited : ev.slice(0, 1);
  // judged plays are bucketed by the signal they stand on (for learned fit and the plays report); built ones by title
  const id = p.rubric ? `judged:${evidence[0]?.type ?? "x"}` : `built:${p.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}`;
  return { id, title: p.title, angle: `${p.need} ${p.angle}`, offer: p.offer, personas: p.personas, qualifies: true, evidence, ...(p.rubric ? { rubric: p.rubric, free: p.free } : {}) };
}

/** The judge / builder prompt version: a changed prompt, catalog or industry file means a new judgement. */
export function playVersion(pack: Pack): string {
  const src = pack.signals.score.mode === "judged" ? judgeSystem(pack) : playBuilderSystem(pack);
  return createHash("sha256").update(src + JSON.stringify(pack.icp.industries)).digest("hex").slice(0, 8);
}

/** Labelled outcomes by industry and play bucket: positive = 👍 or replied / meeting / won; counted = any label or outcome. */
export interface LearnedStats { total: number; positive: number; bySegment: Map<string, { pos: number; n: number }>; byPlay: Map<string, { pos: number; n: number }>; minBucket: number; shrink: number }

export async function loadLearned(pack: Pack): Promise<LearnedStats> {
  const rows = (await getDb().execute(sql`
    select coalesce(a.segment, '?') as seg,
      coalesce(case when pm.play_id like 'built:%' then 'built' else pm.play_id end, 'none') as play,
      count(distinct d.id) filter (where l.label = 'good' or l.outcome in ('replied','meeting','won'))::int as pos,
      count(distinct d.id) filter (where l.label is not null or l.outcome is not null)::int as n
    from ${deliveries} d join ${accounts} a on a.id = d.account_id
    left join ${labels} l on l.delivery_id = d.id
    left join ${playsMatched} pm on pm.account_id = d.account_id and pm.matched_at <= d.delivered_at + interval '1 day'
    group by 1, 2`)).rows as { seg: string; play: string; pos: number; n: number }[];
  const add = (m: Map<string, { pos: number; n: number }>, k: string, r: { pos: number; n: number }) => { const c = m.get(k) ?? { pos: 0, n: 0 }; c.pos += r.pos; c.n += r.n; m.set(k, c); };
  const bySegment = new Map<string, { pos: number; n: number }>(), byPlay = new Map<string, { pos: number; n: number }>();
  for (const r of rows) { add(bySegment, r.seg, r); add(byPlay, r.play, r); }
  const total = [...bySegment.values()].reduce((n, x) => n + x.n, 0), positive = [...bySegment.values()].reduce((n, x) => n + x.pos, 0);
  const j = pack.signals.score.judge;
  return { total, positive, bySegment, byPlay, minBucket: j.min_bucket, shrink: j.shrink };
}

/**
 * Learned fit for a lead (pure; exported for tests): each bucket's positive rate, shrunk toward the overall rate and
 * counted only with min_bucket labelled leads; level = 0.5 at the overall rate, 1 at twice it. Neutral without data.
 */
export function learnedFor(st: LearnedStats | null, segment: string | null, playId: string): LearnedFit {
  if (!st || st.total < st.minBucket * 2 || st.positive === 0) return { level: 0.5, rate: null, n: 0 };
  const p0 = st.positive / st.total;
  const rate = (b?: { pos: number; n: number }) => (b && b.n >= st.minBucket ? (b.pos + st.shrink * p0) / (b.n + st.shrink) : null);
  const seg = rate(st.bySegment.get(segment ?? "?")), play = rate(st.byPlay.get(playId));
  const known = [seg, play].filter((x): x is number => x != null);
  const n = (st.bySegment.get(segment ?? "?")?.n ?? 0) + (st.byPlay.get(playId)?.n ?? 0);
  if (!known.length) return { level: 0.5, rate: null, n };
  const p = known.reduce((a, b) => a + b, 0) / known.length;
  return { level: Math.max(0, Math.min(1, 0.5 * (p / p0))), rate: p, n };
}

function exploreFor(ranking: Ranking<ScoredAccount>, candidates: RI<ScoredAccount>[], pack: Pack, st: LearnedStats, scale: number): Ranking<ScoredAccount> {
  if (st.total < st.minBucket * 2) return ranking; // nothing to compare against yet: every industry is untested
  const groups = pack.delivery.digest.region_groups;
  return applyExploration(ranking, candidates, {
    share: pack.signals.score.judge.explore_share,
    underTested: (r) => !!r.score.judged && (st.bySegment.get(r.account.segment ?? "?")?.n ?? 0) < st.minBucket,
    groupOf: (r) => regionGroupFor(pack, r.account.region, r.account.segment)?.name ?? "",
    capOf: (g) => (groups.find((x) => x.name === g)?.max_leads ?? leadCap(pack)) * scale,
  });
}
