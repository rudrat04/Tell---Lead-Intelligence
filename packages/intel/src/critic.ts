import { toRegex, type Pack } from "@tell/config";
import type { Evidence } from "./rank.js";

/**
 * Code critic (plan 8f): checks that drop a lead before ranking, so the next account takes its slot.
 * Freshness is not re-checked here: eligibility (fresh_days) and the fast-lane age cap already cover it.
 *   vendor:  the company sells what you sell (agency, outsourced SDRs, staffing)
 *   solved:  a pack "solved" tool is on their site/DNS, or a solved-type signal (e.g. the core role was filled)
 *            is newer than every positive signal
 *   icp:     the ICP hard filters, re-checked on stored facts (excluded domain, a size band or segment the pack no longer
 *            has, a YC company whose latest facts fail): discovery checks them once, a pack change must reach old accounts
 *   enterprise: size unknown, but the evidence sits on an enterprise careers system (pack critic.enterprise.url_patterns)
 */
export type CriticCheck = "vendor" | "solved_tool" | "solved_signal" | "icp" | "enterprise";

export interface CriticInput {
  name: string | null;
  domain: string;
  /** homepage <title> from the latest site snapshot */
  siteTitle?: string | null;
  /** tool keys detected on the site or in DNS */
  tools?: string[];
  /** the site shows a HubSpot/Salesforce/... partner badge: they sell GTM services */
  partnerBadge?: boolean;
  /** stored facts (null = unknown) */
  sizeBand?: string | null;
  segment?: string | null;
  /** why this company's latest YC facts fail the hard filters (null/undefined = not a YC company, or it passes) */
  ycFitFailed?: string | null;
  evidence: Evidence[];
}

export interface CriticVerdict { pass: boolean; failed: { check: CriticCheck; reason: string }[] }

export function critic(i: CriticInput, pack: Pack): CriticVerdict {
  const c = pack.critic;
  const failed: CriticVerdict["failed"] = [];

  const text = [i.name, i.domain, i.siteTitle].filter(Boolean).join(" | ");
  const vendor = c.vendor_patterns.map(toRegex).find((r) => r.test(text));
  if (vendor) failed.push({ check: "vendor", reason: `looks like a vendor of the same service (${text.match(vendor)?.[0] ?? "pattern"})` });
  else if (i.partnerBadge) failed.push({ check: "vendor", reason: "shows a CRM/GTM partner badge: sells the same service" });

  const icpFail = icpRecheck(i, pack);
  if (icpFail) failed.push({ check: "icp", reason: icpFail });
  else if (!i.sizeBand) {
    const rx = c.enterprise.url_patterns.map(toRegex);
    const hit = i.evidence.find((e) => rx.some((r) => r.test(e.url)));
    if (hit) failed.push({ check: "enterprise", reason: `size unknown, hiring through an enterprise careers system (${hit.url.slice(0, 80)})` });
  }

  const tool = (i.tools ?? []).find((t) => c.solved_tools.includes(t));
  if (tool) failed.push({ check: "solved_tool", reason: `already uses ${pack.tools.tools[tool]?.label ?? tool}` });

  const solved = i.evidence.filter((e) => c.solved_types.includes(e.type) && e.ageDays <= c.solved_max_age_days)
    .sort((a, b) => a.ageDays - b.ageDays)[0];
  if (solved) {
    const newerPositive = i.evidence.some((e) => e.class !== "negative" && !c.solved_types.includes(e.type) && (e.ageDays < solved.ageDays || (e.current && e.ageDays <= solved.ageDays)));
    if (!newerPositive) failed.push({ check: "solved_signal", reason: `${solved.type.replace(/_/g, " ")} ${solved.ageDays}d ago, nothing newer` });
  }
  return { pass: failed.length === 0, failed };
}

/** ICP hard filters on an account's stored facts; null = passes. Unknown facts pass here (discovery decided on them). */
export function icpRecheck(i: Pick<CriticInput, "domain" | "sizeBand" | "segment" | "ycFitFailed">, pack: Pack): string | null {
  const icp = pack.icp;
  if (icp.hard_filters.exclude_domains.includes(i.domain)) return "excluded domain";
  if (i.sizeBand && !icp.size_bands.some((b) => b.band === i.sizeBand)) return `size ${i.sizeBand} is outside the ICP`;
  if (i.segment) {
    const allowed = new Set(icp.hard_filters.industries_any.map((x) => icp.segment_map[x]).filter(Boolean));
    if (allowed.size && !allowed.has(i.segment)) return `segment ${i.segment} is outside the ICP`;
  }
  if (i.ycFitFailed) return `latest YC facts: ${i.ycFitFailed}`;
  return null;
}

/** The contact found for an unknown-size account holds a regional / business-unit title: an enterprise. */
export function enterpriseTitle(role: string | null | undefined, pack: Pack): boolean {
  return !!role && pack.critic.enterprise.title_patterns.some((p) => toRegex(p).test(role));
}
