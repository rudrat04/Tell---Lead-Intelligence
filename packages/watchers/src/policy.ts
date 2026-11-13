/**
 * Per-source terms-of-use policy, enforced in code.
 *
 * Reddit (Responsible Builder Policy): API access needs explicit approval, commercial use needs
 * written approval, and re-identifying users "including by matching data with off-platform
 * identifiers" is prohibited. So Reddit stays disabled until approved, and Reddit authors may only
 * be linked to a company the post itself names or links (never via profiles or other platforms).
 */

export type MappingConfidence = "explicit" | "profile" | "cross-platform" | "hint";

export interface SourcePolicy {
  enabled: boolean;
  /** which author-mapping methods (plan 8a) are allowed for authors from this source */
  allowedMappings: MappingConfidence[];
  note?: string;
}

const ALL: MappingConfidence[] = ["explicit", "profile", "cross-platform", "hint"];

export const SOURCE_POLICY: Record<string, SourcePolicy> = {
  reddit: { enabled: false, allowedMappings: ["explicit"], note: "Awaiting Reddit API approval (Responsible Builder Policy)" },
  "forhire-subs": { enabled: false, allowedMappings: ["explicit"], note: "Awaiting Reddit API approval (Responsible Builder Policy)" },
  hn: { enabled: true, allowedMappings: ALL },
  // Keka tenants: robots.txt allows only /careers (the portal's own JSON API sits under it). Freshteam: only /jobs.
  // Tenants are listed from Common Crawl's public URL index; each tenant's robots.txt is checked before use.
  keka: { enabled: true, allowedMappings: ["explicit"], note: "robots.txt: /careers only" },
  freshteam: { enabled: true, allowedMappings: ["explicit"], note: "robots.txt: /jobs only" },
  // Workable: robots.txt doesn't block the job-search or widget APIs (ai-input=yes); terms have no automated-access ban.
  workable: { enabled: true, allowedMappings: ["explicit"], note: "public job search + widget API" },
  // Portfolio pages: Surge / Peak XV robots.txt allow all crawlers; robots checked per page.
  portfolio: { enabled: true, allowedMappings: ["explicit"], note: "company page's own Website link only" },
  // Checked Nov 2026 and NOT used: Inc42 terms ban bots/monitoring; Entrackr terms ban automated collection without
  // written consent; YourStory robots.txt blocks AI and RSS bots; Zoho Recruit career sites are a JS app whose job
  // data sits behind paths robots.txt disallows.
  inc42: { enabled: false, allowedMappings: [], note: "terms: no bots without written approval" },
  entrackr: { enabled: false, allowedMappings: [], note: "terms: no automated collection without written consent" },
  yourstory: { enabled: false, allowedMappings: [], note: "robots.txt blocks AI/RSS bots" },
  zohorecruit: { enabled: false, allowedMappings: [], note: "JS app; job data behind robots-disallowed paths" },
};

export function isSourceEnabled(sourceId: string): boolean {
  return SOURCE_POLICY[sourceId]?.enabled ?? true;
}

/** Unknown sources get the strictest mapping rule until a policy is written for them. */
export function isMappingAllowed(sourceId: string, method: MappingConfidence): boolean {
  return (SOURCE_POLICY[sourceId]?.allowedMappings ?? ["explicit"]).includes(method);
}
