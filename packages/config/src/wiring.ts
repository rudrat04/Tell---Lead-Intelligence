/**
 * How a pack's industries are wired end to end (pure, from the pack alone): which sources write signals for an
 * industry, which signals count there, which plays can fire on them and what can be offered. `pnpm pack:map` prints
 * it; `pnpm pack:check` prints the warnings. The idea: each industry gets the signals that are necessary and enough to
 * make an offer, and nothing from another industry leaks in.
 */
import { regionGroupFor, CODE_SIGNAL_TYPES, type Pack } from "./schema.js";

/** Signal types the general sources write for any company (posts, job boards, YC pages, site / DNS watch, people search,
 *  funding news, your network). Every other type comes from a niche source or `pnpm niche import`. */
export const GENERAL_SIGNAL_TYPES = new Set<string>([...CODE_SIGNAL_TYPES, "role_reposted", "jd_mentions", "tool_overlap", "leaky_capture",
  "has_gtm_agency", "new_gtm_leader", "ops_person_left", "marketing_subdomain", "outbound_domain", "freeze_to_contract", "champion_moved",
  "email_auth_gap", "attribution_gap", "site_health_poor", "content_motion", "ops_owner_known", "ops_team_2plus", "role_gap"]);

/** A niche source writing one signal type for one industry. */
export interface Feed { source: string; segment: string; type: string }

/** Every niche source that is on, with the industry and signal type it writes (general sources write for any industry). */
export function nicheFeeds(pack: Pick<Pack, "sources">): Feed[] {
  const n = pack.sources.niche;
  const out: Feed[] = [];
  const add = (source: string, segment: string, ...types: string[]) => { for (const type of types) out.push({ source, segment, type }); };
  if (n.nppes?.enabled) for (const t of Object.values(n.nppes.taxonomies)) add("nppes", t.segment, "new_provider_npi");
  if (n.sam_entities?.enabled) for (const seg of Object.values(n.sam_entities.naics_prefixes)) add("sam", seg, "new_federal_registrant");
  if (n.recalls?.enabled) add("fda_recalls", n.recalls.segment, "competitor_recall");
  for (const e of n.news_events ?? []) add(`news:${e.id}`, e.segment, e.signal_type);
  if (n.fda_shortage.enabled) add("fda_shortage", n.fda_shortage.segment, "shortage_anda_dormant", "shortage_anda_marketed");
  if (n.usaspending.enabled) add("usaspending", n.usaspending.segment, "contract_expiring");
  if (n.cms_new_providers.enabled) add("cms_new_providers", n.cms_new_providers.segment, "new_medicare_certification");
  if (n.fda_510k?.enabled) add("fda_510k", n.fda_510k.segment, "device_cleared");
  if (n.anda_approvals?.enabled) add("anda_approvals", n.anda_approvals.segment, "anda_approved");
  if (n.usaspending_awards?.enabled) for (const g of n.usaspending_awards.groups) add("usaspending_awards", g.segment, "contract_won");
  if (n.form_d?.enabled) for (const seg of Object.values(n.form_d.industries)) add("form_d", seg, "form_d_raise");
  for (const x of n.socrata) if (x.enabled) add(`socrata:${x.id}`, x.segment, x.signal_type);
  // dedupe (several taxonomies / NAICS prefixes map to one industry)
  const seen = new Set<string>();
  return out.filter((f) => { const k = `${f.source}|${f.segment}|${f.type}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/** Whether a signal type counts for a company in this industry (industries.yaml `signals`; unknown industry or no list =
 *  it counts). Paths that read signals outside scoring (alerts, follow-ups) and the watchers check it. */
export function industryCounts(pack: Pick<Pack, "icp">, segment: string | null | undefined, type: string): boolean {
  const counted = segment ? pack.icp.industries[segment]?.signals : undefined;
  return !counted || counted.includes(type);
}

/** Industries that count none of these types: a watcher writing only these types can skip their companies. */
export function industriesIgnoring(pack: Pick<Pack, "icp">, types: string[]): string[] {
  return Object.entries(pack.icp.industries).filter(([, i]) => i.signals && !types.some((t) => i.signals!.includes(t))).map(([s]) => s);
}

/** Capabilities that may be offered to a company in this industry (unscoped ones go to every industry). */
export function capabilitiesFor(pack: Pick<Pack, "capabilities">, segment: string | null | undefined) {
  return pack.capabilities.capabilities.filter((c) => !c.industries.length || (!!segment && c.industries.includes(segment)));
}

export interface IndustryWiring {
  segment: string;
  label: string;
  regions: string[];
  teamSize: { min: number; max: number };
  buyers: string[];
  /** null = every signal type counts */
  counts: string[] | null;
  /** niche sources writing a signal this industry counts */
  feeds: Feed[];
  /** counted types written by general sources (job boards, watch, web search, funding...) */
  general: string[];
  /** plays that can fire here: scoped to this industry, or unscoped with signals it counts */
  plays: { id: string; scoped: boolean; requires: string[]; offer: string | null; list: string | null }[];
  free: string[];
  paid: string[];
  digestList: string | null;
  warnings: string[];
}

/** One entry per admitted industry: what feeds it, what counts, what fires, what it's offered, where it's listed. */
export function industryMap(pack: Pack): IndustryWiring[] {
  const feeds = nicheFeeds(pack);
  const inds = Object.entries(pack.icp.industries).filter(([, i]) => !i.excluded);
  const out: IndustryWiring[] = [];
  for (const [seg, ind] of inds) {
    const warnings: string[] = [];
    const counts = ind.signals ?? null;
    const counted = (t: string) => !counts || counts.includes(t);
    const myFeeds = feeds.filter((f) => f.segment === seg);
    const feeding = myFeeds.filter((f) => counted(f.type));
    for (const f of myFeeds) if (!counted(f.type)) warnings.push(`${f.source} writes ${f.type} for it, which it doesn't count: lookups spent for nothing`);
    const general = (counts ?? []).filter((t) => GENERAL_SIGNAL_TYPES.has(t));
    if (counts) {
      const fed = new Set([...feeding.map((f) => f.type), ...general]);
      const unfed = counts.filter((t) => !fed.has(t));
      if (unfed.length) warnings.push(`no source writes ${unfed.join(", ")} for it: only your own pnpm niche import`);
    } else if (inds.some(([, i]) => i.signals)) warnings.push("counts every signal type (set signals: the ones that show a need you can make an offer on)");

    const plays: IndustryWiring["plays"] = [];
    const offList = new Map<string, string[]>();
    for (const [id, p] of Object.entries(pack.plays.plays)) {
      const scoped = p.industries.length > 0;
      if (scoped && !p.industries.includes(seg)) continue;
      if (!p.requires.every(counted) || (p.requires_any.length && !p.requires_any.some(counted))) continue;
      plays.push({ id, scoped, requires: [...p.requires, ...(p.requires_any.length ? [`any of ${p.requires_any.join("/")}`] : [])], offer: p.offer ?? null, list: p.list ?? null });
      if (scoped) for (const t of p.personas) if (ind.buyers.length && !ind.buyers.includes(t)) offList.set(t, [...(offList.get(t) ?? []), id]);
    }
    // plays contact their own buyers first: a buyer the industry doesn't list is a sign the play was written for another one
    if (offList.size) warnings.push(`its plays name buyers it doesn't list (industries.yaml buyers): ${[...offList].map(([t, ids]) => `"${t}" (${ids.length} play${ids.length === 1 ? "" : "s"})`).join(", ")}`);
    const loose = plays.filter((p) => !p.scoped).map((p) => p.id);
    if (loose.length && Object.values(pack.plays.plays).some((p) => p.industries.length)) warnings.push(`unscoped plays can fire here: ${loose.join(", ")}`);
    const caps = capabilitiesFor(pack, seg);
    const free = caps.filter((c) => c.free).map((c) => c.id), paid = caps.filter((c) => !c.free).map((c) => c.id);
    const judged = pack.signals.score.mode === "judged";
    if (!plays.length && !(judged && free.length)) warnings.push("no play can fire and nothing to offer: its leads have nothing to say");
    if (judged && !free.length) warnings.push("no free first step can be offered (capabilities.yaml), so the judge can never qualify a lead");
    const loneLists = pack.capabilities.capabilities.filter((c) => c.free && c.list && !c.industries.length).map((c) => c.id);
    if (judged && loneLists.length) warnings.push(`list capabilities open to every industry: ${loneLists.join(", ")} (scope them with industries:)`);

    const regions = ind.regions ?? pack.icp.hard_filters.regions_any;
    const groups = pack.delivery.digest.region_groups;
    const listed = (regions.length ? regions : [null]).map((r) => regionGroupFor(pack, r, seg)?.name ?? null).filter((x): x is string => !!x);
    const digestList = groups.length ? (listed[0] ?? null) : "digest";
    if (groups.length && !listed.length) warnings.push("in no digest list (delivery.digest.region_groups): its leads are never sent");
    const dupHint = ind.hint && inds.find(([s2, i2]) => s2 !== seg && i2.hint === ind.hint && i2.list !== ind.list);
    if (dupHint) warnings.push(`same hint as "${dupHint[0]}", which sells a different list: the judge gets the wrong context`);

    out.push({ segment: seg, label: ind.label, regions, teamSize: ind.team_size ?? pack.icp.hard_filters.team_size, buyers: ind.buyers,
      counts, feeds: feeding, general, plays, free, paid, digestList, warnings });
  }
  return out;
}

/** Pack-wide wiring warnings: each industry's, plus plays that can't fire anywhere. Never fatal. */
export function packWarnings(pack: Pack): string[] {
  const map = industryMap(pack);
  const out = map.flatMap((w) => w.warnings.map((x) => `${w.segment}: ${x}`));
  const fires = new Set(map.flatMap((w) => w.plays.map((p) => p.id)));
  if (map.length) for (const id of Object.keys(pack.plays.plays)) if (!fires.has(id)) out.push(`play ${id}: can't fire in any industry (its signals aren't counted where it's scoped)`);
  return out;
}

/** The map as text (pnpm pack:map). */
export function formatIndustryMap(pack: Pack): string {
  const lines: string[] = [];
  for (const w of industryMap(pack)) {
    lines.push(`\n${w.segment}: ${w.label}  (${w.regions.join(", ") || "any region"}; ${w.teamSize.min}-${w.teamSize.max} people)  → ${w.digestList ?? "NOT IN ANY DIGEST LIST"}`);
    lines.push(`  buyers   ${w.buyers.join(" | ") || "(default order)"}`);
    lines.push(`  counts   ${w.counts ? w.counts.join(", ") : "every signal type"}`);
    const bySource = new Map<string, string[]>();
    for (const f of w.feeds) bySource.set(f.source, [...(bySource.get(f.source) ?? []), f.type]);
    lines.push(`  fed by   ${[...[...bySource].map(([s, t]) => `${s} (${t.join(", ")})`), ...(w.general.length ? [`general sources (${w.general.join(", ")})`] : [])].join("; ") || (w.counts ? "nothing" : "any source")}`);
    lines.push(`  plays    ${w.plays.length ? "" : "none"}`);
    for (const p of w.plays) lines.push(`    ${p.scoped ? "•" : "○"} ${p.id}: ${p.requires.join(" + ")}${p.list ? `  → list ${p.list}` : ""}${p.offer ? `  → ${p.offer.slice(0, 90)}${p.offer.length > 90 ? "…" : ""}` : ""}`);
    lines.push(`  offer    free: ${w.free.join(", ") || "none"}; paid: ${w.paid.join(", ") || "none"}`);
    for (const x of w.warnings) lines.push(`  ⚠ ${x}`);
  }
  lines.push(`\n• = play scoped to the industry, ○ = unscoped play that can fire here too`);
  return lines.join("\n");
}
