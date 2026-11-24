import { toRegex, type Pack, type OpportunityDef, type Roster } from "@tell/config";
import { readArticle } from "@tell/watchers";
import { HaikuClient, checkEvent, stageRank, needFor, EVENT_CHECK_VERSION, type EventCheck, type EventNeed, type LlmClient, type Stage, type IndustryRef } from "@tell/extract";
import { getDb, eventChecks, inArray, and, eq } from "@tell/db";
import { neonUsage, type UsageStore } from "./usage.js";
import { tradeId, isTrade } from "./trades.js";

/**
 * The fact-check of each news / signal event (extract/event-check.ts), done once per URL and cached in event_checks:
 * the article is read (robots.txt respected; records and blocked outlets are checked on their stored quote), Haiku says
 * what happened, the stage, where, and what the event company must buy from others, and code keeps only what the
 * quotes prove. Checks are made lazily, only for the events of ranked candidates, strongest first, inside
 * EVENT_CHECKS_PER_RUN (40) and EVENT_DAILY_CAP_USD (0.05, usage_daily "haiku_event").
 */

export interface EventCheckDeps {
  llm?: LlmClient | null;
  read?: (url: string) => Promise<{ text: string } | null>;
  usage?: UsageStore;
}
export interface EventToCheck { url: string; quote: string; entityName: string; entityAbout?: string | null }

/** supplier groups a need can name: the rosters of companies that sell things (company search, imports) */
export const groupsOf = (pack: Pack): IndustryRef[] => Object.entries(pack.opportunities.rosters).filter(([, r]) => r.kind !== "usaspending_awardees").map(([id, r]) => ({ id, label: r.label }));
export const industriesOf = (pack: Pack): IndustryRef[] => Object.entries(pack.icp.industries).filter(([, v]) => !v.excluded).map(([id, v]) => ({ id, label: v.label }));

const fromRow = (r: typeof eventChecks.$inferSelect): EventCheck => ({
  verdict: r.verdict as EventCheck["verdict"], happened: r.happened ?? "", quote: r.quote, entitySells: r.entitySells ?? "", entityIndustry: r.entityIndustry ?? "other",
  where: r.where, stage: (r.stage as Stage | null) ?? null, stageQuote: r.stageQuote, needs: (r.needs as EventNeed[]) ?? [], reason: r.reason ?? "", source: r.source as EventCheck["source"],
});

/** Checks for these events (cached ones from the table, the rest made now, in the order given, inside the caps). */
export async function eventChecksFor(evs: EventToCheck[], pack: Pack, opts: { now: Date; write: boolean; deps?: EventCheckDeps }): Promise<{ checks: Map<string, EventCheck>; made: number; failed: number }> {
  const db = getDb(), usage = opts.deps?.usage ?? neonUsage();
  const urls = [...new Set(evs.map((e) => e.url))];
  const checks = new Map<string, EventCheck>();
  for (let i = 0; i < urls.length; i += 500) for (const r of await db.select().from(eventChecks).where(and(inArray(eventChecks.url, urls.slice(i, i + 500)), eq(eventChecks.version, EVENT_CHECK_VERSION)))) checks.set(r.url, fromRow(r));
  const cap = Number(process.env.EVENT_DAILY_CAP_USD ?? 0.05), perRun = Number(process.env.EVENT_CHECKS_PER_RUN ?? 40);
  let llm: (LlmClient & { spent?: number }) | null | undefined = opts.deps?.llm;
  if (llm === undefined) {
    const left = cap - (await usage.spentToday("haiku_event"));
    llm = process.env.ANTHROPIC_API_KEY && left > 0.001 ? new HaikuClient({ capUsd: left }) : null;
  }
  const read = opts.deps?.read ?? ((u: string) => readArticle(u));
  const industries = industriesOf(pack), groups = groupsOf(pack);
  let made = 0, failed = 0, inRow = 0, lastError: string | null = null;
  const seen = new Set<string>();
  for (const e of evs) {
    if (checks.has(e.url) || seen.has(e.url)) continue;
    seen.add(e.url);
    if (!llm || made >= perRun) break;
    const article = await read(e.url).catch(() => null);
    made++;
    const before = llm.spent ?? 0;
    const c = await checkEvent(llm, { headline: e.quote, entity: e.entityName, entityAbout: e.entityAbout ?? null, article: article?.text ?? null, industries, groups })
      .catch((err: Error) => { lastError = err.message.slice(0, 200); return null; });
    if (llm.spent != null) await usage.addSpend("haiku_event", llm.spent - before, cap);
    // one bad article doesn't stop the run; three failures in a row (cap, outage) do, and the rest wait
    if (!c) { failed++; if (++inRow >= 3) break; continue; }
    inRow = 0;
    checks.set(e.url, c);
    // facts, not deliveries: kept on dry runs too, so a dry run doesn't pay for the same check twice
    if (opts.write) await db.insert(eventChecks).values({ url: e.url, verdict: c.verdict, stage: c.stage, where: c.where, entityIndustry: c.entityIndustry, entitySells: c.entitySells || null,
      happened: c.happened || null, quote: c.quote, stageQuote: c.stageQuote, needs: c.needs, source: c.source, reason: c.reason || null, version: EVENT_CHECK_VERSION, checkedAt: opts.now })
      .onConflictDoUpdate({ target: eventChecks.url, set: { verdict: c.verdict, stage: c.stage, where: c.where, entityIndustry: c.entityIndustry, entitySells: c.entitySells || null, happened: c.happened || null,
        quote: c.quote, stageQuote: c.stageQuote, needs: c.needs, source: c.source, reason: c.reason || null, version: EVENT_CHECK_VERSION, checkedAt: opts.now } });
  }
  if (lastError && process.env.TELL_DEBUG_EVENTS) console.error(`event check failed: ${lastError}`);
  return { checks, made, failed };
}

export type GateResult = { ok: true; need: EventNeed; stage: Stage } | { ok: false; why: "unchecked" | "unclear" | "no-need" | "early" | "no-place" | "elsewhere" | "peer" | "not-their-trade" | "excluded-industry" };

/**
 * Does this verified event make a lead for a company in this supplier group (pure; exported for tests)?
 * - the check stands (quotes found) and names something the company must buy from others;
 * - the stage is at least the opportunity's min_stage (land and plans are early; approvals, funding, orders are
 *   committed; open tenders and hiring drives are buying);
 * - the work is where the beneficiary is (or the opportunity names where beneficiaries may be: exports);
 * - the event company is not itself what this group sells (an EPC contractor winning an order is a competitor of
 *   EPC contractors, never their lead);
 * - one of its needs is this group's trade (its industry, and its `must` / keywords when it has them).
 */
export function gateEvent(c: EventCheck | undefined, op: Exclude<OpportunityDef, { kind: "usaspending_expiring" }>, roster: Roster, beneficiaryRegion: string | null, minStage: Stage, eventRegion: string | null = null, rosterId?: string, excluded?: string[]): GateResult {
  if (!c) return { ok: false, why: "unchecked" };
  if (c.verdict === "unclear") return { ok: false, why: "unclear" };
  if (c.verdict !== "ok" || !c.needs.length || !c.stage) return { ok: false, why: "no-need" };
  if (excluded?.includes(c.entityIndustry)) return { ok: false, why: "excluded-industry" };
  if (stageRank(c.stage) < stageRank(op.min_stage ?? minStage)) return { ok: false, why: "early" };
  // the place the text names wins (an Indian company's order in Chile is work in Chile); silent text = where the event
  // was found (the news search's country, the signalling company's region)
  const where = c.where ?? eventRegion;
  if (!op.beneficiary_regions.length && !where) return { ok: false, why: "no-place" };
  const allowed = op.beneficiary_regions.length ? op.beneficiary_regions : [where!];
  if (!beneficiaryRegion || !allowed.includes(beneficiaryRegion)) return { ok: false, why: "elsewhere" };
  const must = "must" in roster && roster.must ? toRegex(roster.must) : null;
  const segment = "segment" in roster ? roster.segment : "";
  // the event company is the kind of company this group lists: a peer
  if (must && c.entitySells && must.test(c.entitySells) && c.entityIndustry === segment) return { ok: false, why: "peer" };
  // a trade (a need's own supplier search) serves exactly the needs that named it
  const need = rosterId && isTrade(rosterId) ? c.needs.find((n) => tradeId(n, where ?? beneficiaryRegion ?? "") === rosterId) ?? null
    : needFor(c.needs, { ...(rosterId ? { id: rosterId } : {}), segment, must, keywords: op.keywords });
  return need ? { ok: true, need, stage: c.stage } : { ok: false, why: "not-their-trade" };
}
