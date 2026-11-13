import type { Pack } from "@tell/config";
import { fetchYcCompanyProfile, fetchHomepage, fetchTxtRecords, extractSiteFacts } from "@tell/watchers";
import { compileTools, toolsFromTxt, diffSite, diffDnsTools, stackSprawl, toolOverlap, leakyCapture, agencyCredited, eventsFromYcProfile, type SiteState, type WatchEvent } from "@tell/intel";
import { getDb, accounts, jobBoards, snapshots, signals, and, eq, inArray, sql } from "@tell/db";
import { applyPackIdentity } from "./scheduled.js";
import { saveYcFounders } from "./contacts.js";

/**
 * Weekly account watch (plan 5b/5c): non-hiring signals for every tracked account.
 *  - YC page: founders (people), funding headlines, launches (dated facts)
 *  - homepage: sales-led CTA, pricing page, GTM tools in scripts (diffed against the last snapshot)
 *  - DNS TXT: GTM tools from SPF includes / verification tokens (diffed)
 * First snapshot per account and kind = baseline (state only). Snapshots are stored only when they change.
 */

export interface WatchResult {
  accounts: number;
  ycPages: number;
  sites: number;
  dns: number;
  baselines: { site: number; dns: number };
  signals: Record<string, number>;
  peopleSaved: number;
  failures: { yc: number; site: number; dns: number };
}

type Acc = { id: string; domain: string; ycSlug: string | null };

const chunk = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

export async function runAccountWatch(opts: { pack: Pack; limit?: number; now?: Date }): Promise<WatchResult> {
  const { pack } = opts;
  applyPackIdentity(pack);
  const now = opts.now ?? new Date();
  const db = getDb();
  const rules = compileTools(pack.tools);
  const specs = pack.signals.signals;
  const res: WatchResult = { accounts: 0, ycPages: 0, sites: 0, dns: 0, baselines: { site: 0, dns: 0 }, signals: {}, peopleSaved: 0, failures: { yc: 0, site: 0, dns: 0 } };

  // tracked accounts: those with an active job board (YC slug when there is one)
  const rows = await db.select({ id: accounts.id, domain: accounts.domain, source: jobBoards.source, slug: jobBoards.slug })
    .from(accounts).innerJoin(jobBoards, eq(jobBoards.accountId, accounts.id))
    .where(and(eq(accounts.status, "active"), eq(jobBoards.status, "active")));
  const byId = new Map<string, Acc>();
  for (const r of rows) {
    const a = byId.get(r.id) ?? { id: r.id, domain: r.domain, ycSlug: null };
    if (r.source === "yc") a.ycSlug = r.slug;
    byId.set(r.id, a);
  }
  const list = [...byId.values()].slice(0, opts.limit ?? Infinity);
  res.accounts = list.length;

  // latest snapshot per account and kind
  const latest = new Map<string, unknown>();
  for (const part of chunk(list.map((a) => a.id), 500)) {
    const snaps = await db.execute(sql`
      select distinct on (account_id, kind) account_id, kind, extracted from ${snapshots}
      where ${inArray(snapshots.accountId, part)} and kind in ('site', 'dns')
      order by account_id, kind, taken_at desc`);
    for (const s of snaps.rows as { account_id: string; kind: string; extracted: unknown }[]) latest.set(`${s.account_id}:${s.kind}`, s.extracted);
  }

  const emit = async (accountId: string, all: WatchEvent[]) => {
    const events = all.filter((e) => specs[e.type]); // a type the pack doesn't define is not emitted
    if (!events.length) return;
    const inserted = await db.insert(signals).values(events.map((e) => ({
      accountId, class: specs[e.type]!.class, type: e.type, strength: specs[e.type]!.strength,
      evidenceQuote: e.quote.slice(0, 500), evidenceUrl: e.url, observedAt: e.observedAt, halfLifeDays: specs[e.type]!.half_life_days,
    }))).onConflictDoNothing({ target: [signals.evidenceUrl, signals.type] }).returning({ type: signals.type });
    for (const s of inserted) res.signals[s.type] = (res.signals[s.type] ?? 0) + 1;
  };
  // compare the fields that matter (Postgres jsonb reorders keys, so whole-object text comparison always differs)
  const sameSite = (a: SiteState, b: SiteState) =>
    a.salesLed === b.salesLed && a.selfServe === b.selfServe && a.pricing === b.pricing && [...a.tools].sort().join() === [...b.tools].sort().join();
  const sameTools = (a: string[], b: string[]) => [...a].sort().join() === [...b].sort().join();

  // Lane 1: YC pages (one host, one at a time via politeGet)
  const ycLane = async () => {
    for (const a of list) {
      if (!a.ycSlug) continue;
      try {
        const prof = await fetchYcCompanyProfile(a.ycSlug);
        res.ycPages++;
        res.peopleSaved += await saveYcFounders(a.id, prof);
        await emit(a.id, eventsFromYcProfile(prof, now));
      } catch { res.failures.yc++; }
    }
  };

  // Lane 2: homepages + DNS (different hosts: a small worker pool)
  const siteLane = async () => {
    const queue = [...list];
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (queue.length) {
        const a = queue.shift()!;
        const events: WatchEvent[] = [];
        let siteTools: string[] = [];
        let dnsTools: string[] = [];
        let site: SiteState | null = null;

        const page = await fetchHomepage(a.domain);
        if (page) {
          res.sites++;
          const f = extractSiteFacts(page.html, rules.tools);
          const cur: SiteState = { salesLed: f.salesLed, selfServe: f.selfServe, pricing: f.pricing, tools: f.tools, ctas: f.ctas, leakyForms: f.leakyForms, partnerBadge: f.partnerBadge, agencyCredit: f.agencyCredit };
          site = cur;
          const prev = latest.get(`${a.id}:site`) as SiteState | undefined;
          if (!prev) res.baselines.site++;
          events.push(...diffSite(a.domain, prev ?? null, cur, rules, now));
          if (!prev || !sameSite(prev, cur)) {
            await db.insert(snapshots).values({ accountId: a.id, kind: "site", extracted: cur, takenAt: now });
          }
          siteTools = cur.tools;
        } else res.failures.site++;

        const txt = await fetchTxtRecords(a.domain);
        if (txt) {
          res.dns++;
          const cur = toolsFromTxt(txt, rules);
          const prev = latest.get(`${a.id}:dns`) as { tools: string[] } | undefined;
          if (!prev) res.baselines.dns++;
          events.push(...diffDnsTools(a.domain, prev?.tools ?? null, cur, rules, now));
          if (!prev || !sameTools(prev.tools, cur)) await db.insert(snapshots).values({ accountId: a.id, kind: "dns", extracted: { tools: cur }, takenAt: now });
          dnsTools = cur;
        } else res.failures.dns++;

        const sprawl = stackSprawl(a.domain, [...siteTools, ...dnsTools], rules, now);
        if (sprawl) events.push(sprawl);
        const overlap = toolOverlap(a.domain, [...siteTools, ...dnsTools], rules, now);
        if (overlap) events.push(overlap);
        if (site) {
          const leak = leakyCapture(a.domain, site.leakyForms ?? [], [...siteTools, ...dnsTools], rules, now);
          if (leak) events.push(leak);
          const agency = agencyCredited(a.domain, site.agencyCredit, now);
          if (agency) events.push(agency);
        }
        await emit(a.id, events);
      }
    }));
  };

  await Promise.all([ycLane(), siteLane()]);
  return res;
}
