import type { Pack } from "@tell/config";
import type { Research } from "@tell/extract";
import {
  fetchExpiringAwards, fetchNewAwards, fetchShortages, fetchAndaApprovals, fetchRecalls, searchTrials, serperNews, companyFromHeadline,
  type ExpiringAward, type NewAward, type Shortage, type AndaApproval, type Recall, type CompletedTrial, type NewsItem,
} from "@tell/watchers";
import { neonUsage, type UsageStore } from "./usage.js";
import type { ExampleRow } from "./buyer-signals.js";

/**
 * Live lookups for market plays (step 4): examples searched FOR this lead, with its own product words and places,
 * instead of whatever the database happens to hold. Each source maps to ExampleRow (accountId "live:<key>": these
 * companies are not accounts). Every lookup fails soft (returns []): a missing example drops the change, never the lead.
 */
type Change = Pack["modules"]["modules"][number]["changes"][number];
type Lead = { name: string; region: string | null };
const DAY = 86_400_000;

const fmtUsd = (n: number) => (n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n / 1e3)}K`);
const monthYear = (d: Date) => d.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const titleCase = (n: string) => (n === n.toUpperCase() ? n.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\b(Llc|Inc|Lp|Llp)\b/g, (m) => m.toUpperCase()) : n);
const shortDesc = (d: string) => { const t = d.toLowerCase().replace(/\s+/g, " ").trim(); return t.length <= 90 ? t : `${t.slice(0, 90).replace(/[\s,;:(]+\S*$/, "")}...`; };
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\b(inc|llc|ltd|limited|pvt|private|corp|corporation|co|company|the|usa|us)\b/g, " ").replace(/\s+/g, " ").trim();
/** the same company under its record's name ("NORTHWIND PHARMA INC" = "Northwind Pharma") */
export const sameCompany = (a: string, b: string) => { const x = norm(a), y = norm(b); return !!x && !!y && (x === y || x.startsWith(`${y} `) || y.startsWith(`${x} `)); };

/** Research keywords split into industry codes and words (pure; exported for tests). */
export function splitKeywords(r: Pick<Research, "keywords">): { naics: string | null; words: string[] } {
  const ks = r.keywords ?? [];
  const naics = ks.map((k) => k.match(/\b(\d{6}|\d{4}|\d{2})\b/)?.[1]).find(Boolean) ?? null;
  return { naics, words: ks.filter((k) => !/\d/.test(k)).slice(0, 4) };
}
/** US state codes among the places (["Arizona", "AZ"] -> ["AZ"]) */
export const stateCodes = (places: string[]) => places.filter((p) => /^[A-Z]{2}$/.test(p));
const anyWord = (text: string, words: string[]) => { const t = text.toLowerCase(); return words.some((w) => t.includes(w.toLowerCase())); };
const live = (key: string) => `live:${key}`;

// ------------------------------------------------------------------------------------------------ row builders (pure)

export function endingRows(aw: ExpiringAward[], lead: Lead, states: string[]): ExampleRow[] {
  return aw.filter((a) => !sameCompany(a.recipient, lead.name) && (!states.length || (a.state && states.includes(a.state)))).map((a) => ({
    accountId: live(`award:${a.awardId}`), company: titleCase(a.recipient), region: "United States of America", type: "contract_expiring", strength: 4, observedAt: new Date(),
    quote: `${titleCase(a.recipient)}'s ${fmtUsd(a.amount)} contract with the ${a.agency}${a.description ? ` for ${shortDesc(a.description)}` : ""} ends ${monthYear(a.endDate)}.`, url: a.url,
  }));
}
export function awardRows(aw: NewAward[], lead: Lead): ExampleRow[] {
  return aw.filter((a) => !sameCompany(a.recipient, lead.name)).map((a) => ({
    accountId: live(`award:${a.awardId}`), company: titleCase(a.recipient), region: "United States of America", type: "contract_won", strength: 4, observedAt: a.startDate ?? new Date(),
    quote: `${titleCase(a.recipient)} won a ${fmtUsd(a.amount)} contract from the ${a.agency}${a.description ? ` for ${shortDesc(a.description)}` : ""}${a.startDate ? `, starting ${monthYear(a.startDate)}` : ""}.`, url: a.url,
  }));
}
export function shortageRows(ss: Shortage[], words: string[]): ExampleRow[] {
  return ss.filter((s) => anyWord(`${s.name} ${s.substance}`, words)).map((s) => ({
    accountId: live(`shortage:${s.substance}`), company: "FDA shortage list", region: "United States of America", type: "drug_shortage", strength: 5, observedAt: s.updatedAt ?? new Date(),
    quote: `${s.name} is on the FDA drug shortage list (${s.availability.toLowerCase()}${s.reason ? `; ${s.reason.toLowerCase()}` : ""}).`, url: "https://www.accessdata.fda.gov/scripts/drugshortages/default.cfm",
  }));
}
export function approvalRows(as: AndaApproval[], words: string[], lead: Lead): ExampleRow[] {
  return as.filter((a) => anyWord(a.ingredient, words) && !sameCompany(a.sponsor, lead.name)).map((a) => ({
    accountId: live(`anda:${a.appNo}`), company: titleCase(a.sponsor), region: null, type: "anda_approved", strength: 4, observedAt: a.approvedAt,
    quote: `${titleCase(a.sponsor)} received FDA approval for ${a.ingredient.toLowerCase()}${a.form ? ` (${a.form.toLowerCase()})` : ""} on ${isoDay(a.approvedAt)} (ANDA ${a.appNo}).`, url: a.url,
  }));
}
export function recallRows(rs: Recall[], words: string[], lead: Lead): ExampleRow[] {
  return rs.filter((r) => anyWord(`${r.product} ${r.substances.join(" ")}`, words) && !sameCompany(r.firm, lead.name)).map((r) => ({
    accountId: live(`recall:${r.recallNumber}`), company: titleCase(r.firm), region: null, type: "competitor_recall", strength: 4, observedAt: r.reportedAt,
    quote: `${titleCase(r.firm)} recalled ${shortDesc(r.product)} (FDA ${r.classification}) on ${isoDay(r.reportedAt)}.`, url: r.url,
  }));
}
export function trialRows(ts: CompletedTrial[], lead: Lead): ExampleRow[] {
  return ts.filter((t) => !sameCompany(t.sponsor, lead.name)).map((t) => {
    const what = t.interventions.filter((i) => i.name && !/placebo/i.test(i.name)).map((i) => i.name).slice(0, 2).join(" and ");
    const done = t.completedAt <= new Date();
    return { accountId: live(`trial:${t.nctId}`), company: t.sponsor, region: t.countries.includes("India") ? "India" : t.countries.includes("United States") ? "United States of America" : null, type: "trial_completed", strength: 4, observedAt: t.completedAt,
      quote: `${t.sponsor} ${done ? "completed" : "is running"} a clinical trial${what ? ` of ${what}` : ""}: "${t.title.slice(0, 120)}" (${t.nctId}).`, url: t.url };
  });
}
/** market news verbs: the company is the words before one */
const MARKET_VERBS = /\s+(?:opens|launches|commissions|inaugurates|sets up|to set up|expands|invests|to invest|acquires|bags|wins|secures|signs|announces|plans|starts|unveils|adds|raises|files|gets|receives|breaks ground)\b/i;
export function newsRows(items: NewsItem[], lead: Lead, region: string | null): ExampleRow[] {
  return items.flatMap((i) => {
    // a headline whose company we can't name is no example (an outlet name is not a company in their market)
    const company = companyFromHeadline(i.title, MARKET_VERBS);
    if (!company || sameCompany(company, lead.name)) return [];
    return [{ accountId: live(`news:${i.url}`), company, region, type: "news", strength: 3, observedAt: i.postedAt ?? new Date(), quote: `${i.title}${i.outlet ? ` (${i.outlet})` : ""}`, url: i.url }];
  });
}
/** The news query from a change's template (pure; exported for tests): {keywords} = the first two words OR-ed, {place} =
 *  the first place that isn't a state code, {who} = their customers as the research names them. Null when the template needs words the research doesn't have. */
export function newsQuery(template: string, r: Pick<Research, "keywords" | "places"> & { who?: string }): string | null {
  const words = splitKeywords(r).words.slice(0, 2);
  const place = (r.places ?? []).find((p) => !/^[A-Z]{2}$/.test(p)) ?? "";
  if (template.includes("{keywords}") && !words.length) return null;
  if (template.includes("{who}") && !r.who) return null;
  return template.replaceAll("{who}", r.who ?? "").replaceAll("{keywords}", words.length > 1 ? `(${words.map((w) => `"${w}"`).join(" OR ")})` : `"${words[0] ?? ""}"`).replaceAll("{place}", place).replace(/\s+/g, " ").trim();
}

// ------------------------------------------------------------------------------------------------ lookups (I/O)

/** Sources that answer the same for every lead (the shortage list, recent approvals and recalls): fetched once per run. */
export interface LookupMemo { shortages?: Promise<Shortage[]>; approvals?: Promise<AndaApproval[]>; recalls?: Promise<Recall[]> }
const soft = async <T>(p: Promise<T[]>): Promise<T[]> => { try { return await p; } catch { return []; } };
const pause = () => new Promise((r) => setTimeout(r, 400));

export async function liveExamples(c: Change, r: Research, lead: Lead, pack: Pack, memo: LookupMemo, usage: UsageStore = neonUsage(), now = new Date()): Promise<ExampleRow[]> {
  const { naics, words } = splitKeywords(r);
  const states = stateCodes(r.places ?? []);
  switch (c.live) {
    case "contracts_ending": {
      if (!words.length && !naics) return [];
      const aw = await soft(fetchExpiringAwards({ naics, keywords: naics ? [] : words, setAsides: [], from: new Date(now.getTime() + 30 * DAY), to: new Date(now.getTime() + 365 * DAY), minAmount: 100_000, maxPages: 1, now }));
      await pause();
      return endingRows(aw, lead, states);
    }
    case "awards": {
      if (!words.length && !naics) return [];
      const aw = await soft(fetchNewAwards({ naics, keywords: naics ? [] : words, setAsides: [], since: new Date(now.getTime() - 60 * DAY), now, minAmount: 100_000, maxPages: 1 }));
      await pause();
      return awardRows(aw, lead);
    }
    case "fda_shortages":
      memo.shortages ??= soft(fetchShortages());
      return shortageRows(await memo.shortages, words);
    case "fda_approvals":
      memo.approvals ??= soft(fetchAndaApprovals(new Date(now.getTime() - 60 * DAY), now));
      return approvalRows(await memo.approvals, words, lead);
    case "fda_recalls":
      memo.recalls ??= Promise.all([soft(fetchRecalls("drug", new Date(now.getTime() - 60 * DAY), now)), soft(fetchRecalls("device", new Date(now.getTime() - 60 * DAY), now))]).then(([a, b]) => [...a, ...b]);
      return recallRows(await memo.recalls, words, lead);
    case "trials":
      return trialRows(await soft(searchTrials(words, new Date(now.getTime() - 120 * DAY))), lead);
    case "news": {
      const key = process.env.SERPER_API_KEY;
      const q = c.news ? newsQuery(c.news, r) : null;
      const cap = pack.sources.niche.market_news_per_day;
      if (!key || !q || !cap || (await usage.spentToday("serper_market")) >= cap) return [];
      await usage.addSpend("serper_market", 1, cap);
      const india = lead.region === "India";
      return newsRows(await soft(serperNews({ apiKey: key, country: india ? "in" : "us", timeRange: "m" })(q)), lead, lead.region);
    }
    default:
      return [];
  }
}

/** Live rows cached on the account (accounts.buyers.live) are reused for this long. */
export const LIVE_CACHE_DAYS = 7;
export const liveFresh = (at: string | undefined, now = new Date()) => !!at && now.getTime() - new Date(at).getTime() < LIVE_CACHE_DAYS * DAY;
