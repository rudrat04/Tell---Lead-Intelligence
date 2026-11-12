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
};

export function isSourceEnabled(sourceId: string): boolean {
  return SOURCE_POLICY[sourceId]?.enabled ?? true;
}

/** Unknown sources get the strictest mapping rule until a policy is written for them. */
export function isMappingAllowed(sourceId: string, method: MappingConfidence): boolean {
  return (SOURCE_POLICY[sourceId]?.allowedMappings ?? ["explicit"]).includes(method);
}
