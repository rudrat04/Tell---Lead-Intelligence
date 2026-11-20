import type { Pack } from "@tell/config";

export type IcpConfig = Pack["icp"];

export interface CompanyFacts {
  domain: string | null;
  teamSize: number | null;
  /** empty = unknown */
  industries: string[];
  /** null = unknown */
  status: string | null;
}

/** team size and regions for an account in this segment: the segment's override, else the defaults */
export function filtersFor(icp: IcpConfig, segment?: string | null): { team_size: { min: number; max: number }; regions_any: string[] } {
  const f = icp.hard_filters;
  const o = segment ? f.segment_overrides?.[segment] : undefined;
  return { team_size: o?.team_size ?? f.team_size, regions_any: o?.regions_any ?? f.regions_any };
}

/** Hard ICP filters (plan 8d: fit = hard filters first). Unknown team size fails: nothing is assumed. `segment` picks
 *  the segment's size override (niche sources know the segment). */
export function passesHardFilters(c: CompanyFacts, icp: IcpConfig, segment?: string | null): { pass: boolean; reason: string } {
  const f = { ...icp.hard_filters, ...filtersFor(icp, segment) };
  if (!c.domain) return { pass: false, reason: "no domain" };
  if (f.exclude_domains.includes(c.domain)) return { pass: false, reason: "excluded domain" };
  const unknownOk = f.unknown_facts === "pass";
  if (c.status == null) { if (!unknownOk) return { pass: false, reason: "status unknown" }; }
  else if (!f.statuses.includes(c.status)) return { pass: false, reason: `status ${c.status}` };
  const knownIndustries = c.industries.filter((i) => i && i !== "Unspecified");
  if (knownIndustries.length === 0) { if (!unknownOk) return { pass: false, reason: "industry unknown" }; }
  else if (!knownIndustries.some((i) => f.industries_any.includes(i))) return { pass: false, reason: "industry" };
  if (c.teamSize == null) return unknownOk ? { pass: true, reason: "ok (team size unknown: neutral fit)" } : { pass: false, reason: "team size unknown" };
  if (c.teamSize < f.team_size.min || c.teamSize > f.team_size.max) return { pass: false, reason: `team size ${c.teamSize}` };
  return { pass: true, reason: "ok" };
}

export function sizeBand(teamSize: number | null, icp: IcpConfig): string | null {
  if (teamSize == null) return null;
  return icp.size_bands.find((b) => teamSize <= b.max)?.band ?? null;
}

/** Map source industry labels to the pack's segment names (first match wins). */
export function segmentFor(industries: string[], icp: IcpConfig): string | null {
  for (const i of industries) if (icp.segment_map[i]) return icp.segment_map[i]!;
  return null;
}

/**
 * Can an account in this region ever be scored? With `regions_any` set, only a known region on that list (scoring's own
 * rule); empty = every region. Boards and the account watch skip the rest: fetching pages for accounts that can never
 * become leads only gets the crawler throttled (YC began refusing ~270 pages into a 1,060-page run).
 */
export function regionInScope(region: string | null | undefined, icp: IcpConfig, segment?: string | null): boolean {
  const any = filtersFor(icp, segment).regions_any;
  return any.length === 0 || (region != null && any.includes(region));
}
