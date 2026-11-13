import { toRegex, type Pack } from "@tell/config";
import type { Evidence } from "./rank.js";

/**
 * Code critic (plan 8f): checks that drop a lead before ranking, so the next account takes its slot.
 * Freshness is not re-checked here: eligibility (fresh_days) and the fast-lane age cap already cover it.
 *   vendor:  the company sells what you sell (agency, outsourced SDRs, staffing)
 *   solved:  a pack "solved" tool is on their site/DNS, or a solved-type signal (e.g. the core role was filled)
 *            is newer than every positive signal
 */
export type CriticCheck = "vendor" | "solved_tool" | "solved_signal";

export interface CriticInput {
  name: string | null;
  domain: string;
  /** homepage <title> from the latest site snapshot */
  siteTitle?: string | null;
  /** tool keys detected on the site or in DNS */
  tools?: string[];
  /** the site shows a HubSpot/Salesforce/... partner badge: they sell GTM services */
  partnerBadge?: boolean;
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
