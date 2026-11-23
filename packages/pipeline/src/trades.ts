import { createHash } from "node:crypto";
import { inScope, type Pack, type OpportunityDef, type Roster } from "@tell/config";
import { stageRank, type EventCheck, type EventNeed } from "@tell/extract";
import { getDb, needTrades, sql } from "@tell/db";

/**
 * Trades: any business that benefits from a signal, not only the rosters in the pack. Every verified need (a fact-checked
 * event, stage at least min_stage, place in the working regions, still ahead) that no in-scope roster covers names a
 * trade: the kind of company that sells it, in the place the work is ("beverage filling line maker", India). A trade
 * becomes a roster + opportunity at run time (`withTrades`): its company search is run (Exa, inside search_per_day,
 * again every trades.refresh_days), its results resolve to accounts like any roster's, and the events whose needs name
 * it are matched to them, gated, proven on their own sites and delivered like every other lead. The same need worded
 * differently ("pharmaceutical process equipment manufacturer" / "pharma process equipment maker") is one trade.
 */

const FILLER = new Set(["a", "an", "the", "and", "or", "of", "for", "in", "to", "with", "india", "indian", "company", "companies", "firm", "firms", "maker", "makers",
  "manufacturer", "manufacturers", "manufacturing", "supplier", "suppliers", "provider", "providers", "vendor", "vendors", "service", "services", "solution", "solutions",
  "specialist", "specialists", "agency", "agencies", "business", "businesses"]);
const SAME: Record<string, string> = { pharmaceutical: "pharma", pharmaceuticals: "pharma", equipments: "equipment", machines: "machinery", machine: "machinery", logistic: "logistics", transportation: "transport" };

/** The supplier kind, normalised so wording doesn't split one trade (pure): filler words go, words are singular and sorted. */
export function normSupplier(s: string): string {
  const words = s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean)
    .map((w) => SAME[w] ?? w).filter((w) => !FILLER.has(w))
    .map((w) => (w.length > 4 && w.endsWith("ies") ? `${w.slice(0, -3)}y` : w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w)).map((w) => SAME[w] ?? w).filter((w) => !FILLER.has(w));
  return [...new Set(words)].sort().join(" ");
}

/** A need's trade id, in the place the work is (pure). Empty supplier words = no trade. */
export function tradeId(n: Pick<EventNeed, "supplier" | "industry">, where: string): string | null {
  const k = normSupplier(n.supplier);
  if (!k) return null;
  return `trade:${createHash("sha1").update(`${n.industry}|${where}|${k}`).digest("hex").slice(0, 12)}`;
}

/** The supplier kind as a search phrase (pure): a trailing place in brackets goes, "none" / "n/a" is no supplier. */
export const cleanSupplier = (s: string) => {
  const t = s.replace(/\s*\([^)]*\)\s*$/, "").replace(/\s+/g, " ").trim();
  return /^(none|n\/?a|unknown|other|not applicable|-)?$/i.test(t) ? "" : t;
};

export interface TradeRow { id: string; supplier: string; industry: string; region: string; what: string; lastSeenAt: Date }

/** The trades today's verified needs name (pure; exported for tests): one per trade id, needs a roster in scope already
 *  covers (the check named it, and it serves that place) left to that roster. */
export function tradesFrom(checks: { check: EventCheck; eventRegion: string | null }[], pack: Pack): Omit<TradeRow, "lastSeenAt">[] {
  const cfg = pack.opportunities, scope = pack.meta.regions, out = new Map<string, Omit<TradeRow, "lastSeenAt">>();
  for (const { check: c, eventRegion } of checks) {
    if (c.verdict !== "ok" || stageRank(c.stage) < stageRank(cfg.min_stage) || cfg.exclude_entity_industries.includes(c.entityIndustry)) continue;
    const where = c.where ?? eventRegion;
    if (!where || !inScope(scope, [where])) continue;
    for (const n of c.needs) {
      const named = n.group ? cfg.rosters[n.group] : undefined;
      if (named && named.kind !== "usaspending_awardees" && named.regions.includes(where)) continue; // that roster covers it
      const supplier = cleanSupplier(n.supplier);
      if (!supplier) continue;
      const id = tradeId({ ...n, supplier }, where);
      if (id && !out.has(id)) out.set(id, { id, supplier, industry: n.industry, region: where, what: n.what });
    }
  }
  return [...out.values()];
}

/** Record the trades (first seen / last seen; how many times needs named them). */
export async function upsertTrades(rows: Omit<TradeRow, "lastSeenAt">[], now: Date): Promise<number> {
  const db = getDb();
  for (const t of rows) {
    await db.insert(needTrades).values({ ...t, firstSeenAt: now, lastSeenAt: now })
      .onConflictDoUpdate({ target: needTrades.id, set: { lastSeenAt: now, what: t.what, events: sql`${needTrades.events} + 1` } });
  }
  return rows.length;
}

/** Trades still named within trades.max_age_days. */
export async function activeTrades(pack: Pack, now: Date): Promise<TradeRow[]> {
  const t = pack.opportunities.trades;
  if (!t.enabled) return [];
  const since = new Date(now.getTime() - t.max_age_days * 86_400_000);
  return (await getDb().select().from(needTrades).where(sql`${needTrades.lastSeenAt} >= ${since}`)).map((r) => ({ ...r, lastSeenAt: new Date(r.lastSeenAt) }));
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The pack with each trade as a company_search roster and a signals opportunity of the same id (pure; exported for
 *  tests). A trade whose industry the pack doesn't admit gets "auto": its companies are classified from their own
 *  description. Its opportunity collects nothing: its events arrive through their needs (crossEvents). */
export function withTrades(pack: Pack, trades: TradeRow[]): Pack {
  if (!trades.length) return pack;
  const cfg = pack.opportunities, industries = pack.icp.industries;
  const titles = new Set(pack.icp.personas.map((p) => p.title));
  const buyers = cfg.trades.buyers.filter((b) => titles.has(b));
  const rosters: Record<string, Roster> = { ...cfg.rosters }, opportunities: Record<string, OpportunityDef> = { ...cfg.opportunities };
  for (const t of trades) {
    if (rosters[t.id] || opportunities[t.id]) continue;
    const segment = industries[t.industry] && !industries[t.industry]!.excluded ? t.industry : "auto";
    const label = `${cap(t.supplier)} (${t.region})`;
    rosters[t.id] = { kind: "company_search", label, segment, regions: [t.region], queries: [`${t.supplier} in ${t.region}`],
      results_per_query: cfg.trades.results_per_query, refresh_days: cfg.trades.refresh_days, per_run: cfg.trades.per_run } as Roster;
    opportunities[t.id] = { kind: "signals", label, roster: t.id, buyers, angle: `The signal makes the company buy what they sell: ${t.what}.`, follow: "", refresh_days: 7,
      max_age_days: cfg.trades.max_age_days, beneficiary_regions: [], keywords: [], verify: true, types: [], entity_segments: [], entity_regions: [] } as OpportunityDef;
  }
  return { ...pack, opportunities: { ...cfg, rosters, opportunities } };
}

export const isTrade = (id: string) => id.startsWith("trade:");
