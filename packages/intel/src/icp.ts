import { parse } from "yaml";
import { readFileSync } from "node:fs";

export interface IcpConfig {
  hard_filters: {
    team_size: { min: number; max: number };
    industries_any: string[];
    statuses: string[];
    exclude_domains: string[];
  };
  size_bands: { band: string; max: number }[];
}

export function loadIcp(path: string): IcpConfig {
  return parse(readFileSync(path, "utf8")) as IcpConfig;
}

export interface CompanyFacts {
  domain: string | null;
  teamSize: number | null;
  industries: string[];
  status: string;
}

/** Hard ICP filters (plan 8d: fit = hard filters first). Unknown team size fails: nothing is assumed. */
export function passesHardFilters(c: CompanyFacts, icp: IcpConfig): { pass: boolean; reason: string } {
  const f = icp.hard_filters;
  if (!c.domain) return { pass: false, reason: "no domain" };
  if (f.exclude_domains.includes(c.domain)) return { pass: false, reason: "excluded domain" };
  if (!f.statuses.includes(c.status)) return { pass: false, reason: `status ${c.status}` };
  if (!c.industries.some((i) => f.industries_any.includes(i))) return { pass: false, reason: "industry" };
  if (c.teamSize == null) return { pass: false, reason: "team size unknown" };
  if (c.teamSize < f.team_size.min || c.teamSize > f.team_size.max) return { pass: false, reason: `team size ${c.teamSize}` };
  return { pass: true, reason: "ok" };
}

export function sizeBand(teamSize: number | null, icp: IcpConfig): string | null {
  if (teamSize == null) return null;
  return icp.size_bands.find((b) => teamSize <= b.max)?.band ?? null;
}
