import { createHash } from "node:crypto";
import type { Pack } from "@tell/config";
import {
  buildEvidence, scoreAccount, rankAccounts, compileRoles, critic, type CriticVerdict, timing as timingScore,
  type JobRow, type SignalRow, type PersonRow, type AccountScore, type Ranking,
} from "@tell/intel";
import { getDb, accounts, jobBoards, jobs, signals, snapshots, people as peopleTable, scores, playsMatched, deliveries, personLeads, eq, and, inArray, sql } from "@tell/db";

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
  /** every scored account (for tuning and evals; not rendered) */
  all?: { account: ScoredAccount; score: AccountScore }[];
}

/** Pack name + content hash: every score row says which config produced it (calibration, champion/challenger later). */
export function configVersion(pack: Pack): string {
  const h = createHash("sha256").update(JSON.stringify(pack)).digest("hex").slice(0, 10);
  return `${pack.meta.name}@${h}`;
}

/** Daily scoring run (plan 8d). Writes scores + plays and returns the ranking for the digest. */
export async function runScoring(opts: { pack: Pack; now?: Date; maxLeads?: number; write?: boolean }): Promise<ScoreRunResult> {
  const { pack } = opts;
  const now = opts.now ?? new Date();
  const db = getDb();
  const roles = compileRoles(pack.roles);
  const version = configVersion(pack);

  // Load everything once (small: thousands of rows)
  const jobRows = await db.select({
    id: jobs.id, title: jobs.title, url: jobs.url, employmentType: jobs.employmentType, family: jobs.family,
    postedAt: jobs.postedAt, firstSeenAt: jobs.firstSeenAt, closedAt: jobs.closedAt, accountId: jobBoards.accountId,
  }).from(jobs).innerJoin(jobBoards, eq(jobs.boardId, jobBoards.id))
    .where(sql`${jobs.closedAt} is null or ${jobs.closedAt} > ${new Date(now.getTime() - 180 * DAY)}`);

  const sigRows = await db.select({
    id: signals.id, type: signals.type, evidenceQuote: signals.evidenceQuote, evidenceUrl: signals.evidenceUrl,
    observedAt: signals.observedAt, accountId: signals.accountId,
  }).from(signals).where(and(sql`${signals.accountId} is not null`, sql`${signals.observedAt} > ${new Date(now.getTime() - 180 * DAY)}`));

  const byAccount = new Map<string, { jobs: JobRow[]; signals: SignalRow[]; people: PersonRow[] }>();
  const slot = (id: string) => byAccount.get(id) ?? (byAccount.set(id, { jobs: [], signals: [], people: [] }), byAccount.get(id)!);
  for (const j of jobRows) slot(j.accountId).jobs.push(j);
  for (const s of sigRows) slot(s.accountId!).signals.push(s);
  // known people (for "has an ops owner"): attached only to accounts that already have evidence
  const known = await db.select({ id: peopleTable.id, a: peopleTable.accountId, role: peopleTable.role, url: peopleTable.sourceUrl, fetchedAt: peopleTable.fetchedAt }).from(peopleTable);
  for (const p of known) byAccount.get(p.a)?.people.push({ id: p.id, role: p.role, url: p.url, fetchedAt: p.fetchedAt });

  const ids = [...byAccount.keys()];
  const accts = new Map<string, ScoredAccount>();
  for (const part of chunk(ids, 500)) {
    const rows = await db.select({ id: accounts.id, domain: accounts.domain, name: accounts.name, sizeBand: accounts.sizeBand, region: accounts.region, segment: accounts.segment, status: accounts.status })
      .from(accounts).where(inArray(accounts.id, part));
    for (const r of rows) if (r.status === "active") accts.set(r.id, r);
  }

  // Evidence is incomplete when a board covering the account failed on its last check (plan 8d-2: outages are not evidence)
  const failing = new Set((await db.select({ a: jobBoards.accountId }).from(jobBoards)
    .where(and(eq(jobBoards.status, "active"), sql`${jobBoards.failCount} > 0`))).map((r) => r.a));

  const since = new Date(now.getTime() - pack.delivery.redeliver_after_days * DAY);
  const lastDelivery = new Map((await db.select({ a: deliveries.accountId, at: sql<Date>`max(${deliveries.deliveredAt})` }).from(deliveries)
    .where(and(sql`${deliveries.accountId} is not null`, sql`${deliveries.deliveredAt} > ${since}`)).groupBy(deliveries.accountId))
    .map((r) => [r.a!, new Date(r.at)]));
  const firstMatched = new Map((await db.select({ a: playsMatched.accountId, p: playsMatched.playId, at: playsMatched.matchedAt }).from(playsMatched))
    .map((r) => [`${r.a}:${r.p}`, r.at]));

  const results: { account: ScoredAccount; score: AccountScore; incomplete: boolean; recentlyDelivered: boolean; newPlaySinceDelivery: boolean }[] = [];
  for (const [id, data] of byAccount) {
    const account = accts.get(id);
    if (!account) continue;
    const score = scoreAccount(buildEvidence(data.jobs, data.signals, pack, roles, now, data.people), account, pack);
    const delivered = lastDelivery.get(id);
    const newPlay = !!delivered && score.plays.some((p) => { const t = firstMatched.get(`${id}:${p.id}`); return !t || t > delivered; });
    results.push({ account, score, incomplete: failing.has(id), recentlyDelivered: !!delivered, newPlaySinceDelivery: newPlay });
  }

  // Code critic (plan 8f) before the cut, so a dropped account frees its slot for the next one
  const criticDropped: Record<string, number> = {};
  const eligibleIds = results.filter((r) => r.score.eligible).map((r) => r.account.id);
  const site = new Map<string, { title?: string; tools?: string[] }>();
  const dnsTools = new Map<string, string[]>();
  for (const part of chunk(eligibleIds, 500)) {
    const snaps = await db.execute(sql`
      select distinct on (account_id, kind) account_id, kind, extracted from ${snapshots}
      where ${inArray(snapshots.accountId, part)} and kind in ('site', 'dns')
      order by account_id, kind, taken_at desc`);
    for (const r of snaps.rows as { account_id: string; kind: string; extracted: { title?: string; tools?: string[] } | null }[]) {
      if (r.kind === "site") site.set(r.account_id, r.extracted ?? {});
      else dnsTools.set(r.account_id, r.extracted?.tools ?? []);
    }
  }
  const verdicts = new Map<string, CriticVerdict>();
  for (const r of results) {
    if (!r.score.eligible) continue;
    const sf = site.get(r.account.id);
    const v = critic({ name: r.account.name, domain: r.account.domain, siteTitle: sf?.title, tools: [...(sf?.tools ?? []), ...(dnsTools.get(r.account.id) ?? [])], evidence: r.score.evidence }, pack);
    verdicts.set(r.account.id, v);
    if (!v.pass) for (const f of v.failed) criticDropped[f.check] = (criticDropped[f.check] ?? 0) + 1;
  }
  const passed = results.filter((r) => verdicts.get(r.account.id)?.pass !== false);

  const ranking = rankAccounts(passed, opts.maxLeads ?? pack.delivery.digest.max_leads, 5, {
    reserveNonHiring: pack.delivery.digest.reserved_non_hiring, freshDays: pack.signals.eligibility.fresh_days,
  });

  // Person leads: no account, ranked on the post alone (plan 8a): strength x timing
  const pl = await db.select({
    platform: personLeads.platform, handle: personLeads.handle, type: signals.type, quote: signals.evidenceQuote, url: signals.evidenceUrl,
    strength: signals.strength, observedAt: signals.observedAt,
  }).from(personLeads).innerJoin(signals, eq(personLeads.signalId, signals.id))
    .where(and(sql`${personLeads.mappedAccountId} is null`, sql`${signals.observedAt} > ${new Date(now.getTime() - 30 * DAY)}`));
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
    ranking, personLeads: personRanked, playsMatched: playsCount, criticDropped, all: results.map((r) => ({ account: r.account, score: r.score })),
  };
}
