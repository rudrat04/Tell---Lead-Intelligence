import { createHash } from "node:crypto";
import type { Pack } from "@tell/config";
import { researchCompany, type Research, type LlmClient } from "@tell/extract";
import { getDb, accounts, eq, sql } from "@tell/db";
import { liveExamples, liveFresh, type LookupMemo } from "./market-lookups.js";

/**
 * Steps 2-5 of the pitch, for one lead:
 *   research  what they sell, who pays them, which module and changes fit (Haiku, once per account, accounts.buyers)
 *   play      2-3 changes in THEIR market, each with live examples from the database (customers, competitors,
 *             channel or market companies with a fresh signal); a change with no live example is dropped, never padded
 *   brief     a one-page intelligence brief written by code from those facts (Sheet "Brief"), offered in the email
 */
const DAY = 86_400_000;
const PROFILE_DAYS = 120;
export const SAMPLE_DAYS = 60;
const PER_CHANGE = 2;

export interface ExampleRow { accountId: string; company: string; region: string | null; type: string; quote: string; url: string; observedAt: Date; strength: number }
export interface PlayChange { id: string; title: string; whose: string; why: string; action: string; examples: ExampleRow[] }
export interface MarketPlay { module: string; moduleTitle: string; offer: string; research: Research; changes: PlayChange[] }

/** modules + industries in the cache key: editing modules.yaml re-researches */
export const researchVersion = (pack: Pack) => createHash("sha256").update(JSON.stringify([pack.modules.modules, Object.keys(pack.icp.industries)])).digest("hex").slice(0, 8);

/** Best rows (pure; exported for tests): one per company, companies already used elsewhere skipped, same region first,
 *  then strongest, then newest. */
export function pickExamples(rows: ExampleRow[], region: string | null, n: number, used = new Set<string>()): ExampleRow[] {
  const key = (r: ExampleRow) => [r.region === region ? 1 : 0, r.strength, r.observedAt.getTime()];
  const better = (a: ExampleRow, b: ExampleRow) => { const x = key(a), y = key(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i]! > y[i]!; return false; };
  const best = new Map<string, ExampleRow>();
  // live rows aren't accounts: two articles about one company are one example
  const id = (r: ExampleRow) => (r.accountId.startsWith("live:") ? `live:${r.company.toLowerCase()}` : r.accountId);
  for (const r of rows) { if (used.has(r.accountId) || used.has(id(r))) continue; const p = best.get(id(r)); if (!p || better(r, p)) best.set(id(r), r); }
  return [...best.values()].sort((a, b) => (better(a, b) ? -1 : better(b, a) ? 1 : 0)).slice(0, n);
}

/** Whether a quote is in one of their places (pure; exported for tests): whole words, case-insensitive, except two-letter
 *  state codes, which must be capitals ("IN" is Indiana, "in" is a word). No places = anywhere. */
/** places that records name another way: city records say "Manhattan", not "New York City" */
const PLACE_ALIASES: Record<string, string[]> = {
  "new york city": ["manhattan", "brooklyn", "queens", "bronx", "staten island", "nyc"], "new york": ["manhattan", "brooklyn", "queens", "bronx", "staten island", "nyc"],
  bengaluru: ["bangalore"], bangalore: ["bengaluru"], mumbai: ["bombay", "navi mumbai", "thane"], gurugram: ["gurgaon"], gurgaon: ["gurugram"],
  delhi: ["new delhi", "ncr", "noida", "gurugram", "gurgaon"], "new delhi": ["delhi", "ncr"], chennai: ["madras"], kolkata: ["calcutta"],
  "washington, dc": ["washington", "district of columbia"], "district of columbia": ["washington, dc", "washington d.c."],
};
export function inPlaces(quote: string, places: string[]): boolean {
  if (!places.length) return true;
  const all = [...places, ...places.flatMap((p) => PLACE_ALIASES[p.toLowerCase()] ?? [])];
  return all.some((p) => {
    const esc = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return /^[A-Z]{2}$/.test(p) ? new RegExp(`(^|[^A-Za-z])${esc}($|[^A-Za-z])`).test(quote) : new RegExp(`(^|[^a-z])${esc.toLowerCase()}($|[^a-z])`).test(quote.toLowerCase());
  });
}

/** Whether a quote is about what they sell (pure; exported for tests): one of their product words or codes, whole word.
 *  No keywords = nothing can be shown for product-specific changes. */
export function aboutTheirProducts(quote: string, keywords: string[]): boolean {
  const q = quote.toLowerCase();
  return keywords.some((k) => new RegExp(`(^|[^a-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`).test(q));
}

/** Where a change's companies are (pure; exported for tests): competitors = the lead's own industry; customers = the
 *  module's industries that the research also names, else the research's, else the module's; channel / market = the module's. */
export function changeIndustries(c: { whose: string; industries: string[] }, r: Research, leadSegment: string | null): string[] {
  if (c.whose === "competitors") return leadSegment ? [leadSegment] : [];
  if (c.whose === "customers") { const both = c.industries.filter((x) => r.customers.includes(x)); return both.length ? both : r.customers.length ? r.customers : c.industries; }
  return c.industries;
}

/** The research for an account: stored (same version, under PROFILE_DAYS), else worked out now and stored. */
export async function researchFor(account: { id: string; name: string | null; domain: string; segment: string | null; description?: string | null }, trigger: string | undefined, pack: Pack, llm: LlmClient | null, write = true): Promise<Research | null> {
  if (!pack.modules.modules.length) return null;
  const db = getDb();
  const ver = researchVersion(pack);
  const [row] = await db.select({ buyers: accounts.buyers, description: accounts.description }).from(accounts).where(eq(accounts.id, account.id)).limit(1);
  const stored = row?.buyers as (Research & { at?: string; v?: string }) | null | undefined;
  if (stored?.module && stored.v === ver && stored.at && Date.now() - new Date(stored.at).getTime() < PROFILE_DAYS * DAY) return stored;
  const description = account.description ?? row?.description;
  if (!description || !llm) return null;
  const r = await researchCompany(llm, pack, { name: account.name ?? account.domain, domain: account.domain, description, segment: account.segment, ...(trigger ? { trigger } : {}) }).catch(() => null);
  if (r && write) await db.update(accounts).set({ buyers: { ...r, at: new Date().toISOString(), v: ver } }).where(eq(accounts.id, account.id));
  return r;
}

/** The play: each chosen change with live examples (the lead excluded; competitors in its region only). Null when fewer
 *  than two changes have an example. */
export async function marketPlay(r: Research, lead: { id: string; name?: string | null; region: string | null; segment: string | null }, pack: Pack, memo: LookupMemo = {}): Promise<MarketPlay | null> {
  const mod = pack.modules.modules.find((m) => m.id === r.module);
  if (!mod) return null;
  const db = getDb();
  const since = new Date(Date.now() - SAMPLE_DAYS * DAY);
  const used = new Set<string>();
  const changes: PlayChange[] = [];
  // live rows found for this lead before (accounts.buyers.live), reused for LIVE_CACHE_DAYS
  const [acc] = await db.select({ buyers: accounts.buyers }).from(accounts).where(eq(accounts.id, lead.id)).limit(1);
  const cached = (acc?.buyers as { live?: { at?: string; rows?: Record<string, (Omit<ExampleRow, "observedAt"> & { observedAt: string })[]> } } | null)?.live;
  const fresh = liveFresh(cached?.at) ? cached?.rows ?? {} : {};
  const found: Record<string, ExampleRow[]> = {};
  for (const id of r.changes) {
    const c = mod.changes.find((x) => x.id === id);
    if (!c) continue;
    const must = c.must ? new RegExp(c.must, "i") : null;
    if (c.live !== "db") {
      // searched for this lead with its own product words: places (for news) and required words still apply
      const rows = fresh[c.id]?.map((x) => ({ ...x, observedAt: new Date(x.observedAt) }))
        ?? await liveExamples(c, r, { name: lead.name ?? "", region: lead.region }, pack, memo);
      found[c.id] = rows;
      const ok = rows.filter((x) => (c.live !== "news" || inPlaces(x.quote, r.places ?? [])) && (!must || must.test(x.quote)));
      const ex = pickExamples(ok, lead.region, PER_CHANGE, used);
      if (!ex.length) continue;
      ex.forEach((e) => { used.add(e.accountId); used.add(`live:${e.company.toLowerCase()}`); });
      changes.push({ id: c.id, title: c.title, whose: c.whose, why: r.why[c.id] ?? c.why, action: c.action, examples: ex });
      continue;
    }
    const inds = changeIndustries(c, r, lead.segment);
    if (!inds.length) continue;
    const rows = (await db.execute(sql`
      select s.account_id, a.name, a.domain, a.region, s.type, s.evidence_quote, s.evidence_url, s.observed_at, s.strength
      from signals s join accounts a on a.id = s.account_id
      where a.status = 'active' and a.id <> ${lead.id} and a.segment in (${sql.join(inds.map((x) => sql`${x}`), sql`, `)})
        and s.type in (${sql.join(c.signals.map((x) => sql`${x}`), sql`, `)}) and s.observed_at > ${since}
        ${c.whose === "competitors" && lead.region ? sql`and a.region = ${lead.region}` : sql``}
      order by s.strength desc, s.observed_at desc limit 200`)).rows as { account_id: string; name: string | null; domain: string; region: string | null; type: string; evidence_quote: string; evidence_url: string; observed_at: string; strength: number }[];
    // a local business sees its own places only (a road builder in Arizona gets nothing from a Manhattan permit)
    // market, channel and competitor examples must be about what they sell (a food maker's recompetes are food
    // contracts, not IT ones); customers' expansions are judged by the customer industries alone
    const productual = c.whose !== "customers";
    let ex = pickExamples(rows.filter((x) => inPlaces(x.evidence_quote, r.places ?? []) && (!productual || aboutTheirProducts(x.evidence_quote, r.keywords ?? [])) && (!must || must.test(x.evidence_quote))).map((x) => ({ accountId: x.account_id, company: x.name ?? x.domain, region: x.region, type: x.type, quote: x.evidence_quote, url: x.evidence_url, observedAt: new Date(x.observed_at), strength: x.strength })), lead.region, PER_CHANGE, used);
    // nothing collected in their places (no permit feed for Ohio): the change's news search, when it has one
    if (!ex.length && c.news) {
      const rows2 = fresh[c.id]?.map((x) => ({ ...x, observedAt: new Date(x.observedAt) })) ?? await liveExamples({ ...c, live: "news" }, r, { name: lead.name ?? "", region: lead.region }, pack, memo);
      found[c.id] = rows2;
      ex = pickExamples(rows2.filter((x) => inPlaces(x.quote, r.places ?? []) && (!must || must.test(x.quote))), lead.region, PER_CHANGE, used);
    }
    if (!ex.length) continue;
    ex.forEach((e) => { used.add(e.accountId); used.add(`live:${e.company.toLowerCase()}`); });
    changes.push({ id: c.id, title: c.title, whose: c.whose, why: r.why[c.id] ?? c.why, action: c.action, examples: ex });
  }
  if (Object.keys(found).length) {
    const buyers = (acc?.buyers ?? {}) as Record<string, unknown>;
    await db.update(accounts).set({ buyers: { ...buyers, live: { at: liveFresh(cached?.at) ? cached!.at : new Date().toISOString(), rows: { ...fresh, ...found } } } }).where(eq(accounts.id, lead.id)).catch(() => undefined);
  }
  // two changes, or one strong change with two companies behind it
  return changes.length >= 2 || (changes.length === 1 && changes[0]!.examples.length >= 2) ? { module: mod.id, moduleTitle: mod.title, offer: mod.offer, research: r, changes } : null;
}

/** Evidence items for the draft: one per example, labelled with its change (pure; exported for tests). */
export function playEvidence(p: MarketPlay): { type: string; ageDays: number; current: boolean; quote: string; url: string }[] {
  const now = Date.now();
  return p.changes.flatMap((c) => c.examples.map((e) => ({ type: "market_change", ageDays: Math.round((now - e.observedAt.getTime()) / DAY), current: false, quote: `${c.title}. ${e.company}: ${e.quote}`, url: e.url })));
}

/** The one-page brief, written by code from the facts (pure; exported for tests). Plain text for the Sheet. */
export function briefText(p: MarketPlay, lead: { company: string; trigger?: { quote: string; url: string } }, date: string): string {
  const L: string[] = [`Intelligence brief for ${lead.company} · ${date}`, ""];
  if (lead.trigger) L.push(`What happened: ${lead.trigger.quote} (${lead.trigger.url})`, "");
  L.push(`Your business: ${p.research.sells}, for ${p.research.who}${p.research.channel ? `, ${p.research.channel}` : ""}.`, "");
  L.push(p.changes.length === 1 ? "One change in your market worth acting on:" : `${p.changes.length} changes in your market worth acting on:`);
  p.changes.forEach((c, i) => {
    L.push("", `${i + 1}. ${c.title}`, `Why it matters: ${c.why}`);
    // "Contoso is the owner on..." already names the company: no "Contoso: Contoso is..."
    for (const e of c.examples) L.push(`- ${e.quote.toLowerCase().startsWith(e.company.toLowerCase()) ? e.quote : `${e.company}: ${e.quote}`} (${e.url})`);
    L.push(`What your team can do: ${c.action}`);
  });
  L.push("", `How this keeps working: ${p.offer}`);
  return L.join("\n");
}
