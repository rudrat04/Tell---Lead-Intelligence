import type { Pack } from "@tell/config";
import { registrableDomain } from "@tell/people";
import { exaCompanySearch, diffbotOrganizations, type CompanyHit } from "@tell/watchers";
import { HaikuClient, type LlmClient } from "@tell/extract";
import { getDb, accounts, peopleSearches, and, eq, inArray, sql } from "@tell/db";
import { neonUsage, type UsageStore } from "./usage.js";

/**
 * Company size, segment and what the company does (description) for pool accounts missing any of them: one Exa company
 * search per account (name + domain), accepted only when the result's website is the account's own domain, or its
 * LinkedIn company page address is the domain's name and the company name agrees (never a name alone).
 *   size:    headcount -> the pack's size band; under team_size.min or over the last band gets a band the pack doesn't
 *            have ("under 5", "201+"), so the critic's ICP check drops it
 *   segment: Haiku picks one of pack icp.segment_descriptions from the company's description
 *   description: the record's own description, cut to a sentence or two (`profileLine`), for the judge, drafts and Sheet
 * Checked once per CHECK_DAYS (people_searches, provider "exa", persona "company:facts": counts in the Exa usage guard),
 * capped per run.
 */
const CHECK_DAYS = 90;
const DAY = 86_400_000;
// "company:profile" since Nov 21 2026 (description added): accounts checked under the old key get one more lookup
const PERSONA = "company:profile";
const PROFILE_MAX = 240;

/** A company description cut to whole sentences within PROFILE_MAX characters (pure; exported for tests). */
export function profileLine(description: string): string {
  const t = description.replace(/\s+/g, " ").trim();
  if (t.length <= PROFILE_MAX) return t;
  const cut = t.slice(0, PROFILE_MAX);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return end > 60 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(" "))}…`;
}

/** Headcount -> size band label (pure; exported for tests). */
export function bandForHeadcount(n: number, icp: Pack["icp"]): string {
  if (n < icp.hard_filters.team_size.min) return `under ${icp.hard_filters.team_size.min}`;
  const band = icp.size_bands.find((b) => n <= b.max);
  return band ? band.band : `${icp.size_bands[icp.size_bands.length - 1]!.max + 1}+`;
}

const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
/**
 * The company record for this domain, if any (pure; exported for tests): its website is the domain, or it is a
 * LinkedIn company page whose address is the domain's name (linkedin.com/company/trackier for trackier.com) AND whose
 * company name matches that name or the account's. Two independent matches, never a name alone.
 */
export function companyFor(domain: string, hits: CompanyHit[], accountName?: string | null): CompanyHit | null {
  const own = hits.find((h) => registrableDomain(h.url) === domain);
  if (own) return own;
  const label = norm(domain.split(".")[0]!);
  return hits.find((h) => {
    const slug = h.url.match(/linkedin\.com\/company\/([^/?#]+)/i)?.[1];
    if (!slug || norm(slug) !== label) return false;
    const n = norm(h.name);
    return n === label || (!!accountName && n === norm(accountName));
  }) ?? null;
}

/** Segment prompt from the pack; the answer must be one of the keys. Exported for tests. */
export function segmentPrompt(pack: Pack): string {
  const d = pack.icp.segment_descriptions;
  return `You classify a company into exactly one segment from its own description.\nSegments:\n${Object.entries(d).map(([k, v]) => `- ${k}: ${v}`).join("\n")}\nAnswer with the segment name only.`;
}
export function parseSegment(text: string, pack: Pack): string | null {
  const t = text.trim().toLowerCase().replace(/[^a-z0-9_ -]/g, "");
  return Object.keys(pack.icp.segment_descriptions).find((k) => t === k.toLowerCase() || t.startsWith(`${k.toLowerCase()} `)) ?? null;
}

export async function fillCompanyFacts(
  accountIds: string[], pack: Pack,
  opts: { write?: boolean; max?: number; search?: (domain: string) => Promise<CompanyHit[]>; llm?: LlmClient | null; usage?: UsageStore; dailyCapUsd?: number } = {},
): Promise<{ looked: number; sized: number; segmented: number; described: number; changed: string[]; skipped?: string }> {
  const res = { looked: 0, sized: 0, segmented: 0, described: 0, changed: [] as string[] };
  if (!accountIds.length) return res;
  const search = opts.search ?? (process.env.EXA_API_KEY ? (d: string) => exaCompanySearch(d) : null);
  // Diffbot by the company's own domain first (one organisation, 25 credits, within DIFFBOT_FACTS_PER_DAY, usage_daily "diffbot_facts"): size, country and
  // description in one answer; Exa only when Diffbot has nothing
  const byDomain = opts.search ? null : process.env.DIFFBOT_TOKEN ? (d: string) => diffbotOrganizations({ domain: d }, 1) : null;
  const diffbotCap = Number(process.env.DIFFBOT_FACTS_PER_DAY ?? 6);
  if (!search && !byDomain) return { ...res, skipped: "no EXA_API_KEY or DIFFBOT_TOKEN" };
  const write = opts.write !== false;
  const db = getDb();
  const rows = await db.select({ id: accounts.id, domain: accounts.domain, name: accounts.name, size: accounts.sizeBand, segment: accounts.segment, description: accounts.description }).from(accounts)
    .where(and(inArray(accounts.id, accountIds), sql`(${accounts.sizeBand} is null or ${accounts.segment} is null or ${accounts.description} is null)`));
  if (!rows.length) return res;
  // keep the caller's order: the per-run budget goes to the first ids (pool leads, then the closest under the floor)
  const order = new Map(accountIds.map((id, i) => [id, i]));
  rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  const recent = new Set((await db.select({ a: peopleSearches.accountId }).from(peopleSearches).where(and(
    inArray(peopleSearches.accountId, rows.map((r) => r.id)), eq(peopleSearches.persona, PERSONA), sql`${peopleSearches.searchedAt} > ${new Date(Date.now() - CHECK_DAYS * DAY)}`,
  ))).map((r) => r.a));

  // segment classifier: Haiku, on the shared daily Haiku cap
  const wantSegments = Object.keys(pack.icp.segment_descriptions).length > 0;
  let llm = opts.llm ?? null, haiku: HaikuClient | null = null;
  const usage = opts.usage ?? neonUsage();
  if (wantSegments && opts.llm === undefined && process.env.ANTHROPIC_API_KEY) {
    const cap = opts.dailyCapUsd ?? Number(process.env.HAIKU_DAILY_CAP_USD ?? 0.06);
    const left = cap - (await usage.spentToday("haiku"));
    if (left > 0) llm = haiku = new HaikuClient({ capUsd: left });
  }
  const system = wantSegments ? segmentPrompt(pack) : "";

  let budget = opts.max ?? Number(process.env.EXA_COMPANY_PER_RUN ?? 3);
  try {
    for (const a of rows) {
      if (recent.has(a.id) || budget-- <= 0) continue;
      res.looked++;
      let hit: CompanyHit | null = null;
      // name + domain finds the company's own record more often than the bare domain
      if (byDomain && (await usage.spentToday("diffbot_facts")) < diffbotCap) {
        await usage.addSpend("diffbot_facts", 1, diffbotCap);
        hit = companyFor(a.domain, await byDomain(a.domain).catch(() => []), a.name);
      }
      if (!hit && search) { try { hit = companyFor(a.domain, await search(a.name ? `${a.name} ${a.domain}` : a.domain), a.name); } catch { continue; /* Exa down: try next run */ } }
      const set: { sizeBand?: string; segment?: string; description?: string } = {};
      if (hit?.description && !a.description) { set.description = profileLine(hit.description); res.described++; }
      if (hit?.employees && !a.size) { set.sizeBand = bandForHeadcount(hit.employees, pack.icp); res.sized++; }
      if (hit?.description && !a.segment && llm) {
        try {
          const seg = parseSegment(await llm.complete({ system, user: `Company: ${hit.name}\nWebsite: ${a.domain}\nDescription: ${hit.description}` }), pack);
          if (seg) { set.segment = seg; res.segmented++; }
        } catch { /* Haiku cap reached or API down: segment stays unknown */ }
      }
      if (set.sizeBand || set.segment || set.description) res.changed.push(a.id);
      if (write) {
        if (set.sizeBand || set.segment || set.description) await db.update(accounts).set(set).where(eq(accounts.id, a.id));
        await db.insert(peopleSearches).values({ accountId: a.id, persona: PERSONA, provider: "exa", found: hit ? 1 : 0, searchedAt: new Date() })
          .onConflictDoUpdate({ target: [peopleSearches.accountId, peopleSearches.persona, peopleSearches.provider], set: { found: hit ? 1 : 0, searchedAt: new Date() } });
      }
    }
  } finally {
    if (haiku && haiku.spent > 0) await usage.addSpend("haiku", haiku.spent, opts.dailyCapUsd ?? Number(process.env.HAIKU_DAILY_CAP_USD ?? 0.06));
  }
  return res;
}
