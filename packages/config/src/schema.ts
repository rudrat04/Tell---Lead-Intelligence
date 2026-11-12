import { z } from "zod";

/**
 * A config pack: everything business-specific. The code is generic; a pack says who you sell to,
 * what need you solve, which signals mean what, and where to deliver. Packs are validated at startup.
 */

/** Regex written as a string; "(?i)" style inline flags allowed at the start. */
const pattern = z.string().min(1).refine((p) => {
  try { toRegex(p); return true; } catch { return false; }
}, "invalid regular expression");

export function toRegex(p: string): RegExp {
  const m = p.match(/^\(\?([a-z]+)\)(.*)$/s);
  return m ? new RegExp(m[2]!, m[1]) : new RegExp(p);
}

export const PackMetaSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1),
  /** what you sell, one line; used in prompts and the digest */
  offer: z.string().min(10),
  operator: z.object({
    /** bot name for the User-Agent and robots.txt matching (letters, digits, dashes) */
    bot_name: z.string().regex(/^[A-Za-z0-9-]+$/),
    /** where site owners can learn about the bot (your site or the repo) */
    contact_url: z.string().url(),
  }),
  timezone: z.string().default("Asia/Kolkata"),
});

export const IcpSchema = z.object({
  hard_filters: z.object({
    team_size: z.object({ min: z.number().int().min(1), max: z.number().int().min(1) }),
    industries_any: z.array(z.string()).min(1),
    statuses: z.array(z.string()).min(1),
    exclude_domains: z.array(z.string()).default([]),
  }),
  size_bands: z.array(z.object({ band: z.string(), max: z.number().int() })).min(1),
  /** source industry label (e.g. YC "B2B", "Consumer") -> your segment name */
  segment_map: z.record(z.string(), z.string()).default({ B2B: "b2b" }),
  /** soft fit (0..1 per factor, weights sum to 1) */
  soft_fit: z.object({
    weights: z.record(z.string(), z.number().min(0)),
    size_band: z.record(z.string(), z.number().min(0).max(1)).default({}),
    region: z.record(z.string(), z.number().min(0).max(1)).default({}),
    region_default: z.number().min(0).max(1).default(0.5),
    segment: z.record(z.string(), z.number().min(0).max(1)).default({}),
    segment_default: z.number().min(0).max(1).default(0.5),
  }),
  /** who to contact at a matching company, in order of preference, by company size */
  personas: z.array(z.object({
    title: z.string(),
    /** title patterns that count as this persona */
    patterns: z.array(pattern).min(1),
    /** company size bands where this persona is the right first contact (empty = any) */
    size_bands: z.array(z.string()).default([]),
  })).default([]),
});

/** Signal types the code emits; a pack must define each of them in signals.yaml. */
export const CODE_SIGNAL_TYPES = [
  "explicit_hire_request", "pain_post", // posts (Gate 3)
  "contract_role", "first_role", "core_role_open", "adjacent_role_open", "core_role_open_45d", "core_role_filled", // job boards
] as const;

export const SignalsSchema = z.object({
  base_rate: z.number().gt(0).lt(1),
  /** minimum Gate 3 strength for a post to count as a signal */
  min_post_strength: z.number().int().min(1).max(5).default(3),
  signals: z.record(z.string(), z.object({
    class: z.enum(["explicit", "implicit", "trigger", "pain", "negative"]),
    lr: z.number().gt(0),
    half_life_days: z.number().gt(0),
    strength: z.number().int().min(1).max(5).default(3),
    fast_lane: z.boolean().default(false),
  })),
  gate1: z.object({
    required_any: z.array(pattern).default([]),
    never: z.array(pattern).default([]),
  }),
});

export const PlaysSchema = z.object({
  plays: z.record(z.string(), z.object({
    title: z.string(),
    /** all of these signal types within window_days */
    requires: z.array(z.string()).min(1),
    window_days: z.number().int().min(1),
    angle: z.string(),
  })),
});

export const RolesSchema = z.object({
  /** the role you substitute for or bridge (open long = struggling to hire; removed fast = filled) */
  core: z.array(pattern).min(1),
  /** roles that show the need is forming */
  adjacent: z.array(pattern).default([]),
  /** titles that look similar but are not the need */
  exclude: z.array(pattern).default([]),
  contract: z.array(pattern).default(["(?i)\\b(contract(or)?|freelance|part[- ]time|temporary|temp|fractional|consultant)\\b"]),
  founding: z.array(pattern).default(["(?i)\\b(founding|first)\\b"]),
});

export const ExtractorSchema = z.object({
  /** what a genuine need for your offer looks like, for the classifier and verifier prompts */
  need_description: z.string().min(20),
  /** problem categories for posts ("other" is always added) */
  categories: z.array(z.string().regex(/^[a-z_]+$/)).min(1),
  /** what makes a post strength 5 */
  strength_5: z.string().min(10),
});

export const SourcesSchema = z.object({
  hn: z.object({ enabled: z.boolean().default(true), queries: z.array(z.string()).min(1) }),
  reddit: z.object({
    enabled: z.boolean().default(false),
    subs: z.array(z.string()).default([]),
    hiring_subs: z.array(z.string()).default([]),
  }).default({ enabled: false, subs: [], hiring_subs: [] }),
  yc: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
});

export const DomainsSchema = z.object({
  never_company: z.array(z.string()).default([]),
  free_mail: z.array(z.string()).default([]),
  shorteners: z.array(z.string()).default([]),
});

export const DeliverySchema = z.object({
  digest: z.object({
    to: z.string().email().optional(),
    from_name: z.string().default("Lead digest"),
    max_leads: z.number().int().min(1).max(25).default(10),
    send_hour_local: z.number().int().min(0).max(23).default(9),
  }).default({ from_name: "Lead digest", max_leads: 10, send_hour_local: 9 }),
  redeliver_after_days: z.number().int().min(1).default(90),
});

export const PackSchema = z.object({
  meta: PackMetaSchema,
  icp: IcpSchema,
  signals: SignalsSchema,
  plays: PlaysSchema,
  roles: RolesSchema,
  extractor: ExtractorSchema,
  sources: SourcesSchema,
  domains: DomainsSchema,
  delivery: DeliverySchema,
}).superRefine((p, ctx) => {
  for (const t of CODE_SIGNAL_TYPES) {
    if (!p.signals.signals[t]) ctx.addIssue({ code: "custom", path: ["signals", "signals", t], message: `signal type "${t}" is emitted by the code and must be defined` });
  }
  for (const [name, play] of Object.entries(p.plays.plays)) {
    for (const r of play.requires) {
      if (!p.signals.signals[r]) ctx.addIssue({ code: "custom", path: ["plays", "plays", name, "requires"], message: `unknown signal type "${r}"` });
    }
  }
  const w = Object.values(p.icp.soft_fit.weights).reduce((a, b) => a + b, 0);
  if (Math.abs(w - 1) > 0.01) ctx.addIssue({ code: "custom", path: ["icp", "soft_fit", "weights"], message: `weights must sum to 1 (got ${w.toFixed(2)})` });
  if (p.icp.hard_filters.team_size.min > p.icp.hard_filters.team_size.max) ctx.addIssue({ code: "custom", path: ["icp", "hard_filters", "team_size"], message: "min > max" });
});

export type Pack = z.infer<typeof PackSchema>;
export const PACK_FILES = ["pack", "icp", "signals", "plays", "roles", "extractor", "sources", "domains", "delivery"] as const;
