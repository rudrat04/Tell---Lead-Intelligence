import { toRegex, type Pack } from "@tell/config";
import { exaPeopleSearch, brandfetchSearch, serperOrganic, prospeoFind, type PeopleSearch } from "@tell/watchers";
import { pickSignalPeople, signalContactQuery, fullEntityName, topicWords, entityKey, worksAt, type SignalPerson } from "@tell/intel";
import { getDb, signalContacts, inArray, eq } from "@tell/db";
import { findSureEmail, isSureEmail, type WaterfallDeps } from "./email-apis.js";
import { neonUsage, type UsageStore } from "./usage.js";

const DAY = 86_400_000;
const USAGE = "exa_signal_contacts";

export interface SignalContactDeps { search?: PeopleSearch | null; usage?: UsageStore; llm?: (LlmClient & { spent?: number }) | null }
const OWNERS_USAGE = "haiku_owners";

/**
 * Who to reach at the company behind each lead's signal (news / signal / jobs events; a federal recompete's buyer is
 * the agency): one people search per company name, shared by every business that can act on that signal, cached in
 * `signal_contacts` for `opportunities.signal_contacts.refresh_days` (an empty answer is cached too), at most `per_run`
 * new searches a run and a day (usage_daily "exa_signal_contacts"). Mutates the leads (`signalContacts`). Written on
 * dry runs too (facts, not deliveries), like the event checks. Returns counts only.
 */
import { HaikuClient, signalOwners, type LlmClient, type OwnerInput, type SignalOwners } from "@tell/extract";
type Ev = { entityName: string; quote?: string; need?: { what: string }; factQuote?: string | null; happened?: string; stageQuote?: string | null; entitySells?: string };
export async function attachSignalContacts<L extends { opportunity: { kind: string }; events: Ev[]; signalContacts?: SignalPerson[]; signalEntity?: string; signalOwner?: SignalOwners | null }>(
  leads: L[], pack: Pack, opts: { now?: Date; deps?: SignalContactDeps } = {},
): Promise<{ companies: number; searched: number; found: number; skipped?: string }> {
  const cfg = pack.opportunities.signal_contacts, now = opts.now ?? new Date();
  if (!cfg.enabled) return { companies: 0, searched: 0, found: 0, skipped: "off" };
  const want = new Map<string, { name: string; full: string; topic: string | null; words: string[]; owner: OwnerInput }>();
  for (const l of leads) {
    const e = l.events[0];
    if (l.opportunity.kind === "usaspending_expiring" || !e?.entityName) continue;
    const k = entityKey(e.entityName);
    // a headline acronym is searched by the full name the article gives; titles may name what it does ("Renewable Energy")
    if (k.length >= 3 && !want.has(k)) want.set(k, { name: e.entityName, full: fullEntityName(e.entityName, [e.factQuote, e.happened, e.stageQuote, e.quote]),
      topic: e.need?.what ?? null, words: topicWords(e.need?.what, e.entitySells),
      owner: { company: e.entityName, happened: e.happened || e.quote || "", need: e.need?.what ?? null, sells: e.entitySells ?? null, text: [e.factQuote, e.stageQuote].filter(Boolean).join(" ") } });
  }
  if (!want.size) return { companies: 0, searched: 0, found: 0 };
  const db = getDb();
  const found = new Map<string, SignalPerson[]>(), owners = new Map<string, SignalOwners | null>();
  for (const r of await db.select().from(signalContacts).where(inArray(signalContacts.entityKey, [...want.keys()]))) {
    if (now.getTime() - r.searchedAt.getTime() < cfg.refresh_days * DAY) { found.set(r.entityKey, (r.people as SignalPerson[]) ?? []); owners.set(r.entityKey, (r.owner as SignalOwners | null) ?? null); }
  }
  // who owns the purchase there (department, titles, place): Haiku, inside OWNERS_DAILY_CAP_USD
  const cap = Number(process.env.OWNERS_DAILY_CAP_USD ?? 0.02);
  let llm = opts.deps?.llm;
  if (llm === undefined) { const left = cap - (await (opts.deps?.usage ?? neonUsage()).spentToday(OWNERS_USAGE)); llm = process.env.ANTHROPIC_API_KEY && left > 0.001 ? new HaikuClient({ capUsd: left }) : null; }
  const search = opts.deps?.search === undefined ? (process.env.EXA_API_KEY ? exaPeopleSearch() : null) : opts.deps.search;
  const usage = opts.deps?.usage ?? neonUsage();
  const rx = cfg.patterns.map(toRegex);
  let searched = 0;
  if (search) {
    for (const [k, w] of want) {
      if (found.has(k)) continue;
      if (searched >= cfg.per_run || (await usage.spentToday(USAGE)) >= cfg.per_run) break;
      await usage.addSpend(USAGE, 1, cfg.per_run);
      searched++;
      let owner: SignalOwners | null = null;
      if (llm) {
        const before = llm.spent ?? 0;
        owner = await signalOwners(llm, { ...w.owner, company: w.full }).catch(() => null);
        if (llm.spent != null) await usage.addSpend(OWNERS_USAGE, llm.spent - before, cap);
      }
      let people: SignalPerson[];
      try { people = pickSignalPeople(await search.search(signalContactQuery(w.full, owner?.titles ?? cfg.titles, owner ? null : w.topic, owner?.location), 15), [w.name, w.full], rx, 3, w.words, owner?.titles ?? []); }
      catch { continue; } // search down or out of credit: not cached, tried again next run
      found.set(k, people); owners.set(k, owner);
      await db.insert(signalContacts).values({ entityKey: k, entityName: w.name, people, owner, searchedAt: now })
        .onConflictDoUpdate({ target: signalContacts.entityKey, set: { entityName: w.name, people, owner, searchedAt: now } });
    }
  }
  let n = 0;
  for (const l of leads) {
    const e = l.events[0];
    const k = e?.entityName && l.opportunity.kind !== "usaspending_expiring" ? entityKey(e.entityName) : null;
    const ps = k ? found.get(k) : undefined;
    if (ps?.length) { l.signalContacts = ps; l.signalEntity = want.get(k!)?.full ?? e!.entityName; l.signalOwner = owners.get(k!) ?? null; n++; }
  }
  return { companies: want.size, searched, found: n, ...(search ? {} : { skipped: "EXA_API_KEY not set" }) };
}

// ------------------------------------------------------------------------------------------------ emails on a click

/** Hosts that are never a company's own website (directories, social, news, registries). */
const NOT_A_SITE = /(^|\.)(linkedin|facebook|twitter|x|instagram|youtube|wikipedia|wikidata|crunchbase|zaubacorp|tofler|justdial|indiamart|tradeindia|glassdoor|ambitionbox|naukri|indeed|bloomberg|reuters|economictimes|moneycontrol|business-standard|thehindubusinessline|google|bing|mca|gov)\.[a-z.]+$/i;
/** Does a site belong to the signal's company? Its domain must carry the company's name: the full name compacted or its
 *  initials ("cvvn.co.in" for "Contoso Vidyut Vyapar Nigam"). A matching page title alone is not enough (directories
 *  and data vendors title their pages with the company's name), and the acronym is only ever taken from the FULL name,
 *  so a short headline name never picks another organisation that uses the same letters (pure; exported for tests). */
export function siteOf(hit: { name: string; url: string }, names: string[]): string | null {
  const host = hit.url.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "");
  if (!host.includes(".") || NOT_A_SITE.test(host)) return null;
  const label = host.split(".")[0]!;
  const keys = names.flatMap((n) => { const ws = n.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 0 && !/^(ltd|limited|pvt|private|the|of|and|india)$/.test(w));
    return ws.length >= 2 ? [ws.join(""), ws.map((w) => w[0]).join("")] : ws; }).filter((k) => k.length >= 3);
  return keys.includes(label) ? host : null;
}

export interface SignalEmailDeps { waterfall?: WaterfallDeps; brandfetch?: typeof brandfetchSearch; organic?: (q: string) => Promise<{ name: string; url: string }[]>; prospeo?: typeof prospeoFind }

/** The signal company's own website: Brandfetch (free) by its full name and its headline name, then Google results
 *  (Serper, Tavily when it fails); null when none clearly belongs to it. Never guessed. */
export async function signalDomain(name: string, full: string, deps: SignalEmailDeps = {}): Promise<string | null> {
  // an acronym is never searched or matched alone (another organisation may use the same letters): only its full name
  const acronymOnly = /^[A-Z][A-Z0-9&]{1,7}$/.test(name.trim()) && full === name;
  if (acronymOnly) return null;
  const names = /^[A-Z][A-Z0-9&]{1,7}$/.test(name.trim()) ? [full] : [...new Set([full, name])];
  for (const n of names) {
    const hits = await (deps.brandfetch ?? brandfetchSearch)(n).catch(() => []);
    for (const h of hits) { const d = siteOf(h, names); if (d) return d; }
  }
  const key = process.env.SERPER_API_KEY;
  const organic = deps.organic ?? (key ? (q: string) => serperOrganic(key, q, "in") : null);
  // the headline's short name next to the full name finds the company's own site best ("CVVN Contoso Vidyut Vyapar Nigam")
  const queries = [...new Set([name !== full ? `${name} ${full}` : null, `${full} official website`].filter((q): q is string => !!q))];
  if (organic) for (const q of queries) for (const h of await organic(q).catch(() => [])) { const d = siteOf(h, names); if (d) return d; }
  return null;
}

/**
 * Find-email click for the people at a signal's company (the `es:` button / the Sheet's "Signal-side email" link):
 * its website first (signalDomain, or the one Prospeo gives for a person's LinkedIn profile), then each person through
 * Tell's own waterfall (findSureEmail). Only sure addresses are kept; they are saved in `signal_contacts` so every lead
 * on that signal shows them. Returns the people with their answers (email null = no verified address).
 */
export async function enrichSignalPeople(e: { entity: string; full: string; people: SignalPerson[] }, deps: SignalEmailDeps = {}): Promise<{ domain: string | null; people: SignalPerson[] }> {
  const entity = { name: e.entity, full: e.full, people: e.people };
  const db = getDb(), k = entityKey(entity.name);
  const [row] = await db.select().from(signalContacts).where(eq(signalContacts.entityKey, k));
  // the stored people may know more (an email found from another lead's click)
  const stored = ((row?.people as SignalPerson[] | undefined) ?? []);
  const people = entity.people.map((p) => ({ ...p, ...(stored.find((s) => s.name === p.name) ?? {}) }));
  let domain = people.find((p) => p.domain)?.domain ?? await signalDomain(entity.name, entity.full, deps);
  for (const p of people) {
    if (p.email) continue;
    if (!domain && p.linkedin && !/^[A-Z][A-Z0-9&]{1,7}$/.test(entity.full.trim())) {
      // no website yet: Prospeo by the person's LinkedIn profile gives their verified email and the company's site
      const f = await (deps.prospeo ?? prospeoFind)("", "", "", undefined, { linkedin: p.linkedin }).catch(() => null);
      if (f?.domain && siteOf({ name: "", url: f.domain }, [entity.full])) domain = f.domain;
      if (f?.verified && domain && f.address.endsWith(`@${domain}`)) { p.email = { address: f.address, status: "verified", note: "found by Prospeo (verified)" }; continue; }
    }
    if (!domain) continue;
    const r = await findSureEmail({ name: p.name, domain, linkedin: p.linkedin }, deps.waterfall ?? {});
    p.email = r.email && isSureEmail(r.email) ? { address: r.email.address, status: r.email.status as "verified" | "observed", note: r.email.note } : null;
  }
  for (const p of people) p.domain = domain;
  if (row) await db.update(signalContacts).set({ people }).where(eq(signalContacts.entityKey, k));
  return { domain, people };
}
